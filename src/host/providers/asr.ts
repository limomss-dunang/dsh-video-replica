/**
 * 语音识别（ASR）适配器：把源视频音轨转成带时间戳的口播文稿。
 *
 * 两种协议：
 * - `openai-transcription`：POST {base}/audio/transcriptions（multipart Whisper 协议）
 *   → { text, segments:[{start,end,text}] }；不支持 verbose_json 时退回 json。
 * - `chat-asr`：POST {base}/chat/completions，音频作为 `input_audio` 内容块传入
 *   （小米 MiMo `mimo-v2.5-asr` 就是这个协议）；返回内容是纯文本，没有时间戳，
 *   再按字数比例铺到时间轴上。
 *
 * 选了 openai-transcription 但网关返回 404/405（没有该端点）时，自动改用 chat-asr 重试。
 *
 * ASR 是可选增强：未配置时拆解只用视觉 + 画面文字，界面会明确提示
 * 「口播文稿来自画面识别，建议配置语音识别以提升还原度」。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AsrConfig, TranscriptCue } from '../../shared/types.ts'
import { authHeaders, baseUrlOf, extraParams, joinUrl, requestText } from './http.ts'

export interface AsrRequest {
  config: AsrConfig
  audioFile: string
  durationSec: number
  label: string
  signal?: AbortSignal
}

const MAX_AUDIO_BYTES = 24 * 1024 * 1024

interface RawSegment {
  start?: unknown
  end?: unknown
  text?: unknown
}

function cuesFromSegments(segments: unknown, fallbackText: string, durationSec: number): TranscriptCue[] {
  if (Array.isArray(segments)) {
    const cues: TranscriptCue[] = []
    for (const item of segments) {
      if (item === null || typeof item !== 'object') continue
      const record = item as RawSegment
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (text === '') continue
      const start = Number(record.start)
      const end = Number(record.end)
      cues.push({
        startSec: Number.isFinite(start) ? start : 0,
        endSec: Number.isFinite(end) ? end : (Number.isFinite(start) ? start + 1 : 1),
        text,
      })
    }
    if (cues.length > 0) return cues
  }
  // 无分段信息：按句末标点切句，再按字数比例铺到时间轴上。
  const sentences = fallbackText
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;…])\s*/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '')
  const pieces = sentences.length > 0 ? sentences : [fallbackText.trim()].filter(text => text !== '')
  const totalChars = pieces.reduce((sum, piece) => sum + Math.max(1, Array.from(piece).length), 0)
  const duration = durationSec > 0 ? durationSec : pieces.length * 2
  let cursor = 0
  return pieces.map(text => {
    const share = Math.max(1, Array.from(text).length) / totalChars
    const span = Math.max(0.4, duration * share)
    const cue = { startSec: cursor, endSec: Math.min(duration, cursor + span), text }
    cursor += span
    return cue
  })
}

/** 调用 ASR 接口，返回口播分句。 */
export async function transcribeAudio(request: AsrRequest): Promise<TranscriptCue[]> {
  const { config } = request
  if (config.apiUrl.trim() === '') throw new Error(`${request.label}：未配置语音识别接口地址`)
  if (config.model.trim() === '') throw new Error(`${request.label}：未配置语音识别模型名`)
  const bytes = await readFile(request.audioFile)
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error(`${request.label}：音频过大（${Math.round(bytes.length / 1048576)}MB），上限 ${Math.round(MAX_AUDIO_BYTES / 1048576)}MB`)
  }
  const base = baseUrlOf(config.apiUrl, '/v1')
  const timeoutMs = Math.max(60_000, (config.timeoutSec ?? 300) * 1000)
  const protocol = config.protocol.trim() === '' ? 'openai-transcription' : config.protocol.trim()

  if (protocol === 'chat-asr') {
    return await transcribeViaChat(request, base, timeoutMs)
  }

  const attempt = async (responseFormat: string): Promise<unknown> => {
    const form = new FormData()
    const extension = request.audioFile.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3'
    form.set('file', new Blob([bytes], { type: extension === 'wav' ? 'audio/wav' : 'audio/mpeg' }), `source.${extension}`)
    form.set('model', config.model.trim())
    form.set('response_format', responseFormat)
    if (config.language.trim() !== '') form.set('language', config.language.trim())
    for (const [key, value] of Object.entries(extraParams(config.extraJson))) {
      if (typeof value === 'string' || typeof value === 'number') form.set(key, String(value))
    }
    const response = await fetch(joinUrl(base, '/audio/transcriptions'), {
      method: 'POST',
      headers: authHeaders(config.apiKey),
      body: form,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      signal: request.signal ?? AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${request.label}：HTTP ${response.status} ${text.slice(0, 300)}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      return { text }
    }
  }

  let payload: unknown
  try {
    try {
      payload = await attempt('verbose_json')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 端点不存在 → 说明这家网关用 chat-asr 协议（MiMo 一类），自动切换。
      if (/HTTP (404|405)|Not Found/i.test(message)) {
        return await transcribeViaChat(request, base, timeoutMs)
      }
      if (!/400|422|verbose/i.test(message)) throw error
      payload = await attempt('json')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/HTTP (404|405)|Not Found/i.test(message)) return await transcribeViaChat(request, base, timeoutMs)
    throw error
  }

  const record = payload as { text?: unknown, segments?: unknown }
  const fullText = typeof record.text === 'string' ? record.text : ''
  const cues = cuesFromSegments(record.segments, fullText, request.durationSec)
  if (cues.length === 0) throw new Error(`${request.label}：识别结果为空`)
  return cues
}

/** 从 chat 形态的响应里取文字（兼容 OpenAI 流式分片与普通 JSON）。 */
function chatAsrText(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  // SSE：逐行 data: {...}
  if (trimmed.includes('data:')) {
    let out = ''
    for (const line of trimmed.split(/\r?\n/)) {
      const body = line.startsWith('data:') ? line.slice(5).trim() : ''
      if (body === '' || body === '[DONE]') continue
      try {
        const chunk = JSON.parse(body) as { choices?: Array<{ delta?: { content?: unknown }, message?: { content?: unknown } }> }
        const choice = chunk.choices?.[0]
        const piece = typeof choice?.delta?.content === 'string'
          ? choice.delta.content
          : (typeof choice?.message?.content === 'string' ? choice.message.content : '')
        out += piece
      } catch {
        // 跳过无法解析的分片
      }
    }
    return out
  }
  try {
    const parsed = JSON.parse(trimmed) as { choices?: Array<{ message?: { content?: unknown }, text?: unknown }> }
    const content = parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

/**
 * 「聊天接口做语音识别」：音频以 `input_audio` 内容块提交。
 * 小米 MiMo：`{"model":"mimo-v2.5-asr","messages":[{"role":"user","content":[
 *   {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,..."}}]}],
 *   "asr_options":{"language":"auto"}}`
 */
async function transcribeViaChat(request: AsrRequest, base: string, timeoutMs: number): Promise<TranscriptCue[]> {
  const { config } = request
  const bytes = await readFile(request.audioFile)
  const extension = request.audioFile.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3'
  const mime = extension === 'wav' ? 'audio/wav' : 'audio/mpeg'
  const headers = authHeaders(config.apiKey, { 'content-type': 'application/json' })
  const key = config.apiKey.trim()
  if (key !== '') headers['api-key'] = key

  const response = await requestText(joinUrl(base, '/chat/completions'), {
    method: 'POST',
    headers,
    json: {
      model: config.model.trim(),
      messages: [{
        role: 'user',
        content: [{
          type: 'input_audio',
          input_audio: { data: `data:${mime};base64,${bytes.toString('base64')}` },
        }],
      }],
      asr_options: { language: config.language.trim() === '' ? 'auto' : config.language.trim() },
      ...extraParams(config.extraJson),
    },
    label: `${request.label}（chat-asr）`,
    timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  if (!response.ok) {
    throw new Error(`${request.label}：HTTP ${response.status} ${response.text.slice(0, 300)}`)
  }
  const text = chatAsrText(response.text)
  const cues = cuesFromSegments(undefined, text, request.durationSec)
  if (cues.length === 0) throw new Error(`${request.label}：识别结果为空（${response.text.slice(0, 200)}）`)
  return cues
}

/** 转写结果转纯文本（喂给模型时用）。 */
export function transcriptToText(cues: TranscriptCue[]): string {
  return cues.map(cue => `${cue.startSec.toFixed(1)}-${cue.endSec.toFixed(1)}s ${cue.text}`).join('\n')
}

export function audioBaseName(file: string): string {
  return basename(file)
}
