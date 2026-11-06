/**
 * 分镜视频生成适配器。
 *
 * 支持两种协议族：
 *
 * 1) `ark-seedance` —— 火山方舟 Seedance（参考项目 LeadStageAI 的线上协议）
 *    POST {base}/contents/generations/tasks
 *    {model, content:[{type:'text'},{type:'image_url',image_url:{url},role:'reference_image'}],
 *     ratio, duration, resolution, generate_audio, watermark}
 *    GET  {base}/contents/generations/tasks/{id}  → status / content.video_url
 *
 * 2) `openai-video` —— 通用 OpenAI 风格视频任务
 *    POST {base}/videos（失败自动再试 /videos/generations）
 *    GET  {base}/videos/{id}（再试 /videos/generations/{id} /videos/{id}/content）
 *
 * 两条路径都以「提交 → 轮询 → 下载落盘」的异步语义执行，并对外回传进度。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatImage } from './chat.ts'
import { authHeaders, baseUrlOf, extraParams, joinUrl, requestBuffer, requestJson } from './http.ts'
import { messageOf, sleep } from '../util.ts'

export interface VideoRequest {
  apiUrl: string
  apiKey: string
  model: string
  protocol: string
  extraJson?: string
  timeoutSec?: number
  prompt: string
  /** 参考图（第一张会作为主参考图）。 */
  images?: ChatImage[]
  size: string
  seconds: number
  outFile: string
  pollSec: number
  label: string
  onProgress?: (message: string, progress: number) => void
  signal?: AbortSignal
}

export interface VideoResult {
  file: string
  bytes: number
  taskId?: string
  raw?: string
}

function dataUrl(image: ChatImage): string {
  const mime = image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType
  return `data:${mime};base64,${Buffer.from(image.bytes).toString('base64')}`
}

/** "9:16" 或 "720x1280" → 比例字符串。 */
/**
 * 火山方舟 Seedance 不支持含真人人脸的参考图/首帧（AI 生成的人脸同样被拦）。
 * 把上游的错误码翻译成可操作的说明。
 */
function privacyHint(label: string): string {
  return `${label}：火山方舟判定这张图「可能包含真实人物」（PrivacyInformation）。\n` +
    '方舟只信任三类产物：Seedance 生成的含人脸视频、其尾帧、以及 Seedream 5.0 的**文生图**结果（同账号、30 天内、未压缩）。' +
    '「图生图」产物不在信任名单里，所以「写实人物 + 产品」的参考图首帧会被判疑似真实人物。\n' +
    '可选做法：① 用 Seedream 文生图生成首帧（本插件在 Seedance + 写实画风时已自动改用它）；' +
    '② 首帧画风改成 3D 卡通/国风插画；' +
    '③ 视频模型换成 Grok 系；' +
    '④ 真人素材走火山「人像素材库」登记为 asset://。'
}

export function ratioOf(size: string): string {
  const trimmed = size.trim()
  if (/^\d+:\d+$/.test(trimmed)) return trimmed
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(trimmed)
  if (match === null) return '9:16'
  const width = Number(match[1])
  const height = Number(match[2])
  const known: Array<[string, number]> = [
    ['9:16', 9 / 16],
    ['3:4', 3 / 4],
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['16:9', 16 / 9],
    ['21:9', 21 / 9],
  ]
  const target = width / Math.max(1, height)
  let best = known[0] as [string, number]
  let bestDelta = Number.POSITIVE_INFINITY
  for (const candidate of known) {
    const delta = Math.abs(candidate[1] - target)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best[0]
}

/** 由 size 推导 resolution 档位（ark 只认 480p/720p/1080p）。 */
export function resolutionOf(size: string): string {
  const match = /(\d+)\s*[x×*]\s*(\d+)/i.exec(size)
  if (match === null) return '720p'
  const shortSide = Math.min(Number(match[1]), Number(match[2]))
  if (shortSide >= 1000) return '1080p'
  if (shortSide >= 700) return '720p'
  return '480p'
}

/** 从任意响应体里挖出视频地址。 */
function findVideoUrl(payload: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > 6 || node === null || typeof node !== 'object') return undefined
    if (seen.has(node)) return undefined
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    const record = node as Record<string, unknown>
    for (const key of ['video_url', 'videoUrl', 'url', 'download_url', 'file_url', 'video']) {
      const value = record[key]
      if (typeof value === 'string' && /^https?:\/\//.test(value) && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(value)) {
        return value
      }
    }
    for (const value of Object.values(record)) {
      const found = walk(value, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(payload, 0)
}

function findTaskId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  for (const key of ['id', 'task_id', 'taskId', 'video_id', 'videoId', 'request_id']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const data = record.data
  if (data !== null && typeof data === 'object') {
    const nested = data as Record<string, unknown>
    for (const key of ['id', 'task_id', 'video_id']) {
      const value = nested[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

function statusOf(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const candidates = [record.status, (record.data as Record<string, unknown> | undefined)?.status]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate.toLowerCase()
  }
  return ''
}

/**
 * 提交一次视频生成任务并等待完成、下载到 outFile。
 */
export async function generateVideo(request: VideoRequest): Promise<VideoResult> {
  if (request.apiUrl.trim() === '') throw new Error(`${request.label}：未配置视频接口地址（设置 → 视频复刻）`)
  if (request.model.trim() === '') throw new Error(`${request.label}：未配置视频模型名（设置 → 视频复刻）`)
  const base = baseUrlOf(request.apiUrl, '/v1')
  const headers = authHeaders(request.apiKey, { 'content-type': 'application/json' })
  const timeoutMs = Math.max(60_000, (request.timeoutSec ?? 900) * 1000)
  const protocol = request.protocol.trim() === '' ? 'openai-video' : request.protocol.trim()

  let submitUrl: string
  let submitBody: Record<string, unknown>
  const images = request.images ?? []

  if (protocol === 'ark-seedance') {
    submitUrl = joinUrl(base, '/contents/generations/tasks')
    submitBody = {
      model: request.model.trim(),
      content: [
        { type: 'text', text: request.prompt },
        ...images.slice(0, 3).map((image, index) => ({
          type: 'image_url',
          image_url: { url: dataUrl(image) },
          role: index === 0 ? 'reference_image' : 'reference_image',
        })),
      ],
      ratio: ratioOf(request.size),
      duration: Math.round(Math.min(15, Math.max(2, request.seconds))),
      resolution: resolutionOf(request.size),
      generate_audio: true,
      watermark: false,
      ...extraParams(request.extraJson),
    }
  } else if (/grok|imagine/i.test(request.model)) {
    // xAI Grok Imagine 系网关：用参考实现验证过的最小字段集（多塞别名会被判内部错误）。
    const seconds = Math.round(Math.min(30, Math.max(2, request.seconds)))
    submitUrl = joinUrl(base, '/videos')
    submitBody = {
      model: request.model.trim(),
      prompt: request.prompt,
      duration: seconds,
      size: request.size.trim() === '' ? '720x1280' : request.size.trim(),
      ...(images[0] === undefined ? {} : { image: dataUrl(images[0]) }),
      ...extraParams(request.extraJson),
    }
  } else {
    // 通用 OpenAI 风格视频接口没有统一字段，这里一次带上各网关的常见别名：
    // 多余的字段通常会被忽略，比"猜错字段导致 400"更划算。
    // 参考字段组合来自 dsh-media-gen 在 Grok / Agnes 一类网关上的实测可用形态。
    const seconds = Math.round(Math.min(30, Math.max(2, request.seconds)))
    const size = request.size.trim() === '' ? '720x1280' : request.size.trim()
    const sizeMatch = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size)
    // Agnes 一类网关用 num_frames + frame_rate，且要求 8n+1。
    const frames = (() => {
      const raw = Math.min(441, Math.max(9, Math.round(seconds * 24)))
      return Math.floor((raw - 1) / 8) * 8 + 1
    })()
    submitUrl = joinUrl(base, '/videos')
    submitBody = {
      model: request.model.trim(),
      prompt: request.prompt,
      n: 1,
      size,
      ...(sizeMatch === null ? {} : { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) }),
      seconds,
      duration: seconds,
      frame_rate: 24,
      num_frames: frames,
      ...(images[0] === undefined
        ? {}
        : { image: dataUrl(images[0]), input_reference: dataUrl(images[0]) }),
      ...extraParams(request.extraJson),
    }
  }

  request.onProgress?.('提交生成任务…', 0.05)
  let submitted: unknown
  try {
    submitted = await requestJson(submitUrl, {
      method: 'POST',
      headers,
      json: submitBody,
      label: `${request.label}（提交）`,
      timeoutMs: Math.min(timeoutMs, 180_000),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (/PrivacyInformation|may contain real person|real person/i.test(messageOf(error))) {
      throw new Error(privacyHint(request.label))
    }
    if (protocol === 'ark-seedance') throw error
    // 通用网关：/videos 不存在时再试 /videos/generations。
    try {
      submitted = await requestJson(joinUrl(base, '/videos/generations'), {
        method: 'POST',
        headers,
        json: submitBody,
        label: `${request.label}（提交 /videos/generations）`,
        timeoutMs: Math.min(timeoutMs, 180_000),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (fallbackError) {
      const first = messageOf(error)
      if (/PrivacyInformation|may contain real person|real person/i.test(first)) {
        throw new Error(privacyHint(request.label))
      }
      // 上游临时不可用是最常见的：把「稍后重试」直接写进错误，别让用户以为是配置问题。
      const hint = /503|service_unavailable|暂时不可用/i.test(`${first}${messageOf(fallbackError)}`)
        ? '（上游视频生成服务暂时不可用，请稍后点「重新生成」重试）'
        : ''
      throw new Error(
        `${request.label}：提交生成任务失败${hint}。` +
        `POST /videos → ${first.slice(0, 300)}；` +
        `POST /videos/generations → ${messageOf(fallbackError).slice(0, 200)}`,
      )
    }
  }

  const directUrl = findVideoUrl(submitted)
  const taskId = findTaskId(submitted)
  request.onProgress?.('任务已提交，等待生成…', 0.15)
  if (directUrl !== undefined) {
    await downloadTo(directUrl, request, headers)
    return { file: request.outFile, bytes: 0, ...(taskId === undefined ? {} : { taskId }) }
  }
  if (taskId === undefined) {
    throw new Error(`${request.label}：网关没有返回任务 id，也没有视频地址（${JSON.stringify(submitted).slice(0, 400)}）`)
  }

  const started = Date.now()
  const pollInterval = Math.max(1, request.pollSec) * 1000
  const statusUrls = protocol === 'ark-seedance'
    ? [joinUrl(base, `/contents/generations/tasks/${encodeURIComponent(taskId)}`)]
    : [
        joinUrl(base, `/videos/${encodeURIComponent(taskId)}`),
        joinUrl(base, `/videos/generations/${encodeURIComponent(taskId)}`),
      ]

  const pollOnce = async (): Promise<unknown> => {
    let lastError: unknown
    for (const url of statusUrls) {
      try {
        return await requestJson(url, {
          method: 'GET',
          headers,
          label: `${request.label}（轮询）`,
          timeoutMs: 60_000,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error(`${request.label}：轮询失败`)
  }

  let last: unknown = submitted
  for (;;) {
    if (request.signal?.aborted) throw new Error(`${request.label}：已取消`)
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${request.label}：等待超时（${Math.round(timeoutMs / 60000)} 分钟）；任务 ${taskId} 可能仍在生成`)
    }
    await sleep(pollInterval)
    let payload: unknown
    try {
      payload = await pollOnce()
    } catch (error) {
      // 轮询网络抖动不致命，继续等；连续失败由总超时兜底。
      last = { pollError: messageOf(error) }
      continue
    }
    last = payload
    const status = statusOf(payload)
    const elapsed = Date.now() - started
    const progress = Math.min(0.92, 0.15 + (elapsed / timeoutMs) * 0.75)
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled' || status === 'expired') {
      const detail = JSON.stringify(payload)
      const reason = /"(?:message|error|error_message|reason)"\s*:\s*"([^"]{0,300})"/.exec(detail)?.[1] ?? ''
      // 火山对「输出」还会做版权/敏感判定，这类拦截是随机的，重试通常能过。
      const hint = /PolicyViolation|copyright restrictions|SensitiveContentDetected/i.test(detail)
        ? '（上游判定输出可能涉及版权或敏感内容，这是随机拦截，点「重新生成」通常能过）'
        : ''
      throw new Error(`${request.label}：生成失败${hint}${reason === '' ? '' : `（${reason}）`}：${detail.slice(0, 400)}`)
    }
    if (status === 'completed' || status === 'succeeded' || status === 'success' || status === 'done') {
      // 有些网关（Grok Imagine 一类）状态里永远不给地址，成品只在
      // GET /videos/{id}/content；而且刚 completed 时 CDN 可能还没就绪，
      // 所以这里重试几轮，并在轮询之间刷新任务（地址可能被换过）。
      let current = payload
      let lastError = ''
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const url = findVideoUrl(current)
        if (url !== undefined) {
          await downloadTo(url, request, headers)
          return { file: request.outFile, bytes: 0, taskId, raw: JSON.stringify(current).slice(0, 2000) }
        }
        try {
          const content = await tryContentDownload(taskId, request, headers)
          if (content !== undefined && content > 0) {
            return { file: request.outFile, bytes: content, taskId, raw: JSON.stringify(current).slice(0, 2000) }
          }
        } catch (error) {
          lastError = messageOf(error)
        }
        if (attempt >= 5) break
        request.onProgress?.(`任务已完成，等待成品就绪（第 ${attempt + 1} 次重试）…`, 0.96)
        await sleep(Math.min(20_000, 3_000 * (attempt + 1)))
        const refreshed = await pollOnce()
        if (refreshed !== undefined) current = refreshed
      }
      throw new Error(
        `${request.label}：任务已完成但没有取到视频文件（任务 ${taskId}）` +
        `${lastError === '' ? '' : `；最后一次错误：${lastError.slice(0, 300)}`}。` +
        '可稍后用「重新生成」重试，任务本身可能仍然可用。',
      )
    }
    request.onProgress?.(`生成中（${status === '' ? '处理中' : status}，已等待 ${Math.round(elapsed / 1000)}s）`, progress)
  }

  // eslint-disable-next-line no-unreachable
  throw new Error(`${request.label}：未取得视频（${JSON.stringify(last).slice(0, 300)}）`)
}

async function downloadTo(url: string, request: VideoRequest, headers: Record<string, string>): Promise<number> {
  request.onProgress?.('下载视频…', 0.95)
  const { bytes } = await requestBuffer(url, {
    method: 'GET',
    headers: { ...headers, accept: 'video/*' },
    label: `${request.label}（下载）`,
    timeoutMs: 600_000,
    retries: 2,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  if (bytes.length < 1024) throw new Error(`${request.label}：下载到的视频过小（${bytes.length} 字节）`)
  await mkdir(dirname(request.outFile), { recursive: true })
  await writeFile(request.outFile, bytes)
  return bytes.length
}

async function tryContentDownload(taskId: string, request: VideoRequest, headers: Record<string, string>): Promise<number | undefined> {
  const base = baseUrlOf(request.apiUrl, '/v1')
  for (const suffix of [`/videos/${encodeURIComponent(taskId)}/content`, `/videos/generations/${encodeURIComponent(taskId)}/content`]) {
    try {
      const { bytes, contentType } = await requestBuffer(joinUrl(base, suffix), {
        method: 'GET',
        headers: { ...headers, accept: 'video/*' },
        label: `${request.label}（取成品）`,
        timeoutMs: 300_000,
        retries: 0,
      })
      if (!contentType.startsWith('video/') && bytes.length < 4096) continue
      await mkdir(dirname(request.outFile), { recursive: true })
  await writeFile(request.outFile, bytes)
      return bytes.length
    } catch {
      // 换下一个候选路径
    }
  }
  return undefined
}
