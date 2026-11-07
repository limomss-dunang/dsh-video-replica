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

/** 发布一条成片到视频号。 */
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
