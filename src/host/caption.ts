/**
 * 第 7 步：发布文案生成（标题 / 话题 / 描述）。
 *
 * 吃拆解结论 + 选中的仿写脚本，让文本模型写视频号发布文案；输出做一次归一化，
 * 避免模型写出超长标题、带 # 的话题、或把话题混进描述里。
 */

import { completeText, describeEndpoint } from './endpoint-resolver.ts'
import { CAPTION_SYSTEM, captionPrompt } from './prompts.ts'
import { messageOf, parseModelJson } from './util.ts'
import type { DshModels } from './dsh.ts'
import type { PluginConfig, PublishCaption, RunState, StepId } from '../shared/types.ts'

/**
 * 只用得到的宿主上下文（避免和 pipeline.ts 互相 import）。
 * PipelineContext 结构上兼容它。
 */
export interface CaptionContext {
  config: PluginConfig
  dsh?: DshModels | undefined
  run: RunState
  signal: AbortSignal
  log: (step: StepId | 'run', level: 'info' | 'warn' | 'error', text: string) => void
}

/** 视频号短标题的显示长度上限（按汉字算）。 */
const TITLE_MAX = 16
const TOPIC_MAX = 8

function stripTopic(text: string): string {
  return text
    .trim()
    .replace(/^#+/, '')
    .replace(/[，,。.、;；\s]+$/, '')
    .replace(/\s+/g, '')
}

function normalizeTitle(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const cleaned = raw
    .replace(/^[「『《"'\s]+|[」』》"'\s]+$/g, '')
    .replace(/[。！？!?，,、]+$/g, '')
    .replace(/\s+/g, '')
  return cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX) : cleaned
}

function normalizeTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const topic = stripTopic(item)
    if (topic === '' || topic.length > 12) continue
    if (seen.has(topic)) continue
    seen.add(topic)
    out.push(topic)
    if (out.length >= TOPIC_MAX) break
  }
  return out
}

function normalizeDescription(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw
    .replace(/^#\S+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 发布时最终写进视频号的描述：正文 + 话题。 */
export function composePostText(description: string, topics: readonly string[]): string {
  const body = description.trim()
  const tags = topics.map(topic => `#${stripTopic(topic)}`).filter(tag => tag !== '#').join(' ')
  if (tags === '') return body
  return body === '' ? tags : `${body}\n\n${tags}`
}

export interface GenerateCaptionOptions {
  /** 用户附加要求（例如「更口语一点」「突出摸鱼」）。 */
  extra?: string
  signal?: AbortSignal
}

/** 生成一版发布文案；写进 run.publish 由调用方负责。 */
export async function generateCaption(ctx: CaptionContext, options: GenerateCaptionOptions = {}): Promise<PublishCaption> {
  const { run, config } = ctx
  const analysis = run.analysis
  if (analysis === undefined) throw new Error('还没有拆解报告，先生成文案之前请先完成「AI 拆解」')

  const variant = run.scripts?.variants.find(item => item.id === run.variantId) ?? run.scripts?.variants[0]
  const variantLines = variant === undefined
    ? []
    : variant.segments
      .map(segment => (segment.speaker === undefined || segment.speaker === '' ? segment.voiceover : `${segment.speaker}：${segment.voiceover}`))
      .filter(text => text.trim() !== '')

  const prompt = captionPrompt({
    platform: '视频号',
    sourceTitle: (run.source?.title ?? run.title).trim(),
    analysis,
    variantTitle: variant?.title ?? run.title,
    variantLines,
    targetDurationSec: run.compose?.durationSec ?? analysis.meta.durationSec,
    ...(options.extra === undefined ? {} : { extra: options.extra }),
  })

  // 仿写模型经常被上游打到 502，这里按「仿写 → 拆解」依次兜底，任一成功即返回。
  const candidates = [config.rewrite, config.analyze]
  const seen = new Set<string>()
  let lastError: unknown
  for (const endpoint of candidates) {
    const key = `${endpoint.source}|${endpoint.dshProvider}/${endpoint.dshModel}|${endpoint.apiUrl}/${endpoint.model}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      ctx.log('publish', 'info', `生成发布文案（${describeEndpoint(endpoint) || '文本模型'}）`)
      return await attempt(endpoint, { ctx, analysis, prompt, options })
    } catch (error) {
      lastError = error
      ctx.log('publish', 'warn', `文案生成失败（${describeEndpoint(endpoint) || '文本模型'}）：${messageOf(error).slice(0, 160)}，换下一个模型重试…`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('文案生成失败')
}

/** 单次尝试：先正常温度，JSON 不合法时压温度再来一次。 */
async function attempt(
  endpoint: CaptionContext['config']['rewrite'],
  input: { ctx: CaptionContext, analysis: NonNullable<RunState['analysis']>, prompt: string, options: GenerateCaptionOptions },
): Promise<PublishCaption> {
  const { ctx, prompt, options } = input
  let parsed: Record<string, unknown> | undefined
  for (const [index, temperature] of [0.9, 0.5].entries()) {
    const raw = await completeText(ctx.dsh, endpoint, {
      label: '发布文案',
      system: CAPTION_SYSTEM,
      user: prompt,
      json: true,
      maxTokens: 1600,
      temperature,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    try {
      parsed = parseModelJson(raw, '发布文案')
      break
    } catch (error) {
      if (index === 1) throw error
      ctx.log('publish', 'warn', '文案输出无法解析，压温度重试一次…')
    }
  }
  if (parsed === undefined) throw new Error('文案生成失败')
  const title = normalizeTitle(parsed.title)
  const topics = normalizeTopics(parsed.topics)
  const description = normalizeDescription(parsed.description)
  if (title === '' || description === '') throw new Error('文案生成不完整（标题或描述为空），请重试一次')
  return { title, description, topics, model: describeEndpoint(endpoint), at: Date.now() }
}
