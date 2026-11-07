/**
 * 运行引擎：步骤调度、并发闸门、停止与自动推进。
 *
 * 一个 run 同时只允许一个任务在跑（避免两步同时写同一份 run.json）；
 * 每一步跑完立刻落盘，所以界面刷新、Agent 查询、进程重启都能接着看到进度。
 */

import type { PluginConfig, RunState, StepId, StepState } from '../shared/types.ts'
import { STEP_IDS } from '../shared/types.ts'
import type { ConfigStore } from './config.ts'
import { STEP_RUNNERS, type PipelineContext } from './pipeline.ts'
import type { RunStore } from './store.ts'
import type { DshModels } from './dsh.ts'
import { messageOf } from './util.ts'

/** 只能手动点、不参与自动连续执行的步骤（发布对外有副作用）。 */
const MANUAL_STEPS: readonly StepId[] = ['publish']

interface ActiveJob {
  controller: AbortController
  promise: Promise<void>
  step: StepId
}

export class Engine {
  private readonly active = new Map<string, ActiveJob>()

  constructor(
    private readonly configs: ConfigStore,
    private readonly store: RunStore,
    /** DSH 已配置模型接入层（可选，缺失时只能用手填接口）。 */
    private readonly dsh?: DshModels,
  ) {}

  /**
   * 应用重启后修复「上次执行被中断」的运行：
   * 进程被杀时步骤会停在 running，界面会一直转圈且无法继续，这里标成 failed 并写明原因。
   */
  async repairInterrupted(): Promise<number> {
    const ids = await this.store.listIds()
    let repaired = 0
    for (const runId of ids) {
      const run = await this.store.get(runId)
      if (run === undefined) continue
      const stuck = run.steps.filter(step => step.status === 'running')
      // 分段/首帧也可能停在 running（重生成时被杀），界面上会一直显示“生成中”。
      const stuckSegments = run.segments.filter(segment => segment.status === 'running')
      const stuckFrames = run.frames.filter(frame => frame.file === '' && frame.error === undefined)
      if (stuck.length === 0 && run.status !== 'running' && stuckSegments.length === 0) continue
      for (const step of stuck) {
        step.status = 'failed'
        step.message = '上次执行被中断（应用重启）'
        step.error = '上次执行被中断（应用重启）。点「重试」或「运行」可从这里继续。'
        step.endedAt = Date.now()
      }
      for (const segment of stuckSegments) {
        segment.status = 'failed'
        segment.error = '上次生成被中断（应用重启）'
        segment.endedAt = Date.now()
      }
      void stuckFrames
      if (run.status === 'running') {
        run.status = 'failed'
        run.error = '上次执行被中断（应用重启）'
      }
      this.store.log(run, stuck[0]?.id ?? 'parse', 'warn', '检测到上次执行被应用重启中断，已标记为失败，可重新运行这一步。')
      await this.store.flush(runId)
      repaired += 1
    }
    return repaired
  }

  isBusy(runId: string): boolean {
    return this.active.has(runId)
  }

  busyStep(runId: string): StepId | undefined {
    return this.active.get(runId)?.step
  }

  /** 建一个可取消的 pipeline 上下文。 */
  private makeContext(run: RunState, config: PluginConfig, controller: AbortController): PipelineContext {
    return {
      config,
      store: this.store,
      run,
      signal: controller.signal,
      ...(this.dsh === undefined ? {} : { dsh: this.dsh }),
      setStep: (step: StepId, patch: Partial<StepState>) => {
        const target = run.steps.find(item => item.id === step)
        if (target === undefined) return
        Object.assign(target, patch)
        run.updatedAt = Date.now()
        this.store.schedule(run.id)
      },
      log: (step, level, text) => {
        this.store.log(run, step, level, text)
        run.updatedAt = Date.now()
        this.store.schedule(run.id)
      },
    }
  }

  private resetFrom(run: RunState, from: StepId, options: { clearDownstream: boolean }): void {
    const startIndex = STEP_IDS.indexOf(from)
    for (const [index, id] of STEP_IDS.entries()) {
      if (index < startIndex) continue
      const step = run.steps.find(item => item.id === id)
      if (step === undefined) continue
      step.status = 'pending'
      step.progress = 0
      step.message = undefined
      step.error = undefined
      step.startedAt = undefined
      step.endedAt = undefined
    }
    if (options.clearDownstream) {
      if (startIndex <= STEP_IDS.indexOf('analyze')) run.analysis = undefined
      if (startIndex <= STEP_IDS.indexOf('rewrite')) {
        run.scripts = undefined
        run.variantId = undefined
      }
      if (startIndex <= STEP_IDS.indexOf('match')) run.frames = []
      if (startIndex <= STEP_IDS.indexOf('generate')) run.segments = []
      if (startIndex <= STEP_IDS.indexOf('compose')) run.compose = undefined
    }
  }

  /**
   * 从某一步开始执行。
   * @param from - 起始步骤，默认第一个未完成的步骤。
   * @param autoAdvance - true 时连续执行到结束或失败；false 只执行一步。
   */
  async start(runId: string, options: { from?: StepId, autoAdvance?: boolean } = {}): Promise<{ run: RunState, finished: boolean }> {
    const run = await this.store.get(runId)
    if (run === undefined) throw new Error('运行不存在或已被删除')
    if (this.active.has(runId)) throw new Error('这个复刻任务正在执行中，请先等待或停止')

    const from = options.from ?? this.nextStep(run) ?? 'parse'
    const autoAdvance = options.autoAdvance ?? run.autoAdvance
    // 从该步之前重跑时，后续产物一律作废，避免新旧数据混在一起。
    this.resetFrom(run, from, { clearDownstream: true })
    run.error = undefined
    run.status = 'running'
    run.autoAdvance = autoAdvance
    this.store.log(run, 'run', 'info', `开始执行：${from}${autoAdvance ? '（自动连续执行）' : '（单步）'}`)

    const controller = new AbortController()
    const job: ActiveJob = {
      controller,
      step: from,
      promise: Promise.resolve(),
    }
    this.active.set(runId, job)

    const config = await this.configs.read()
    const context = this.makeContext(run, config, controller)
    const startIndex = STEP_IDS.indexOf(from)

    job.promise = (async () => {
      try {
        for (let index = startIndex; index < STEP_IDS.length; index += 1) {
          const step = STEP_IDS[index] as StepId
          // 手动步骤：自动连续执行时停在它前面，保留 pending 等用户点。
          if (index > startIndex && MANUAL_STEPS.includes(step)) break
          job.step = step
          if (controller.signal.aborted) throw new Error('已停止')
          await this.runOne(run, context, step)
          if (!autoAdvance) break
        }
        // 手动步骤（发布）保持 pending 不算“没跑完”，否则自动执行完六步永远是 idle。
        const remaining = run.steps.find(step => step.status === 'pending' && !MANUAL_STEPS.includes(step.id))
        if (remaining === undefined) {
          run.status = 'done'
          this.store.log(run, 'run', 'info', '全部步骤完成')
        } else {
          run.status = 'idle'
        }
      } catch (error) {
        const stopIndex = STEP_IDS.indexOf(job.step)
        const failing = run.steps.find(item => item.id === job.step)
        if (failing !== undefined && failing.status === 'running') {
          failing.status = 'failed'
          failing.error = messageOf(error)
          failing.endedAt = Date.now()
          failing.message = messageOf(error).slice(0, 200)
        }
        if (controller.signal.aborted) {
          run.status = 'stopped'
          this.store.log(run, 'run', 'warn', `已停止（${job.step}）`)
        } else {
          run.status = 'failed'
          run.error = `${job.step}：${messageOf(error)}`
          this.store.log(run, 'run', 'error', `${job.step} 失败：${messageOf(error)}`)
        }
        void stopIndex
      } finally {
        this.active.delete(runId)
        run.updatedAt = Date.now()
        await this.store.flush(runId)
      }
    })()

    return { run, finished: false }
  }

  private async runOne(run: RunState, context: PipelineContext, step: StepId): Promise<void> {
    const state = run.steps.find(item => item.id === step)
    if (state === undefined) return
    // 已完成的步骤在「重跑单步」语义下也应重置为运行中。
    state.status = 'running'
    state.progress = 0
    state.error = undefined
    state.stale = false
    state.startedAt = Date.now()
    state.message = '开始'
    this.store.log(run, step, 'info', `▶ ${step}`)
    await this.store.flush(run.id)

    const runner = STEP_RUNNERS[step]
    await runner(context)

    const after = run.steps.find(item => item.id === step)
    if (after !== undefined && after.status === 'running') {
      after.status = 'done'
      after.progress = 1
      after.endedAt = Date.now()
      after.stale = false
    }
    await this.store.flush(run.id)
  }

  /** 停止正在执行的任务。 */
  stop(runId: string): boolean {
    const job = this.active.get(runId)
    if (job === undefined) return false
    job.controller.abort(new Error('用户停止'))
    return true
  }

  /** 等所有任务结束（进程退出 / 测试用）。 */
  async waitAll(): Promise<void> {
    await Promise.all([...this.active.values()].map(job => job.promise))
  }

  /** 下一个应执行的步骤。 */
  nextStep(run: RunState): StepId | undefined {
    // 手动步骤不自动挑起来：一键发布对外有副作用，必须用户点。
    const pending = run.steps.find(step => step.status === 'pending' && !MANUAL_STEPS.includes(step.id))
    if (pending !== undefined) return pending.id
    const failed = run.steps.find(step => step.status === 'failed' && !MANUAL_STEPS.includes(step.id))
    return failed?.id
  }

  /** 单步重跑（会作废该步之后的产物）。 */
  async retryStep(runId: string, step: StepId): Promise<{ run: RunState }> {
    const result = await this.start(runId, { from: step, autoAdvance: false })
    return { run: result.run }
  }

  /** 跳过某一步（状态置 skipped，用于人工确认不需要的步骤）。 */
  async skipStep(runId: string, step: StepId): Promise<RunState> {
    const run = await this.store.get(runId)
    if (run === undefined) throw new Error('运行不存在')
    const state = run.steps.find(item => item.id === step)
    if (state === undefined) throw new Error('步骤不存在')
    if (state.status === 'running') throw new Error('该步骤正在执行，无法跳过')
    state.status = 'skipped'
    state.progress = 1
    state.message = '已跳过'
    state.endedAt = Date.now()
    this.store.log(run, step, 'warn', `跳过 ${step}`)
    await this.store.flush(runId)
    return run
  }

  /** 当前活跃任务数（健康检查用）。 */
  get activeCount(): number {
    return this.active.size
  }
}
