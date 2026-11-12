/**
 * 按「接口地址 + 模型名」自动推断该用哪个协议，并给出常见提供商的推荐模型。
 *
 * 目标：使用者只需要填 baseURL + Key，点「检测模型」后从列表里选一个，
 * 协议自动跟着变，不用理解 openai-tts / chat-asr / volc-tts 这些名字。
 *
 * 这里是纯函数，浏览器与宿主共用（宿主用它做兜底，浏览器用它即时联动）。
 */

import type { StepId } from './types.ts'

/** 配置阶段（与设置页的 Stage 一致）。 */
export type ProviderStage = 'parser' | 'analyze' | 'rewrite' | 'image' | 'video' | 'tts' | 'asr'

export interface ProviderPreset {
  id: string
  label: string
  match: RegExp
  /** 该提供商在各阶段可用的模型（列给用户选，省得记版本号）。 */
  models: Partial<Record<ProviderStage, string[]>>
  /** 各阶段应使用的协议。 */
  protocols: Partial<Record<ProviderStage, string>>
  /** 该提供商需要额外说明时的一句话。 */
  note?: string
}

/**
 * 已知提供商预设。顺序敏感：越具体的越靠前。
 * 这里的模型列表是「常见可用」的起点，不是穷举；用户仍可手填。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openspeech',
    label: '火山豆包语音',
    match: /openspeech\.bytedance\.com/i,
    protocols: { tts: 'volc-tts', asr: 'volc-asr' },
    models: {
      tts: ['seed-tts-2.0'],
      asr: ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'],
    },
    note: '豆包语音要用「语音技术控制台」的 API Key（不是方舟的 ark- Key）。',
  },
  {
    id: 'ark',
    label: '火山方舟',
    match: /ark\.[\w.-]*volces\.com|\.volces\.com/i,
    protocols: { analyze: 'chat', rewrite: 'chat', image: 'openai-images', video: 'ark-seedance' },
    models: {
      analyze: [
        'doubao-seed-2-1-pro-260915',
        'doubao-seed-2-1-lite-260915',
        'doubao-seed-2-1-turbo-260628',
        'doubao-seed-2-0-pro-260428',
      ],
      rewrite: ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-1-pro-260915', 'doubao-seed-2-0-lite-260428'],
      image: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
      video: ['doubao-seedance-2-0-260128', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-1-0-pro-250528'],
    },
    note: '方舟的图片/视频/文本共用一个 Key；配音与语音识别不在方舟，要走「火山豆包语音」。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    match: /api\.openai\.com/i,
    protocols: { analyze: 'chat', rewrite: 'chat', image: 'openai-images', tts: 'openai-tts', asr: 'openai-transcription' },
    models: {
      analyze: ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini'],
      rewrite: ['gpt-4.1', 'gpt-4o-mini'],
      image: ['gpt-image-1', 'dall-e-3'],
      tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
      asr: ['whisper-1', 'gpt-4o-mini-transcribe'],
    },
  },
  {
    id: 'mimo',
    label: '小米 MiMo',
    match: /xiaomimimo\.com/i,
    protocols: { analyze: 'chat', rewrite: 'chat', tts: 'chat-tts', asr: 'chat-asr' },
    models: {
      analyze: ['mimo-v2.5'],
      rewrite: ['mimo-v2.5'],
      tts: ['mimo-v2.5-tts'],
      asr: ['mimo-v2.5-asr'],
    },
    note: 'MiMo 的配音/识别走聊天接口（chat-tts / chat-asr），音色填 mimo_default 等。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    match: /api\.deepseek\.com/i,
    protocols: { analyze: 'chat', rewrite: 'chat' },
    models: {
      analyze: ['deepseek-chat', 'deepseek-reasoner'],
      rewrite: ['deepseek-chat'],
    },
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / DashScope',
    match: /dashscope\.aliyuncs\.com/i,
    protocols: { analyze: 'chat', rewrite: 'chat', image: 'openai-images' },
    models: {
      analyze: ['qwen-vl-max', 'qwen-vl-plus'],
      rewrite: ['qwen-plus', 'qwen-max'],
      image: ['qwen-image-plus', 'wanx-v1'],
    },
  },
]

/** 按接口地址找已知提供商。 */
export function matchPreset(apiUrl: string): ProviderPreset | undefined {
  const url = apiUrl.trim()
  if (url === '') return undefined
  return PROVIDER_PRESETS.find(preset => preset.match.test(url))
}

/** 没有已知预设时，给一条通用的协议提示。 */
export function genericProtocol(stage: ProviderStage): string {
  switch (stage) {
    case 'analyze':
    case 'rewrite':
      return 'chat'
    case 'image':
      return 'openai-images'
    case 'video':
      return 'openai-video'
    case 'tts':
      return 'openai-tts'
    case 'asr':
      return 'openai-transcription'
    default:
      return 'chat'
  }
}

/**
 * 推断协议：先看提供商预设，再看模型名里的特征词，最后回退到通用协议。
 * 返回值一定是该阶段下拉里的合法值（调用方负责校验）。
 */
export function inferProtocol(stage: ProviderStage, apiUrl: string, model: string): string {
  const preset = matchPreset(apiUrl)
  if (preset !== undefined && preset.protocols[stage] !== undefined) {
    return preset.protocols[stage] as string
  }
  const name = model.toLowerCase()
  // 模型名兜底：不同网关混用时也能猜个八九不离十
  if (stage === 'tts') {
    if (/seed-tts|openspeech/.test(name)) return 'volc-tts'
    if (/mimo|chat/.test(name)) return 'chat-tts'
    return 'openai-tts'
  }
  if (stage === 'asr') {
    if (/seedasr|volc\./.test(name)) return 'volc-asr'
    if (/mimo/.test(name)) return 'chat-asr'
    return 'openai-transcription'
  }
  if (stage === 'image') return 'openai-images'
  if (stage === 'video') return /seedance/i.test(name) ? 'ark-seedance' : 'openai-video'
  return 'chat'
}

/** 该阶段能从 /models 列表里留下的模型名特征。 */
const STAGE_PATTERNS: Record<ProviderStage, RegExp | undefined> = {
  parser: undefined,
  analyze: /^(?!.*(embed|rerank|moderation|whisper|tts|asr|image|video|seedream|seedance)).*$/i,
  rewrite: /^(?!.*(embed|rerank|moderation|whisper|tts|asr|image|video|seedream|seedance)).*$/i,
  image: /seedream|image|dall-e|flux|imagen|glm-image|qwen-image|wanx|kolors|sd[0-9x]/i,
  video: /seedance|video|veo|kling|hailuo|wan[0-9]|cogvideo|hunyuan-video/i,
  tts: /tts|speech|voice|audio/i,
  asr: /asr|whisper|transcri/i,
}

/** 模型名是否可能属于该阶段（用于过滤 /models 返回）。 */
export function modelMatchesStage(stage: ProviderStage, modelId: string): boolean {
  const pattern = STAGE_PATTERNS[stage]
  if (pattern === undefined) return true
  return pattern.test(modelId)
}

/** 推荐模型：预设里的候选，加上按阶段过滤后的实际列表（去重、保序）。 */
export function suggestedModels(stage: ProviderStage, apiUrl: string, listed: string[]): string[] {
  const preset = matchPreset(apiUrl)
  const curated = preset?.models[stage] ?? []
  const filtered = listed.filter(item => modelMatchesStage(stage, item))
  const out: string[] = []
  for (const item of [...curated, ...filtered]) {
    if (!out.includes(item)) out.push(item)
  }
  return out
}

/** 阶段与设置页 Stage 的映射（导出方便调用方复用）。 */
export type SettingsStage = Exclude<ProviderStage, never>
export type { StepId }
