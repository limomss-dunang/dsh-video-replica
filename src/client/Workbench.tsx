/**
 * 复刻工作台：左栏流程轨道 + 中栏主舞台 + 右栏详情/日志。
 *
 * 每一步都是「一个可读的结果卡 + 一个可执行的动作」：
 * 输入链接 → 看拆解报告 → 选脚本版本 → 看参考图 → 看分镜视频 → 下载成片。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnalysisReport,
  ConfigView,
  PluginConfig,
  RunState,
  RunSummary,
  ScriptSegment,
  ScriptVariant,
  StepId,
  StepState,
} from '../shared/types.ts'
import { ASPECT_RATIOS, CAMERA_MOVES, PLATFORM_LABELS, SHOT_TYPES, STEP_IDS, STEP_LABELS } from '../shared/types.ts'
import type { VideoReplicaApi } from './api.ts'
import { mediaUrl } from './api.ts'
import type { PromptPreviewPayload } from './api.ts'
import { CONFIG_SAVED_EVENT, PANEL_OPEN_EVENT } from '../shared/protocol.ts'
import { copy, tt } from './locales.ts'

interface WorkbenchProps {
  api: VideoReplicaApi
  onClose: () => void
}

const STATUS_TEXT: Record<StepState['status'], string> = {
  pending: '待执行',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  skipped: '已跳过',
}

function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  return minutes === 0 ? `${total}s` : `${minutes}m${String(total % 60).padStart(2, '0')}s`
}

function stepOf(run: RunState, id: StepId): StepState {
  return run.steps.find(step => step.id === id) ?? { id, status: 'pending', progress: 0 }
}

function currentStep(run: RunState): StepId {
  const running = run.steps.find(step => step.status === 'running')
  if (running !== undefined) return running.id
  const failed = run.steps.find(step => step.status === 'failed')
  if (failed !== undefined) return failed.id
  const pending = run.steps.find(step => step.status === 'pending')
  return pending?.id ?? 'compose'
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function Pill(props: { tone?: 'ok' | 'warn' | 'err' | 'brand', children: React.ReactNode }): JSX.Element {
  return <span className="vr-pill" {...(props.tone === undefined ? {} : { 'data-tone': props.tone })}>{props.children}</span>
}

function Card(props: { title?: string, hint?: string, actions?: React.ReactNode, children: React.ReactNode }): JSX.Element {
  return (
    <section className="vr-card">
      {(props.title !== undefined || props.actions !== undefined) && (
        <header className="vr-card-head">
          {props.title !== undefined && <h3 className="vr-card-title">{props.title}</h3>}
          {props.actions !== undefined && <div className="vr-inline">{props.actions}</div>}
        </header>
      )}
      {props.hint !== undefined && props.hint !== '' && <p className="vr-hint">{props.hint}</p>}
      {props.children}
    </section>
  )
}

function Empty(props: { text: string, hint?: string }): JSX.Element {
  return (
    <div className="vr-empty">
      <div className="vr-empty-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M10 9.5l5 2.5-5 2.5z" />
        </svg>
      </div>
      <div>{props.text}</div>
      {props.hint !== undefined && <div className="vr-hint">{props.hint}</div>}
    </div>
  )
}

function toneOfScore(value: number): 'good' | 'mid' | 'low' {
  if (value >= 8) return 'good'
  if (value >= 6) return 'mid'
  return 'low'
}

function ScoreGrid(props: { analysis: AnalysisReport }): JSX.Element {
  const scores = props.analysis.scores
  const items: Array<[string, number]> = [
    ['钩子力', scores.hook],
    ['完播力', scores.retention],
    ['转化力', scores.conversion],
    ['综合', scores.overall],
  ]
  return (
    <div className="vr-score-grid">
      {items.map(([label, value]) => (
        <div className="vr-score" key={label} data-tone={toneOfScore(value)}>
          <b>{value}</b>
          <span>{label} / 10</span>
        </div>
      ))}
    </div>
  )
}

function ProgressBar(props: { value: number }): JSX.Element {
  return (
    <div className="vr-progress">
      <i style={{ width: `${Math.round(Math.min(1, Math.max(0, props.value)) * 100)}%` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function Workbench(props: WorkbenchProps): JSX.Element {
  const { api, onClose } = props
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [run, setRun] = useState<RunState | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [busyStep, setBusyStep] = useState<StepId | undefined>(undefined)
  const [config, setConfig] = useState<ConfigView | undefined>(undefined)
  const [selected, setSelected] = useState<StepId>('parse')
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** 正在等待宿主的动作（重生成/执行步骤），避免"点了没反应"的错觉。 */
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState('')
  const [productBrief, setProductBrief] = useState('')
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [aspectRatio, setAspectRatio] = useState<string>('source')
  const [detect, setDetect] = useState<{ platform?: string, note?: string, direct?: boolean } | undefined>(undefined)
  const videoInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const [pendingVideo, setPendingVideo] = useState<File | undefined>(undefined)
  const [pendingImages, setPendingImages] = useState<File[]>([])
  const autoSelectedFor = useRef<string | undefined>(undefined)

  const applyRun = useCallback((next: RunState | undefined, isBusy?: boolean, step?: StepId) => {
    setRun(next)
    if (isBusy !== undefined) setBusy(isBusy)
    if (step !== undefined) setBusyStep(step)
    if (next === undefined) return
    // 首次加载/新建时把选中步骤跳到当前进度；之后不再抢用户的选择。
    if (autoSelectedFor.current !== next.id) {
      autoSelectedFor.current = next.id
      setSelected(currentStep(next))
    }
  }, [])

  const reloadRun = useCallback(async (runId: string) => {
    try {
      const payload = await api.run(runId)
      applyRun(payload.run, payload.busy, payload.busyStep)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, applyRun])

  const reloadRuns = useCallback(async () => {
    try {
      const payload = await api.runs()
      setRuns(payload.runs)
    } catch {
      // 列表刷新失败不打扰用户
    }
  }, [api])

  /**
   * 重新拉取配置。
   *
   * 工作台常驻挂载，而模型配置是在设置对话框里改的：如果只在挂载时读一次，
   * 改完配置回来还会看到「还没有配置模型」的旧提示。所以窗口重新获得焦点、
   * 切回标签页、设置保存事件、以及低频兜底轮询都会刷新一次。
   */
  const reloadConfig = useCallback(async () => {
    try {
      setConfig(await api.config())
    } catch {
      // 配置不可用不影响工作台
    }
  }, [api])

  useEffect(() => {
    void (async () => {
      await reloadConfig()
      await reloadRuns()
    })()
  }, [reloadConfig, reloadRuns])

  // 配置变更的几种触发点：切回窗口、面板重新打开、设置页保存成功。
  useEffect(() => {
    const onFocus = (): void => { void reloadConfig() }
    const onVisible = (): void => { if (document.visibilityState === 'visible') void reloadConfig() }
    const onSaved = (): void => { void reloadConfig() }
    const onPanelOpen = (): void => { void reloadConfig() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(CONFIG_SAVED_EVENT, onSaved)
    window.addEventListener(PANEL_OPEN_EVENT, onPanelOpen)
    // 兜底：空闲时每 20 秒对一次（配置很小，成本可忽略）。
    const timer = window.setInterval(() => {
      if (!busy) void reloadConfig()
    }, 20_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(CONFIG_SAVED_EVENT, onSaved)
      window.removeEventListener(PANEL_OPEN_EVENT, onPanelOpen)
      window.clearInterval(timer)
    }
  }, [busy, reloadConfig])

  // 轮询：执行中 1.4s，空闲 5s 刷新历史列表。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const runId = run?.id
      if (runId !== undefined && (busy || run?.status === 'running')) {
        void reloadRun(runId)
      } else if (runId === undefined) {
        void reloadRuns()
      }
    }, busy || run?.status === 'running' ? 1400 : 5000)
    return () => window.clearInterval(timer)
  }, [busy, run?.id, run?.status, reloadRun, reloadRuns])

  const act = useCallback(async (
    work: () => Promise<unknown>,
    options: { reload?: boolean, label?: string } = {},
  ) => {
    setError(undefined)
    setNotice(undefined)
    setPending(options.label ?? '正在执行…')
    try {
      await work()
      if (options.reload !== false && run !== undefined) await reloadRun(run.id)
      await reloadRuns()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending(undefined)
    }
  }, [reloadRun, reloadRuns, run])

  const openRun = useCallback(async (runId: string) => {
    autoSelectedFor.current = undefined
    setError(undefined)
    setSelected('parse')
    await reloadRun(runId)
  }, [reloadRun])

  const create = useCallback(async () => {
    setCreating(true)
    setError(undefined)
    setNotice(undefined)
    // 用户可能刚在设置里配好模型，这里先对齐一次再判断/创建。
    await reloadConfig()
    try {
      const trimmedUrl = url.trim()
      const { run: created } = await api.createRun({
        ...(trimmedUrl === '' ? {} : { url: trimmedUrl }),
        ...(productBrief.trim() === '' ? {} : { productBrief: productBrief.trim() }),
        autoAdvance,
      })
      let latest = created
      if (pendingVideo !== undefined) {
        latest = await api.uploadVideo(created.id, pendingVideo)
      }
      for (const file of pendingImages) {
        latest = await api.uploadProduct(created.id, file)
      }
      applyRun(latest, true, 'parse')
      setSelected('parse')
      setPendingVideo(undefined)
      setPendingImages([])
      autoSelectedFor.current = created.id
      await api.start(created.id, autoAdvance)
      setUrl('')
      setDetect(undefined)
      await reloadRuns()
      await reloadRun(created.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }, [api, applyRun, autoAdvance, aspectRatio, pendingImages, pendingVideo, productBrief, reloadConfig, reloadRun, reloadRuns, url])

  const onDetect = useCallback(async (value: string) => {
    setUrl(value)
    if (value.trim() === '') {
      setDetect(undefined)
      return
    }
    const timer = window.setTimeout(() => {
      void api.detect(value).then(result => {
        setDetect(result.recognized ? { platform: result.platform, note: result.note, direct: result.direct } : undefined)
      }).catch(() => setDetect(undefined))
    }, 400)
    void timer
  }, [api])

  const variant = useMemo<ScriptVariant | undefined>(() => {
    if (run?.scripts === undefined) return undefined
    return run.scripts.variants.find(item => item.id === run.variantId)
      ?? run.scripts.variants.find(item => item.id === run.scripts?.recommendedId)
      ?? run.scripts.variants[0]
  }, [run?.scripts, run?.variantId])

  const stepState = run === undefined ? undefined : stepOf(run, selected)
  const canRun = run !== undefined && !busy

  return (
    <div className="vr-app">
      <header className="vr-header">
        <div className="vr-brand">
          <span className="vr-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
              <path d="M2.5 9.5h19M8 4.5v5M16 4.5v5" />
              <path d="M10.2 13l4.4 2.4-4.4 2.4z" />
            </svg>
          </span>
          <div className="vr-brand-text">
            <span className="vr-brand-title">{tt('title')}</span>
            <span className="vr-brand-sub">{tt('subtitle')}</span>
          </div>
        </div>
        <div className="vr-header-spacer" />
        {run !== undefined && (
          <div className="vr-header-run" title={run.title}>
            {busy ? <span className="vr-spin" /> : null}
            <span>{run.title}</span>
          </div>
        )}
        {run !== undefined && (
          <button
            type="button"
            className="vr-btn"
            data-variant={busy ? 'danger' : 'primary'}
            disabled={busy && !canRun}
            onClick={() => {
              if (busy) {
                void act(() => api.stop(run.id))
                return
              }
              void act(() => api.start(run.id, autoAdvance))
            }}
          >
            {busy ? tt('stop') : tt('runAll')}
          </button>
        )}
        <button type="button" className="vr-btn" data-variant="ghost" onClick={onClose} title={tt('sessionTip')}>
          {tt('session')}
        </button>
      </header>

      <div className="vr-body">
        <aside className="vr-rail">
          <div className="vr-rail-section">
            <h2 className="vr-rail-title">{tt('steps')}</h2>
            <button type="button" className="vr-new" onClick={() => { setRun(undefined); setSelected('parse'); autoSelectedFor.current = undefined; setError(undefined); setNotice(undefined) }}>
              + {tt('newRun')}
            </button>
          </div>
          <nav className="vr-steps">
            {(run?.steps ?? STEP_IDS.map(id => ({ id, status: 'pending' as const, progress: 0, message: undefined, stale: false }))).map((step, index) => (
              <button
                type="button"
                key={step.id}
                className="vr-step"
                data-status={step.status}
                {...(step.stale === true ? { 'data-stale': '' } : {})}
                {...(selected === step.id ? { 'data-active': '' } : {})}
                onClick={() => setSelected(step.id)}
              >
                <span className="vr-step-idx">
                  {step.status === 'done' ? (step.stale === true ? '↻' : '✓') : step.status === 'failed' ? '!' : index + 1}
                </span>
                <span className="vr-step-text">
                  <span className="vr-step-label">{STEP_LABELS[step.id]}</span>
                  <span className="vr-step-msg">
                    {step.stale === true ? tt('stepStale') : (step.message ?? STATUS_TEXT[step.status])}
                  </span>
                  {step.status === 'running' && <ProgressBar value={step.progress} />}
                </span>
              </button>
            ))}
          </nav>
          <div className="vr-rail-section" style={{ paddingBottom: 0 }}>
            <h2 className="vr-rail-title">{tt('history')}</h2>
          </div>
          <div className="vr-history">
            {runs.length === 0 && <p className="vr-hint" style={{ padding: '0 8px' }}>{tt('historyEmpty')}</p>}
            {runs.map(item => (
              <button
                type="button"
                key={item.id}
                className="vr-run"
                {...(run?.id === item.id ? { 'data-active': '' } : {})}
                onClick={() => void openRun(item.id)}
              >
                {item.thumbFile === undefined
                  ? <span className="vr-run-thumb" />
                  : <img className="vr-run-thumb" src={mediaUrl(item.id, item.thumbFile)} alt="" loading="lazy" />}
                <span className="vr-run-text">
                  <span className="vr-run-title">{item.title || tt('untitled')}</span>
                  <span className="vr-run-meta">
                    <span>{item.platform === undefined ? '—' : PLATFORM_LABELS[item.platform]}</span>
                    <span>·</span>
                    <span>{item.completed}/6</span>
                    <span>·</span>
                    <span>{formatTime(item.updatedAt)}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="vr-main">
          <div className="vr-stage">
            {pending !== undefined && <div className="vr-banner" data-tone="ok">{pending}</div>}
          {error !== undefined && <div className="vr-banner" data-tone="err">{error}</div>}
            {notice !== undefined && <div className="vr-banner" data-tone="ok">{notice}</div>}
            {run === undefined
              ? (
                  <StageInput
                    url={url}
                    productBrief={productBrief}
                    autoAdvance={autoAdvance}
                    aspectRatio={aspectRatio}
                    onAspectRatio={setAspectRatio}
                    creating={creating}
                    detect={detect}
                    pendingVideo={pendingVideo}
                    pendingImages={pendingImages}
                    config={config}
                    onUrl={onDetect}
                    onProductBrief={setProductBrief}
                    onAutoAdvance={setAutoAdvance}
                    onPickVideo={() => videoInput.current?.click()}
                    onPickImages={() => imageInput.current?.click()}
                    onDropVideo={file => setPendingVideo(file)}
                    onDropImages={files => setPendingImages(current => [...current, ...files])}
                    onRemoveVideo={() => setPendingVideo(undefined)}
                    onRemoveImage={index => setPendingImages(current => current.filter((_, i) => i !== index))}
                    onCreate={() => void create()}
                    onRefreshConfig={() => void reloadConfig()}
                  />
                )
              : (
                  <>
                    {selected === 'parse' && (
                      <StageParse
                        run={run}
                        api={api}
                        busy={busy}
                        step={stepState as StepState}
                        onPickVideo={() => videoInput.current?.click()}
                        onPickImages={() => imageInput.current?.click()}
                        onRemoveImage={index => void act(async () => {
                          await api.action({ runId: run.id, action: 'sync-product-images', removeIndex: index })
                        })}
                        onAspectRatio={value => void act(() => api.setAspectRatio(run.id, value))}
                  onRun={() => void act(() => api.runStep(run.id, 'parse'))}
                      />
                    )}
                    {selected === 'analyze' && <StageAnalysis run={run} step={stepState as StepState} onRun={() => void act(() => api.runStep(run.id, 'analyze'))} />}
                    {selected === 'rewrite' && (
                      <StageRewrite
                        run={run}
                        api={api}
                        variant={variant}
                        step={stepState as StepState}
                        onSelect={variantId => void act(() => api.selectVariant(run.id, variantId))}
                        onSave={segments => void act(() => api.updateSegments(run.id, segments))}
                        onMode={mode => void act(() => api.setRewriteMode(run.id, mode))}
                  onRun={() => void act(() => api.runStep(run.id, 'rewrite'))}
                      />
                    )}
                    {selected === 'match' && (
                      <StageMatch
                        api={api}
                        run={run}
                        busy={busy}
                        variant={variant}
                        step={stepState as StepState}
                        onRegenerate={segmentIndex => void act(() => api.regenerateFrame(run.id, segmentIndex))}
                        onRun={() => void act(() => api.runStep(run.id, 'match'))}
                      />
                    )}
                    {selected === 'generate' && (
                      <StageGenerate
                        api={api}
                        run={run}
                        busy={busy}
                        step={stepState as StepState}
                        onRegenerate={segmentIndex => void act(() => api.regenerateSegment(run.id, segmentIndex))}
                        onRegenerateWithPrompt={(segmentIndex, prompt) => act(
                          () => api.regenerateSegment(run.id, segmentIndex, prompt),
                          { label: `正在用新提示词重新生成第 ${segmentIndex} 段（含重新合成，约 1–3 分钟）…` },
                        )}
                        onRun={() => void act(() => api.runStep(run.id, 'generate'))}
                      />
                    )}
                    {selected === 'publish' && (
                      <StagePublish
                        api={api}
                        run={run}
                        busy={busy}
                        step={stepState as StepState}
                        onRun={() => void act(() => api.runStep(run.id, 'publish'))}
                        onCaption={async () => { await act(() => api.caption(run.id), { label: '正在生成标题和话题…' }) }}
                        onPublish={input => void act(() => api.publish(run.id, { platform: 'channels', ...input }))}
                      />
                    )}
                    {selected === 'compose' && (
                      <StageCompose
                        api={api}
                        run={run}
                        step={stepState as StepState}
                        onRun={() => void act(() => api.runStep(run.id, 'compose'))}
                        onAudioSource={value => void act(() => api.setAudioSource(run.id, value))}
                      />
                    )}
                  </>
                )}
          </div>
        </main>

        <aside className="vr-side">
          <div className="vr-side-section">
            <h2 className="vr-rail-title">{tt('details')}</h2>
            <div className="vr-kv"><span>{tt('status')}</span><span>{busy ? (busyStep === undefined ? '执行中' : `执行中 · ${STEP_LABELS[busyStep]}`) : (run?.status ?? '—')}</span></div>
            {run?.source !== undefined && (
              <>
                <div className="vr-kv"><span>{tt('platform')}</span><span>{PLATFORM_LABELS[run.source.platform]}</span></div>
                <div className="vr-kv"><span>{tt('duration')}</span><span>{run.source.durationSec === undefined ? '—' : `${run.source.durationSec.toFixed(1)}s`}</span></div>
                <div className="vr-kv"><span>分辨率</span><span>{run.source.width === undefined ? '—' : `${run.source.width}×${run.source.height}`}</span></div>
              </>
            )}
            {run?.analysis !== undefined && (
              <>
                <div className="vr-kv"><span>镜头数</span><span>{run.analysis.meta.shotCount}</span></div>
                <div className="vr-kv"><span>风格</span><span>{run.analysis.meta.style}</span></div>
              </>
            )}
            {variant !== undefined && (
              <div className="vr-kv"><span>脚本</span><span>{variant.id} 版 · {variant.segments.length} 镜</span></div>
            )}
            {config !== undefined && (
              <>
                <div className="vr-kv" title={describeEndpoint(config.config.analyze)}>
                  <span>拆解模型</span><span>{describeEndpoint(config.config.analyze)}</span>
                </div>
                <div className="vr-kv" title={describeEndpoint(config.config.video)}>
                  <span>视频模型</span><span>{describeEndpoint(config.config.video)}</span>
                </div>
              </>
            )}
            {run !== undefined && (
              <div className="vr-kv"><span>创建</span><span>{formatTime(run.createdAt)}</span></div>
            )}
            {run !== undefined && busy && (
              <div className="vr-kv"><span>已运行</span><span>{formatElapsed(Date.now() - run.updatedAt)}</span></div>
            )}
            {run !== undefined && (
              <div className="vr-inline" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="vr-btn"
                  data-size="sm"
                  data-variant="danger"
                  onClick={() => {
                    if (run === undefined) return
                    void act(async () => {
                      await api.deleteRun(run.id)
                      setRun(undefined)
                    })
                  }}
                >
                  {tt('delete')}
                </button>
                {stepState !== undefined && stepState.status === 'failed' && (
                  <button type="button" className="vr-btn" data-size="sm" onClick={() => void act(() => api.skipStep(run.id, selected))}>
                    {tt('skip')}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="vr-side-section" style={{ paddingBottom: 6 }}>
            <h2 className="vr-rail-title">{tt('logs')}</h2>
          </div>
          <div className="vr-logs">
            {(run?.logs ?? []).slice(-160).map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="vr-log" data-level={entry.level}>
                <time>{formatTime(entry.at)}</time>
                <span>{entry.text}</span>
              </div>
            ))}
            {(run?.logs ?? []).length === 0 && <p className="vr-hint">{tt('logsEmpty')}</p>}
          </div>
        </aside>
      </div>

      <input
        ref={videoInput}
        type="file"
        accept="video/*,.mp4,.mov,.mkv,.webm"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file === undefined) return
          if (run !== undefined) {
            void act(async () => {
              await api.uploadVideo(run.id, file)
            })
          } else {
            setPendingVideo(file)
          }
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        style={{ display: 'none' }}
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length === 0) return
          if (run !== undefined) {
            void act(async () => {
              for (const file of files) await api.uploadProduct(run.id, file)
            })
          } else {
            setPendingImages(current => [...current, ...files])
          }
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 输入舞台
// ---------------------------------------------------------------------------

interface StageInputProps {
  url: string
  productBrief: string
  autoAdvance: boolean
  aspectRatio: string
  onAspectRatio: (value: string) => void
  creating: boolean
  detect: { platform?: string, note?: string, direct?: boolean } | undefined
  pendingVideo: File | undefined
  pendingImages: File[]
  config: ConfigView | undefined
  onUrl: (value: string) => void
  onProductBrief: (value: string) => void
  onAutoAdvance: (value: boolean) => void
  onPickVideo: () => void
  onPickImages: () => void
  onDropVideo: (file: File) => void
  onDropImages: (files: File[]) => void
  onRemoveVideo: () => void
  onRemoveImage: (index: number) => void
  onCreate: () => void
  onRefreshConfig: () => void
}

/** 一步的模型是否已就绪（DSH 已配置模型 or 手填接口）。 */
function endpointReady(endpoint: { source?: string, dshModel?: string, apiUrl?: string } | undefined): boolean {
  if (endpoint === undefined) return false
  return endpoint.source === 'dsh' ? (endpoint.dshModel ?? '').trim() !== '' : (endpoint.apiUrl ?? '').trim() !== ''
}

/** 人类可读的模型描述（DSH 模式显示提供商/模型）。 */
function describeEndpoint(endpoint: { source?: string, dshProvider?: string, dshModel?: string, model?: string } | undefined): string {
  if (endpoint === undefined) return '—'
  if (endpoint.source === 'dsh') {
    return `${(endpoint.dshProvider ?? '').trim() || '?'} / ${(endpoint.dshModel ?? '').trim() || '?'}`
  }
  return (endpoint.model ?? '').trim() || '—'
}

/** 画幅选择：创建前就定好，后面自动连续执行全程用它。 */
function AspectPicker(props: {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <div className="vr-row" style={{ gap: 8, alignItems: 'center' }}>
      <span className="vr-hint">{tt('aspectRatio')}：</span>
      <select
        className="vr-input"
        style={{ width: 160 }}
        value={props.value}
        disabled={props.disabled === true}
        onChange={event => props.onChange(event.target.value)}
      >
        {ASPECT_RATIOS.map(item => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
      <span className="vr-hint">{tt('aspectHint')}</span>
    </div>
  )
}

function StageInput(props: StageInputProps): JSX.Element {
  const config = props.config?.config
  const missingModels = config !== undefined
    && !endpointReady(config.analyze)
    && !endpointReady(config.rewrite)
  return (
    <>
      <div className="vr-stage-head">
        <h1 className="vr-h1">{tt('inputTitle')}</h1>
      </div>
      <p className="vr-hint">{tt('inputTip')}</p>
      {missingModels && (
        <div className="vr-banner">
          <span>
            还没有配置模型：请到「设置 → 视频复刻」选择 DSH 已配置的模型，或手填接口地址、密钥与模型名，否则执行会立即失败。
          </span>
          <button
            type="button"
            className="vr-btn"
            data-size="sm"
            style={{ marginLeft: 'auto', flex: 'none' }}
            onClick={props.onRefreshConfig}
          >
            重新检测配置
          </button>
        </div>
      )}
      <Card title={tt('urlLabel')}>
        <input
          className="vr-input"
          value={props.url}
          placeholder={tt('urlPlaceholder')}
          onChange={event => props.onUrl(event.target.value)}
        />
        {props.detect !== undefined && (
          <div className="vr-inline">
            <Pill tone="brand">{tt('detected')}：{props.detect.platform === undefined ? '—' : PLATFORM_LABELS[props.detect.platform as keyof typeof PLATFORM_LABELS] ?? props.detect.platform}</Pill>
            {props.detect.direct === true && <Pill tone="ok">直链</Pill>}
            {props.detect.note !== undefined && props.detect.note !== '' && <span className="vr-hint">{props.detect.note}</span>}
          </div>
        )}
        <div className="vr-field">
          <label className="vr-label">{tt('productBriefLabel')}</label>
          <textarea
            className="vr-textarea"
            value={props.productBrief}
            placeholder={tt('productBriefPlaceholder')}
            onChange={event => props.onProductBrief(event.target.value)}
          />
        </div>
        <label className="vr-switch">
          <input type="checkbox" checked={props.autoAdvance} onChange={event => props.onAutoAdvance(event.target.checked)} />
          {tt('autoAdvance')}
        </label>
      </Card>

      <Card title={tt('outputPrefs')}>
        <AspectPicker value={props.aspectRatio} onChange={props.onAspectRatio} />
      </Card>

      <div className="vr-row">
        <Card title={tt('localVideo')} hint={tt('localVideoTip')}>
          {props.pendingVideo === undefined
            ? (
                <div
                  className="vr-drop"
                  onClick={props.onPickVideo}
                  onDragOver={event => event.preventDefault()}
                  onDrop={event => {
                    event.preventDefault()
                    const file = event.dataTransfer.files?.[0]
                    if (file !== undefined) props.onDropVideo(file)
                  }}
                >
                  <strong>{tt('chooseVideo')}</strong>
                  <span>mp4 / mov / mkv / webm</span>
                </div>
              )
            : (
                <div className="vr-inline">
                  <Pill tone="ok">{props.pendingVideo.name}</Pill>
                  <button type="button" className="vr-btn" data-size="sm" onClick={props.onRemoveVideo}>×</button>
                </div>
              )}
        </Card>
        <Card title={tt('productImages')} hint={tt('productImagesTip')}>
          <div
            className="vr-drop"
            onClick={props.onPickImages}
            onDragOver={event => event.preventDefault()}
            onDrop={event => {
              event.preventDefault()
              props.onDropImages(Array.from(event.dataTransfer.files ?? []))
            }}
          >
            <strong>{tt('chooseImages')}</strong>
            <span>png / jpg / webp</span>
          </div>
          {props.pendingImages.length > 0 && (
            <div className="vr-thumbs">
              {props.pendingImages.map((file, index) => (
                <span className="vr-thumb-wrap" key={`${file.name}-${index}`}>
                  <img className="vr-thumb" src={URL.createObjectURL(file)} alt={file.name} />
                  <button type="button" className="vr-thumb-x" onClick={() => props.onRemoveImage(index)}>×</button>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="vr-inline">
        <button
          type="button"
          className="vr-btn"
          data-variant="primary"
          disabled={props.creating || (props.url.trim() === '' && props.pendingVideo === undefined)}
          onClick={props.onCreate}
        >
          {props.creating ? <span className="vr-spin" /> : null}
          {tt('createAndParse')}
        </button>
        <span className="vr-hint">{copy().subtitle}</span>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 各步骤舞台
// ---------------------------------------------------------------------------

interface StageBaseProps {
  run: RunState
  step: StepState
  busy?: boolean
  onRun: () => void
}

function StageHeader(props: { title: string, step: StepState, onRun: () => void, busy?: boolean }): JSX.Element {
  return (
    <div className="vr-stage-head">
      <h1 className="vr-h1">{props.title}</h1>
      <Pill tone={props.step.status === 'done' ? 'ok' : props.step.status === 'failed' ? 'err' : props.step.status === 'running' ? 'brand' : undefined}>
        {STATUS_TEXT[props.step.status]}
      </Pill>
      {props.step.message !== undefined && <span className="vr-hint">{props.step.message}</span>}
      <div className="vr-header-spacer" />
      <button
        type="button"
        className="vr-btn"
        data-size="sm"
        disabled={props.busy === true || props.step.status === 'running'}
        onClick={props.onRun}
      >
        {props.step.status === 'done' ? tt('retry') : tt('runStep')}
      </button>
      {props.step.status === 'running' && <span className="vr-spin" />}
    </div>
  )
}

interface StageParseProps {
  run: RunState
  api: VideoReplicaApi
  busy: boolean
  step: StepState
  onAspectRatio: (value: string) => void
  onPickVideo: () => void
  onPickImages: () => void
  onRemoveImage: (index: number) => void
  onRun: () => void
}

function StageParse(props: StageParseProps): JSX.Element {
  const { run } = props
  return (
    <>
      <StageHeader title={STEP_LABELS.parse} step={props.step} onRun={props.onRun} busy={props.busy} />
      <AspectPicker
        value={run.aspectRatio ?? 'source'}
        disabled={props.busy}
        onChange={props.onAspectRatio}
      />
      {run.source !== undefined && (
        <Card title="源视频">
          <div className="vr-row">
            {run.source.thumbFile !== undefined && (
              <img
                src={mediaUrl(run.id, run.source.thumbFile)}
                alt=""
                style={{ width: 96, height: 128, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)' }}
              />
            )}
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="vr-kv"><span>标题</span><span>{run.source.title}</span></div>
              {run.source.author !== undefined && <div className="vr-kv"><span>作者</span><span>{run.source.author}</span></div>}
              <div className="vr-kv"><span>{tt('platform')}</span><span>{PLATFORM_LABELS[run.source.platform]} · {run.source.provider}</span></div>
              <div className="vr-kv"><span>{tt('duration')}</span><span>{run.source.durationSec === undefined ? '—' : `${run.source.durationSec.toFixed(1)}s`}</span></div>
              <div className="vr-kv"><span>文件</span><span>{run.source.videoFile}</span></div>
            </div>
          </div>
          <video className="vr-video" controls preload="metadata" src={mediaUrl(run.id, run.source.videoFile)} />
        </Card>
      )}
      <div className="vr-row">
        <Card title={tt('localVideo')} hint={tt('localVideoTip')}>
          <button type="button" className="vr-btn" onClick={props.onPickVideo}>{tt('chooseVideo')}</button>
        </Card>
        <Card title={tt('productImages')} hint={tt('productImagesTip')}>
          <button type="button" className="vr-btn" onClick={props.onPickImages}>{tt('chooseImages')}</button>
          {run.productImages.length > 0 && (
            <div className="vr-thumbs">
              {run.productImages.map((image, index) => (
                <span className="vr-thumb-wrap" key={image.file}>
                  <img className="vr-thumb" src={mediaUrl(run.id, image.file)} alt={image.name} />
                  <button type="button" className="vr-thumb-x" onClick={() => props.onRemoveImage(index)}>×</button>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
      {run.sourceUrl !== undefined && <p className="vr-hint">原始链接：{run.sourceUrl}</p>}
    </>
  )
}

function StageAnalysis(props: { run: RunState, step: StepState, onRun: () => void }): JSX.Element {
  const analysis = props.run.analysis
  return (
    <>
      <StageHeader title={STEP_LABELS.analyze} step={props.step} onRun={props.onRun} />
      {analysis === undefined
        ? <Empty text={tt('noAnalysis')} />
        : (
            <>
              <Card title={tt('analysisSummary')}>
                <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65 }}>{analysis.summary}</p>
                <ScoreGrid analysis={analysis} />
                <div className="vr-inline">
                  <Pill tone="brand">{analysis.meta.style}</Pill>
                  <Pill>{analysis.shots.length} 镜</Pill>
                  <Pill>{analysis.meta.pacing === '' ? '—' : analysis.meta.pacing}</Pill>
                  {analysis.occasion !== undefined && (
                    <Pill tone="ok">节令：{analysis.occasion.name}</Pill>
                  )}
                </div>
                {analysis.occasion !== undefined && (
                  <p className="vr-hint">时效钩子：{analysis.occasion.why}</p>
                )}
              </Card>

              <Card title={tt('hook')}>
                <div className="vr-kv"><span>类型</span><span>{analysis.hook.type}</span></div>
                <div style={{ fontSize: 13, fontWeight: 550 }}>{analysis.hook.text}</div>
                <p className="vr-hint">{analysis.hook.whyItWorks}</p>
              </Card>

              <Card title={tt('dna')}>
                <div className="vr-dna">
                  {analysis.dna.map((item, index) => <span key={index}>{item}</span>)}
                </div>
              </Card>

              <Card title={tt('frames')}>
                <div className="vr-frames">
                  {analysis.frameFiles.map(file => (
                    <figure className="vr-frame" key={file} style={{ aspectRatio: '3/4' }}>
                      <img src={mediaUrl(props.run.id, `frames/${file}`)} alt={file} loading="lazy" />
                      <figcaption>{file.replace(/\.[^.]+$/, '')}</figcaption>
                    </figure>
                  ))}
                </div>
              </Card>

              <Card title={tt('shots')}>
                <table className="vr-table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th style={{ width: 92 }}>{tt('duration')}</th>
                      <th style={{ width: 96 }}>景别/运镜</th>
                      <th>画面</th>
                      <th style={{ width: 150 }}>{tt('voiceover')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.shots.map(shot => (
                      <tr key={shot.index}>
                        <td className="vr-idx">{shot.index}</td>
                        <td className="vr-idx">{shot.startSec.toFixed(1)}–{shot.endSec.toFixed(1)}s</td>
                        <td>{shot.shotType}<br /><span className="vr-hint">{shot.camera}</span></td>
                        <td>
                          {shot.visual}
                          {shot.onscreenText !== '' && <div className="vr-hint">大字：{shot.onscreenText}</div>}
                        </td>
                        <td>{shot.voiceover === '' ? '—' : shot.voiceover}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>

              <Card title={tt('transcript')}>
                {analysis.transcript === undefined || analysis.transcript.length === 0
                  ? <p className="vr-hint">{tt('transcriptMissing')}</p>
                  : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {analysis.transcript.map((cue, index) => (
                          <div key={index} style={{ fontSize: 12 }}>
                            <span className="vr-idx">{cue.startSec.toFixed(1)}s </span>
                            {cue.text}
                          </div>
                        ))}
                      </div>
                    )}
              </Card>
            </>
          )}
    </>
  )
}

interface StageRewriteProps {
  onMode: (mode: 'faithful' | 'redesign') => void
  run: RunState
  api: VideoReplicaApi
  variant: ScriptVariant | undefined
  step: StepState
  onSelect: (variantId: string) => void
  onSave: (segments: ScriptSegment[]) => void
  onRun: () => void
}

function StageRewrite(props: StageRewriteProps): JSX.Element {
  const { run, variant } = props
  const [draft, setDraft] = useState<ScriptSegment[] | undefined>(undefined)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(variant === undefined ? undefined : variant.segments.map(segment => ({ ...segment })))
    setDirty(false)
  }, [variant?.id, run.scripts?.createdAt])

  const segments = draft ?? variant?.segments ?? []
  const update = (index: number, patch: Partial<ScriptSegment>): void => {
    setDraft(current => {
      const base = current ?? (variant?.segments ?? []).map(segment => ({ ...segment }))
      return base.map((segment, i) => (i === index ? { ...segment, ...patch } : segment))
    })
    setDirty(true)
  }

  return (
    <>
      <StageHeader title={STEP_LABELS.rewrite} step={props.step} onRun={props.onRun} />
      <div className="vr-row" style={{ gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
        <span className="vr-hint">复刻方式：</span>
        <select
          className="vr-input"
          style={{ width: 240 }}
          value={run.rewriteMode ?? 'faithful'}
          onChange={event => props.onMode(event.target.value === 'redesign' ? 'redesign' : 'faithful')}
        >
          <option value="faithful">忠于原片（保留题材与节令）</option>
          <option value="redesign">重新设计（换桥段，保留核心机制与节令）</option>
        </select>
        {run.analysis?.occasion !== undefined && <span className="vr-hint">节令：{run.analysis.occasion.name}（必须保留）</span>}
      </div>
      {run.scripts === undefined || variant === undefined
        ? <Empty text="还没有脚本，先执行「AI 仿写」。" />
        : (
            <>
              <Card title={tt('variants')} hint={tt('editHint')}>
                <div className="vr-tabs">
                  {run.scripts.variants.map(item => (
                    <button
                      type="button"
                      key={item.id}
                      className="vr-tab"
                      {...(item.id === variant.id ? { 'data-active': '' } : {})}
                      onClick={() => props.onSelect(item.id)}
                    >
                      {item.id} 版 · {item.angle === '' ? item.title : item.angle}
                      {item.id === run.scripts?.recommendedId && <Pill tone="ok">推荐</Pill>}
                    </button>
                  ))}
                </div>
                <div className="vr-kv"><span>标题</span><span>{variant.title}</span></div>
                <div className="vr-kv"><span>钩子</span><span>{variant.hookLine}</span></div>
                <div className="vr-kv"><span>时长</span><span>{variant.totalDurationSec}s · {segments.length} 个分镜</span></div>
                {run.scripts.checks !== undefined && (
                  <div className="vr-inline" style={{ marginTop: 6 }}>
                    <Pill>{`主体：${run.scripts.checks.keptSubject === undefined || run.scripts.checks.keptSubject === '' ? '—' : run.scripts.checks.keptSubject}`}</Pill>
                    <Pill tone={run.analysis?.occasion === undefined ? undefined : 'ok'}>{`节令：${run.scripts.checks.keptOccasion === undefined || run.scripts.checks.keptOccasion === '' ? '无' : run.scripts.checks.keptOccasion}`}</Pill>
                  </div>
                )}
                {variant.notes !== '' && <p className="vr-hint">{variant.notes}</p>}
                <div className="vr-inline">
                  <button
                    type="button"
                    className="vr-btn"
                    data-variant="primary"
                    disabled={!dirty}
                    onClick={() => props.onSave(segments)}
                  >
                    {dirty ? '保存分镜' : tt('selected')}
                  </button>
                  {dirty && (
                    <button
                      type="button"
                      className="vr-btn"
                      onClick={() => {
                        setDraft(variant.segments.map(segment => ({ ...segment })))
                        setDirty(false)
                      }}
                    >
                      {tt('cancel')}
                    </button>
                  )}
                </div>
              </Card>

              <Card title={tt('segmentTable')}>
                <table className="vr-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>#</th>
                      <th style={{ width: 66 }}>{tt('duration')}</th>
                      <th style={{ width: 108 }}>{tt('shotLook')}</th>
                      <th style={{ width: '20%' }}>{tt('voiceover')}</th>
                      <th style={{ width: '14%' }}>{tt('onscreen')}</th>
                      <th>{tt('visualPrompt')}</th>
                      <th style={{ width: '13%' }}>{tt('placement')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((segment, index) => (
                      <tr key={`${variant.id}-${index}`}>
                        <td className="vr-idx">{index + 1}</td>
                        <td className="vr-idx">{(segment.endSec - segment.startSec).toFixed(1)}s</td>
                        <td>
                          <select
                            className="vr-cell-input"
                            value={segment.shotType}
                            onChange={event => update(index, { shotType: event.target.value })}
                          >
                            {SHOT_TYPES.map(item => <option key={item} value={item}>{item}</option>)}
                          </select>
                          <select
                            className="vr-cell-input"
                            style={{ marginTop: 4 }}
                            value={segment.camera}
                            onChange={event => update(index, { camera: event.target.value })}
                          >
                            {CAMERA_MOVES.map(item => <option key={item} value={item}>{item}</option>)}
                          </select>
                        </td>
                        <td>
                          <textarea
                            className="vr-cell-input"
                            value={segment.voiceover}
                            onChange={event => update(index, { voiceover: event.target.value })}
                          />
                        </td>
                        <td>
                          <textarea
                            className="vr-cell-input"
                            value={segment.onscreenText}
                            onChange={event => update(index, { onscreenText: event.target.value })}
                          />
                        </td>
                        <td>
                          <textarea
                            className="vr-cell-input"
                            style={{ minHeight: 54 }}
                            value={segment.visualPrompt}
                            onChange={event => update(index, { visualPrompt: event.target.value })}
                          />
                        </td>
                        <td>
                          <textarea
                            className="vr-cell-input"
                            value={segment.productPlacement}
                            onChange={event => update(index, { productPlacement: event.target.value })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
    </>
  )
}

interface StageMatchProps {
  api: VideoReplicaApi
  run: RunState
  busy: boolean
  variant: ScriptVariant | undefined
  step: StepState
  onRegenerate: (segmentIndex: number) => void
  onRun: () => void
}

function PromptPreview(props: {
  api: VideoReplicaApi
  runId: string
  stage: 'match' | 'generate'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState<PromptPreviewPayload | undefined>()
  const [copied, setCopied] = useState('')

  const toggle = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    setOpen(true)
    if (data !== undefined) return
    setLoading(true)
    setError('')
    try {
      setData(await props.api.previewPrompts(props.runId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const copy = (text: string, key: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(''), 1200)
    }).catch(() => {})
  }

  const items = props.stage === 'match'
    ? (data?.frames ?? []).map(frame => ({
        key: `f${frame.segmentIndex}`,
        title: `镜 ${frame.segmentIndex} · ${frame.shotType}/${frame.camera}`,
        text: frame.framePrompt,
      }))
    : (data?.videos ?? []).map(video => ({
        key: `v${video.segmentIndex}`,
        title: `第 ${video.segmentIndex} 段 · ${video.durationSec.toFixed(1)}s · 镜 ${video.shots.join(',')}`,
        text: video.videoPrompt,
      }))

  return (
    <div className="vr-prompt-preview">
      <div className="vr-row" style={{ alignItems: 'center', gap: 8 }}>
        <button type="button" className="vr-btn" data-size="sm" onClick={() => void toggle()}>
          {open ? tt('hidePrompts') : tt('previewPrompts')}
        </button>
        <span className="vr-hint">{tt('previewPromptsHint')}</span>
        {loading && <span className="vr-hint">{tt('running')}</span>}
      </div>
      {open && error !== '' && <div className="vr-banner" data-tone="err">{error}</div>}
      {open && data !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflow: 'auto', marginTop: 8 }}>
          <div className="vr-hint">
            {tt('previewVariant')}: {data.variantId} · {tt('previewProductMode')}: {data.productMode === 'text' ? tt('productModeText') : tt('productModeReference')}
          </div>
          {items.map(item => (
            <div key={item.key}>
              <div className="vr-row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="vr-idx">{item.title}</span>
                <button type="button" className="vr-btn" data-size="sm" data-variant="ghost" onClick={() => copy(item.text, item.key)}>
                  {copied === item.key ? tt('copied') : tt('copy')}
                </button>
              </div>
              <div className="vr-seg-prompt">{item.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StageMatch(props: StageMatchProps): JSX.Element {
  const frames = props.run.frames
  return (
    <>
      <StageHeader title={STEP_LABELS.match} step={props.step} onRun={props.onRun} busy={props.busy} />
      <PromptPreview api={props.api} runId={props.run.id} stage="match" />
      <p className="vr-hint">{tt('refFramesTip')}</p>
      {frames.length === 0
        ? <Empty text={tt('matchMissing')} />
        : (
            <Card title={`${tt('refFrames')}（${frames.filter(frame => frame.file !== '').length}/${frames.length}）`}>
              <div className="vr-frames">
                {frames.map(frame => (
                  <figure className="vr-frame" data-kind="ref" key={frame.segmentIndex}>
                    {frame.file === ''
                      ? <div className="vr-frame-err">{frame.error ?? '生成失败'}</div>
                      : <img key={frame.createdAt} src={mediaUrl(props.run.id, frame.file, { version: frame.createdAt })} alt={`ref-${frame.segmentIndex}`} loading="lazy" />}
                    <figcaption>镜 {frame.segmentIndex} · {frame.mode === 'product' ? '产品融入' : '场景'}</figcaption>
                    <div className="vr-frame-actions">
                      <button
                        type="button"
                        className="vr-btn"
                        data-size="sm"
                        title={tt('regenerate')}
                        disabled={props.busy}
                        onClick={() => props.onRegenerate(frame.segmentIndex)}
                      >
                        ↻
                      </button>
                    </div>
                  </figure>
                ))}
              </div>
            </Card>
          )}
      {props.variant !== undefined && frames.length > 0 && (
        <Card title="每张图的生成提示词">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflow: 'auto' }}>
            {frames.map(frame => (
              <div key={frame.segmentIndex}>
                <div className="vr-idx">镜 {frame.segmentIndex}</div>
                <div className="vr-seg-prompt">{frame.prompt}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  )
}

interface StageGenerateProps {
  api: VideoReplicaApi
  run: RunState
  busy: boolean
  step: StepState
  onRegenerate: (segmentIndex: number) => void
  onRegenerateWithPrompt: (segmentIndex: number, prompt: string) => void
  onRun: () => void
}

/** 单段提示词编辑：改完可以立刻用改后的提示词重生成这一段。 */
function SegmentPromptEditor(props: {
  segmentIndex: number
  prompt: string
  busy: boolean
  onRegenerate: (prompt: string) => Promise<unknown> | void
}): JSX.Element {
  const [text, setText] = useState(props.prompt)
  const [dirty, setDirty] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    setText(props.prompt)
    setDirty(false)
  }, [props.prompt])
  return (
    <details className="vr-prompt-editor">
      <summary className="vr-hint" style={{ cursor: 'pointer' }}>{tt('prompt')}（可编辑）</summary>
      <textarea
        className="vr-textarea"
        value={text}
        rows={8}
        spellCheck={false}
        onChange={event => {
          setText(event.target.value)
          setDirty(event.target.value !== props.prompt)
        }}
      />
      <div className="vr-row" style={{ gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="vr-btn"
          data-size="sm"
          disabled={props.busy || running || text.trim() === ''}
          onClick={() => {
            setRunning(true)
            void Promise.resolve(props.onRegenerate(text)).finally(() => setRunning(false))
          }}
        >
          {running ? '已提交，生成中…（约 1–3 分钟）' : '↻ 用这段提示词重新生成'}
        </button>
        {dirty && <span className="vr-hint">{tt('promptEdited')}</span>}
      </div>
    </details>
  )
}

function StageGenerate(props: StageGenerateProps): JSX.Element {
  const segments = props.run.segments
  return (
    <>
      <StageHeader title={STEP_LABELS.generate} step={props.step} onRun={props.onRun} busy={props.busy} />
      <PromptPreview api={props.api} runId={props.run.id} stage="generate" />
      <p className="vr-hint">{tt('videoSegmentsTip')}</p>
      {segments.length === 0
        ? <Empty text={tt('generationMissing')} />
        : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {segments.map(segment => (
                <div className="vr-seg" key={segment.segmentIndex}>
                  <div className="vr-seg-head">
                    <span className="vr-seg-no">{segment.segmentIndex}</span>
                    <strong style={{ fontSize: 12.5 }}>分镜 {segment.segmentIndex}</strong>
                    {segment.shots !== undefined && <Pill>{segment.shots.join(', ')} 镜</Pill>}
                    <Pill tone={segment.status === 'done' ? 'ok' : segment.status === 'failed' ? 'err' : segment.status === 'running' ? 'brand' : undefined}>
                      {segment.status === 'done' ? '完成' : segment.status === 'failed' ? '失败' : segment.status === 'running' ? '生成中' : '待生成'}
                    </Pill>
                    {segment.durationSec !== undefined && <Pill>{segment.durationSec.toFixed(1)}s</Pill>}
                    <div className="vr-header-spacer" />
                    <button
                      type="button"
                      className="vr-btn"
                      data-size="sm"
                      disabled={props.busy || segment.status === 'running'}
                      onClick={() => props.onRegenerate(segment.segmentIndex)}
                    >
                      ↻ {tt('regenerate')}
                    </button>
                  </div>
                  {segment.error !== undefined && <div className="vr-banner" data-tone="err">{segment.error}</div>}
                  {segment.file !== undefined && (
                    <video
                      key={`${segment.segmentIndex}-${segment.endedAt ?? segment.startedAt ?? ''}`}
                      className="vr-video"
                      style={{ maxHeight: 340 }}
                      controls
                      preload="metadata"
                      src={mediaUrl(props.run.id, segment.file, { version: segment.endedAt ?? segment.startedAt ?? '' })}
                    />
                  )}
                  {segment.prompt !== undefined && (
                    <SegmentPromptEditor
                      segmentIndex={segment.segmentIndex}
                      prompt={segment.prompt}
                      busy={props.busy || segment.status === 'running'}
                      onRegenerate={prompt => props.onRegenerateWithPrompt(segment.segmentIndex, prompt)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
    </>
  )
}

interface StageComposeProps {
  api: VideoReplicaApi
  run: RunState
  step: StepState
  onRun: () => void
  onAudioSource: (value: 'tts' | 'original') => void
}

interface StagePublishProps {
  api: VideoReplicaApi
  run: RunState
  busy: boolean
  step: StepState
  onRun: () => void
  onCaption: () => Promise<void>
  onPublish: (input: { title: string, description: string, topics: string[] }) => void
}

/** 第七步：一键发布（先只做视频号）。 */
function StagePublish(props: StagePublishProps): JSX.Element {
  const compose = props.run.compose
  const publish = props.run.publish
  const caption = publish?.caption
  const [title, setTitle] = useState(caption?.title ?? publish?.title ?? '')
  const [description, setDescription] = useState(caption?.description ?? publish?.description ?? '')
  const [topics, setTopics] = useState<string[]>(publish?.topics ?? caption?.topics ?? [])
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')
  const askedAuto = useRef(false)
  const seenCaptionAt = useRef<number | undefined>(caption?.at)

  const regenerate = async (): Promise<void> => {
    setGenerating(true)
    setGenError('')
    try {
      await props.onCaption()
    } catch (error) {
      setGenError(error instanceof Error ? error.message : String(error))
    } finally {
      setGenerating(false)
    }
  }

  // 新文案落盘后同步到输入框（用户改过的内容只在重新生成时被覆盖）。
  useEffect(() => {
    if (caption === undefined || caption.at === seenCaptionAt.current) return
    seenCaptionAt.current = caption.at
    setTitle(caption.title)
    setDescription(caption.description)
    setTopics(caption.topics)
  }, [caption?.at])

  // 第一次进入这一步、且还没有文案时，自动生成一版。
  useEffect(() => {
    if (askedAuto.current || compose === undefined || caption !== undefined) return
    askedAuto.current = true
    void regenerate()
  }, [compose === undefined, caption === undefined])

  const running = publish?.status === 'waiting-login' || publish?.status === 'uploading' || publish?.status === 'publishing'
  const ready = description.trim() !== '' && !generating
  return (
    <>
      <StageHeader title={STEP_LABELS.publish} step={props.step} onRun={props.onRun} busy={props.busy} />
      <p className="vr-hint">{tt('publishHint')}</p>
      {compose === undefined
        ? <Empty text={tt('composeMissing')} />
        : (
            <Card title={`${tt('finalVideo')} · ${compose.durationSec.toFixed(1)}s`}>
              <video className="vr-video" style={{ maxHeight: 260 }} controls src={mediaUrl(props.run.id, compose.file, { version: compose.createdAt })} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                <div className="vr-row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="vr-hint">{tt('platform')}：</span>
                  <select className="vr-input" style={{ width: 160 }} value="channels" disabled>
                    <option value="channels">视频号</option>
                  </select>
                  <button type="button" className="vr-btn" data-size="sm" disabled={generating || props.busy} onClick={() => void regenerate()}>
                    {generating ? tt('captionGenerating') : tt('captionRegenerate')}
                  </button>
                </div>
                {genError !== '' && <div className="vr-banner" data-tone="err">{tt('captionFailed')}：{genError}</div>}
                <div className="vr-field">
                  <label className="vr-label">{tt('publishTitle')}</label>
                  <input className="vr-input" value={title} maxLength={16} onChange={event => setTitle(event.target.value)} placeholder={generating ? tt('captionGenerating') : '可留空'} />
                </div>
                <div className="vr-field">
                  <label className="vr-label">{tt('publishTopics')}</label>
                  <div className="vr-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {topics.length === 0 && <span className="vr-hint">{generating ? tt('captionGenerating') : '—'}</span>}
                    {topics.map(topic => (
                      <span key={topic} className="vr-pill">
                        #{topic}
                        <button
                          type="button"
                          className="vr-pill-x"
                          aria-label={`remove ${topic}`}
                          onClick={() => setTopics(current => current.filter(item => item !== topic))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <span className="vr-hint">{tt('captionHint')}</span>
                </div>
                <div className="vr-field">
                  <label className="vr-label">{tt('publishDesc')}</label>
                  <textarea className="vr-textarea" rows={4} value={description} onChange={event => setDescription(event.target.value)} />
                  <span className="vr-hint">{tt('publishDescHint')}</span>
                </div>
                <div className="vr-row" style={{ gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="vr-btn"
                    data-variant="primary"
                    disabled={props.busy || running || !ready}
                    onClick={() => props.onPublish({ title: title.trim(), description: description.trim(), topics })}
                  >
                    {running ? `${publish?.status === 'waiting-login' ? '等待扫码登录…' : publish?.status === 'uploading' ? '上传中…' : '发表中…'}` : tt('publishNow')}
                  </button>
                  {publish !== undefined && <span className="vr-hint">{publish.message}</span>}
                </div>
              </div>
            </Card>
          )}
      {publish !== undefined && (
        <Card title={tt('publishStatus')}>
          <div className="vr-kv"><span>{tt('status')}</span><span>{publish.status}</span></div>
          {publish.postUrl !== undefined && publish.postUrl !== '' && (
            <div className="vr-kv"><span>{tt('publishedUrl')}</span><span><a href={publish.postUrl} target="_blank" rel="noopener">{publish.postUrl}</a></span></div>
          )}
          {publish.error !== undefined && <div className="vr-banner" data-tone="err">{publish.error}</div>}
          {publish.screenshot !== undefined && (
            <div style={{ marginTop: 8 }}>
              <div className="vr-hint">{tt('publishScreenshot')}</div>
              <img src={mediaUrl(props.run.id, publish.screenshot)} alt="publish" style={{ maxWidth: '100%', borderRadius: 10 }} loading="lazy" />
            </div>
          )}
        </Card>
      )}
    </>
  )
}

function StageCompose(props: StageComposeProps): JSX.Element {
  const compose = props.run.compose
  return (
    <>
      <StageHeader title={STEP_LABELS.compose} step={props.step} onRun={props.onRun} />
      <div className="vr-row" style={{ gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
        <span className="vr-hint">{tt('audioSource')}：</span>
        {(['tts', 'original'] as const).map(value => {
          const active = (props.run.audioSource ?? 'tts') === value
          return (
            <button
              key={value}
              type="button"
              className="vr-btn"
              data-size="sm"
              data-variant={active ? 'primary' : 'default'}
              onClick={() => props.onAudioSource(value)}
            >
              {value === 'tts' ? tt('audioTts') : tt('audioOriginal')}
            </button>
          )
        })}
        <span className="vr-hint">{tt('audioSourceHint')}</span>
      </div>
      {compose === undefined
        ? <Empty text={tt('composeMissing')} />
        : (
            <Card
              title={tt('finalVideo')}
              actions={(
                <a className="vr-btn" href={mediaUrl(props.run.id, compose.file, { download: true, version: compose.createdAt })} download>
                  {tt('download')}
                </a>
              )}
            >
              <video key={compose.createdAt} className="vr-video" controls src={mediaUrl(props.run.id, compose.file, { version: compose.createdAt })} />
              <div className="vr-inline">
                <Pill tone="ok">{compose.durationSec.toFixed(1)}s</Pill>
                <Pill>{compose.width}×{compose.height}</Pill>
                <Pill tone={compose.hasAudio ? 'ok' : 'warn'}>{compose.hasAudio ? tt('withAudio') : tt('withoutAudio')}</Pill>
                {compose.burnedSubtitles && <Pill tone="brand">{tt('burnedSubtitles')}</Pill>}
                {compose.bgm && <Pill>BGM</Pill>}
              </div>
            </Card>
          )}
    </>
  )
}

/** 供设置页复用的配置类型别名。 */
export type WorkbenchConfig = PluginConfig
