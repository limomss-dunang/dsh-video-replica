/**
 * 上游 HTTP 基础设施：带超时 / 可重试状态码 / JSON 解析的 fetch 封装。
 *
 * 约定：所有 provider 都通过这里出网，错误信息统一带上「哪一步、哪家网关、
 * HTTP 状态、响应体前 400 字」，方便用户在设置页排障。
 */

import { messageOf, sleep } from '../util.ts'

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  /** JSON 请求体（与 body 互斥）。 */
  json?: unknown
  /** 原始请求体（FormData / Uint8Array 等）。 */
  body?: BodyInit
  timeoutMs?: number
  /** 是否把非 2xx 当成可重试（429/5xx 默认重试）。 */
  retries?: number
  /** 调用标签，进入错误文本。 */
  label: string
  /** 外部取消信号。 */
  signal?: AbortSignal
}

export interface JsonResponse {
  status: number
  ok: boolean
  json: unknown
  text: string
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

function isRetryable(status: number): boolean {
  return RETRYABLE.has(status)
}

/** 发一次请求并读回文本（不做 JSON 断言）。 */
export async function requestText(url: string, options: RequestOptions): Promise<{ status: number, ok: boolean, text: string, headers: Headers }> {
  const retries = options.retries ?? 1
  let attempt = 0
  let lastError: unknown
  while (attempt <= retries) {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 120_000
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const headers: Record<string, string> = { ...options.headers }
      let body: BodyInit | undefined = options.body
      if (options.json !== undefined) {
        headers['content-type'] = headers['content-type'] ?? 'application/json'
        body = JSON.stringify(options.json)
      }
      const response = await fetch(url, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      })
      const text = await response.text()
      if (!response.ok && isRetryable(response.status) && attempt < retries) {
        lastError = new Error(`${options.label}：HTTP ${response.status} ${text.slice(0, 400)}`)
        attempt += 1
        await sleep(600 * attempt)
        continue
      }
      return { status: response.status, ok: response.ok, text, headers: response.headers }
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) throw new Error(`${options.label}：已取消`)
      if (attempt >= retries) break
      attempt += 1
      await sleep(600 * attempt)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
  throw new Error(`${options.label}：请求失败（${messageOf(lastError)}）`)
}

/** 请求并解析 JSON，非 2xx 抛错。 */
export async function requestJson(url: string, options: RequestOptions): Promise<unknown> {
  const response = await requestText(url, options)
  let parsed: unknown
  try {
    parsed = response.text === '' ? {} : JSON.parse(response.text)
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const detail = typeof parsed === 'object' && parsed !== null
      ? JSON.stringify(parsed).slice(0, 600)
      : response.text.slice(0, 600)
    throw new Error(`${options.label}：HTTP ${response.status} ${detail}`)
  }
  if (parsed === undefined) {
    throw new Error(`${options.label}：响应不是 JSON（前 300 字：${response.text.slice(0, 300)}）`)
  }
  return parsed
}

/** 请求二进制（图片/音频/TTS 用）。 */
export async function requestBuffer(url: string, options: RequestOptions): Promise<{ bytes: Uint8Array, contentType: string }> {
  const retries = options.retries ?? 1
  let attempt = 0
  let lastError: unknown
  while (attempt <= retries) {
    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? 180_000
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const headers: Record<string, string> = { ...options.headers }
      let body: BodyInit | undefined = options.body
      if (options.json !== undefined) {
        headers['content-type'] = headers['content-type'] ?? 'application/json'
        body = JSON.stringify(options.json)
      }
      const response = await fetch(url, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        if (isRetryable(response.status) && attempt < retries) {
          lastError = new Error(`${options.label}：HTTP ${response.status} ${detail.slice(0, 300)}`)
          attempt += 1
          await sleep(600 * attempt)
          continue
        }
        throw new Error(`${options.label}：HTTP ${response.status} ${detail.slice(0, 300)}`)
      }
      const buffer = new Uint8Array(await response.arrayBuffer())
      return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' }
    } catch (error) {
      lastError = error
      if (attempt >= retries) break
      attempt += 1
      await sleep(600 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`${options.label}：下载失败（${messageOf(lastError)}）`)
}

/** 拼接 URL：base 可能已带 /v1，也可能带了完整路径。 */
export function joinUrl(base: string, path: string): string {
  const trimmed = base.trim().replace(/\/+$/, '')
  if (trimmed === '') return path
  if (trimmed.endsWith(path)) return trimmed
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  return `${trimmed}${cleanPath}`
}

/**
 * 端点基址归一：用户可能填 `https://x/v1`、`https://x`、或完整接口地址。
 * 返回可直接拼路径的基址（不含结尾斜杠）。
 */
export function baseUrlOf(apiUrl: string, defaultSuffix = '/v1'): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '') return `${url.origin}${defaultSuffix}`
    return `${url.origin}${path}`
  } catch {
    return trimmed
  }
}

/** Bearer 头（密钥为空时不带）。 */
export function authHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...extra }
  const key = apiKey.trim()
  if (key !== '') headers.authorization = `Bearer ${key}`
  return headers
}

/** 解析用户填的额外 JSON 参数（失败返回空对象，不阻断主流程）。 */
export function extraParams(extraJson: string | undefined): Record<string, unknown> {
  if (extraJson === undefined || extraJson.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(extraJson)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 用户填写的手写 JSON 可能不合法，忽略而不是让整个生成失败。
  }
  return {}
}
