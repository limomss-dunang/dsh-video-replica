/**
 * 语言桥：把 DSH 的界面语言映射到插件自己的文案表，并在切换时通知已挂载的
 * DOM 入口重渲染标签（React 部分靠自己的状态刷新）。
 */

import { setLanguage } from './locales.ts'

const listeners = new Set<() => void>()
let active = 'zh-CN'

export function currentLanguage(): string {
  return active
}

export function applyLocale(locale: string): void {
  active = locale === '' ? 'zh-CN' : locale
  setLanguage(active)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者出问题不影响其它入口
    }
  }
}

/** 订阅语言变化。 */
export function bindLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
