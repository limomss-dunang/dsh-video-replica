/**
 * 界面文案（中 / 英）。跟随 DSH 界面语言切换；缺失键回落英文。
 */

export interface Copy {
  nav: string
  navTip: string
  session: string
  sessionTip: string
  title: string
  subtitle: string
  newRun: string
  start: string
  stop: string
  retry: string
  skip: string
  runStep: string
  runAll: string
  save: string
  saved: string
  saving: string
  cancel: string
  delete: string
  loading: string
  empty: string
  untitled: string
  steps: string
  history: string
  historyEmpty: string
  details: string
  logs: string
  logsEmpty: string
  models: string
  model: string
  status: string

  inputTitle: string
  inputTip: string
  urlLabel: string
  urlPlaceholder: string
  productBriefLabel: string
  productBriefPlaceholder: string
  autoAdvance: string
  localVideo: string
  localVideoTip: string
  productImages: string
  productImagesTip: string
  chooseVideo: string
  chooseImages: string
  createAndParse: string
  platform: string
  detected: string
  notRecognized: string

  analysisSummary: string
  hook: string
  scores: string
  dna: string
  shots: string
  frames: string
  styleTitle: string
  transcript: string
  transcriptMissing: string
  noAnalysis: string

  variants: string
  segmentTable: string
  voiceover: string
  onscreen: string
  visualPrompt: string
  placement: string
  duration: string
  shotLook: string
  activeDsh: string
  frameStyle: string
  productMode: string
  rewriteMode: string
  rewriteModeHint: string
  rewriteRedesign: string
  rewriteFaithful: string
  productModeHint: string
  productModeAuto: string
  productModeReference: string
  productModeText: string
  arkImageHint: string
  frameStyleHint: string
  frameStylePhoto: string
  frameStyleCartoon: string
  frameStyleIllustration: string
  activeCustom: string
  activeUnset: string
  selectVariant: string
  selected: string
  segmentsCount: string
  editHint: string

  refFrames: string
  refFramesTip: string
  regenerate: string
  matchMissing: string

  videoSegments: string
  videoSegmentsTip: string
  prompt: string
  generationMissing: string

  finalVideo: string
  download: string
  copy: string
  copied: string
  previewPrompts: string
  hidePrompts: string
  previewPromptsHint: string
  previewVariant: string
  previewProductMode: string
  running: string
  composeMissing: string
  burnedSubtitles: string
  withAudio: string
  withoutAudio: string

  settingsTitle: string
  settingsDesc: string
  parserSection: string
  analyzeSection: string
  rewriteSection: string
  imageSection: string
  videoSection: string
  ttsSection: string
  asrSection: string
  mediaSection: string
  composeSection: string
  apiUrl: string
  apiKey: string
  apiKeySet: string
  apiKeyUnset: string
  modelName: string
  protocol: string
  timeout: string
  extraJson: string
  test: string
  testing: string
  testOk: string
  testFail: string
  frameCount: string
  maxFrameSide: string
  secondsPerSegment: string
  size: string
  pollSec: string
  concurrency: string
  voice: string
  speed: string
  voiceAlt: string
  promptEdited: string
  stepStale: string
  aspectRatio: string
  aspectHint: string
  outputPrefs: string
  publishTitle: string
  publishDesc: string
  publishDescHint: string
  publishNow: string
  publishHint: string
  publishNeedBrowser: string
  publishedUrl: string
  publishScreenshot: string
  publishStatus: string
  openFolder: string
  runNext: string
  previewTts: string
  previewSubtitles: string
  previewTtsHint: string
  previewSubsHint: string
  copyPath: string
  captionGenerating: string
  captionRegenerate: string
  publishTopics: string
  captionHint: string
  captionFailed: string
  audioSource: string
  audioTts: string
  audioOriginal: string
  audioSourceHint: string
  enabled: string
  ffmpegPath: string
  ffprobePath: string
  ytDlpPath: string
  fps: string
  burnSubtitlesLabel: string
  subtitleFontSize: string
  bgmPath: string
  bgmVolume: string
  dataDir: string
  envStatus: string
  parserMode: string
  videoUrlPath: string
  browserCookies: string
  fallbackApiUrl: string
  fallbackApiKey: string
  language: string
  toolOk: string
  toolMissing: string
  sourceCustom: string
  sourceDsh: string
  sourceHint: string
  providerLabel: string
  refreshModels: string
  modelsLoading: string
  noDshModels: string
  dshNoRoute: string
  dshVisionHint: string
  dshAutoProtocol: string
  dshRouteReady: string
  useDefaultModel: string
}

export const zh: Copy = {
  nav: '视频复刻',
  navTip: '爆款视频复刻工作台',
  session: '会话',
  sessionTip: '返回会话',
  title: '爆款视频复刻',
  subtitle: '链接 → 拆解 → 仿写 → 参考图 → 分镜视频 → 成片',
  newRun: '新建复刻',
  start: '开始',
  stop: '停止',
  retry: '重试',
  skip: '跳过',
  runStep: '执行本步',
  runAll: '连续执行',
  save: '保存',
  saved: '已保存',
  saving: '保存中…',
  cancel: '取消',
  delete: '删除',
  loading: '加载中…',
  empty: '还没有内容',
  untitled: '未命名',
  steps: '流程',
  history: '历史任务',
  historyEmpty: '还没有历史任务',
  details: '详情',
  logs: '运行日志',
  logsEmpty: '暂无日志',
  models: '模型配置',
  model: '模型',
  status: '状态',

  inputTitle: '粘贴链接或上传视频',
  inputTip: '支持抖音、小红书、视频号、快手、B站分享链接；解析失败时可直接上传已下载的视频。',
  urlLabel: '分享链接',
  urlPlaceholder: '粘贴分享链接，例如 https://v.douyin.com/xxxxxxx/',
  productBriefLabel: '产品 / 卖点（可选）',
  productBriefPlaceholder: '例如：茉知味苹屿乌龙轻乳茶，卖点是国风轻乳茶、下午茶解腻',
  autoAdvance: '建好后自动连续执行',
  localVideo: '本地视频',
  localVideoTip: '上传后跳过链接解析，直接进入拆解（视频号推荐这种方式）',
  productImages: '产品参考图',
  productImagesTip: '上传产品图后，拆解会锁定产品外观，分镜会把产品融入画面',
  chooseVideo: '选择视频文件',
  chooseImages: '选择产品图',
  createAndParse: '创建并开始',
  platform: '平台',
  detected: '已识别',
  notRecognized: '没有识别到链接',

  analysisSummary: '一句话概括',
  hook: '开场钩子',
  scores: '评分',
  dna: '爆款 DNA',
  shots: '分镜拆解',
  frames: '抽帧',
  styleTitle: '风格与节奏',
  transcript: '口播文稿',
  transcriptMissing: '未配置语音识别：口播内容仅依据画面文字推断。到「设置 → 视频复刻 → 语音识别」配置后可显著提升还原度。',
  noAnalysis: '还没有拆解结果，先执行「AI 拆解」。',

  variants: '脚本版本',
  segmentTable: '分镜表（可直接编辑）',
  voiceover: '口播',
  onscreen: '大字',
  visualPrompt: '画面提示词',
  placement: '产品呈现',
  duration: '时长',
  shotLook: '景别 / 运镜',
  activeDsh: '当前生效：DSH 已配置模型',
  frameStyle: '首帧画风',
  productMode: '产品融入方式',
  rewriteMode: '仿写取向',
  rewriteModeHint: '默认「忠于原片」：保留题材、节令与桥段，只换台词与执行细节；「重新设计」只换桥段，核心机制与节令仍必须保留。每次任务可在「AI 仿写」页单独切换。',
  rewriteRedesign: '重新设计（推荐，不照抄内容）',
  rewriteFaithful: '结构照搬（同题材同桥段）',
  productModeHint: '只影响「首帧生成」：文生图产物的脸在方舟信任名单里；生视频时产品图仍会作为参考图传入',
  productModeAuto: '自动（Seedance + 写实 → 文生图）',
  productModeReference: '参考图（图生图，产品最准）',
  productModeText: '首帧用文字描述（不传产品图，Seedance 可信）',
  arkImageHint: '用火山方舟生图：地址填 https://ark.cn-beijing.volces.com/api/v3，协议选 openai-images，模型填 doubao-seedream-5-0-260128（与视频同一个 Key）。',
  frameStyleHint: 'Seedance 收写实人物；但「写实人物+产品」同框易被判含真实人物，此时可切卡通',
  frameStylePhoto: '写实摄影（Grok 等通用网关）',
  frameStyleCartoon: '3D 卡通（Seedance 推荐）',
  frameStyleIllustration: '国风插画',
  activeCustom: '当前生效：手动填写接口',
  activeUnset: '（尚未选择）',
  selectVariant: '选用这一版',
  selected: '已选用',
  segmentsCount: '个分镜',
  editHint: '修改后点「保存分镜」，参考图与分镜视频会按新内容重新生成',

  refFrames: '分镜参考图',
  refFramesTip: '产品图已融入每个分镜的关键帧，用于锁定视频生成时的产品外观',
  regenerate: '重新生成',
  matchMissing: '还没有参考图，先执行「参考图匹配」。',

  videoSegments: '分镜视频',
  videoSegmentsTip: '一镜一段（多镜塞进同一条视频会丢镜）；提示词可以直接改，改完点「用这段提示词重新生成」',
  prompt: '生成提示词',
  generationMissing: '还没有分镜视频，先执行「AI 生成视频」。',

  finalVideo: '成片',
  download: '下载',
  copy: '复制',
  copied: '已复制',
  previewPrompts: '预览提示词',
  hidePrompts: '收起提示词',
  previewPromptsHint: '只拼提示词，不调模型、不消耗额度',
  previewVariant: '版本',
  previewProductMode: '产品融入',
  running: '加载中…',
  composeMissing: '还没有成片，先执行「合成成片」。',
  burnedSubtitles: '已烧字幕',
  withAudio: '有音轨',
  withoutAudio: '无音轨',

  settingsTitle: '视频复刻配置',
  settingsDesc: '六步流水线各用哪个模型、走哪个网关都在这里配置。密钥只保存在本机，界面回读时以掩码显示。',
  parserSection: '① 解析下载',
  analyzeSection: '② AI 拆解（视觉模型）',
  rewriteSection: '③ AI 仿写（文本模型）',
  imageSection: '④ 参考图匹配（图像模型）',
  videoSection: '⑤ AI 生成视频',
  ttsSection: '⑥ 配音（TTS，可选）',
  asrSection: '语音识别（ASR，可选）',
  mediaSection: '本地工具',
  composeSection: '合成成片',
  apiUrl: '接口地址',
  apiKey: 'API Key',
  apiKeySet: '已配置（留空则保持不变）',
  apiKeyUnset: '未配置',
  modelName: '模型名',
  protocol: '协议',
  timeout: '超时（秒）',
  extraJson: '附加请求参数（JSON）',
  test: '测试',
  testing: '测试中…',
  testOk: '连通正常',
  testFail: '测试失败',
  frameCount: '抽帧数量',
  maxFrameSide: '单帧最长边',
  secondsPerSegment: '每段秒数',
  size: '分辨率 / 画幅',
  pollSec: '轮询间隔（秒）',
  concurrency: '并发生成数',
  voice: '音色',
  speed: '语速',
  voiceAlt: '配角音色',
  promptEdited: '已修改，点右侧按钮用新提示词重生成',
  stepStale: '需重新生成',
  aspectRatio: '画幅',
  aspectHint: '创建后全程按它出图/出片；改它会让首帧、视频、成片过期',
  outputPrefs: '输出偏好',
  publishTitle: '短标题（≤16 字）',
  publishDesc: '发布描述',
  publishDescHint: '视频号会把它作为动态文案；话题会在发布时自动拼到末尾。描述由 AI 生成，可自由改。',
  publishNow: '发布到视频号',
  publishHint: '点发布后会打开浏览器：未登录时用微信扫码，登录后自动上传成片、填描述并点发表。',
  publishNeedBrowser: '未检测到「dsh-browser-playwright-codex」插件：第七步需要它的浏览器服务。',
  publishedUrl: '作品链接',
  publishScreenshot: '发布截图',
  publishStatus: '发布状态',
  openFolder: '打开文件夹',
  runNext: '执行下一步',
  previewTts: '试听配音',
  previewSubtitles: '预览字幕',
  previewTtsHint: '只跑 TTS，按成片的音色逐段合成，不消耗视频/图片额度',
  previewSubsHint: '按脚本和分镜时长估算字幕时间轴，可直接核对断句与字号',
  copyPath: '复制路径',
  captionGenerating: '正在生成标题和话题…',
  captionRegenerate: '换一版文案',
  publishTopics: '话题',
  captionHint: '标题和话题由 AI 按这条片子的内容生成，可以改、也可以删掉某个话题。',
  captionFailed: '文案生成失败',
  audioSource: '成片音轨',
  audioTts: 'TTS 配音',
  audioOriginal: '分镜视频原声',
  audioSourceHint: '切换后需要重新执行「合成成片」',
  enabled: '启用',
  ffmpegPath: 'ffmpeg 路径',
  ffprobePath: 'ffprobe 路径',
  ytDlpPath: 'yt-dlp 路径',
  fps: '输出帧率',
  burnSubtitlesLabel: '烧录字幕',
  subtitleFontSize: '字幕字号',
  bgmPath: 'BGM 文件路径',
  bgmVolume: 'BGM 音量',
  dataDir: '数据目录',
  envStatus: '环境状态',
  parserMode: '解析模式',
  videoUrlPath: '视频地址字段路径（可选）',
  browserCookies: '读取浏览器 Cookie（yt-dlp）',
  fallbackApiUrl: '备用解析接口（可选）',
  fallbackApiKey: '备用接口 Key',
  language: '识别语言（可选）',
  toolOk: '可用',
  toolMissing: '不可用',
  sourceCustom: '手动填写接口',
  sourceDsh: 'DSH 已配置模型',
  sourceHint: 'DSH 已配置模型：直接使用「设置 → 模型」里配置的提供商与密钥，不需要在这里重复填写。',
  providerLabel: '提供商',
  refreshModels: '刷新模型',
  modelsLoading: '读取模型列表…',
  noDshModels: 'DSH 里还没有配置模型：请到「设置 → 模型」添加提供商与模型后回来刷新。',
  dshNoRoute: '该提供商在 DSH 配置里没有接口地址（baseURL），图片 / 视频 / 语音请求无法使用它。',
  dshVisionHint: '该模型未声明图片输入能力，用它做画面拆解可能失败。',
  dshAutoProtocol: '协议自动（OpenAI 兼容）',
  dshRouteReady: '接口地址已从 DSH 配置读取',
  useDefaultModel: '用 DSH 默认模型',
}

export const en: Copy = {
  nav: 'Video Replica',
  navTip: 'Viral video replica studio',
  session: 'Session',
  sessionTip: 'Back to session',
  title: 'Viral Video Replica',
  subtitle: 'Link → analyze → rewrite → keyframes → shots → final cut',
  newRun: 'New replica',
  start: 'Start',
  stop: 'Stop',
  retry: 'Retry',
  skip: 'Skip',
  runStep: 'Run step',
  runAll: 'Run all',
  save: 'Save',
  saved: 'Saved',
  saving: 'Saving…',
  cancel: 'Cancel',
  delete: 'Delete',
  loading: 'Loading…',
  empty: 'Nothing yet',
  untitled: 'Untitled',
  steps: 'Pipeline',
  history: 'History',
  historyEmpty: 'No runs yet',
  details: 'Details',
  logs: 'Logs',
  logsEmpty: 'No logs yet',
  models: 'Models',
  model: 'Model',
  status: 'Status',

  inputTitle: 'Paste a link or upload a video',
  inputTip: 'Supports Douyin, Xiaohongshu, WeChat Channels, Kuaishou and Bilibili links. Upload a downloaded file when parsing fails.',
  urlLabel: 'Share link',
  urlPlaceholder: 'Paste a share link, e.g. https://v.douyin.com/xxxxxxx/',
  productBriefLabel: 'Product / selling points (optional)',
  productBriefPlaceholder: 'e.g. Oolong milk tea, selling point: light and refreshing',
  autoAdvance: 'Run all steps automatically after creating',
  localVideo: 'Local video',
  localVideoTip: 'Skips link parsing and goes straight to analysis',
  productImages: 'Product images',
  productImagesTip: 'With product images, analysis locks the product look and each keyframe places it in the scene',
  chooseVideo: 'Choose video',
  chooseImages: 'Choose images',
  createAndParse: 'Create and start',
  platform: 'Platform',
  detected: 'Detected',
  notRecognized: 'No link recognized',

  analysisSummary: 'Summary',
  hook: 'Hook',
  scores: 'Scores',
  dna: 'Viral DNA',
  shots: 'Shot breakdown',
  frames: 'Frames',
  styleTitle: 'Style and rhythm',
  transcript: 'Transcript',
  transcriptMissing: 'No speech recognition configured: transcript is inferred from on-screen text only.',
  noAnalysis: 'No analysis yet — run “AI analysis”.',

  variants: 'Script versions',
  segmentTable: 'Storyboard (editable)',
  voiceover: 'Voiceover',
  onscreen: 'On-screen',
  visualPrompt: 'Visual prompt',
  placement: 'Product placement',
  duration: 'Duration',
  shotLook: 'Shot / Camera',
  activeDsh: 'Active: DSH provider',
  frameStyle: 'First-frame style',
  productMode: 'Product integration',
  rewriteMode: 'Rewrite mode',
  rewriteModeHint: 'Default "faithful": keep the subject and seasonal hook, change only wording and execution. "Redesign" changes beats but must keep the core mechanism and the occasion.',
  rewriteRedesign: 'Redesign (recommended)',
  rewriteFaithful: 'Faithful structure copy',
  productModeHint: 'Affects first-frame only: text-to-image output is trusted; product image is still sent as a video reference',
  productModeAuto: 'Auto (Seedance + photoreal → text-to-image)',
  productModeReference: 'Reference image (most accurate)',
  productModeText: 'First frame by text only (trusted by Seedance)',
  arkImageHint: 'ARK image: base URL https://ark.cn-beijing.volces.com/api/v3, protocol openai-images, model doubao-seedream-5-0-260128 (same key as video).',
  frameStyleHint: 'Seedance accepts photoreal people; photoreal person + product may be flagged — switch to cartoon then',
  frameStylePhoto: 'Photoreal (Grok etc.)',
  frameStyleCartoon: '3D cartoon (Seedance)',
  frameStyleIllustration: 'Chinese illustration',
  activeCustom: 'Active: custom endpoint',
  activeUnset: '(not set)',
  selectVariant: 'Use this version',
  selected: 'Selected',
  segmentsCount: 'segments',
  editHint: 'After editing, save to regenerate keyframes and shot videos',

  refFrames: 'Keyframes',
  refFramesTip: 'The product is composited into every keyframe to lock its look during video generation',
  regenerate: 'Regenerate',
  matchMissing: 'No keyframes yet — run “Keyframe matching”.',

  videoSegments: 'Shot videos',
  videoSegmentsTip: 'One shot per segment (packing several shots into one video drops shots); edit the prompt and click “Regenerate with this prompt”',
  prompt: 'Prompt',
  generationMissing: 'No shot videos yet — run “AI video”.',

  finalVideo: 'Final cut',
  download: 'Download',
  copy: 'Copy',
  copied: 'Copied',
  previewPrompts: 'Preview prompts',
  hidePrompts: 'Hide prompts',
  previewPromptsHint: 'Prompt only — no model call, no cost',
  previewVariant: 'Variant',
  previewProductMode: 'Product mode',
  running: 'Loading…',
  composeMissing: 'No final cut yet — run “Compose”.',
  burnedSubtitles: 'Subtitles burned',
  withAudio: 'With audio',
  withoutAudio: 'No audio',

  settingsTitle: 'Video Replica settings',
  settingsDesc: 'Configure the model and gateway used by each of the six steps. Keys stay on this machine and are shown masked.',
  parserSection: '① Parse and download',
  analyzeSection: '② AI analysis (vision model)',
  rewriteSection: '③ AI rewrite (text model)',
  imageSection: '④ Keyframes (image model)',
  videoSection: '⑤ AI video',
  ttsSection: '⑥ Voiceover (TTS, optional)',
  asrSection: 'Speech recognition (optional)',
  mediaSection: 'Local tools',
  composeSection: 'Compose',
  apiUrl: 'API URL',
  apiKey: 'API key',
  apiKeySet: 'Configured (leave blank to keep)',
  apiKeyUnset: 'Not configured',
  modelName: 'Model',
  protocol: 'Protocol',
  timeout: 'Timeout (s)',
  extraJson: 'Extra JSON params',
  test: 'Test',
  testing: 'Testing…',
  testOk: 'Connection OK',
  testFail: 'Test failed',
  frameCount: 'Frames',
  maxFrameSide: 'Max frame side',
  secondsPerSegment: 'Seconds per segment',
  size: 'Size / aspect',
  pollSec: 'Poll interval (s)',
  concurrency: 'Concurrency',
  voice: 'Voice',
  speed: 'Speed',
  voiceAlt: 'Supporting voice',
  promptEdited: 'Edited — regenerate with this prompt',
  stepStale: 'Needs re-run',
  aspectRatio: 'Aspect ratio',
  aspectHint: 'Used for every frame/video in this run; changing it marks them stale',
  outputPrefs: 'Output preferences',
  publishTitle: 'Short title (optional)',
  publishDesc: 'Post description',
  publishDescHint: 'Used as the post text; topics are appended when publishing. Generated by AI and editable.',
  publishNow: 'Publish to WeChat Channels',
  publishHint: 'Publishing opens a browser: scan the QR code if not signed in, then the plugin uploads the video, fills the description and clicks post.',
  publishNeedBrowser: 'dsh-browser-playwright-codex is not available: step 7 needs its browser service.',
  publishedUrl: 'Post URL',
  publishScreenshot: 'Screenshot',
  publishStatus: 'Publish status',
  openFolder: 'Open folder',
  runNext: 'Run next step',
  previewTts: 'Preview voiceover',
  previewSubtitles: 'Preview subtitles',
  previewTtsHint: 'Runs TTS only — same voices as the final cut, no image or video cost',
  previewSubsHint: 'Estimates subtitle timing from the script and shot durations',
  copyPath: 'Copy path',
  captionGenerating: 'Writing the title and topics…',
  captionRegenerate: 'Another version',
  publishTopics: 'Topics',
  captionHint: 'The title and topics are generated from this video; edit them freely or remove a topic.',
  captionFailed: 'Caption generation failed',
  audioSource: 'Audio source',
  audioTts: 'TTS voiceover',
  audioOriginal: 'Original video audio',
  audioSourceHint: 'Re-run “Compose” after switching',
  enabled: 'Enabled',
  ffmpegPath: 'ffmpeg path',
  ffprobePath: 'ffprobe path',
  ytDlpPath: 'yt-dlp path',
  fps: 'Output fps',
  burnSubtitlesLabel: 'Burn subtitles',
  subtitleFontSize: 'Subtitle size',
  bgmPath: 'BGM file path',
  bgmVolume: 'BGM volume',
  dataDir: 'Data directory',
  envStatus: 'Environment',
  parserMode: 'Parse mode',
  videoUrlPath: 'Video URL field path (optional)',
  browserCookies: 'Read browser cookies (yt-dlp)',
  fallbackApiUrl: 'Fallback parser URL (optional)',
  fallbackApiKey: 'Fallback parser key',
  language: 'Language (optional)',
  toolOk: 'available',
  toolMissing: 'missing',
  sourceCustom: 'Custom endpoint',
  sourceDsh: 'DSH configured model',
  sourceHint: 'Uses a provider and key already configured in Settings → Models, so nothing is retyped here.',
  providerLabel: 'Provider',
  refreshModels: 'Refresh models',
  modelsLoading: 'Reading model list…',
  noDshModels: 'No models configured in DSH yet. Add a provider in Settings → Models, then refresh here.',
  dshNoRoute: 'This provider has no baseURL in the DSH config, so image / video / speech requests cannot use it.',
  dshVisionHint: 'This model does not declare image input; frame analysis may fail.',
  dshAutoProtocol: 'Protocol automatic (OpenAI compatible)',
  dshRouteReady: 'Base URL read from the DSH config',
  useDefaultModel: 'Use DSH default model',
}

let current: Copy = zh

export function setLanguage(active: string): void {
  current = active.toLowerCase().startsWith('en') ? en : zh
}

export function tt<K extends keyof Copy>(key: K): string {
  return current[key] ?? zh[key] ?? String(key)
}

export function copy(): Copy {
  return current
}
