/**
 * 插件配置：落盘在 ~/.dsh/storages/dsh-video-replica/config.json。
 *
 * 选择自持配置文件而不是宿主 settings 命名空间，原因：
 * - 六步各自需要「接口地址 + 密钥 + 模型 + 协议 + 超时」，是嵌套结构，
 *   用 settings 的 path-op 表达会让前端与宿主两套模型互相牵制；
 * - 配置必须能被 Agent 工具 / 命令行 / 设置页三处一致读取，单一 JSON 最稳；
 * - 不依赖宿主 settings 服务版本差异（该服务在 0.1.x / 0.2.x 之间换过 API）。
 *
 * 安全：密钥只落本机（用户目录、0600 尽力而为），HTTP 桥接只对本机回环开放，
 * 读回配置时密钥一律以掩码返回，界面按「是否已设置」显示。
 */

import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginConfig, ConfigView, EndpointConfig } from '../shared/types.ts'
import { asString, messageOf } from './util.ts'

/** 密钥掩码（与浏览器半边共用同一常量）：界面原样回传表示「不修改」。 */
export { SECRET_MASK } from '../shared/protocol.ts'
import { SECRET_MASK } from '../shared/protocol.ts'

export const CONFIG_VERSION = 1

export function defaultDataRoot(): string {
  // DSH_VIDEO_REPLICA_HOME 只用于测试 / 便携部署：把配置与产物整体搬进隔离目录。
  const override = (process.env.DSH_VIDEO_REPLICA_HOME ?? '').trim()
  if (override !== '') return override
  return join(homedir(), '.dsh', 'storages', 'dsh-video-replica')
}

function endpointDefaults(): EndpointConfig {
  return {
    source: 'custom',
    dshProvider: '',
    dshModel: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    protocol: 'chat',
    extraJson: '',
    timeoutSec: 120,
  }
}

export function defaultConfig(): PluginConfig {
  return {
    enabled: true,
    dataDir: '',
    imageFrameStyle: 'photo',
    imageProductMode: 'auto',
    rewriteMode: 'redesign',
    parser: {
      ...endpointDefaults(),
      source: 'custom',
      protocol: 'parser-json',
      timeoutSec: 120,
      mode: 'auto',
      videoUrlPath: '',
      cookiesFromBrowser: '',
      fallbackApiUrl: '',
      fallbackApiKey: '',
    },
    analyze: {
      ...endpointDefaults(),
      protocol: 'chat',
      timeoutSec: 300,
      frameCount: 12,
      maxFrameSide: 1024,
    },
    rewrite: { ...endpointDefaults(), protocol: 'chat', timeoutSec: 180 },
    image: { ...endpointDefaults(), protocol: 'openai-images', timeoutSec: 180 },
    video: {
      ...endpointDefaults(),
      protocol: 'openai-video',
      timeoutSec: 900,
      secondsPerSegment: 5,
      size: '720x1280',
      aspectRatio: 'source',
      pollSec: 5,
      concurrency: 2,
    },
    tts: {
      ...endpointDefaults(),
      protocol: 'openai-tts',
      timeoutSec: 180,
      voice: 'alloy',
      voiceAlt: '',
      speed: 1,
      enabled: true,
    },
    asr: {
      ...endpointDefaults(),
      protocol: 'openai-transcription',
      timeoutSec: 300,
      enabled: false,
      language: '',
    },
    media: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ytDlpPath: 'yt-dlp' },
    compose: {
      size: '',
      fps: 30,
      burnSubtitles: true,
      subtitleFontSize: 15,
      bgmPath: '',
      bgmVolume: 0.18,
      perSegmentTts: true,
      audioSource: 'tts',
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 递归合并：数组整体替换，对象逐键合并，其余以 incoming 为准。 */
function deepMerge<T>(base: T, incoming: unknown): T {
  if (!isRecord(base)) {
    return (incoming === undefined ? base : incoming) as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  const patch = isRecord(incoming) ? incoming : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value
  }
  return out as unknown as T
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(asString(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 收敛配置：保证界面可以乱填而宿主不会崩。 */
export function normalizeConfig(input: unknown): PluginConfig {
  const base = defaultConfig()
  const merged = deepMerge(base, input)

  const endpoint = (value: Partial<EndpointConfig> | undefined): EndpointConfig => ({
    source: asString(value?.source).trim() === 'dsh' ? 'dsh' : 'custom',
    dshProvider: asString(value?.dshProvider).trim(),
    dshModel: asString(value?.dshModel).trim(),
    apiUrl: asString(value?.apiUrl).trim(),
    apiKey: asString(value?.apiKey),
    model: asString(value?.model).trim(),
    protocol: asString(value?.protocol, 'chat').trim() || 'chat',
    extraJson: asString(value?.extraJson),
    timeoutSec: clampNumber(value?.timeoutSec, 120, 5, 3600),
  })

  const parserMode = asString(merged.parser?.mode, 'auto')
  return {
    enabled: merged.enabled !== false,
    dataDir: asString(merged.dataDir).trim(),
    imageFrameStyle: (['cartoon', 'illustration'].includes(asString(merged.imageFrameStyle))
      ? asString(merged.imageFrameStyle)
      : 'photo') as PluginConfig['imageFrameStyle'],
    imageProductMode: (['reference', 'text'].includes(asString(merged.imageProductMode))
      ? asString(merged.imageProductMode)
      : 'auto') as PluginConfig['imageProductMode'],
    rewriteMode: (asString(merged.rewriteMode) === 'faithful' ? 'faithful' : 'redesign') as PluginConfig['rewriteMode'],
    parser: {
      ...endpoint(merged.parser),
      // 解析接口是服务而不是模型，恒为手填。
      source: 'custom',
      dshProvider: '',
      dshModel: '',
      protocol: asString(merged.parser?.protocol, 'parser-json').trim() || 'parser-json',
      mode: (['auto', 'api', 'ytdlp', 'upload'].includes(parserMode) ? parserMode : 'auto') as PluginConfig['parser']['mode'],
      videoUrlPath: asString(merged.parser?.videoUrlPath).trim(),
      cookiesFromBrowser: asString(merged.parser?.cookiesFromBrowser).trim(),
      fallbackApiUrl: asString(merged.parser?.fallbackApiUrl).trim(),
      fallbackApiKey: asString(merged.parser?.fallbackApiKey),
    },
    analyze: {
      ...endpoint(merged.analyze),
      frameCount: Math.round(clampNumber(merged.analyze?.frameCount, 12, 3, 24)),
      maxFrameSide: Math.round(clampNumber(merged.analyze?.maxFrameSide, 1024, 256, 2048)),
    },
    rewrite: endpoint(merged.rewrite),
    image: {
      ...endpoint(merged.image),
      protocol: asString(merged.image?.protocol, 'openai-images').trim() || 'openai-images',
    },
    video: {
      ...endpoint(merged.video),
      protocol: asString(merged.video?.protocol, 'openai-video').trim() || 'openai-video',
      secondsPerSegment: Math.round(clampNumber(merged.video?.secondsPerSegment, 5, 2, 30)),
      size: asString(merged.video?.size, '720x1280').trim(),
      aspectRatio: (['source', '9:16', '16:9', '1:1', '3:4', '4:3', '21:9'] as const)
        .find(value => value === asString(merged.video?.aspectRatio, 'source')) ?? 'source',
      pollSec: Math.round(clampNumber(merged.video?.pollSec, 5, 1, 60)),
      concurrency: Math.round(clampNumber(merged.video?.concurrency, 2, 1, 8)),
    },
    tts: {
      ...endpoint(merged.tts),
      protocol: asString(merged.tts?.protocol, 'openai-tts').trim() || 'openai-tts',
      voice: asString(merged.tts?.voice, 'alloy').trim() || 'alloy',
      voiceAlt: asString(merged.tts?.voiceAlt, '').trim(),
      speed: clampNumber(merged.tts?.speed, 1, 0.5, 2),
      enabled: merged.tts?.enabled !== false,
    },
    asr: {
      ...endpoint(merged.asr),
      protocol: asString(merged.asr?.protocol, 'openai-transcription').trim() || 'openai-transcription',
      enabled: merged.asr?.enabled === true,
      language: asString(merged.asr?.language).trim(),
    },
    media: {
      ffmpegPath: asString(merged.media?.ffmpegPath, 'ffmpeg').trim() || 'ffmpeg',
      ffprobePath: asString(merged.media?.ffprobePath, 'ffprobe').trim() || 'ffprobe',
      ytDlpPath: asString(merged.media?.ytDlpPath, 'yt-dlp').trim() || 'yt-dlp',
    },
    compose: {
      size: asString(merged.compose?.size).trim(),
      fps: Math.round(clampNumber(merged.compose?.fps, 30, 12, 60)),
      burnSubtitles: merged.compose?.burnSubtitles !== false,
      subtitleFontSize: Math.round(clampNumber(merged.compose?.subtitleFontSize, 15, 8, 40)),
      bgmPath: asString(merged.compose?.bgmPath).trim(),
      bgmVolume: clampNumber(merged.compose?.bgmVolume, 0.18, 0, 1),
      perSegmentTts: merged.compose?.perSegmentTts !== false,
      audioSource: merged.compose?.audioSource === 'original' ? 'original' : 'tts',
    },
  }
}

/** 已设置的密钥路径集合（用于界面显示「已配置」）。 */
export function secretPaths(config: PluginConfig): string[] {
  const paths: string[] = []
  for (const key of ['parser', 'analyze', 'rewrite', 'image', 'video', 'tts', 'asr'] as const) {
    if (asString((config[key] as EndpointConfig).apiKey) !== '') paths.push(`${key}.apiKey`)
  }
  if (asString(config.parser.fallbackApiKey).trim() !== '') paths.push('parser.fallbackApiKey')
  return paths
}

function mask(value: string): string {
  if (value === '') return ''
  if (value.length <= 8) return SECRET_MASK
  return `${SECRET_MASK}${value.slice(-4)}`
}

/** 生成回读视图：密钥换掩码，附「是否已设置」。 */
export function toConfigView(config: PluginConfig, extras: Omit<ConfigView, 'config' | 'secrets'>): ConfigView {
  const masked = structuredClone(config) as PluginConfig & Record<string, unknown>
  const secrets: Record<string, boolean> = {}
  for (const key of ['parser', 'analyze', 'rewrite', 'image', 'video', 'tts', 'asr'] as const) {
    const target = masked[key] as EndpointConfig & { apiKey: string }
    const value = asString(target.apiKey)
    secrets[`${key}.apiKey`] = value !== ''
    target.apiKey = mask(value)
  }
  const fallbackKey = asString(masked.parser.fallbackApiKey)
  secrets['parser.fallbackApiKey'] = fallbackKey.trim() !== ''
  masked.parser.fallbackApiKey = mask(fallbackKey)
  return { config: masked, secrets, ...extras }
}

/** 把界面回传的掩码密钥替换成磁盘上的真值。 */
export function mergeSecrets(incoming: unknown, current: PluginConfig): unknown {
  if (!isRecord(incoming)) return incoming
  const out: Record<string, unknown> = { ...incoming }
  for (const key of ['parser', 'analyze', 'rewrite', 'image', 'video', 'tts', 'asr'] as const) {
    const section = out[key]
    if (!isRecord(section)) continue
    const apiKey = section.apiKey
    const next: Record<string, unknown> = typeof apiKey === 'string' && apiKey.startsWith(SECRET_MASK)
      ? { ...section, apiKey: asString((current[key] as EndpointConfig).apiKey) }
      : { ...section }
    // 解析接口还有一把备用 Key（不在 EndpointConfig 的 apiKey 字段上）。
    if (key === 'parser') {
      const fallback = next.fallbackApiKey
      if (typeof fallback === 'string' && fallback.startsWith(SECRET_MASK)) {
        next.fallbackApiKey = asString(current.parser.fallbackApiKey)
      }
    }
    out[key] = next
  }
  return out
}

/** 配置文件读写器（带缓存，同步路径由调用方保证串行）。 */
export class ConfigStore {
  private cache: PluginConfig | undefined
  private loading: Promise<PluginConfig> | undefined

  constructor(private readonly dataRootProvider: () => string) {}

  get configPath(): string {
    return join(this.dataRootProvider(), 'config.json')
  }

  async read(): Promise<PluginConfig> {
    if (this.cache !== undefined) return this.cache
    if (this.loading === undefined) {
      this.loading = this.load()
    }
    return await this.loading
  }

  private async load(): Promise<PluginConfig> {
    let parsed: unknown
    try {
      const text = await readFile(this.configPath, 'utf8')
      parsed = JSON.parse(text)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') console.warn('[dsh-video-replica] 配置读取失败，使用默认值：', messageOf(error))
      parsed = undefined
    }
    const config = normalizeConfig(parsed ?? {})
    this.cache = config
    // 首次运行把默认配置落盘，方便用户直接编辑文件。
    if (parsed === undefined) await this.save(config).catch(() => {})
    this.loading = undefined
    return config
  }

  /** 以「掩码保留 + 深度合并」的方式应用界面提交的补丁。 */
  async patch(incoming: unknown): Promise<PluginConfig> {
    const current = await this.read()
    const withSecrets = mergeSecrets(incoming, current)
    const next = normalizeConfig(deepMerge(current, withSecrets))
    await this.save(next)
    return next
  }

  async save(config: PluginConfig): Promise<void> {
    const file = this.configPath
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await chmod(file, 0o600).catch(() => {})
    this.cache = config
    this.loading = undefined
  }

  /** 设置页修改数据目录后强制重读。 */
  invalidate(): void {
    this.cache = undefined
    this.loading = undefined
  }
}
