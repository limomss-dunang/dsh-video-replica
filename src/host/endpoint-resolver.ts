/**
 * 端点解析：把「一步的模型配置」解析成真正可用的调用参数。
 *
 * source=custom → 直接用手填的 apiUrl / apiKey / model；
 * source=dsh    → 从 DSH 已配置的提供商里取接口地址与密钥，模型名用 dshModel。
 *
 * 聊天与视觉两种走 DSH 的 `llm.stream`（DSH 自己鉴权、编排多模态），
 * 图片 / 视频 / 语音这类 DSH 没有适配器的模态，用解析出来的接口地址自建请求。
 */

import type { EndpointConfig } from '../shared/types.ts'
import { chatComplete, type ChatImage, type ChatOptions } from './providers/chat.ts'
import type { DshModels } from './dsh.ts'
import { asString } from './util.ts'

export interface ResolvedEndpoint {
  apiUrl: string
  apiKey: string
  model: string
  /** 是否来自 DSH 配置。 */
  fromDsh: boolean
}

/** 这一步是否使用 DSH 已配置模型。 */
export function usesDsh(endpoint: Partial<EndpointConfig> | undefined): boolean {
  return asString(endpoint?.source).trim() === 'dsh'
}

/**
 * 解析出可以直接发 HTTP 请求的端点。
 * source=custom 直接返回配置；source=dsh 需要提供商在 DSH 配置里写了 baseURL。
 */
export async function resolveEndpoint(
  dsh: DshModels | undefined,
  endpoint: EndpointConfig,
  label: string,
): Promise<ResolvedEndpoint> {
  if (!usesDsh(endpoint)) {
    return {
      apiUrl: endpoint.apiUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      fromDsh: false,
    }
  }
  if (dsh === undefined) {
    throw new Error(`${label}：DSH 模型服务不可用，请在设置里改用「手动填写接口」`)
  }
  const provider = endpoint.dshProvider.trim()
  const model = endpoint.dshModel.trim()
  if (provider === '' || model === '') {
    throw new Error(`${label}：还没有选择 DSH 模型（设置 → 视频复刻 → 选择提供商与模型）`)
  }
  const route = await dsh.route(provider)
  if (route === undefined) {
    throw new Error(
      `${label}：提供商「${provider}」在 DSH 配置里没有接口地址（baseURL），无法用于图片/视频/语音请求。` +
      '请在 DSH 模型设置里补上接口地址，或在本插件里改用「手动填写接口」。',
    )
  }
  return { apiUrl: route.baseURL, apiKey: route.apiKey, model, fromDsh: true }
}

export type CompleteOptions = Omit<ChatOptions, 'label' | 'system' | 'user' | 'images' | 'json'> & {
  label: string
  system?: string
  user: string
  images?: ChatImage[]
  /** 只是提示词要求 JSON，不是协议字段；DSH 通道没有 response_format。 */
  json?: boolean
}

/**
 * 跑一次文本/视觉补全，自动选择走 DSH 的 llm 服务还是手填的 HTTP 端点。
 */
export async function completeText(
  dsh: DshModels | undefined,
  endpoint: EndpointConfig,
  options: CompleteOptions,
): Promise<string> {
  if (!usesDsh(endpoint)) {
    return await chatComplete(endpoint, options as ChatOptions)
  }
  if (dsh === undefined) {
    throw new Error(`${options.label}：DSH 模型服务不可用，请在设置里改用「手动填写接口」`)
  }
  return await dsh.chat({
    provider: endpoint.dshProvider,
    model: endpoint.dshModel,
    label: options.label,
    user: options.user,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/** 界面上显示「这一步用的是哪个模型」。 */
export function describeEndpoint(endpoint: Partial<EndpointConfig> | undefined): string {
  if (endpoint === undefined) return ''
  if (usesDsh(endpoint)) {
    const provider = asString(endpoint.dshProvider).trim() || '未选提供商'
    const model = asString(endpoint.dshModel).trim() || '未选模型'
    return `${provider} / ${model}（DSH 已配置）`
  }
  const model = asString(endpoint.model).trim()
  const url = asString(endpoint.apiUrl).trim()
  if (model === '' && url === '') return ''
  return `${model === '' ? '未填模型' : model} @ ${url === '' ? '未填接口' : url}`
}
