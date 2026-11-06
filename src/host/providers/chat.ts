/**
 * 聊天 / 视觉模型适配：OpenAI 兼容 /chat/completions。
 *
 * 视觉模型走同一条路径，图片以 `image_url` 的 base64 data URL 传入 —— 这是
 * OpenAI 兼容网关（含 MiMo、GPT-4o 系、Qwen-VL 兼容层）最通用的形态。
 * 某些网关（如 MiMo）用 `api-key` 头而不是 `Bearer`，这里两个都带，互不影响。
 */

import type { EndpointConfig } from '../../shared/types.ts'
import { baseUrlOf, authHeaders, extraParams, joinUrl, requestJson } from './http.ts'

export interface ChatContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface ChatImage {
  /** 图片字节与 MIME。 */
  bytes: Uint8Array
  mediaType: string
}

export interface ChatOptions {
  label: string
  system?: string
  user: string
  images?: ChatImage[]
  /** 期望严格 JSON（多数网关支持 response_format）。 */
  json?: boolean
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}

function dataUrl(image: ChatImage): string {
  const mime = image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType
  return `data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`
}

function chatUrl(config: EndpointConfig): string {
  const raw = config.apiUrl.trim()
  if (raw === '') throw new Error(`${'聊天模型'} 未配置接口地址`)
  if (/\/chat\/completions$/i.test(raw)) return raw
  return joinUrl(baseUrlOf(raw, '/v1'), '/chat/completions')
}

/** 从 OpenAI 兼容响应中取出正文。 */
function textOf(payload: unknown): string {
  const record = payload as { choices?: Array<{ message?: { content?: unknown }, text?: string }> }
  const choice = record?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('')
  }
  if (typeof choice?.text === 'string') return choice.text
  return ''
}

/** 一次聊天补全，返回纯文本。 */
export async function chatComplete(config: EndpointConfig, options: ChatOptions): Promise<string> {
  if (config.apiUrl.trim() === '') throw new Error(`${options.label}：未配置接口地址（设置 → 视频复刻）`)
  if (config.model.trim() === '') throw new Error(`${options.label}：未配置模型名（设置 → 视频复刻）`)
  const url = chatUrl(config)
  const messages: Array<Record<string, unknown>> = []
  if (options.system !== undefined && options.system.trim() !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  if (options.images !== undefined && options.images.length > 0) {
    const parts: ChatContentPart[] = options.images.map(image => ({
      type: 'image_url',
      image_url: { url: dataUrl(image) },
    }))
    parts.push({ type: 'text', text: options.user })
    messages.push({ role: 'user', content: parts })
  } else {
    messages.push({ role: 'user', content: options.user })
  }

  const headers: Record<string, string> = { ...authHeaders(config.apiKey, { 'content-type': 'application/json' }) }
  const key = config.apiKey.trim()
  if (key !== '') headers['api-key'] = key
  const timeoutMs = options.timeoutMs ?? Math.max(30_000, (config.timeoutSec ?? 120) * 1000)
  const base: Record<string, unknown> = {
    model: config.model.trim(),
    messages,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...extraParams(config.extraJson),
  }

  const send = async (body: Record<string, unknown>): Promise<string> => {
    const payload = await requestJson(url, {
      method: 'POST',
      headers,
      json: body,
      label: options.label,
      timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const text = textOf(payload)
    if (text.trim() === '') {
      throw new Error(`${options.label}：模型返回空内容（${JSON.stringify(payload).slice(0, 400)}）`)
    }
    return text
  }

  if (options.json === true) {
    try {
      return await send({ ...base, response_format: { type: 'json_object' } })
    } catch (error) {
      // 部分网关不支持 response_format：去掉重试一次，提示词里已要求「只返回 JSON」。
      const message = error instanceof Error ? error.message : String(error)
      if (!/response_format|400|422/i.test(message)) throw error
      return await send(base)
    }
  }
  return await send(base)
}

/** 读取本地图片字节（供视觉调用）。 */
/**
 * 读一张图作为模型输入。
 *
 * 大图必须压：视频网关对 request body 有长度上限（Grok 系超限直接 400
 * `Failed to read request body: length limit exceeded`），而首帧 PNG 常见 2–3MB。
 * 超过 `maxBytes` 时用 ffmpeg 转成 JPEG 并限制长边。
 */
export async function loadImage(
  file: string,
  options: { maxBytes?: number, maxSide?: number, ffmpegPath?: string } = {},
): Promise<ChatImage> {
  const { readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const bytes = new Uint8Array(await readFile(file))
  const lower = file.toLowerCase()
  const mediaType = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : lower.endsWith('.gif')
        ? 'image/gif'
        : 'image/jpeg'

  const limit = options.maxBytes ?? 900_000
  if (bytes.length <= limit) return { bytes, mediaType }

  const maxSide = options.maxSide ?? 1280
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg'
  const outFile = join(tmpdir(), `dvr-shrink-${process.pid}-${Date.now()}.jpg`)
  const ok = await new Promise<boolean>(resolve => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-vf', `scale='min(${maxSide},iw)':-2`, '-q:v', '4', outFile,
    ], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('exit', code => resolve(code === 0))
  })
  try {
    if (!ok) return { bytes, mediaType }
    const small = new Uint8Array(await readFile(outFile))
    return small.length > 0 && small.length < bytes.length ? { bytes: small, mediaType: 'image/jpeg' } : { bytes, mediaType }
  } finally {
    await rm(outFile, { force: true })
    void readdir
  }
}
