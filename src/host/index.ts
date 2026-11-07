/**
 * dsh-video-replica — 宿主半边。
 *
 * 一个复刻任务固定六步：
 *   parse 解析下载 → analyze AI 拆解 → rewrite AI 仿写 → match 参考图匹配
 *   → generate AI 生成分镜视频 → compose ffmpeg 合成成片
 *
 * 宿主负责：配置读写、运行引擎（步骤调度 / 失败重试 / 取消）、loopback 桥接
 * 路由（配置、运行状态、上传、媒体流）、以及给 Agent 的系统提示说明。
 * 浏览器半边（./client）渲染三栏工作台与设置页。
 *
 * 依赖只有 `webServer`：其余能力（ffmpeg / ffprobe / yt-dlp / 模型网关）全部
 * 由本插件自己的配置驱动，缺什么就在界面上明确提示缺什么。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStore, defaultDataRoot } from './config.ts'
import { Engine } from './engine.ts'
import { RunStore } from './store.ts'
import { makeRoutes } from './routes.ts'
import { DshModels } from './dsh.ts'
import { messageOf } from './util.ts'

export const name = 'dsh-video-replica'

/** webServer 是硬依赖；systemPrompt 做能力说明（可选，缺失时静默跳过）。 */
export const inject = ['webServer']

export interface Config {
  /** 关掉整个插件（设置页与工作台都不出现）。 */
  enabled?: boolean
  /** 是否在系统提示里向 Agent 介绍这个插件。 */
  announceToAgent?: boolean
}

export const PLUGIN_GUIDANCE = `本机已安装 dsh-video-replica 插件（爆款视频复刻）：「设置 → 视频复刻」配置模型与工具，侧边栏「会话 / 视频复刻」进入三栏工作台。
能力是一条六步流水线：①解析下载（抖音 / 小红书 / 视频号 / 快手 / B站 分享链接，支持第三方解析接口、yt-dlp、直链，或直接上传本地视频）②AI 拆解（均匀抽帧 + 视觉模型逐镜分析钩子/结构/节奏/风格/爆款 DNA/评分，可选 ASR 转写口播）③AI 仿写（按拆解结果产出 A/B/C 三版分镜脚本，可逐镜编辑）④参考图匹配（把上传的产品图融入每个分镜，生成参考首帧）⑤AI 生成视频（按「≤5 镜 / ≤15 秒」分块调用视频模型，支持火山方舟 Seedance 与通用 OpenAI 风格视频接口）⑥合成成片（ffmpeg 拼接 + 可选 TTS 配音 + ASS 字幕烧录 + BGM，输出 final.mp4）。
每一步的模型有两种来源，任选其一：**DSH 已配置模型**（直接选「设置 → 模型」里已有的提供商与模型，无需重复填密钥；拆解/仿写走 DSH 的 llm 服务，图片/视频/语音用该提供商配置里的接口地址发请求）或**手动填写接口**（自带网关地址 + Key + 模型名）。
用户提到「复刻视频 / 模仿爆款 / 拆解这条视频 / 一键成片 / 视频仿写」时指的就是本插件。手填的密钥只存本机（~/.dsh/storages/dsh-video-replica/config.json），界面回读时以掩码显示。视频生成会消耗上游额度且耗时较长（单段数分钟），运行状态会落盘、刷新页面不丢。`

interface HostContext {
  effect: (run: () => () => void, label?: string) => unknown
  get?: (name: string) => unknown
  webServer?: { register: (route: unknown) => () => void }
  systemPrompt?: { section: (section: { name: string, order?: number, text: string }) => () => void }
  on?: (event: string, listener: () => void) => () => void
}

export function apply(ctx: HostContext, config?: Config): (() => void) | void {
  try {
    return activate(ctx, config)
  } catch (error) {
    // 兜底：插件激活失败会让宿主 startup audit 判为 failed 并中断整个应用启动，
    // 宁可少功能也不能冒泡。
    console.warn('[dsh-video-replica] 激活失败（已忽略以避免阻断启动）：', messageOf(error))
  }
}

function activate(ctx: HostContext, config?: Config): (() => void) | void {
  if (config?.enabled === false) return

  // 配置文件固定在默认根目录；`dataDir` 只决定运行产物存放位置。
  const configs = new ConfigStore(() => defaultDataRoot())
  let dataRoot = defaultDataRoot()
  const store = new RunStore(() => dataRoot)
  // DSH 已配置模型：全部经 ctx.get 取服务（0.2.x 直接读未 inject 的属性会抛错）。
  const dsh = new DshModels((name: string) => ctx.get?.(name))
  const engine = new Engine(configs, store, dsh, (serviceName: string) => ctx.get?.(serviceName))
  // 应用重启后把「上次被执行中断」的运行标记出来（否则界面一直转圈）。
  void engine.repairInterrupted().catch(() => {})

  const refreshDataRoot = async (): Promise<void> => {
    const current = await configs.read()
    const configured = current.dataDir.trim()
    dataRoot = configured === '' ? defaultDataRoot() : configured
    await mkdir(join(dataRoot, 'runs'), { recursive: true }).catch(() => {})
  }

  ctx.effect(() => {
    let disposed = false
    const disposers: Array<() => void> = []
    void (async () => {
      try {
        await refreshDataRoot()
        const routes = makeRoutes({
          configs,
          store,
          engine,
          dsh,
          dataRoot: () => dataRoot,
          refreshDataRoot,
        })
        if (ctx.webServer === undefined) {
          console.warn('[dsh-video-replica] webServer 服务不可用：工作台将无法连接宿主')
          return
        }
        for (const route of routes) {
          const dispose = ctx.webServer.register(route)
          // 卸载与异步挂载赛跑时，注册完立刻注销，避免路由泄漏。
          if (disposed) dispose()
          else disposers.push(dispose)
        }
        console.log(`[dsh-video-replica] 已挂载 ${disposers.length} 条桥接路由（数据目录 ${dataRoot}）`)
      } catch (error) {
        console.warn('[dsh-video-replica] 路由挂载失败：', messageOf(error))
      }
    })()
    return () => {
      disposed = true
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // 插件卸载期间路由可能已随 webServer 一起销毁
        }
      }
      void store.flushAll().catch(() => {})
    }
  }, 'dsh-video-replica: bridge routes')

  // Agent 能力说明（可被设置关掉）。
  // systemPrompt 是可选服务：DSH 0.2.x 里直接读未 inject 的服务属性会抛
  // `cannot get property "systemPrompt" without inject`，所以走 ctx.get 取值。
  if (config?.announceToAgent !== false) {
    try {
      const systemPrompt = ctx.get?.('systemPrompt') as {
        section: (section: { name: string, order?: number, text: string }) => () => void
      } | undefined
      const dispose = systemPrompt?.section({
        name: 'plugin:dsh-video-replica',
        order: 60,
        text: PLUGIN_GUIDANCE,
      })
      if (typeof dispose === 'function') {
        ctx.effect(() => dispose, 'dsh-video-replica: system prompt section')
      }
    } catch (error) {
      console.warn('[dsh-video-replica] 系统提示注册失败（不影响功能）：', messageOf(error))
    }
  }

  ctx.effect(() => () => {
    void engine.waitAll().catch(() => {})
  }, 'dsh-video-replica: engine shutdown')

}

export { buildPromptPreview } from './pipeline.ts'
