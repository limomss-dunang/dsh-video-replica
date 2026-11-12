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

if (failures > 0) {
  console.log(`[volc] 失败 ${failures} 项`)
  process.exit(1)
}
console.log('[volc] 全部通过 ✓')
