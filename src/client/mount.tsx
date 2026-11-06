/**
 * 挂载点：侧边栏入口（会话 / 视频复刻）+ 中栏工作台接管。
 *
 * 中栏是单占用区（ui-conversation 独占），外部插件无法声明 slot，所以在 DOM
 * 层接管：往中栏追加一个 React 容器，用 `<html data-dvr-active>` 标识隐藏原生
 * 会话视图。会话子树保持挂载，切回来状态不丢。
 */

import { createRoot, type Root } from 'react-dom/client'
import type { VideoReplicaApi } from './api.ts'
import { Workbench } from './Workbench.tsx'
import { bindLocale } from './locale-bridge.ts'
import { tt } from './locales.ts'
import { ACTIVE_ATTR, ENTRY_ATTR, ENTRY_HOST_ATTR, VIEW_SELECTOR, shellStyle } from './styles.ts'
import { PANEL_OPEN_EVENT } from '../shared/protocol.ts'

const CENTER_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'
const SIDEBAR_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"], [class*="dshDesktopSidebarSurface"], [class*="dshDesktopUpstreamSidebar"]'
const NEW_SESSION_SELECTOR = 'button[data-dsh-part="new-session"], button[class*="newSession"]'
const IMAGEGEN_TABS_SELECTOR = '[data-dsh-imagegen-session-tabs]'
const COMMENTARY_HOST_SELECTOR = '[data-dsh-commentary-entry-host]'
const PANEL_EVENT = 'dsh-panel-activate'
const OTHER_ACTIVE_ATTRS = ['data-dsh-imagegen-active', 'data-dsh-brainstorm-active', 'data-dsh-commentary-active', 'data-dsh-ssh-active', 'data-dsh-taskboard-active']

const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="10" rx="2"/><path d="M1.8 6h12.4M6 3v3M11 3v3"/><path d="M6.9 8.4l3 1.5-3 1.5z"/></svg>'

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  return root.querySelector<HTMLButtonElement>(NEW_SESSION_SELECTOR)
    ?? [...root.querySelectorAll<HTMLButtonElement>('button')].find(button =>
      /new session|new chat|新会话|新建会话|新对话|新话题/i.test(`${button.getAttribute('aria-label')} ${button.title} ${button.textContent}`))
}

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>(SIDEBAR_SELECTOR)
  if (column === null) return undefined
  const logo = column.querySelector<HTMLElement>('[class*="logoRow"]')
  for (let candidate = logo?.parentElement; candidate !== null && candidate !== undefined && candidate !== document.body; candidate = candidate.parentElement) {
    if (newSessionButton(candidate) !== undefined) return candidate
    if (candidate === column) break
  }
  return (column.firstElementChild as HTMLElement | null) ?? column
}

function centerColumn(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>(CENTER_SELECTOR) ?? undefined
}

function makeEntry(onOpen: () => void): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dvrEntry = ''
  entry.title = tt('navTip')
  entry.setAttribute('aria-label', tt('nav'))
  entry.innerHTML = `<span class="vr-entry-icon" style="display:flex;flex:none">${ICON}</span><span class="vr-entry-label">${tt('nav')}</span>`
  entry.addEventListener('click', onOpen)
  return entry
}

export function mountWorkbench(api: VideoReplicaApi): () => void {
  let open = false
  let root: Root | undefined
  let view: HTMLDivElement | undefined
  let column: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let entry: HTMLButtonElement | undefined
  let entryHost: HTMLDivElement | undefined

  const style = document.createElement('style')
  style.dataset.dvrStyles = ''
  style.textContent = shellStyle()
  document.head.append(style)

  const render = (): void => {
    if (root === undefined) return
    root.render(<Workbench api={api} onClose={() => setOpen(false)} />)
  }

  const syncEntry = (): void => {
    if (entry === undefined) return
    entry.toggleAttribute('data-active', open)
    entry.setAttribute('aria-pressed', String(open))
    entry.title = open ? tt('sessionTip') : tt('navTip')
    entry.setAttribute('aria-label', tt('nav'))
    const label = entry.querySelector('.vr-entry-label')
    if (label !== null) label.textContent = tt('nav')
  }

  function setOpen(next: boolean): void {
    if (open === next) return
    if (next) {
      // 中栏同一时刻只给一个插件面板：先把别的面板请回会话视图。
      if (document.documentElement.hasAttribute('data-dsh-imagegen-active')) {
        document.querySelector<HTMLButtonElement>('[data-dsh-imagegen-tab="session"]')?.click()
      }
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
    }
    open = next
    document.documentElement.toggleAttribute(ACTIVE_ATTR, open)
    if (open) {
      document.dispatchEvent(new CustomEvent(PANEL_EVENT, { detail: 'video-replica' }))
      // 面板每次打开都让工作台对一次配置（用户可能刚在设置里改过模型）。
      try {
        window.dispatchEvent(new CustomEvent(PANEL_OPEN_EVENT))
      } catch {
        // 事件派发失败不影响打开
      }
    }
    syncEntry()
    render()
  }

  const placeEntry = (): void => {
    if (sidebar === undefined || !sidebar.isConnected) sidebar = sidebarRoot()
    if (sidebar === undefined) return
    const sharedTabs = sidebar.querySelector<HTMLElement>(IMAGEGEN_TABS_SELECTOR)
    const commentary = sidebar.querySelector<HTMLElement>(COMMENTARY_HOST_SELECTOR)
    const target = sharedTabs ?? commentary

    if (target !== null) {
      if (entry !== undefined && entry.parentElement === target) return
      entry?.remove()
      entryHost?.remove()
      entryHost = undefined
      entry = makeEntry(() => setOpen(true))
      target.append(entry)
      syncEntry()
      return
    }

    const native = newSessionButton(sidebar)
    if (native === undefined) return
    if (entryHost !== undefined && entryHost.isConnected && entryHost.parentElement === native.parentElement) return
    entry?.remove()
    entryHost?.remove()
    entryHost = document.createElement('div')
    entryHost.dataset.dvrEntryHost = ''
    const session = document.createElement('button')
    session.type = 'button'
    session.textContent = tt('session')
    session.title = tt('sessionTip')
    session.addEventListener('click', () => setOpen(false))
    entry = makeEntry(() => setOpen(true))
    entryHost.append(session, entry)
    native.before(entryHost)
    syncEntry()
  }

  const ensure = (): void => {
    placeEntry()
    if (view !== undefined && !view.isConnected) {
      root?.unmount()
      root = undefined
      view = undefined
      column = undefined
    }
    column ??= centerColumn()
    if (column !== undefined && view === undefined) {
      view = document.createElement('div')
      view.dataset.dvrView = ''
      column.append(view)
      root = createRoot(view)
      render()
    }
  }

  const observer = new MutationObserver(ensure)
  const onActivate = (event: Event): void => {
    if ((event as CustomEvent).detail !== 'video-replica') setOpen(false)
  }
  const onShellClick = (event: MouseEvent): void => {
    if (!open || !(event.target instanceof Element)) return
    if (event.target.closest([
      '[data-dsh-imagegen-tab="session"]',
      '[data-dsh-commentary-entry-host] > button:first-child',
      '[class*="sessionRow"]',
      '[class*="projectRow"]',
      '[class*="searchResultRow"]',
      '[class*="searchResultWorkspace"]',
      '[data-dsh-part="new-session"]',
      '[class*="newSession"]',
    ].join(', ')) !== null) {
      setOpen(false)
    }
  }

  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener(PANEL_EVENT, onActivate)
  document.addEventListener('click', onShellClick, true)
  const unbind = bindLocale(syncEntry)
  ensure()

  return () => {
    unbind()
    observer.disconnect()
    document.removeEventListener(PANEL_EVENT, onActivate)
    document.removeEventListener('click', onShellClick, true)
    root?.unmount()
    view?.remove()
    entry?.remove()
    entryHost?.remove()
    style.remove()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}

export const __viewSelector = VIEW_SELECTOR
export const __entryAttr = ENTRY_ATTR
export const __entryHostAttr = ENTRY_HOST_ATTR
