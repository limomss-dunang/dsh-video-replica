/**
 * 浏览器桥接路由（loopback-only）。
 *
 * 所有读写都经由宿主进程完成：配置、运行状态、文件上传、媒体读取。
 * 鉴权沿用同源 + 回环字面检查（与 dsh-imagegen / dsh-brainstorm 一致），
 * 因此远端浏览器拿不到密钥，也无法触发本机 ffmpeg。
 *
 * 重要：宿主的 WebServer 把 (kind, path) 当成唯一键，重复注册会抛错；因此这里
 * 一个路径只注册**一条** WebRoute，GET/POST 在同一个 handler 里按方法分派。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, normalize, sep } from 'node:path'
import type { ConfigView, RunState, StepId } from '../shared/types.ts'
import { API, STEP_IDS } from '../shared/types.ts'
import { ConfigStore, toConfigView } from './config.ts'
import type { Engine } from './engine.ts'
import type { RunStore } from './store.ts'
import { detectPlatform, extractUrl, looksLikeDirectVideo, parseViaApi } from './providers/parser.ts'
import { toolAvailable } from './media.ts'
import { chatComplete } from './providers/chat.ts'
import type { DshModels } from './dsh.ts'
import { completeText, describeEndpoint, resolveEndpoint, usesDsh } from './endpoint-resolver.ts'
import type { EndpointConfig } from '../shared/types.ts'
import { regenerateFrame, regenerateSegment, type PipelineContext } from './pipeline.ts'
import { CAMERA_MOVES, SHOT_TYPES } from './prompts.ts'
import { buildPromptPreview } from './pipeline.ts'
import { asString, isLoopbackRequest, messageOf } from './util.ts'

const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/**
 * 最小化本地路由契约：与 @deepseek-ai/dsh-host-webserver 的 WebRoute 形状一致。
 * 这里自持类型声明，避免为几个类型字段去依赖宿主包（宿主版本号在 0.1.x / 0.2.x
 * 之间会变，而形状没变）。
 */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface RoutesDeps {
  configs: ConfigStore
  store: RunStore
  engine: Engine
  /** DSH 已配置模型目录（可缺省）。 */
  dsh?: DshModels
  dataRoot: () => string
  /** 配置保存后重算数据目录（dataDir 可能变了）。 */
  refreshDataRoot?: () => Promise<void>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 读取原始上传字节（视频/图片）。 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) throw new Error(`文件过大（上限 ${Math.round(maxBytes / 1048576)}MB）`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function contentTypeOf(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.mp4':
    case '.m4v': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.m4a': return 'audio/mp4'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.ass': return 'text/plain; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

/** 把 runId + 相对路径解析成运行目录内的安全绝对路径。 */
function resolveRunFile(runDir: string, relative: string): string | undefined {
  const clean = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean.includes('\u0000')) return undefined
  const resolved = normalize(join(runDir, clean))
  const root = normalize(runDir.endsWith(sep) ? runDir : `${runDir}${sep}`)
  if (!resolved.startsWith(root)) return undefined
  return resolved
}

/** 带 Range 的文件响应（<video> 拖动进度必需）。 */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, downloadName?: string): Promise<void> {
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    writeJson(res, 404, { ok: false, error: '文件不存在' })
    return
  }
  const type = contentTypeOf(file)
  const inline = type.startsWith('video/') || type.startsWith('image/') || type.startsWith('audio/')
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    ...(inline ? {} : { 'content-disposition': `attachment; filename="${encodeURIComponent(downloadName ?? basename(file))}"` }),
  }
  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      const start = match[1] === '' ? 0 : Number(match[1])
      const end = match[2] === '' ? info.size - 1 : Math.min(Number(match[2]), info.size - 1)
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < info.size) {
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${info.size}`,
          'content-length': String(end - start + 1),
        })
        createReadStream(file, { start, end }).pipe(res)
        return
      }
    }
  }
  res.writeHead(200, { ...headers, 'content-length': String(info.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

type GetHandler = (url: URL, req: IncomingMessage, res: ServerResponse) => Promise<void> | void
type PostHandler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => Promise<unknown>

interface RouteEntry {
  get?: GetHandler
  post?: PostHandler
  /** POST 处理器自己消费请求体（例如原始字节上传），路由器不再把它当 JSON 读。 */
  rawBody?: boolean
}


/** 上游产物变了：把下游已完成的步骤标记为「需要重新生成」。 */
function markStale(run: RunState, steps: StepId[]): void {
  for (const id of steps) {
    const state = run.steps.find(item => item.id === id)
    if (state === undefined) continue
    // 还没跑过的步骤不需要「过期」提示，本身就是待执行。
    if (state.status === 'done') state.stale = true
  }
}

export function makeRoutes(deps: RoutesDeps): WebRoute[] {
  const { configs, store, engine, dsh } = deps
  const table = new Map<string, RouteEntry>()

  const entryFor = (path: string): RouteEntry => {
    const existing = table.get(path)
    if (existing !== undefined) return existing
    const created: RouteEntry = {}
    table.set(path, created)
    return created
  }

  const onGet = (path: string, handler: GetHandler): void => {
    entryFor(path).get = handler
  }

  const onPost = (path: string, handler: PostHandler, options: { rawBody?: boolean } = {}): void => {
    const entry = entryFor(path)
    entry.post = handler
    if (options.rawBody === true) entry.rawBody = true
  }

  // ---------------------------------------------------------------- config

  const extras = async (): Promise<Omit<ConfigView, 'config' | 'secrets'>> => {
    const config = await configs.read()
    const [ffmpeg, ffprobe, ytDlp] = await Promise.all([
      toolAvailable(config.media.ffmpegPath),
      toolAvailable(config.media.ffprobePath),
      toolAvailable(config.media.ytDlpPath, '--version'),
    ])
    return {
      dataDir: deps.dataRoot(),
      ffmpegAvailable: ffmpeg,
      ffprobeAvailable: ffprobe,
      ytDlpAvailable: ytDlp,
    }
  }

  onGet(API.config, async (_url, _req, res) => {
    const config = await configs.read()
    writeJson(res, 200, { ok: true, value: toConfigView(config, await extras()) })
  })

  onPost(API.config, async body => {
    const patch = body.config !== undefined ? body.config : body
    const config = await configs.patch(patch)
    await deps.refreshDataRoot?.()
    return toConfigView(config, await extras())
  })

  // DSH 已配置模型目录（设置页的「提供商 / 模型」下拉数据源）。
  onGet(API.models, async (url, _req, res) => {
    const force = url.searchParams.get('refresh') === '1'
    const catalog = dsh === undefined
      ? { providers: [], errors: ['DSH 模型服务不可用（插件未拿到 ctx.get）'] }
      : await dsh.catalog(force)
    writeJson(res, 200, { ok: true, value: catalog })
  })

  onPost(API.configTest, async body => {
    const stage = asString(body.stage, 'rewrite')
    const config = await configs.read()
    const started = Date.now()
    if (stage === 'parse') {
      const url = extractUrl(asString(body.url))
      if (url === undefined) throw new Error('请先粘贴一个链接用于测试解析接口')
      const parsed = await parseViaApi(config.parser, url, detectPlatform(url))
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        detail: `解析成功：${parsed.title}｜平台 ${parsed.platform}｜${parsed.videoUrl.slice(0, 120)}`,
      }
    }
    const stageEndpoint: EndpointConfig = stage === 'video'
      ? config.video
      : stage === 'image'
        ? config.image
        : stage === 'tts'
          ? config.tts
          : stage === 'asr'
            ? config.asr
            : stage === 'analyze'
              ? config.analyze
              : config.rewrite

    // source=dsh：先用 DSH 目录校验选择，再按模态给出对应结论。
    if (usesDsh(stageEndpoint)) {
      const provider = stageEndpoint.dshProvider.trim()
      const model = stageEndpoint.dshModel.trim()
      if (provider === '' || model === '') throw new Error('还没有选择 DSH 提供商与模型')
      const catalog = dsh === undefined ? undefined : await dsh.catalog()
      const found = catalog?.providers.find(item => item.id === provider)
      if (found === undefined) throw new Error(`DSH 里找不到提供商「${provider}」`)
      const inCatalog = found.models.some(item => item.id === model)
      // 聊天/视觉走 DSH 的 llm 服务，模型必须真的在目录里（否则调用必然失败）。
      if (!inCatalog && (stage === 'analyze' || stage === 'rewrite')) {
        throw new Error(`提供商「${provider}」下找不到模型「${model}」，请重新选择`)
      }
      if (stage === 'analyze' || stage === 'rewrite') {
        const reply = await completeText(dsh, stageEndpoint, {
          label: 'DSH 模型连通性测试',
          system: '你是连通性测试助手。',
          user: '只回复两个字：可用',
          maxTokens: 20,
          temperature: 0,
        })
        return {
          ok: true,
          elapsedMs: Date.now() - started,
          detail: `模型回复：${reply.slice(0, 80)}（${describeEndpoint(stageEndpoint)}）`,
        }
      }
      const route = await resolveEndpoint(dsh, stageEndpoint, '连通性测试')
      const response = await fetch(`${route.apiUrl.replace(/\/+$/, '')}/models`, {
        headers: route.apiKey === '' ? {} : { authorization: `Bearer ${route.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      }).catch(() => undefined)
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        detail: `已选 ${describeEndpoint(stageEndpoint)}；接口地址 ${route.apiUrl}` +
          (response === undefined ? '（/models 不可达，不影响生成）' : `（/models HTTP ${response.status}）`) +
          (inCatalog ? '' : '；该模型不在提供商目录里，会按该名称直接请求'),
      }
    }

    if (stage === 'video' || stage === 'image') {
      const endpoint = stageEndpoint
      if (endpoint.apiUrl.trim() === '') throw new Error('请先填写接口地址')
      const url = `${endpoint.apiUrl.replace(/\/+$/, '')}/models`
      const response = await fetch(url, {
        headers: endpoint.apiKey.trim() === '' ? {} : { authorization: `Bearer ${endpoint.apiKey.trim()}` },
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      let listed = '（未列出）'
      try {
        const parsed = JSON.parse(text) as { data?: Array<{ id?: string }> }
        listed = parsed.data?.map(item => item.id).filter((id): id is string => typeof id === 'string').slice(0, 12).join(', ') ?? listed
      } catch {
        // 非 JSON 就只报 HTTP 状态
      }
      return {
        ok: response.ok,
        elapsedMs: Date.now() - started,
        detail: response.ok ? `接口可达，可用模型：${listed}` : `接口返回 HTTP ${response.status}：${text.slice(0, 200)}`,
      }
    }
    const endpoint = stageEndpoint
    const reply = await chatComplete(endpoint, {
      label: '配置连通性测试',
      system: '你是连通性测试助手。',
      user: '只回复两个字：可用',
      maxTokens: 20,
      temperature: 0,
      timeoutMs: 60_000,
    })
    return { ok: true, elapsedMs: Date.now() - started, detail: `模型回复：${reply.slice(0, 80)}` }
  })

  // ---------------------------------------------------------------- detect

  onPost(API.detect, async body => {
    const input = asString(body.url)
    const url = extractUrl(input)
    if (url === undefined) return { ok: false, recognized: false, message: '没有识别到链接' }
    const platform = detectPlatform(url)
    const config = await configs.read()
    return {
      ok: true,
      recognized: true,
      url,
      platform,
      direct: looksLikeDirectVideo(url),
      hasParserApi: config.parser.apiUrl.trim() !== '',
      mode: config.parser.mode,
      note: platform === 'channels'
        ? '视频号需要登录态，纯接口解析通常不可用：建议用支持视频号的解析服务，或先下载再上传。'
        : '',
    }
  })

  // ---------------------------------------------------------------- runs

  onGet(API.runs, async (_url, _req, res) => {
    const runs = await store.list()
    writeJson(res, 200, {
      ok: true,
      value: { runs, busy: runs.filter(item => engine.isBusy(item.id)).map(item => item.id) },
    })
  })

  onPost(API.runs, async body => {
    const url = extractUrl(asString(body.url))
    const title = asString(body.title).trim()
      || (url === undefined ? '本地视频复刻' : `复刻 ${url.slice(0, 48)}`)
    const aspectRaw = asString(body.aspectRatio, 'source')
    const allowedAspect = (['source', '9:16', '16:9', '1:1', '3:4', '4:3', '21:9'] as const)
      .find(value => value === aspectRaw) ?? 'source'
    const run = await store.create({
      title,
      ...(url === undefined ? {} : { sourceUrl: url }),
      ...(asString(body.productBrief).trim() === '' ? {} : { productBrief: asString(body.productBrief).trim() }),
      autoAdvance: body.autoAdvance !== false,
      aspectRatio: allowedAspect,
    })
    return { run }
  })

  onGet(API.run, async (url, _req, res) => {
    const runId = url.searchParams.get('runId') ?? ''
    const run = await store.get(runId)
    if (run === undefined) {
      writeJson(res, 200, { ok: false, error: '运行不存在' })
      return
    }
    writeJson(res, 200, { ok: true, value: { run, busy: engine.isBusy(runId), busyStep: engine.busyStep(runId) } })
  })

  // ---------------------------------------------------------------- actions

  onPost(API.runAction, async body => {
    const runId = asString(body.runId)
    const action = asString(body.action)
    const run = await store.get(runId)
    if (run === undefined) throw new Error('运行不存在')
    const step = asString(body.step) as (typeof STEP_IDS)[number]

    switch (action) {
      case 'start': {
        const from = STEP_IDS.includes(step) ? step : undefined
        await engine.start(runId, { ...(from === undefined ? {} : { from }), autoAdvance: body.autoAdvance !== false })
        break
      }
      case 'step':
      case 'retry-step': {
        if (!STEP_IDS.includes(step)) throw new Error('未知步骤')
        await engine.start(runId, { from: step, autoAdvance: false })
        break
      }
      case 'skip-step': {
        if (!STEP_IDS.includes(step)) throw new Error('未知步骤')
        await engine.skipStep(runId, step)
        break
      }
      case 'stop': {
        engine.stop(runId)
        break
      }
      case 'select-variant': {
        const variantId = asString(body.variantId)
        const found = run.scripts?.variants.find(variant => variant.id === variantId)
        if (found === undefined) throw new Error('脚本版本不存在')
        run.variantId = variantId
        // 换版本后，参考图与分镜视频都失效。
        run.frames = []
        run.segments = []
        run.compose = undefined
        for (const id of ['match', 'generate', 'compose'] as const) {
          const state = run.steps.find(item => item.id === id)
          if (state !== undefined) {
            state.status = 'pending'
            state.progress = 0
            state.message = undefined
            state.error = undefined
            state.startedAt = undefined
            state.endedAt = undefined
          }
        }
        store.log(run, 'rewrite', 'info', `切换到 ${variantId} 版脚本`)
        await store.flush(runId)
        break
      }
      case 'update-segments': {
        const variant = run.scripts?.variants.find(item => item.id === run.variantId)
        if (variant === undefined) throw new Error('还没有选定脚本')
        const segments = Array.isArray(body.segments) ? body.segments : undefined
        if (segments === undefined) throw new Error('缺少分镜数据')
        const allowedShot: readonly string[] = SHOT_TYPES
        const allowedCamera: readonly string[] = CAMERA_MOVES
        variant.segments = segments.map((item, index) => {
          const record = item as Record<string, unknown>
          const previous = variant.segments[index]
          const shotRaw = asString(record.shotType).trim()
          const cameraRaw = asString(record.camera).trim()
          return {
            index: index + 1,
            startSec: Number(record.startSec ?? 0),
            endSec: Number(record.endSec ?? 4),
            shotType: allowedShot.includes(shotRaw) ? shotRaw : (previous?.shotType ?? '中景'),
            camera: allowedCamera.includes(cameraRaw) ? cameraRaw : (previous?.camera ?? '固定'),
            voiceover: asString(record.voiceover),
            onscreenText: asString(record.onscreenText),
            visualPrompt: asString(record.visualPrompt),
            lighting: asString(record.lighting),
            environment: asString(record.environment),
            emotion: asString(record.emotion),
            speaker: asString(record.speaker),
            productPlacement: asString(record.productPlacement),
          }
        })
        run.frames = []
        run.segments = []
        run.compose = undefined
        for (const id of ['match', 'generate', 'compose'] as const) {
          const state = run.steps.find(item => item.id === id)
          if (state !== undefined) {
            state.status = 'pending'
            state.progress = 0
          }
        }
        store.log(run, 'rewrite', 'info', `分镜已更新（${variant.segments.length} 镜），下游产物已作废`)
        await store.flush(runId)
        break
      }
      case 'remove-product': {
        const index = Number(body.removeIndex ?? -1)
        if (!Number.isFinite(index) || index < 0 || index >= run.productImages.length) throw new Error('产品图序号无效')
        const [removed] = run.productImages.splice(index, 1)
        run.productVisual = undefined
        if (removed !== undefined) store.log(run, 'rewrite', 'info', `已移除产品图：${removed.name}`)
        await store.flush(runId)
        break
      }
      case 'set-aspect-ratio': {
        const raw = asString(body.aspectRatio, 'source')
        const allowed = (['source', '9:16', '16:9', '1:1', '3:4', '4:3', '21:9'] as const)
          .find(value => value === raw)
        if (allowed === undefined) throw new Error('不支持的画幅')
        run.aspectRatio = allowed
        // 画幅变了，首帧/视频/成片都要重出。
        for (const id of ['match', 'generate', 'compose'] as const) {
          const state = run.steps.find(item => item.id === id)
          if (state !== undefined && state.status === 'done') state.stale = true
        }
        store.log(run, 'parse', 'info', `成片画幅设为：${allowed === 'source' ? '跟随源片' : allowed}（首帧/视频/成片需要重新生成）`)
        await store.flush(runId)
        break
      }
      case 'set-audio-source': {
        const value = asString(body.audioSource) === 'original' ? 'original' : 'tts'
        run.audioSource = value
        markStale(run, ['compose'])
        store.log(run, 'compose', 'info', `成片音轨改为：${value === 'original' ? '分镜视频原声' : 'TTS 配音'}（需要重新执行「合成成片」）`)
        await store.flush(runId)
        break
      }
      case 'preview-prompts': {
        // 只拼提示词，不调模型、不花额度。
        const previewConfig = await configs.read()
        return buildPromptPreview(run, previewConfig)
      }
      case 'regenerate-frame':
      case 'regenerate-segment': {
        if (engine.isBusy(runId)) throw new Error('任务正在执行中，请先等待或停止')
        const config = await configs.read()
        const controller = new AbortController()
        const context: PipelineContext = {
          config,
          store,
          run,
          signal: controller.signal,
          ...(dsh === undefined ? {} : { dsh }),
          setStep: (id, patch) => {
            const state = run.steps.find(item => item.id === id)
            if (state !== undefined) Object.assign(state, patch)
          },
          log: (id, level, text) => {
            store.log(run, id, level, text)
          },
        }
        const index = Number(body.segmentIndex ?? 0)
        if (!Number.isFinite(index) || index <= 0) throw new Error('缺少分镜序号')
        const prompt = asString(body.prompt)
        // 置为 running：前端轮询会立刻转起来，用户能看到"正在生成"而不是"点了没反应"。
        const previousStatus = run.status
        run.status = 'running'
        try {
          if (action === 'regenerate-frame') {
            await regenerateFrame(context, index, prompt === '' ? undefined : prompt)
            markStale(run, ['generate', 'compose'])
          } else {
            await regenerateSegment(context, index, prompt === '' ? undefined : prompt)
            markStale(run, ['compose'])
          }
        } finally {
          run.status = previousStatus === 'running' ? 'idle' : previousStatus
        }
        await store.flush(runId)
        break
      }
      case 'delete': {
        engine.stop(runId)
        await store.remove(runId)
        return { deleted: true }
      }
      default:
        throw new Error(`不支持的操作：${action}`)
    }

    const latest = await store.get(runId)
    return { run: latest, busy: engine.isBusy(runId) }
  })

  // ---------------------------------------------------------------- upload

  onPost(API.upload, async (_body, req, res) => {    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const runId = url.searchParams.get('runId') ?? ''
    const kind = url.searchParams.get('kind') ?? 'product'
    // searchParams 已经解码过一次，这里不能再 decodeURIComponent（文件名含 % 会抛错）。
    const name = url.searchParams.get('name') ?? 'upload.bin'
    const run = await store.get(runId)
    if (run === undefined) throw new Error('运行不存在，请先新建复刻任务')
    const bytes = await readRawBody(req, kind === 'video' ? MAX_UPLOAD_BYTES : 40 * 1024 * 1024)
    if (bytes.length < 128) throw new Error('文件为空或过小')
    const dir = store.runDir(runId)

    if (kind === 'video') {
      await mkdir(join(dir, 'source'), { recursive: true })
      const extension = /\.(mp4|mov|m4v|webm|mkv)$/i.exec(name)?.[1]?.toLowerCase() ?? 'mp4'
      const file = `source/upload.${extension}`
      await writeFile(join(dir, file), bytes)
      run.source = {
        platform: 'upload',
        provider: 'upload',
        videoFile: file,
        title: name.replace(/\.[^.]+$/, '').slice(0, 60) || '本地视频',
      }
      run.title = run.source.title
      const state = run.steps.find(item => item.id === 'parse')
      if (state !== undefined) {
        state.status = 'pending'
        state.progress = 0
        state.error = undefined
        state.message = undefined
      }
      store.log(run, 'parse', 'info', `已上传本地视频：${name}（${Math.round(bytes.length / 1048576)}MB）`)
      await store.flush(runId)
      writeJson(res, 200, { ok: true, value: { file, name, bytes: bytes.length, run } })
      return undefined
    }

    await mkdir(join(dir, 'products'), { recursive: true })
    const safe = basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'product.png'
    const extension = extname(safe).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) throw new Error('产品图只支持 png / jpg / webp')
    const fileName = `products/${Date.now().toString(36)}-${safe}`
    await writeFile(join(dir, fileName), bytes)
    run.productImages.push({ file: fileName, name: safe, bytes: bytes.length, createdAt: Date.now() })
    run.productVisual = undefined
    store.log(run, 'rewrite', 'info', `已上传产品图：${safe}`)
    await store.flush(runId)
    writeJson(res, 200, { ok: true, value: { file: fileName, name: safe, bytes: bytes.length, run } })
    return undefined
  }, { rawBody: true })

  // ---------------------------------------------------------------- media

  onGet(API.media, async (url, req, res) => {
    const runId = url.searchParams.get('runId') ?? ''
    const relative = url.searchParams.get('path') ?? ''
    const run = await store.get(runId)
    if (run === undefined) {
      writeJson(res, 404, { ok: false, error: '运行不存在' })
      return
    }
    const file = resolveRunFile(store.runDir(runId), relative)
    if (file === undefined) {
      writeJson(res, 400, { ok: false, error: '非法路径' })
      return
    }
    await serveFile(req, res, file, url.searchParams.get('download') === '1' ? basename(file) : undefined)
  })

  // 读回运行目录里的小文本文件（字幕 / 报告 JSON），便于排障与复制。
  onGet(`${API.media}/text`, async (url, _req, res) => {
    const runId = url.searchParams.get('runId') ?? ''
    const relative = url.searchParams.get('path') ?? ''
    const file = resolveRunFile(store.runDir(runId), relative)
    if (file === undefined) {
      writeJson(res, 400, { ok: false, error: '非法路径' })
      return
    }
    const text = await readFile(file, 'utf8').catch(() => undefined)
    if (text === undefined) {
      writeJson(res, 404, { ok: false, error: '文件不存在' })
      return
    }
    writeJson(res, 200, { ok: true, value: { text: text.slice(0, 400_000) } })
  })

  // ---------------------------------------------------------------- 组装

  const routes: WebRoute[] = []
  for (const [path, entry] of table) {
    routes.push({
      kind: 'exact',
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req as never)) {
          writeJson(res, 403, { ok: false, error: '只允许本机同源访问' })
          return
        }
        const method = (req.method ?? 'GET').toUpperCase()
        try {
          if (method === 'GET' || method === 'HEAD') {
            if (entry.get === undefined) {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
            await entry.get(url, req, res)
            return
          }
          if (method === 'POST') {
            if (entry.post === undefined) {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = entry.rawBody === true ? {} : await readJsonBody(req)
            const value = await entry.post(body, req, res)
            // 上传等处理器自己写了响应，这里只补标准信封。
            if (value !== undefined) writeJson(res, 200, { ok: true, value })
            return
          }
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: messageOf(error) })
        }
      },
    })
  }
  return routes
}
