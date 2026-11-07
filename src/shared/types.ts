/**
 * dsh-video-replica — 宿主 / 浏览器共享的数据契约。
 *
 * 一条"复刻"运行（Run）固定六步，与参考实现 LeadStageAI 的 pipeline 对齐：
 *
 *   parse    解析分享链接并下载源视频（抖音 / 视频号 / 小红书 / 快手 / B站 / 直链 / 本地文件）
 *   analyze  抽帧 + 视觉模型逐镜拆解（钩子、结构、节奏、风格、爆款 DNA、评分）
 *   rewrite  基于拆解结果仿写 3 版口播脚本（A/B/C 角度）
 *   match    产品图融入分镜：为每个分镜生成一张参考首帧图
 *   generate 以参考首帧 + 分镜提示词生成分镜视频
 *   compose  ffmpeg 拼接 + 配音(TTS) + 字幕 + 可选 BGM → final.mp4
 *
 * 每一步都可独立重跑；运行状态全部落盘，刷新页面不丢。
 */

// ---------------------------------------------------------------------------
// 平台
// ---------------------------------------------------------------------------

export type Platform = 'douyin' | 'xiaohongshu' | 'channels' | 'kuaishou' | 'bilibili' | 'direct' | 'upload' | 'other'

export const PLATFORM_LABELS: Record<Platform, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  channels: '视频号',
  kuaishou: '快手',
  bilibili: 'B站',
  direct: '视频直链',
  upload: '本地视频',
  other: '其他',
}

// ---------------------------------------------------------------------------
// 步骤
// ---------------------------------------------------------------------------

export type StepId = 'parse' | 'analyze' | 'rewrite' | 'match' | 'generate' | 'compose' | 'publish'

/** 景别白名单（host 提示词与客户端编辑器共用）。 */
export const SHOT_TYPES = ['特写', '近景', '中近景', '中景', '全景', '远景'] as const
/** 运镜白名单：一镜只用一种。 */
export const CAMERA_MOVES = ['固定', '缓慢推近', '缓慢拉远', '横摇', '跟拍', '环绕', '手持', '拉焦'] as const

export const STEP_IDS: StepId[] = ['parse', 'analyze', 'rewrite', 'match', 'generate', 'compose', 'publish']

/** 只能手动点、不参与自动连续执行的步骤（发布对外有副作用）。 */
export const MANUAL_STEP_IDS: StepId[] = ['publish']

export const STEP_LABELS: Record<StepId, string> = {
  parse: '解析下载',
  analyze: 'AI 拆解',
  rewrite: 'AI 仿写',
  match: '参考图匹配',
  generate: 'AI 生成视频',
  compose: '合成成片',
  publish: '一键发布',
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StepState {
  /** 上游产物变了，这一步的结果已过期，需要重新执行。 */
  stale?: boolean
  id: StepId
  status: StepStatus
  /** 0..1；-1 表示不确定进度（长任务）。 */
  progress: number
  /** 面向用户的一行状态说明。 */
  message?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

// ---------------------------------------------------------------------------
// 第 1 步：源视频
// ---------------------------------------------------------------------------

export type ParseProvider = 'api' | 'ytdlp' | 'direct' | 'upload'

export interface SourceMeta {
  platform: Platform
  provider: ParseProvider
  /** 运行目录内的相对文件名，例如 source.mp4 */
  videoFile: string
  /** 源视频的绝对路径（下载落盘后写入，界面直接展示/复制）。 */
  filePath?: string
  coverFile?: string
  title: string
  author?: string
  /** 源视频时长（秒）。 */
  durationSec?: number
  width?: number
  height?: number
  fps?: number
  /** 原作者主页 / 原始链接。 */
  sourceUrl?: string
  /** 解析器返回的原始元数据摘要（截断后保留，便于排障）。 */
  raw?: string
  /** 是否已做抽帧封面。 */
  thumbFile?: string
}

// ---------------------------------------------------------------------------
// 第 2 步：拆解报告
// ---------------------------------------------------------------------------

export interface AnalysisShot {
  index: number
  /** 镜头起止秒。 */
  startSec: number
  endSec: number
  /** 景别 / 镜头语言，例如"特写推镜"。 */
  shotType: string
  camera: string
  /** 画面内容描述。 */
  visual: string
  /** 光线：方向 / 色温 / 明暗（写可见事实，不写"电影感"）。 */
  lighting: string
  /** 环境动态：雨、风、烟、衣摆、人群、灯光变化等。 */
  environment: string
  /** 该镜头对应的口播文案（听不清则给"无"）。 */
  voiceover: string
  /** 画面上的大字/字幕。 */
  onscreenText: string
  /** 情绪 / 功能（钩子、痛点、卖点、证明、行动号召…）。 */
  emotion: string
  purpose: string
}

export interface AnalysisScores {
  hook: number
  retention: number
  conversion: number
  overall: number
}

export interface AnalysisReport {
  /** 一句话说清这条片子真正在做什么（不是内容摘要，而是创意主张/把戏）。 */
  coreIdea: string
  /** 创意手法：抽象到可跨题材迁移的那一条（例：把隐喻字面化、把类型套路实体化反讽）。 */
  creativeDevice: string
  /** 为什么成立：预期违背的机制、情绪节奏、观众代入点。 */
  whyItWorks: string
  meta: {
    durationSec: number
    shotCount: number
    resolution: string
    fps: number
    style: string
    pacing: string
    /** 镜头语言/视角：鱼眼超广角、门禁摄像头、监控机位、第一人称、俯拍…没有特殊镜头时为空。 */
    lens?: string
  }
  /** 一句话概括这条视频靠什么爆。 */
  summary: string
  /** 主角外形身份证（物种/毛色/花纹/眼睛/体型/配饰），用于角色锚点与逐镜一致性。 */
  subjectIdentity?: string
  /** 需要锁定的角色清单（1–3 个）；每个角色一张锚点图，逐镜保持一致。 */
  characters?: Array<{ name: string, identity: string }>
  /**
   * 节令/时效钩子：这条片子必须在这个时间点发才成立的原因。
   * 例：万圣节（临近节日，萌宠装扮讨糖）／春节／开学季／双11／热点事件。
   * 没有时效依赖时为空。
   */
  occasion?: { name: string, why: string }
  hook: {
    type: string
    text: string
    whyItWorks: string
    seconds: number
  }
  shots: AnalysisShot[]
  rhythm: {
    avgShotSec: number
    beatPattern: string
    cutPoints: number[]
  }
  style: {
    palette: string[]
    typography: string
    music: string
    colorGrade: string
    subject: string
  }
  /** 可复用的"爆款 DNA"清单。 */
  dna: string[]
  scores: AnalysisScores
  /** ASR 得到的口播文稿（未配置语音识别时为空）。 */
  transcript?: TranscriptCue[]
  /** 口播类型判定：spoken=有人说话，sung=只是歌，none=无口播。 */
  voiceKind?: 'spoken' | 'sung' | 'none'
  /** 抽帧文件名（相对运行目录），供 UI 展示。 */
  frameFiles: string[]
  /** 拆解耗时（毫秒）与所用模型，便于排障。 */
  model?: string
  analyzedAt: number
}

// ---------------------------------------------------------------------------
// 第 3 步：仿写脚本
// ---------------------------------------------------------------------------

export interface ScriptSegment {
  index: number
  startSec: number
  endSec: number
  /** 景别：特写 / 近景 / 中近景 / 中景 / 全景 / 远景。 */
  shotType: string
  /** 运镜：固定 / 缓慢推近 / 缓慢拉远 / 跟拍 / 横摇 / 环绕 / 手持 / 拉焦。每镜只用一种。 */
  camera: string
  /** 口播文案（第一句、短句化，单句 ≤15 汉字）。 */
  voiceover: string
  /** 画面大字 / 字幕。 */
  onscreenText: string
  /** 画面提示词：给图像/视频模型的画面描述（不含产品名时用"产品"指代）。 */
  visualPrompt: string
  /** 本镜光线（按新场景写，不要照抄源片）。 */
  lighting: string
  /** 本镜环境动态（按新场景写）。 */
  environment: string
  /** 本镜情绪（期待/疑惑/无语/气急败坏/认命…），同时驱动配音语气。 */
  emotion: string
  /** 本镜台词由谁说（角色名，如 柴犬/老板/同事）；空 = 主角。 */
  speaker: string
  /** 产品在本镜头的呈现方式。 */
  productPlacement: string
}

export interface ScriptVariant {
  id: string
  /** 创作角度，例如"痛点前置"。 */
  angle: string
  title: string
  hookLine: string
  totalDurationSec: number
  segments: ScriptSegment[]
  notes?: string
}

/** 仿写自检：模型必须回报保留了哪些东西（防止把节令/主体/核心关系换掉）。 */
export interface RewriteChecks {
  keptCoreIdea?: string
  keptOccasion?: string
  keptSubject?: string
  changed?: string
}

export interface ScriptSet {
  variants: ScriptVariant[]
  recommendedId: string
  checks?: RewriteChecks
  /** 由用户填写的产品/卖点简述，仿写时作为约束。 */
  productBrief: string
  model?: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 第 4 步：参考图（产品融入分镜）
// ---------------------------------------------------------------------------

export interface ProductImage {
  /** 运行目录内相对文件名。 */
  file: string
  name: string
  bytes: number
  createdAt: number
}

export interface StoryboardFrame {
  segmentIndex: number
  /** 运行目录内相对文件名（frames/ref-01.png 之类）。 */
  file: string
  prompt: string
  /** product = 产品已融入画面；scene = 仅场景（未上传产品图时）。 */
  mode: 'product' | 'scene'
  /** 生成失败时的原因；存在则 file 可能为空。 */
  error?: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// 第 5 步：分镜视频
// ---------------------------------------------------------------------------

export type SegmentStatus = 'pending' | 'running' | 'done' | 'failed'

export interface SegmentVideo {
  segmentIndex: number
  status: SegmentStatus
  /** 本段包含的分镜序号（1 起），一次生成最多 5 镜。 */
  shots?: number[]
  /** 运行目录内相对文件名。 */
  file?: string
  durationSec?: number
  prompt?: string
  /** 使用的参考图（相对文件名）。 */
  referenceFile?: string
  error?: string
  startedAt?: number
  endedAt?: number
}

// ---------------------------------------------------------------------------
// 第 6 步：成片
// ---------------------------------------------------------------------------

export interface ComposeResult {
  file: string
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
  burnedSubtitles: boolean
  bgm: boolean
  /** 合成用到的中间产物说明（配音文件、字幕文件）。 */
  artifacts: string[]
  createdAt: number
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

export interface RunLogEntry {
  at: number
  step: StepId | 'run'
  level: 'info' | 'warn' | 'error'
  text: string
}

/** 支持的发布平台（先只做视频号）。 */
export type PublishPlatform = 'channels'

export const PUBLISH_PLATFORMS: Array<{ value: PublishPlatform, label: string, loginUrl: string, createUrl: string }> = [
  {
    value: 'channels',
    label: '视频号',
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    createUrl: 'https://channels.weixin.qq.com/platform/post/create',
  },
]

export type PublishStatus = 'idle' | 'waiting-login' | 'uploading' | 'publishing' | 'done' | 'failed'

/** 发布文案（标题 / 话题 / 描述），由文本模型生成后可手动改。 */
export interface PublishCaption {
  title: string
  description: string
  topics: string[]
  model?: string
  at: number
}

/** 一次发布的运行状态（落盘，刷新不丢）。 */
export interface PublishState {
  platform: PublishPlatform
  status: PublishStatus
  message: string
  title?: string
  description?: string
  /** 发布后页面上取到的作品链接（拿得到才有）。 */
  postUrl?: string
  /** 自动生成的发布文案（标题 / 话题 / 描述）。 */
  caption?: PublishCaption
  /** 最终话题（用户在界面上删改后的结果）。 */
  topics?: string[]
  /** 关键步骤截图（运行目录内相对路径）。 */
  screenshot?: string
  startedAt?: number
  endedAt?: number
  error?: string
}

export interface RunState {
  id: string
  /** 本次任务的运行目录绝对路径（素材、成片、日志都在它下面）。 */
  workDir?: string
  title: string
  createdAt: number
  updatedAt: number
  /** 用户粘贴的原始链接（upload 时为空）。 */
  sourceUrl?: string
  /** 当前选中的脚本版本（rewrite 之后）。 */
  variantId?: string
  /** 产品/卖点简述。 */
  productBrief?: string
  /** 视觉模型对产品参考图的客观描述（生成提示词里复述外观用）。 */
  productVisual?: string
  /** 是否自动连续跑完六步。 */
  autoAdvance: boolean
  /** 成片音轨来源：TTS 配音 或 分镜视频原声；缺省跟随配置。 */
  audioSource?: 'tts' | 'original'
  /** 成片画幅：创建时选好，后续步骤全程按它出图/出片。 */
  aspectRatio?: AspectRatio
  /** 角色锚点：纯复刻时先生成一张角色设定图，后续每个分镜都以它为参考，保证同一个角色。 */
  subject?: { description: string, anchorFile: string, createdAt: number }
  /** 多角色锚点：每个需要锁定的角色各一张设定图。 */
  subjects?: Array<{ name: string, description: string, anchorFile: string, createdAt: number }>
  /** 第七步：一键发布的运行状态。 */
  publish?: PublishState
  /** 本次仿写方式覆盖（不填则用设置里的全局默认）。 */
  rewriteMode?: RewriteMode
  /**
   * 字幕文案来源（原声模式生效）：
   * - `asr`：如实转写分镜原声（默认）；
   * - `script`：用脚本台词，时间仍按原声语音窗口对齐。
   */
  subtitleText?: 'asr' | 'script'
  steps: StepState[]
  source?: SourceMeta
  analysis?: AnalysisReport
  scripts?: ScriptSet
  productImages: ProductImage[]
  frames: StoryboardFrame[]
  segments: SegmentVideo[]
  compose?: ComposeResult
  logs: RunLogEntry[]
  /** 整体状态：空闲等待用户、执行中、结束。 */
  status: 'idle' | 'running' | 'stopped' | 'done' | 'failed'
  /** 最近一次失败摘要。 */
  error?: string
}

export interface RunSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  platform?: Platform
  status: RunState['status']
  currentStep: StepId
  /** 已完成步数 / 6。 */
  completed: number
  thumbFile?: string
  finalFile?: string
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 模型来源：custom=手填接口地址与密钥；dsh=直接用 DSH「模型」设置里已配置的提供商 + 模型。 */
export type ModelSource = 'custom' | 'dsh'

/** 一步所调用的模型端点（OpenAI 兼容或对应厂商原生协议）。 */
export interface EndpointConfig {
  /** 模型来源；source=dsh 时忽略 apiUrl / apiKey / model，改用 dshProvider + dshModel。 */
  source: ModelSource
  /** DSH 已配置的提供商 id（source=dsh 时生效）。 */
  dshProvider: string
  /** DSH 已配置的模型 id（source=dsh 时生效）。 */
  dshModel: string
  apiUrl: string
  apiKey: string
  model: string
  /**
   * 协议族：
   * - chat: OpenAI 兼容 /chat/completions（视觉模型同此，图片以 image_url 传入）
   * - openai-images: /images/generations 与 /images/edits
   * - ark-seedance: 火山方舟 /contents/generations/tasks（Seedance 2.0）
   * - openai-video: 通用 /videos + /videos/{id} 轮询
   * - openai-tts: /audio/speech
   */
  protocol: string
  /** 追加进请求体的 JSON（网关私有参数），解析失败则忽略。 */
  extraJson?: string
  /** 单次请求超时（秒）。 */
  timeoutSec?: number
}

export interface ParserConfig extends EndpointConfig {
  /** auto = 直链 → API → yt-dlp 依次尝试；也可强制某一种。 */
  mode: 'auto' | 'api' | 'ytdlp' | 'upload'
  /** 解析接口返回体里视频地址的字段路径提示（可选，留空自动识别）。 */
  videoUrlPath?: string
  /**
   * 让 yt-dlp 从浏览器读 cookie（edge / chrome / firefox / brave …）。
   * 抖音现在基本要求「新鲜 cookie」才能下载，留空则不读。
   */
  cookiesFromBrowser?: string
  /** 备用解析接口：主接口失败（服务异常/鉴权/超时）时自动切过去再试。 */
  fallbackApiUrl?: string
  /** 备用解析接口的 Key。 */
  fallbackApiKey?: string
}

export interface AnalyzeConfig extends EndpointConfig {
  /** 均匀抽帧数量（6–16）。 */
  frameCount: number
  /** 送入模型的单帧最长边像素。 */
  maxFrameSide: number
}

/** 首帧画风。 */
export type FrameStyle = 'photo' | 'cartoon' | 'illustration'

/**
 * 产品融入方式：
 * - `reference` 传产品参考图（图生图），产品最准；
 * - `text` 只用文字描述产品做**文生图**——方舟只信任 Seedream 文生图产物，
 *   图生图产物会被当「疑似真实人物」拦掉（见 docs/MODELS.md 实测表）；
 * - `auto` 视频走 ark-seedance 且画风为写实时自动用 text，其它情况用 reference。
 */
export type ImageProductMode = 'auto' | 'reference' | 'text'

/**
 * 仿写取向：
 * - `redesign` 提炼源片的创意机制（钩子/节奏/情绪/反转），换题材、角色、场景重新设计（默认）；
 * - `faithful` 结构照搬（同题材同桥段，只换产品/口播），仅用于明确的“整活复刻”。
 */
export type RewriteMode = 'redesign' | 'faithful'

export interface VideoConfig extends EndpointConfig {
  /** 默认画幅（创建运行时可用项目级值覆盖）。 */
  aspectRatio: AspectRatio
  /** 每个分镜生成的秒数（多数模型 5/10）。 */
  secondsPerSegment: number
  /** 生成分辨率，如 720x1280 / 1080x1920 / 9:16。 */
  size: string
  /** 轮询间隔（秒）。 */
  pollSec: number
  /** 并行生成的并发数。 */
  concurrency: number
}

export interface TtsConfig extends EndpointConfig {
  /** 主角音色（留空由网关自动挑）。 */
  voice: string
  /** 配角音色（老板/同事等非主角台词用它；留空则沿用主角音色）。 */
  voiceAlt: string
  /** 语速，1 为正常。 */
  speed: number
  enabled: boolean
}

/** 语音识别（可选）：把源视频音轨转成口播文稿，供拆解/仿写用。 */
export interface AsrConfig extends EndpointConfig {
  enabled: boolean
  /** 语言提示，留空自动。 */
  language: string
}

export interface TranscriptCue {
  startSec: number
  endSec: number
  text: string
}

export interface MediaConfig {
  ffmpegPath: string
  ffprobePath: string
  ytDlpPath: string
}

export interface ComposeConfig {
  /** 输出宽 x 高；留空沿用分镜视频尺寸。 */
  size: string
  fps: number
  /** 是否把字幕烧进画面。 */
  burnSubtitles: boolean
  subtitleFontSize: number
  /** 可选 BGM 文件绝对路径。 */
  bgmPath: string
  bgmVolume: number
  /** 是否让每个分镜口播单独合成后按镜头顺序拼接。 */
  perSegmentTts: boolean
  /** 默认音轨来源：tts 配音 或 original 视频原声。 */
  audioSource: 'tts' | 'original'
}

export interface PluginConfig {
  enabled: boolean
  /** 数据根目录；留空用 ~/.dsh/storages/dsh-video-replica */
  dataDir: string
  /** 默认是否跳过分镜视频生成，仅做拆解仿写（省额度）。 */
  parser: ParserConfig
  analyze: AnalyzeConfig
  rewrite: EndpointConfig
  image: EndpointConfig
  video: VideoConfig
  tts: TtsConfig
  asr: AsrConfig
  media: MediaConfig
  compose: ComposeConfig
  /** 首帧画风（④ 参考图匹配用）。 */
  imageFrameStyle: FrameStyle
  /** 产品融入方式（④ 参考图匹配用）。 */
  imageProductMode: ImageProductMode
  /** 仿写取向（③ AI 仿写用）。 */
  rewriteMode: RewriteMode
}

/** 设置页读回的配置：密钥被替换为掩码，并给出是否已设置。 */
export interface ConfigView {
  config: PluginConfig
  secrets: Record<string, boolean>
  dataDir: string
  ffmpegAvailable: boolean
  ffprobeAvailable: boolean
  ytDlpAvailable: boolean
}

// ---------------------------------------------------------------------------
// DSH 已配置模型目录
// ---------------------------------------------------------------------------

/** DSH 里某个提供商下可选的模型。 */
export interface DshModelOption {
  id: string
  name: string
  /** 输入模态，例如 ['text','image']；提供商没声明时为空数组。 */
  modalities: string[]
}

/** DSH「模型」设置里已配置的一个提供商。 */
export interface DshProviderOption {
  id: string
  name: string
  models: DshModelOption[]
  /** 能否从 DSH 配置里解析出接口地址（图片/视频等自建请求需要）。 */
  routeReady: boolean
  /** 取模型或取路由失败时的原因（界面提示用）。 */
  error?: string
}

/** 设置页用来渲染「DSH 已配置模型」选择器的目录。 */
export interface DshModelCatalog {
  providers: DshProviderOption[]
  /** DSH 当前默认模型（设置 → 模型里的默认选择）。 */
  default?: { provider: string; model: string }
  /** 整体性错误（例如没有 llm 服务）。 */
  errors: string[]
}

// ---------------------------------------------------------------------------
// 请求 / 响应
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  url?: string
  productBrief?: string
  autoAdvance?: boolean
  /** 上传本地视频时由 upload 接口先写入运行目录。 */
  uploadId?: string
}

export interface RunActionRequest {
  runId: string
  action:
    | 'start'
    | 'step'
    | 'retry-step'
    | 'skip-step'
    | 'stop'
    | 'select-variant'
    | 'update-segments'
    | 'delete'
    | 'regenerate-frame'
    | 'regenerate-segment'
  /** 目标步骤（step / retry-step / skip-step 用）。 */
  step?: StepId
  /** select-variant 用。 */
  variantId?: string
  /** update-segments 用（整段替换选中版本的分镜）。 */
  segments?: ScriptSegment[]
  /** regenerate-* 用。 */
  segmentIndex?: number
  /** 覆盖生成提示词（可选）。 */
  prompt?: string
}

export interface ApiEnvelope<T = unknown> {
  ok: boolean
  error?: string
  code?: string
  value?: T
}

// ---------------------------------------------------------------------------
// 路由常量（浏览器 / 宿主共用；宿主只注册这些 loopback 路径）
// ---------------------------------------------------------------------------

export const API_ROOT = '/api/dsh-video-replica'

export const API = {
  config: `${API_ROOT}/config`,
  configTest: `${API_ROOT}/config/test`,
  detect: `${API_ROOT}/detect`,
  runs: `${API_ROOT}/runs`,
  run: `${API_ROOT}/run`,
  runAction: `${API_ROOT}/run/action`,
  upload: `${API_ROOT}/upload`,
  media: `${API_ROOT}/media`,
  models: `${API_ROOT}/models`,
} as const

/** 成片画幅：source = 跟随源片，其余为显式比例。 */
export type AspectRatio = 'source' | '9:16' | '16:9' | '1:1' | '3:4' | '4:3' | '21:9'

export const ASPECT_RATIOS: Array<{ value: AspectRatio, label: string, size: string }> = [
  { value: 'source', label: '跟随源片', size: '' },
  { value: '9:16', label: '9:16 竖屏', size: '720x1280' },
  { value: '16:9', label: '16:9 横屏', size: '1280x720' },
  { value: '1:1', label: '1:1 方形', size: '720x720' },
  { value: '3:4', label: '3:4 竖版', size: '720x960' },
  { value: '4:3', label: '4:3 横版', size: '960x720' },
  { value: '21:9', label: '21:9 宽银幕', size: '1680x720' },
]

/** 按画幅取值换算成实际像素尺寸（source 时用源片宽高）。 */
export function aspectSizeOf(
  value: AspectRatio | undefined,
  source?: { width?: number, height?: number },
): { width: number, height: number } {
  const found = ASPECT_RATIOS.find(item => item.value === (value ?? 'source'))
  if (found !== undefined && found.size !== '') {
    const [w, h] = found.size.split('x').map(Number)
    return { width: w, height: h }
  }
  return { width: source?.width ?? 720, height: source?.height ?? 1280 }
}
