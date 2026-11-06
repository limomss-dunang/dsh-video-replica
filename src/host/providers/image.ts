/**
 * 参考图生成适配器（产品融入分镜的关键一步）。
 *
 * 协议：
 * - `openai-images`（默认）：POST {base}/images/generations
 *     body {model, prompt, size, n:1, response_format:'url', ...(参考图 ? {image:[dataURL]} : {})}
 *   带参考图时若网关不支持 JSON `image` 数组，自动改走 /images/edits（multipart）。
 *   兼容火山方舟 Seedream、OpenAI gpt-image 系、以及多数第三方聚合网关。
 *
 * 结果可能是 b64_json 也可能是 url，两种都落地成文件。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatImage } from './chat.ts'
import { authHeaders, baseUrlOf, extraParams, joinUrl, requestBuffer, requestJson } from './http.ts'

export interface ImageRequest {
  apiUrl: string
  apiKey: string
  model: string
  protocol: string
  extraJson?: string
  timeoutSec?: number
  prompt: string
  /** 产品参考图（图生图时传入）。 */
  images?: ChatImage[]
  /** 期望画幅，如 9:16 / 1:1；留空用 9:16。 */
  aspect?: string
  /** 源片宽高（用于把 1080x1080 这类比例归一到标准宽高比）。 */
  width?: number
  height?: number
  outFile: string
  label: string
  signal?: AbortSignal
}

function dataUrl(image: ChatImage): string {
  const mime = image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType
  return `data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`
}

/**
 * 尺寸映射：不同网关对 size 的要求差异很大，这里按「模型名 + 画幅」给保守值。
 * - Seedream（方舟）要求像素总量 ≥ 3,686,400，故用 2K 档；
 * - 其余 OpenAI 兼容网关用常见的 1024 档。
 */
/**
 * 火山方舟 Seedream 官方支持的 2K 尺寸表（按宽高比）。
 * pro/flash 与 lite/4.5 的表略有不同，用错会 400。
 */
const ARK_SEEDREAM_SIZES: Record<'pro' | 'lite', Record<string, string>> = {
  pro: { '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368', '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
  lite: { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
}

/** 把任意 aspect 归一到最近的标准宽高比。 */
function normalizeAspect(aspect: string, width = 0, height = 0): string {
  const raw = (aspect ?? '').trim()
  if (raw !== '' && raw !== 'auto') {
    const match = /^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/.exec(raw)
    if (match !== null) {
      const w = Number(match[1])
      const h = Number(match[2])
      if (w > 0 && h > 0) return closestAspect(w / h)
    }
  }
  if (width > 0 && height > 0) return closestAspect(width / height)
  return '9:16'
}

const ASPECT_RATIOS: Array<[string, number]> = [
  ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16],
  ['3:2', 1.5], ['2:3', 2 / 3], ['21:9', 21 / 9],
]

function closestAspect(ratio: number): string {
  let best = ASPECT_RATIOS[0] as [string, number]
  for (const entry of ASPECT_RATIOS) {
    if (Math.abs(Math.log(entry[1] / ratio)) < Math.abs(Math.log(best[1] / ratio))) best = entry
  }
  return best[0]
}

export function imageSizeFor(model: string, aspect: string, width = 0, height = 0): string {
  const key = normalizeAspect(aspect, width, height)
  if (/seedream/i.test(model)) {
    // 火山 Seedance 系列（pro/flash 与 lite/4.5）各自的 2K 尺寸表。
    const family = /seedream-5-0-(pro|flash)/i.test(model) ? 'pro' : 'lite'
    const table = ARK_SEEDREAM_SIZES[family]
    return table[key] ?? (family === 'pro' ? '1584x2816' : '1600x2848')
  }
  if (key === '1:1') return '1024x1024'
  if (key === '16:9' || key === '21:9' || key === '3:2' || key === '4:3') return '1536x1024'
  return '1024x1536'
}

interface ImageOutcome {
  bytes?: Uint8Array
  url?: string
}

function extractImage(payload: unknown): ImageOutcome | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.images) ? record.images : undefined
  const first = list?.[0]
  if (first !== undefined) {
    if (typeof first === 'string' && first.startsWith('http')) return { url: first }
    if (first !== null && typeof first === 'object') {
      const item = first as Record<string, unknown>
      if (typeof item.b64_json === 'string' && item.b64_json !== '') {
        return { bytes: new Uint8Array(Buffer.from(item.b64_json, 'base64')) }
      }
      for (const key of ['url', 'image_url', 'imageUrl']) {
        const value = item[key]
        if (typeof value === 'string' && value.startsWith('http')) return { url: value }
      }
    }
  }
  // 少数网关直接给顶层 url / image
  for (const key of ['url', 'image_url', 'imageUrl']) {
    const value = record[key]
    if (typeof value === 'string' && value.startsWith('http')) return { url: value }
  }
  if (typeof record.b64_json === 'string') return { bytes: new Uint8Array(Buffer.from(record.b64_json, 'base64')) }
  return undefined
}

async function saveOutcome(outcome: ImageOutcome, outFile: string, apiKey: string, label: string): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true })
  if (outcome.bytes !== undefined && outcome.bytes.length > 512) {
    await writeFile(outFile, outcome.bytes)
    return
  }
  if (outcome.url !== undefined) {
    const { bytes } = await requestBuffer(outcome.url, {
      method: 'GET',
      headers: { ...authHeaders(apiKey), accept: 'image/*' },
      label: `${label}（下载图片）`,
      timeoutMs: 180_000,
      retries: 1,
    })
    if (bytes.length < 512) throw new Error(`${label}：下载到的图片过小（${bytes.length} 字节）`)
    await writeFile(outFile, bytes)
    return
  }
  throw new Error(`${label}：响应里没有图片数据`)
}

/** 生成一张参考图并落盘。 */
export async function generateImage(request: ImageRequest): Promise<{ file: string, bytes: number }> {
  if (request.apiUrl.trim() === '') throw new Error(`${request.label}：未配置图片接口地址（设置 → 视频复刻）`)
  if (request.model.trim() === '') throw new Error(`${request.label}：未配置图片模型名（设置 → 视频复刻）`)
  const base = baseUrlOf(request.apiUrl, '/v1')
  const headers = authHeaders(request.apiKey, { 'content-type': 'application/json' })
  const timeoutMs = Math.max(60_000, (request.timeoutSec ?? 180) * 1000)
  const size = imageSizeFor(request.model, request.aspect ?? '', request.width ?? 0, request.height ?? 0)
  const images = request.images ?? []

  const body: Record<string, unknown> = {
    model: request.model.trim(),
    prompt: request.prompt,
    n: 1,
    size,
    // 优先要 b64：不少网关把返回的 URL 做成需要鉴权的受保护地址，直接下载会 401。
    response_format: 'b64_json',
    ...(/seedream/i.test(request.model)
      ? { sequential_image_generation: 'disabled', stream: false, watermark: false, output_format: 'jpeg' }
      : {}),
    ...(images.length === 0 ? {} : { image: images.slice(0, 3).map(image => dataUrl(image)) }),
    ...extraParams(request.extraJson),
  }

  /** 发一次 generations；response_format 被拒时自动去掉重试一次。 */
  const generate = async (): Promise<unknown> => {
    const send = async (withFormat: boolean): Promise<unknown> => await requestJson(joinUrl(base, '/images/generations'), {
      method: 'POST',
      headers,
      json: withFormat ? body : Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'response_format')),
      label: request.label,
      timeoutMs,
      // 上游生图偶发 502/503：多给两次机会（退避由 http 层处理）。
      retries: 2,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    try {
      return await send(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 只对「参数不被接受」重试，其它错误（鉴权/额度/超时）原样抛出。
      if (!/response_format|unknown parameter|unsupported|invalid.*parameter/i.test(message)) throw error
      return await send(false)
    }
  }

  try {
    const payload = await generate()
    const outcome = extractImage(payload)
    if (outcome === undefined) {
      throw new Error(`${request.label}：响应里没有图片（${JSON.stringify(payload).slice(0, 400)}）`)
    }
    await saveOutcome(outcome, request.outFile, request.apiKey, request.label)
    return { file: request.outFile, bytes: outcome.bytes?.length ?? 0 }
  } catch (error) {
    // 带参考图 + JSON image 数组被拒时，改走 /images/edits（multipart）。
    if (images.length === 0) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (!/400|422|image|invalid|unsupported/i.test(message)) throw error
    const form = new FormData()
    form.set('model', request.model.trim())
    form.set('prompt', request.prompt)
    form.set('n', '1')
    form.set('size', size)
    images.slice(0, 3).forEach((image, index) => {
      const extension = image.mediaType.includes('png') ? 'png' : 'jpg'
      form.append('image', new Blob([image.bytes], { type: image.mediaType }), `reference-${index + 1}.${extension}`)
    })
    const response = await requestBuffer(joinUrl(base, '/images/edits'), {
      method: 'POST',
      headers: authHeaders(request.apiKey),
      body: form,
      label: `${request.label}（edits）`,
      timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    // edits 可能直接回二进制图片，也可能回 JSON。
    const contentType = response.contentType.toLowerCase()
    if (contentType.startsWith('image/')) {
      await writeFile(request.outFile, response.bytes)
      return { file: request.outFile, bytes: response.bytes.length }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(response.bytes).toString('utf8'))
    } catch {
      throw error
    }
    const outcome = extractImage(parsed)
    if (outcome === undefined) throw error
    await saveOutcome(outcome, request.outFile, request.apiKey, request.label)
    return { file: request.outFile, bytes: outcome.bytes?.length ?? 0 }
  }
}
