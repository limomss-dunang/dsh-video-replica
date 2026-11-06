/**
 * 宿主 / 浏览器共享常量（不含运行时代码，可被两边同时引用）。
 */

/** 设置页在 DSH 设置对话框里的 section id。 */
export const SETTINGS_SECTION_ID = 'dsh-video-replica'

/** 设置页导航项显示名。 */
export const SETTINGS_SECTION_LABEL = '视频复刻'

/** 密钥掩码：界面原样回传表示「不修改」。 */
export const SECRET_MASK = '••••••'

/** 侧边栏入口的稳定选择器属性。 */
export const ENTRY_SELECTOR = '[data-dvr-entry]'

/** 打开设置页的窗口事件（工作台里「去配置」按钮用）。 */
export const OPEN_SETTINGS_EVENT = 'dsh-video-replica:open-settings'

/**
 * 设置页保存成功后派发：常驻挂载的工作台收到后重新拉配置，
 * 否则「还没有配置模型」之类的旧提示会一直留在界面上。
 */
export const CONFIG_SAVED_EVENT = 'dsh-video-replica:config-saved'

/** 工作台面板被打开时派发：顺便刷新一次配置。 */
export const PANEL_OPEN_EVENT = 'dsh-video-replica:panel-open'
