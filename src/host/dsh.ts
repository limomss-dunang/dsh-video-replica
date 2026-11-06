/**
 * DSH 已配置模型的接入层。
 *
 * 目标：设置里不必重复填写接口地址与密钥——直接从 DSH「模型」设置中读取
 * 已配置的提供商 / 模型 / 凭据。
 *
 * 两条通路：
 * 1. **聊天与视觉**：走宿主 `llm` 服务（`llm.stream`）。DSH 自己负责鉴权、
 *    重试、多模态编排；图片通过 `attachments.saveImages` 变成附件再以
 *    `{ type:'image', attachment }` 内容块交给模型，因此不需要我们重写协议。
 * 2. **图片 / 视频 / 语音**：DSH 没有这些模态的原生适配器，所以从
 *    `configEditor` 读 `llm-pi-ai` 提供商配置里的 `baseURL` / `apiKey`
 *    （或 `apiKeyEnv` 对应的凭据），复用本插件已有 HTTP 适配器发请求。
 *
 * 所有服务都经 `ctx.get(name)` 取，且每一步都容错：宿主/版本差异只让对应
 * 能力降级，绝不让插件激活失败（上一轮启动报错的教训）。
 */

import type { DshModelCatalog, DshModelOption, DshProviderOption } from '../shared/types.ts'
import { asString, messageOf } from './util.ts'

export interface ChatImageInput {
  bytes: Uint8Array
  mediaType: string
}

interface LlmProviderInfo {
  id?: unknown
  name?: unknown
}

interface LlmModelInfo {
  id?: unknown
  name?: unknown
  inputModalities?: unknown
}

interface LlmStreamChunk {
  type?: unknown
  text?: unknown
  reason?: { kind?: unknown, failure?: { message?: unknown } }
}

interface LlmService {
  listProviders?: () => LlmProviderInfo[]
  listModels?: (provider: string) => Promise<LlmModelInfo[]>
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: unknown }>
  stream?: (options: Record<string, unknown>) => AsyncIterable<LlmStreamChunk>
}

interface ConfigEditorEntry {
  options?: { id?: unknown, config?: { providers?: Record<string, unknown> } }
}

interface ConfigEditorService {
  entries?: () => ConfigEditorEntry[]
}

interface CredentialsService {
  resolve?: (ref: string) => Promise<{ value?: string } | undefined>
}

interface AttachmentsService {
  saveImages?: (inputs: Array<{ data: Uint8Array, mediaType: string, name?: string }>) => Promise<Array<Record<string, unknown>>>
}

interface AgentDefaultModelService {
  currentSelection?: () => { provider?: unknown, model?: unknown, providerId?: unknown, modelId?: unknown } | undefined
}

/** 设置服务：`describe()` 给出每个插件条目的实时配置（含用户在设置页里改的值）。 */
interface SettingsService {
  describe?: (options?: { redactSecrets?: boolean }) => Array<{
    ns?: unknown
    value?: unknown
  }>
}

/** 读取服务属性：Cordis 对未 inject 的服务取值会抛错，这里统一兜住。 */
function optional<T>(get: (name: string) => unknown, name: string): T | undefined {
  try {
    return get(name) as T | undefined
  } catch {
    return undefined
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    ;(timer as { unref?: () => void }).unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function toModalities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export interface DshChatRequest {
  provider: string
  model: string
  label: string
  user: string
  system?: string
  images?: ChatImageInput[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface DshRoute {
  baseURL: string
  apiKey: string
}

export class DshModels {
  /** 提供商目录缓存（模型列表探测有网络开销，缓存 60 秒）。 */
  private catalogCache: { at: number, value: DshModelCatalog } | undefined
  /** 设置服务里的提供商配置缓存（5 秒，避免每个提供商都调一次 describe）。 */
  private settingsCache: { at: number, providers: Record<string, unknown> } | undefined

  constructor(private readonly get: (name: string) => unknown) {}

  private llm(): LlmService | undefined {
    return optional<LlmService>(this.get, 'llm')
  }

  /** llm 服务是否可用（不可用时设置页会提示改用「手动填写接口」）。 */
  get available(): boolean {
    return typeof this.llm()?.stream === 'function'
  }

  /** DSH 当前默认模型选择。 */
  defaultSelection(): { provider: string, model: string } | undefined {
    const service = optional<AgentDefaultModelService>(this.get, 'agentDefaultModel')
    try {
      const selection = service?.currentSelection?.()
      const provider = asString(selection?.provider ?? selection?.providerId).trim()
      const model = asString(selection?.model ?? selection?.modelId).trim()
      if (provider !== '' && model !== '') return { provider, model }
    } catch {
      // 版本差异：读不到就当没有默认值
    }
    return undefined
  }

  /**
   * 列出 DSH 已配置的提供商与模型。
   * @param force - true 时忽略缓存重新探测。
   */
  async catalog(force = false): Promise<DshModelCatalog> {
    const cached = this.catalogCache
    if (!force && cached !== undefined && Date.now() - cached.at < 60_000) return cached.value

    const errors: string[] = []
    const providers: DshProviderOption[] = []
    const llm = this.llm()
    if (llm === undefined) {
      errors.push('DSH 的 llm 服务不可用（无法读取已配置模型）')
      const empty = { providers, errors }
      this.catalogCache = { at: Date.now(), value: empty }
      return empty
    }

    let declared: Array<{ id: string, name: string }> = []
    try {
      const list = llm.listProviders?.() ?? []
      declared = list
        .map(entry => ({
          id: asString(entry?.id).trim(),
          name: asString(entry?.name).trim() || asString(entry?.id).trim(),
        }))
        .filter(entry => entry.id !== '')
    } catch (error) {
      errors.push(`读取提供商列表失败：${messageOf(error)}`)
    }

    // 组合配置 / 设置文档里声明的提供商也列出来：即使适配器没注册（或模型列表
    // 探测失败），用户也应该能看到自己在「设置 → 模型」里配过什么。
    const configured = this.configuredProviders()
    for (const id of Object.keys(configured)) {
      if (declared.some(entry => entry.id === id)) continue
      const section = configured[id]
      const record = section !== null && typeof section === 'object' ? section as Record<string, unknown> : {}
      declared.push({ id, name: asString(record.name).trim() || id })
    }

    // 各提供商的模型列表并行探测（每个自带 12s 超时，慢的不会拖住其它）。
    const resolved = await Promise.all(declared.map(async provider => {
      const models: DshModelOption[] = []
      const seen = new Set<string>()
      let error: string | undefined
      try {
        const listed = await withTimeout(
          Promise.resolve(llm.listModels?.(provider.id) ?? []),
          12_000,
          `读取 ${provider.name} 的模型列表`,
        )
        for (const model of listed ?? []) {
          const id = asString(model?.id).trim()
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          models.push({
            id,
            name: asString(model?.name).trim() || id,
            modalities: toModalities(model?.inputModalities),
          })
        }
      } catch (cause) {
        error = messageOf(cause)
      }

      // 探测失败或没返回时，退回配置里声明过的模型列表——「设置 → 模型」里
      // 手写的 models 才是用户真实可用的清单。
      if (models.length === 0) {
        const section = configured[provider.id]
        const record = section !== null && typeof section === 'object' ? section as Record<string, unknown> : {}
        const declaredModels = Array.isArray(record.models) ? record.models : []
        for (const item of declaredModels) {
          const id = asString(typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.id).trim()
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          models.push({
            id,
            name: asString((item as Record<string, unknown> | null)?.name).trim() || id,
            modalities: toModalities((item as Record<string, unknown> | null)?.inputModalities),
          })
        }
        if (models.length > 0) error = undefined
      }

      const route = await this.route(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        models: models.sort((a, b) => a.id.localeCompare(b.id)),
        routeReady: route !== undefined,
        ...(error === undefined ? {} : { error: error.slice(0, 200) }),
      } satisfies DshProviderOption
    }))
    providers.push(...resolved)

    // 有模型的提供商排前面，其余按名字稳定排序。
    providers.sort((a, b) => {
      const delta = (b.models.length > 0 ? 1 : 0) - (a.models.length > 0 ? 1 : 0)
      return delta !== 0 ? delta : a.name.localeCompare(b.name)
    })

    const defaultSelection = this.defaultSelection()
    const value: DshModelCatalog = {
      providers,
      ...(defaultSelection === undefined ? {} : { default: defaultSelection }),
      errors,
    }
    this.catalogCache = { at: Date.now(), value }
    return value
  }

  /**
   * 已配置的提供商（id → 原始配置）。
   *
   * 两个来源合并，后者优先：
   * 1. `configEditor` 里 `llm-pi-ai` 条目的组合配置；
   * 2. `settings.describe()` 里同名条目的**实时**值——用户在「设置 → 模型」里改的
   *    baseURL / models 属于设置文档，只在组合配置里看不到它们。
   */
  private configuredProviders(): Record<string, unknown> {
    const merged: Record<string, unknown> = {}

    const editor = optional<ConfigEditorService>(this.get, 'configEditor')
    try {
      const entries = editor?.entries?.() ?? []
      const entry = entries.find(row => asString(row?.options?.id) === 'llm-pi-ai')
      const providers = entry?.options?.config?.providers
      if (providers !== null && typeof providers === 'object') {
        Object.assign(merged, providers as Record<string, unknown>)
      }
    } catch {
      // 组合配置读不到就只依赖设置
    }

    const cached = this.settingsCache
    const settings = cached !== undefined && Date.now() - cached.at < 5_000
      ? cached.providers
      : this.readSettingsProviders()
    for (const [id, section] of Object.entries(settings)) {
      const current = merged[id]
      merged[id] = current !== null && typeof current === 'object' && section !== null && typeof section === 'object'
        ? { ...(current as Record<string, unknown>), ...(section as Record<string, unknown>) }
        : section
    }
    return merged
  }

  /** 从设置服务读 `llm-pi-ai` 的提供商配置（只保留结构，不做日志输出）。 */
  private readSettingsProviders(): Record<string, unknown> {
    const settings = optional<SettingsService>(this.get, 'settings')
    try {
      const rows = settings?.describe?.({ redactSecrets: true }) ?? []
      const row = rows.find(item => asString(item?.ns) === 'llm-pi-ai')
      const record = row?.value !== null && typeof row?.value === 'object' ? row.value as Record<string, unknown> : undefined
      const providers = record?.providers
      const result = providers !== null && typeof providers === 'object' ? providers as Record<string, unknown> : {}
      this.settingsCache = { at: Date.now(), providers: result }
      return result
    } catch {
      return {}
    }
  }

  /**
   * 解析某个提供商的 OpenAI 兼容接口地址与密钥。
   * 只有配置里显式写了 baseURL 才能用于图片/视频等自建请求。
   */
  async route(providerId: string): Promise<DshRoute | undefined> {
    const id = providerId.trim()
    if (id === '') return undefined
    const section = this.configuredProviders()[id]
    if (section === null || typeof section !== 'object') return undefined
    const record = section as Record<string, unknown>
    const baseURL = asString(record.baseURL).trim().replace(/\/+$/, '')
    if (baseURL === '') return undefined
    let apiKey = asString(record.apiKey).trim()
    if (apiKey === '') {
      const env = asString(record.apiKeyEnv).trim()
      if (env !== '') {
        const credentials = optional<CredentialsService>(this.get, 'credentials')
        try {
          const resolved = await credentials?.resolve?.(env)
          apiKey = asString(resolved?.value).trim()
        } catch {
          // 凭据读取失败就退化为空密钥，让上游报鉴权错误
        }
      }
    }
    return { baseURL, apiKey }
  }

  /**
   * 用 DSH 已配置的模型跑一次对话（可带图片）。
   * @returns 模型回复的纯文本。
   */
  async chat(request: DshChatRequest): Promise<string> {
    const llm = this.llm()
    if (llm?.stream === undefined) {
      throw new Error(`${request.label}：DSH 的 llm 服务不可用，请在设置里改用「手动填写接口」`)
    }
    const provider = request.provider.trim()
    const model = request.model.trim()
    if (provider === '' || model === '') {
      throw new Error(`${request.label}：还没有选择 DSH 模型（设置 → 视频复刻 → 选择提供商与模型）`)
    }

    // 先看模型是否声明支持图片，提前给出比上游 400 更清楚的原因。
    if (request.images !== undefined && request.images.length > 0) {
      try {
        const info = await llm.resolveModelInfo?.(provider, model)
        const modalities = toModalities(info?.inputModalities)
        if (modalities.length > 0 && !modalities.includes('image')) {
          throw new Error(
            `${request.label}：模型 ${provider}/${model} 未声明图片输入能力，无法做画面拆解。` +
            '请在设置里换一个视觉模型，或改用「手动填写接口」。',
          )
        }
      } catch (error) {
        const message = messageOf(error)
        if (message.includes('未声明图片输入能力')) throw error
        // 查询能力失败不阻断：交给实际调用判断
      }
    }

    const content: Array<Record<string, unknown>> = []
    if (request.images !== undefined && request.images.length > 0) {
      const attachments = optional<AttachmentsService>(this.get, 'attachments')
      if (typeof attachments?.saveImages !== 'function') {
        throw new Error(`${request.label}：DSH 附件服务不可用，无法把抽帧图片交给视觉模型`)
      }
      const refs = await attachments.saveImages(request.images.map((image, index) => ({
        data: image.bytes,
        mediaType: image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType,
        name: `frame-${String(index + 1).padStart(2, '0')}`,
      })))
      for (const ref of refs) content.push({ type: 'image', attachment: ref })
    }
    content.push({ type: 'text', text: request.user })

    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content }],
      ...(request.system === undefined || request.system === '' ? {} : { system: request.system }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })

    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') {
        text += asString(chunk.text)
        continue
      }
      if (chunk?.type === 'finish') {
        const kind = asString(chunk.reason?.kind)
        if (kind === 'error') {
          const detail = asString(chunk.reason?.failure?.message) || '未知错误'
          throw new Error(`${request.label}：模型调用失败（${detail}）`)
        }
        if (kind === 'aborted') throw new Error(`${request.label}：已取消`)
      }
    }
    if (text.trim() === '') throw new Error(`${request.label}：模型返回空内容`)
    return text
  }

  /** 清空缓存（设置变化或用户手动刷新时）。 */
  invalidate(): void {
    this.catalogCache = undefined
  }
}
