// 用**真实配置**跑完整六步（会消耗上游额度）。
//
// 与 GUI 走同一份代码：加载 lib/index.js → apply(fake ctx) → 起桥接路由 →
// 建运行 → 上传源视频/产品图 → 六步流水线。区别只有两点：
//   1. 真实宿主里 analyze/rewrite 走 ctx.llm；这里用等价的最小 llm 垫片，
//      直接调该提供商的 OpenAI 兼容端点（意图是验证同一段代码路径）。
//   2. 服务（configEditor / credentials / attachments）用读真实 DSH 配置文件的最小实现。
//
// 用法：node scripts/run-real.mjs [--source <视频路径>] [--product <图片路径>] [--keep]
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe'
const HOME = join(homedir(), '.dsh')
const DATA_ROOT = process.env.DSH_VIDEO_REPLICA_HOME ?? join(HOME, 'storages', 'dsh-video-replica')
const PATCH = join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const CREDS = join(HOME, '.credentials.yaml')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...args) => console.log('[real]', ...args)
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

// ---------------------------------------------------------------- 读真实配置
const config = JSON.parse((await readFile(join(DATA_ROOT, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''))
log('媒体工具', config.media)
log('模型来源', Object.fromEntries(['analyze', 'rewrite', 'image', 'video', 'tts', 'asr'].map(stage => {
  const item = config[stage] ?? {}
  return [stage, item.source === 'dsh' ? `dsh:${item.dshProvider}/${item.dshModel}` : `custom:${item.model}@${item.apiUrl}`]
})))

/** 从桌面 profile 的 cordis.patch.yml 里抠出 llm-pi-ai 的 providers（够用的缩进解析）。 */
function readProviders() {
  const lines = readFileSync(PATCH, 'utf8').split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === '- id: llm-pi-ai')
  const providers = {}
  if (start < 0) return providers
  let current = null
  let inModels = false
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^- id: /.test(line)) break
    const providerMatch = /^\s{6}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (providerMatch !== null) {
      current = providerMatch[1]
      providers[current] = { models: [] }
      inModels = false
      continue
    }
    if (current === null) continue
    const baseMatch = /^\s+baseURL:\s*(\S+)/.exec(line)
    if (baseMatch !== null) { providers[current].baseURL = baseMatch[1]; continue }
    const envMatch = /^\s+apiKeyEnv:\s*(\S+)/.exec(line)
    if (envMatch !== null) { providers[current].apiKeyEnv = envMatch[1]; continue }
    const modelIdMatch = /^\s+-\s+id:\s*(\S+)/.exec(line)
    if (modelIdMatch !== null) { inModels = true; providers[current].models.push({ id: modelIdMatch[1] }); continue }
    if (/^\s+models:\s*$/.test(line)) { inModels = true; continue }
    if (inModels && /^\s{6}\S/.test(line)) inModels = false
  }
  return providers
}

/** 读 ~/.dsh/.credentials.yaml 的 refs（只取需要的那几个 key）。 */
function readCredentials() {
  const refs = {}
  let text = ''
  try {
    text = readFileSync(CREDS, 'utf8')
  } catch {
    return refs
  }
  const start = text.indexOf('\nrefs:')
  if (start < 0) return refs
  for (const line of text.slice(start).split(/\r?\n/)) {
    const match = /^\s{2}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    refs[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return refs
}

const providers = readProviders()
const credentials = readCredentials()
log('DSH 提供商', Object.keys(providers).join(', '))

// ---------------------------------------------------------------- 素材
const work = await mkdtemp(join(tmpdir(), 'dvr-real-'))
const sourcePath = argOf('--source', join(work, 'source.mp4'))
if (argOf('--source', '') === '' && argOf('--url', '') === '') {
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', sourcePath,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`生成素材失败：${result.stderr}`)
}
const productPath = argOf('--product', join(work, 'product.png'))
if (argOf('--product', '') === '') {
  const result = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xd06a3a:s=768x768', '-frames:v', '1', productPath,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`生成产品图失败：${result.stderr}`)
}

// ---------------------------------------------------------------- 最小 DSH 服务垫片
const attachmentStore = new Map()
const imageToDataUrl = ref => {
  const entry = attachmentStore.get(ref?.attachmentId)
  if (entry === undefined) throw new Error('附件不存在')
  return `data:${entry.mediaType};base64,${entry.bytes.toString('base64')}`
}

const fakeLlm = {
  listProviders: () => Object.keys(providers).map(id => ({ id, name: providers[id].displayName ?? id })),
  listModels: async id => (providers[id]?.models ?? []).map(model => ({
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: /(v|vision|vl|image)/i.test(model.id) ? ['text', 'image'] : ['text'],
  })),
  resolveModelInfo: async (_provider, model) => ({
    inputModalities: /(v|vision|vl|image)/i.test(String(model)) ? ['text', 'image'] : ['text'],
  }),
  stream: async function* (options) {
    const provider = providers[options.provider]
    if (provider?.baseURL === undefined) throw new Error(`提供商 ${options.provider} 没有 baseURL`)
    const key = credentials[provider.apiKeyEnv ?? ''] ?? ''
    // 把我们内部的内容块翻译成 OpenAI 兼容的 messages。
    const messages = []
    if (typeof options.system === 'string' && options.system !== '') {
      messages.push({ role: 'system', content: options.system })
    }
    for (const message of options.messages ?? []) {
      if (typeof message.content === 'string') {
        messages.push({ role: message.role, content: message.content })
        continue
      }
      const parts = (message.content ?? []).map(part => {
        if (part.type === 'image') return { type: 'image_url', image_url: { url: imageToDataUrl(part.attachment) } }
        return { type: 'text', text: String(part.text ?? '') }
      })
      messages.push({ role: message.role, content: parts })
    }
    const body = {
      model: options.model,
      messages,
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    }
    const response = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === '' ? {} : { authorization: `Bearer ${key}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })
    const text = await response.text()
    if (!response.ok) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `HTTP ${response.status} ${text.slice(0, 300)}` } } }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `响应不是 JSON：${text.slice(0, 200)}` } } }
      return
    }
    const content = parsed?.choices?.[0]?.message?.content
    const reply = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''
    log(`  llm ${options.provider}/${options.model} → ${reply.length} 字`)
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const fakeServices = {
  llm: fakeLlm,
  attachments: {
    saveImages: async (inputs) => inputs.map((input, index) => {
      const attachmentId = `real-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`
      attachmentStore.set(attachmentId, { bytes: Buffer.from(input.data), mediaType: input.mediaType })
      return { attachmentId, mediaType: input.mediaType, bytes: input.data.length, width: 512, height: 512 }
    }),
  },
  configEditor: { entries: () => [{ options: { id: 'llm-pi-ai', config: { providers } } }] },
  credentials: {
    resolve: async name => (credentials[name] === undefined ? undefined : { value: credentials[name] }),
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'workbuddy', model: 'glm-5.3' }) },
  systemPrompt: { section: () => () => {} },
}

// ---------------------------------------------------------------- 起插件与路由
const routes = []
const fakeCtx = {
  effect: run => { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} },
  get: name => fakeServices[name],
  on: () => () => {},
  webServer: { register: route => { routes.push(route); return () => {} } },
  systemPrompt: fakeServices.systemPrompt,
}
const plugin = await import('../lib/index.js')
plugin.apply(fakeCtx, {})
for (let i = 0; i < 60 && routes.length === 0; i += 1) await sleep(100)
if (routes.length === 0) throw new Error('路由没有挂载')

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = routes.find(item => item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"ok":false,"error":"no route"}')
    return
  }
  Promise.resolve(route.handler(req, res)).catch(error => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const API_ROOT = `http://127.0.0.1:${server.address().port}/api/dsh-video-replica`

async function call(path, options = {}) {
  const response = await fetch(path, options)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: text.slice(0, 300) }
  }
}

let lastLogIndex = 0

// ---------------------------------------------------------------- 提示词预览（--preview-prompts <runId>）
const previewRunId = argOf('--preview-prompts', '')
if (previewRunId !== '') {
  const response = await call(`${API_ROOT}/run/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: previewRunId, action: 'preview-prompts' }),
  })
  let value = response
  while (value !== undefined && value !== null && value.frames === undefined && value.value !== undefined) {
    value = value.value
  }
  if (value?.frames === undefined) {
    log('预览失败', JSON.stringify(response).slice(0, 400))
    await new Promise(resolve => server.close(resolve))
    process.exit(1)
  }
  log(`版本 ${value.variantId}｜产品融入方式 ${value.productMode}｜首帧 ${value.frames.length} 张｜视频 ${value.videos.length} 段`)
  for (const frame of value.frames) {
    console.log(`\n=== 首帧 SH${String(frame.segmentIndex).padStart(2, '0')} [${frame.shotType}/${frame.camera}] ===`)
    console.log(frame.framePrompt)
  }
  for (const video of value.videos) {
    console.log(`\n=== 视频段 ${video.segmentIndex}（${video.durationSec}s，镜 ${video.shots.join(',')}）===`)
    console.log(video.videoPrompt)
  }
  await new Promise(resolve => server.close(resolve))
  process.exit(0)
}

// ---------------------------------------------------------------- 单段/单张重生成（--regenerate-segment N / --regenerate-frame N）
const regenerateSegmentIndex = argOf('--regenerate-segment', '')
const regenerateFrameIndex = argOf('--regenerate-frame', '')
const regenerateRunId = argOf('--run-id', '')
if ((regenerateSegmentIndex !== '' || regenerateFrameIndex !== '') && regenerateRunId !== '') {
  const action = regenerateSegmentIndex !== '' ? 'regenerate-segment' : 'regenerate-frame'
  const segmentIndex = Number(regenerateSegmentIndex !== '' ? regenerateSegmentIndex : regenerateFrameIndex)
  const result = await call(`${API_ROOT}/run/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: regenerateRunId,
      action,
      segmentIndex,
      ...(argOf('--prompt', '') === '' ? {} : { prompt: argOf('--prompt', '') }),
    }),
  })
  log(`${action} #${segmentIndex}`, result.ok === true ? '已启动' : JSON.stringify(result).slice(0, 300))
  for (let index = 0; index < 1440; index += 1) {
    const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(regenerateRunId)}`)
    const current = response.value?.run
    if (current !== undefined) {
      const fresh = (current.logs ?? []).slice(lastLogIndex)
      lastLogIndex = (current.logs ?? []).length
      for (const entry of fresh) log(`  [${entry.step}] ${entry.level} ${entry.text.slice(0, 260)}`)
      const slot = action === 'regenerate-segment'
        ? current.segments?.find(item => item.segmentIndex === segmentIndex)
        : current.frames?.find(item => item.segmentIndex === segmentIndex)
      const done = response.value?.busy !== true && slot !== undefined
        && ['done', 'failed'].includes(slot.status ?? (slot.file === '' ? 'failed' : 'done'))
      if (done) {
        log('重生成结果', JSON.stringify(slot).slice(0, 300))
        await new Promise(resolve => server.close(resolve))
        process.exit(slot.status === 'failed' ? 1 : 0)
      }
    }
    await sleep(2500)
  }
  await new Promise(resolve => server.close(resolve))
  process.exit(1)
}

// ---------------------------------------------------------------- 逐步执行（可复用）
async function runSteps(runId, steps) {
  for (const step of steps) {
    const action = await call(`${API_ROOT}/run/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, action: 'step', step }),
    })
    log(`${runId} 的 ${step}`, action.ok === true ? '已启动' : JSON.stringify(action).slice(0, 200))
    let settled = 'failed'
    for (let index = 0; index < 1440; index += 1) {
      const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(runId)}`)
      const current = response.value?.run
      if (current !== undefined) {
        const fresh = (current.logs ?? []).slice(lastLogIndex)
        lastLogIndex = (current.logs ?? []).length
        for (const entry of fresh) log(`  [${entry.step}] ${entry.level} ${entry.text.slice(0, 300)}`)
        const target = current.steps.find(item => item.id === step)
        const done = response.value?.busy !== true && target !== undefined
          && ['done', 'failed', 'skipped'].includes(target.status)
        if (done) {
          settled = target.status
          if (target.error !== undefined) log(`  ${step} 失败原因：${target.error.slice(0, 400)}`)
          break
        }
      }
      await sleep(2500)
    }
    log(`${step} → ${settled}`)
    if (settled !== 'done') return { ok: false, steps }
  }
  return { ok: true, steps }
}

const resumeRunId = argOf('--run-id', '')
const singleStep = argOf('--step', '')
const chain = (argOf('--steps', '').split(',') ?? []).map(item => item.trim()).filter(item => item !== '')
const steps = chain.length > 0 ? chain : (singleStep === '' ? [] : [singleStep])
if (resumeRunId !== '' && steps.length > 0) {
  const result = await runSteps(resumeRunId, steps)
  const finalRun = (await call(`${API_ROOT}/run?runId=${encodeURIComponent(resumeRunId)}`)).value?.run
  for (const item of finalRun?.steps ?? []) log(`  ${item.id.padEnd(9)} ${item.status.padEnd(8)} ${item.message ?? ''}`)
  await new Promise(resolve => server.close(resolve))
  process.exit(result.ok ? 0 : 1)
}

// ---------------------------------------------------------------- 建运行 + 上传 + 执行
const productBrief = argOf('--brief', '茉知味苹屿乌龙轻乳茶，卖点：国风轻乳茶、苹果+茉莉冷萃、下午茶解腻')
const sourceUrl = argOf('--url', '')
const noProduct = args.includes('--no-product')
const created = await call(`${API_ROOT}/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: noProduct ? '纯复刻联调（无产品）' : (sourceUrl === '' ? '真实模型联调' : '真实链接联调'),
    ...(noProduct ? {} : { productBrief }),
    ...(sourceUrl === '' ? {} : { url: sourceUrl }),
    autoAdvance: steps.length === 0,
  }),
})
const runId = created?.value?.run?.id
if (typeof runId !== 'string') throw new Error(`建运行失败：${JSON.stringify(created).slice(0, 300)}`)
log('runId', runId)

if (sourceUrl === '') {
  const uploadVideo = await fetch(`${API_ROOT}/upload?runId=${encodeURIComponent(runId)}&kind=video&name=${encodeURIComponent('source.mp4')}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4' },
    body: await readFile(sourcePath),
  })
  log('上传源视频', (await uploadVideo.json()).ok)
} else {
  log('源链接', sourceUrl)
}
if (!noProduct) {
  const uploadProduct = await fetch(`${API_ROOT}/upload?runId=${encodeURIComponent(runId)}&kind=product&name=${encodeURIComponent('product.png')}`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: await readFile(productPath),
  })
  log('上传产品图', (await uploadProduct.json()).ok)
} else {
  log('纯复刻模式：不上传产品图')
}

if (steps.length > 0) {
  const result = await runSteps(runId, steps)
  const state = (await call(`${API_ROOT}/run?runId=${encodeURIComponent(runId)}`)).value?.run
  for (const item of state?.steps ?? []) log(`  ${item.id.padEnd(9)} ${item.status.padEnd(8)} ${item.message ?? ''}`)
  log('源信息', JSON.stringify(state?.source ?? {}).slice(0, 400))
  if (state?.analysis !== undefined) log(`拆解：${state.analysis.shots.length} 镜｜${state.analysis.summary.slice(0, 100)}`)
  await new Promise(resolve => server.close(resolve))
  process.exit(result.ok ? 0 : 1)
}

const started = await call(`${API_ROOT}/run/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, action: 'start', autoAdvance: true }),
})
if (started.ok !== true) throw new Error(`启动失败：${JSON.stringify(started).slice(0, 300)}`)

// ---------------------------------------------------------------- 轮询并打印步骤变化
let lastStepKey = ''
let snapshot
const deadline = Date.now() + Number(argOf('--timeout-min', '30')) * 60_000
for (;;) {
  const response = await call(`${API_ROOT}/run?runId=${encodeURIComponent(runId)}`)
  snapshot = response.value
  const run = snapshot?.run
  if (run !== undefined) {
    const stepKey = run.steps.map(step => `${step.id}:${step.status}:${step.progress?.toFixed?.(2) ?? ''}`).join('|')
    if (stepKey !== lastStepKey) {
      lastStepKey = stepKey
      const active = run.steps.find(step => step.status === 'running') ?? run.steps.find(step => step.status === 'failed')
      if (active !== undefined) log(`${active.id} ${active.status} ${active.message ?? ''}`)
    }
    const fresh = (run.logs ?? []).slice(lastLogIndex)
    lastLogIndex = (run.logs ?? []).length
    for (const entry of fresh) log(`  [${entry.step}] ${entry.level} ${entry.text.slice(0, 240)}`)
    if (['done', 'failed', 'stopped'].includes(run.status)) break
  }
  if (Date.now() > deadline) {
    log('超时，停止任务')
    await call(`${API_ROOT}/run/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId, action: 'stop' }),
    })
    break
  }
  await sleep(2500)
}

const run = snapshot?.run
log('最终状态', run?.status)
for (const step of run?.steps ?? []) {
  log(`  ${step.id.padEnd(9)} ${step.status.padEnd(8)} ${step.message ?? ''}${step.error === undefined ? '' : ` | ${step.error.slice(0, 400)}`}`)
}
if (run?.analysis !== undefined) log(`拆解：${run.analysis.shots.length} 镜｜${run.analysis.summary.slice(0, 120)}`)
if (run?.scripts !== undefined) log(`脚本：${run.scripts.variants.length} 版；选中 ${run.variantId}`)
if (run?.frames !== undefined) log(`参考图：${run.frames.filter(frame => frame.file !== '').length}/${run.frames.length}`)
if (run?.segments !== undefined) {
  log(`分镜视频：${run.segments.filter(segment => segment.status === 'done').length}/${run.segments.length}`)
  for (const segment of run.segments) log(`  seg ${segment.segmentIndex} ${segment.status} ${segment.durationSec?.toFixed?.(1) ?? '?'}s ${segment.error?.slice(0, 200) ?? ''}`)
}
if (run?.compose !== undefined) {
  log('成片', run.compose.file, `${run.compose.durationSec?.toFixed?.(1)}s`, `${run.compose.width}x${run.compose.height}`, `audio=${run.compose.hasAudio}`)
}

const runDir = join(DATA_ROOT, 'runs', runId)
const finalPath = join(runDir, run?.compose?.file ?? 'final.mp4')
const finalStat = await stat(finalPath).catch(() => undefined)
if (finalStat !== undefined) {
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', finalPath], { encoding: 'utf8' })
  const info = JSON.parse(probe.stdout || '{}')
  log('成片探测', JSON.stringify({
    duration: Number(info?.format?.duration ?? 0).toFixed(2),
    size: finalStat.size,
    streams: (info.streams ?? []).map(stream => `${stream.codec_type}:${stream.codec_name}:${stream.width ?? ''}x${stream.height ?? ''}`),
  }))
  log('成片路径', finalPath)
} else {
  log('没有成片；运行目录', runDir)
}

await new Promise(resolve => server.close(resolve))
if (args.includes('--keep')) log('保留临时素材目录', work)
process.exit(run?.status === 'done' ? 0 : 1)
