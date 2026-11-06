/**
 * 分享链接解析与下载。
 *
 * 平台识别是本地正则（不联网）：抖音 / 小红书 / 视频号 / 快手 / B站 / 直链。
 * 真正的解析走三条路，按 parser.mode 决定顺序：
 *
 * 1. `api`    —— 第三方解析服务（HoxHox / RedFox / 兼容网关）。响应体形状自动识别：
 *                - HoxHox：`{success:true, data|root:{platform, mediaType, videoUrl,...}}`
 *                - RedFox：`{code:"200", data:{platform:"dy", videoUrl,...}}`
 *                - 通用：递归找 `*.mp4` 地址 + title/author/duration 常见字段
 *                也支持用户用 `videoUrlPath` 指定点路径。
 * 2. `ytdlp`  —— 本机 yt-dlp 直接抓（抖音/TikTok/B站/YouTube 等受支持站点）。
 * 3. `direct` —— URL 本身就是视频文件地址。
 *
 * 视频号（channels.weixin.qq.com）需要微信登录态/签名，任何纯 HTTP 解析都不稳；
 * 界面会明确引导「用解析服务，或下载后本地视频上传」。
 */

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ParserConfig, Platform } from '../../shared/types.ts'
import { downloadFile, probeMedia, runCommand, toolAvailable } from '../media.ts'
import { asNumber, asRecord, asString, messageOf } from '../util.ts'
import { authHeaders, baseUrlOf, extraParams, joinUrl, requestJson } from './http.ts'

/** 从一段文案里抠出第一个链接。 */
export function extractUrl(input: string): string | undefined {
  const text = input.trim()
  if (text === '') return undefined
  const match = /https?:\/\/[^\s一-\u9fff\uff00-\uffef]+/u.exec(text)
  if (match !== null) return match[0].replace(/[,.;!?)\]>"']+$/g, '')
  // 用户可能只贴了 "v.douyin.com/xxxx"
  const bare = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+$/i.exec(text)
  if (bare !== null) return `https://${bare[0]}`
  return undefined
}

export function detectPlatform(url: string): Platform {
  let host = ''
  try {
    host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return 'other'
  }
  if (/douyin\.com$|iesdouyin\.com$/.test(host)) return 'douyin'
  if (/xiaohongshu\.com$|xhslink\.com$/.test(host)) return 'xiaohongshu'
  if (/channels\.weixin\.qq\.com$|finder\.video\.qq\.com$|weixin\.qq\.com$/.test(host)) return 'channels'
  if (/kuaishou\.com$|chenzhongtech\.com$/.test(host)) return 'kuaishou'
  if (/bilibili\.com$|b23\.tv$/.test(host)) return 'bilibili'
  if (/\.(mp4|mov|m4v|webm|flv|mkv)$/i.test(new URL(url).pathname)) return 'direct'
  return 'other'
}

const EXTENSION_RE = /\.(mp4|mov|m4v|webm|flv|mkv)$/i

export function looksLikeDirectVideo(url: string): boolean {
  try {
    return EXTENSION_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

export interface ParsedLink {
  platform: Platform
  provider: 'api' | 'ytdlp' | 'direct'
  videoUrl: string
  /** 解析服务给的备用地址（主地址下载失败时再试）。 */
  videoUrlBackup?: string
  title: string
  author?: string
  durationSec?: number
  coverUrl?: string
  raw?: string
  /** 实际成功的解析接口域名（日志里说清楚是哪家解析的）。 */
  endpoint?: string
  /** 切换过程中被跳过的接口及其失败原因（主接口挂了要让人知道）。 */
  skipped?: string[]
}

/** 递归找视频直链（只在明确的视频字段/后缀上命中，避免抓到封面图）。 */
function findVideoUrl(node: unknown, depth = 0): string | undefined {
  if (depth > 6 || node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  for (const key of ['videoUrl', 'video_url', 'directVideoUrl', 'videoUrlBackup', 'playUrl', 'play_url', 'url', 'mp4', 'video']) {
    const value = record[key]
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      if (EXTENSION_RE.test(value.split('?')[0] ?? '') || /video|play|mp4/i.test(value)) return value
    }
    if (value !== null && typeof value === 'object') {
      const nested = findVideoUrl(value, depth + 1)
      if (nested !== undefined) return nested
    }
  }
  for (const value of Object.values(record)) {
    if (value === null || typeof value !== 'object') continue
    const nested = findVideoUrl(value, depth + 1)
    if (nested !== undefined) return nested
  }
  return undefined
}

/** 按点路径取值：`data.videoUrl`。 */
function pickPath(node: unknown, path: string): unknown {
  const parts = path.split('.').map(part => part.trim()).filter(part => part !== '')
  let current: unknown = node
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function textAt(node: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4 || node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number') return String(value)
    if (value !== null && typeof value === 'object') {
      const name = asString((value as Record<string, unknown>).name).trim()
        || asString((value as Record<string, unknown>).nickname).trim()
      if (name !== '') return name
    }
  }
  return undefined
}

function mapPlatformCode(code: string, fallback: Platform): Platform {
  const value = code.trim().toLowerCase()
  if (['dy', 'douyin', 'aweme'].includes(value)) return 'douyin'
  if (['xhs', 'xhsw', 'xiaohongshu', 'redbook'].includes(value)) return 'xiaohongshu'
  if (['shipinhao', 'wechat', 'channels', 'sph', 'wxsph'].includes(value)) return 'channels'
  if (['ks', 'kuaishou', 'kwai'].includes(value)) return 'kuaishou'
  if (['bili', 'bilibili'].includes(value)) return 'bilibili'
  return fallback
}

/** 解析接口返回体 → 统一结构（兼容 HoxHox / RedFox / 通用网关）。 */
export function interpretParseResponse(payload: unknown, fallbackPlatform: Platform, videoUrlPath = ''): ParsedLink {
  const root = asRecord(payload)
  const data = asRecord(root.data !== undefined ? root.data : root)

  // 成功判定：HoxHox 用 success，RedFox 用 code 前缀 2，其它有 data 就认。
  const successFlag = root.success
  if (successFlag === false) {
    const message = textAt(root, ['msg', 'message', 'error', 'errorMessage']) ?? '解析接口返回失败'
    throw new Error(message)
  }
  const code = root.code
  if (typeof code === 'string' || typeof code === 'number') {
    const codeText = String(code)
    const ok = /^2/.test(codeText) || codeText === '0' || codeText.toLowerCase() === 'ok'
    if (!ok) {
      const message = textAt(root, ['msg', 'message', 'error']) ?? `解析接口返回 code=${codeText}`
      if (codeText === '3106' || codeText === '3107') throw new Error(`解析接口鉴权失败（code=${codeText}），请检查 API Key`)
      throw new Error(message)
    }
  }

  // 图集/非视频：明确报错，避免下载到一堆图片。
  const mediaType = Number(asNumber(root.mediaType ?? data.mediaType, 0))
  const awemeType = asString(root.awemeType ?? data.awemeType).toLowerCase()
  if (mediaType !== 0 && mediaType !== 4) {
    throw new Error(`该链接是图文/图集（mediaType=${mediaType}），当前只支持视频复刻`)
  }
  if (awemeType !== '' && awemeType !== 'video') {
    throw new Error(`该链接类型是「${awemeType}」，当前只支持视频复刻`)
  }

  const videoUrl = videoUrlPath.trim() === ''
    ? findVideoUrl(data) ?? findVideoUrl(root)
    : asString(pickPath(payload, videoUrlPath)).trim()
  if (videoUrl === undefined || videoUrl === '') {
    throw new Error(`解析接口没有返回视频地址（响应前 300 字：${JSON.stringify(payload).slice(0, 300)}）`)
  }

  const platformCode = asString(root.platform ?? data.platform)
  const duration = normalizeDuration(asNumber(root.duration ?? data.duration, 0))
  const backup = asString(data.videoUrlBackup ?? data.video_url_backup ?? data.backupUrl).trim()
  return {
    platform: platformCode === '' ? fallbackPlatform : mapPlatformCode(platformCode, fallbackPlatform),
    provider: 'api',
    videoUrl,
    ...(backup === '' || backup === videoUrl ? {} : { videoUrlBackup: backup }),
    title: firstText(data, ['title', 'desc', 'description', 'caption', 'content'])
      ?? firstText(root, ['title', 'desc', 'description'])
      ?? '未命名视频',
    ...(textAt(data, ['author', 'nickname', 'user']) === undefined
      ? {}
      : { author: textAt(data, ['author', 'nickname', 'user']) }),
    ...(duration > 0 ? { durationSec: duration } : {}),
    ...(textAt(data, ['coverUrl', 'cover', 'cover_url', 'thumbnail']) === undefined
      ? {}
      : { coverUrl: textAt(data, ['coverUrl', 'cover', 'cover_url', 'thumbnail']) }),
    raw: JSON.stringify(payload).slice(0, 4000),
  }
}

/** 时长统一成秒：大于 15 分钟的数值基本可以确定是毫秒（RedFox 给 9000 = 9 秒）。 */
function normalizeDuration(value: number): number {
  if (value <= 0) return 0
  if (value > 900) return Math.round((value / 1000) * 100) / 100
  return value
}

/** 取第一个非空文本字段（`??` 遇到空字符串不会回落，这里单独处理）。 */
function firstText(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(source[key]).trim()
    if (value !== '') return value
  }
  return undefined
}

/** 调一个第三方解析接口拿直链。 */
async function callParser(config: ParserConfig, apiUrl: string, apiKey: string, url: string, platform: Platform): Promise<ParsedLink> {
  const trimmed = apiUrl.trim()
  if (trimmed === '') throw new Error('未配置解析接口（设置 → 视频复刻 → 解析下载）')
  const base = baseUrlOf(trimmed, '/v1')
  const endpoint = /^https?:\/\//i.test(trimmed) && /\/(parse|parseWork|api)\b/i.test(trimmed)
    ? trimmed
    : joinUrl(base, '')
  const headers = authHeaders(apiKey, {
    'content-type': 'application/json',
    'x-api-key': apiKey.trim(),
  })
  // HoxHox 只要 url；RedFox 还认 source 标签。多带一个字段不影响其它网关。
  const body = { url, source: 'dsh-video-replica', key: apiKey.trim(), ...extraParams(config.extraJson) }
  const payload = await requestJson(endpoint, {
    method: 'POST',
    headers,
    json: body,
    label: '解析视频链接',
    timeoutMs: Math.max(15_000, (config.timeoutSec ?? 120) * 1000),
  })
  return { ...interpretParseResponse(payload, platform, config.videoUrlPath ?? ''), endpoint: new URL(trimmed).host }
}

/**
 * 调解析接口拿直链：主接口失败（服务异常 / 鉴权 / 超时 / 视频地址缺失）时，
 * 如果配了备用接口就自动切过去——不同服务商的抖音通道经常各自挂。
 */
export async function parseViaApi(config: ParserConfig, url: string, platform: Platform): Promise<ParsedLink> {
  const primaryUrl = config.apiUrl.trim()
  const fallbackUrl = (config.fallbackApiUrl ?? '').trim()
  const attempts: Array<{ label: string, url: string, key: string }> = []
  if (primaryUrl !== '') attempts.push({ label: '主解析接口', url: primaryUrl, key: config.apiKey })
  if (fallbackUrl !== '') attempts.push({ label: '备用解析接口', url: fallbackUrl, key: config.fallbackApiKey ?? '' })
  if (attempts.length === 0) throw new Error('未配置视频解析接口（设置 → 视频复刻 → 解析下载）')

  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      const parsed = await callParser(config, attempt.url, attempt.key, url, platform)
      return failures.length === 0 ? parsed : { ...parsed, skipped: [...failures] }
    } catch (error) {
      failures.push(`${attempt.label}（${hostOf(attempt.url)}）：${messageOf(error)}`)
    }
  }
  throw new Error(failures.join('；'))
}

function hostOf(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

export interface YtDlpResult {
  videoUrl: string
  /** 解析服务给的备用地址（主地址下载失败时再试）。 */
  videoUrlBackup?: string
  title: string
  author?: string
  durationSec?: number
}

/** 用 yt-dlp 读元数据（不下载）。 */
export async function ytDlpProbe(config: { ytDlpPath: string, cookiesFromBrowser?: string }, url: string): Promise<YtDlpResult> {
  const cookies = (config.cookiesFromBrowser ?? '').trim()
  const result = await runCommand(config.ytDlpPath, [
    '--no-playlist', '--no-warnings', '--no-check-certificates',
    ...(cookies === '' ? [] : ['--cookies-from-browser', cookies]),
    '-J', url,
  ], { timeoutMs: 180_000, allowFailure: true })
  if (result.code !== 0) {
    throw new Error(`yt-dlp 解析失败：${result.stderr.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('yt-dlp 输出不是 JSON')
  }
  const record = asRecord(parsed)
  return {
    videoUrl: asString(record.url).trim(),
    title: asString(record.title).trim() || asString(record.description).slice(0, 40) || '未命名视频',
    ...(asString(record.uploader ?? record.channel).trim() === ''
      ? {}
      : { author: asString(record.uploader ?? record.channel).trim() }),
    ...(asNumber(record.duration, 0) > 0 ? { durationSec: asNumber(record.duration, 0) } : {}),
  }
}

/** 用 yt-dlp 直接下载到 dest。 */
export async function ytDlpDownload(config: { ytDlpPath: string, cookiesFromBrowser?: string }, url: string, dest: string, workDir: string): Promise<void> {
  await mkdir(workDir, { recursive: true })
  // 模板不含扩展名，由 yt-dlp 决定；之后我们按前缀找文件并改名。
  const template = join(workDir, 'ytdlp-download.%(ext)s')
  const cookies = (config.cookiesFromBrowser ?? '').trim()
  const result = await runCommand(config.ytDlpPath, [
    '--no-playlist', '--no-warnings', '--no-check-certificates',
    '--no-progress',
    ...(cookies === '' ? [] : ['--cookies-from-browser', cookies]),
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '-o', template,
    url,
  ], { timeoutMs: 600_000, allowFailure: true, cwd: workDir })
  if (result.code !== 0) {
    throw new Error(`yt-dlp 下载失败：${result.stderr.trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400)}`)
  }
  const { listFiles } = await import('../media.ts')
  const files = (await listFiles(workDir)).filter(name => name.startsWith('ytdlp-download.'))
  const found = files.find(name => /\.(mp4|mkv|webm|mov|flv)$/i.test(name))
  if (found === undefined) throw new Error('yt-dlp 没有产出视频文件')
  const { rename } = await import('node:fs/promises')
  await rename(join(workDir, found), dest)
}

export interface ResolvedSource {
  videoFile: string
  provider: 'api' | 'ytdlp' | 'direct'
  platform: Platform
  title: string
  author?: string
  durationSec?: number
  width?: number
  height?: number
  fps?: number
  coverFile?: string
  raw?: string
}

/**
 * 解析 + 下载源视频到运行目录。
 *
 * mode=auto 时的顺序：直链 → 解析接口（已配置）→ yt-dlp（可用时）。
 * 全部失败时抛出的错误里带每条路的具体原因，界面据此提示改用本地上传。
 */
export async function resolveSource(options: {
  input: string
  parser: ParserConfig
  media: { ytDlpPath: string; ffprobePath: string; cookiesFromBrowser?: string }
  workDir: string
  onProgress?: (message: string) => void
}): Promise<ResolvedSource> {
  const { parser, media, workDir, onProgress } = options
  const url = extractUrl(options.input)
  if (url === undefined) throw new Error('没有识别到链接。请粘贴抖音/小红书/视频号分享链接，或改用本地视频上传。')
  const platform = detectPlatform(url)
  await mkdir(workDir, { recursive: true })
  const videoPath = join(workDir, 'source.mp4')
  const failures: string[] = []

  /** 校验下载结果：必须是能解码的视频，否则把原因说清楚而不是留给下一步。 */
  const finish = async (source: Omit<ResolvedSource, 'width' | 'height' | 'fps'>): Promise<ResolvedSource> => {
    const probe = await probeMedia(videoPath, media.ffprobePath).catch(() => undefined)
    if (probe === undefined || !probe.hasVideo) {
      const size = await stat(videoPath).then(info => info.size).catch(() => 0)
      const head = await readFile(videoPath).then(buffer => buffer.subarray(0, 300).toString('utf8')).catch(() => '')
      const looksHtml = /^\s*<(!doctype|html|head|body)/i.test(head) || /^\s*[{[]/.test(head)
      const reason = looksHtml
        ? '下载到的是一段网页/JSON（解析服务没有给出真正的视频地址，或链接需要登录态）'
        : '文件无法解码（可能下载不完整，或不是视频文件）'
      // 保留坏文件方便排障，但不要把运行指到它上面。
      await rename(videoPath, `${videoPath}.invalid`).catch(() => {})
      throw new Error(`${reason}；大小 ${Math.round(size / 1024)}KB${size > 0 ? `；开头：${head.slice(0, 120).replace(/\s+/g, ' ')}` : ''}`)
    }
    return {
      ...source,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      // ffprobe 是权威来源：解析接口的 duration 可能单位错、或只是预估。
      durationSec: probe.durationSec > 0 ? probe.durationSec : (source.durationSec ?? 0),
    }
  }

  const tryDirect = async (): Promise<ResolvedSource> => {
    onProgress?.('直接下载视频文件…')
    await downloadFile(url, videoPath, { timeoutMs: 600_000 })
    return await finish({ videoFile: 'source.mp4', provider: 'direct', platform, title: '本地直链视频' })
  }

  const tryApi = async (): Promise<ResolvedSource> => {
    if (parser.apiUrl.trim() === '') throw new Error('未配置解析接口')
    onProgress?.('调用解析接口…')
    const parsed = await parseViaApi(parser, url, platform)
    onProgress?.(`已解析（${parsed.endpoint ?? '解析接口'}）：${parsed.title}，开始下载视频…`)
    for (const note of parsed.skipped ?? []) {
      onProgress?.(`主解析接口失败，已切备用 —— ${note}`)
    }
    // 解析服务常给一个主地址 + 一个备用地址，主地址失败时再试备用的。
    const candidates = [parsed.videoUrl, ...(parsed.videoUrlBackup === undefined ? [] : [parsed.videoUrlBackup])]
    let lastError: unknown
    let downloaded = false
    for (const candidate of candidates) {
      try {
        await downloadFile(candidate, videoPath, { timeoutMs: 600_000, headers: { referer: url } })
        downloaded = true
        break
      } catch (error) {
        lastError = error
        await rm(videoPath, { force: true }).catch(() => {})
      }
    }
    if (!downloaded) throw lastError ?? new Error('视频下载失败')
    let coverFile: string | undefined
    if (parsed.coverUrl !== undefined && parser.apiUrl !== '') {
      const coverPath = join(workDir, 'cover.jpg')
      try {
        await downloadFile(parsed.coverUrl, coverPath, { timeoutMs: 60_000, maxBytes: 12 * 1024 * 1024 })
        coverFile = 'cover.jpg'
      } catch {
        // 封面失败不影响主流程
      }
    }
    return await finish({
      videoFile: 'source.mp4',
      provider: 'api',
      platform: parsed.platform,
      title: parsed.title,
      ...(parsed.author === undefined ? {} : { author: parsed.author }),
      ...(parsed.durationSec === undefined ? {} : { durationSec: parsed.durationSec }),
      ...(coverFile === undefined ? {} : { coverFile }),
      ...(parsed.raw === undefined ? {} : { raw: parsed.raw }),
    })
  }

  const tryYtDlp = async (): Promise<ResolvedSource> => {
    const available = await toolAvailable(media.ytDlpPath, '--version')
    if (!available) throw new Error(`yt-dlp 不可用（路径：${media.ytDlpPath}）`)
    onProgress?.('用 yt-dlp 解析并下载…')
    const probe = await ytDlpProbe(media, url).catch(() => undefined)
    await ytDlpDownload(media, url, videoPath, workDir)
    return await finish({
      videoFile: 'source.mp4',
      provider: 'ytdlp',
      platform,
      title: probe?.title ?? 'yt-dlp 视频',
      ...(probe?.author === undefined ? {} : { author: probe.author }),
      ...(probe?.durationSec === undefined ? {} : { durationSec: probe.durationSec }),
    })
  }

  const order: Array<[string, () => Promise<ResolvedSource>]> = []
  if (parser.mode === 'upload') {
    throw new Error('当前解析模式为「仅本地上传」。请上传视频文件，或把解析模式改为自动。')
  }
  if (parser.mode === 'api') {
    order.push(['解析接口', tryApi])
  } else if (parser.mode === 'ytdlp') {
    order.push(['yt-dlp', tryYtDlp])
  } else {
    if (looksLikeDirectVideo(url)) order.push(['直链下载', tryDirect])
    if (parser.apiUrl.trim() !== '') order.push(['解析接口', tryApi])
    order.push(['yt-dlp', tryYtDlp])
    // 注意：分享链接不是视频文件地址，绝不能当直链去下载（会存下一整页 HTML）。

  }

  for (const [label, attempt] of order) {
    try {
      return await attempt()
    } catch (error) {
      const reason = messageOf(error).replace(/\s+/g, ' ').slice(0, 300)
      failures.push(`${label}：${messageOf(error)}`)
      onProgress?.(`${label}失败：${reason}`)
    }
  }

  const hint = platform === 'channels'
    ? '视频号需要登录态，纯接口解析通常不可用：建议用支持视频号的解析服务，或先下载视频再「本地上传」。'
    : '建议：①在设置里配置解析接口 API Key；②或安装 yt-dlp；③或直接上传已下载的视频。'
  throw new Error(`视频解析失败。\n${failures.join('\n')}\n${hint}`)
}
