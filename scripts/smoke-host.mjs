// 宿主半边的端到端冒烟测试：真实 ffmpeg + 本地 mock 模型网关。
//
// 验证链路：apply → 桥接路由 → 建运行 → 上传源视频 → 六步流水线（拆解/仿写/
// 参考图/分镜视频/合成）→ final.mp4 落盘与 Range 播放。
//
// 用法：node scripts/smoke-host.mjs
// 说明：配置与产物写在系统临时目录（DSH_VIDEO_REPLICA_HOME），不碰用户真实配置。
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args) => console.log('[smoke]', ...args)

function ffmpeg(args, label) {
  const result = spawnSync(FFMPEG, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label ?? 'ffmpeg'} 失败：${(result.stderr ?? '').slice(-800)}`)
  return result
}

function probe(file) {
  const result = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`ffprobe 失败：${result.stderr}`)
  return JSON.parse(result.stdout)
}

const root = await mkdtemp(join(tmpdir(), 'dvr-smoke-'))
process.env.DSH_VIDEO_REPLICA_HOME = root
log('临时数据目录', root)

// ---------------------------------------------------------------- 素材
const sourceMp4 = join(root, 'fixture-source.mp4')
ffmpeg([
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=6',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', sourceMp4,
], '生成源视频素材')

const resultMp4 = join(root, 'fixture-result.mp4')
ffmpeg([
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', resultMp4,
], '生成分镜视频素材')

const ttsWav = join(root, 'fixture-tts.wav')
ffmpeg([
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
  '-c:a', 'pcm_s16le', ttsWav,
], '生成配音素材')

const productPng = join(root, 'fixture-product.png')
ffmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=orange:s=256x256', '-frames:v', '1', productPng], '生成产品图素材')
const productPngBytes = await readFile(productPng)
const pngB64 = productPngBytes.toString('base64')

// ---------------------------------------------------------------- mock 网关
const ANALYSIS = {
  videoType: 'product_showcase',
  hasHumanSubject: false,
  visualStyle: '实拍写实',
  summary: '用高对比色块和快切节奏在 2 秒内抛出价格反差钩子。',
  hook: { type: '反差', text: '这个价格你敢信？', whyItWorks: '先立价格锚点再反转，制造停留。', seconds: 2 },
  shots: [
    { index: 1, startSec: 0, endSec: 2, shotType: '特写', camera: '缓慢推近', visual: '产品特写亮起', lighting: '左侧柔和窗光', environment: '杯口蒸汽缓慢上升', voiceover: '这个价格你敢信', onscreenText: '你敢信？', emotion: '惊讶', purpose: '钩子' },
    { index: 2, startSec: 2, endSec: 4, shotType: '中景', camera: '固定', visual: '手持产品使用中', lighting: '左侧柔和窗光', environment: '背景虚焦人群经过', voiceover: '一杯只要九块九', onscreenText: '9.9', emotion: '惊喜', purpose: '卖点' },
    { index: 3, startSec: 4, endSec: 6, shotType: '全景', camera: '横摇', visual: '桌面全景摆盘', lighting: '暖色实用灯', environment: '桌面轻微反光', voiceover: '下午茶就选它', onscreenText: '下午茶', emotion: '满足', purpose: '收尾' },
  ],
  rhythm: { avgShotSec: 2, beatPattern: '快切三段', cutPoints: [2, 4] },
  style: { palette: ['暖白', '橙'], typography: '大字居中', music: '未识别（无音频输入）', colorGrade: '高饱和', subject: '饮品' },
  dna: ['前 2 秒价格反差制造冲突', '每镜一个卖点递进', '结尾生活方式收束'],
  scores: { hook: 8, retention: 7, conversion: 8, overall: 8 },
}

const REWRITE = {
  variants: ['A', 'B', 'C'].map((id, variantIndex) => ({
    id,
    angle: ['原片结构', '换钩子', '换视角'][variantIndex],
    title: `${id} 版脚本`,
    hookLine: '九块九这杯你敢信',
    totalDurationSec: 24,
    notes: '继承价格反差钩子与三段递进结构',
    segments: Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      startSec: index * 4,
      endSec: index * 4 + 4,
      voiceover: `第 ${index + 1} 镜口播：下午茶选它只要九块九`,
      onscreenText: `大字${index + 1}`,
      shotType: ['特写', '中近景', '中景', '全景'][index % 4],
      camera: ['固定', '缓慢推近', '跟拍', '横摇'][index % 4],
      visualPrompt: `暖白背景下的饮品特写，橙色高光，主体在画面右侧，抬手举杯一次`,
      productPlacement: index % 2 === 0 ? '产品居中特写' : '手持使用中',
    })),
  })),
  recommendedId: 'A',
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

const mockCalls = {
  videoSizes: [], chat: 0, vision: 0, image: 0, videoSubmit: 0, videoPoll: 0, tts: 0, auth: [], imagePrompts: [], videoPrompts: [], videoImageCounts: [] }
const resultBytes = await readFile(resultMp4)
const ttsBytes = await readFile(ttsWav)

const mockServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // 网关前缀兼容：/v1/chat/completions 与 /chat/completions 都收。
  url.pathname = url.pathname.replace(/^\/v1(?=\/)/, '')
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type })
    res.end(typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body))
  }
  try {
    if (url.pathname === '/chat/completions' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const messages = body.messages ?? []
      const system = String(messages.find(message => message.role === 'system')?.content ?? '')
      const user = messages.find(message => message.role === 'user')?.content
      const hasAudio = Array.isArray(user) && user.some(part => part?.type === 'input_audio')
      if (hasAudio) {
        mockCalls.asr = (mockCalls.asr ?? 0) + 1
        return send(200, { choices: [{ message: { content: '下午三点眼皮开始打架。同事递来这一杯。' } }] })
      }
      const hasImage = Array.isArray(user) && user.some(part => part?.type === 'image_url')
      if (hasImage) mockCalls.vision += 1
      else mockCalls.chat += 1
      if (system.includes('拆解')) return send(200, { choices: [{ message: { content: JSON.stringify(ANALYSIS) } }] })
      if (system.includes('仿写')) return send(200, { choices: [{ message: { content: JSON.stringify(REWRITE) } }] })
      if (system.includes('产品视觉描述')) return send(200, { choices: [{ message: { content: JSON.stringify({ visual: '橙色易拉罐，磨砂质感' }) } }] })
      return send(200, { choices: [{ message: { content: '可用' } }] })
    }
    if (url.pathname === '/audio/transcriptions' && req.method === 'POST') {
      return send(404, { error: 'not found' }, 'application/json')
    }
    if (url.pathname === '/images/generations' && req.method === 'POST') {
      mockCalls.image += 1
      const imageBody = await readJsonBody(req)
      mockCalls.imagePrompts.push(String(imageBody.prompt ?? ''))
      mockCalls.auth.push(String(req.headers.authorization ?? ''))
      return send(200, { data: [{ b64_json: pngB64 }] })
    }
    if (url.pathname === '/contents/generations/tasks' && req.method === 'POST') {
      await readJsonBody(req)
      return send(400, {
        error: {
          code: 'InputImageSensitiveContentDetected.PrivacyInformation',
          message: "The request failed because the input image 'content[1]' may contain real person.",
          type: 'BadRequest',
        },
      }, 'application/json')
    }
    if (url.pathname === '/videos' && req.method === 'POST') {
      mockCalls.videoSubmit += 1
      const videoBody = await readJsonBody(req)
      mockCalls.videoPrompts.push(String(videoBody.prompt ?? ''))
      mockCalls.videoSizes.push(String(videoBody.size ?? videoBody.ratio ?? ''))
  mockCalls.videoImageCounts.push(Array.isArray(videoBody.content)
        ? videoBody.content.filter(part => part?.type === 'image_url').length
        : (videoBody.image === undefined ? 0 : 1))
      mockCalls.auth.push(String(req.headers.authorization ?? ''))
      return send(200, { id: `task-${mockCalls.videoSubmit}` })
    }
    if (url.pathname.startsWith('/videos/task-') && req.method === 'GET') {
      mockCalls.videoPoll += 1
      return send(200, { status: 'completed', id: url.pathname.split('/').pop(), url: `http://127.0.0.1:${mockServer.address().port}/result.mp4` })
    }
    if (url.pathname === '/result.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(resultBytes.length) })
      res.end(resultBytes)
      return
    }
    if (url.pathname === '/audio/speech' && req.method === 'POST') {
      mockCalls.tts += 1
      mockCalls.auth.push(String(req.headers.authorization ?? ''))
      await readJsonBody(req)
      return send(200, ttsBytes, 'audio/wav')
    }
    if (url.pathname === '/parse-fail' && req.method === 'POST') {
      await readJsonBody(req)
      return send(200, { success: false, error: '抖音解析服务异常' })
    }
    if (url.pathname === '/parse' && req.method === 'POST') {
      await readJsonBody(req)
      return send(200, {
        success: true,
        data: {
          platform: 'douyin',
          mediaType: 4,
          title: 'Mock 抖音视频',
          author: { name: '测试作者' },
          duration: 6,
          videoUrl: `http://127.0.0.1:${mockServer.address().port}/result.mp4`,
        },
      })
    }
    if (url.pathname === '/models' && req.method === 'GET') {
      return send(200, { data: [{ id: 'mock-model' }] })
    }
    send(404, { error: 'not found' })
  } catch (error) {
    send(500, { error: String(error?.message ?? error) })
  }
})
await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${mockServer.address().port}`
log('mock 网关', mockBase)

// ---------------------------------------------------------------- 加载宿主插件
const routes = []

// —— 假的 DSH 服务：llm / attachments / configEditor / credentials / agentDefaultModel ——
// 用来验证「设置里选 DSH 已配置模型」这条通路（聊天走 llm.stream，媒体走解析出的 baseURL）。
const llmCalls = { chat: 0, vision: 0 }
const savedImages = []
const fakeLlm = {
  listProviders: () => [{ id: 'mock-provider', name: 'Mock 提供商' }],
  listModels: async (provider) => provider === 'mock-provider'
    ? [
        { id: 'mock-vision', name: 'Mock Vision', inputModalities: ['text', 'image'] },
        { id: 'mock-text', name: 'Mock Text', inputModalities: ['text'] },
        { id: 'mock-image', name: 'Mock Image', inputModalities: ['text'] },
        { id: 'mock-video', name: 'Mock Video', inputModalities: ['text'] },
        { id: 'mock-tts', name: 'Mock TTS', inputModalities: ['text'] },
      ]
    : [],
  resolveModelInfo: async (_provider, model) => ({ inputModalities: String(model).includes('vision') ? ['text', 'image'] : ['text'] }),
  stream: async function* (options) {
    const system = String(options.system ?? '')
    const content = Array.isArray(options.messages) ? options.messages[0]?.content : undefined
    const hasImage = Array.isArray(content) && content.some(part => part?.type === 'image')
    if (hasImage) llmCalls.vision += 1
    else llmCalls.chat += 1
    let text
    if (system.includes('拆解')) text = JSON.stringify(ANALYSIS)
    else if (system.includes('仿写')) text = JSON.stringify(REWRITE)
    else if (system.includes('产品视觉描述')) text = JSON.stringify({ visual: '橙色易拉罐，磨砂质感' })
    else text = '可用'
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const fakeAttachments = {
  saveImages: async (inputs) => {
    for (const input of inputs) savedImages.push(input)
    return inputs.map((input, index) => ({
      attachmentId: `att-${index}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 512,
      height: 512,
      name: input.name,
    }))
  },
}
const fakeConfigEditor = {
  entries: () => [{
    options: {
      id: 'llm-pi-ai',
      config: {
        providers: {
          'mock-provider': {
            name: 'Mock 提供商',
            baseURL: mockBase,
            apiKey: 'dsh-route-key',
            models: [{ id: 'mock-image' }, { id: 'mock-video' }, { id: 'mock-tts' }, { id: 'mock-asr' }],
          },
          'no-route-provider': { name: '没有接口地址的提供商', models: [{ id: 'some-model' }] },
        },
      },
    },
  }],
}
// 设置服务：真实 DSH 里用户在「设置 → 模型」改的 baseURL / models 只在设置文档里，
// 组合配置里看不到。这里用一个只在设置里存在的提供商验证兜底读取。
const fakeSettings = {
  describe: () => [{
    ns: 'llm-pi-ai',
    value: {
      providers: {
        'settings-provider': {
          name: '设置里的提供商',
          baseURL: mockBase,
          apiKeyEnv: 'SMOKE_KEY',
          models: [{ id: 'smoke-model' }],
        },
      },
    },
  }],
}

const fakeServices = {
  llm: fakeLlm,
  settings: fakeSettings,
  attachments: fakeAttachments,
  configEditor: fakeConfigEditor,
  credentials: { resolve: async () => ({ value: 'from-credential-store' }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock-provider', model: 'mock-vision' }) },
  systemPrompt: { section: () => () => {} },
}

const fakeCtx = {
  effect: (run) => {
    const dispose = run()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: (name) => fakeServices[name],
  on: () => () => {},
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  },
  systemPrompt: fakeServices.systemPrompt,
}

const plugin = await import('../lib/index.js')
log('插件导出', Object.keys(plugin))
plugin.apply(fakeCtx, {})
for (let i = 0; i < 60 && routes.length === 0; i += 1) await sleep(100)
if (routes.length === 0) throw new Error('路由没有挂载')
log('已挂载路由', routes.map(route => route.path).join(', '))

// ---------------------------------------------------------------- 路由服
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find(item => item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `no route ${url.pathname}` }))
    return
  }
  Promise.resolve(route.handler(req, res)).catch(error => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const API_ROOT = `${base}/api/dsh-video-replica`

async function call(path, options = {}) {
  const response = await fetch(path, options)
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { status: response.status, json }
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    log('✓', label)
  } else {
    failures.push(`${label}${detail === undefined ? '' : `：${detail}`}`)
    log('✗', label, detail ?? '')
  }
}

// ---------------------------------------------------------------- 1. 配置
const configGet = await call(`${API_ROOT}/config`)
check('GET /config 返回默认配置', configGet.json.ok === true && configGet.json.value.config.analyze.frameCount === 12)

const configPatch = await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      parser: {
        apiUrl: `${mockBase}/parse-fail`,
        apiKey: 'parser-key',
        model: '',
        mode: 'auto',
        fallbackApiUrl: `${mockBase}/parse`,
        fallbackApiKey: 'fallback-key',
      },
      analyze: { apiUrl: mockBase, apiKey: 'vision-key', model: 'mock-vision', frameCount: 6 },
      rewrite: { apiUrl: mockBase, apiKey: 'text-key', model: 'mock-text' },
      image: { apiUrl: mockBase, apiKey: 'image-key', model: 'mock-image' },
      video: { apiUrl: mockBase, apiKey: 'video-key', model: 'mock-video', pollSec: 1, secondsPerSegment: 5, concurrency: 2 },
      tts: { apiUrl: mockBase, apiKey: 'tts-key', model: 'mock-tts', enabled: true, voice: 'alloy' },
      asr: { enabled: true, apiUrl: mockBase, apiKey: 'asr-key', model: 'mock-asr', protocol: 'openai-transcription' },
      compose: { burnSubtitles: true, fps: 30, perSegmentTts: true },
    },
  }),
})
check('POST /config 保存成功', configPatch.json.ok === true, JSON.stringify(configPatch.json).slice(0, 300))
check('密钥以掩码回读', String(configPatch.json.value?.config?.analyze?.apiKey ?? '').startsWith('••'), String(configPatch.json.value?.config?.analyze?.apiKey))
check('密钥真值已落盘', await readFile(join(root, 'config.json'), 'utf8').then(text => text.includes('vision-key')))
check('连通性测试', (await call(`${API_ROOT}/config/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'rewrite' }),
})).json.ok === true)

// DSH 已配置模型目录
const modelsCatalog = await call(`${API_ROOT}/models`)
const catalogValue = modelsCatalog.json.value
check('GET /models 返回提供商目录', modelsCatalog.json.ok === true && Array.isArray(catalogValue?.providers), JSON.stringify(modelsCatalog.json).slice(0, 300))
check('提供商模型列表来自 DSH', (catalogValue?.providers ?? []).some(p => p.id === 'mock-provider' && p.models.length >= 2), JSON.stringify(catalogValue?.providers ?? []).slice(0, 300))
check('DSH 默认模型被读出', catalogValue?.default?.provider === 'mock-provider' && catalogValue?.default?.model === 'mock-vision', JSON.stringify(catalogValue?.default))
check('接口地址可解析的提供商被标记', (catalogValue?.providers ?? []).find(p => p.id === 'mock-provider')?.routeReady === true)
check('缺接口地址的提供商被标记', (catalogValue?.providers ?? []).find(p => p.id === 'no-route-provider')?.routeReady === false)
check('设置文档里的提供商也被列出', (catalogValue?.providers ?? []).some(p => p.id === 'settings-provider'), JSON.stringify((catalogValue?.providers ?? []).map(p => p.id)))
check('设置文档里的 baseURL 能解析', (catalogValue?.providers ?? []).find(p => p.id === 'settings-provider')?.routeReady === true)

// 图片 / 视频 / 配音切到 DSH 已配置模型（接口地址与密钥从 DSH 提供商配置里取）
const dshPatch = await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      image: { source: 'dsh', dshProvider: 'mock-provider', dshModel: 'mock-image', apiUrl: '', apiKey: '', model: '' },
      video: { source: 'dsh', dshProvider: 'mock-provider', dshModel: 'mock-video', apiUrl: '', apiKey: '', model: '' },
      tts: { source: 'dsh', dshProvider: 'mock-provider', dshModel: 'mock-tts', apiUrl: '', apiKey: '', apiKey: '', model: '', enabled: true },
    },
  }),
})
check('切到 DSH 已配置模型', dshPatch.json.value?.config?.image?.source === 'dsh'
  && dshPatch.json.value?.config?.image?.dshModel === 'mock-image'
  && dshPatch.json.value?.config?.video?.source === 'dsh', JSON.stringify(dshPatch.json.value?.config?.image ?? {}).slice(0, 240))
check('DSH 模式连通性测试', (await call(`${API_ROOT}/config/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'tts' }),
})).json.ok === true)
// 提供商没有接口地址时，图片这类自建请求必须给出明确原因
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { image: { dshProvider: 'no-route-provider', dshModel: 'some-model' } } }),
})
const noRouteTest = await call(`${API_ROOT}/config/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'image' }),
})
check('DSH 提供商缺接口地址时明确报错', noRouteTest.json.ok === false && String(noRouteTest.json.error).includes('接口地址'), JSON.stringify(noRouteTest.json).slice(0, 240))
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { image: { dshProvider: 'mock-provider', dshModel: 'mock-image' } } }),
})

// ---------------------------------------------------------------- 2. 本地上传 + 全流程
const created = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'smoke 本地视频', autoAdvance: true }),
})
const runId = created.json?.value?.run?.id
check('创建运行', typeof runId === 'string' && runId.length > 0, JSON.stringify(created.json).slice(0, 200))

const uploadResponse = await fetch(`${API_ROOT}/upload?runId=${encodeURIComponent(runId)}&kind=video&name=${encodeURIComponent('fixture.mp4')}`, {
  method: 'POST',
  headers: { 'content-type': 'video/mp4' },
  body: await readFile(sourceMp4),
})
const uploadJson = await uploadResponse.json()
check('上传本地视频', uploadJson.ok === true, JSON.stringify(uploadJson).slice(0, 200))

const productResponse = await fetch(`${API_ROOT}/upload?runId=${encodeURIComponent(runId)}&kind=product&name=${encodeURIComponent('product.png')}`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: productPngBytes,
})
const productJson = await productResponse.json()
check('上传产品图', productJson.ok === true, JSON.stringify(productJson).slice(0, 200))

const started = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'start', autoAdvance: true }),
})
check('启动全流程', started.json.ok === true, JSON.stringify(started.json).slice(0, 300))

let snapshot
const deadline = Date.now() + 240_000
for (;;) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(runId)}`)
  snapshot = response.json.value
  const status = snapshot?.run?.status
  if (status === 'done' || status === 'failed' || status === 'stopped') break
  if (Date.now() > deadline) {
    failures.push('流水线超时未结束')
    break
  }
  await sleep(600)
}

const run = snapshot?.run
log('最终状态', run?.status)
for (const step of run?.steps ?? []) {
  log(`  ${step.id.padEnd(9)} ${step.status.padEnd(8)} ${step.message ?? ''}${step.error === undefined ? '' : ` | ${step.error}`}`)
}
check('六步全部完成', run?.status === 'done', JSON.stringify(run?.steps?.filter(step => step.status !== 'done')).slice(0, 500))
check('拆解结果写入', (run?.analysis?.shots?.length ?? 0) === 3)
check('语音识别在 whisper 404 时自动切 chat-asr',
  (run?.analysis?.transcript?.length ?? 0) >= 1
  && (run?.analysis?.transcript ?? []).some(cue => cue.text.includes('下午三点')),
  JSON.stringify(run?.analysis?.transcript ?? []).slice(0, 240))
check('仿写 3 版脚本', (run?.scripts?.variants?.length ?? 0) === 3)
check('参考图生成 6 张', (run?.frames?.filter(frame => frame.file !== '').length ?? 0) === 6)
// 现在默认一块只放一个分镜（多镜同块会丢镜），所以 6 镜的 mock 会生成 6 段
check('分镜视频一镜一段', (run?.segments?.filter(segment => segment.status === 'done').length ?? 0) === 6,
  JSON.stringify(run?.segments?.map(segment => ({ i: segment.segmentIndex, s: segment.status }))))
check('拆解保留光线与环境动态',
  (run?.analysis?.shots ?? []).every(shot => shot.lighting !== '' && shot.environment !== ''),
  JSON.stringify((run?.analysis?.shots ?? []).map(shot => ({ l: shot.lighting, e: shot.environment }))).slice(0, 240))
check('分镜带景别/运镜（脚本给出）',
  (run?.scripts?.variants ?? []).every(variant => variant.segments.every(segment =>
    ['特写', '近景', '中近景', '中景', '全景', '远景'].includes(segment.shotType)
    && ['固定', '缓慢推近', '缓慢拉远', '横摇', '跟拍', '环绕', '手持', '拉焦'].includes(segment.camera))),
  JSON.stringify((run?.scripts?.variants?.[0]?.segments ?? []).slice(0, 2)).slice(0, 240))
check('参考图提示词用「首帧」模板 + 素材职责',
  (mockCalls.imagePrompts[0] ?? '').includes('首帧') && (mockCalls.imagePrompts[0] ?? '').includes('图片1'),
  String(mockCalls.imagePrompts[0] ?? '').slice(0, 200))
check('视频画幅走参数而不是提示词',
  mockCalls.videoSizes.length > 0
    && mockCalls.videoSizes.every(size => size !== '')
    && mockCalls.videoPrompts.every(prompt => !String(prompt).includes('【画幅】')),
  `sizes=${JSON.stringify(mockCalls.videoSizes)} prompt=${String(mockCalls.videoPrompts[0] ?? '').slice(0, 120)}`)
check('视频提示词带素材绑定/连续性锁定',
  mockCalls.videoPrompts.some(prompt => /图片2|本段起始帧/.test(String(prompt))
    && String(prompt).includes('[CONTINUITY_LOCK]')),
  String(mockCalls.videoPrompts[0] ?? '').slice(0, 200))
check('model 调用：视觉/文本/图像/视频/TTS', mockCalls.vision >= 2 && mockCalls.chat >= 1 && mockCalls.image >= 6 && mockCalls.videoSubmit >= 2 && mockCalls.tts >= 1, JSON.stringify(mockCalls))
check('DSH 提供商的密钥被用于图片/视频/配音请求',
  mockCalls.auth.length > 0 && mockCalls.auth.every(value => value === 'Bearer dsh-route-key'),
  JSON.stringify(mockCalls.auth.slice(0, 4)))

const runDir = join(root, 'runs', runId)
const finalPath = join(runDir, 'final.mp4')
const finalStat = await stat(finalPath).catch(() => undefined)
check('final.mp4 落盘', finalStat !== undefined && finalStat.size > 10_000, `${finalStat?.size ?? 0} 字节`)
if (finalStat !== undefined) {
  const info = probe(finalPath)
  const video = info.streams.find(stream => stream.codec_type === 'video')
  const audio = info.streams.find(stream => stream.codec_type === 'audio')
  const duration = Number(info.format.duration)
  check('成片时长合理', duration > 5 && duration < 40, `${duration.toFixed(2)}s`)
  check('成片分辨率 720x1280', video?.width === 720 && video?.height === 1280, `${video?.width}x${video?.height}`)
  check('成片有音轨（TTS 配音）', audio !== undefined)
  check('字幕文件已生成', (await readdir(runDir)).includes('subs.ass'))
}

// ---------------------------------------------------------------- 3. 媒体 Range
const range = await fetch(`${API_ROOT}/media?runId=${encodeURIComponent(runId)}&path=final.mp4`, {
  headers: { range: 'bytes=0-1023' },
})
check('媒体 Range 播放', range.status === 206 && Number(range.headers.get('content-length')) === 1024, String(range.status))
const traversal = await call(`${API_ROOT}/media?runId=${encodeURIComponent(runId)}&path=../../../etc/passwd`)
check('拒绝目录穿越', traversal.status === 400, String(traversal.status))

// ---------------------------------------------------------------- 4. 链接解析路径
const linkRun = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://v.douyin.com/abcdefg/', autoAdvance: false }),
})
const linkRunId = linkRun.json?.value?.run?.id
check('创建链接任务', typeof linkRunId === 'string')
const detect = await call(`${API_ROOT}/detect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://v.douyin.com/abcdefg/' }),
})
check('识别抖音链接', detect.json.value?.platform === 'douyin', JSON.stringify(detect.json).slice(0, 200))

const parseAction = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: linkRunId, action: 'step', step: 'parse' }),
})
check('执行解析单步', parseAction.json.ok === true, JSON.stringify(parseAction.json).slice(0, 300))
let linkSnapshot
for (let i = 0; i < 100; i += 1) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(linkRunId)}`)
  linkSnapshot = response.json.value
  if (linkSnapshot?.run?.status !== 'running' && linkSnapshot?.busy !== true) break
  await sleep(300)
}
const linkRunState = linkSnapshot?.run
log('链接任务 parse 状态', linkRunState?.steps?.find(step => step.id === 'parse')?.status)
check('解析接口下载源视频', linkRunState?.source?.provider === 'api' && linkRunState?.source?.platform === 'douyin', JSON.stringify(linkRunState?.source).slice(0, 300))
check('解析出标题', linkRunState?.source?.title === 'Mock 抖音视频', linkRunState?.source?.title)
check('主解析接口失败时自动切备用',
  (linkRunState?.logs ?? []).some(entry => entry.text.includes('已解析（127.0.0.1')),
  JSON.stringify((linkRunState?.logs ?? []).slice(-4)).slice(0, 300))
check('备用 Key 以掩码回读',
  String((await call(`${API_ROOT}/config`)).json.value?.config?.parser?.fallbackApiKey ?? '').startsWith('••'))

// ---------------------------------------------------------------- 4b. 拆解走 DSH 已配置模型
const dshChatPatch = await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      analyze: { source: 'dsh', dshProvider: 'mock-provider', dshModel: 'mock-vision', apiUrl: '', apiKey: '', model: '' },
      rewrite: { source: 'dsh', dshProvider: 'mock-provider', dshModel: 'mock-text', apiUrl: '', apiKey: '', model: '' },
    },
  }),
})
check('拆解/仿写切到 DSH 模型', dshChatPatch.json.value?.config?.analyze?.dshModel === 'mock-vision'
  && dshChatPatch.json.value?.config?.rewrite?.source === 'dsh')

const dshTest = await call(`${API_ROOT}/config/test`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ stage: 'analyze' }),
})
check('DSH 视觉模型连通性测试', dshTest.json.ok === true, JSON.stringify(dshTest.json).slice(0, 240))

const savedImagesBefore = savedImages.length
const analyzeAction = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: linkRunId, action: 'step', step: 'analyze' }),
})
check('执行 DSH 拆解', analyzeAction.json.ok === true, JSON.stringify(analyzeAction.json).slice(0, 300))
let dshSnapshot
for (let i = 0; i < 120; i += 1) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(linkRunId)}`)
  dshSnapshot = response.json.value
  if (dshSnapshot?.busy !== true && dshSnapshot?.run?.status !== 'running') break
  await sleep(300)
}
const dshRun = dshSnapshot?.run
check('DSH 模型完成拆解', (dshRun?.analysis?.shots?.length ?? 0) === 3, JSON.stringify(dshRun?.steps?.find(step => step.id === 'analyze')).slice(0, 300))
check('抽帧以附件形式交给 DSH 模型', savedImages.length - savedImagesBefore >= 3, `新增 ${savedImages.length - savedImagesBefore} 张`)
check('视觉调用走 llm.stream', llmCalls.vision >= 1, JSON.stringify(llmCalls))

// ---------------------------------------------------------------- 4c. 显式 chat-asr 协议
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { asr: { protocol: 'chat-asr' } } }),
})
await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: linkRunId, action: 'step', step: 'analyze' }),
})
let asrSnapshot
for (let index = 0; index < 300; index += 1) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(linkRunId)}`)
  asrSnapshot = response.json.value
  if (asrSnapshot?.busy !== true) break
  await sleep(200)
}
check('显式 chat-asr 协议可转写',
  (asrSnapshot?.run?.analysis?.transcript?.length ?? 0) >= 1,
  JSON.stringify(asrSnapshot?.run?.analysis?.transcript ?? []).slice(0, 200))

// ---------------------------------------------------------------- 4b9. 画幅在创建时确定
const aspectRun = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'aspect-test', aspectRatio: '16:9', autoAdvance: false }),
})
check('创建运行时可指定画幅',
  (aspectRun.json?.value?.run?.aspectRatio ?? aspectRun.json?.run?.aspectRatio) === '16:9',
  JSON.stringify(aspectRun.json).slice(0, 160))

// ---------------------------------------------------------------- 4c0. 提示词可改 + 重新生成用改后的提示词
const customPrompt = '【画幅】竖屏 9:16（720×1280），约 6 秒。SMOKE_CUSTOM_PROMPT 只做一个动作。'
const regenResponse = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'regenerate-segment', segmentIndex: 1, prompt: customPrompt }),
})
check('重新生成使用编辑后的提示词',
  (mockCalls.videoPrompts.at(-1) ?? '').includes('SMOKE_CUSTOM_PROMPT'),
  String(mockCalls.videoPrompts.at(-1) ?? '').slice(0, 160))
check('重新生成返回成功', regenResponse.status === 200, JSON.stringify(regenResponse.json).slice(0, 160))
const afterRegen = await call(`${API_ROOT}/run?runId=${runId}`)
const afterRegenRun = afterRegen.json?.value?.run ?? afterRegen.json?.run
check('重生成分镜后「合成成片」标记为需重新生成',
  (afterRegenRun?.steps ?? []).find(step => step.id === 'compose')?.stale === true,
  JSON.stringify((afterRegenRun?.steps ?? []).map(step => ({ id: step.id, s: step.stale }))))

// 音轨来源切换
const audioSwitch = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'set-audio-source', audioSource: 'original' }),
})
const audioRun = await call(`${API_ROOT}/run?runId=${runId}`)
const audioSourceValue = audioRun.json?.value?.run?.audioSource ?? audioRun.json?.run?.audioSource ?? ''
check('音轨来源可切换为原声',
  (audioSwitch.status === 200) && String(audioSourceValue) === 'original',
  `status=${audioSwitch.status} source=${String(audioSourceValue)} body=${JSON.stringify(audioSwitch.json).slice(0, 120)}`)

// ---------------------------------------------------------------- 4c1. 提示词预览（不调模型）
const previewBefore = mockCalls.image
const previewResponse = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'preview-prompts' }),
})
let previewValue = previewResponse.json
while (previewValue !== undefined && previewValue.frames === undefined && previewValue.value !== undefined) {
  previewValue = previewValue.value
}
check('提示词预览：返回首帧 + 视频提示词',
  (previewValue?.frames?.length ?? 0) > 0 && (previewValue?.videos?.length ?? 0) > 0,
  JSON.stringify(previewValue)?.slice(0, 200))
check('提示词预览：不调用图片/视频模型',
  mockCalls.image === previewBefore,
  `image ${previewBefore} -> ${mockCalls.image}`)
check('提示词预览：首帧提示词含构图与光线',
  String(previewValue?.frames?.[0]?.framePrompt ?? '').includes('[构图]')
  && String(previewValue?.frames?.[0]?.framePrompt ?? '').includes('[光线]'),
  String(previewValue?.frames?.[0]?.framePrompt ?? '').slice(0, 160))

// ---------------------------------------------------------------- 4c2. 不上传产品图：纯复刻
const pureRun = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '纯复刻（无产品）', url: 'https://v.douyin.com/pure/', productBrief: '这段卖点不应该出现在纯复刻里' }),
})
const pureRunId = pureRun.json?.value?.run?.id
check('可以创建不带产品的运行', typeof pureRunId === 'string', JSON.stringify(pureRun.json).slice(0, 160))
for (const step of ['parse', 'analyze', 'rewrite', 'match']) {
  await call(`${API_ROOT}/run/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: pureRunId, action: 'step', step }),
  })
  for (let index = 0; index < 300; index += 1) {
    const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(pureRunId)}`)
    if (response.json?.value?.busy !== true) break
    await sleep(120)
  }
}
const pureState = (await call(`${API_ROOT}/run?runId=${encodeURIComponent(pureRunId)}`)).json?.value?.run
check('纯复刻：参考图标记为 scene',
  (pureState?.frames ?? []).length > 0 && (pureState?.frames ?? []).every(frame => frame.mode === 'scene'),
  JSON.stringify((pureState?.frames ?? []).map(frame => frame.mode)))
check('纯复刻：首帧不引用产品图',
  (pureState?.frames ?? []).every(frame => !String(frame.prompt ?? '').includes('图片1 = 产品外观锚定')),
  String(pureState?.frames?.[0]?.prompt ?? '').slice(0, 160))
check('纯复刻：卖点简述不参与创作',
  !String(pureState?.frames?.[0]?.prompt ?? '').includes('这段卖点不应该出现'),
  String(pureState?.frames?.[0]?.prompt ?? '').slice(0, 160))
await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: pureRunId, action: 'step', step: 'generate' }),
})
let pureGen
for (let index = 0; index < 400; index += 1) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(pureRunId)}`)
  pureGen = response.json?.value?.run
  if (response.json?.value?.busy !== true) break
  await sleep(120)
}
check('纯复刻：视频提示词不引用产品图',
  !String(pureGen?.segments?.[0]?.prompt ?? '').includes('产品外观锚定')
  && String(pureGen?.segments?.[0]?.prompt ?? '').includes('起始帧'),
  String(pureGen?.segments?.[0]?.prompt ?? '').slice(0, 200))

// ---------------------------------------------------------------- 4c3. 产品融入：文生图模式不发产品图
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { imageProductMode: 'text', imageFrameStyle: 'photo', video: { protocol: 'ark-seedance' } } }),
})
const textModeRun = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: '文生图产品模式', url: 'https://v.douyin.com/t2i/' }),
})
const textModeId = textModeRun.json?.value?.run?.id
await fetch(`${API_ROOT}/upload?runId=${encodeURIComponent(textModeId)}&kind=product&name=${encodeURIComponent('p.png')}`, {
  method: 'POST',
  headers: { 'content-type': 'image/png' },
  body: productPngBytes,
})
for (const step of ['parse', 'analyze', 'rewrite', 'match']) {
  await call(`${API_ROOT}/run/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: textModeId, action: 'step', step }),
  })
  for (let index = 0; index < 400; index += 1) {
    const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(textModeId)}`)
    if (response.json?.value?.busy !== true) break
    await sleep(120)
  }
}
const textModeState = (await call(`${API_ROOT}/run?runId=${encodeURIComponent(textModeId)}`)).json?.value?.run
check('文生图模式：首帧请求不带产品图',
  String(textModeState?.frames?.[0]?.prompt ?? '').includes('[产品]')
  && !String(textModeState?.frames?.[0]?.prompt ?? '').includes('图片1 = 产品外观锚定'),
  String(textModeState?.frames?.[0]?.prompt ?? '').slice(0, 200))
check('文生图模式：模式标记仍为 product',
  (textModeState?.frames ?? []).every(frame => frame.mode === 'product'),
  JSON.stringify((textModeState?.frames ?? []).map(frame => frame.mode)))
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { video: { protocol: 'openai-video' } } }),
})
await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: textModeId, action: 'step', step: 'generate' }),
})
let textModeGen
for (let index = 0; index < 400; index += 1) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(textModeId)}`)
  textModeGen = response.json?.value?.run
  if (response.json?.value?.busy !== true) break
  await sleep(120)
}
check('通用视频网关只传首帧（产品靠提示词）',
  (mockCalls.videoImageCounts.at(-1) ?? 0) === 1
  && String(textModeGen?.segments?.[0]?.prompt ?? '').includes('图片1 = 本段起始帧'),
  `images=${JSON.stringify(mockCalls.videoImageCounts.slice(-3))} hasAnchor=${String(textModeGen?.segments?.[0]?.prompt ?? '').includes('产品外观锚定')} hasStart=${String(textModeGen?.segments?.[0]?.prompt ?? '').includes('起始帧')} prompt=${String(textModeGen?.segments?.[0]?.prompt ?? '').slice(0, 260)}`)

// ---------------------------------------------------------------- 4d. Ark Seedance 真人风控的错误提示
await call(`${API_ROOT}/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      video: { source: 'custom', protocol: 'ark-seedance', apiUrl: mockBase, apiKey: 'ark-key', model: 'doubao-seedance-2-0-mini', size: '720x1280' },
    },
  }),
})
const arkReject = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'regenerate-segment', segmentIndex: 1 }),
})
check('Seedance 风控拦截时给出可操作提示',
  /PrivacyInformation/.test(String(arkReject.json?.error ?? ''))
  && /真实人物|卡通/.test(String(arkReject.json?.error ?? '')),
  String(arkReject.json?.error ?? '').slice(0, 240))

// ---------------------------------------------------------------- 5. 交互动作（界面按钮走的路由）
const callAction = body => call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, ...body }),
})

const selectedB = await callAction({ action: 'select-variant', variantId: 'B' })
check('切换脚本版本', selectedB.json.ok === true && selectedB.json.value?.run?.variantId === 'B', JSON.stringify(selectedB.json).slice(0, 240))
check('切换版本后清空下游产物', (selectedB.json.value?.run?.frames?.length ?? -1) === 0 && (selectedB.json.value?.run?.segments?.length ?? -1) === 0)

const regenFrame = await callAction({ action: 'regenerate-frame', segmentIndex: 1 })
check('单张参考图重生成', regenFrame.json.ok === true && (regenFrame.json.value?.run?.frames?.length ?? 0) >= 1, JSON.stringify(regenFrame.json).slice(0, 240))
const frameOk = await stat(join(runDir, 'frames', 'ref-01.png')).then(info => info.size > 512).catch(() => false)
check('重生成的参考图落盘', frameOk)

const edited = await callAction({
  action: 'update-segments',
  segments: [
    { startSec: 0, endSec: 5, voiceover: '改过的第一句', onscreenText: '改1', visualPrompt: '改过的画面描述', productPlacement: '产品居中' },
    { startSec: 5, endSec: 10, voiceover: '改过的第二句', onscreenText: '改2', visualPrompt: '第二个画面', productPlacement: '手持' },
  ],
})
const editedVariant = edited.json.value?.run?.scripts?.variants?.find(item => item.id === 'B')
check('保存分镜（逐镜编辑）', edited.json.ok === true && editedVariant?.segments?.length === 2, JSON.stringify(edited.json).slice(0, 240))
check('保存分镜后清空下游产物', (edited.json.value?.run?.frames?.length ?? -1) === 0)

const skipped = await callAction({ action: 'skip-step', step: 'compose' })
check('跳过某一步', skipped.json.ok === true && skipped.json.value?.run?.steps?.find(step => step.id === 'compose')?.status === 'skipped', JSON.stringify(skipped.json).slice(0, 240))

const unknownAction = await callAction({ action: 'nope' })
check('未知动作被拒绝', unknownAction.json.ok === false, JSON.stringify(unknownAction.json).slice(0, 160))

const deleted = await callAction({ action: 'delete' })
check('删除运行', deleted.json.ok === true && deleted.json.value?.deleted === true)
check('删除后读不到运行', (await call(`${API_ROOT}/run?runId=${encodeURIComponent(runId)}`)).json.ok === false)

// ---------------------------------------------------------------- 收尾
log('mock 调用统计', mockCalls)
if (failures.length > 0) {
  console.error('\n[smoke] 失败项：')
  for (const failure of failures) console.error(' -', failure)
} else {
  console.log('\n[smoke] 全部通过 ✓')
}

await new Promise(resolve => server.close(resolve))
await new Promise(resolve => mockServer.close(resolve))
if (process.env.KEEP_SMOKE_DIR !== '1') await rm(root, { recursive: true, force: true }).catch(() => {})
else log('保留临时目录', root)
process.exit(failures.length === 0 ? 0 : 1)
