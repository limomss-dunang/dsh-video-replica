/**
 * 火山豆包语音协议回归测试（不联网）：
 * 验证 TTS 的请求体与 ASR 的二进制帧编解码是否符合官方文档。
 *
 * 用法：node --experimental-strip-types scripts/smoke-volc.mjs
 */

import { gzipSync } from 'node:zlib'
import {
  buildAudioFrame,
  buildFullClientRequest,
  buildHeader,
  parseServerFrame,
} from '../src/host/providers/volc.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`[volc] ✓ ${name}`)
    return
  }
  failures += 1
  console.log(`[volc] ✗ ${name}${detail === '' ? '' : `：${detail}`}`)
}

// 1) 通用 header：version=1, header size=1, message type / flags / serialization / compression
const header = buildHeader(0x1, 0x0, 0x1, 0x0)
check('header 长度 4 字节', header.length === 4, String(header.length))
check('header[0] = 0x11（version1 + headerSize1）', header[0] === 0x11, `0x${header[0].toString(16)}`)
check('header[1] = 0x10（full client request + 无序号）', header[1] === 0x10, `0x${header[1].toString(16)}`)
check('header[2] = 0x10（JSON + 不压缩）', header[2] === 0x10, `0x${header[2].toString(16)}`)

// 2) full client request：header + 4 字节长度 + JSON
const request = buildFullClientRequest({
  user: { uid: 'test' },
  audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
  request: { model_name: 'bigmodel', show_utterances: true },
})
const payloadSize = request.readUInt32BE(4)
check('full client request 带长度字段', payloadSize === request.length - 8, `${payloadSize} vs ${request.length - 8}`)
const payloadJson = JSON.parse(request.subarray(8).toString('utf8'))
check('full client request 是合法 JSON', payloadJson.request.model_name === 'bigmodel')
check('请求里带 show_utterances', payloadJson.request.show_utterances === true)

// 3) audio frame：header + 序号 + 长度 + PCM
const pcm = Buffer.alloc(6400, 0x01)
const audio = buildAudioFrame(pcm, 3, false)
check('audio frame 头部 0x21（audio only + 正序号）', audio[1] === 0x21, `0x${audio[1].toString(16)}`)
check('audio frame 序号 = 3', audio.readInt32BE(4) === 3, String(audio.readInt32BE(4)))
check('audio frame 长度 = 6400', audio.readUInt32BE(8) === 6400, String(audio.readUInt32BE(8)))
check('audio frame 总长 = 12 + 6400', audio.length === 12 + 6400, String(audio.length))

const last = buildAudioFrame(Buffer.alloc(0), -9, true)
check('最后一帧 flags=0x2', last[1] === 0x22, `0x${last[1].toString(16)}`)
check('最后一帧序号为负', last.readInt32BE(4) === -9, String(last.readInt32BE(4)))

// 4) 服务端响应解析（未压缩）
function serverFrame(json, { gzip = false, flags = 0x0 } = {}) {
  const body = Buffer.from(JSON.stringify(json), 'utf8')
  const payload = gzip ? gzipSync(body) : body
  const head = Buffer.from([0x11, (0x9 << 4) | flags, (0x1 << 4) | (gzip ? 0x1 : 0x0), 0x00])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, size, payload])
}

const parsed = parseServerFrame(serverFrame({
  result: {
    text: '你好世界',
    utterances: [
      { text: '你好', start_time: 0, end_time: 800 },
      { text: '世界', start_time: 800, end_time: 1500 },
    ],
  },
}))
check('解析 result.text', parsed.text === '你好世界', parsed.text)
check('解析 utterances 数量', parsed.utterances.length === 2, String(parsed.utterances.length))
check('分句时间戳（毫秒）', parsed.utterances[1]?.start_time === 800)

const gz = parseServerFrame(serverFrame({ result: { text: '压缩正常', utterances: [] } }, { gzip: true }))
check('支持 gzip 压缩的响应', gz.text === '压缩正常', gz.text)

const err = parseServerFrame(Buffer.from([
  0x11, (0xf << 4) | 0x0, 0x10, 0x00,
  0x00, 0x00, 0x00, 0x05,
  0x7b, 0x7d, 0x20, 0x20, 0x20,
]))
check('错误帧返回 error', typeof err.error === 'string', String(err.error).slice(0, 60))

// 5) 接口地址 + 模型 → 协议自动匹配
const { inferProtocol, matchPreset, modelMatchesStage, suggestedModels } = await import('../src/shared/provider-detect.ts')

check('火山方舟 → 生图协议', inferProtocol('image', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedream-5-0-260128') === 'openai-images')
check('火山方舟 → 生视频协议', inferProtocol('video', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seedance-2-0-260128') === 'ark-seedance')
check('火山方舟 → 文本协议', inferProtocol('analyze', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-lite-260915') === 'chat')
check('豆包语音 → TTS 协议', inferProtocol('tts', 'https://openspeech.bytedance.com', 'seed-tts-2.0') === 'volc-tts')
check('豆包语音 → ASR 协议', inferProtocol('asr', 'https://openspeech.bytedance.com', 'volc.seedasr.sauc.duration') === 'volc-asr')
check('小米 MiMo → chat-tts', inferProtocol('tts', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-tts') === 'chat-tts')
check('小米 MiMo → chat-asr', inferProtocol('asr', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-asr') === 'chat-asr')
check('OpenAI → whisper', inferProtocol('asr', 'https://api.openai.com/v1', 'whisper-1') === 'openai-transcription')
check('未知网关 → 通用回退', inferProtocol('tts', 'https://gateway.example.com/v1', 'some-tts') === 'openai-tts')
check('识别火山预设', matchPreset('https://ark.cn-beijing.volces.com/api/v3')?.id === 'ark')
check('识别豆包语音预设', matchPreset('https://openspeech.bytedance.com')?.id === 'openspeech')
check('模型按阶段过滤：seedream 属于生图', modelMatchesStage('image', 'doubao-seedream-5-0-260128'))
check('模型按阶段过滤：seedream 不属于生视频', !modelMatchesStage('video', 'doubao-seedream-5-0-260128'))
check('模型按阶段过滤：embedding 不属于文本', !modelMatchesStage('rewrite', 'text-embedding-3-large'))
const suggested = suggestedModels('image', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-seedream-4-0-250828', 'doubao-seedance-2-0-260128'])
check('推荐模型去重且保留预设顺序', suggested[0] === 'doubao-seedream-5-0-260128' && !suggested.includes('doubao-seedance-2-0-260128'), JSON.stringify(suggested))

// 6) 模型探测：对着本地假 /models 服务验证「列表 → 过滤 → 协议」
const http = await import('node:http')
const { probeModels } = await import('../src/host/providers/probe.ts')
const server = http.createServer((req, res) => {
  if ((req.url ?? '').startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'doubao-seedream-4-0-250828' },
      { id: 'doubao-seedance-2-0-260128' },
      { id: 'doubao-seed-2-1-lite-260915' },
      { id: 'text-embedding-3-large' },
    ] }))
    return
  }
  res.writeHead(404); res.end('{}')
})
await new Promise(resolve => server.listen(0, resolve))
const port = server.address().port
const fakeBase = `http://127.0.0.1:${port}/v1`
const probedImage = await probeModels({ stage: 'image', apiUrl: fakeBase, apiKey: 'k' })
check('探测生图模型并匹配协议', probedImage.protocol === 'openai-images' && probedImage.models.includes('doubao-seedream-4-0-250828'), JSON.stringify(probedImage.models))
const probedVideo = await probeModels({ stage: 'video', apiUrl: fakeBase, apiKey: 'k' })
check('探测生视频模型并匹配 Seedance 协议', probedVideo.protocol === 'ark-seedance' && probedVideo.models.includes('doubao-seedance-2-0-260128'))
const probedText = await probeModels({ stage: 'rewrite', apiUrl: fakeBase, apiKey: 'k' })
check('文本阶段过滤掉 embedding', !probedText.models.includes('text-embedding-3-large'), JSON.stringify(probedText.models))
const probedSpeech = await probeModels({ stage: 'tts', apiUrl: 'https://openspeech.bytedance.com', apiKey: 'k' })
check('豆包语音预设无需 /models', probedSpeech.protocol === 'volc-tts' && probedSpeech.models[0] === 'seed-tts-2.0')
server.close()

if (failures > 0) {
  console.log(`[volc] 失败 ${failures} 项`)
  process.exit(1)
}
console.log('[volc] 全部通过 ✓')
