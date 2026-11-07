/**
 * 六步流水线：parse → analyze → rewrite → match → generate → compose。
 *
 * 每一步都是「读运行状态 → 调模型/工具 → 写运行状态」的纯函数式阶段，
 * 由 engine 负责步骤调度、失败标记与自动推进。任何一步都能单独重跑。
 *
 * 设计取舍（与参考实现 LeadStageAI 对齐的部分）：
 * - 拆解用「均匀抽帧 + 视觉模型」而不是整段视频 base64：对任意 OpenAI 兼容
 *   网关都能跑，且不会一次上传几十 MB；口播文稿优先用 ASR（可选配置）。
 * - 仿写出 3 版，用户在界面上选一版再往下走。
 * - 参考图逐镜生成（产品融入分镜），视频按「≤5 镜 / ≤15 秒」分块生成，
 *   这是 Seedance 一类模型的硬约束。
 * - 合成保留分镜自带的音轨（模型内嵌配音）；只有配置了 TTS 才生成外挂配音。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AnalysisReport,
  AnalysisShot,
  ComposeResult,
  PluginConfig,
  ProductImage,
  RunState,
  ScriptSegment,
  ScriptVariant,
  SegmentVideo,
  SourceMeta,
  StepId,
  StoryboardFrame,
  TranscriptCue,
} from '../shared/types.ts'
import { PLATFORM_LABELS, aspectSizeOf } from '../shared/types.ts'
import { publishToChannels } from './publish.ts'
import { loadImage, type ChatImage } from './providers/chat.ts'
import { completeText, resolveEndpoint, usesDsh } from './endpoint-resolver.ts'
import type { DshModels } from './dsh.ts'
import { generateImage } from './providers/image.ts'
import { generateVideo, ratioOf } from './providers/video.ts'
import { synthesizeSpeech } from './providers/tts.ts'
import { transcribeAudio } from './providers/asr.ts'
import { resolveSource, extractUrl, detectPlatform } from './providers/parser.ts'
import {
  extractCover,
  extractFrames,
  fitAudio,
  mergeSegments,
  muxFinal,
  probeMedia,
  runCommand,
  silentAudio,
  writeAssSubtitle,
  buildAmbientTrack,
  detectSpeechWindows,
  alignPhrasesInAudio,
  mediaDuration,
} from './media.ts'
import {
  ANALYZE_SYSTEM,
  CAMERA_MOVES,
  SHOT_TYPES,
  REWRITE_SYSTEM,
  analyzePrompt,
  framePrompt,
  productDescribePrompt,
  rewritePrompt,
  videoPrompt,
} from './prompts.ts'
import { RunStore } from './store.ts'
import { asArray, asNumber, asRecord, asString, clamp, messageOf, pad2, parseModelJson } from './util.ts'

export interface PipelineContext {
  config: PluginConfig
  /** DSH 已配置模型接入层（缺失时只能用手填接口）。 */
  dsh?: DshModels
  store: RunStore
  run: RunState
  signal: AbortSignal
  /** 更新某一步的状态（内部负责合并与落盘）。 */
  setStep: (step: StepId, patch: Partial<RunState['steps'][number]>) => void
  log: (step: StepId | 'run', level: 'info' | 'warn' | 'error', text: string) => void
}

/** 把所有角色拼成一句用于「角色锁定」的身份描述。 */
function subjectIdentityForPrompt(run: RunState): string {
  const subjects = run.subjects ?? []
  if (subjects.length > 0) {
    return subjects.map(item => `${item.name}：${item.description}`).join('；')
  }
  return (run.analysis?.subjectIdentity ?? '').trim()
}

function dirOf(ctx: PipelineContext): string {
  return ctx.store.runDir(ctx.run.id)
}

function rel(relative: string): string {
  return relative.replace(/\\/g, '/')
}

function abs(ctx: PipelineContext, relative: string): string {
  return join(dirOf(ctx), relative)
}

function checkAbort(ctx: PipelineContext): void {
  if (ctx.signal.aborted) throw new Error('已停止')
}

/** 统一把生成/改写到运行状态的提交动作（触发落盘）。 */
function touch(ctx: PipelineContext): void {
  ctx.store.schedule(ctx.run.id)
}

// ---------------------------------------------------------------------------
// 第 1 步：解析下载
// ---------------------------------------------------------------------------

export async function stepParse(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  ctx.setStep('parse', { status: 'running', progress: 0.05, message: '准备解析', startedAt: Date.now(), error: undefined })
  touch(ctx)

  await mkdir(dirOf(ctx), { recursive: true })

  // 本地上传：文件已在运行目录里，只需探测与出封面。
  if (run.source?.provider === 'upload' && run.source.videoFile !== '') {
    const videoPath = abs(ctx, run.source.videoFile)
    const info = await stat(videoPath).catch(() => undefined)
    if (info === undefined || info.size < 1024) throw new Error('上传的视频文件不存在或过小，请重新上传')
    ctx.setStep('parse', { progress: 0.6, message: '读取本地视频信息' })
    const probe = await probeMedia(videoPath, config.media.ffprobePath).catch(() => undefined)
    const thumb = 'source/thumb.jpg'
    await extractCover(videoPath, abs(ctx, thumb), config.media.ffmpegPath).catch(() => {})
    const hasThumb = await stat(abs(ctx, thumb)).then(info => info.size > 0).catch(() => false)
    run.source = {
      ...run.source,
      ...(probe === undefined ? {} : {
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
      }),
      ...(hasThumb ? { thumbFile: thumb } : {}),
    }
    ctx.setStep('parse', { status: 'done', progress: 1, message: '已就绪', endedAt: Date.now() })
    touch(ctx)
    return
  }

  const input = run.sourceUrl ?? ''
  if (extractUrl(input) === undefined) {
    throw new Error('没有可解析的链接。请粘贴抖音/小红书/视频号链接，或在左侧上传本地视频。')
  }
  const platform = detectPlatform(extractUrl(input) ?? '')
  ctx.setStep('parse', { progress: 0.15, message: `识别为${PLATFORM_LABELS[platform]}链接，开始解析` })
  touch(ctx)

  const source = await resolveSource({
    input,
    parser: config.parser,
    media: {
      ytDlpPath: config.media.ytDlpPath,
      ffprobePath: config.media.ffprobePath,
      ...(config.parser.cookiesFromBrowser === undefined || config.parser.cookiesFromBrowser === ''
        ? {}
        : { cookiesFromBrowser: config.parser.cookiesFromBrowser }),
    },
    workDir: join(dirOf(ctx), 'source'),
    onProgress: message => {
      ctx.setStep('parse', { progress: 0.5, message })
      ctx.log('parse', 'info', message)
    },
  })
  checkAbort(ctx)

  const videoPath = abs(ctx, `source/${source.videoFile}`)
  const probe = await probeMedia(videoPath, config.media.ffprobePath).catch(() => undefined)
  const thumb = 'source/thumb.jpg'
  await extractCover(videoPath, abs(ctx, thumb), config.media.ffmpegPath).catch(() => {})
  const hasThumb = await stat(abs(ctx, thumb)).then(() => true).catch(() => false)

  const meta: SourceMeta = {
    platform: source.platform,
    provider: source.provider,
    videoFile: `source/${source.videoFile}`,
    filePath: abs(ctx, `source/${source.videoFile}`),
    title: source.title,
    ...(source.author === undefined ? {} : { author: source.author }),
    ...(source.durationSec === undefined ? {} : { durationSec: source.durationSec }),
    ...(probe === undefined ? {} : { width: probe.width, height: probe.height, fps: probe.fps }),
    ...(probe !== undefined && (source.durationSec === undefined || source.durationSec <= 0)
      ? { durationSec: probe.durationSec }
      : {}),
    ...(source.coverFile === undefined ? {} : { coverFile: source.coverFile }),
    ...(hasThumb ? { thumbFile: thumb } : {}),
    sourceUrl: extractUrl(input),
    ...(source.raw === undefined ? {} : { raw: source.raw }),
  }
  run.source = meta
  run.title = source.title.slice(0, 60) || run.title
  ctx.log('parse', 'info', `已解析：${meta.title}（${PLATFORM_LABELS[meta.platform]}，${meta.provider}）`)
  ctx.setStep('parse', { status: 'done', progress: 1, message: '已下载源视频', endedAt: Date.now() })
  touch(ctx)
}

// ---------------------------------------------------------------------------
// 第 2 步：AI 拆解
// ---------------------------------------------------------------------------

function normalizeShot(raw: unknown, index: number, durationSec: number): AnalysisShot {
  const record = asRecord(raw)
  const start = clamp(asNumber(record.startSec ?? record.start, (index - 1) * 3), 0, Math.max(0, durationSec))
  const end = clamp(asNumber(record.endSec ?? record.end, start + 3), start + 0.3, Math.max(start + 0.3, durationSec))
  return {
    index,
    startSec: Math.round(start * 10) / 10,
    endSec: Math.round(end * 10) / 10,
    shotType: asString(record.shotType ?? record.type, '中景'),
    camera: asString(record.camera ?? record.camera_movement, '固定'),
    visual: asString(record.visual ?? record.description, ''),
    voiceover: asString(record.voiceover ?? record.voiceover_text, ''),
    onscreenText: asString(record.onscreenText ?? record.on_screen_text, ''),
    lighting: asString(record.lighting ?? record.light, ''),
    environment: asString(record.environment ?? record.environmentMotion ?? record.env, ''),
    emotion: asString(record.emotion, ''),
    purpose: asString(record.purpose, ''),
  }
}

/** 节令关键词兜底：模型没给 occasion 时，从拆解文本里识别节令/时效。 */
const OCCASION_KEYWORDS: Array<{ pattern: RegExp, name: string }> = [
  { pattern: /万圣节|halloween/i, name: '万圣节' },
  { pattern: /春节|过年|农历新年/, name: '春节' },
  { pattern: /中秋/, name: '中秋节' },
  { pattern: /元宵/, name: '元宵节' },
  { pattern: /元旦|跨年/, name: '元旦跨年' },
  { pattern: /圣诞(节)?|christmas/i, name: '圣诞节' },
  { pattern: /情人节|七夕/, name: '情人节' },
  { pattern: /端午/, name: '端午节' },
  { pattern: /国庆/, name: '国庆' },
  { pattern: /开学季|开学|返校/, name: '开学季' },
  { pattern: /毕业季|毕业/, name: '毕业季' },
  { pattern: /双\s*11|双十一/, name: '双11' },
  { pattern: /618/, name: '618' },
  { pattern: /世界杯/, name: '世界杯' },
  { pattern: /奥运/, name: '奥运会' },
]

/** 从拆解文本推断节令；识别不到返回 undefined。 */
function inferOccasion(analysis: AnalysisReport): { name: string, why: string } | undefined {
  if (analysis.occasion !== undefined && analysis.occasion.name.trim() !== '') return analysis.occasion
  const corpus = [
    analysis.coreIdea,
    analysis.summary,
    analysis.whyItWorks,
    analysis.creativeDevice,
    analysis.hook.type,
    analysis.hook.text,
    ...(analysis.transcript ?? []).map(cue => cue.text),
    ...analysis.shots.map(shot => `${shot.visual} ${shot.onscreenText} ${shot.voiceover}`),
  ].join(' ')
  const hit = OCCASION_KEYWORDS.find(item => item.pattern.test(corpus))
  if (hit === undefined) return undefined
  return { name: hit.name, why: '从拆解的创意核心/台词里识别到节令或时效线索' }
}

/** 老拆解没有 characters 时，看一张源片截帧让视觉模型列出需要锁定的角色。 */
async function inferCharacters(ctx: PipelineContext): Promise<Array<{ name: string, identity: string }>> {
  const { run, config } = ctx
  const analysis = run.analysis
  if (analysis === undefined) return []
  if ((analysis.characters ?? []).length > 0) return analysis.characters ?? []
  const frameFile = analysis.frameFiles[0]
  if (frameFile === undefined) return []
  try {
    const image = await loadImage(join(dirOf(ctx), 'frames', frameFile))
    const raw = await completeText(ctx.dsh, config.analyze, {
      label: '角色识别',
      system: '你是短视频分镜师。只描述画面里确实可见的内容，不臆测。只输出严格 JSON。',
      user: [
        '看这张视频截帧，列出画面里需要逐镜保持一致的每个主要角色（1–3 个）。',
        '每个角色给：name（简短可区分，如「橘猫」「灰猫」「店主」）、identity（30–60 字外形身份证：物种/毛色/花纹/眼睛/体型/配饰）。',
        '画面里只有一个人物或动物时只给一条；不要写不存在的角色；不要写动作或场景。',
        '只输出：{"characters":[{"name":"","identity":""}]}',
      ].join('\n'),
      images: [image],
      json: true,
      maxTokens: 800,
      temperature: 0.2,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    const parsed = parseModelJson(raw, '角色识别')
    const list = asArray(parsed.characters)
      .map(item => {
        const row = asRecord(item)
        return { name: asString(row.name, '').trim(), identity: asString(row.identity ?? row.description, '').trim() }
      })
      .filter(item => item.name !== '' && item.identity !== '')
      .slice(0, 3)
    if (list.length > 0) {
      analysis.characters = list
      ctx.log('match', 'info', `识别出角色清单：${list.map(item => item.name).join('、')}`)
      touch(ctx)
    }
    return list
  } catch (error) {
    ctx.log('match', 'warn', `角色清单识别失败（不影响流程）：${messageOf(error).slice(0, 120)}`)
    return []
  }
}

const LENS_PATTERNS: Array<{ pattern: RegExp, text: string }> = [
  { pattern: /鱼眼|fisheye/i, text: '鱼眼超广角镜头（门禁/猫眼视角），画面四角桶形畸变、中心放大' },
  { pattern: /门禁|门铃|可视对讲|猫眼/, text: '门禁摄像头视角，广角略带畸变，机位在门框高度' },
  { pattern: /监控|摄像头|机位/, text: '固定监控机位视角，广角略畸变' },
  { pattern: /第一人称|pov|主观视角/i, text: '第一人称主观视角' },
  { pattern: /俯拍/, text: '高机位俯拍' },
]

/** 从拆解文本推断镜头语言（模型没给 lens 时兜底）。 */
function inferLens(analysis: AnalysisReport): string {
  const declared = (analysis.meta.lens ?? '').trim()
  if (declared !== '') return declared
  const corpus = [analysis.coreIdea, analysis.summary, analysis.hook.text, analysis.creativeDevice,
    ...analysis.shots.map(shot => `${shot.visual} ${shot.camera}`)].join(' ')
  const hit = LENS_PATTERNS.find(item => item.pattern.test(corpus))
  return hit === undefined ? '' : hit.text
}

function normalizeAnalysis(raw: Record<string, unknown>, options: {
  durationSec: number
  width: number
  height: number
  fps: number
  frameFiles: string[]
  model: string
  transcript?: TranscriptCue[]
}): AnalysisReport {
  const shotsRaw = asArray(raw.shots)
  const shots = shotsRaw.length > 0
    ? shotsRaw.slice(0, 40).map((shot, index) => normalizeShot(shot, index + 1, options.durationSec))
    : [normalizeShot({ startSec: 0, endSec: Math.max(1, options.durationSec), visual: asString(raw.summary) }, 1, options.durationSec)]

  const style = asRecord(raw.style)
  const hook = asRecord(raw.hook)
  const rhythm = asRecord(raw.rhythm)
  const scores = asRecord(raw.scores)
  const score = (key: string): number => clamp(Math.round(asNumber(scores[key], 6)), 0, 10)
  const dna = asArray(raw.dna).map(item => asString(item)).filter(item => item !== '')
  const characters = asArray(raw.characters)
    .map(item => {
      const row = asRecord(item)
      return { name: asString(row.name, '').trim(), identity: asString(row.identity ?? row.description, '').trim() }
    })
    .filter(item => item.name !== '' && item.identity !== '')
    .slice(0, 3)
  const occasionRaw = asRecord(raw.occasion)
  const occasionName = asString(occasionRaw.name ?? raw.occasion, '').trim()
  const occasionWhy = asString(occasionRaw.why ?? occasionRaw.reason, '').trim()
  const palette = asArray(style.palette).map(item => asString(item)).filter(item => item !== '')

  return {
    coreIdea: asString(raw.coreIdea ?? raw.core_idea, ''),
    creativeDevice: asString(raw.creativeDevice ?? raw.creative_device, ''),
    whyItWorks: asString(raw.whyItWorks ?? raw.why_it_works, ''),
    meta: {
      durationSec: options.durationSec,
      shotCount: shots.length,
      resolution: `${options.width}x${options.height}`,
      fps: options.fps,
      style: asString(raw.visualStyle ?? raw.videoType, '实拍写实'),
      ...(asString(raw.lens, '').trim() === '' ? {} : { lens: asString(raw.lens, '').trim() }),
      pacing: asString(rhythm.beatPattern, ''),
    },
    summary: asString(raw.summary, ''),
    ...(asString(raw.subjectIdentity ?? raw.subject_identity, '').trim() === ''
      ? {}
      : { subjectIdentity: asString(raw.subjectIdentity ?? raw.subject_identity, '').trim() }),
    ...(characters.length === 0 ? {} : { characters }),
    ...(occasionName === '' ? {} : { occasion: { name: occasionName, why: occasionWhy } }),
    hook: {
      type: asString(hook.type, ''),
      text: asString(hook.text, ''),
      whyItWorks: asString(hook.whyItWorks ?? hook.why, ''),
      seconds: asNumber(hook.seconds, shots[0]?.endSec ?? 3),
    },
    shots,
    rhythm: {
      avgShotSec: Math.round(asNumber(rhythm.avgShotSec, options.durationSec / Math.max(1, shots.length)) * 10) / 10,
      beatPattern: asString(rhythm.beatPattern, ''),
      cutPoints: asArray(rhythm.cutPoints).map(item => asNumber(item, 0)).filter(value => value > 0),
    },
    style: {
      palette: palette.length > 0 ? palette : ['自然'],
      typography: asString(style.typography, ''),
      music: asString(style.music, ''),
      colorGrade: asString(style.colorGrade, ''),
      subject: asString(style.subject, ''),
    },
    dna,
    scores: {
      hook: score('hook'),
      retention: score('retention'),
      conversion: score('conversion'),
      overall: score('overall'),
    },
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    frameFiles: options.frameFiles,
    model: options.model,
    analyzedAt: Date.now(),
  }
}

export async function stepAnalyze(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  if (run.source === undefined) throw new Error('还没有源视频，请先完成「解析下载」')
  ctx.setStep('analyze', { status: 'running', progress: 0.03, message: '读取源视频', startedAt: Date.now(), error: undefined })
  touch(ctx)

  const videoPath = abs(ctx, run.source.videoFile)
  const probe = await probeMedia(videoPath, config.media.ffprobePath).catch(() => undefined)
  if (probe === undefined || !probe.hasVideo) {
    throw new Error(
      '源视频无法解码：文件不是有效视频，或下载不完整（常见于解析服务返回了网页/风控页）。' +
      '请回到「解析下载」重试，或直接上传一个完整的视频文件。',
    )
  }
  const duration = probe.durationSec > 0 ? probe.durationSec : (run.source.durationSec ?? 0)

  // 长视频适当多抽几帧：2 分钟片子只给 12 帧，模型很难看清创意细节。
  const frameCount = duration > 60
    ? Math.min(24, Math.max(config.analyze.frameCount, 18))
    : config.analyze.frameCount
  // 抽帧
  ctx.setStep('analyze', { progress: 0.08, message: `抽取 ${frameCount} 帧` })
  touch(ctx)
  const framesDir = join(dirOf(ctx), 'frames')
  const frameFiles = await extractFrames({
    videoPath,
    outDir: framesDir,
    count: frameCount,
    maxSide: config.analyze.maxFrameSide,
    durationSec: duration,
    ffmpegPath: config.media.ffmpegPath,
  })
  if (frameFiles.length === 0) throw new Error('抽帧失败：ffmpeg 未能从源视频取到画面')
  checkAbort(ctx)

  // 可选 ASR：把音轨转成口播文稿
  let transcript: TranscriptCue[] | undefined
  const asrConfigured = config.asr.enabled && (usesDsh(config.asr) || config.asr.apiUrl.trim() !== '')
  if (asrConfigured && !probe.hasAudio) {
    ctx.log('analyze', 'info', '源视频没有音轨，跳过语音识别（只按画面拆解）')
  }
  if (asrConfigured && probe.hasAudio) {
    ctx.setStep('analyze', { progress: 0.2, message: '转写口播音频' })
    touch(ctx)
    try {
      const wav = join(dirOf(ctx), 'audio', 'source.wav')
      await mkdir(join(dirOf(ctx), 'audio'), { recursive: true })
      await runCommand(config.media.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      ], { timeoutMs: 600_000 })
      const asrEndpoint = await resolveEndpoint(ctx.dsh, config.asr, '语音识别')
      transcript = await transcribeAudio({
        config: {
          ...config.asr,
          apiUrl: asrEndpoint.apiUrl,
          apiKey: asrEndpoint.apiKey,
          model: asrEndpoint.model,
        },
        audioFile: wav,
        durationSec: duration,
        label: '语音识别',
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      ctx.log('analyze', 'info', `已转写 ${transcript.length} 句口播`)
    } catch (error) {
      const text = messageOf(error)
      const hint = /HTTP 404|Not Found/i.test(text)
        ? '（该网关没有 /audio/transcriptions 端点；可换支持 Whisper 协议的端点，或留空 ASR 只按画面拆解）'
        : ''
      ctx.log('analyze', 'warn', `语音识别失败，改用画面识别：${text}${hint}`)
      transcript = undefined
    }
  } else {
    ctx.log('analyze', 'info', '未配置语音识别：口播稿仅依据画面与画面文字推断')
  }
  checkAbort(ctx)

  ctx.setStep('analyze', { progress: 0.35, message: `视觉模型逐镜拆解（${frameFiles.length} 帧）` })
  touch(ctx)
  const images: ChatImage[] = []
  for (const file of frameFiles) {
    images.push(await loadImage(join(framesDir, file)))
  }

  const raw = await completeText(ctx.dsh, config.analyze, {
    label: 'AI 拆解',
    system: `${ANALYZE_SYSTEM}\n景别只能取：${SHOT_TYPES.join('、')}；运镜只能取：${CAMERA_MOVES.join('、')}。`,
    user: analyzePrompt({
      platformLabel: PLATFORM_LABELS[run.source.platform],
      title: run.source.title,
      durationSec: duration,
      frameCount: frameFiles.length,
      width: probe?.width ?? run.source.width ?? 0,
      height: probe?.height ?? run.source.height ?? 0,
      ...(transcript === undefined ? {} : { transcript }),
      ...(run.productBrief === undefined ? {} : { productBrief: run.productBrief }),
    }),
    images,
    json: true,
    maxTokens: 8000,
    temperature: 0.3,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })

  const parsed = parseModelJson(raw, 'AI 拆解')
  const analysis = normalizeAnalysis(parsed, {
    durationSec: duration,
    width: probe?.width ?? run.source.width ?? 0,
    height: probe?.height ?? run.source.height ?? 0,
    fps: probe?.fps ?? run.source.fps ?? 0,
    frameFiles,
    model: config.analyze.model,
    ...(transcript === undefined ? {} : { transcript }),
  })
  run.analysis = analysis
  ctx.log('analyze', 'info', `拆解完成：${analysis.shots.length} 个镜头，综合评分 ${analysis.scores.overall}`)
  ctx.setStep('analyze', { status: 'done', progress: 1, message: `${analysis.shots.length} 个镜头`, endedAt: Date.now() })
  touch(ctx)
}

// ---------------------------------------------------------------------------
// 第 3 步：AI 仿写
// ---------------------------------------------------------------------------

/** 分镜的景别/运镜：脚本没给就回退到源片同序号镜头，再不行给默认值。 */
function normalizeSegmentLook(
  record: Record<string, unknown>,
  index: number,
  sourceShots: Array<{ shotType: string, camera: string }>,
): { shotType: string, camera: string } {
  const allowedShot = SHOT_TYPES as readonly string[]
  const allowedCamera = CAMERA_MOVES as readonly string[]
  const fallback = sourceShots[index] ?? sourceShots[0] ?? { shotType: '中景', camera: '固定' }
  const shotRaw = asString(record.shotType ?? record.shot ?? record.shotSize, '').trim()
  const cameraRaw = asString(record.camera ?? record.cameraMove, '').trim()
  const shotType = allowedShot.includes(shotRaw)
    ? shotRaw
    : (allowedShot.find(item => shotRaw.includes(item)) ?? fallback.shotType ?? '中景')
  const camera = allowedCamera.includes(cameraRaw)
    ? cameraRaw
    : (allowedCamera.find(item => cameraRaw.includes(item)) ?? fallback.camera ?? '固定')
  return { shotType, camera }
}

function normalizeSegments(raw: unknown, durationSec: number, sourceShots: Array<{ shotType: string, camera: string }> = []): ScriptSegment[] {
  const list = asArray(raw)
  const segments: ScriptSegment[] = []
  let cursor = 0
  for (const item of list) {
    const record = asRecord(item)
    // 模型常给出互相重叠的起止秒，这里按顺序拉平，避免切块时长虚高。
    const start = Math.max(cursor, asNumber(record.startSec ?? record.start, cursor))
    const duration = clamp(asNumber(record.endSec ?? record.end, start + 4) - start, 2, 12)
    const end = Math.min(Math.max(start + 2, start + duration), Math.max(durationSec * 1.4, start + 2))
    const look = normalizeSegmentLook(record, segments.length, sourceShots)
    segments.push({
      index: segments.length + 1,
      startSec: Math.round(start * 10) / 10,
      endSec: Math.round(end * 10) / 10,
      shotType: look.shotType,
      camera: look.camera,
      voiceover: asString(record.voiceover ?? record.voiceover_text, ''),
      onscreenText: asString(record.onscreenText ?? record.on_screen_text, ''),
      visualPrompt: asString(record.visualPrompt ?? record.visual_description, ''),
      lighting: asString(record.lighting ?? record.light, ''),
      environment: asString(record.environment ?? record.environmentMotion, ''),
      emotion: asString(record.emotion ?? record.mood, ''),
      speaker: asString(record.speaker ?? record.character, ''),
      productPlacement: asString(record.productPlacement ?? record.product_placement, ''),
    })
    cursor = end
  }
  return segments
}

function normalizeVariants(
  raw: Record<string, unknown>,
  sourceDuration: number,
  sourceShots: Array<{ shotType: string, camera: string }> = [],
): { variants: ScriptVariant[], recommendedId: string } {
  const list = asArray(raw.variants ?? raw.versions)
  const variants: ScriptVariant[] = []
  for (const [index, item] of list.entries()) {
    const record = asRecord(item)
    const segments = normalizeSegments(record.segments ?? record.shots, sourceDuration, sourceShots)
    if (segments.length === 0) continue
    const id = asString(record.id ?? record.version, String.fromCharCode(65 + index)).toUpperCase()
    const total = asNumber(record.totalDurationSec, segments.at(-1)?.endSec ?? sourceDuration)
    variants.push({
      id,
      angle: asString(record.angle, ''),
      title: asString(record.title, `${id} 版`),
      hookLine: asString(record.hookLine ?? record.hook, ''),
      totalDurationSec: Math.round(total),
      notes: asString(record.notes ?? record.creative_inheritance, ''),
      segments,
    })
  }
  if (variants.length === 0) throw new Error('仿写结果里没有可用分镜（模型可能返回了空数组）')
  const recommended = asString(raw.recommendedId, variants[0]?.id ?? 'A').toUpperCase()
  return {
    variants,
    recommendedId: variants.some(variant => variant.id === recommended) ? recommended : variants[0]!.id,
  }
}

/** 让视觉模型描述产品参考图的外观（写进提示词，保证跨镜头一致）。 */
async function describeProduct(ctx: PipelineContext, images: ProductImage[]): Promise<string> {
  const first = images[0]
  if (first === undefined) return ''
  try {
    const image = await loadImage(abs(ctx, first.file))
    const raw = await completeText(ctx.dsh, ctx.config.analyze, {
      label: '产品图识别',
      system: '你是一位严谨的产品视觉描述专家。只描述图片中确实可见的内容，禁止臆测。只输出 JSON。',
      user: productDescribePrompt(first.name),
      images: [image],
      json: true,
      maxTokens: 400,
      temperature: 0.2,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    const parsed = parseModelJson(raw, '产品图识别')
    return asString(parsed.visual, '')
  } catch (error) {
    ctx.log('rewrite', 'warn', `产品图识别失败（不影响流程）：${messageOf(error)}`)
    return ''
  }
}

export async function stepRewrite(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  if (run.analysis === undefined) throw new Error('还没有拆解报告，请先完成「AI 拆解」')
  ctx.setStep('rewrite', { status: 'running', progress: 0.1, message: '准备仿写', startedAt: Date.now(), error: undefined })
  touch(ctx)

  // 镜头语言兜底：老拆解没有 lens 时从画面/创意文本里识别（鱼眼、门禁、监控…）。
  if ((run.analysis.meta.lens ?? '') === '') {
    const lens = inferLens(run.analysis)
    if (lens !== '') {
      run.analysis.meta.lens = lens
      ctx.log('rewrite', 'info', `识别到镜头语言：${lens}`)
      touch(ctx)
    }
  }

  // 节令兜底：老拆解可能没有 occasion 字段，从文本里识别一次并写回，避免仿写把节日弄丢。
  if (run.analysis.occasion === undefined) {
    const inferred = inferOccasion(run.analysis)
    if (inferred !== undefined) {
      run.analysis.occasion = inferred
      ctx.log('rewrite', 'info', `识别到节令/时效钩子：${inferred.name}（仿写会保留它）`)
      touch(ctx)
    }
  }

  if (run.productVisual === undefined && run.productImages.length > 0) {
    ctx.setStep('rewrite', { progress: 0.2, message: '识别产品外观' })
    touch(ctx)
    run.productVisual = await describeProduct(ctx, run.productImages)
    ctx.log('rewrite', 'info', run.productVisual === '' ? '产品图未识别出可用描述' : `产品外观：${run.productVisual}`)
    touch(ctx)
  }
  checkAbort(ctx)

  const sourceDuration = run.analysis.meta.durationSec > 0
    ? run.analysis.meta.durationSec
    : (run.source?.durationSec ?? 30)
  const targetDuration = clamp(sourceDuration, 8, 75)

  ctx.setStep('rewrite', { progress: 0.35, message: '模型仿写 3 版脚本' })
  touch(ctx)
  const system = `${REWRITE_SYSTEM}\nshotType 只能取：${SHOT_TYPES.join('、')}；camera 只能取：${CAMERA_MOVES.join('、')}，一镜只用一种。`
  const userPrompt = rewritePrompt({
    analysis: run.analysis,
    productBrief: run.productBrief ?? '',
    hasProductImages: run.productImages.length > 0,
    productNames: run.productImages.map(image => image.name),
    targetDurationSec: targetDuration,
    mode: run.rewriteMode ?? config.rewriteMode,
  })
  // 长时间源片容易让模型写飞（实测出现 30 万字符的重复输出），
  // 这里做一次「紧凑重试」：只要输出异常长、解析失败或版本不足 2 版，就用压缩指令再要一次。
  const compactHint = '\n\n# 输出压缩要求（本轮必须遵守）\n- 每版最多 5 个分镜，可把源片同类镜头合并；\n- visualPrompt ≤40 个汉字，notes ≤40 字；\n- 只输出一个 JSON 对象，不要重复、不要解释；总输出控制在 6000 字以内。'
  let raw = ''
  let parsed: Record<string, unknown> | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await completeText(ctx.dsh, config.rewrite, {
      label: 'AI 仿写',
      system,
      user: attempt === 0 ? userPrompt : `${userPrompt}${compactHint}`,
      json: true,
      maxTokens: attempt === 0 ? 24000 : 16000,
      temperature: attempt === 0 ? 0.75 : 0.6,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    raw = reply
    if (reply.length > 50_000) {
      ctx.log('rewrite', 'warn', `模型输出异常长（${reply.length} 字符），疑似重复，正在用压缩指令重试…`)
      continue
    }
    try {
      parsed = parseModelJson(raw, 'AI 仿写')
      const count = Array.isArray(parsed.variants) ? parsed.variants.length : 0
      if (count >= 2) break
      ctx.log('rewrite', 'warn', `只解析出 ${count} 版脚本，正在用压缩指令重试…`)
    } catch (error) {
      ctx.log('rewrite', 'warn', `仿写输出无法解析（${messageOf(error).slice(0, 120)}），正在重试…`)
    }
  }
  if (parsed === undefined) parsed = parseModelJson(raw, 'AI 仿写')
  const checksRaw = asRecord(parsed.checks)
  const checks = {
    keptCoreIdea: asString(checksRaw.keptCoreIdea, '').trim(),
    keptOccasion: asString(checksRaw.keptOccasion, '').trim(),
    keptSubject: asString(checksRaw.keptSubject, '').trim(),
    changed: asString(checksRaw.changed, '').trim(),
  }
  if (checks.keptOccasion !== '' || checks.keptSubject !== '') {
    ctx.log('rewrite', 'info', `仿写自检：主体=${checks.keptSubject === '' ? '—' : checks.keptSubject}；节令=${checks.keptOccasion === '' ? '—' : checks.keptOccasion}`)
  }
  const { variants, recommendedId } = normalizeVariants(
    parsed,
    targetDuration,
    run.analysis.shots.map(shot => ({ shotType: shot.shotType, camera: shot.camera })),
  )
  run.scripts = {
    variants,
    recommendedId,
    checks,
    productBrief: run.productBrief ?? '',
    model: config.rewrite.model,
    createdAt: Date.now(),
  }
  run.variantId = variants.some(variant => variant.id === run.variantId) ? run.variantId : recommendedId
  ctx.log('rewrite', 'info', `生成 ${variants.length} 版脚本，推荐 ${recommendedId} 版`)
  ctx.setStep('rewrite', { status: 'done', progress: 1, message: `${variants.length} 版脚本`, endedAt: Date.now() })
  touch(ctx)
}

// ---------------------------------------------------------------------------
// 第 4 步：参考图匹配（产品融入分镜）
// ---------------------------------------------------------------------------

export function selectedVariant(run: RunState): ScriptVariant | undefined {
  if (run.scripts === undefined) return undefined
  return run.scripts.variants.find(variant => variant.id === run.variantId)
    ?? run.scripts.variants.find(variant => variant.id === run.scripts?.recommendedId)
    ?? run.scripts.variants[0]
}

/** 解析实际生效的产品融入方式：ark-seedance + 写实画风时自动走文生图（方舟只信任 Seedream 文生图产物）。 */

/** 项目画幅：run 上选的值优先，没选过用配置默认，最后源片兜底。 */
function resolveAspect(run: RunState, config: PluginConfig): { width: number, height: number } {
  return aspectSizeOf(run.aspectRatio ?? config.video.aspectRatio, run.source)
}

function resolveProductMode(config: PluginConfig): 'reference' | 'text' {
  if (config.imageProductMode === 'reference' || config.imageProductMode === 'text') return config.imageProductMode
  const imageIsSeedream = /seedream/i.test(config.image.model) || /seedream/i.test(config.image.dshModel)
  return config.video.protocol === 'ark-seedance' && config.imageFrameStyle === 'photo' && imageIsSeedream
    ? 'text'
    : 'reference'
}

export async function stepMatch(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本，请先完成「AI 仿写」')
  ctx.setStep('match', { status: 'running', progress: 0.02, message: '生成分镜参考图', startedAt: Date.now(), error: undefined })
  touch(ctx)

  const productImages: ChatImage[] = []
  const productMode = resolveProductMode(config)
  if (productMode === 'text' && run.productImages.length > 0) {
    ctx.log('match', 'info', '产品融入方式：文字描述（文生图）——方舟只信任 Seedream 文生图产物，带参考图的图生图会被判「疑似真实人物」')
  }
  for (const image of productMode === 'text' ? [] : run.productImages.slice(0, 3)) {
    try {
      productImages.push(await loadImage(abs(ctx, image.file)))
    } catch {
      // 单张产品图读不到就跳过
    }
  }
  // 镜头语言兜底：老拆解没有 lens 时从画面文本里识别（鱼眼/门禁/监控…），保证首帧视角一致。
  if (run.analysis !== undefined && (run.analysis.meta.lens ?? '') === '') {
    const lens = inferLens(run.analysis)
    if (lens !== '') {
      run.analysis.meta.lens = lens
      ctx.log('match', 'info', `识别到镜头语言：${lens}`)
      touch(ctx)
    }
  }
  const aspect = resolveAspect(run, config)
  const styleHint = run.analysis === undefined
    ? ''
    : `${run.analysis.meta.style}${run.analysis.style.palette.length > 0 ? `，主色调 ${run.analysis.style.palette.slice(0, 3).join('/')}` : ''}${run.analysis.style.colorGrade === '' ? '' : `，${run.analysis.style.colorGrade}`}`


  // 纯复刻（没有产品图）时，先为每个角色生成一张「角色锚点」：各镜首帧都以它们为参考，
  // 否则每个分镜都会用文生图凭空造一个长得不一样的主角（多角色时尤其明显）。
  const pureReplica = run.productImages.length === 0
  if (pureReplica && (run.analysis?.characters ?? []).length === 0) {
    await inferCharacters(ctx)
  }
  const characters = (run.analysis?.characters !== undefined && run.analysis.characters.length > 0
    ? run.analysis.characters
    : (run.analysis?.subjectIdentity ?? '').trim() === ''
      ? []
      : [{ name: '主角', identity: run.analysis?.subjectIdentity ?? '' }])
    .filter(item => item.identity.trim() !== '')
    .slice(0, 3)
  if (pureReplica && characters.length > 0) {
    run.subjects = run.subjects ?? []
    for (const [index, character] of characters.entries()) {
      if (run.subjects.some(item => item.name === character.name)) continue
      const anchorFile = `subject/anchor-${index + 1}.png`
      ctx.log('match', 'info', `生成角色锚点「${character.name}」：${character.identity.slice(0, 50)}`)
      ctx.setStep('match', { progress: 0.03, message: `生成角色锚点 ${index + 1}/${characters.length}（${character.name}）` })
      touch(ctx)
      try {
        const imageEndpoint = await resolveEndpoint(ctx.dsh, config.image, `角色锚点 ${character.name}`)
        await generateImage({
          apiUrl: imageEndpoint.apiUrl,
          apiKey: imageEndpoint.apiKey,
          model: imageEndpoint.model,
          protocol: imageEndpoint.fromDsh ? 'openai-images' : config.image.protocol,
          ...(config.image.extraJson === undefined ? {} : { extraJson: config.image.extraJson }),
          ...(config.image.timeoutSec === undefined ? {} : { timeoutSec: config.image.timeoutSec }),
          prompt: `角色设定图：${character.identity}。单个角色正面半身、正对镜头，完整清晰展现外形特征（毛色/花纹/眼睛/体型/配饰）；纯色干净背景，中性柔和光，画面里只有一个角色，无文字、无字幕、无 Logo，不要拼图、不要多视角排版。`,
          aspect: ratioOf(`${aspect.width}x${aspect.height}`),
          width: aspect.width,
          height: aspect.height,
          outFile: abs(ctx, anchorFile),
          label: `角色锚点 ${character.name}`,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
        run.subjects.push({ name: character.name, description: character.identity, anchorFile, createdAt: Date.now() })
        touch(ctx)
      } catch (error) {
        ctx.log('match', 'warn', `角色锚点「${character.name}」生成失败（不影响流程，但该角色可能不一致）：${messageOf(error).slice(0, 160)}`)
      }
    }
  }
  const subjectAnchors = (run.subjects ?? []).map(item => ({ name: item.name, description: item.description }))
  const subjectImages: ChatImage[] = []
  for (const item of run.subjects ?? []) {
    const image = await loadImage(abs(ctx, item.anchorFile)).catch(() => undefined)
    if (image !== undefined) subjectImages.push(image)
  }

  const lightingBaseline = run.analysis?.shots.find(shot => shot.lighting.trim() !== '')?.lighting ?? ''
  const frames: StoryboardFrame[] = []
  for (const [index, segment] of variant.segments.entries()) {
    checkAbort(ctx)
    const file = `frames/ref-${pad2(index + 1)}.png`
    const sourceShot = run.analysis?.shots.find(shot => shot.index === segment.index)
    const prompt = framePrompt({
      segment: {
        index: segment.index,
        shotType: segment.shotType,
        camera: segment.camera,
        visualPrompt: segment.visualPrompt,
        productPlacement: segment.productPlacement,
        // 优先用分镜自己写的光线/环境（新世界），没有才回退到源片拆解。
        lighting: segment.lighting !== '' ? segment.lighting : (sourceShot?.lighting ?? ''),
        environment: segment.environment !== '' ? segment.environment : (sourceShot?.environment ?? ''),
      },
      productVisual: run.productVisual ?? '',
      hasProduct: run.productImages.length > 0,
      productMode,
      aspect,
      styleHint,
      frameStyle: config.imageFrameStyle,
      ...(lightingBaseline === '' ? {} : { lightingBaseline }),
      ...(subjectAnchors.length === 0 ? {} : { subjectAnchors }),
      ...(run.analysis?.meta.lens === undefined || run.analysis.meta.lens.trim() === '' ? {} : { lens: run.analysis.meta.lens }),
    })
    ctx.setStep('match', {
      progress: (index / Math.max(1, variant.segments.length)) * 0.9,
      message: `生成第 ${index + 1}/${variant.segments.length} 张参考图`,
    })
    touch(ctx)
    try {
      const imageEndpoint = await resolveEndpoint(ctx.dsh, config.image, `参考图 ${index + 1}`)
      await generateImage({
        apiUrl: imageEndpoint.apiUrl,
        apiKey: imageEndpoint.apiKey,
        model: imageEndpoint.model,
        protocol: imageEndpoint.fromDsh ? 'openai-images' : config.image.protocol,
        ...(config.image.extraJson === undefined ? {} : { extraJson: config.image.extraJson }),
        ...(config.image.timeoutSec === undefined ? {} : { timeoutSec: config.image.timeoutSec }),
        prompt,
        ...(productImages.length === 0 ? {} : { images: productImages }),
        aspect: ratioOf(`${aspect.width}x${aspect.height}`),
        width: aspect.width,
        height: aspect.height,
        outFile: abs(ctx, file),
        label: `参考图 ${index + 1}`,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      frames.push({
        segmentIndex: segment.index,
        file,
        prompt,
        mode: run.productImages.length > 0 ? 'product' : 'scene',
        createdAt: Date.now(),
      })
    } catch (error) {
      ctx.log('match', 'warn', `第 ${index + 1} 张参考图生成失败：${messageOf(error)}`)
      frames.push({
        segmentIndex: segment.index,
        file: '',
        prompt,
        mode: run.productImages.length > 0 ? 'product' : 'scene',
        error: messageOf(error),
        createdAt: Date.now(),
      })
    }
  }

  run.frames = frames
  const ok = frames.filter(frame => frame.file !== '').length
  if (ok === 0) throw new Error('所有参考图都生成失败：请检查图片模型配置与额度')
  ctx.log('match', 'info', `参考图完成：${ok}/${frames.length} 张`)
  ctx.setStep('match', { status: 'done', progress: 1, message: `${ok}/${frames.length} 张参考图`, endedAt: Date.now() })
  touch(ctx)
}

/**
 * 预览提示词：完全按 ④/⑤ 的规则拼好首帧与分镜视频提示词，但不调用任何模型、不消耗额度。
 * 用于“先审提示词再决定要不要花钱出图”。
 */
export function buildPromptPreview(run: RunState, config: PluginConfig): {
  variantId: string
  productMode: 'reference' | 'text'
  frames: Array<{ segmentIndex: number, shotType: string, camera: string, framePrompt: string }>
  videos: Array<{ segmentIndex: number, durationSec: number, shots: number[], videoPrompt: string }>
} {
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本，请先完成「AI 仿写」')
  const productMode = resolveProductMode(config)
  const aspect = resolveAspect(run, config)
  const styleHint = run.analysis === undefined
    ? ''
    : `${run.analysis.meta.style}${run.analysis.style.palette.length > 0 ? `，主色调 ${run.analysis.style.palette.slice(0, 3).join('/')}` : ''}${run.analysis.style.colorGrade === '' ? '' : `，${run.analysis.style.colorGrade}`}`
  const lightingBaseline = run.analysis?.shots.find(shot => shot.lighting.trim() !== '')?.lighting ?? ''

  const frames = variant.segments.map(segment => {
    const sourceShot = run.analysis?.shots.find(shot => shot.index === segment.index)
    const frame = framePrompt({
      segment: {
        index: segment.index,
        shotType: segment.shotType,
        camera: segment.camera,
        visualPrompt: segment.visualPrompt,
        productPlacement: segment.productPlacement,
        lighting: segment.lighting !== '' ? segment.lighting : (sourceShot?.lighting ?? ''),
        environment: segment.environment !== '' ? segment.environment : (sourceShot?.environment ?? ''),
      },
      productVisual: run.productVisual ?? '',
      hasProduct: run.productImages.length > 0,
      productMode,
      aspect,
      styleHint,
      frameStyle: config.imageFrameStyle,
      ...(lightingBaseline === '' ? {} : { lightingBaseline }),
    })
    return { segmentIndex: segment.index, shotType: segment.shotType, camera: segment.camera, framePrompt: frame }
  })

  const videos = buildChunks(variant.segments).map(chunk => {
    const includeProductImage = config.video.protocol === 'ark-seedance' && run.productImages.length > 0
    return {
      segmentIndex: chunk.index,
      durationSec: chunk.durationSec,
      shots: chunk.shots.map(shot => shot.index),
      videoPrompt: videoPrompt({
        shots: chunk.shots.map(shot => {
          const sourceShot = run.analysis?.shots.find(item => item.index === shot.index)
          return {
            ...shotHint(run, shot),
            visualPrompt: shot.visualPrompt,
            voiceover: shot.voiceover,
            environment: shot.environment !== '' ? shot.environment : (sourceShot?.environment ?? ''),
            lighting: shot.lighting !== '' ? shot.lighting : (sourceShot?.lighting ?? ''),
            emotion: shot.emotion,
          }
        }),
        hasProduct: run.productImages.length > 0,
        includeProductImage,
        productVisual: run.productVisual ?? '',
        styleHint,
        ...(subjectIdentityForPrompt(run) === '' ? {} : { subjectIdentity: subjectIdentityForPrompt(run) }),
      ...(run.analysis?.meta.lens === undefined || run.analysis.meta.lens.trim() === '' ? {} : { lens: run.analysis.meta.lens }),
        continuation: chunk.index > 1
            && chunk.shots[0]?.index === buildChunks(variant.segments)[chunk.index - 2]?.shots.at(-1)?.index,
        aspect,
        frameStyle: config.imageFrameStyle,
        ...(lightingBaseline === '' ? {} : { lightingBaseline }),
        seconds: chunk.durationSec,
      }),
    }
  })

  return { variantId: variant.id, productMode, frames, videos }
}

// ---------------------------------------------------------------------------
// 第 5 步：AI 生成分镜视频
// ---------------------------------------------------------------------------

const MAX_SHOTS_PER_CHUNK = 1
const MAX_CHUNK_SECONDS = 15
const MIN_CHUNK_SECONDS = 4
const MAX_CHUNKS = 12

export interface VideoChunk {
  index: number
  shots: ScriptSegment[]
  durationSec: number
}

/** 按「≤5 镜 / ≤15 秒」把分镜切成生成块。 */
export function buildChunks(segments: ScriptSegment[]): VideoChunk[] {
  const chunks: VideoChunk[] = []
  let current: ScriptSegment[] = []
  let currentSeconds = 0
  const flush = (): void => {
    if (current.length === 0) return
    const duration = clamp(Math.round(currentSeconds), MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS)
    chunks.push({ index: chunks.length + 1, shots: current, durationSec: duration })
    current = []
    currentSeconds = 0
  }
  for (const segment of segments) {
    const duration = Math.max(2, segment.endSec - segment.startSec)
    if (current.length >= MAX_SHOTS_PER_CHUNK || currentSeconds + duration > MAX_CHUNK_SECONDS) flush()
    current.push(segment)
    currentSeconds += duration
  }
  flush()
  // 尾巴太短（< 4 秒）时并进前一块：否则会为 2 秒的镜头白白生成 4 秒视频。
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1]
    const previous = chunks[chunks.length - 2]
    if (last !== undefined && previous !== undefined
      && last.durationSec < MIN_CHUNK_SECONDS
      && previous.shots.length + last.shots.length <= MAX_SHOTS_PER_CHUNK
      && previous.durationSec + last.durationSec <= MAX_CHUNK_SECONDS) {
      previous.shots = [...previous.shots, ...last.shots]
      previous.durationSec = clamp(previous.durationSec + last.durationSec, MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS)
      chunks.pop()
    }
  }
  // 超出块数上限时把后段合并进最后一块（最多 6 块 = 90 秒，覆盖绝大多数需求）。
  if (chunks.length > MAX_CHUNKS) {
    const kept = chunks.slice(0, MAX_CHUNKS - 1)
    const rest = chunks.slice(MAX_CHUNKS - 1)
    kept.push({
      index: kept.length + 1,
      shots: rest.flatMap(chunk => chunk.shots),
      durationSec: clamp(Math.round(rest.reduce((sum, chunk) => sum + chunk.durationSec, 0)), MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS),
    })
    return kept
  }
  return chunks
}

/** 从源片拆解里取同序号镜头的景别/运镜，写进视频提示词。 */
function shotHint(run: RunState, segment: ScriptSegment): { shotType: string, camera: string } {
  // 脚本自己写了景别/运镜就用脚本的（新脚本可能和源片不一样），否则回退到源片同序号镜头。
  if (segment.shotType !== undefined && segment.shotType.trim() !== '') {
    return { shotType: segment.shotType.trim(), camera: (segment.camera ?? '').trim() || '固定' }
  }
  const source = run.analysis?.shots.find(shot => shot.index === segment.index)
    ?? run.analysis?.shots[segment.index - 1]
  const shotType = (source?.shotType ?? '').trim()
  const camera = (source?.camera ?? '').trim()
  return {
    shotType: shotType === '' ? '中景' : shotType,
    camera: camera === '' ? '' : camera,
  }
}

export async function stepGenerate(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本，请先完成「AI 仿写」')
  ctx.setStep('generate', { status: 'running', progress: 0.02, message: '规划生成分段', startedAt: Date.now(), error: undefined })
  touch(ctx)

  const chunks = buildChunks(variant.segments)
  const productImages: ChatImage[] = []
  for (const image of run.productImages.slice(0, 2)) {
    try {
      productImages.push(await loadImage(abs(ctx, image.file)))
    } catch {
      // 忽略
    }
  }
  const styleHint = run.analysis === undefined
    ? ''
    : `${run.analysis.meta.style}${run.analysis.style.colorGrade === '' ? '' : `，${run.analysis.style.colorGrade}`}`
  const sourceWidth = run.source?.width ?? 0
  const sourceHeight = run.source?.height ?? 0
  const aspect = sourceWidth > 0 && sourceHeight > 0
    ? { width: sourceWidth, height: sourceHeight }
    : { width: 720, height: 1280 }
  const lightingBaseline = run.analysis?.shots.find(shot => shot.lighting.trim() !== '')?.lighting ?? ''

  const segments: SegmentVideo[] = chunks.map(chunk => ({
    segmentIndex: chunk.index,
    shots: chunk.shots.map(shot => shot.index),
    status: 'pending',
    durationSec: chunk.durationSec,
  }))
  run.segments = segments
  touch(ctx)

  const size = config.video.size.trim() === '' ? '720x1280' : config.video.size.trim()
  let completed = 0
  const total = chunks.length
  const failures: string[] = []

  const runChunk = async (chunk: VideoChunk): Promise<void> => {
    const slot = run.segments[chunk.index - 1]
    if (slot === undefined) return
    checkAbort(ctx)
    slot.status = 'running'
    slot.startedAt = Date.now()
    touch(ctx)

    // 参考图：优先用本块首镜的参考图。
    const referenceFiles = chunk.shots
      .map(shot => run.frames.find(frame => frame.segmentIndex === shot.index && frame.file !== '')?.file)
      .filter((file): file is string => file !== undefined)
    const referenceFile = referenceFiles[0]
    const referenceImage = referenceFile === undefined
      ? undefined
      : await loadImage(abs(ctx, referenceFile)).catch(() => undefined)
    // ark-seedance 走「全模态参考」，产品图 + 首帧都传（都用 reference_image）；
    // 其它网关基本只吃一张图，优先传首帧，产品外观交给提示词。
    const includeProductImage = config.video.protocol === 'ark-seedance' && productImages.length > 0
    const images: ChatImage[] = includeProductImage
      ? [...productImages, ...(referenceImage === undefined ? [] : [referenceImage])]
      : (referenceImage === undefined ? [] : [referenceImage])

    const prompt = videoPrompt({
      shots: chunk.shots.map(shot => {
        const sourceShot = run.analysis?.shots.find(item => item.index === shot.index)
        return {
          ...shotHint(run, shot),
          visualPrompt: shot.visualPrompt,
          voiceover: shot.voiceover,
          ...(sourceShot === undefined ? {} : { environment: sourceShot.environment, lighting: sourceShot.lighting }),
        }
      }),
      hasProduct: run.productImages.length > 0,
      includeProductImage,
      productVisual: run.productVisual ?? '',
      styleHint,
      ...(subjectIdentityForPrompt(run) === '' ? {} : { subjectIdentity: subjectIdentityForPrompt(run) }),
      ...(run.analysis?.meta.lens === undefined || run.analysis.meta.lens.trim() === '' ? {} : { lens: run.analysis.meta.lens }),
      continuation: chunk.index > 1
            && chunk.shots[0]?.index === buildChunks(variant.segments)[chunk.index - 2]?.shots.at(-1)?.index,
      aspect,
      frameStyle: config.imageFrameStyle,
      ...(lightingBaseline === '' ? {} : { lightingBaseline }),
      seconds: chunk.durationSec,
    })
    slot.prompt = prompt
    if (referenceFile !== undefined) slot.referenceFile = referenceFile
    touch(ctx)

    const file = `segments/seg-${pad2(chunk.index)}.mp4`
    try {
      const videoEndpoint = await resolveEndpoint(ctx.dsh, config.video, `分镜 ${chunk.index}`)
      await generateVideo({
        apiUrl: videoEndpoint.apiUrl,
        apiKey: videoEndpoint.apiKey,
        model: videoEndpoint.model,
        protocol: videoEndpoint.fromDsh ? 'openai-video' : config.video.protocol,
        ...(config.video.extraJson === undefined ? {} : { extraJson: config.video.extraJson }),
        ...(config.video.timeoutSec === undefined ? {} : { timeoutSec: config.video.timeoutSec }),
        prompt,
        ...(images.length === 0 ? {} : { images }),
        size,
        seconds: chunk.durationSec,
        outFile: abs(ctx, file),
        pollSec: config.video.pollSec,
        label: `分镜 ${chunk.index}`,
        onProgress: (message, progress) => {
          slot.status = 'running'
          touch(ctx)
          ctx.setStep('generate', {
            progress: ((completed + clamp(progress, 0, 1)) / total) * 0.95,
            message: `第 ${chunk.index}/${total} 段：${message}`,
          })
        },
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })
      const probe = await probeMedia(abs(ctx, file), config.media.ffprobePath).catch(() => undefined)
      slot.status = 'done'
      slot.file = file
      slot.endedAt = Date.now()
      if (probe !== undefined && probe.durationSec > 0) slot.durationSec = probe.durationSec
      completed += 1
      ctx.setStep('generate', { progress: (completed / total) * 0.95, message: `已完成 ${completed}/${total} 段` })
      ctx.log('generate', 'info', `第 ${chunk.index} 段生成完成（${slot.durationSec?.toFixed(1) ?? '?'}s）`)
    } catch (error) {
      slot.status = 'failed'
      slot.error = messageOf(error)
      slot.endedAt = Date.now()
      failures.push(`第 ${chunk.index} 段：${messageOf(error)}`)
      ctx.log('generate', 'error', `第 ${chunk.index} 段失败：${messageOf(error)}`)
    }
    touch(ctx)
  }

  // 有限并发：默认 2，太多会被网关限流。
  const concurrency = clamp(config.video.concurrency, 1, 4)
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= chunks.length) return
      const chunk = chunks[index]
      if (chunk === undefined) return
      await runChunk(chunk)
    }
  })
  await Promise.all(workers)

  if (failures.length === chunks.length) {
    throw new Error(`全部分镜生成失败：\n${failures.slice(0, 3).join('\n')}`)
  }
  const doneCount = run.segments.filter(segment => segment.status === 'done').length
  ctx.setStep('generate', {
    status: 'done',
    progress: 1,
    message: `${doneCount}/${total} 段成功${failures.length === 0 ? '' : `，${failures.length} 段失败可重试`}`,
    endedAt: Date.now(),
  })
  touch(ctx)
}

// ---------------------------------------------------------------------------
// 第 6 步：合成成片
// ---------------------------------------------------------------------------

/** 字幕文案：优先口播，其次画面大字。 */
/**
 * 为每个说话人分配音色：第一位出场的角色用主音色，其余角色用配角音色。
 * 这样「柴犬」和「老板」不会共用一个嗓子。
 */
function voiceCasting(segments: ScriptSegment[], config: PluginConfig): Map<string, string> {
  const map = new Map<string, string>()
  const main = config.tts.voice.trim()
  const alt = config.tts.voiceAlt.trim()
  for (const segment of segments) {
    const speaker = segment.speaker.trim() === '' ? '主角' : segment.speaker.trim()
    if (!map.has(speaker)) {
      map.set(speaker, map.size === 0 || alt === '' ? main : alt)
    }
  }
  return map
}

/**
 * 把分镜情绪和创意手法翻译成 TTS 的语气指令。
 * MiMo 一类模型吃自然语言描述（“气急败坏、语速偏快、有真实呼吸”），
 * 不要播音腔 —— 这条片子的笑点一半在“人真的被气到了”。
 */
function ttsStyleFor(emotions: string[], creativeDevice: string, summary: string): string {
  const unique = [...new Set(emotions.map(item => item.trim()).filter(item => item !== ''))]
  const mood = unique.length === 0 ? '' : unique.join('、')
  const corpus = `${creativeDevice} ${summary}`
  const contrast = /反差|错位|萌|可爱/.test(corpus)
  const literal = /字面|双关|多义/.test(corpus)
  const parts: string[] = ['口语化，不要播音腔，不要念稿感']
  if (mood !== '') parts.push(`情绪按顺序走：${mood}`)
  if (contrast) parts.push('声音要有反差：前半段与外形一致的软萌/乖巧，后段突然变凶或变急，反差要明显')
  parts.push('有真实的呼吸和情绪起伏，允许破音、咬牙、叹气，不要平铺直叙')
  if (literal) parts.push('语气像被按字面照做的人整到，又拿它没办法')
  return parts.join('；')
}

function subtitleText(segment: ScriptSegment): string {
  const voice = segment.voiceover.replace(/[（(][^（）()]*[）)]/g, '').replace(/\s+/g, ' ').trim()
  if (voice !== '') return voice
  return segment.onscreenText.trim()
}

export async function stepCompose(ctx: PipelineContext): Promise<void> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本')
  const done = run.segments.filter(segment => segment.status === 'done' && segment.file !== undefined)
  if (done.length === 0) throw new Error('还没有可用的分镜视频，请先完成「AI 生成视频」')

  ctx.setStep('compose', { status: 'running', progress: 0.05, message: '检查分镜', startedAt: Date.now(), error: undefined })
  touch(ctx)

  const workDir = dirOf(ctx)
  const probes = new Map<number, Awaited<ReturnType<typeof probeMedia>>>()
  for (const segment of done) {
    probes.set(segment.segmentIndex, await probeMedia(abs(ctx, segment.file as string), config.media.ffprobePath).catch(() => ({
      durationSec: 0, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: false,
    })))
  }

  // 目标画幅：优先用户配置，其次源片，其次分镜实际尺寸。
  const firstProbe = probes.get(done[0]!.segmentIndex)
  const configured = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(config.compose.size.trim())
  const sourceW = run.source?.width ?? firstProbe?.width ?? 0
  const sourceH = run.source?.height ?? firstProbe?.height ?? 0
  const width = configured !== null
    ? Number(configured[1])
    : (sourceW > 0 ? (sourceW % 2 === 0 ? sourceW : sourceW + 1) : 720)
  const height = configured !== null
    ? Number(configured[2])
    : (sourceH > 0 ? (sourceH % 2 === 0 ? sourceH : sourceH + 1) : 1280)
  const fps = clamp(config.compose.fps, 12, 60)

  // ---------- 配音（可选） ----------
  let narrationFile: string | undefined
  let narrationNote = '沿用分镜内嵌音频'
  /** 成片里是否真的有口播/字幕文案；没有就不该用 TTS 造一条静音配音。 */
  const narrationTexts = buildChunks(variant.segments).map(chunk =>
    (chunk.shots ?? []).map(shot => subtitleText(shot)).filter(text => text !== '').join(''))
  const hasNarrationText = narrationTexts.some(text => text.trim() !== '')
  const audioSource = run.audioSource ?? config.compose.audioSource
  const useTts = audioSource !== 'original'
  const ttsConfigured = useTts && config.tts.enabled && (usesDsh(config.tts)
    ? config.tts.dshModel.trim() !== ''
    : (config.tts.apiUrl.trim() !== '' && config.tts.model.trim() !== ''))
  if (!useTts) {
    ctx.log('compose', 'info', '按设置使用「分镜视频原声」，跳过 TTS 配音')
  }
  if (ttsConfigured && !hasNarrationText) {
    ctx.log('compose', 'info', '脚本没有口播/字幕文案，跳过 TTS，沿用分镜自带音频')
  }
  /** 每段实际语音时长（未补齐前），用来让字幕跟着说话走。 */
  const speechDurations = new Map<number, number>()
  if (ttsConfigured && hasNarrationText) {
    try {
      ctx.setStep('compose', { progress: 0.12, message: '生成配音' })
      touch(ctx)
      await mkdir(join(workDir, 'audio'), { recursive: true })
      const pieces: string[] = []
      const casting = voiceCasting(variant.segments, config)
      for (const [index, segment] of done.entries()) {
        checkAbort(ctx)
        const chunk = buildChunks(variant.segments).find(item => item.index === segment.segmentIndex)
        const text = (chunk?.shots ?? [])
          .map(shot => subtitleText(shot))
          .filter(item => item !== '')
          .join('')
        const targetSec = segment.durationSec ?? probes.get(segment.segmentIndex)?.durationSec ?? 5
        const rawFile = `audio/tts-${pad2(index + 1)}.mp3`
        const fitted = join(workDir, `audio/tts-${pad2(index + 1)}.wav`)
        if (text.trim() === '') {
          await silentAudio(fitted, targetSec, config.media.ffmpegPath, workDir)
        } else {
          const ttsEndpoint = await resolveEndpoint(ctx.dsh, config.tts, `配音 ${index + 1}`)
          const speaker = (chunk?.shots ?? []).map(shot => shot.speaker.trim()).find(item => item !== '') ?? '主角'
          const voice = casting.get(speaker) ?? config.tts.voice
          ctx.log('compose', 'info', `配音 ${index + 1}：${speaker} → 音色 ${voice}`)
          const style = ttsStyleFor(
            (chunk?.shots ?? []).map(shot => shot.emotion ?? '').filter(item => item !== ''),
            run.analysis?.creativeDevice ?? '',
              run.analysis?.summary ?? '',
          )
          const speech = await synthesizeSpeech({
            config: {
              ...config.tts,
              apiUrl: ttsEndpoint.apiUrl,
              apiKey: ttsEndpoint.apiKey,
              model: ttsEndpoint.model,
              protocol: ttsEndpoint.fromDsh ? 'openai-tts' : config.tts.protocol,
              voice,
            },
            text,
            outFile: abs(ctx, rawFile),
            label: `配音 ${index + 1}`,
            ...(style === '' ? {} : { style }),
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          })
          if (speech.voice !== undefined && speech.voice !== voice) {
            ctx.log('compose', 'info', `配音音色自动改用「${speech.voice}」（${voice} 网关不支持）`)
          }
          const rawDuration = await mediaDuration(abs(ctx, rawFile), config.media.ffprobePath)
          if (rawDuration > 0) speechDurations.set(segment.segmentIndex, rawDuration)
          await fitAudio({
            input: abs(ctx, rawFile),
            output: fitted,
            targetSec,
            ffmpegPath: config.media.ffmpegPath,
            workDir,
          })
        }
        pieces.push(fitted)
        ctx.setStep('compose', { progress: 0.12 + ((index + 1) / done.length) * 0.2, message: `配音 ${index + 1}/${done.length}` })
        touch(ctx)
      }
      // 顺序拼接配音轨
      const listFile = join(workDir, 'audio', 'narration-list.txt')
      await writeFile(
        listFile,
        `${pieces.map(file => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')}\n`,
        'utf8',
      )
      narrationFile = join(workDir, 'audio', 'narration.wav')
      await runCommand(config.media.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:a', 'pcm_s16le', narrationFile,
      ], { timeoutMs: 600_000, cwd: workDir })
      narrationNote = '使用 TTS 配音'
      ctx.log('compose', 'info', '配音轨已生成')
    } catch (error) {
      narrationFile = undefined
      ctx.log('compose', 'warn', `配音生成失败，改用内嵌音频：${messageOf(error)}`)
    }
  }
  checkAbort(ctx)

  // ---------- 拼接 ----------
  ctx.setStep('compose', { progress: 0.4, message: '拼接分镜' })
  touch(ctx)
  const mergedName = 'merged.mp4'
  await mergeSegments({
    segments: done.map(segment => ({
      file: rel(segment.file as string),
      hasAudio: probes.get(segment.segmentIndex)?.hasAudio ?? false,
    })),
    output: mergedName,
    width,
    height,
    fps,
    ffmpegPath: config.media.ffmpegPath,
    workDir,
    keepAudio: narrationFile === undefined,
  })
  let ambientName: string | undefined
  if (narrationFile !== undefined) {
    const ambientFile = join(workDir, 'audio', 'ambient.wav')
    try {
      const built = await buildAmbientTrack({
        segments: done.map(segment => ({
          file: abs(ctx, segment.file ?? ''),
          hasAudio: probes.get(segment.segmentIndex)?.hasAudio ?? false,
        })),
        output: ambientFile,
        ffmpegPath: config.media.ffmpegPath,
        workDir,
      })
      if (built) {
        ambientName = ambientFile
        ctx.log('compose', 'info', '已混入分镜环境音（22% 音量）')
      }
    } catch (error) {
      ctx.log('compose', 'warn', `环境音混合失败，忽略：${messageOf(error)}`)
    }
  }
  const mergedProbe = await probeMedia(join(workDir, mergedName), config.media.ffprobePath).catch(() => undefined)
  const mergedDuration = mergedProbe?.durationSec ?? 0
  ctx.log('compose', 'info', `拼接完成：${mergedDuration.toFixed(1)}s ${width}x${height}@${fps}`)

  // ---------- 字幕 ----------
  const chunkMap = new Map(buildChunks(variant.segments).map(chunk => [chunk.index, chunk]))
  const cues: Array<{ startSec: number, endSec: number, text: string }> = []
  let clock = 0
  for (const segment of done) {
    const chunk = chunkMap.get(segment.segmentIndex)
    const actual = segment.durationSec ?? probes.get(segment.segmentIndex)?.durationSec ?? 0
    const planned = (chunk?.shots ?? []).reduce((sum, shot) => sum + Math.max(1, shot.endSec - shot.startSec), 0)
    const scale = planned > 0 ? actual / planned : 1
    let cursor = clock
    const speech = speechDurations.get(segment.segmentIndex)
    // 字幕跟着「实际说完」走：把本块内所有镜的时长按语音占比压缩，
    // 语音结束后剩下的静默不再挂字幕。
    const speechScale = speech === undefined
      ? 1
      : Math.min(1, Math.max(0.2, (speech + 0.35) / Math.max(0.5, actual)))
    for (const shot of chunk?.shots ?? []) {
      let span = Math.max(0.6, (shot.endSec - shot.startSec) * (scale > 0 ? scale : 1) * speechScale)
      const text = subtitleText(shot)
      if (text !== '') {
        // 按句子切分：整段 8 秒里只挂一条字幕会一直压在画面上，
        // 这里按字数占比把每条句子铺到该镜的时间窗内。
        const sentences = text.split(/(?<=[。！？!?…])/).map(item => item.trim()).filter(item => item !== '')
        const pieces = sentences.length > 0 ? sentences : [text]
        const total = pieces.reduce((sum, item) => sum + item.length, 0) || 1
        // 按字数占比把句子铺满本镜时间窗，且严格不越过窗口 —— 否则相邻两条会重叠。
        const shotEnd = Math.min(clock + actual, cursor + span)
        let inner = cursor
        for (const [pieceIndex, piece] of pieces.entries()) {
          const remaining = pieces.length - pieceIndex
          const pieceSpan = remaining === 1
            ? Math.max(0, shotEnd - inner)
            : Math.max(0.2, (shotEnd - cursor) * (piece.length / total))
          const end = Math.min(shotEnd, inner + pieceSpan)
          if (end > inner + 0.2) cues.push({ startSec: inner, endSec: end, text: piece })
          inner = Math.max(inner, end)
        }
      }
      cursor += span
    }
    clock += actual
  }
  // ---------- 原声模式：字幕跟着原声走 ----------
  // 选「分镜视频原声」时，画面里的台词是视频模型自己生成的，脚本字幕会与语音错位。
  // 这里对每段原声跑一次 ASR，按识别到的时间重新生成字幕；失败则退回脚本字幕。
  let finalCues = cues
  const asrConfigured = config.asr.enabled && (usesDsh(config.asr)
    ? config.asr.dshModel.trim() !== ''
    : (config.asr.apiUrl.trim() !== '' && config.asr.model.trim() !== ''))
  if (!useTts && config.compose.burnSubtitles && asrConfigured) {
    try {
      ctx.setStep('compose', { progress: 0.62, message: '按原声转写字幕' })
      touch(ctx)
      const asrEndpoint = await resolveEndpoint(ctx.dsh, config.asr, '原声转写')
      const asrCues: Array<{ startSec: number, endSec: number, text: string }> = []
      let asrClock = 0
      for (const segment of done) {
        checkAbort(ctx)
        const duration = segment.durationSec ?? probes.get(segment.segmentIndex)?.durationSec ?? 0
        const file = abs(ctx, segment.file ?? '')
        if (file === '' || duration <= 0) { asrClock += duration; continue }
        try {
          const wav = join(workDir, 'audio', `asr-${pad2(segment.segmentIndex)}.wav`)
          await runCommand(config.media.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
          ], { timeoutMs: 300_000 })
          // 优先：按静音切出每个「说话窗口」，逐窗转写 —— 这样每句字幕的时间就是它真正被说出来的区间。
          const windows = await detectSpeechWindows({
            file: wav,
            durationSec: duration,
            ffmpegPath: config.media.ffmpegPath,
          }).catch(() => [])
          const usable = windows.filter(item => item.endSec - item.startSec >= 0.5)
          if (usable.length >= 2) {
            for (const [windowIndex, window] of usable.entries()) {
              checkAbort(ctx)
              const slice = join(workDir, 'audio', `asr-${pad2(segment.segmentIndex)}-${windowIndex + 1}.wav`)
              await runCommand(config.media.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-ss', window.startSec.toFixed(2), '-to', window.endSec.toFixed(2),
                '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', slice,
              ], { timeoutMs: 120_000 })
              const spoken = await transcribeAudio({
                config: {
                  ...config.asr,
                  apiUrl: asrEndpoint.apiUrl,
                  apiKey: asrEndpoint.apiKey,
                  model: asrEndpoint.model,
                },
                audioFile: slice,
                durationSec: window.endSec - window.startSec,
                label: `原声转写 ${segment.segmentIndex}-${windowIndex + 1}`,
                ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
              })
              const text = spoken.map(cue => cue.text.trim()).join('').trim()
              if (text === '') continue
              asrCues.push({
                startSec: asrClock + Math.max(0, window.startSec - 0.05),
                endSec: asrClock + Math.min(duration, window.endSec + 0.05),
                text,
              })
            }
          } else {
            // 兜底：整段就一个语音窗口（或没检测到静音）→ 整段转写后按标点切句铺满。
            const spoken = await transcribeAudio({
              config: {
                ...config.asr,
                apiUrl: asrEndpoint.apiUrl,
                apiKey: asrEndpoint.apiKey,
                model: asrEndpoint.model,
              },
              audioFile: wav,
              durationSec: duration,
              label: `原声转写 ${segment.segmentIndex}`,
              ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
            })
            const text = spoken.map(cue => cue.text.trim()).join('').trim()
            const phrases = text.split(/(?<=[，。！？!?…；;])/).map(item => item.trim()).filter(item => item !== '')
            const window = usable[0] ?? { startSec: 0, endSec: duration }
            // 连续底噪的片段：按能量谷把每句对到真实停顿上（比按字数硬摊准）。
            const aligned = await alignPhrasesInAudio({
              wavFile: wav,
              phrases,
              durationSec: duration,
              startSec: window.startSec,
              endSec: window.endSec,
            }).catch(() => [])
            if (aligned.length === phrases.length) {
              for (const [phraseIndex, phrase] of phrases.entries()) {
                const piece = aligned[phraseIndex]
                asrCues.push({
                  startSec: asrClock + piece.startSec,
                  endSec: asrClock + piece.endSec,
                  text: phrase,
                })
              }
            } else {
              const span = Math.max(0.5, window.endSec - window.startSec)
              const totalChars = phrases.reduce((sum, item) => sum + item.length, 0) || 1
              let cursor = window.startSec
              for (const [phraseIndex, phrase] of phrases.entries()) {
                const end = phraseIndex === phrases.length - 1
                  ? window.endSec
                  : Math.min(window.endSec, cursor + Math.max(0.6, span * (phrase.length / totalChars)))
                if (end > cursor + 0.15) {
                  asrCues.push({ startSec: asrClock + cursor, endSec: asrClock + end, text: phrase })
                }
                cursor = end
              }
            }
          }
        } catch (error) {
          ctx.log('compose', 'warn', `第 ${segment.segmentIndex} 段原声转写失败，沿用脚本字幕：${messageOf(error)}`)
        }
        asrClock += duration
      }
      if (asrCues.length > 0) {
        finalCues = asrCues
        ctx.log('compose', 'info', `字幕已按原声转写对齐（${asrCues.length} 条）`)
      } else {
        ctx.log('compose', 'warn', '原声转写没有拿到台词，沿用脚本字幕')
      }
    } catch (error) {
      ctx.log('compose', 'warn', `原声转写字幕失败，沿用脚本字幕：${messageOf(error)}`)
    }
  }
  const wantSubtitles = config.compose.burnSubtitles && finalCues.length > 0
  if (wantSubtitles) {
    await writeAssSubtitle({
      output: join(workDir, 'subs.ass'),
      fontSize: config.compose.subtitleFontSize,
      width,
      height,
      cues: finalCues,
    })
  }

  // ---------- 合流 ----------
  ctx.setStep('compose', { progress: 0.7, message: '合流与烧字幕' })
  touch(ctx)
  const bgm = config.compose.bgmPath.trim()
  const finalName = 'final.mp4'
  if (narrationFile !== undefined) {
    await muxFinal({
      video: join(workDir, mergedName),
      audio: narrationFile,
      ...(ambientName === undefined ? {} : { ambient: ambientName, ambientVolume: 0.22 }),
      ...(bgm === '' ? {} : { bgm, bgmVolume: config.compose.bgmVolume }),
      ...(wantSubtitles ? { subtitle: join(workDir, 'subs.ass'), subtitleFontSize: config.compose.subtitleFontSize } : {}),
      output: finalName,
      ffmpegPath: config.media.ffmpegPath,
      workDir,
    })
  } else if (mergedProbe?.hasAudio === true) {
    // 有内嵌音轨：保留原音轨，可选烧字幕 + BGM。
    await muxFinal({
      video: join(workDir, mergedName),
      audio: join(workDir, mergedName),
      ...(bgm === '' ? {} : { bgm, bgmVolume: config.compose.bgmVolume }),
      ...(wantSubtitles ? { subtitle: join(workDir, 'subs.ass'), subtitleFontSize: config.compose.subtitleFontSize } : {}),
      output: finalName,
      ffmpegPath: config.media.ffmpegPath,
      workDir,
      tempName: 'video-with-subs.mp4',
    })
  } else {
    // 既无配音也无内嵌音轨：输出无声成片，并在界面明示。
    await muxFinal({
      video: join(workDir, mergedName),
      ...(wantSubtitles ? { subtitle: join(workDir, 'subs.ass'), subtitleFontSize: config.compose.subtitleFontSize } : {}),
      output: finalName,
      ffmpegPath: config.media.ffmpegPath,
      workDir,
      tempName: 'video-with-subs.mp4',
    })
    narrationNote = '无声成片（分镜无音轨且未配置配音）'
  }

  const finalProbe = await probeMedia(join(workDir, finalName), config.media.ffprobePath).catch(() => undefined)
  const finalInfo = await stat(join(workDir, finalName)).catch(() => undefined)
  if (finalInfo === undefined || finalInfo.size < 1024) throw new Error('成片生成失败：输出文件不存在或过小')

  const result: ComposeResult = {
    file: finalName,
    durationSec: finalProbe?.durationSec ?? mergedDuration,
    width: finalProbe?.width ?? width,
    height: finalProbe?.height ?? height,
    hasAudio: finalProbe?.hasAudio ?? false,
    burnedSubtitles: wantSubtitles,
    bgm: bgm !== '',
    artifacts: [
      mergedName,
      ...(wantSubtitles ? ['subs.ass'] : []),
      ...(narrationFile === undefined ? [] : ['audio/narration.wav']),
    ],
    createdAt: Date.now(),
  }
  run.compose = result
  ctx.log('compose', 'info', `成片完成：${result.durationSec.toFixed(1)}s（${narrationNote}）`)
  ctx.setStep('compose', {
    status: 'done',
    progress: 1,
    message: `${result.durationSec.toFixed(1)}s ${result.width}x${result.height}`,
    endedAt: Date.now(),
  })
  touch(ctx)
}

// ---------------------------------------------------------------------------
// 合成前的「试听配音 / 预览字幕」
// ---------------------------------------------------------------------------

export interface SubtitlePreviewRow {
  index: number
  startSec: number
  endSec: number
  text: string
  segmentIndex: number
}

/** 字幕预览：按分镜顺序与字符数估算时间轴（不进 ffmpeg，纯预览）。 */
export function buildSubtitlePreview(run: RunState): SubtitlePreviewRow[] {
  const variant = selectedVariant(run)
  if (variant === undefined) return []
  const rows: SubtitlePreviewRow[] = []
  let cursor = 0
  for (const chunk of buildChunks(variant.segments)) {
    const shots = (chunk.shots ?? [])
      .map(shot => ({ text: subtitleText(shot), segmentIndex: shot.index }))
      .filter(item => item.text.trim() !== '')
    const totalChars = shots.reduce((sum, item) => sum + item.text.length, 0)
    if (totalChars === 0) {
      cursor += chunk.durationSec
      continue
    }
    for (const item of shots) {
      const span = Math.max(0.6, chunk.durationSec * (item.text.length / totalChars))
      rows.push({
        index: rows.length + 1,
        startSec: cursor,
        endSec: cursor + span,
        text: item.text,
        segmentIndex: item.segmentIndex,
      })
      cursor += span
    }
  }
  return rows
}

export interface TtsPreviewItem {
  index: number
  speaker: string
  voice: string
  text: string
  file: string
}

/** 试听配音：按成片的说话人/音色逐段合成，落盘到 preview/，不合成视频。 */
export async function previewNarration(ctx: PipelineContext): Promise<TtsPreviewItem[]> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本，先完成「AI 仿写」')
  if (!config.tts.enabled) throw new Error('配音未启用：请到「设置 → 视频复刻 → 配音」打开')

  const casting = voiceCasting(variant.segments, config)
  const items: TtsPreviewItem[] = []
  for (const [index, chunk] of buildChunks(variant.segments).entries()) {
    checkAbort(ctx)
    const shots = chunk.shots ?? []
    const text = shots.map(shot => subtitleText(shot)).filter(item => item !== '').join('')
    if (text.trim() === '') continue
    const speaker = shots.map(shot => shot.speaker.trim()).find(item => item !== '') ?? '主角'
    const voice = casting.get(speaker) ?? config.tts.voice
    const style = ttsStyleFor(
      shots.map(shot => shot.emotion ?? '').filter(item => item !== ''),
      run.analysis?.creativeDevice ?? '',
      run.analysis?.summary ?? '',
    )
    const endpoint = await resolveEndpoint(ctx.dsh, config.tts, `试听 ${index + 1}`)
    const file = `preview/tts-${pad2(index + 1)}.mp3`
    const speech = await synthesizeSpeech({
      config: {
        ...config.tts,
        apiUrl: endpoint.apiUrl,
        apiKey: endpoint.apiKey,
        model: endpoint.model,
        protocol: endpoint.fromDsh ? 'openai-tts' : config.tts.protocol,
        voice,
      },
      text,
      outFile: abs(ctx, file),
      label: `试听 ${index + 1}`,
      ...(style === '' ? {} : { style }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    items.push({ index: index + 1, speaker, voice: speech.voice ?? voice, text, file })
    ctx.log('compose', 'info', `试听配音 ${index + 1}：${speaker} → 音色 ${voice}`)
  }
  if (items.length === 0) throw new Error('脚本里没有口播文案，试听不到内容（可以先在「AI 仿写」补台词）')
  return items
}

// ---------------------------------------------------------------------------
// 第 7 步：一键发布
// ---------------------------------------------------------------------------

/** 发布描述的默认值：优先用拆解摘要，其次源片标题。 */
function defaultPublishText(run: RunState): string {
  const summary = run.analysis?.summary.trim() ?? ''
  if (summary !== '') return summary
  return (run.source?.title ?? run.title).trim()
}

async function stepPublish(ctx: PipelineContext): Promise<void> {
  const { run } = ctx
  const compose = run.compose
  if (compose === undefined) throw new Error('还没有成片：请先执行「合成成片」再发布')
  const platform = run.publish?.platform ?? 'channels'
  const description = (run.publish?.description ?? '').trim() || defaultPublishText(run)
  const title = (run.publish?.title ?? '').trim()
  const videoFile = abs(ctx, compose.file)

  ctx.setStep('publish', { status: 'running', progress: 0.05, message: '准备发布' })
  run.publish = {
    platform,
    status: 'waiting-login',
    message: '打开创作页…',
    description,
    ...(title === '' ? {} : { title }),
    startedAt: Date.now(),
  }
  touch(ctx)

  try {
    const result = await publishToChannels({
      videoFile,
      description,
      ...(title === '' ? {} : { title }),
      signal: ctx.signal,
      runDir: dirOf(ctx),
      log: (level, text) => ctx.log('publish', level, text),
      onProgress: progress => {
        if (run.publish !== undefined) {
          run.publish.status = progress.status
          run.publish.message = progress.message
        }
        const ratio = progress.status === 'waiting-login' ? 0.15 : progress.status === 'uploading' ? 0.45 : 0.8
        ctx.setStep('publish', { progress: ratio, message: progress.message })
        touch(ctx)
      },
    })
    const screenshot = result.screenshot
    run.publish = {
      platform,
      status: 'done',
      message: '已发布',
      description,
      ...(title === '' ? {} : { title }),
      ...(result.postUrl === '' ? {} : { postUrl: result.postUrl }),
      ...(screenshot === undefined ? {} : { screenshot }),
      startedAt: run.publish?.startedAt ?? Date.now(),
      endedAt: Date.now(),
    }
    ctx.setStep('publish', { status: 'done', progress: 1, message: '已发布' })
    touch(ctx)
  } catch (error) {
    const text = messageOf(error)
    if (run.publish !== undefined) {
      run.publish.status = 'failed'
      run.publish.message = text
      run.publish.error = text
      run.publish.endedAt = Date.now()
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 单步重跑 / 单张重生成（界面按钮）
// ---------------------------------------------------------------------------

export const STEP_RUNNERS: Record<StepId, (ctx: PipelineContext) => Promise<void>> = {
  parse: stepParse,
  analyze: stepAnalyze,
  rewrite: stepRewrite,
  match: stepMatch,
  generate: stepGenerate,
  compose: stepCompose,
  publish: stepPublish,
}

/** 单张参考图重生成。 */
export async function regenerateFrame(ctx: PipelineContext, segmentIndex: number, promptOverride?: string): Promise<void> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  const segment = variant?.segments.find(item => item.index === segmentIndex)
  if (segment === undefined) throw new Error(`找不到第 ${segmentIndex} 个分镜`)
  const productImages: ChatImage[] = []
  const productMode = resolveProductMode(config)
  for (const image of productMode === 'text' ? [] : run.productImages.slice(0, 3)) {
    try {
      productImages.push(await loadImage(abs(ctx, image.file)))
    } catch {
      // 忽略
    }
  }
  if (run.analysis !== undefined && (run.analysis.meta.lens ?? '') === '') {
    const lens = inferLens(run.analysis)
    if (lens !== '') run.analysis.meta.lens = lens
  }
  const aspect = resolveAspect(run, config)
  const subjectAnchors = (run.subjects ?? []).map(item => ({ name: item.name, description: item.description }))
  const subjectImages: ChatImage[] = []
  for (const item of run.subjects ?? []) {
    const image = await loadImage(abs(ctx, item.anchorFile)).catch(() => undefined)
    if (image !== undefined) subjectImages.push(image)
  }
  const sourceShot = run.analysis?.shots.find(shot => shot.index === segment.index)
  const lightingBaseline = run.analysis?.shots.find(shot => shot.lighting.trim() !== '')?.lighting ?? ''
  const prompt = promptOverride !== undefined && promptOverride.trim() !== ''
    ? promptOverride
    : framePrompt({
        segment: {
          index: segment.index,
          shotType: segment.shotType,
          camera: segment.camera,
          visualPrompt: segment.visualPrompt,
          productPlacement: segment.productPlacement,
          ...(sourceShot === undefined ? {} : { lighting: sourceShot.lighting, environment: sourceShot.environment }),
        },
        productVisual: run.productVisual ?? '',
        hasProduct: run.productImages.length > 0,
        productMode,
        aspect,
        styleHint: run.analysis?.meta.style ?? '',
        frameStyle: config.imageFrameStyle,
        ...(lightingBaseline === '' ? {} : { lightingBaseline }),
        ...(subjectAnchors.length === 0 ? {} : { subjectAnchors }),
        ...(run.analysis?.meta.lens === undefined || run.analysis.meta.lens.trim() === '' ? {} : { lens: run.analysis.meta.lens }),
      })
  const file = `frames/ref-${pad2(segmentIndex)}.png`
  const imageEndpoint = await resolveEndpoint(ctx.dsh, config.image, `参考图 ${segmentIndex}`)
  await generateImage({
    apiUrl: imageEndpoint.apiUrl,
    apiKey: imageEndpoint.apiKey,
    model: imageEndpoint.model,
    protocol: imageEndpoint.fromDsh ? 'openai-images' : config.image.protocol,
    ...(config.image.extraJson === undefined ? {} : { extraJson: config.image.extraJson }),
    ...(config.image.timeoutSec === undefined ? {} : { timeoutSec: config.image.timeoutSec }),
    prompt,
    ...(productImages.length === 0
      ? (subjectImages.length === 0 ? {} : { images: subjectImages })
      : { images: productImages }),
    aspect: ratioOf(`${aspect.width}x${aspect.height}`),
    width: aspect.width,
    height: aspect.height,
    outFile: abs(ctx, file),
    label: `参考图 ${segmentIndex}`,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })
  const existing = run.frames.findIndex(frame => frame.segmentIndex === segmentIndex)
  const frame: StoryboardFrame = {
    segmentIndex,
    file,
    prompt,
    mode: run.productImages.length > 0 ? 'product' : 'scene',
    createdAt: Date.now(),
  }
  if (existing >= 0) run.frames[existing] = frame
  else run.frames.push(frame)
  run.frames.sort((a, b) => a.segmentIndex - b.segmentIndex)
  touch(ctx)
}

/** 单段视频重生成。 */
export async function regenerateSegment(ctx: PipelineContext, segmentIndex: number, promptOverride?: string): Promise<void> {
  const { run, config } = ctx
  const variant = selectedVariant(run)
  if (variant === undefined) throw new Error('还没有选定脚本')
  const chunks = buildChunks(variant.segments)
  const chunk = chunks.find(item => item.index === segmentIndex)
  if (chunk === undefined) throw new Error(`找不到第 ${segmentIndex} 个生成分段`)
  const referenceFile = run.frames.find(frame => frame.segmentIndex === chunk.shots[0]?.index && frame.file !== '')?.file
  const referenceImage = referenceFile === undefined
    ? undefined
    : await loadImage(abs(ctx, referenceFile)).catch(() => undefined)
  const productImages: ChatImage[] = []
  for (const image of run.productImages.slice(0, 2)) {
    try {
      productImages.push(await loadImage(abs(ctx, image.file)))
    } catch {
      // 忽略
    }
  }
  // ark-seedance：产品图 + 首帧（顺序与提示词「图片1/图片2」一致）；其它网关只传首帧。
  const includeProductImage = config.video.protocol === 'ark-seedance' && productImages.length > 0
  const images: ChatImage[] = includeProductImage
    ? [...productImages, ...(referenceImage === undefined ? [] : [referenceImage])]
    : (referenceImage === undefined ? [] : [referenceImage])
  for (const image of run.productImages.slice(0, 2)) {
    try {
      images.push(await loadImage(abs(ctx, image.file)))
    } catch {
      // 忽略
    }
  }
  const prompt = promptOverride !== undefined && promptOverride.trim() !== ''
    ? promptOverride
    : videoPrompt({
        shots: chunk.shots.map(shot => {
          const sourceShot = run.analysis?.shots.find(item => item.index === shot.index)
          return {
            ...shotHint(run, shot),
            visualPrompt: shot.visualPrompt,
            voiceover: shot.voiceover,
            environment: shot.environment !== '' ? shot.environment : (sourceShot?.environment ?? ''),
            lighting: shot.lighting !== '' ? shot.lighting : (sourceShot?.lighting ?? ''),
          }
        }),
        hasProduct: run.productImages.length > 0,
        includeProductImage,
        productVisual: run.productVisual ?? '',
        styleHint: run.analysis?.meta.style ?? '',
        continuation: false,
        frameStyle: config.imageFrameStyle,
        aspect: resolveAspect(run, config),
        ...(run.analysis === undefined
          ? {}
          : { lightingBaseline: run.analysis.shots.find(shot => shot.lighting.trim() !== '')?.lighting ?? '' }),
        seconds: chunk.durationSec,
      })
  const file = `segments/seg-${pad2(segmentIndex)}.mp4`
  const slot = run.segments.find(item => item.segmentIndex === segmentIndex)
    ?? { segmentIndex, status: 'pending' as const, durationSec: chunk.durationSec }
  const index = run.segments.findIndex(item => item.segmentIndex === segmentIndex)
  if (index < 0) run.segments.push(slot)
  slot.status = 'running'
  slot.prompt = prompt
  slot.startedAt = Date.now()
  touch(ctx)
  try {
    const videoEndpoint = await resolveEndpoint(ctx.dsh, config.video, `分镜 ${segmentIndex}`)
    await generateVideo({
      apiUrl: videoEndpoint.apiUrl,
      apiKey: videoEndpoint.apiKey,
      model: videoEndpoint.model,
      protocol: videoEndpoint.fromDsh ? 'openai-video' : config.video.protocol,
      ...(config.video.extraJson === undefined ? {} : { extraJson: config.video.extraJson }),
      ...(config.video.timeoutSec === undefined ? {} : { timeoutSec: config.video.timeoutSec }),
      prompt,
      ...(images.length === 0 ? {} : { images }),
      size: `${resolveAspect(run, config).width}x${resolveAspect(run, config).height}`,
      seconds: chunk.durationSec,
      outFile: abs(ctx, file),
      pollSec: config.video.pollSec,
      label: `分镜 ${segmentIndex}`,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    const probe = await probeMedia(abs(ctx, file), config.media.ffprobePath).catch(() => undefined)
    slot.status = 'done'
    slot.file = file
    slot.endedAt = Date.now()
    if (probe !== undefined && probe.durationSec > 0) slot.durationSec = probe.durationSec
    slot.error = undefined
  } catch (error) {
    slot.status = 'failed'
    slot.error = messageOf(error)
    slot.endedAt = Date.now()
    throw error
  } finally {
    touch(ctx)
  }
}

export { STEP_RUNNERS as STEP_FUNCTIONS }
