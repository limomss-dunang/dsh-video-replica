/**
 * 火山豆包语音：TTS（HTTP Chunked 单向流式）与 ASR（WebSocket 大模型流式识别）。
 *
 * 两者都不是 OpenAI 兼容协议，单独适配：
 *
 * - TTS：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *     头：X-Api-Key / X-Api-Resource-Id: seed-tts-2.0 / X-Api-Request-Id
 *     体：{ req_params: { text, speaker, audio_params: { format, sample_rate } } }
 *     响应：HTTP chunked，每个 chunk 是一个 JSON `{code, message, data(base64音频)}`，
 *          末尾 code=20000000 表示结束。
 *
 * - ASR：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream（流式输入模式，适合文件）
 *     头：X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id / X-Api-Connect-Id
 *     WebSocket 二进制帧：4 字节 header + [4 字节 sequence] + 4 字节 payload 长度 + payload。
 *     返回 result.utterances[]，带 start_time/end_time（毫秒）与 text。
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface VolcTtsRequest {
  /** 形如 https://openspeech.bytedance.com（会拼 /api/v3/tts/unidirectional） */
  apiUrl: string
  apiKey: string
  /** X-Api-Resource-Id，默认 seed-tts-2.0 */
  resourceId?: string
  /** speaker 音色 ID */
  voice: string
  text: string
  outFile: string
  label: string
  signal?: AbortSignal
  /** 语速 [-50,100] */
  speechRate?: number
  /** 音量 [-50,100] */
  loudnessRate?: number
}

function volcBase(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('未配置火山语音接口地址')
  // 允许用户填 https://openspeech.bytedance.com 或带 /api/v3 的完整地址
  if (/\/api\/v\d+$/i.test(trimmed)) return trimmed
  return `${trimmed}/api/v3`
}

/** 豆包语音合成：单向流式 HTTP，收完所有 chunk 拼成音频文件。 */
export async function volcSynthesize(request: VolcTtsRequest): Promise<{ file: string, bytes: number, voice?: string }> {
  const base = volcBase(request.apiUrl)
  const resourceId = (request.resourceId ?? '').trim() || 'seed-tts-2.0'
  const speaker = request.voice.trim()
  if (speaker === '') throw new Error(`${request.label}：豆包语音需要填音色 ID（设置 → 配音 → 音色）`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  if (request.signal !== undefined) {
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(`${base}/tts/unidirectional`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Api-Key': request.apiKey.trim(),
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': randomUUID(),
      },
      body: JSON.stringify({
        req_params: {
          text: request.text,
          speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            ...(request.speechRate === undefined ? {} : { speech_rate: request.speechRate }),
            ...(request.loudnessRate === undefined ? {} : { loudness_rate: request.loudnessRate }),
          },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`${request.label}：HTTP ${response.status} ${detail.slice(0, 300)}`)
    }

    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error(`${request.label}：响应没有可读流`)
    const decoder = new TextDecoder()
    let pending = ''
    const pieces: Uint8Array[] = []
    let lastError = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      // 逐个切出完整的 JSON 对象
      for (;;) {
        const start = pending.indexOf('{')
        if (start < 0) break
        let depth = 0
        let inString = false
        let escaped = false
        let end = -1
        for (let index = start; index < pending.length; index += 1) {
          const char = pending[index]
          if (inString) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
            continue
          }
          if (char === '"') inString = true
          else if (char === '{') depth += 1
          else if (char === '}') {
            depth -= 1
            if (depth === 0) { end = index; break }
          }
        }
        if (end < 0) break
        const chunk = pending.slice(start, end + 1)
        pending = pending.slice(end + 1)
        try {
          const parsed = JSON.parse(chunk) as { code?: number, message?: string, data?: string | null }
          if (typeof parsed.data === 'string' && parsed.data !== '') {
            pieces.push(Buffer.from(parsed.data, 'base64'))
          }
          if (typeof parsed.code === 'number' && parsed.code !== 0 && parsed.code !== 20000000) {
            lastError = `${parsed.code} ${parsed.message ?? ''}`.trim()
          }
        } catch {
          // 非 JSON 片段（例如心跳/注释）直接忽略
        }
      }
    }
    if (pieces.length === 0) throw new Error(`${request.label}：豆包语音没有返回音频${lastError === '' ? '' : `（${lastError}）`}`)
    const audio = Buffer.concat(pieces.map(item => Buffer.from(item)))
    await writeFile(request.outFile, audio)
    return { file: request.outFile, bytes: audio.length, voice: speaker }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// ASR（WebSocket 大模型流式识别）
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 0x1
const HEADER_SIZE = 0x1
const MSG_FULL_CLIENT_REQUEST = 0x1
const MSG_AUDIO_ONLY = 0x2
const MSG_FULL_SERVER_RESPONSE = 0x9
const MSG_ERROR = 0xf
const SERIALIZATION_JSON = 0x1
const COMPRESSION_NONE = 0x0
const COMPRESSION_GZIP = 0x1
const FLAG_NO_SEQUENCE = 0x0
const FLAG_POSITIVE_SEQUENCE = 0x1
const FLAG_LAST = 0x2

export function buildHeader(messageType: number, flags: number, serialization: number, compression: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

export function buildFullClientRequest(payload: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = buildHeader(MSG_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_NONE)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(json.length, 0)
  return Buffer.concat([header, size, json])
}

export function buildAudioFrame(pcm: Buffer, sequence: number, last: boolean): Buffer {
  const header = buildHeader(MSG_AUDIO_ONLY, last ? FLAG_LAST : FLAG_POSITIVE_SEQUENCE, SERIALIZATION_JSON, COMPRESSION_NONE)
  const seq = Buffer.alloc(4)
  seq.writeInt32BE(sequence, 0)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(pcm.length, 0)
  return Buffer.concat([header, seq, size, pcm])
}

interface VolcAsrUtterance {
  text?: string
  start_time?: number
  end_time?: number
}

/** 解析服务端返回帧，返回识别到的分句与整段文本。 */
export function parseServerFrame(data: Buffer): { utterances: VolcAsrUtterance[], text: string, error?: string } {
  if (data.length < 4) return { utterances: [], text: '' }
  const messageType = (data[1] >> 4) & 0x0f
  const flags = data[1] & 0x0f
  const compression = data[2] & 0x0f
  let offset = 4
  if (flags === FLAG_POSITIVE_SEQUENCE || flags === FLAG_LAST) offset += 4
  if (data.length < offset + 4) return { utterances: [], text: '' }
  const size = data.readUInt32BE(offset)
  offset += 4
  const payload = data.subarray(offset, offset + size)
  let jsonText = ''
  try {
    jsonText = (compression === COMPRESSION_GZIP ? gunzipSync(payload) : payload).toString('utf8')
  } catch {
    return { utterances: [], text: '' }
  }
  if (messageType === MSG_ERROR) {
    return { utterances: [], text: '', error: jsonText.slice(0, 300) }
  }
  if (messageType !== MSG_FULL_SERVER_RESPONSE) return { utterances: [], text: '' }
  try {
    const parsed = JSON.parse(jsonText) as {
      result?: { text?: string, utterances?: VolcAsrUtterance[] }
      message?: string
      code?: number
    }
    if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 20000000) {
      return { utterances: [], text: '', error: `${parsed.code} ${parsed.message ?? ''}`.trim() }
    }
    return {
      utterances: parsed.result?.utterances ?? [],
      text: (parsed.result?.text ?? '').trim(),
    }
  } catch {
    return { utterances: [], text: '' }
  }
}

export interface VolcAsrRequest {
  apiUrl: string
  apiKey: string
  /** X-Api-Resource-Id，默认 volc.seedasr.sauc.duration（豆包流式识别 2.0 小时版） */
  resourceId: string
  audioFile: string
  durationSec: number
  label: string
  signal?: AbortSignal
}

/** 读 wav 文件，跳过 44 字节头拿 PCM（不是 wav 时按原始字节喂）。 */
function pcmOfWav(bytes: Buffer): Buffer {
  if (bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') {
    return bytes.subarray(44)
  }
  return bytes
}

/** 豆包流式识别：把整段音频推给 WebSocket，收所有分句。 */
export async function volcTranscribe(request: VolcAsrRequest): Promise<Array<{ startSec: number, endSec: number, text: string }>> {
  const bytes = await readFile(request.audioFile)
  const pcm = pcmOfWav(bytes)
  const base = volcBase(request.apiUrl).replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
  const url = `${base}/sauc/bigmodel_nostream`
  const resourceId = request.resourceId.trim() || 'volc.seedasr.sauc.duration'

  const WebSocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (WebSocketImpl === undefined) throw new Error(`${request.label}：当前 Node 版本没有 WebSocket，无法调用豆包流式识别`)

  const socket = new WebSocketImpl(url, {
    // Node 的 WebSocket 支持 headers 选项（undici 实现）
    headers: {
      'X-Api-Key': request.apiKey.trim(),
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Connect-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    } as unknown as Record<string, string>,
  } as unknown as string[])

  const utterances: VolcAsrUtterance[] = []
  let fullText = ''
  let serverError = ''
  let opened = false

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      reject(new Error(`${request.label}：豆包识别超时`))
    }, Math.max(60_000, (request.durationSec + 30) * 1000))

    const finish = (error?: Error): void => {
      clearTimeout(timer)
      try { socket.close() } catch { /* ignore */ }
      if (error !== undefined) reject(error)
      else resolve()
    }

    socket.binaryType = 'arraybuffer'
    socket.onopen = () => {
      opened = true
      try {
        socket.send(buildFullClientRequest({
          user: { uid: 'dsh-video-replica' },
          audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: {
            model_name: 'bigmodel',
            enable_punc: true,
            enable_itn: true,
            show_utterances: true,
            result_type: 'full',
          },
        }))
        // 每包 200ms：16000Hz * 2字节 * 0.2s = 6400 字节
        const CHUNK = 6400
        let sequence = 1
        let offset = 0
        const pump = (): void => {
          if (offset >= pcm.length) {
            socket.send(buildAudioFrame(Buffer.alloc(0), -sequence, true))
            return
          }
          const slice = pcm.subarray(offset, offset + CHUNK)
          offset += CHUNK
          socket.send(buildAudioFrame(Buffer.from(slice), sequence, false))
          sequence += 1
          setTimeout(pump, 60)
        }
        pump()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    socket.onmessage = (event: MessageEvent) => {
      const raw = event.data
      const data = raw instanceof ArrayBuffer ? Buffer.from(new Uint8Array(raw)) : Buffer.from(String(raw))
      const parsed = parseServerFrame(data)
      if (parsed.error !== undefined) serverError = parsed.error
      if (parsed.text !== '') fullText = parsed.text
      if (parsed.utterances.length > 0) {
        utterances.length = 0
        utterances.push(...parsed.utterances)
      }
      const messageType = data.length >= 2 ? (data[1] >> 4) & 0x0f : 0
      const flags = data.length >= 2 ? data[1] & 0x0f : 0
      // 服务端在最后一包（负序号）后结束
      if (messageType === MSG_FULL_SERVER_RESPONSE && flags === FLAG_LAST) {
        setTimeout(() => finish(), 200)
      }
    }
    socket.onerror = () => {
      finish(new Error(`${request.label}：豆包识别连接失败${serverError === '' ? '' : `（${serverError}）`}`))
    }
    socket.onclose = () => {
      if (!opened) finish(new Error(`${request.label}：豆包识别连接被关闭`))
      else setTimeout(() => finish(), 100)
    }
  })

  if (serverError !== '' && utterances.length === 0 && fullText === '') {
    throw new Error(`${request.label}：豆包识别失败（${serverError}）`)
  }

  const cues = utterances
    .map(item => ({
      startSec: Math.max(0, (item.start_time ?? 0) / 1000),
      endSec: Math.max(0, (item.end_time ?? 0) / 1000),
      text: (item.text ?? '').trim(),
    }))
    .filter(item => item.text !== '' && item.endSec > item.startSec)

  if (cues.length > 0) return cues
  if (fullText !== '') return [{ startSec: 0, endSec: Math.max(1, request.durationSec), text: fullText }]
  throw new Error(`${request.label}：豆包识别没有返回文本`)
}
