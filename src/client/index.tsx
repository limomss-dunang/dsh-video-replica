/**
 * 浏览器半边入口：注册设置页 + 挂载侧边栏入口与三栏工作台。
 *
 * 失败策略与 dsh-imagegen / dsh-brainstorm 一致：DOM 挂载问题只记录告警，绝不
 * 抛错——插件 apply 抛错会让整个 Web 壳启动失败。
 */

import { VideoReplicaApi } from './api.ts'
import { applyLocale } from './locale-bridge.ts'
import { mountWorkbench } from './mount.tsx'
import { tt } from './locales.ts'
import { VideoReplicaSettingsSection } from './SettingsCard.tsx'
import { SETTINGS_SECTION_ID } from '../shared/protocol.ts'

interface LocaleLike {
  getLocale?: () => { active?: string }
  subscribe?: (listener: () => void) => () => void
}

interface SlotsLike {
  inject: (name: string, register: () => unknown) => unknown
  register: (options: Record<string, unknown>, component: unknown) => unknown
}

interface ClientContext {
  effect: (run: () => () => void, label?: string) => unknown
  get?: (name: string) => unknown
  slots?: SlotsLike
  locale?: LocaleLike
}

/**
 * slots 是硬依赖：没有它就无法注册设置页。
 * locale 也是硬依赖：DSH 0.2.x 的 client ctx 读取未 inject 的服务会直接抛
 * `cannot get property "locale" without inject`，所以必须在 inject 里声明。
 */
export const inject = ['slots', 'locale']

/**
 * 注册一个绝不抛错的 effect。
 *
 * DSH 的 web boot 会把任意 client 插件 fiber 的失败汇总成
 * `web boot: N entry did not activate` 并中止整个前端启动，而它只保留
 * `${id}: failed`、丢掉原始错误。所以这里双层兜底：effect 回调内部抛错就地
 * 吞掉并打印，`ctx.effect` 自身抛错也吞掉。任何情况下 apply 都不向宿主冒泡。
 */
function safeEffect(ctx: ClientContext, label: string, run: () => () => void): void {
  try {
    ctx.effect(() => {
      try {
        return run()
      } catch (error) {
        console.warn(`[dsh-video-replica] ${label} 执行失败：`, error)
        return () => {}
      }
    }, label)
  } catch (error) {
    console.warn(`[dsh-video-replica] ${label} 注册失败：`, error)
  }
}

export function apply(ctx: ClientContext): void {
  try {
    activate(ctx)
  } catch (error) {
    // 兜底：宿主侧 boot 失败会连带整个 GUI 起不来，宁可少功能也不能冒泡。
    console.warn('[dsh-video-replica] 激活失败（已忽略以避免阻断 Web 启动）：', error)
  }
}

function activate(ctx: ClientContext): void {
  // 1) 跟随界面语言
  safeEffect(ctx, 'dsh-video-replica: locale', () => {
    const locale = ctx.locale
    if (locale?.getLocale === undefined) return () => {}
    try {
      applyLocale(locale.getLocale?.()?.active ?? 'zh-CN')
    } catch {
      applyLocale('zh-CN')
    }
    try {
      const unsubscribe = locale.subscribe?.(() => {
        try {
          applyLocale(locale.getLocale?.()?.active ?? 'zh-CN')
        } catch {
          applyLocale('zh-CN')
        }
      })
      return typeof unsubscribe === 'function' ? unsubscribe : () => {}
    } catch {
      return () => {}
    }
  })

  // 2) 设置页（DSH 设置对话框左侧导航）
  safeEffect(ctx, 'dsh-video-replica: settings section', () => {
    const slots = ctx.slots
    if (slots === undefined) return () => {}
    try {
      const dispose = slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: SETTINGS_SECTION_ID,
        order: 17,
        label: () => tt('settingsTitle'),
      }, VideoReplicaSettingsSection))
      return typeof dispose === 'function' ? dispose as () => void : () => {}
    } catch (error) {
      console.warn('[dsh-video-replica] 设置页注册失败：', error)
      return () => {}
    }
  })

  // 3) 侧边栏入口 + 中栏工作台
  safeEffect(ctx, 'dsh-video-replica: workbench', () => {
    try {
      const api = new VideoReplicaApi()
      return mountWorkbench(api)
    } catch (error) {
      console.warn('[dsh-video-replica] 工作台挂载失败：', error)
      return () => {}
    }
  })
}
