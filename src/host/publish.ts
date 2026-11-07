/**
 * 第七步：一键发布（视频号）。
 *
 * 为什么不用 `ctx.browser`：`dsh-browser-playwright-codex` 的服务只注册在它自己的
 * 子上下文里（宿主 Service 目录里没有 `browser`），兄弟插件拿不到。这里直接复用
 * 同一套 playwright-core + 本机浏览器，登录态存在独立 profile 目录里（扫码一次即可）。
 *
 * 元素定位全部走 Playwright 的语义定位（getByRole / placeholder / 文本），不写死
 * CSS 选择器；页面改版时优先留下截图和明确报错，而不是静默失败。
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

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
  const base = { headless: false, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' } as const
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
    `找不到可用的浏览器（Edge / Chrome / playwright chromium 都启动失败）。`
    + `可以安装 Microsoft Edge 或 Google Chrome，或用环境变量 DSH_VIDEO_REPLICA_BROWSER 指向浏览器可执行文件。\n`
    + failures.join('\n'),
  )
}

// ---------------------------------------------------------------------------
// 页面工具
// ---------------------------------------------------------------------------

const CREATE_URL = 'https://channels.weixin.qq.com/platform/post/create'
const LOGIN_URL = 'https://channels.weixin.qq.com/login.html'

export function isLoginUrl(url: string): boolean {
  return /\/login(\.html)?(\?|$|\/)/.test(url)
}

/** 登录页判断：URL 是登录页，或页面正文里只有登录相关文案。 */
export async function isLoginPage(page: Page): Promise<boolean> {
  if (isLoginUrl(page.url())) return true
  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
  return /登录视频号助手|微信扫一扫|扫码登录/.test(body) && !/发表/.test(body)
}

async function bodyText(page: Page): Promise<string> {
  return await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
}

/** 找到视频上传 input（优先 accept 含 video 的）。 */
async function findVideoInput(page: Page) {
  const candidates = [
    page.locator('input[type="file"][accept*="video" i]'),
    page.locator('input[type="file"]'),
  ]
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0)
    if (count > 0) return locator.first()
  }
  return undefined
}

/** 找「发表」按钮（按钮 / div 扮演的按钮都试）。 */
async function findSubmit(page: Page) {
  const candidates = [
    page.getByRole('button', { name: /^(发表|发布)$/ }),
    page.locator('button:has-text("发表")'),
    page.getByText('发表', { exact: true }),
  ]
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0)
    if (count > 0) return locator.first()
  }
  return undefined
}

/** 描述输入框：优先 placeholder 含「描述」的，其次任意 textarea / contenteditable。 */
async function findDescriptionBox(page: Page) {
  const candidates = [
    page.getByPlaceholder(/描述|说点什么|添加描述/),
    page.locator('textarea'),
    page.locator('[contenteditable="true"]'),
  ]
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0)
    if (count > 0) return locator.first()
  }
  return undefined
}

/** 填描述：textarea 用 fill，contenteditable 用 type。 */
async function fillDescriptionBox(page: Page, text: string): Promise<boolean> {
  const box = await findDescriptionBox(page)
  if (box === undefined) return false
  const tag = await box.evaluate(node => node.tagName.toLowerCase()).catch(() => '')
  if (tag === 'textarea' || tag === 'input') {
    await box.fill(text)
  } else {
    await box.click()
    await box.type(text, { delay: 8 })
  }
  return true
}

/** 等扫码登录完成；返回登录后的 page。 */
export async function waitForLogin(page: Page, options: {
  timeoutSec: number
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let noted = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    if (!(await isLoginPage(page))) return
    if (Date.now() > deadline) throw new Error(`扫码登录超时（${options.timeoutSec}s），请重新点发布`)
    if (Date.now() - noted > 15_000) {
      options.log('info', '等待扫码：请在打开的浏览器窗口里用微信扫一扫登录视频号助手…')
      noted = Date.now()
    }
    await page.waitForTimeout(2000)
  }
}

/** 等上传完成：出现「上传完成」文案，或发表按钮变为可点。 */
export async function waitForUpload(page: Page, options: {
  timeoutSec: number
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let noted = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const text = await bodyText(page)
    if (/上传完成|上传成功|视频已上传/.test(text)) return
    if (/上传失败|转码失败/.test(text)) throw new Error('平台提示上传/转码失败，请到浏览器窗口查看详情')
    const submit = await findSubmit(page)
    if (submit !== undefined && (await submit.isEnabled().catch(() => false))) return
    if (Date.now() > deadline) throw new Error('等待视频上传超时，请到浏览器窗口里查看上传进度')
    if (Date.now() - noted > 20_000) {
      const percent = text.match(/(\d{1,3})\s*%/)?.[1]
      options.log('info', percent === undefined ? '视频上传中…' : `视频上传中… ${percent}%`)
      noted = Date.now()
    }
    await page.waitForTimeout(3000)
  }
}

/** 点发表并等结果，返回作品页 URL。 */
export async function submitPost(page: Page, options: {
  log: (level: 'info' | 'warn', text: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const submit = await findSubmit(page)
  if (submit === undefined) throw new Error('没找到「发表」按钮：页面可能改版，浏览器窗口保留，可手动点发表')
  await submit.click()
  const deadline = Date.now() + 120_000
  let confirmed = false
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    await page.waitForTimeout(1500)
    const text = await bodyText(page)
    const confirm = page.getByRole('button', { name: /^(确认|确定|继续发表)$/ })
    if (!confirmed && (await confirm.count().catch(() => 0)) > 0) {
      await confirm.first().click().catch(() => {})
      confirmed = true
      continue
    }
    if (/发表成功|发布成功/.test(text) || /\/platform\/post\/(list|success)/.test(page.url())) return page.url()
    if (/发表失败|违规|不可发布/.test(text)) throw new Error('平台提示发布失败，请到浏览器窗口查看详情')
    if (Date.now() > deadline) throw new Error('点了发表但没等到成功提示，请到浏览器窗口确认')
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface PublishProgress {
  status: 'waiting-login' | 'uploading' | 'publishing'
  message: string
}

export interface PublishChannelsOptions {
  videoFile: string
  description: string
  title?: string
  signal?: AbortSignal
  log: (level: 'info' | 'warn', text: string) => void
  onProgress: (progress: PublishProgress) => void
  /** 等扫码的最长时间（秒）。 */
  loginTimeoutSec?: number
  /** 等上传完成的最长时间（秒）。 */
  uploadTimeoutSec?: number
  /** 失败时是否把浏览器窗口留着（默认留着，方便手动接管）。 */
  keepOpenOnError?: boolean
  /** 截图输出目录（运行目录）。 */
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

    if (await isLoginPage(page)) {
      onProgress({ status: 'waiting-login', message: '等待扫码登录…' })
      log('info', '视频号未登录：请在弹出的浏览器窗口里用微信扫码，登录后自动继续')
      await waitForLogin(page, {
        timeoutSec: options.loginTimeoutSec ?? 300,
        log,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!/post\/create/.test(page.url())) {
        await page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      }
    }
    if (await isLoginPage(page)) throw new Error('登录后仍停留在登录页，请重试')

    onProgress({ status: 'uploading', message: '上传成片…' })
    log('info', `开始上传：${videoFile}`)
    const input = await findVideoInput(page)
    if (input === undefined) throw new Error('页面上没找到视频上传入口（input[type=file]），页面可能改版')
    await input.setInputFiles(videoFile)
    await waitForUpload(page, {
      timeoutSec: options.uploadTimeoutSec ?? 900,
      log,
      ...(signal === undefined ? {} : { signal }),
    })
    log('info', '视频上传完成')

    if (title !== undefined && title.trim() !== '') {
      const titleBox = page.getByPlaceholder(/标题|短标题/).first()
      if ((await titleBox.count().catch(() => 0)) > 0) {
        await titleBox.fill(title.trim()).catch(() => {})
      }
    }

    onProgress({ status: 'publishing', message: '填写描述…' })
    if (description.trim() !== '') {
      const filled = await fillDescriptionBox(page, description.trim())
      if (filled) log('info', '描述已填写')
      else log('warn', '没找到描述输入框，跳过描述（视频已上传，可在浏览器窗口手动补）')
    }

    onProgress({ status: 'publishing', message: '点发表…' })
    const postUrl = await submitPost(page, { log, ...(signal === undefined ? {} : { signal }) })
    const screenshot = await capture(page, options.runDir, 'post-ok')
    log('info', `发布完成：${postUrl === '' ? '页面已提交' : postUrl}`)
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
