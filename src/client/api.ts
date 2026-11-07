/**
 * 浏览器侧桥接客户端：所有请求都打到本机同源路由（loopback-only）。
 */

import type {
  ApiEnvelope,
  ConfigView,
  DshModelCatalog,
  PluginConfig,
  RunState,
  RunSummary,
  ScriptSegment,
  StepId,
} from '../shared/types.ts'
import { API } from '../shared/types.ts'

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`桥接接口 HTTP ${response.status}`)
  const envelope = await response.json() as ApiEnvelope<T>
  if (envelope.ok !== true) throw new Error(envelope.error ?? '宿主返回失败')
  return envelope.value as T
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`桥接接口 HTTP ${response.status}`)
  const envelope = await response.json() as ApiEnvelope<T>
  if (envelope.ok !== true) throw new Error(envelope.error ?? '宿主返回失败')
  return envelope.value as T
}

export interface DetectResult {
  ok: boolean
  recognized: boolean
  url?: string
  platform?: string
  direct?: boolean
  hasParserApi?: boolean
  mode?: string
  note?: string
  message?: string
}

export interface RunsPayload {
  runs: RunSummary[]
  busy: string[]
}

export interface RunPayload {
  run: RunState
  busy: boolean
  busyStep?: StepId
}

export interface PromptPreviewPayload {
  variantId: string
  productMode: 'reference' | 'text'
  frames: Array<{ segmentIndex: number, shotType: string, camera: string, framePrompt: string }>
  videos: Array<{ segmentIndex: number, durationSec: number, shots: number[], videoPrompt: string }>
}

export interface TestResult {
  ok: boolean
  elapsedMs: number
  detail: string
}

export class VideoReplicaApi {
  config(): Promise<ConfigView> {
    return getJson<ConfigView>(API.config)
  }

  /** DSH 已配置的提供商与模型（设置页的下拉数据源）。 */
  models(force = false): Promise<DshModelCatalog> {
    return getJson<DshModelCatalog>(`${API.models}${force ? '?refresh=1' : ''}`)
  }

  saveConfig(config: PluginConfig): Promise<ConfigView> {
    return postJson<ConfigView>(API.config, { config })
  }

  testStage(stage: string, extra: Record<string, unknown> = {}): Promise<TestResult> {
    return postJson<TestResult>(API.configTest, { stage, ...extra })
  }

  detect(url: string): Promise<DetectResult> {
    return postJson<DetectResult>(API.detect, { url })
  }

  async runs(): Promise<RunsPayload> {
    return await getJson<RunsPayload>(API.runs)
  }

  createRun(input: { url?: string, productBrief?: string, autoAdvance?: boolean, aspectRatio?: string }): Promise<{ run: RunState }> {
    return postJson<{ run: RunState }>(API.runs, input)
  }

  async run(runId: string): Promise<RunPayload> {
    return await getJson<RunPayload>(`${API.run}?runId=${encodeURIComponent(runId)}`)
  }

  action(payload: Record<string, unknown>): Promise<{ run?: RunState, busy?: boolean, deleted?: boolean }> {
    return postJson(API.runAction, payload)
  }

  start(runId: string, autoAdvance: boolean, from?: StepId): Promise<unknown> {
    return this.action({ runId, action: 'start', autoAdvance, ...(from === undefined ? {} : { step: from }) })
  }

  runStep(runId: string, step: StepId): Promise<unknown> {
    return this.action({ runId, action: 'step', step })
  }

  skipStep(runId: string, step: StepId): Promise<unknown> {
    return this.action({ runId, action: 'skip-step', step })
  }

  stop(runId: string): Promise<unknown> {
    return this.action({ runId, action: 'stop' })
  }

  deleteRun(runId: string): Promise<unknown> {
    return this.action({ runId, action: 'delete' })
  }

  selectVariant(runId: string, variantId: string): Promise<unknown> {
    return this.action({ runId, action: 'select-variant', variantId })
  }

  updateSegments(runId: string, segments: ScriptSegment[]): Promise<unknown> {
    return this.action({ runId, action: 'update-segments', segments })
  }

  /**
   * 预览提示词。带 8 秒超时：宿主还是旧进程（没有这个动作）时请求会挂住，
   * 不设超时界面就只会“点了没反应”。
   */
  async previewPrompts(runId: string): Promise<PromptPreviewPayload> {
    const response = await fetch(API.runAction, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, action: 'preview-prompts' }),
      signal: AbortSignal.timeout(8000),
    }).catch(error => {
      const text = error instanceof Error && error.name === 'TimeoutError'
        ? '宿主没有响应（可能还没重启：预览接口是新加的）'
        : `请求失败：${error instanceof Error ? error.message : String(error)}`
      throw new Error(text)
    })
    if (!response.ok) throw new Error(`桥接接口 HTTP ${response.status}`)
    const envelope = await response.json() as ApiEnvelope<unknown>
    if (envelope.ok !== true) throw new Error(envelope.error ?? '宿主返回失败')
    // 宿主路由可能把 payload 再包一层 {ok,value}，这里逐层解到有 frames 为止。
    let value: unknown = envelope.value
    for (let depth = 0; depth < 3; depth += 1) {
      const record = value as { frames?: unknown, value?: unknown } | undefined
      if (record?.frames !== undefined) break
      if (record?.value === undefined) break
      value = record.value
    }
    const payload = value as PromptPreviewPayload
    if (payload?.frames === undefined) throw new Error('宿主返回的预览数据格式不对（可能还没重启）')
    return payload
  }

  regenerateFrame(runId: string, segmentIndex: number, prompt?: string): Promise<unknown> {
    return this.action({ runId, action: 'regenerate-frame', segmentIndex, ...(prompt === undefined ? {} : { prompt }) })
  }

  setRewriteMode(runId: string, mode: 'faithful' | 'redesign'): Promise<unknown> {
    return this.action({ runId, action: 'set-rewrite-mode', mode })
  }

  caption(runId: string, extra?: string): Promise<unknown> {
    return this.action({ runId, action: 'caption', ...(extra === undefined ? {} : { extra }) })
  }

  publish(runId: string, input: { platform?: string, title?: string, description?: string, topics?: string[] }): Promise<unknown> {
    return this.action({ runId, action: 'publish', ...input })
  }

  setAspectRatio(runId: string, aspectRatio: string): Promise<unknown> {
    return this.action({ runId, action: 'set-aspect-ratio', aspectRatio })
  }

  setAudioSource(runId: string, audioSource: 'tts' | 'original'): Promise<unknown> {
    return this.action({ runId, action: 'set-audio-source', audioSource })
  }

  regenerateSegment(runId: string, segmentIndex: number, prompt?: string): Promise<unknown> {
    return this.action({ runId, action: 'regenerate-segment', segmentIndex, ...(prompt === undefined ? {} : { prompt }) })
  }

  /** 上传本地视频（原始字节 + 文件名头）。 */
  async uploadVideo(runId: string, file: File): Promise<RunState> {
    const response = await fetch(`${API.upload}?runId=${encodeURIComponent(runId)}&kind=video&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const envelope = await response.json() as ApiEnvelope<{ run: RunState }>
    if (envelope.ok !== true) throw new Error(envelope.error ?? '上传失败')
    return (envelope.value as { run: RunState }).run
  }

  /** 上传产品参考图。 */
  async uploadProduct(runId: string, file: File): Promise<RunState> {
    const response = await fetch(`${API.upload}?runId=${encodeURIComponent(runId)}&kind=product&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    })
    const envelope = await response.json() as ApiEnvelope<{ run: RunState }>
    if (envelope.ok !== true) throw new Error(envelope.error ?? '上传失败')
    return (envelope.value as { run: RunState }).run
  }
}

/** 运行目录内媒体的可访问 URL。 */
export function mediaUrl(
  runId: string,
  path: string,
  options: { download?: boolean, version?: string | number } = {},
): string {
  const search = new URLSearchParams({ runId, path })
  if (options.download === true) search.set('download', '1')
  // 重新生成后文件路径不变，带上版本号强制浏览器重新取，避免继续播放缓存/错误状态。
  if (options.version !== undefined && String(options.version) !== '') search.set('v', String(options.version))
  return `${API.media}?${search.toString()}`
}

export function readText(runId: string, path: string): Promise<{ text: string }> {
  return getJson<{ text: string }>(`${API.media}/text?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`)
}
