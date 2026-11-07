/**
 * 第七步：一键发布。
 *
 * 通过 dsh-browser-playwright-codex 暴露的 `ctx.browser` 服务驱动真实浏览器：
 * 打开平台创作页 → 没登录就等用户扫码 → 上传成片 → 填描述 → 点发表。
 *
 * 这里刻意不写死 CSS 选择器：页面结构会变，改用无障碍快照
 * （role / name / placeholder）找元素；只有文件上传必须走 CDP
 * （快照里没有 input[type=file] 的引用）。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 浏览器服务的结构化类型（只声明用到的部分，避免把插件依赖带进来）
// ---------------------------------------------------------------------------

export interface BrowserNodeLike {
  role: string
  name: string
  ref?: string
  children: readonly BrowserNodeLike[]
}

export interface BrowserSnapshotLike {
  url: string
  title: string
  nodes: readonly BrowserNodeLike[]
}

export interface BrowserSessionLike {
  navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle', signal?: AbortSignal): Promise<BrowserSnapshotLike>
  snapshot(options?: { interactiveOnly?: boolean }, signal?: AbortSignal): Promise<BrowserSnapshotLike>
  click(ref: string, signal?: AbortSignal): Promise<BrowserSnapshotLike>
  clickText(text: string, signal?: AbortSignal): Promise<BrowserSnapshotLike>
  fill(ref: string, text: string, signal?: AbortSignal): Promise<BrowserSnapshotLike>
  wait(ms: number, signal?: AbortSignal): Promise<void>
  evaluate(expression: string, signal?: AbortSignal): Promise<unknown>
  screenshot(options?: { fullPage?: boolean }, signal?: AbortSignal): Promise<{ mime: string, bytes: Uint8Array }>
  cdp(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

export interface BrowserRuntimeLike {
  acquire(owner: string, signal?: AbortSignal): Promise<BrowserSessionLike>
  disposeOwner?(owner: string): Promise<void>
}

// ---------------------------------------------------------------------------
// 快照工具
// ---------------------------------------------------------------------------

export function flattenNodes(nodes: readonly BrowserNodeLike[]): BrowserNodeLike[] {
  const out: BrowserNodeLike[] = []
  const walk = (list: readonly BrowserNodeLike[]): void => {
    for (const node of list) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

export function snapshotText(snapshot: BrowserSnapshotLike): string {
  return flattenNodes(snapshot.nodes).map(node => node.name).join('\n')
}

/** 找第一个 role 匹配、名字匹配（不区分大小写）的可交互节点。 */
export function findNode(
  snapshot: BrowserSnapshotLike,
  roles: readonly string[],
  namePattern: RegExp,
): BrowserNodeLike | undefined {
  return flattenNodes(snapshot.nodes).find(node =>
    node.ref !== undefined
    && roles.includes(node.role.toLowerCase())
    && namePattern.test(node.name))
}

/** 任意名字命中的节点（不要求 role，用于读文本判断状态）。 */
export function hasText(snapshot: BrowserSnapshotLike, pattern: RegExp): boolean {
  return flattenNodes(snapshot.nodes).some(node => pattern.test(node.name))
}

/** 平台登录页判断：URL 或页面文案里出现扫码登录一类的字样。 */
export function isLoginPage(snapshot: BrowserSnapshotLike): boolean {
  if (/\/login\b/i.test(snapshot.url)) return true
  const text = snapshotText(snapshot)
  return /扫码登录|二维码登录|微信扫一扫|请使用微信扫描/.test(text) && !/发表/.test(text)
}

// ---------------------------------------------------------------------------
// 发布主流程
// ---------------------------------------------------------------------------

export interface PublishProgress {
  status: 'waiting-login' | 'uploading' | 'publishing'
  message: string
}

export interface PublishChannelsOptions {
  browser: BrowserRuntimeLike
  owner: string
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
}

export interface PublishChannelsResult {
  postUrl: string
  screenshot?: Uint8Array
}

async function runCdp<T>(session: BrowserSessionLike, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return await session.cdp(method, params, signal) as T
}

/** 用 CDP 把本地文件塞进页面里的 file input（快照拿不到它的引用）。 */
export async function setFileInput(
  session: BrowserSessionLike,
  selector: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await runCdp(session, 'DOM.enable', {}, signal).catch(() => undefined)
  const doc = await runCdp<{ root?: { nodeId?: number } }>(session, 'DOM.getDocument', { depth: -1 }, signal)
  const rootId = doc?.root?.nodeId
  if (typeof rootId !== 'number') return false
  const found = await runCdp<{ nodeId?: number }>(session, 'DOM.querySelector', { nodeId: rootId, selector }, signal)
  const nodeId = found?.nodeId
  if (typeof nodeId !== 'number' || nodeId === 0) return false
  await runCdp(session, 'DOM.setFileInputFiles', { files: [filePath], nodeId }, signal)
  return true
}

/** 在页面上找视频上传 input：优先 accept 含 video 的，退回第一个 file input。 */
export async function attachVideo(session: BrowserSessionLike, filePath: string, signal?: AbortSignal): Promise<void> {
  const selectors = ['input[type="file"][accept*="video"]', 'input[type="file"]']
  for (const selector of selectors) {
    if (await setFileInput(session, selector, filePath, signal)) return
  }
  throw new Error('页面上没找到视频上传入口（file input）。可能页面改版或还没登录，先刷新重试。')
}

/** 等扫码登录完成；返回登录后的最新快照。 */
export async function waitForLogin(
  session: BrowserSessionLike,
  options: { timeoutSec: number, log: (level: 'info' | 'warn', text: string) => void, signal?: AbortSignal },
): Promise<BrowserSnapshotLike> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let lastNote = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const snapshot = await session.snapshot(undefined, options.signal)
    if (!isLoginPage(snapshot)) return snapshot
    if (Date.now() > deadline) throw new Error('扫码登录超时，请重新点发布')
    if (Date.now() - lastNote > 15_000) {
      options.log('info', '等待扫码登录视频号助手（在打开的浏览器窗口里用微信扫一扫）…')
      lastNote = Date.now()
    }
    await session.wait(2500, options.signal)
  }
}

/** 等视频上传完成：靠页面文案判断，超时抛错。 */
export async function waitForUpload(
  session: BrowserSessionLike,
  options: { timeoutSec: number, log: (level: 'info' | 'warn', text: string) => void, signal?: AbortSignal },
): Promise<BrowserSnapshotLike> {
  const deadline = Date.now() + options.timeoutSec * 1000
  let lastNote = 0
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const snapshot = await session.snapshot(undefined, options.signal)
    if (hasText(snapshot, /上传完成|上传成功|视频已上传/)) return snapshot
    if (Date.now() > deadline) throw new Error('等待视频上传超时，请到浏览器窗口里看看上传进度')
    if (Date.now() - lastNote > 20_000) {
      options.log('info', '视频上传中…')
      lastNote = Date.now()
    }
    await session.wait(3000, options.signal)
  }
}

/** 填描述（找不到"描述"输入框时退回第一个多行输入）。 */
export async function fillDescription(session: BrowserSessionLike, description: string, signal?: AbortSignal): Promise<boolean> {
  let snapshot = await session.snapshot(undefined, signal)
  let target = findNode(snapshot, ['textbox', 'textarea'], /描述|说点什么|添加描述|正文/i)
  if (target === undefined || target.ref === undefined) {
    target = flattenNodes(snapshot.nodes).find(node =>
      node.ref !== undefined && /textbox|textarea/i.test(node.role))
  }
  if (target === undefined || target.ref === undefined) return false
  snapshot = await session.fill(target.ref, description, signal)
  return snapshot.url !== ''
}

/** 点发表并等结果。 */
export async function submitPost(
  session: BrowserSessionLike,
  options: { log: (level: 'info' | 'warn', text: string) => void, signal?: AbortSignal },
): Promise<string> {
  const before = await session.snapshot(undefined, options.signal)
  const button = findNode(before, ['button'], /^发表$|发表$|发布$/)
  if (button?.ref !== undefined) {
    await session.click(button.ref, options.signal)
  } else {
    await session.clickText('发表', options.signal)
  }
  const deadline = Date.now() + 120_000
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('已停止')
    const snapshot = await session.snapshot(undefined, options.signal)
    const text = snapshotText(snapshot)
    if (/发表成功|发布成功/.test(text) || /\/platform\/post\/(list|success)/.test(snapshot.url)) {
      return snapshot.url
    }
    if (/发表失败|违规|不可发布/.test(text)) throw new Error('平台提示发布失败，请到浏览器窗口查看详情')
    if (Date.now() > deadline) throw new Error('点了发表但没等到成功提示，请到浏览器窗口确认')
    await session.wait(2000, options.signal)
  }
}

/** 视频号发布：打开创作页 → 等登录 → 上传 → 填描述 → 发表。 */
export async function publishToChannels(options: PublishChannelsOptions): Promise<PublishChannelsResult> {
  const { browser, owner, videoFile, description, title, signal, log, onProgress } = options
  const info = await stat(videoFile).catch(() => undefined)
  if (info === undefined || info.size === 0) throw new Error('成片文件不存在或为空，请先完成「合成成片」')

  const session = await browser.acquire(owner, signal)
  onProgress({ status: 'waiting-login', message: '打开视频号创作页…' })
  let snapshot = await session.navigate('https://channels.weixin.qq.com/platform/post/create', 'domcontentloaded', signal)

  if (isLoginPage(snapshot)) {
    onProgress({ status: 'waiting-login', message: '等待扫码登录…' })
    log('info', '视频号未登录：请在弹出的浏览器窗口里用微信扫码，登录后会自动继续')
    snapshot = await waitForLogin(session, {
      timeoutSec: options.loginTimeoutSec ?? 240,
      log,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!/post\/create/.test(snapshot.url)) {
      snapshot = await session.navigate('https://channels.weixin.qq.com/platform/post/create', 'domcontentloaded', signal)
    }
  }
  if (isLoginPage(snapshot)) throw new Error('登录后仍停留在登录页，请重试')

  onProgress({ status: 'uploading', message: '上传成片…' })
  log('info', `开始上传：${videoFile}`)
  await attachVideo(session, videoFile, signal)
  snapshot = await waitForUpload(session, {
    timeoutSec: options.uploadTimeoutSec ?? 900,
    log,
    ...(signal === undefined ? {} : { signal }),
  })
  log('info', '视频上传完成')

  if (title !== undefined && title.trim() !== '') {
    const titleNode = findNode(snapshot, ['textbox'], /标题|短标题/)
    if (titleNode?.ref !== undefined) {
      snapshot = await session.fill(titleNode.ref, title.trim(), signal)
    }
  }

  onProgress({ status: 'publishing', message: '填写描述…' })
  const filled = await fillDescription(session, description, signal)
  if (!filled) log('warn', '没找到描述输入框，跳过描述（视频已上传，可到浏览器窗口手动补）')
  else log('info', '描述已填写')

  onProgress({ status: 'publishing', message: '点发表…' })
  const postUrl = await submitPost(session, { log, ...(signal === undefined ? {} : { signal }) })
  const shot = await session.screenshot({ fullPage: false }, signal).catch(() => undefined)
  log('info', `发布完成：${postUrl}`)
  return { postUrl, ...(shot === undefined ? {} : { screenshot: shot.bytes }) }
}

/** 把发布截图存到运行目录，返回相对路径（供界面展示）。 */
export async function savePublishShot(runDir: string, bytes: Uint8Array): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = join(runDir, 'publish')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `post-${Date.now()}.png`)
  await writeFile(file, bytes)
  return `publish/${file.split(/[\\/]/).pop()}`
}
