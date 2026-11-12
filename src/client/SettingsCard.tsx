/**
 * 设置页：接进 DSH 设置对话框左侧导航的「视频复刻」一页。
 *
 * 每一步都可以二选一：
 * - **DSH 已配置模型**：直接选「设置 → 模型」里已经配好的提供商与模型，
 *   密钥与接口地址由宿主从 DSH 配置里读取，这里不再重复填写；
 * - **手动填写接口**：自己填接口地址 / API Key / 模型名（第三方网关、自建服务）。
 *
 * 另加本地工具（ffmpeg / ffprobe / yt-dlp）与合成参数。密钥回读一律是掩码，
 * 留空即保持原值。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ConfigView,
  DshModelCatalog,
  DshProviderOption,
  EndpointConfig,
  ModelSource,
  PluginConfig,
} from '../shared/types.ts'
import { CONFIG_SAVED_EVENT, SECRET_MASK } from '../shared/protocol.ts'
import { VideoReplicaApi } from './api.ts'
import { tt } from './locales.ts'

type Stage = 'parser' | 'analyze' | 'rewrite' | 'image' | 'video' | 'tts' | 'asr'

const PROTOCOL_LABELS: Record<string, string> = {
  'parser-json': '解析服务（JSON）',
  chat: '聊天补全（Chat）',
  'openai-images': 'OpenAI 图片',
  'ark-seedance': '火山方舟 Seedance',
  'openai-video': 'OpenAI 视频',
  'openai-tts': 'OpenAI TTS',
  'chat-tts': '聊天接口返回音频',
  'volc-tts': '火山豆包语音（TTS）',
  'chat-asr': '聊天接口语音识别',
  'openai-transcription': 'OpenAI Whisper',
  'volc-asr': '火山豆包语音识别（ASR）',
}

function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol] === undefined ? protocol : `${PROTOCOL_LABELS[protocol]}（${protocol}）`
}

const PROTOCOLS: Record<Stage, string[]> = {
  parser: ['parser-json'],
  analyze: ['chat'],
  rewrite: ['chat'],
  image: ['openai-images'],
  video: ['ark-seedance', 'openai-video'],
  tts: ['openai-tts', 'chat-tts', 'volc-tts'],
  asr: ['chat-asr', 'openai-transcription', 'volc-asr'],
}

/** 这一步产出的媒体类型决定 DSH 选择器里的提示。 */
const STAGE_NEEDS: Record<Stage, { image?: boolean, route?: boolean }> = {
  parser: {},
  analyze: { image: true },
  rewrite: {},
  image: { route: true },
  video: { route: true },
  tts: { route: true },
  asr: { route: true },
}

interface StageMeta {
  key: Stage
  title: string
  desc: string
}

const STAGES: StageMeta[] = [
  { key: 'parser', title: tt('parserSection'), desc: '第三方解析服务的接口地址与 Key（HoxHox / RedFox / 兼容网关均可）。不填时自动改用 yt-dlp 或直链。' },
  { key: 'analyze', title: tt('analyzeSection'), desc: '视觉模型：均匀抽帧后逐镜拆解。可以用 DSH 里已配置的视觉模型，也可以手填网关。' },
  { key: 'rewrite', title: tt('rewriteSection'), desc: '文本模型：根据拆解结果仿写 A/B/C 三版分镜脚本。' },
  { key: 'image', title: tt('imageSection'), desc: '图像模型：把产品图融入每个分镜的关键帧（image-to-image）。' },
  { key: 'video', title: tt('videoSection'), desc: '视频模型：按「≤5 镜 / ≤15 秒」生成分镜视频，支持火山方舟 Seedance 与通用 OpenAI 视频接口。' },
  { key: 'tts', title: tt('ttsSection'), desc: '配音模型：合成口播音轨。留空则沿用分镜视频自带的音频。' },
  { key: 'asr', title: tt('asrSection'), desc: '语音识别：把源视频音轨转成口播文稿，显著提升仿写还原度。' },
]

function Field(props: { label: string, hint?: string, children: React.ReactNode }): JSX.Element {
  return (
    <label className="vr-field">
      <span className="vr-label">{props.label}</span>
      {props.children}
      {props.hint !== undefined && props.hint !== '' && <span className="vr-hint">{props.hint}</span>}
    </label>
  )
}

function Section(props: { title: string, desc?: string, children: React.ReactNode, extra?: React.ReactNode }): JSX.Element {
  return (
    <section className="vr-card">
      <header className="vr-card-head">
        <h3 className="vr-card-title">{props.title}</h3>
        {props.extra}
      </header>
      {props.desc !== undefined && props.desc !== '' && <p className="vr-hint">{props.desc}</p>}
      {props.children}
    </section>
  )
}

/** 模型来源切换：DSH 已配置模型 / 手动填写接口。 */
function SourceTabs(props: { value: ModelSource, onChange: (next: ModelSource) => void }): JSX.Element {
  return (
    <div className="vr-tabs" style={{ alignSelf: 'flex-start' }}>
      <button
        type="button"
        className="vr-tab"
        {...(props.value === 'dsh' ? { 'data-active': '' } : {})}
        onClick={() => props.onChange('dsh')}
      >
        {tt('sourceDsh')}
      </button>
      <button
        type="button"
        className="vr-tab"
        {...(props.value === 'custom' ? { 'data-active': '' } : {})}
        onClick={() => props.onChange('custom')}
      >
        {tt('sourceCustom')}
      </button>
    </div>
  )
}

/** 从目录里挑一个合理的默认选择（优先 DSH 默认模型）。 */
function pickDefault(catalog: DshModelCatalog | undefined, needsImage: boolean): { dshProvider?: string, dshModel?: string } {
  if (catalog === undefined) return {}
  const supportsImage = (provider: DshProviderOption): boolean =>
    provider.models.some(model => model.modalities.length === 0 || model.modalities.includes('image'))
  const usable = catalog.providers.filter(provider => provider.models.length > 0)

  const preferred = catalog.default
  if (preferred !== undefined) {
    const provider = usable.find(item => item.id === preferred.provider)
    if (provider !== undefined && provider.models.some(model => model.id === preferred.model)) {
      return { dshProvider: preferred.provider, dshModel: preferred.model }
    }
  }
  const provider = (needsImage ? usable.find(supportsImage) : usable[0]) ?? usable[0]
  if (provider === undefined) return {}
  const model = provider.models.find(item => item.modalities.length === 0 || item.modalities.includes('image')) ?? provider.models[0]
  return { dshProvider: provider.id, dshModel: model?.id ?? '' }
}

/** DSH 已配置模型的提供商 / 模型选择器。 */
function DshModelPicker(props: {
  value: EndpointConfig
  catalog: DshModelCatalog | undefined
  loading: boolean
  error: string | undefined
  needImage: boolean
  needRoute: boolean
  onChange: (patch: Partial<EndpointConfig>) => void
  onRefresh: () => void
}): JSX.Element {
  const providers = props.catalog?.providers ?? []
  const selected = providers.find(provider => provider.id === props.value.dshProvider)
  const models = selected?.models ?? []
  const model = models.find(item => item.id === props.value.dshModel)

  const routeWarning = props.needRoute && selected !== undefined && !selected.routeReady
  const visionWarning = props.needImage && model !== undefined
    && model.modalities.length > 0 && !model.modalities.includes('image')

  return (
    <>
      <div className="vr-grid-2">
        <Field label={tt('providerLabel')} hint={selected === undefined ? undefined : selected.name}>
          <select
            className="vr-select"
            value={props.value.dshProvider}
            disabled={providers.length === 0}
            onChange={event => {
              const provider = providers.find(item => item.id === event.target.value)
              const nextModel = provider?.models.find(item => item.modalities.length === 0 || item.modalities.includes('image'))
                ?? provider?.models[0]
              props.onChange({ dshProvider: event.target.value, dshModel: nextModel?.id ?? '' })
            }}
          >
            {providers.length === 0 && <option value="">{tt('noDshModels')}</option>}
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>
                {provider.name}（{provider.models.length} 模型）
              </option>
            ))}
          </select>
        </Field>
        <Field label={tt('modelName')} hint={model === undefined ? undefined : model.name}>
          <select
            className="vr-select"
            value={props.value.dshModel}
            disabled={models.length === 0}
            onChange={event => props.onChange({ dshModel: event.target.value })}
          >
            {models.length === 0 && <option value="">—</option>}
            {models.map(item => (
              <option key={item.id} value={item.id}>{item.id}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="vr-inline">
        <button type="button" className="vr-btn" data-size="sm" onClick={props.onRefresh} disabled={props.loading}>
          {props.loading ? tt('modelsLoading') : tt('refreshModels')}
        </button>
        {props.catalog?.default !== undefined && (
          <button
            type="button"
            className="vr-btn"
            data-size="sm"
            onClick={() => props.onChange({
              dshProvider: props.catalog?.default?.provider ?? '',
              dshModel: props.catalog?.default?.model ?? '',
            })}
          >
            {tt('useDefaultModel')}
          </button>
        )}
        <span className="vr-hint">{tt('sourceHint')}</span>
      </div>
      {props.error !== undefined && <div className="vr-banner" data-tone="err">{props.error}</div>}
      {(props.catalog?.errors ?? []).map(message => (
        <div className="vr-banner" key={message}>{message}</div>
      ))}
      {routeWarning && <div className="vr-banner">{tt('dshNoRoute')}</div>}
      {visionWarning && <div className="vr-banner">{tt('dshVisionHint')}</div>}
      {selected?.error !== undefined && <div className="vr-banner">模型列表读取失败：{selected.error}</div>}
    </>
  )
}

/** 一步的通用端点字段（手动填写接口）。 */
function EndpointFields(props: {
  value: PluginConfig[Stage] & { apiKey: string }
  protocols: string[]
  /** 解析接口没有模型概念，隐藏模型输入框。 */
  showModel?: boolean
  onChange: (patch: Record<string, unknown>) => void
  onTest: () => void
  testing: boolean
  testResult: string | undefined
}): JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const value = props.value as unknown as Record<string, unknown>
  return (
    <>
      <div className="vr-grid-2">
        <Field label={tt('apiUrl')}>
          <input
            className="vr-input"
            value={String(value.apiUrl ?? '')}
            placeholder="https://api.example.com/v1"
            onChange={event => props.onChange({ apiUrl: event.target.value })}
          />
        </Field>
        <Field label={tt('apiKey')} hint={String(value.apiKey ?? '') === '' ? tt('apiKeyUnset') : tt('apiKeySet')}>
          <input
            className="vr-input"
            type="password"
            value={String(value.apiKey ?? '')}
            placeholder={SECRET_MASK}
            onChange={event => props.onChange({ apiKey: event.target.value })}
          />
        </Field>
        {props.showModel === false ? null : (
          <Field label={tt('modelName')}>
            <input
              className="vr-input"
              value={String(value.model ?? '')}
              placeholder="gpt-4o / doubao-seedance-2-0 / …"
              onChange={event => props.onChange({ model: event.target.value })}
            />
          </Field>
        )}
        <Field label={tt('protocol')}>
          <select
            className="vr-select"
            value={String(value.protocol ?? props.protocols[0])}
            onChange={event => props.onChange({ protocol: event.target.value })}
          >
            {props.protocols.map(protocol => <option key={protocol} value={protocol}>{protocolLabel(protocol)}</option>)}
          </select>
        </Field>
      </div>
      <div className="vr-inline">
        <button type="button" className="vr-btn" data-size="sm" onClick={() => setShowAdvanced(current => !current)}>
          {showAdvanced ? '收起高级' : '高级选项'}
        </button>
        <button type="button" className="vr-btn" data-size="sm" onClick={props.onTest} disabled={props.testing}>
          {props.testing ? tt('testing') : tt('test')}
        </button>
        {props.testResult !== undefined && (
          <span className="vr-hint" style={{ color: props.testResult.startsWith('✓') ? undefined : 'var(--dsw-alias-state-error-primary)' }}>
            {props.testResult}
          </span>
        )}
      </div>
      {showAdvanced && (
        <div className="vr-grid-2">
          <Field label={tt('timeout')}>
            <input
              className="vr-input"
              type="number"
              min={5}
              max={3600}
              value={Number(value.timeoutSec ?? 120)}
              onChange={event => props.onChange({ timeoutSec: Number(event.target.value) })}
            />
          </Field>
          <Field label={tt('extraJson')} hint='例如 {"watermark":false,"generate_audio":true}'>
            <input
              className="vr-input"
              value={String(value.extraJson ?? '')}
              onChange={event => props.onChange({ extraJson: event.target.value })}
            />
          </Field>
        </div>
      )}
    </>
  )
}

export function VideoReplicaSettingsSection(): JSX.Element {
  const [api] = useState(() => new VideoReplicaApi())
  const [view, setView] = useState<ConfigView | undefined>(undefined)
  const [draft, setDraft] = useState<PluginConfig | undefined>(undefined)
  const [catalog, setCatalog] = useState<DshModelCatalog | undefined>(undefined)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [testing, setTesting] = useState<string | undefined>(undefined)
  const [testResults, setTestResults] = useState<Record<string, string>>({})

  const loadModels = useCallback(async (force = false) => {
    setCatalogLoading(true)
    try {
      const next = await api.models(force)
      setCatalog(next)
      setCatalogError(undefined)
    } catch (cause) {
      setCatalogError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCatalogLoading(false)
    }
  }, [api])

  const load = useCallback(async () => {
    try {
      const next = await api.config()
      setView(next)
      setDraft(structuredClone(next.config))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    await loadModels()
  }, [api, loadModels])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback((stage: Stage | 'media' | 'compose' | 'root', values: Record<string, unknown>) => {
    setDraft(current => {
      if (current === undefined) return current
      const next = structuredClone(current) as unknown as Record<string, unknown>
      if (stage === 'root') {
        Object.assign(next, values)
      } else {
        const section = { ...(next[stage] as Record<string, unknown>) }
        Object.assign(section, values)
        next[stage] = section
      }
      return next as unknown as PluginConfig
    })
    setStatus('idle')
  }, [])

  /** 切换来源：切到 DSH 时顺手挑一个默认模型，省一步点击。 */
  const changeSource = useCallback((stage: Stage, source: ModelSource) => {
    const current = draft?.[stage] as EndpointConfig | undefined
    if (source === 'custom') {
      patch(stage, { source })
      return
    }
    // 老配置里可能没有这两个字段，按「空」处理，否则会跳过一次自动选择。
    const hasSelection = (current?.dshProvider ?? '').trim() !== '' && (current?.dshModel ?? '').trim() !== ''
    if (hasSelection) {
      patch(stage, { source })
      return
    }
    patch(stage, { source, ...pickDefault(catalog, STAGE_NEEDS[stage].image === true) })
  }, [catalog, draft, patch])

  const save = useCallback(async () => {
    if (draft === undefined) return
    setStatus('saving')
    try {
      const next = await api.saveConfig(draft)
      setView(next)
      setDraft(structuredClone(next.config))
      setStatus('saved')
      setError(undefined)
      // 工作台是常驻挂载的，通知它立刻重读配置（否则旧提示会留在界面上）。
      try {
        window.dispatchEvent(new CustomEvent(CONFIG_SAVED_EVENT))
      } catch {
        // 事件派发失败不影响保存结果
      }
    } catch (cause) {
      setStatus('idle')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, draft])

  const test = useCallback(async (stage: Stage) => {
    setTesting(stage)
    try {
      const result = await (stage === 'parser' ? api.testStage('parse', {}) : api.testStage(stage))
      setTestResults(current => ({ ...current, [stage]: `${result.ok ? '✓' : '✗'} ${result.detail}（${result.elapsedMs}ms）` }))
    } catch (cause) {
      setTestResults(current => ({ ...current, [stage]: `✗ ${cause instanceof Error ? cause.message : String(cause)}` }))
    } finally {
      setTesting(undefined)
    }
  }, [api])

  const dshAvailable = useMemo(() => (catalog?.providers ?? []).some(provider => provider.models.length > 0), [catalog])

  if (draft === undefined || view === undefined) {
    return (
      <div className="vr-settings">
        {error === undefined ? <p className="vr-hint">{tt('loading')}</p> : <div className="vr-banner" data-tone="err">{error}</div>}
      </div>
    )
  }

  const endpoint = (stage: Stage): PluginConfig[Stage] & { apiKey: string } =>
    draft[stage] as PluginConfig[Stage] & { apiKey: string }

  /** 一步的模型来源 + 字段。 */
  const stageBody = (stage: Stage): JSX.Element => {
    const value = endpoint(stage)
    const needs = STAGE_NEEDS[stage]
    if (value.source === 'dsh') {
      return (
        <DshModelPicker
          value={value}
          catalog={catalog}
          loading={catalogLoading}
          error={catalogError}
          needImage={needs.image === true}
          needRoute={needs.route === true}
          onChange={values => patch(stage, values)}
          onRefresh={() => void loadModels(true)}
        />
      )
    }
    return (
      <EndpointFields
        value={value}
        protocols={PROTOCOLS[stage]}
        {...(stage === 'parser' ? { showModel: false } : {})}
        onChange={values => patch(stage, values)}
        onTest={() => void test(stage)}
        testing={testing === stage}
        testResult={testResults[stage]}
      />
    )
  }

  return (
    <div className="vr-settings">
      <div>
        <h2 className="vr-h1" style={{ marginBottom: 4 }}>{tt('settingsTitle')}</h2>
        <p className="vr-hint">{tt('settingsDesc')}</p>
      </div>

      {error !== undefined && <div className="vr-banner" data-tone="err">{error}</div>}

      <Section title={tt('envStatus')} desc={`${tt('dataDir')}：${view.dataDir}`}>
        <div className="vr-inline">
          <span className="vr-pill" data-tone={view.ffmpegAvailable ? 'ok' : 'err'}>ffmpeg {view.ffmpegAvailable ? tt('toolOk') : tt('toolMissing')}</span>
          <span className="vr-pill" data-tone={view.ffprobeAvailable ? 'ok' : 'err'}>ffprobe {view.ffprobeAvailable ? tt('toolOk') : tt('toolMissing')}</span>
          <span className="vr-pill" data-tone={view.ytDlpAvailable ? 'ok' : 'err'}>yt-dlp {view.ytDlpAvailable ? tt('toolOk') : tt('toolMissing')}</span>
          <span className="vr-pill" data-tone={dshAvailable ? 'ok' : 'warn'}>
            {dshAvailable
              ? `DSH 已配置模型：${(catalog?.providers ?? []).filter(provider => provider.models.length > 0).length} 个提供商`
              : tt('noDshModels')}
          </span>
          <button type="button" className="vr-btn" data-size="sm" onClick={() => void loadModels(true)} disabled={catalogLoading}>
            {catalogLoading ? tt('modelsLoading') : tt('refreshModels')}
          </button>
        </div>
        <div className="vr-grid-2">
          <Field label={tt('ffmpegPath')}>
            <input className="vr-input" value={draft.media.ffmpegPath} onChange={event => patch('media', { ffmpegPath: event.target.value })} />
          </Field>
          <Field label={tt('ffprobePath')}>
            <input className="vr-input" value={draft.media.ffprobePath} onChange={event => patch('media', { ffprobePath: event.target.value })} />
          </Field>
          <Field label={tt('ytDlpPath')}>
            <input className="vr-input" value={draft.media.ytDlpPath} onChange={event => patch('media', { ytDlpPath: event.target.value })} />
          </Field>
          <Field label={tt('dataDir')} hint="留空使用 ~/.dsh/storages/dsh-video-replica">
            <input className="vr-input" value={draft.dataDir} onChange={event => patch('root', { dataDir: event.target.value })} />
          </Field>
        </div>
      </Section>

      <Section title={STAGES[0]!.title} desc={STAGES[0]!.desc}>
        <EndpointFields
          value={endpoint('parser')}
          protocols={PROTOCOLS.parser}
          showModel={false}
          onChange={values => patch('parser', values)}
          onTest={() => void test('parser')}
          testing={testing === 'parser'}
          testResult={testResults.parser}
        />
        <div className="vr-grid-2">
          <Field label={tt('parserMode')} hint="auto：直链 → 解析接口 → yt-dlp 依次尝试">
            <select
              className="vr-select"
              value={draft.parser.mode}
              onChange={event => patch('parser', { mode: event.target.value })}
            >
              <option value="auto">auto</option>
              <option value="api">仅解析接口</option>
              <option value="ytdlp">仅 yt-dlp</option>
              <option value="upload">仅本地上传</option>
            </select>
          </Field>
          <Field label={tt('videoUrlPath')} hint="留空自动识别，例如 data.videoUrl">
            <input
              className="vr-input"
              value={draft.parser.videoUrlPath ?? ''}
              onChange={event => patch('parser', { videoUrlPath: event.target.value })}
            />
          </Field>
          <Field label={tt('fallbackApiUrl')} hint="主接口失败时自动切过去；不同服务商的抖音通道经常各自挂">
            <input
              className="vr-input"
              value={draft.parser.fallbackApiUrl ?? ''}
              placeholder="https://redfox.hk/story/api/parseWork/parse"
              onChange={event => patch('parser', { fallbackApiUrl: event.target.value })}
            />
          </Field>
          <Field label={tt('fallbackApiKey')} hint={(draft.parser.fallbackApiKey ?? '') === '' ? tt('apiKeyUnset') : tt('apiKeySet')}>
            <input
              className="vr-input"
              type="password"
              value={draft.parser.fallbackApiKey ?? ''}
              placeholder={SECRET_MASK}
              onChange={event => patch('parser', { fallbackApiKey: event.target.value })}
            />
          </Field>
          <Field label={tt('browserCookies')} hint="抖音现在通常需要 cookie；选一个你打开过抖音的浏览器">
            <select
              className="vr-select"
              value={draft.parser.cookiesFromBrowser ?? ''}
              onChange={event => patch('parser', { cookiesFromBrowser: event.target.value })}
            >
              <option value="">不读取</option>
              <option value="edge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
              <option value="firefox">Firefox</option>
              <option value="brave">Brave</option>
            </select>
          </Field>
        </div>
      </Section>

      {STAGES.slice(1).map(meta => (
        <Section
          key={meta.key}
          title={meta.title}
          desc={meta.desc}
          extra={endpoint(meta.key).source === 'dsh' ? (
            <button type="button" className="vr-btn" data-size="sm" onClick={() => void test(meta.key)} disabled={testing === meta.key}>
              {testing === meta.key ? tt('testing') : tt('test')}
            </button>
          ) : undefined}
        >
          <SourceTabs value={endpoint(meta.key).source} onChange={next => changeSource(meta.key, next)} />
          <p className="vr-hint" data-testid={`active-${meta.key}`}>
            {endpoint(meta.key).source === 'dsh'
              ? `${tt('activeDsh')}：${(endpoint(meta.key).dshProvider ?? '').trim() || '—'} / ${(endpoint(meta.key).dshModel ?? '').trim() || tt('activeUnset')}`
              : `${tt('activeCustom')}：${(endpoint(meta.key).model ?? '').trim() || tt('activeUnset')}${(endpoint(meta.key).apiUrl ?? '').trim() === '' ? '' : ` @ ${(endpoint(meta.key).apiUrl ?? '').trim()}`}`}
          </p>
          {endpoint(meta.key).source === 'dsh' && <p className="vr-hint">{tt('dshAutoProtocol')}</p>}
          {stageBody(meta.key)}
          {endpoint(meta.key).source === 'dsh' && testResults[meta.key] !== undefined && (
            <span className="vr-hint">{testResults[meta.key]}</span>
          )}

          {meta.key === 'image' && (
            <p className="vr-hint">{tt('arkImageHint')}</p>
          )}
          {meta.key === 'image' && (
            <Field label={tt('productMode')} hint={tt('productModeHint')}>
              <select
                className="vr-select"
                value={draft.imageProductMode}
                onChange={event => setDraft({ ...draft, imageProductMode: event.target.value as typeof draft.imageProductMode })}
              >
                <option value="auto">{tt('productModeAuto')}</option>
                <option value="reference">{tt('productModeReference')}</option>
                <option value="text">{tt('productModeText')}</option>
              </select>
            </Field>
          )}
          {meta.key === 'image' && (
            <Field label={tt('frameStyle')} hint={tt('frameStyleHint')}>
              <select
                className="vr-select"
                value={draft.imageFrameStyle}
                onChange={event => setDraft({ ...draft, imageFrameStyle: event.target.value as typeof draft.imageFrameStyle })}
              >
                <option value="photo">{tt('frameStylePhoto')}</option>
                <option value="cartoon">{tt('frameStyleCartoon')}</option>
                <option value="illustration">{tt('frameStyleIllustration')}</option>
              </select>
            </Field>
          )}
          {meta.key === 'rewrite' && (
            <Field label={tt('rewriteMode')} hint={tt('rewriteModeHint')}>
              <select
                className="vr-select"
                value={draft.rewriteMode}
                onChange={event => setDraft({ ...draft, rewriteMode: event.target.value as typeof draft.rewriteMode })}
              >
                <option value="redesign">{tt('rewriteRedesign')}</option>
                <option value="faithful">{tt('rewriteFaithful')}</option>
              </select>
            </Field>
          )}
          {meta.key === 'analyze' && (
            <div className="vr-grid-2">
              <Field label={tt('frameCount')}>
                <input
                  className="vr-input"
                  type="number"
                  min={3}
                  max={24}
                  value={draft.analyze.frameCount}
                  onChange={event => patch('analyze', { frameCount: Number(event.target.value) })}
                />
              </Field>
              <Field label={tt('maxFrameSide')}>
                <input
                  className="vr-input"
                  type="number"
                  min={256}
                  max={2048}
                  value={draft.analyze.maxFrameSide}
                  onChange={event => patch('analyze', { maxFrameSide: Number(event.target.value) })}
                />
              </Field>
            </div>
          )}

          {meta.key === 'video' && (
            <div className="vr-grid-2">
              <Field label={tt('secondsPerSegment')} hint="多数模型支持 5 / 10 秒">
                <input
                  className="vr-input"
                  type="number"
                  min={2}
                  max={30}
                  value={draft.video.secondsPerSegment}
                  onChange={event => patch('video', { secondsPerSegment: Number(event.target.value) })}
                />
              </Field>
              <Field label={tt('size')} hint="720x1280 / 1080x1920 / 9:16">
                <input className="vr-input" value={draft.video.size} onChange={event => patch('video', { size: event.target.value })} />
              </Field>
              <Field label={tt('pollSec')}>
                <input
                  className="vr-input"
                  type="number"
                  min={1}
                  max={60}
                  value={draft.video.pollSec}
                  onChange={event => patch('video', { pollSec: Number(event.target.value) })}
                />
              </Field>
              <Field label={tt('concurrency')}>
                <input
                  className="vr-input"
                  type="number"
                  min={1}
                  max={8}
                  value={draft.video.concurrency}
                  onChange={event => patch('video', { concurrency: Number(event.target.value) })}
                />
              </Field>
            </div>
          )}

          {meta.key === 'tts' && (
            <>
              <label className="vr-switch">
                <input type="checkbox" checked={draft.tts.enabled} onChange={event => patch('tts', { enabled: event.target.checked })} />
                {tt('enabled')}
              </label>
              <div className="vr-grid-2">
                <Field label={tt('voice')}>
                  <input className="vr-input" value={draft.tts.voice} onChange={event => patch('tts', { voice: event.target.value })} />
                </Field>
                <Field label={tt('voiceAlt')}>
                  <input
                    className="vr-input"
                    value={draft.tts.voiceAlt}
                    placeholder="留空则所有角色同一音色"
                    onChange={event => patch('tts', { voiceAlt: event.target.value })}
                  />
                </Field>
                <Field label={tt('speed')}>
                  <input
                    className="vr-input"
                    type="number"
                    step={0.05}
                    min={0.5}
                    max={2}
                    value={draft.tts.speed}
                    onChange={event => patch('tts', { speed: Number(event.target.value) })}
                  />
                </Field>
              </div>
            </>
          )}

          {meta.key === 'asr' && (
            <>
              <label className="vr-switch">
                <input type="checkbox" checked={draft.asr.enabled} onChange={event => patch('asr', { enabled: event.target.checked })} />
                {tt('enabled')}
              </label>
              <Field label={tt('language')} hint="zh / en；留空自动识别">
                <input className="vr-input" value={draft.asr.language} onChange={event => patch('asr', { language: event.target.value })} />
              </Field>
            </>
          )}
        </Section>
      ))}

      <Section title={tt('composeSection')}>
        <div className="vr-grid-2">
          <Field label={tt('size')} hint="留空沿用源片/分镜尺寸">
            <input className="vr-input" value={draft.compose.size} onChange={event => patch('compose', { size: event.target.value })} />
          </Field>
          <Field label={tt('fps')}>
            <input
              className="vr-input"
              type="number"
              min={12}
              max={60}
              value={draft.compose.fps}
              onChange={event => patch('compose', { fps: Number(event.target.value) })}
            />
          </Field>
          <Field label={tt('subtitleFontSize')}>
            <input
              className="vr-input"
              type="number"
              min={8}
              max={40}
              value={draft.compose.subtitleFontSize}
              onChange={event => patch('compose', { subtitleFontSize: Number(event.target.value) })}
            />
          </Field>
          <Field label={tt('bgmVolume')}>
            <input
              className="vr-input"
              type="number"
              step={0.02}
              min={0}
              max={1}
              value={draft.compose.bgmVolume}
              onChange={event => patch('compose', { bgmVolume: Number(event.target.value) })}
            />
          </Field>
          <Field label={tt('bgmPath')} hint="本机 mp3/wav 绝对路径，留空不混 BGM">
            <input className="vr-input" value={draft.compose.bgmPath} onChange={event => patch('compose', { bgmPath: event.target.value })} />
          </Field>
        </div>
        <div className="vr-inline">
          <label className="vr-switch">
            <input type="checkbox" checked={draft.compose.burnSubtitles} onChange={event => patch('compose', { burnSubtitles: event.target.checked })} />
            {tt('burnSubtitlesLabel')}
          </label>
          <label className="vr-switch">
            <input type="checkbox" checked={draft.enabled} onChange={event => patch('root', { enabled: event.target.checked })} />
            启用插件
          </label>
        </div>
      </Section>

      <div className="vr-inline" style={{ position: 'sticky', bottom: 0, padding: '10px 0', background: 'var(--dsw-alias-bg-base)' }}>
        <button type="button" className="vr-btn" data-variant="primary" onClick={() => void save()} disabled={status === 'saving'}>
          {status === 'saving' ? tt('saving') : tt('save')}
        </button>
        {status === 'saved' && <span className="vr-hint">✓ {tt('saved')}</span>}
        <button type="button" className="vr-btn" onClick={() => void load()}>{tt('cancel')}</button>
      </div>
    </div>
  )
}
