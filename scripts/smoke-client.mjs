// 浏览器半边的冒烟测试：在 jsdom 里加载 lib/client.js，模拟 DSH 的 __ModuleLoader__
// 与 slots / locale 服务，验证设置页注册、侧边栏入口、中栏接管与工作台首屏渲染。
//
// 用法：node scripts/smoke-client.mjs
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const require = createRequire(import.meta.url)

const failures = []
const log = (...args) => console.log('[client-smoke]', ...args)
function check(label, condition, detail) {
  if (condition) log('✓', label)
  else {
    failures.push(`${label}${detail === undefined ? '' : `：${detail}`}`)
    log('✗', label, detail ?? '')
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const CONFIG = {
  enabled: true,
  dataDir: '',
  parser: { apiUrl: '', apiKey: '', model: '', protocol: 'parser-json', extraJson: '', timeoutSec: 120, mode: 'auto', videoUrlPath: '' },
  analyze: { apiUrl: 'https://api.example.com/v1', apiKey: '••••••1234', model: 'vision-model', protocol: 'chat', extraJson: '', timeoutSec: 300, frameCount: 12, maxFrameSide: 1024 },
  rewrite: { apiUrl: 'https://api.example.com/v1', apiKey: '••••••1234', model: 'text-model', protocol: 'chat', extraJson: '', timeoutSec: 180 },
  image: { apiUrl: 'https://api.example.com/v1', apiKey: '••••••1234', model: 'image-model', protocol: 'openai-images', extraJson: '', timeoutSec: 180 },
  video: { apiUrl: 'https://api.example.com/v1', apiKey: '••••••1234', model: 'video-model', protocol: 'ark-seedance', extraJson: '', timeoutSec: 900, secondsPerSegment: 5, size: '720x1280', pollSec: 5, concurrency: 2 },
  tts: { apiUrl: '', apiKey: '', model: '', protocol: 'openai-tts', extraJson: '', timeoutSec: 180, voice: 'alloy', speed: 1, enabled: false },
  asr: { apiUrl: '', apiKey: '', model: '', protocol: 'openai-transcription', extraJson: '', timeoutSec: 300, enabled: false, language: '' },
  media: { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ytDlpPath: 'yt-dlp' },
  compose: { size: '', fps: 30, burnSubtitles: true, subtitleFontSize: 15, bgmPath: '', bgmVolume: 0.18, perSegmentTts: true },
}

const RUN = {
  id: '20261103-120000-abcdef',
  title: '复刻测试视频',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  status: 'idle',
  autoAdvance: true,
  steps: [
    { id: 'parse', status: 'done', progress: 1, message: '已下载源视频' },
    { id: 'analyze', status: 'done', progress: 1, message: '3 个镜头' },
    { id: 'rewrite', status: 'pending', progress: 0 },
    { id: 'match', status: 'pending', progress: 0 },
    { id: 'generate', status: 'pending', progress: 0 },
    { id: 'compose', status: 'pending', progress: 0 },
  ],
  source: { platform: 'douyin', provider: 'api', videoFile: 'source/source.mp4', title: '复刻测试视频', author: '作者', durationSec: 6, width: 720, height: 1280, fps: 30 },
  productImages: [],
  frames: [],
  segments: [],
  logs: [{ at: Date.now(), step: 'run', level: 'info', text: '开始执行：parse' }],
  analysis: {
    meta: { durationSec: 6, shotCount: 3, resolution: '720x1280', fps: 30, style: '实拍写实', pacing: '快切' },
    summary: '价格反差钩子 + 三段递进',
    hook: { type: '反差', text: '这个价格你敢信', whyItWorks: '价格锚点反转', seconds: 2 },
    shots: [
      { index: 1, startSec: 0, endSec: 2, shotType: '特写', camera: '推', visual: '产品特写', voiceover: '这个价格你敢信', onscreenText: '你敢信', emotion: '惊讶', purpose: '钩子' },
    ],
    rhythm: { avgShotSec: 2, beatPattern: '快切', cutPoints: [2] },
    style: { palette: ['暖白'], typography: '大字居中', music: '未识别', colorGrade: '高饱和', subject: '饮品' },
    dna: ['价格反差钩子'],
    scores: { hook: 8, retention: 7, conversion: 8, overall: 8 },
    frameFiles: [],
    analyzedAt: Date.now(),
  },
}

const html = `<!doctype html><html><head></head><body>
  <div data-pane="sidebar">
    <div class="logoRow"><span>DSH</span></div>
    <button data-dsh-part="new-session" aria-label="新会话">新会话</button>
    <div class="regionArea"></div>
  </div>
  <div data-pane="conversation"><div class="conversation-content">原生会话</div></div>
</body></html>`

const dom = new JSDOM(html, { url: 'http://127.0.0.1:63012/', pretendToBeVisual: true, runScripts: 'outside-only' })
const win = dom.window
// react-dom（Node realm）会直接读全局 window/document，这里把 jsdom 的全局镜像过去。
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage']) {
  if (globalThis[key] === undefined) globalThis[key] = win[key]
}
globalThis.window = win
globalThis.document = win.document
win.structuredClone = value => JSON.parse(JSON.stringify(value))
win.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
win.fetch = async (input) => {
  const url = String(input)
  const envelope = url.includes('/models')
    ? {
        ok: true,
        value: {
          providers: [
            {
              id: 'mock-provider',
              name: 'Mock 提供商',
              models: [
                { id: 'mock-vision', name: 'Mock Vision', modalities: ['text', 'image'] },
                { id: 'mock-text', name: 'Mock Text', modalities: ['text'] },
              ],
              routeReady: true,
            },
            { id: 'no-route', name: '没有地址的提供商', models: [{ id: 'x', name: 'x', modalities: [] }], routeReady: false },
          ],
          default: { provider: 'mock-provider', model: 'mock-vision' },
          errors: [],
        },
      }
    : url.includes('/runs')
      ? { ok: true, value: { runs: [{ id: RUN.id, title: RUN.title, createdAt: RUN.createdAt, updatedAt: RUN.updatedAt, platform: 'douyin', status: 'idle', currentStep: 'rewrite', completed: 2 }], busy: [] } }
      : url.includes('/run?')
        ? { ok: true, value: { run: RUN, busy: false } }
        : { ok: true, value: { config: CONFIG, secrets: { 'analyze.apiKey': true }, dataDir: 'C:/tmp/dvr', ffmpegAvailable: true, ffprobeAvailable: true, ytDlpAvailable: true } }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => envelope,
    text: async () => JSON.stringify(envelope),
  }
}

// 模拟 DSH 的浏览器模块加载器
let moduleExports
win.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    log('加载模块', id)
    moduleExports = factory(name => {
      if (name === 'react') return require('react')
      if (name === 'react-dom/client') return require('react-dom/client')
      if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

const source = await readFile(bundlePath, 'utf8')
win.eval(source)
check('客户端包注册到 __ModuleLoader__', moduleExports !== undefined && typeof moduleExports.apply === 'function', String(Object.keys(moduleExports ?? {})))

const document = win.document
const sections = []
const disposers = []
const ctx = {
  effect: (run) => {
    const dispose = run()
    const wrapped = typeof dispose === 'function' ? dispose : () => {}
    disposers.push(wrapped)
    return wrapped
  },
  get: () => undefined,
  slots: {
    inject: (name, register) => {
      check('settings.section 被注入', name === 'settings.section', name)
      return register()
    },
    register: (options, component) => {
      sections.push({ options, component })
      return () => {}
    },
  },
  locale: { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
}

moduleExports.apply(ctx)
await sleep(120)

check('注册了一个设置页', sections.length === 1, String(sections.length))
check('设置页 id 正确', sections[0]?.options?.id === 'dsh-video-replica', String(sections[0]?.options?.id))
check('设置页标题已本地化', typeof sections[0]?.options?.label === 'function' && String(sections[0].options.label()).includes('视频复刻'), String(sections[0]?.options?.label?.()))

const entry = document.querySelector('[data-dvr-entry]')
check('侧边栏入口已挂载', entry !== null)
check('侧边栏入口在 New Session 上方', entry?.parentElement?.nextElementSibling?.getAttribute('data-dsh-part') === 'new-session', entry?.parentElement?.outerHTML?.slice(0, 160))

const view = document.querySelector('[data-dvr-view]')
check('中栏容器已挂载', view !== null)
check('样式已注入', document.querySelector('style[data-dvr-styles]') !== null)

// 打开工作台
entry?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(200)
check('切换到工作台（html 属性）', document.documentElement.hasAttribute('data-dvr-active'))
const text = view?.textContent ?? ''
check('渲染标题', text.includes('爆款视频复刻'), text.slice(0, 80))
check('首屏是输入舞台', text.includes('粘贴链接或上传视频'), text.slice(0, 120))
check('渲染链接输入框', view?.querySelector('input.vr-input') !== null)
check('渲染流程轨道（六步）', view?.querySelectorAll('.vr-step').length === 6, String(view?.querySelectorAll('.vr-step').length))
check('渲染历史任务', text.includes('复刻测试视频'))
check('切回会话按钮存在', [...(view?.querySelectorAll('button') ?? [])].some(button => (button.textContent ?? '').includes('会话')))

// 打开历史任务：应加载运行状态并渲染日志与源视频
const historyItem = view?.querySelector('.vr-run')
historyItem?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(200)
const loadedText = view?.textContent ?? ''
check('打开历史任务后渲染源视频信息', loadedText.includes('已下载源视频'), loadedText.slice(0, 120))
check('渲染右栏日志', loadedText.includes('开始执行'), loadedText.slice(-160))
check('渲染步骤状态', [...(view?.querySelectorAll('.vr-step') ?? [])].some(step => step.getAttribute('data-status') === 'done'))

// 点击「新建复刻」回到输入舞台
const newButton = [...(view?.querySelectorAll('button') ?? [])].find(button => (button.textContent ?? '').includes('新建复刻'))
newButton?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(120)
check('新建按钮回到输入舞台', (view?.textContent ?? '').includes('粘贴链接或上传视频'), (view?.textContent ?? '').slice(0, 120))

// 关闭工作台
const sessionButton = [...(view?.querySelectorAll('button') ?? [])].find(button => (button.textContent ?? '').trim() === '会话')
sessionButton?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(80)
check('关闭后恢复会话视图', !document.documentElement.hasAttribute('data-dvr-active'))

// ---------------------------------------------------------------- 设置页：选择 DSH 已配置模型
const settingsHost = document.createElement('div')
document.body.append(settingsHost)
const settingsRoot = require('react-dom/client').createRoot(settingsHost)
const settingsElement = require('react').createElement(sections[0].component)
settingsRoot.render(settingsElement)
await sleep(250)

const settingsText = settingsHost.textContent ?? ''
check('设置页渲染来源切换', settingsText.includes('DSH 已配置模型') && settingsText.includes('手动填写接口'), settingsText.slice(0, 160))
check('设置页显示 DSH 模型数量', settingsText.includes('DSH 已配置模型：'), settingsText.slice(0, 200))

// 切到 DSH 已配置模型（第一处 = ② AI 拆解）
const dshTab = [...settingsHost.querySelectorAll('button.vr-tab')].find(button => (button.textContent ?? '').includes('DSH 已配置模型'))
dshTab?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(120)
const selects = [...settingsHost.querySelectorAll('select')]
const providerSelect = selects.find(select => [...select.options].some(option => option.textContent?.includes('Mock 提供商')))
check('切到 DSH 后出现提供商下拉', providerSelect !== undefined)
const providerOptions = providerSelect === undefined ? [] : [...providerSelect.options].map(option => option.textContent ?? '')
check('提供商下拉列出 DSH 提供商', providerOptions.some(text => text.includes('Mock 提供商')), providerOptions.join(' | '))
const modelSelect = selects.find(select => [...select.options].some(option => option.value === 'mock-vision'))
const modelOptions = modelSelect === undefined ? [] : [...modelSelect.options].map(option => option.value)
check('模型下拉来自 DSH 目录', modelOptions.includes('mock-vision') && modelOptions.includes('mock-text'), modelOptions.join(','))
const dshHint = settingsHost.textContent ?? ''
check('显示 DSH 自动协议提示', dshHint.includes('协议自动'), dshHint.slice(0, 200))

// 保存：配置里应带上 source=dsh 与选中的模型
const saveButton = [...settingsHost.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === '保存')
saveButton?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(200)
check('保存后提示已保存', (settingsHost.textContent ?? '').includes('已保存'), (settingsHost.textContent ?? '').slice(-160))

settingsRoot.unmount()
settingsHost.remove()

// 卸载
for (const dispose of disposers.reverse()) {
  try {
    dispose()
  } catch (error) {
    failures.push(`卸载失败：${String(error)}`)
  }
}
await sleep(60)
check('卸载后入口被移除', document.querySelector('[data-dvr-entry]') === null)
check('卸载后中栏容器被移除', document.querySelector('[data-dvr-view]') === null)
check('卸载后样式被移除', document.querySelector('style[data-dvr-styles]') === null)

if (failures.length > 0) {
  console.error('\n[client-smoke] 失败项：')
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('\n[client-smoke] 全部通过 ✓')
process.exit(0)
