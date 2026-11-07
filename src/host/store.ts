/**
 * 运行存储：每个复刻任务一个目录，全部状态落在 run.json。
 *
 *   <dataRoot>/runs/<runId>/
 *     run.json           运行状态（步骤、报告、脚本、分镜、日志）
 *     source/            源视频与封面
 *     frames/            抽帧 + 参考图
 *     segments/          分镜视频
 *     audio/             配音
 *     final.mp4          成片
 *
 * 写入策略：内存里持有权威状态，落盘用 150ms 去抖 + 串行写；进程退出前
 * flush。这样 Agent 工具、界面轮询、刷新页面都读到同一份状态。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AspectRatio, RunState, RunSummary, StepId, StepState } from '../shared/types.ts'
import { STEP_IDS } from '../shared/types.ts'
import { messageOf } from './util.ts'

export const MAX_LOGS = 400

export function newRunId(): string {
  const stamp = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  return `${date}-${randomUUID().slice(0, 6)}`
}

export function freshSteps(): StepState[] {
  return STEP_IDS.map(id => ({ id, status: 'pending', progress: 0 }))
}

export function currentStepOf(run: RunState): StepId {
  const running = run.steps.find(step => step.status === 'running')
  if (running !== undefined) return running.id
  const failed = run.steps.find(step => step.status === 'failed')
  if (failed !== undefined) return failed.id
  const pending = run.steps.find(step => step.status === 'pending')
  return pending?.id ?? 'compose'
}

export function summarize(run: RunState): RunSummary {
  return {
    id: run.id,
    title: run.title,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.source === undefined ? {} : { platform: run.source.platform }),
    status: run.status,
    currentStep: currentStepOf(run),
    completed: run.steps.filter(step => step.status === 'done' || step.status === 'skipped').length,
    ...(run.source?.thumbFile === undefined ? {} : { thumbFile: run.source.thumbFile }),
    ...(run.compose?.file === undefined ? {} : { finalFile: run.compose.file }),
  }
}

export class RunStore {
  private readonly cache = new Map<string, RunState>()
  /** 每个运行落盘后的 mtime；磁盘被外部改动时用于主动失效缓存。 */
  private readonly mtimes = new Map<string, number>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly writing = new Map<string, Promise<void>>()

  constructor(private readonly rootProvider: () => string) {}

  get runsRoot(): string {
    return join(this.rootProvider(), 'runs')
  }

  runDir(runId: string): string {
    return join(this.runsRoot, runId)
  }

  /** 运行目录内的绝对路径。 */
  filePath(runId: string, relative: string): string {
    return join(this.runDir(runId), relative)
  }

  async ensureDir(runId: string): Promise<string> {
    const dir = this.runDir(runId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * 读取一次运行（优先内存，未命中回读磁盘）。
   * 若磁盘上的 run.json 比内存副本更新（例如外部脚本改过），主动重读，避免一直显示旧状态。
   */
  async get(runId: string): Promise<RunState | undefined> {
    const cached = this.cache.get(runId)
    if (cached === undefined) return await this.load(runId)
    try {
      const info = await stat(join(this.runDir(runId), 'run.json'))
      if (info.mtimeMs > (this.mtimes.get(runId) ?? 0) + 30) {
        const fresh = await this.load(runId)
        if (fresh !== undefined) return fresh
      }
    } catch {
      // 读不到 mtime 就按内存里的来
    }
    return cached
  }

  private async load(runId: string): Promise<RunState | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return undefined
    try {
      const file = join(this.runDir(runId), 'run.json')
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text) as RunState
      if (typeof parsed?.id !== 'string') return undefined
      if (parsed.workDir === undefined || parsed.workDir === '') parsed.workDir = this.runDir(parsed.id)
      // 老任务补源视频绝对路径，界面直接能展示/复制。
      if (parsed.source !== undefined && (parsed.source.filePath === undefined || parsed.source.filePath === '')) {
        parsed.source.filePath = join(parsed.workDir, parsed.source.videoFile)
      }
      // 版本迁移：老运行缺新步骤（如第 7 步「一键发布」）时补成 pending，并按 STEP_IDS 排序。
      parsed.steps = Array.isArray(parsed.steps) ? parsed.steps : []
      for (const id of STEP_IDS) {
        if (!parsed.steps.some(step => step.id === id)) {
          parsed.steps.push({ id, status: 'pending', progress: 0 })
        }
      }
      parsed.steps.sort((a, b) => STEP_IDS.indexOf(a.id) - STEP_IDS.indexOf(b.id))
      // 老数据只有单个 run.publish：迁移成按平台分组的 publishes。
      if (parsed.publish !== undefined) {
        parsed.publishes = { ...(parsed.publishes ?? {}), [parsed.publish.platform]: parsed.publish }
      }
      this.cache.set(runId, parsed)
      await stat(file).then(info => this.mtimes.set(runId, info.mtimeMs)).catch(() => {})
      return parsed
    } catch {
      return undefined
    }
  }

  /** 列出全部运行（按更新时间倒序）。 */
  /** 全部运行 id（启动修复用）。 */
  async listIds(): Promise<string[]> {
    try {
      const dirents = await readdir(this.runsRoot, { withFileTypes: true })
      return dirents.filter(item => item.isDirectory()).map(item => item.name)
    } catch {
      return []
    }
  }

  async list(): Promise<RunSummary[]> {
    let entries: string[] = []
    try {
      const dirents = await readdir(this.runsRoot, { withFileTypes: true })
      entries = dirents.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch {
      return []
    }
    const summaries: RunSummary[] = []
    for (const id of entries) {
      const run = await this.get(id)
      if (run !== undefined) summaries.push(summarize(run))
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 新建并落盘一次运行。 */
  async create(input: {
    title: string
    sourceUrl?: string
    productBrief?: string
    autoAdvance: boolean
    aspectRatio?: AspectRatio
  }): Promise<RunState> {
    const id = newRunId()
    const now = Date.now()
    const run: RunState = {
      id,
      workDir: this.runDir(id),
      title: input.title,
      createdAt: now,
      updatedAt: now,
      ...(input.sourceUrl === undefined || input.sourceUrl === '' ? {} : { sourceUrl: input.sourceUrl }),
      ...(input.productBrief === undefined || input.productBrief === '' ? {} : { productBrief: input.productBrief }),
      autoAdvance: input.autoAdvance,
      ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
      steps: freshSteps(),
      productImages: [],
      frames: [],
      segments: [],
      logs: [],
      status: 'idle',
    }
    await this.ensureDir(id)
    this.cache.set(id, run)
    await this.flush(id)
    return run
  }

  /** 修改并触发落盘（调用方拿到的是同一对象引用）。 */
  update(runId: string, mutate: (run: RunState) => void): RunState | undefined {
    const run = this.cache.get(runId)
    if (run === undefined) return undefined
    mutate(run)
    run.updatedAt = Date.now()
    this.schedule(runId)
    return run
  }

  log(run: RunState, step: StepId | 'run', level: 'info' | 'warn' | 'error', text: string): void {
    run.logs.push({ at: Date.now(), step, level, text: text.slice(0, 2000) })
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS)
  }

  /** 去抖落盘。 */
  schedule(runId: string): void {
    const existing = this.timers.get(runId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(runId)
      void this.flush(runId)
    }, 150)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(runId, timer)
  }

  /** 立即落盘（串行，原子替换）。 */
  async flush(runId: string): Promise<void> {
    const run = this.cache.get(runId)
    if (run === undefined) return
    const timer = this.timers.get(runId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(runId)
    }
    const previous = this.writing.get(runId) ?? Promise.resolve()
    const task = previous.then(async () => {
      const dir = await this.ensureDir(runId)
      const target = join(dir, 'run.json')
      const temp = `${target}.tmp`
      // 防覆盖：如果磁盘上的 run.json 比我们记录的更新（外部脚本/另一个实例写过），
      // 就不要用内存里的旧状态覆盖它。
      const known = this.mtimes.get(runId) ?? 0
      const onDisk = await stat(target).then(info => info.mtimeMs).catch(() => 0)
      if (known > 0 && onDisk > known + 30) {
        console.warn('[dsh-video-replica] 跳过落盘：磁盘上的 run.json 比内存新', runId)
        return
      }
      const snapshot = JSON.stringify(run, null, 2)
      await writeFile(temp, snapshot, 'utf8')
      await rename(temp, target).catch(async error => {
        // Windows 上目标被占用时降级为直接覆盖。
        if ((error as { code?: string }).code !== 'EPERM' && (error as { code?: string }).code !== 'EBUSY') throw error
        await writeFile(target, snapshot, 'utf8')
      })
      // 记录自己这次写入的 mtime，避免下次 get() 把自己写的内容误判为“外部改动”。
      await stat(target).then(info => this.mtimes.set(runId, info.mtimeMs)).catch(() => {})
    }).catch(error => {
      console.warn('[dsh-video-replica] 运行状态落盘失败：', messageOf(error))
    })
    this.writing.set(runId, task)
    await task
  }

  /** 删除运行（连同媒体文件）。 */
  async remove(runId: string): Promise<void> {
    const timer = this.timers.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(runId)
    this.cache.delete(runId)
    await rm(this.runDir(runId), { recursive: true, force: true })
  }

  /** 进程退出前刷盘。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.cache.keys()].map(async id => { await this.flush(id) }))
  }
}

/** 文件存在且大于 minBytes。 */
export async function fileOk(file: string, minBytes = 1024): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && info.size >= minBytes
  } catch {
    return false
  }
}
