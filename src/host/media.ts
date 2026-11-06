/**
 * 媒体层：ffmpeg / ffprobe / yt-dlp 的进程封装，以及下载。
 *
 * 约定：
 * - 全部以「无 shell 的 argv」调用，避免中文路径与空格被 cmd 解析吃掉；
 * - 需要滤镜（subtitles / concat）时把 cwd 设到产物目录，用相对文件名，
 *   绕开 Windows 盘符冒号在 filtergraph 里的转义地狱；
 * - 超时后 kill 子进程并抛错，绝不留下僵尸 ffmpeg。
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { messageOf } from './util.ts'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunCommandOptions {
  timeoutMs?: number
  cwd?: string
  /** 允许非零退出码（默认抛错）。 */
  allowFailure?: boolean
  /** 标准输入内容（例如 ffmpeg 的 concat 列表）。 */
  stdin?: string
}

/** 运行一个可执行文件并收集输出。 */
export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectPromise(new Error(`无法启动 ${basename(command)}：${messageOf(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CommandResult | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result instanceof Error) rejectPromise(result)
      else resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已退出
      }
      finish(new Error(`${basename(command)} 执行超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()

    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000)
    })
    child.on('error', error => {
      finish(new Error(`运行 ${basename(command)} 失败：${messageOf(error)}`))
    })
    child.on('close', code => {
      const status = code ?? -1
      if (status !== 0 && options.allowFailure !== true) {
        finish(new Error(`${basename(command)} 退出码 ${status}：${stderr.trim().split(/\r?\n/).slice(-6).join(' | ')}`))
        return
      }
      finish({ code: status, stdout, stderr })
    })
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin)
    } else {
      child.stdin?.end()
    }
  })
}

export interface MediaProbe {
  durationSec: number
  width: number
  height: number
  fps: number
  hasVideo: boolean
  hasAudio: boolean
}

/** ffprobe 探测时长/分辨率/帧率/音轨。 */
export async function probeMedia(file: string, ffprobePath: string, timeoutMs = 30_000): Promise<MediaProbe> {
  const result = await runCommand(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeoutMs, allowFailure: true })
  const empty: MediaProbe = { durationSec: 0, width: 0, height: 0, fps: 0, hasVideo: false, hasAudio: false }
  if (result.code !== 0) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return empty
  }
  const record = parsed as { format?: { duration?: string }, streams?: Array<Record<string, unknown>> }
  const streams = Array.isArray(record.streams) ? record.streams : []
  const video = streams.find(stream => stream.codec_type === 'video')
  const audio = streams.find(stream => stream.codec_type === 'audio')
  const fpsRaw = typeof video?.r_frame_rate === 'string' ? video.r_frame_rate : ''
  const [num, den] = fpsRaw.split('/').map(value => Number.parseFloat(value))
  const fps = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : 0
  return {
    durationSec: Number.parseFloat(String(record.format?.duration ?? '0')) || 0,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
    fps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
  }
}

/** 工具是否可用（ffmpeg -version / yt-dlp --version）。 */
export async function toolAvailable(command: string, versionFlag = '-version'): Promise<boolean> {
  if (command.trim() === '') return false
  try {
    const result = await runCommand(command, [versionFlag], { timeoutMs: 15_000, allowFailure: true })
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * 均匀抽帧成 JPG，返回文件名列表。
 *
 * 抽帧点避开首尾黑场：0.5s 起、结束前 0.5s 止；不足则退回全片均分。
 */
export async function extractFrames(options: {
  videoPath: string
  outDir: string
  count: number
  maxSide: number
  durationSec: number
  ffmpegPath: string
  prefix?: string
}): Promise<string[]> {
  const { videoPath, outDir, count, maxSide, ffmpegPath } = options
  const prefix = options.prefix ?? 'frame'
  await mkdir(outDir, { recursive: true })
  const duration = options.durationSec > 0 ? options.durationSec : 1
  const margin = duration > 4 ? 0.5 : 0
  const usable = Math.max(0.1, duration - margin * 2)
  const files: string[] = []
  let lastError = ''
  for (let index = 0; index < count; index += 1) {
    const t = margin + (usable * (index + 0.5)) / count
    const name = `${prefix}-${String(index + 1).padStart(2, '0')}.jpg`
    const out = join(outDir, name)
    const scale = `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))'`
    const result = await runCommand(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', t.toFixed(2),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', scale,
      '-q:v', '3',
      out,
    ], { timeoutMs: 60_000, allowFailure: true })
    if (result.code !== 0) {
      // 退化：不做缩放再试一次（某些老版本不支持 min() 表达式）
      const retry = await runCommand(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', t.toFixed(2), '-i', videoPath,
        '-frames:v', '1', '-vf', `scale=${maxSide}:-2`, '-q:v', '3', out,
      ], { timeoutMs: 60_000, allowFailure: true })
      if (retry.code !== 0) {
        lastError = (retry.stderr || lastError).trim()
        continue
      }
    }
    files.push(name)
  }
  if (files.length === 0) {
    const detail = lastError.split(/\r?\n/).filter(line => line.trim() !== '').slice(-3).join(' | ')
    throw new Error(
      `ffmpeg 没有从源视频取到任何画面${detail === '' ? '' : `（${detail.slice(0, 300)}）`}。` +
      '请确认视频文件完整、或把设置里的 ffmpeg 路径填成完整路径。',
    )
  }
  return files
}

/** 用 ffmpeg 生成一张封面 jpg。 */
export async function extractCover(videoPath: string, outFile: string, ffmpegPath: string, atSec = 0.3): Promise<void> {
  const attempt = await runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile,
  ], { timeoutMs: 60_000, allowFailure: true })
  if (attempt.code === 0) return
  await runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile,
  ], { timeoutMs: 60_000 }).catch(() => {})
}

/** 下载远程文件到本地（带超时与大小上限）。 */
export async function downloadFile(
  url: string,
  dest: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ bytes: number }> {
  const timeoutMs = options.timeoutMs ?? 300_000
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024
  await mkdir(dirname(dest), { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-video-replica', ...options.headers },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${(await response.text().catch(() => '')).slice(0, 200)}`)
    if (response.body === null) throw new Error('下载响应没有内容')
    const length = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error(`文件过大（${Math.round(length / 1048576)}MB），超过上限 ${Math.round(maxBytes / 1048576)}MB`)
    }
    const temp = `${dest}.part`
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp))
    const info = await stat(temp)
    if (info.size > maxBytes) {
      await rm(temp, { force: true })
      throw new Error(`文件过大（${Math.round(info.size / 1048576)}MB），超过上限 ${Math.round(maxBytes / 1048576)}MB`)
    }
    if (info.size < 1024) {
      const head = (await import('node:fs/promises')).readFile
      const sample = await head(temp).then(buffer => buffer.subarray(0, 200).toString('utf8')).catch(() => '')
      await rm(temp, { force: true })
      throw new Error(`下载内容不是视频（${info.size} 字节）：${sample.slice(0, 160)}`)
    }
    await rename(temp, dest)
    return { bytes: info.size }
  } finally {
    clearTimeout(timer)
  }
}

/** 把远程图片下载成文件（供参考图/产品图）。 */
export async function downloadImage(url: string, dest: string, timeoutMs = 120_000): Promise<void> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const buffer = Buffer.from(url.slice(comma + 1), 'base64')
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buffer)
    return
  }
  const result = await downloadFile(url, dest, { timeoutMs, maxBytes: 40 * 1024 * 1024 })
  if (result.bytes <= 0) throw new Error('图片下载为空')
}

// ---------------------------------------------------------------------------
// 合成辅助
// ---------------------------------------------------------------------------

/**
 * 拼接分镜视频（多段一次编码完成）。
 *
 * 必须用 concat **滤镜**而不是 concat 解复用器：不同模型/不同批次产出的片段
 * 采样率、帧率、SAR 都可能不一致，解复用器会按首段参数硬拼，导致音画错位。
 * 这里统一 scale+pad 到目标画幅、统一 fps、统一 44.1kHz 立体声。
 *
 * @param keepAudio - true 时保留各段自带音轨（模型内嵌配音）；缺音轨的段会补静音。
 */
export async function mergeSegments(options: {
  segments: Array<{ file: string, hasAudio: boolean }>
  output: string
  width: number
  height: number
  fps: number
  ffmpegPath: string
  workDir: string
  keepAudio: boolean
}): Promise<void> {
  const { segments, output, width, height, fps, ffmpegPath, workDir, keepAudio } = options
  if (segments.length === 0) throw new Error('没有可拼接的分镜视频')
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  const inputs: string[] = []
  const withAudio = keepAudio && segments.every(segment => segment.hasAudio)
  for (const segment of segments) {
    args.push('-i', segment.file)
    inputs.push(segment.file)
  }
  const filters: string[] = []
  const videoLabels: string[] = []
  const audioLabels: string[] = []
  segments.forEach((segment, index) => {
    filters.push(
      `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}[v${index}]`,
    )
    videoLabels.push(`[v${index}]`)
    if (withAudio) {
      filters.push(`[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`)
      audioLabels.push(`[a${index}]`)
    }
  })
  const videoConcat = withAudio
    ? `${videoLabels.join('')}concat=n=${segments.length}:v=1:a=0[vout]`
    : `${videoLabels.join('')}concat=n=${segments.length}:v=1:a=0[vout]`
  filters.push(videoConcat)
  if (withAudio) {
    filters.push(`${audioLabels.join('')}concat=n=${segments.length}:v=0:a=1[aout]`)
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]')
  if (withAudio) args.push('-map', '[aout]')
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
  if (withAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2')
  args.push('-movflags', '+faststart', output)
  await runCommand(ffmpegPath, args, { timeoutMs: 1_800_000, cwd: workDir })
}

/**
 * 把各段自带音轨（Seedance 生成的环境音/动作声）拼成一条“环境音底噪”，
 * 音量压到很低，混在 TTS 配音下面，避免成片出现大段绝对静音。
 */
export async function buildAmbientTrack(options: {
  segments: Array<{ file: string, hasAudio: boolean }>
  output: string
  ffmpegPath: string
  workDir: string
  /** 环境音相对音量，默认 0.22。 */
  volume?: number
}): Promise<boolean> {
  const usable = options.segments.filter(segment => segment.hasAudio)
  if (usable.length === 0) return false
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const segment of usable) args.push('-i', segment.file)
  const filters = usable.map((_segment, index) =>
    `[${index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`)
  const labels = usable.map((_segment, index) => `[a${index}]`).join('')
  const volume = Math.min(1, Math.max(0, options.volume ?? 0.22))
  filters.push(`${labels}concat=n=${usable.length}:v=0:a=1[cat]`)
  filters.push(`[cat]volume=${volume}[aout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[aout]', '-ar', '44100', '-ac', '2', options.output)
  await runCommand(options.ffmpegPath, args, { timeoutMs: 900_000, cwd: options.workDir })
  return true
}

/**
 * 用 ffmpeg silencedetect 找出「有人说话」的区间。
 * 原声模式下字幕要贴到真实语音上，而多数 ASR 只给整段文本、不给逐句时间。
 */
export async function detectSpeechWindows(options: {
  file: string
  durationSec: number
  ffmpegPath: string
  noiseDb?: string
  minSilenceSec?: number
}): Promise<Array<{ startSec: number, endSec: number }>> {
  const noise = options.noiseDb ?? '-35dB'
  const minSilence = options.minSilenceSec ?? 0.35
  const result = await runCommand(options.ffmpegPath, [
    '-hide_banner', '-i', options.file,
    '-af', `silencedetect=noise=${noise}:d=${minSilence}`,
    '-f', 'null', '-',
  ], { timeoutMs: 300_000, allowFailure: true })
  const text = result.stderr
  const silences: Array<{ startSec: number, endSec: number }> = []
  let openStart: number | undefined
  for (const line of text.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[0-9.]+)/.exec(line)
    if (start !== null) { openStart = Math.max(0, Number(start[1])); continue }
    const end = /silence_end:\s*([0-9.]+)/.exec(line)
    if (end !== null && openStart !== undefined) {
      silences.push({ startSec: openStart, endSec: Number(end[1]) })
      openStart = undefined
    }
  }
  const total = options.durationSec > 0 ? options.durationSec : (silences.at(-1)?.endSec ?? 0)
  const windows: Array<{ startSec: number, endSec: number }> = []
  let cursor = 0
  for (const silence of silences) {
    if (silence.startSec > cursor + 0.15) windows.push({ startSec: cursor, endSec: Math.min(silence.startSec, total) })
    cursor = Math.max(cursor, silence.endSec)
  }
  if (total > cursor + 0.15) windows.push({ startSec: cursor, endSec: total })
  if (windows.length === 0 && total > 0) windows.push({ startSec: 0, endSec: total })
  return windows.filter(item => item.endSec > item.startSec + 0.15)
}

/**
 * 用能量谷把已知台词「对」到音频上。
 *
 * ASR（MiMo 等）只回一段纯文本、没有时间戳；连续底噪的片段又检测不到静音。
 * 这里把 16k 单声道 PCM 按 25ms 算能量，在每句按字数推算的预期位置附近找能量最低点，
 * 做为断句边界——比按比例硬摊更贴真实停顿。
 */
export async function alignPhrasesInAudio(options: {
  wavFile: string
  phrases: string[]
  durationSec: number
  /** 只在这个区间内对齐（默认整段）。 */
  startSec?: number
  endSec?: number
}): Promise<Array<{ startSec: number, endSec: number }>> {
  const phrases = options.phrases.filter(item => item.trim() !== '')
  const from = Math.max(0, options.startSec ?? 0)
  const to = Math.min(options.durationSec, options.endSec ?? options.durationSec)
  if (phrases.length === 0 || to - from < 0.2) return []
  if (phrases.length === 1) return [{ startSec: from, endSec: to }]

  const buffer = await readFile(options.wavFile)
  // 定位 data chunk（PCM s16le）
  let offset = 12
  let dataStart = -1
  let dataLength = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') { dataStart = offset + 8; dataLength = Math.min(size, buffer.length - dataStart); break }
    offset += 8 + size + (size % 2)
  }
  if (dataStart < 0 || dataLength <= 0) return []
  const sampleRate = 16000
  const hop = 0.025
  const frameSamples = Math.round(sampleRate * hop)
  const frames = Math.floor(dataLength / 2 / frameSamples)
  if (frames < 4) return []
  const energy = new Float64Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    const base = dataStart + frame * frameSamples * 2
    for (let i = 0; i < frameSamples; i += 1) {
      const value = buffer.readInt16LE(base + i * 2) / 32768
      sum += value * value
    }
    energy[frame] = Math.sqrt(sum / frameSamples)
  }
  const smoothed = new Float64Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    let count = 0
    for (let k = Math.max(0, i - 2); k <= Math.min(frames - 1, i + 2); k += 1) { sum += energy[k]; count += 1 }
    smoothed[i] = sum / count
  }

  const span = to - from
  const totalChars = phrases.reduce((sum, item) => sum + item.length, 0) || 1
  const boundaries: number[] = [from]
  let consumed = 0
  for (const [index, phrase] of phrases.entries()) {
    consumed += phrase.length
    if (index === phrases.length - 1) break
    const expected = from + span * (consumed / totalChars)
    const radius = Math.max(0.35, Math.min(1.2, span * 0.12))
    const low = Math.max(boundaries[boundaries.length - 1] + 0.3, expected - radius)
    const high = Math.min(to - 0.2, expected + radius)
    let bestAt = expected
    let bestValue = Number.POSITIVE_INFINITY
    for (let t = low; t <= high; t += hop) {
      const frame = Math.min(frames - 1, Math.max(0, Math.round(t / hop)))
      if (smoothed[frame] < bestValue) { bestValue = smoothed[frame]; bestAt = t }
    }
    boundaries.push(bestAt)
  }
  boundaries.push(to)
  const cues: Array<{ startSec: number, endSec: number }> = []
  for (let i = 0; i < phrases.length; i += 1) {
    const startSec = boundaries[i]
    const endSec = boundaries[i + 1]
    if (endSec > startSec + 0.15) cues.push({ startSec, endSec })
  }
  return cues
}

/** 取音视频长度（秒），失败返回 0。 */
export async function mediaDuration(file: string, ffprobePath: string): Promise<number> {
  const probe = await probeMedia(file, ffprobePath).catch(() => undefined)
  return probe?.durationSec ?? 0
}

/**
 * 用 ASS 字幕把每个镜头的口播/大字烧进画面。
 *
 * 字号与边距必须按成片**真实高度**推导（写死会在横屏/小尺寸下缩到看不见）；
 * libass 不会给无空格的中文断行，所以这里自己按字数均分并插入 `\N`，
 * 同时把标点挪到下一行行首之外（禁则处理）。
 */
export async function writeAssSubtitle(options: {
  output: string
  fontSize: number
  width: number
  height: number
  cues: Array<{ startSec: number; endSec: number; text: string }>
}): Promise<void> {
  const { output, width, height, cues } = options
  // 竖屏字幕的约束是「宽度」而不是高度：720 宽下 74px 会每行只剩 8 个字、碎成三行。
  // 基准按宽度取 5.5%（720 → 40px），再用配置里的相对字号（默认 15）做缩放。
  const relative = options.fontSize === undefined ? 15 : Math.max(8, Math.min(40, options.fontSize))
  const base = Math.round(width * 0.0555)
  const fontSize = Math.max(20, Math.min(Math.round(base * (relative / 15)), Math.round(width * 0.12)))
  const marginV = Math.max(24, Math.round(height * 0.09))
  const outline = Math.max(1, Math.min(Math.round(height * 0.003), 6))
  const marginSide = 40
  const perLine = Math.max(6, Math.floor((width - marginSide * 2) / (fontSize * 0.95)))
  const wrap = (text: string): string => {
    const chars = Array.from(text.replace(/\s+/g, ' ').trim())
    if (chars.length <= perLine) return chars.join('')
    const lineCount = Math.ceil(chars.length / perLine)
    const per = Math.ceil(chars.length / lineCount)
    const lines: string[] = []
    let cursor = 0
    while (cursor < chars.length) {
      let take = Math.min(per, chars.length - cursor)
      // 标点不顶行首：行尾是标点则少取一个字。
      if (cursor + take < chars.length && '，。！？；：、）】」』〉》”’,.!?;:)]}'.includes(chars[cursor + take] ?? '')) {
        take = Math.max(1, take - 1)
      }
      lines.push(chars.slice(cursor, cursor + take).join(''))
      cursor += take
    }
    return lines.join('\\N')
  }
  const time = (seconds: number): string => {
    const total = Math.max(0, seconds)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = Math.floor(total % 60)
    const centis = Math.round((total - Math.floor(total)) * 100)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(Math.min(99, centis)).padStart(2, '0')}`
  }
  const escape = (text: string): string =>
    text.replace(/\\/g, '／').replace(/\{/g, '（').replace(/\}/g, '）').replace(/\r?\n/g, ' ')
  const header = [
    '[Script Info]',
    'Title: dsh-video-replica',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${outline},1,2,${marginSide},${marginSide},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const lines = cues
    .filter(cue => cue.text.trim() !== '' && cue.endSec > cue.startSec)
    .map(cue => `Dialogue: 0,${time(cue.startSec)},${time(cue.endSec)},Default,,0,0,0,,${wrap(escape(cue.text))}`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${header.join('\n')}\n${lines.join('\n')}\n`, 'utf8')
}

/** 把一轨音频按目标时长拉伸/补静音，便于逐镜头对齐。 */
export async function fitAudio(options: {
  input: string
  output: string
  targetSec: number
  ffmpegPath: string
  workDir: string
}): Promise<void> {
  const { input, output, targetSec, ffmpegPath } = options
  const target = Math.max(0.4, targetSec)
  const attempt = await runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-af', `apad,atrim=0:${target.toFixed(3)}`,
    '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', output,
  ], { timeoutMs: 300_000, allowFailure: true, cwd: options.workDir })
  if (attempt.code === 0) return
  // 极短/空音频：直接生成等长静音，保证后续拼接不断轨。
  await runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', target.toFixed(3), '-c:a', 'pcm_s16le', output,
  ], { timeoutMs: 120_000, cwd: options.workDir })
}

/** 生成一段 N 秒静音 wav。 */
export async function silentAudio(output: string, seconds: number, ffmpegPath: string, workDir: string): Promise<void> {
  await runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', Math.max(0.2, seconds).toFixed(3), '-c:a', 'pcm_s16le', output,
  ], { timeoutMs: 120_000, cwd: workDir })
}

/**
 * 音视频合流：视频轨直接复制，音频轨可混 BGM，字幕可选烧录。
 */
export async function muxFinal(options: {
  video: string
  /** 配音轨；缺省表示沿用视频自带音频，没有音轨时输出无声成片。 */
  audio?: string
  /** 环境音底噪（各段原声混合），与配音叠加。 */
  ambient?: string
  /** 环境音相对音量，默认 0.22。 */
  ambientVolume?: number
  bgm?: string
  bgmVolume?: number
  subtitle?: string
  subtitleFontSize?: number
  output: string
  ffmpegPath: string
  workDir: string
  /** 中间容器文件名（相对 workDir），避免 filtergraph 里的绝对路径。 */
  tempName?: string
}): Promise<void> {
  const { video, audio, bgm, subtitle, output, ffmpegPath, workDir } = options
  const tempName = options.tempName ?? 'video-with-subs.mp4'
  // 第一步：烧字幕（如果启用）。放在 cwd=workDir 里跑，用相对文件名绕开冒号。
  let videoStage = video
  if (subtitle !== undefined) {
    await runCommand(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', video,
      '-vf', 'subtitles=subs.ass',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-an', '-movflags', '+faststart', tempName,
    ], { timeoutMs: 900_000, cwd: workDir }).catch(async error => {
      // 字幕滤镜不可用（缺 libass 字体）时降级为不烧字幕，保留成片。
      console.warn('[dsh-video-replica] 字幕烧录失败，降级为不烧录：', messageOf(error))
      await runCommand(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-an',
        '-c:v', 'copy', '-movflags', '+faststart', tempName,
      ], { timeoutMs: 300_000, cwd: workDir })
    })
    videoStage = join(workDir, tempName)
  }

  if (audio === undefined) {
    // 没有音轨：只做字幕烧录（或直接复制），输出无声成片。
    if (videoStage === video) {
      await runCommand(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', video,
        '-c', 'copy', '-movflags', '+faststart', output,
      ], { timeoutMs: 300_000, cwd: workDir })
      return
    }
    await runCommand(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', videoStage,
      '-c', 'copy', '-movflags', '+faststart', output,
    ], { timeoutMs: 300_000, cwd: workDir })
    return
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoStage, '-i', audio]
  let nextIndex = 2
  let ambientIndex: number | undefined
  if (options.ambient !== undefined && options.ambient.trim() !== '') {
    ambientIndex = nextIndex
    args.push('-i', options.ambient)
    nextIndex += 1
  }
  let bgmIndex: number | undefined
  if (bgm !== undefined && bgm !== '') {
    bgmIndex = nextIndex
    args.push('-stream_loop', '-1', '-i', bgm)
    nextIndex += 1
  }
  if (ambientIndex !== undefined || bgmIndex !== undefined) {
    const parts: string[] = []
    let current = '[1:a]'
    const ambVolume = Math.min(1, Math.max(0, options.ambientVolume ?? 0.22))
    if (ambientIndex !== undefined) {
      // 侧链闪避：配音一说话，环境音自动压下去（避免和 TTS 叠成双人声），
      // 配音停顿的间隙再把环境音放回来。
      parts.push(`[${ambientIndex}:a]volume=${ambVolume}[amb]`)
      parts.push(`${current}asplit=2[nar][sc]`)
      parts.push('[amb][sc]sidechaincompress=threshold=0.03:ratio=8:attack=8:release=260[ambd]')
      parts.push('[nar][ambd]amix=inputs=2:duration=first:dropout_transition=0[mix1]')
      current = '[mix1]'
    }
    if (bgmIndex !== undefined) {
      const bgmVolume = Math.min(1, Math.max(0, options.bgmVolume ?? 0.18))
      parts.push(`[${bgmIndex}:a]volume=${bgmVolume}[bgm]`)
      parts.push(`${current}[bgm]amix=inputs=2:duration=first:dropout_transition=0[mix2]`)
      current = '[mix2]'
    }
    // 统一响度：TTS + 环境音混出来常常只有 -31 dB，手机外放几乎听不见。
    parts.push(`${current}loudnorm=I=-16:TP=-1.5:LRA=11[aout]`)
    args.push('-filter_complex', parts.join(';'), '-map', '0:v:0', '-map', '[aout]')
  } else {
    args.push('-map', '0:v:0', '-map', '1:a:0')
  }
  args.push(
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-shortest', '-movflags', '+faststart', output,
  )
  await runCommand(ffmpegPath, args, { timeoutMs: 900_000, cwd: workDir })
}

/** 目录里按前缀列文件（排障/清理用）。 */
export async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

export function absolute(dir: string, relative: string): string {
  return resolve(dir, relative)
}
