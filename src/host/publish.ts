/**
 * 第七步：一键发布（视频号）。
 *
 * 视频号创作页的关键事实（2026-11 实测）：
 * - 编辑器在**独立进程的 iframe** `channels.weixin.qq.com/micro/content/post/create` 里，
 *   主文档只有一个 empty.html iframe；Playwright 的 locator 在这个 frame 上**查不到元素**
 *   （evaluate 能查到，locator 返回 0），所以这里的交互全部走 frame.evaluate + CDP。
 * - 上传入口是隐藏的 `input[type=file][accept*=video]`，用 CDP
 *   `DOM.getDocument {pierce:true}` 找到 nodeId 后 `DOM.setFileInputFiles` 塞文件。
 * - 上传中会出现「取消上传 / N%」；完成后预览出现「删除」按钮。
 * - 描述是 `div.input-editor[contenteditable]`（placeholder「添加描述」），
 *   要用 focus + execCommand('insertText') 才触发编辑器状态。
 * - 短标题是 `input[placeholder*="短标题"]`，得用原生 value setter + input/change 事件。
 * - 「发表」必须用**真实鼠标点击**（page.mouse.click）：JS 的 btn.click() 不会提交。
 * - 成功信号是页面上出现「发表成功」，随后作品出现在 /platform/post/list。
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Frame, type Page } from 'playwright-core'

// ---------------------------------------------------------------------------
// 浏览器启动
// ---------------------------------------------------------------------------

/** 发布专用 profile：与浏览器插件的 profile 分开，避免两个 Chromium 抢同一个目录。 */
export function publishProfileDir(): string {
  return process.env.DSH_VIDEO_REPLICA_PUBLISH_PROFILE ?? join(homedir(), '.dsh', 'browser-profiles', 'video-replica-publish')
}

function describeLaunchError(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error)
}

/** 依次尝试：显式可执行文件 → playwright 自带 chromium → 系统 Edge → 系统 Chrome。 */
export async function launchPublishBrowser(): Promise<{ context: BrowserContext, how: string }> {
  const dir = publishProfileDir()
  await mkdir(dir, { recursive: true }).catch(() => {})
  const base = { headless: false, viewport: { width: 1280, height: 920 }, locale: 'zh-CN' } as const
  const attempts: Array<{ label: string, options: Record<string, unknown> }> = []

  const explicit = process.env.DSH_VIDEO_REPLICA_BROWSER
  if (explicit !== undefined && explicit.trim() !== '') {
    attempts.push({ label: `executablePath=${explicit}`, options: { ...base, executablePath: explicit } })
  }
  const bundled = chromium.executablePath()
  if (bundled !== '' && existsSync(bundled)) {
    attempts.push({ label: 'playwright chromium', options: { ...base, executablePath: bundled } })
  }
  attempts.push({ label: 'msedge', options: { ...base, channel: 'msedge' } })
  attempts.push({ label: 'chrome', options: { ...base, channel: 'chrome' } })

  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      const context = await chromium.launchPersistentContext(dir, attempt.options as never)
      return { context, how: attempt.label }
    } catch (error) {
      failures.push(`${attempt.label}: ${describeLaunchError(error)}`)
    }
  }
  throw new Error(
    '找不到可用的浏览器（Edge / Chrome / playwright chromium 都启动失败）。'
    + '可以安装 Microsoft Edge 或 Google Chrome，或用环境变量 DSH_VIDEO_REPLICA_BROWSER 指向浏览器可执行文件。\n'
    + failures.join('\n'),
  )
}

// ---------------------------------------------------------------------------
// 页面工具（视频号专用）
// ---------------------------------------------------------------------------

const CREATE_URL = 'https://channels.weixin.qq.com/platform/post/create'
const EDITOR_FRAME = '/micro/content/post/create'

export function isLoginUrl(url: string): boolean {
  return /\/login(\.html)?(\?|$|\/)/.test(url)
}

/** 等编辑器 iframe 出现并返回它（视频号把整个创作区放在独立 frame 里）。 */
export async function editorFrame(page: Page, timeoutMs = 40_000): Promise<Frame | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const frame = page.frames().find(item => item.url().includes(EDITOR_FRAME))
    if (frame !== undefined) return frame
    if (Date.now() > deadline) return undefined
    await page.waitForTimeout(400)
  }
}

/** 登录判断：主页面在登录页，或编辑器 frame 迟迟不出现且正文是登录文案。 */
export async function isLoginPage(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) return true
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
  return /登录视频号助手|微信扫一扫|扫码登录/.test(body) && !/视频管理/.test(body)
}

async function frameText(frame: Frame): Promise<string> {
  return await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '')
}

interface FileInputNode {
  nodeId: number
}

function collectFileInputs(rawNode: unknown, out: FileInputNode[], onlyVideo: boolean): void {
  if (rawNode === undefined || rawNode === null || typeof rawNode !== 'object') return
  const node = rawNode as Record<string, unknown>
  const nodeName = String(node.nodeName ?? '')
  if (nodeName === 'INPUT') {
    const raw = node.attributes
    const attrs: Record<string, string> = {}
    if (Array.isArray(raw)) {
      for (let index = 0; index < raw.length; index += 2) {
        attrs[String(raw[index])] = String(raw[index + 1])
      }
    }
    if (attrs.type === 'file' && (!onlyVideo || /video/i.test(attrs.accept ?? ''))) {
      out.push({ nodeId: Number(node.nodeId) })
    }
  }
  for (const key of ['children', 'shadowRoots', 'contentDocument', 'pseudoElements']) {
    const kids = node[key]
    if (Array.isArray(kids)) for (const kid of kids) collectFileInputs(kid, out, onlyVideo)
  }
}

/** 用 CDP 把本地文件塞进编辑器 iframe 里的隐藏 file input（上传控件会延迟挂载，轮询等它）。 */
export async function attachVideo(context: BrowserContext, page: Page, videoFile: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cdp: CDPSession = await context.newCDPSession(page)
    try {
      const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as unknown as { root?: Record<string, unknown> }
      const candidates: FileInputNode[] = []
      collectFileInputs(document.root, candidates, true)
      if (candidates.length === 0) collectFileInputs(document.root, candidates, false)
      const first = candidates[0]
      if (first !== undefined) {
        await cdp.send('DOM.setFileInputFiles', { files: [videoFile], nodeId: first.nodeId })
        return
      }
    } finally {
      await cdp.detach().catch(() => {})
    }
    if (Date.now() > deadline) throw new Error('编辑器里没找到视频上传入口（input[type=file]），页面可能改版')
    await page.waitForTimeout(800)
  }
}

/** 等视频上传完成：连续两次「没有取消上传、出现删除按钮」。 */
export async function waitForUpload(frame: Frame, options: {
  timeoutSec: number
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let stable = 0
  let noted = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const text = await frameText(frame)
    if (/上传失败|转码失败/.test(text)) throw new Error('平台提示上传/转码失败，请到浏览器窗口查看')
    const uploading = /取消上传/.test(text)
    const uploaded = /删除/.test(text)
    if (!uploading && uploaded) {
      stable += 1
      if (stable >= 2) return
    } else {
      stable = 0
    }
    if (Date.now() > deadline) throw new Error('等待视频上传超时，请到浏览器窗口查看上传进度')
    if (Date.now() - noted > 20_000) {
      const percent = text.match(/(\d{1,3})\s*%/)?.[1]
      options.log('info', percent === undefined ? '视频上传中…' : `视频上传中… ${percent}%`)
      noted = Date.now()
    }
    await frame.waitForTimeout(3000)
  }
}

/** 填描述 + 短标题（都在编辑器 iframe 里，用页面内 JS 触发编辑器状态）。 */
export async function fillFields(frame: Frame, input: { description: string, title?: string }): Promise<void> {
  await frame.evaluate((payload) => {
    const editor = document.querySelector('div.input-editor[contenteditable]') as HTMLDivElement | null
    if (editor !== null) {
      editor.focus()
      editor.innerHTML = ''
      document.execCommand('insertText', false, payload.description)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      editor.blur()
    }
    if (payload.title !== undefined && payload.title !== '') {
      const titleInput = [...document.querySelectorAll('input')]
        .find(item => (item.placeholder ?? '').includes('短标题')) as HTMLInputElement | undefined
      if (titleInput !== undefined) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(titleInput, payload.title)
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        titleInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
  }, { description: input.description, title: input.title })
}

/** 真实鼠标点击「发表」：JS click 不会提交，必须走鼠标。 */
export async function clickSubmit(page: Page, frame: Frame): Promise<void> {
  const rect = await frame.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => (item.innerText ?? '').trim() === '发表')
    if (button === undefined) return null
    button.scrollIntoView({ block: 'center' })
    const box = button.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, top: box.top, bottom: box.bottom }
  })
  if (rect === null) throw new Error('没找到「发表」按钮：页面可能改版，浏览器窗口保留，可手动点发表')
  await page.waitForTimeout(800)
  const inView = rect.top >= 0 && rect.bottom <= (page.viewportSize()?.height ?? 900)
  if (!inView) throw new Error('「发表」按钮不在可视区，请到浏览器窗口里手动点发表')
  await page.mouse.click(rect.x, rect.y)
}

/** 等发布结果：成功 / 失败 / 被二次确认拦下。 */
export async function waitForPublishResult(page: Page, frame: Frame, options: {
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const deadline = Date.now() + 120_000
  let confirmed = false
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    await page.waitForTimeout(2500)
    const text = await frameText(frame)
    if (/发表成功|发布成功|已发表/.test(text)) return page.url()
    if (/发表失败|违规|不可发布|请完善/.test(text)) {
      const line = text.split('\n').map(item => item.trim()).find(item => /失败|违规|不可发布|请完善/.test(item))
      throw new Error(`平台提示：${line ?? '发布失败'}`)
    }
    if (!confirmed) {
      const confirmedClick = await frame.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(item => /^(确认|确定|继续发表)$/.test((item.innerText ?? '').trim()))
        if (button === undefined) return false
        button.click()
        return true
      }).catch(() => false)
      if (confirmedClick) {
        confirmed = true
        options.log('info', '点了发表后出现二次确认，已自动确认')
        continue
      }
    }
    if (Date.now() > deadline) throw new Error('点了发表但没等到成功提示，请到浏览器窗口确认')
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface PublishProgress {
  status: 'waiting-login' | 'uploading' | 'publishing' | 'waiting-verify'
  message: string
}

export interface PublishChannelsOptions {
  videoFile: string
  description: string
  title?: string
  /** 发布封面主图（不传则由平台自动截帧）。 */
  coverFile?: string
  /** ffmpeg 可执行文件（裁封面用）。 */
  ffmpegPath?: string
  signal?: AbortSignal
  log: (level: 'info' | 'warn', text: string) => void
  onProgress: (progress: PublishProgress) => void
  loginTimeoutSec?: number
  uploadTimeoutSec?: number
  keepOpenOnError?: boolean
  runDir?: string
}

export interface PublishChannelsResult {
  postUrl: string
  screenshot?: string
  browser: string
}

async function capture(page: Page, runDir: string | undefined, tag: string): Promise<string | undefined> {
  if (runDir === undefined) return undefined
  try {
    const dir = join(runDir, 'publish')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${tag}-${Date.now()}.png`)
    await page.screenshot({ path: file })
    return `publish/${file.split(/[\\/]/).pop()}`
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 发布封面
// ---------------------------------------------------------------------------

export interface CoverCrops {
  portrait: string
  landscape: string
}

/** 把封面主图裁成 3:4 与 4:3 两张（平台卡片用）。 */
export async function prepareCoverCrops(options: {
  coverFile: string
  runDir: string
  ffmpegPath: string
}): Promise<CoverCrops | undefined> {
  const dir = join(options.runDir, 'cover')
  await mkdir(dir, { recursive: true })
  const portrait = join(dir, 'cover-3x4.jpg')
  const landscape = join(dir, 'cover-4x3.jpg')
  const run = async (output: string, w: number, h: number): Promise<void> => {
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', options.coverFile,
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
        '-frames:v', '1', '-q:v', '2', output,
      ], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg 裁封面失败（${code}）`))))
    })
  }
  try {
    await run(portrait, 1080, 1440)
    await run(landscape, 1440, 1080)
    return { portrait, landscape }
  } catch {
    return undefined
  }
}

/** 用 CDP 把图片塞进当前页面里 accept 含 image 的 file input（跨 frame 找）。 */
/** 点「上传封面」按钮走文件选择器（比猜 input 更稳），失败再退回直接塞 input。 */
async function setCoverByChooser(page: Page, imageFile: string): Promise<boolean> {
  const buttons = page.getByText('上传封面', { exact: true })
  const count = await buttons.count().catch(() => 0)
  for (let index = count - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index)
    if (!(await button.isVisible().catch(() => false))) continue
    const chooser = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => undefined)
    await button.click().catch(() => {})
    const event = await chooser
    if (event !== undefined) {
      await event.setFiles(imageFile).catch(() => {})
      return true
    }
  }
  return false
}

async function setCoverImageInput(context: BrowserContext, page: Page, imageFile: string): Promise<boolean> {
  // 先试 Playwright 定位：抖音页面上有多个图片 file input（商品封面等），
  // 用最后一个「位于可见弹窗内」的输入框，避免把封面上传到别的控件里。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidates = page.locator('input[type=file][accept*="image" i]')
    const count = await candidates.count().catch(() => 0)
    if (count > 0) {
      for (let index = count - 1; index >= 0; index -= 1) {
        const input = candidates.nth(index)
        const visible = await input.isVisible().catch(() => false)
        const box = visible ? await input.boundingBox().catch(() => null) : null
        if (visible && box !== null) {
          await input.setInputFiles(imageFile).catch(() => {})
          return true
        }
      }
      // 全都不可见时退回到最后一个（上传按钮常是隐藏 input + 自定义按钮）。
      await candidates.nth(count - 1).setInputFiles(imageFile).catch(() => {})
      return true
    }
    await page.waitForTimeout(800)
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const cdp = await context.newCDPSession(page)
    try {
      const document = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as unknown as { root?: Record<string, unknown> }
      const candidates: Array<{ nodeId: number, accept: string }> = []
      const walk = (node: unknown): void => {
        if (node === undefined || node === null || typeof node !== 'object') return
        const raw = node as Record<string, unknown>
        if (raw.nodeName === 'INPUT' && Array.isArray(raw.attributes)) {
          const attrs: Record<string, string> = {}
          const list = raw.attributes as unknown[]
          for (let index = 0; index < list.length; index += 2) attrs[String(list[index])] = String(list[index + 1])
          if (attrs.type === 'file' && /image/i.test(attrs.accept ?? '')) candidates.push({ nodeId: Number(raw.nodeId), accept: attrs.accept })
        }
        for (const key of ['children', 'shadowRoots', 'contentDocument', 'pseudoElements']) {
          const kids = (raw as Record<string, unknown>)[key]
          if (Array.isArray(kids)) for (const kid of kids) walk(kid)
        }
      }
      walk(document.root)
      const first = candidates[0]
      if (first !== undefined) {
        await cdp.send('DOM.setFileInputFiles', { files: [imageFile], nodeId: first.nodeId })
        return true
      }
    } finally {
      await cdp.detach().catch(() => {})
    }
    await page.waitForTimeout(800)
  }
  return false
}

/** 视频号：分别设置「个人主页卡片 3:4」与「分享卡片 4:3」封面。 */
export async function applyChannelsCover(context: BrowserContext, page: Page, crops: CoverCrops, log: (level: 'info' | 'warn', text: string) => void): Promise<void> {
  const jobs: Array<{ kind: 'portrait' | 'landscape', wrap: string, label: string, file: string }> = [
    { kind: 'portrait', wrap: 'vertical-img-wrap', label: '个人主页卡片 3:4', file: crops.portrait },
    { kind: 'landscape', wrap: 'horizon-img-wrap', label: '分享卡片 4:3', file: crops.landscape },
  ]
  for (const job of jobs) {
    const frame = await editorFrame(page)
    if (frame === undefined) return
    const opened = await frame.evaluate((wrapClass) => {
      const wrap = document.querySelector(`.${wrapClass}`)
      if (wrap === null) return false
      const button = wrap.querySelector('.edit-btn') ?? [...wrap.querySelectorAll('*')].find(item => ((item as HTMLElement).innerText ?? '').trim() === '编辑')
      if (button === undefined || button === null) return false
      ;(button as HTMLElement).click()
      return true
    }, job.wrap).catch(() => false)
    if (!opened) { log('warn', `视频号：没找到${job.label}的封面编辑入口，跳过`); continue }
    await page.waitForTimeout(1500)
    const uploaded = (await setCoverByChooser(page, job.file)) || (await setCoverImageInput(context, page, job.file))
    if (!uploaded) { log('warn', `视频号：${job.label}封面上传入口没出现，跳过`); continue }
    await page.waitForTimeout(1500)
    const confirmed = await frame.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(item => (item.innerText ?? '').trim() === '确认')
      if (button === undefined) return false
      ;(button as HTMLElement).click()
      return true
    }).catch(() => false)
    // 等弹窗真正关掉再处理下一张，否则第二次点击会落在旧弹窗上。
    for (let waitIndex = 0; waitIndex < 10; waitIndex += 1) {
      await page.waitForTimeout(500)
      const open = await (await editorFrame(page))?.evaluate(() => /编辑(个人主页|分享)卡片/.test(document.body.innerText)).catch(() => false)
      if (open !== true) break
    }
    log(confirmed ? 'info' : 'warn', confirmed ? `视频号：已设置${job.label}封面` : `视频号：${job.label}封面没找到确认按钮，已上传但可能未生效`)
  }
}

/** 抖音：分别设置竖封面 3:4 与横封面 4:3（真实浏览器实测通过）。 */
export async function applyDouyinCover(context: BrowserContext, page: Page, crops: CoverCrops, log: (level: 'info' | 'warn', text: string) => void): Promise<void> {
  const clickButton = async (text: string): Promise<boolean> => page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find(item => (item.innerText ?? '').trim() === label)
    if (button === undefined) return false
    ;(button as HTMLElement).click()
    return true
  }, text).catch(() => false)

  const waitDialogClosed = async (): Promise<void> => {
    for (let index = 0; index < 16; index += 1) {
      await page.waitForTimeout(500)
      const open = await page.evaluate(() => /设置横封面|设置竖封面/.test(document.body.innerText)).catch(() => false)
      if (open !== true) return
    }
  }

  /** 打开某个封面格子的编辑器：按「竖封面3:4 / 横封面4:3」标签定位其控制区，点「选择封面 / 编辑封面」。 */
  const openEditor = async (label: string): Promise<boolean> => {
    const opened = await page.evaluate((target) => {
      const labelEl = [...document.querySelectorAll('*')].find(item => (item.textContent ?? '').trim() === target && item.children.length === 0)
      const control = labelEl?.closest('[class*="coverControl"]')
      if (control === null || control === undefined) return false
      const trigger = [...control.querySelectorAll('*')].find(item => /^(选择封面|编辑封面)$/.test((item.textContent ?? '').trim()) && item.children.length === 0)
      if (trigger === undefined) return false
      ;(trigger as HTMLElement).click()
      return true
    }, label).catch(() => false)
    if (!opened) return false
    await page.waitForTimeout(2500)
    return true
  }

  const uploadLastImage = async (file: string): Promise<boolean> => {
    // 抖音封面对话框里会额外挂出多个图片 input；实测最后一个（semi-upload upload-*）才是封面。
    const inputs = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')]
      .map((input, index) => ({ index, accept: (input as HTMLInputElement).accept }))
      .filter(item => /image/i.test(item.accept))).catch(() => [])
    const last = inputs[inputs.length - 1]
    if (last === undefined) return false
    await page.locator('input[type=file]').nth(last.index).setInputFiles(file).catch(() => {})
    await page.waitForTimeout(4000)
    return true
  }

  const jobs: Array<{ label: string, file: string, name: string }> = [
    { label: '竖封面3:4', file: crops.portrait, name: '竖封面 3:4' },
    { label: '横封面4:3', file: crops.landscape, name: '横封面 4:3' },
  ]
  let done = 0
  for (const job of jobs) {
    if (!(await openEditor(job.label))) {
      log('warn', `抖音：没找到${job.name}的入口，跳过`)
      continue
    }
    if (!(await uploadLastImage(job.file))) {
      log('warn', `抖音：${job.name}上传入口没出现，跳过`)
      await waitDialogClosed()
      continue
    }
    const confirmed = await clickButton('完成')
    await waitDialogClosed()
    // 平台常在这时弹「设置横/竖封面」引导，点「暂不设置」关掉，避免挡住后续操作。
    if (await clickButton('暂不设置')) await page.waitForTimeout(1200)
    if (confirmed) {
      done += 1
      log('info', `抖音：已设置${job.name}`)
    } else {
      log('warn', `抖音：${job.name}没找到完成按钮，已上传但可能未生效`)
    }
  }
  log(done === jobs.length ? 'info' : 'warn', done === jobs.length ? '抖音：横竖封面都已设置' : `抖音：只设置了 ${done}/${jobs.length} 张封面`)
}

/** 发布一条成片到视频号。 *//** 发布一条成片到视频号。 *//** 发布一条成片到视频号。 */
export async function publishToChannels(options: PublishChannelsOptions): Promise<PublishChannelsResult> {
  const { videoFile, description, title, signal, log, onProgress } = options
  const { context, how } = await launchPublishBrowser()
  log('info', `浏览器已启动（${how}），profile：${publishProfileDir()}`)
  let keepOpen = options.keepOpenOnError !== false
  try {
    const page = context.pages()[0] ?? await context.newPage()
    onProgress({ status: 'waiting-login', message: '打开视频号创作页…' })
    await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1500)

    if (await isLoginPage(page)) {
      onProgress({ status: 'waiting-login', message: '等待扫码登录…' })
      log('info', '视频号未登录：请在弹出的浏览器窗口里用微信扫码，登录后自动继续')
      const deadline = Date.now() + (options.loginTimeoutSec ?? 300) * 1000
      for (;;) {
        if (signal?.aborted === true) throw new Error('已停止')
        if (!(await isLoginPage(page))) break
        if (Date.now() > deadline) throw new Error('扫码登录超时，请重新点发布')
        await page.waitForTimeout(2000)
      }
      await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1500)
    }

    const frame = await editorFrame(page)
    if (frame === undefined) throw new Error('没等到视频号编辑器加载（可能未登录或页面改版），浏览器窗口保留可手动处理')

    // 起始页可能弹「将此次编辑保留?」，选择不保存，从干净状态开始。
    await frame.evaluate(() => {
      const discard = [...document.querySelectorAll('button')].find(item => (item.innerText ?? '').trim() === '不保存')
      discard?.click()
    }).catch(() => {})

    onProgress({ status: 'uploading', message: '上传成片…' })
    log('info', `开始上传：${videoFile}`)
    await attachVideo(context, page, videoFile)
    await waitForUpload(frame, {
      timeoutSec: options.uploadTimeoutSec ?? 900,
      log,
      ...(signal === undefined ? {} : { signal }),
    })
    log('info', '视频上传完成')

    if (options.coverFile !== undefined && options.coverFile !== '') {
      onProgress({ status: 'publishing', message: '设置发布封面…' })
      const crops = await prepareCoverCrops({
        coverFile: options.coverFile,
        runDir: options.runDir ?? publishProfileDir(),
        ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
      })
      if (crops === undefined) log('warn', '封面裁剪失败，沿用平台自动截帧')
      else await applyChannelsCover(context, page, crops, log)
    }

    onProgress({ status: 'publishing', message: '填写标题和描述…' })
    await fillFields(frame, { description, ...(title === undefined ? {} : { title }) })
    log('info', '标题和描述已填写')

    onProgress({ status: 'publishing', message: '点发表…' })
    await clickSubmit(page, frame)
    const postUrl = await waitForPublishResult(page, frame, { log, ...(signal === undefined ? {} : { signal }) })
    const screenshot = await capture(page, options.runDir, 'post-ok')
    log('info', '已发表成功')
    keepOpen = false
    return { postUrl, ...(screenshot === undefined ? {} : { screenshot }), browser: how }
  } catch (error) {
    const shot = await capture(context.pages()[0] as Page, options.runDir, 'post-fail').catch(() => undefined)
    if (shot !== undefined) log('warn', `失败截图：${shot}`)
    if (keepOpen) log('warn', '浏览器窗口保留：可以在窗口里手动完成或排查，处理完关掉即可')
    throw error
  } finally {
    if (!keepOpen) await context.close().catch(() => {})
  }
}

/** 把发布截图存到运行目录（兼容旧调用）。 */
export async function savePublishShot(runDir: string, bytes: Uint8Array): Promise<string> {
  const dir = join(runDir, 'publish')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `post-${Date.now()}.png`)
  await writeFile(file, bytes)
  return `publish/${file.split(/[\\/]/).pop()}`
}

// ---------------------------------------------------------------------------
// 抖音（创作者中心）
// ---------------------------------------------------------------------------

const DOUYIN_UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'

async function pageText(page: Page): Promise<string> {
  const main = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
  let extra = ''
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    if (text !== '') extra += `\n${text}`
  }
  return `${main}${extra}`
}

/** 跨 frame 找第一个满足条件的 locator（抖音编辑器可能在子 frame 里）。 */
async function firstLocatorAcrossFrames(
  page: Page,
  predicate: (frame: Frame) => Promise<number>,
): Promise<import('playwright-core').Locator | undefined> {
  for (const frame of page.frames()) {
    const count = await predicate(frame).catch(() => 0)
    if (count > 0) return frame.locator('*').first()
  }
  return undefined
}

/** 逐个 frame 试一个操作，返回第一个成功的位置（供上传/填写/点击复用）。 */
async function inFirstFrame<T>(
  page: Page,
  action: (frame: Frame) => Promise<T | undefined>,
): Promise<T | undefined> {
  for (const frame of page.frames()) {
    const result = await action(frame).catch(() => undefined)
    if (result !== undefined) return result
  }
  return undefined
}

/** 等抖音进入「可上传」状态（登录完成、上传控件出现）。 */
async function waitDouyinReady(page: Page, options: {
  timeoutSec: number
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let noted = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const text = await pageText(page)
    const hasInput = await page.locator('input[type=file]').count().catch(() => 0) > 0
    const loginWall = /扫码登录|验证码登录|密码登录/.test(text) && !/发布作品|上传视频/.test(text)
    if (!loginWall && (hasInput || /发布作品|上传视频/.test(text))) return
    if (Date.now() > deadline) throw new Error('抖音未登录或创作者中心加载超时，请重新点发布并扫码')
    if (Date.now() - noted > 15_000) {
      options.log('info', '等待扫码登录抖音创作者中心（在弹出的浏览器窗口里用抖音 App 扫码）…')
      noted = Date.now()
    }
    await page.waitForTimeout(2000)
  }
}

/** 等抖音视频上传/转码完成：上传中/进度消失且「发布」按钮可用。 */
/** 等抖音视频真正可预览：预览 <video> readyState>=3 且时长>0（页面提示文案里的「上传中」不算）。 */
async function waitDouyinUpload(page: Page, options: {
  timeoutSec: number
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let noted = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const ready = await page.evaluate(() => [...document.querySelectorAll('video')]
      .some(video => video.readyState >= 3 && video.duration > 0)).catch(() => false)
    if (ready) return
    const text = await pageText(page)
    if (/上传失败|转码失败|视频格式不支持/.test(text)) throw new Error('抖音提示上传/转码失败，请到浏览器窗口查看')
    if (Date.now() > deadline) throw new Error('等待抖音视频上传/转码超时，请到浏览器窗口查看进度')
    if (Date.now() - noted > 20_000) {
      const percent = text.match(/(\d{1,3})\s*%/)?.[1]
      options.log('info', percent === undefined ? '抖音上传中…' : `抖音上传中… ${percent}%`)
      noted = Date.now()
    }
    await page.waitForTimeout(2000)
  }
}

/** 抖音：填标题与描述（两种编辑控件都兼容）。 */
async function fillDouyinFields(page: Page, input: { description: string, title?: string }, log: (level: 'info' | 'warn', text: string) => void): Promise<void> {
  // 标题
  if (input.title !== undefined && input.title.trim() !== '') {
    const filled = await inFirstFrame(page, async (frame) => {
      const byPlaceholder = frame.locator('input[placeholder*="标题"]').first()
      if (await byPlaceholder.count().catch(() => 0) === 0) return undefined
      await byPlaceholder.fill(input.title?.trim() ?? '').catch(() => {})
      return true
    })
    if (filled === true) log('info', '已填抖音作品标题')
  }
  // 描述（textarea 或 contenteditable）
  const desc = input.description.trim()
  if (desc === '') return
  const byTextarea = await inFirstFrame(page, async (frame) => {
    const textarea = frame.locator('textarea').first()
    if (await textarea.count().catch(() => 0) === 0) return undefined
    await textarea.fill(desc).catch(() => {})
    return true
  })
  if (byTextarea === true) {
    log('info', '已填抖音作品描述')
    return
  }
  const byEditable = await inFirstFrame(page, async (frame) => {
    const editable = frame.locator('div[contenteditable="true"], [data-placeholder*="描述"]').first()
    if (await editable.count().catch(() => 0) === 0) return undefined
    await editable.click().catch(() => {})
    await editable.type(desc, { delay: 6 }).catch(() => {})
    return true
  })
  if (byEditable === true) log('info', '已填抖音作品描述（富文本）')
}

/** 抖音：点发布并等结果。 */
async function submitDouyin(page: Page, options: {
  log: (level: 'info' | 'warn', text: string) => void
  onProgress: (progress: { status: 'publishing' | 'waiting-verify', message: string }) => void
  signal?: AbortSignal
}): Promise<string> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
  await page.waitForTimeout(600)
  const clicked = await inFirstFrame(page, async (frame) => {
    const exact = frame.getByRole('button', { name: /^发布$/ }).first()
    const target = (await exact.count().catch(() => 0)) > 0 ? exact : frame.locator('button:has-text("发布")').first()
    if (await target.count().catch(() => 0) === 0) return undefined
    await target.scrollIntoViewIfNeeded().catch(() => {})
    await target.click()
    return true
  })
  if (clicked !== true) throw new Error('没找到抖音「发布」按钮：页面可能改版，浏览器窗口保留可手动点')

  const deadline = Date.now() + 8 * 60_000
  let verifyNoted = false
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    await page.waitForTimeout(3000)
    const text = await pageText(page)
    // 风控短信验证：平台要求本人确认，脚本无法代过，只能等用户在浏览器窗口里完成。
    if (/短信验证码|接收短信验证码|获取验证码/.test(text)) {
      if (!verifyNoted) {
        verifyNoted = true
        options.log('warn', '抖音要求短信验证：请在打开的浏览器窗口里点「获取验证码」并输入验证码（最多等 5 分钟）')
        options.onProgress({ status: 'waiting-verify', message: '等待短信验证…' })
      }
      if (Date.now() > deadline) throw new Error('抖音短信验证超时：请在浏览器窗口完成验证后重试')
      continue
    }
    if (/发布成功|作品已发布|发布完成/.test(text) || /content\/manage/.test(page.url())) return page.url()
    if (/发布失败|请完善信息|违规|不可发布/.test(text)) {
      const line = text.split('\n').map(item => item.trim()).find(item => /发布失败|请完善信息|违规|不可发布/.test(item))
      throw new Error(`抖音提示：${line ?? '发布失败'}`)
    }
    const confirmedClick = await inFirstFrame(page, async (frame) => {
      const confirm = frame.getByRole('button', { name: /^(确认|确定|继续发布)$/ }).first()
      if (await confirm.count().catch(() => 0) === 0) return undefined
      await confirm.click().catch(() => {})
      return true
    })
    if (confirmedClick === true) {
      options.log('info', '抖音出现二次确认，已自动确认')
      continue
    }
    if (Date.now() > deadline) throw new Error('点了抖音发布但没等到成功提示，请到浏览器窗口确认')
  }
}

/** 发布一条成片到抖音创作者中心。 */
export async function publishToDouyin(options: PublishChannelsOptions): Promise<PublishChannelsResult> {
  const { videoFile, description, title, signal, log, onProgress } = options
  const { context, how } = await launchPublishBrowser()
  log('info', `浏览器已启动（${how}），profile：${publishProfileDir()}`)
  let keepOpen = options.keepOpenOnError !== false
  try {
    const page = context.pages()[0] ?? await context.newPage()
    onProgress({ status: 'waiting-login', message: '打开抖音创作者中心…' })
    await page.goto(DOUYIN_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2000)

    onProgress({ status: 'waiting-login', message: '等待扫码登录抖音…' })
    await waitDouyinReady(page, { timeoutSec: options.loginTimeoutSec ?? 300, log, ...(signal === undefined ? {} : { signal }) })
    if (!/content\/upload/.test(page.url())) {
      await page.goto(DOUYIN_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(2000)
    }

    onProgress({ status: 'uploading', message: '上传成片…' })
    log('info', `开始上传到抖音：${videoFile}`)
    const uploaded = await inFirstFrame(page, async (frame) => {
      const input = frame.locator('input[type="file"]').first()
      const count = await input.count().catch(() => 0)
      if (count === 0) return undefined
      await input.setInputFiles(videoFile)
      return true
    })
    if (uploaded !== true) throw new Error('抖音页面上没找到视频上传入口（input[type=file]），页面可能改版')
    await waitDouyinUpload(page, { timeoutSec: options.uploadTimeoutSec ?? 900, log, ...(signal === undefined ? {} : { signal }) })
    log('info', '抖音视频上传完成')

    if (options.coverFile !== undefined && options.coverFile !== '') {
      onProgress({ status: 'publishing', message: '设置发布封面…' })
      const crops = await prepareCoverCrops({
        coverFile: options.coverFile,
        runDir: options.runDir ?? publishProfileDir(),
        ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
      })
      if (crops === undefined) log('warn', '封面裁剪失败，沿用平台自动截帧')
      else await applyDouyinCover(context, page, crops, log)
    }
    onProgress({ status: 'publishing', message: '填写标题和描述…' })
    await fillDouyinFields(page, { description, ...(title === undefined ? {} : { title }) }, log)

    onProgress({ status: 'publishing', message: '点发布…' })
    const postUrl = await submitDouyin(page, { log, onProgress, ...(signal === undefined ? {} : { signal }) })
    const screenshot = await capture(page, options.runDir, 'douyin-ok')
    log('info', '抖音发布成功')
    keepOpen = false
    return { postUrl, ...(screenshot === undefined ? {} : { screenshot }), browser: how }
  } catch (error) {
    const shot = await capture(context.pages()[0] as Page, options.runDir, 'douyin-fail').catch(() => undefined)
    if (shot !== undefined) log('warn', `失败截图：${shot}`)
    if (keepOpen) log('warn', '浏览器窗口保留：可以在窗口里手动完成或排查，处理完关掉即可')
    throw error
  } finally {
    if (!keepOpen) await context.close().catch(() => {})
  }
}
