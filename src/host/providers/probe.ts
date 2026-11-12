/**
 * 模型探测：用「接口地址 + Key」去拉 /models，按阶段过滤，并推断协议。
 *
 * 目的：使用者不必记住模型版本号和协议名——填好 baseURL 与 Key，
 * 点「检测模型」，从下拉里选一个即可，协议自动切到正确的那一个。
 */

import type { ProviderStage } from '../../shared/provider-detect.ts'
import { genericProtocol, inferProtocol, matchPreset, modelMatchesStage, suggestedModels } from '../../shared/provider-detect.ts'

export interface ProbeInput {
  stage: ProviderStage
  apiUrl: string
  apiKey: string
}

export interface ProbeResult {
  /** 可选的模型名（预设 + 实际列表）。 */
  models: string[]
  /** 推断出的协议。 */
  protocol: string
  /** 命中的提供商名称（没有则 undefined）。 */
  provider?: string
  /** 给人看的补充说明。 */
  note?: string
  /** /models 是否成功（false 时 models 只来自预设）。 */
  listed: boolean
  error?: string
}

function trimBase(apiUrl: string): string {
  let base = apiUrl.trim().replace(/\/+$/, '')
  if (base === '') return ''
  // 用户可能填了 .../v1/chat/completions 这类完整路径，退回到 origin + 版本段
  const match = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(base)
  if (match === null) return base
  const origin = match[1] as string
  const rest = (match[2] ?? '').replace(/\/(chat\/completions|images\/generations|audio\/speech|audio\/transcriptions|models).*$/i, '')
  return `${origin}${rest}`
}

/** 从 /models 响应里取出模型 id 列表（兼容 OpenAI / 火山 / 常见聚合网关）。 */
function modelsOf(payload: unknown): string[] {
  const record = payload as { data?: unknown, models?: unknown, result?: unknown }
  const pick = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    for (const item of value) {
      if (typeof item === 'string') { out.push(item); continue }
      if (item !== null && typeof item === 'object') {
        const row = item as Record<string, unknown>
        const id = row.id ?? row.name ?? row.model ?? row.model_id
        if (typeof id === 'string' && id.trim() !== '') out.push(id.trim())
      }
    }
    return out
  }
  return [...pick(record.data), ...pick(record.models), ...pick(record.result)]
}

/** 探测某个阶段在某接口地址下可用的模型，并推断协议。 */
export async function probeModels(input: ProbeInput, options: { timeoutMs?: number, signal?: AbortSignal } = {}): Promise<ProbeResult> {
  const stage = input.stage
  const apiUrl = input.apiUrl.trim()
  if (apiUrl === '') {
    return { models: [], protocol: genericProtocol(stage), listed: false, error: '先填接口地址' }
  }
  const preset = matchPreset(apiUrl)
  const base = trimBase(apiUrl)
  const timeoutMs = options.timeoutMs ?? 12_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // 豆包语音没有 /models（模型就是 Resource-Id），直接用预设列表。
  if (preset?.id === 'openspeech') {
    clearTimeout(timer)
    const models = preset.models[stage] ?? []
    return {
      models,
      protocol: preset.protocols[stage] ?? genericProtocol(stage),
      provider: preset.label,
      ...(preset.note === undefined ? {} : { note: preset.note }),
      listed: false,
    }
  }

  try {
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: {
        ...(input.apiKey.trim() === '' ? {} : { authorization: `Bearer ${input.apiKey.trim()}` }),
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const models = preset?.models[stage] ?? []
      return {
        models,
        protocol: preset?.protocols[stage] ?? genericProtocol(stage),
        ...(preset === undefined ? {} : { provider: preset.label }),
        ...(preset?.note === undefined ? {} : { note: preset.note }),
        listed: false,
        error: `读取模型列表失败：HTTP ${response.status} ${detail.slice(0, 160)}`,
      }
    }
    const payload = await response.json().catch(() => undefined)
    const listed = modelsOf(payload)
    const models = suggestedModels(stage, apiUrl, listed)
    const first = models[0]
    return {
      models,
      protocol: first === undefined ? genericProtocol(stage) : inferProtocol(stage, apiUrl, first),
      ...(preset === undefined ? {} : { provider: preset.label }),
      ...(preset?.note === undefined ? {} : { note: preset.note }),
      listed: listed.length > 0,
      ...(models.length === 0 ? { error: '这个接口没有返回适用于当前步骤的模型，可手动填写模型名' } : {}),
    }
  } catch (error) {
    const models = preset?.models[stage] ?? []
    const message = error instanceof Error ? error.message : String(error)
    return {
      models,
      protocol: preset?.protocols[stage] ?? genericProtocol(stage),
      ...(preset === undefined ? {} : { provider: preset.label }),
      ...(preset?.note === undefined ? {} : { note: preset.note }),
      listed: false,
      error: `连不上 ${base}/models（${message.slice(0, 120)}）`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 该阶段模型是否匹配（导出给测试用）。 */
export { modelMatchesStage }
