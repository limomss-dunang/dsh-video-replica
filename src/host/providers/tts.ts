/**
 * 配音（TTS）适配器。两种协议：
 *
 * - `openai-tts`（默认）：POST {base}/audio/speech
 *     {model, input, voice, response_format:'mp3', speed} → 音频二进制
 *   兼容 OpenAI TTS、以及多数透传该接口的聚合网关。
 * - `chat-tts`：小米 MiMo 那类「聊天接口返回音频」的形态
 *     POST {base}/chat/completions
 *     {model, messages:[...], audio:{format:'wav', voice}}
 *     → choices[0].message.audio.data（base64 WAV）
 */

import { writeFile } from 'node:fs/promises'
import type { TtsConfig } from '../../shared/types.ts'
import { authHeaders, baseUrlOf, extraParams, joinUrl, requestBuffer, requestJson } from './http.ts'

export interface TtsRequest {
  config: TtsConfig
  text: string
  outFile: string
  label: string
  signal?: AbortSignal
  /** 语气/情绪风格指令（自然语言）。MiMo 一类模型用它控制情绪与语速。 */
  style?: string
}

function chatAudioOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as { choices?: Array<{ message?: Record<string, unknown> }> }
  const message = record.choices?.[0]?.message
  if (message === undefined) return undefined
  const audio = message.audio
  if (audio !== null && typeof audio === 'object' && typeof (audio as { data?: unknown }).data === 'string') {
    return (audio as { data: string }).data
  }
  const content = message.content
  if (typeof content === 'string' && /^[A-Za-z0-9+/=\s]{200,}$/.test(content.slice(0, 400))) return content
  return undefined
}

/** 合成一段配音并写入 outFile。 */
export async function synthesizeSpeech(request: TtsRequest): Promise<{ file: string, bytes: number, voice?: string }> {
  const { config } = request
  if (config.apiUrl.trim() === '') throw new Error(`${request.label}：未配置配音接口地址（设置 → 视频复刻）`)
  if (config.model.trim() === '') throw new Error(`${request.label}：未配置配音模型名（设置 → 视频复刻）`)
  const base = baseUrlOf(config.apiUrl, '/v1')
  const timeoutMs = Math.max(30_000, (config.timeoutSec ?? 180) * 1000)
  const text = request.text.trim()
  if (text === '') throw new Error(`${request.label}：配音文本为空`)
  const protocol = config.protocol.trim() === '' ? 'openai-tts' : config.protocol.trim()

  if (protocol === 'chat-tts' || protocol === 'chat') {
    const headers = authHeaders(config.apiKey, { 'content-type': 'application/json' })
    const key = config.apiKey.trim()
    if (key !== '') headers['api-key'] = key
    const payload = await requestJson(joinUrl(base, '/chat/completions'), {
      method: 'POST',
      headers,
      json: {
        model: config.model.trim(),
        messages: [
          {
            role: 'user',
            content: request.style !== undefined && request.style.trim() !== ''
              ? request.style.trim()
              : '请用自然流畅、像短视频口播一样的语气朗读下面的文本。',
          },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: config.voice.trim() === '' ? 'default' : config.voice.trim() },
        ...extraParams(config.extraJson),
      },
      label: request.label,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const data = chatAudioOf(payload)
    if (data === undefined) throw new Error(`${request.label}：响应里没有音频数据（${JSON.stringify(payload).slice(0, 400)}）`)
    const bytes = new Uint8Array(Buffer.from(data, 'base64'))
    if (bytes.length < 512) throw new Error(`${request.label}：音频数据过小（${bytes.length} 字节）`)
    await writeFile(request.outFile, bytes)
    return { file: request.outFile, bytes: bytes.length }
  }

  // 先按 OpenAI 的 /audio/speech 发；网关没有这个端点时（404/405），
  // 自动退到「聊天接口返回音频」的形态（MiMo 一类）。
  try {
    const response = await requestBuffer(joinUrl(base, '/audio/speech'), {
      method: 'POST',
      headers: authHeaders(config.apiKey, { 'content-type': 'application/json' }),
      json: {
        model: config.model.trim(),
        input: text,
        voice: config.voice.trim() === '' ? 'alloy' : config.voice.trim(),
        response_format: 'mp3',
        speed: config.speed,
        ...(request.style !== undefined && request.style.trim() !== '' ? { instruction: request.style.trim() } : {}),
        ...extraParams(config.extraJson),
      },
      label: request.label,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (response.bytes.length < 512) {
      throw new Error(`${request.label}：音频数据过小（${response.bytes.length} 字节）`)
    }
    await writeFile(request.outFile, response.bytes)
    return { file: request.outFile, bytes: response.bytes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (404|405|501)/.test(message)) throw error
    return await chatSpeech({
      ...request,
      config: { ...config, protocol: 'chat-tts' },
    })
  }
}

/**
 * 「聊天接口返回音频」形态的配音（MiMo 等）。
 *
 * 网关对音色校验很严，填错会返回 400 并列出可用音色；这里解析该列表，
 * 自动挑一个（优先 mimo_default）重试，避免用户为了一个音色名卡住。
 */
async function chatSpeech(request: TtsRequest): Promise<{ file: string, bytes: number, voice?: string }> {
  const { config } = request
  const base = baseUrlOf(config.apiUrl, '/v1')
  const headers = authHeaders(config.apiKey, { 'content-type': 'application/json' })
  const key = config.apiKey.trim()
  if (key !== '') headers['api-key'] = key
  const timeoutMs = Math.max(30_000, (config.timeoutSec ?? 180) * 1000)

  const attempt = async (voice: string): Promise<{ file: string, bytes: number, voice: string }> => {
    const payload = await requestJson(joinUrl(base, '/chat/completions'), {
      method: 'POST',
      headers,
      json: {
        model: config.model.trim(),
        messages: [
          { role: 'user', content: '请用自然流畅的语调朗读以下文本。' },
          { role: 'assistant', content: request.text.trim() },
        ],
        audio: { format: 'wav', voice },
        ...extraParams(config.extraJson),
      },
      label: `${request.label}（chat-tts）`,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const data = chatAudioOf(payload)
    if (data === undefined) throw new Error(`${request.label}：响应里没有音频数据（${JSON.stringify(payload).slice(0, 400)}）`)
    const bytes = new Uint8Array(Buffer.from(data, 'base64'))
    if (bytes.length < 512) throw new Error(`${request.label}：音频数据过小（${bytes.length} 字节）`)
    await writeFile(request.outFile, bytes)
    return { file: request.outFile, bytes: bytes.length, voice }
  }

  const preferred = config.voice.trim() === '' ? 'mimo_default' : config.voice.trim()
  try {
    return await attempt(preferred)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const listed = /Available voices:\s*\[([^\]]+)\]/.exec(message)
    if (listed === null) throw error
    const voices = listed[1].split(',').map(item => item.trim()).filter(item => item !== '')
    const fallback = voices.find(item => /^mimo_default$/i.test(item)) ?? voices[0]
    if (fallback === undefined || fallback === preferred) throw error
    return await attempt(fallback)
  }
}
