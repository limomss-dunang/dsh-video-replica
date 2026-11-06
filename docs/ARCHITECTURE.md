# 架构说明

## 两半结构

| 半边 | 入口 | 运行位置 | 职责 |
|---|---|---|---|
| 宿主 | `src/host/index.ts` → `lib/index.js` | DSH 宿主进程（Node） | 配置读写、运行引擎、六步流水线、模型适配、loopback 桥接路由、系统提示说明 |
| 浏览器 | `src/client/index.tsx` → `lib/client.js` | DSH Web 页面 | 侧边栏入口、中栏三栏工作台、设置页 |

宿主 `apply(ctx, config)` 只硬依赖 `webServer` 服务；`systemPrompt` 可选（缺失时静默跳过）。
浏览器 `apply(ctx)` 硬依赖 `slots`；`locale` 可选。

## 为什么不让 Agent 直接编排六步

六步里有长任务（视频生成单段 1–5 分钟）与大量中间产物。放在宿主进程里跑的好处：

- 关掉页面任务继续跑，刷新页面状态不丢（状态落盘 `run.json`）；
- 视频生成的轮询、断点续传、并发闸门只在一个地方实现；
- Agent 与界面读到的是同一份状态，不会出现「模型以为完成了但文件没落盘」。

## 数据模型

```
~/.dsh/storages/dsh-video-replica/
├── config.json                    配置（含密钥，0600）
└── runs/<runId>/
    ├── run.json                   运行状态：步骤、拆解、脚本、参考图、分镜视频、成片、日志
    ├── source/                    source.mp4（或 upload.mp4）、thumb.jpg
    ├── frames/                    frame-01.jpg（抽帧）、ref-01.png（分镜关键帧）
    ├── products/                  用户上传的产品图
    ├── segments/                  seg-01.mp4 …（分块生成的分镜视频）
    ├── audio/                     tts-01.mp3、tts-01.wav、narration.wav
    ├── subs.ass                   字幕
    ├── merged.mp4                 拼接中间产物
    └── final.mp4                  成片
```

`RunState` 是唯一权威状态（`src/shared/types.ts`）。写入策略：内存持有 + 150ms 去抖 +
串行原子落盘（`run.json.tmp` → rename，Windows 上被占用时降级为直接覆盖）。

## 状态机

```
idle ──start──▶ running ──全部步骤完成──▶ done
                  │
                  ├──某步抛错──▶ failed（失败步骤标记 error，可单步重试或跳过）
                  └──用户停止──▶ stopped
```

- 一个 run 同时只允许一个任务（`Engine.active` 闸门），避免两个步骤同时写 `run.json`。
- 从第 N 步重跑时，第 N 步及之后的步骤状态与产物**一并作废**（`resetFrom`），
  避免新旧数据混在一起（例如改了脚本却还留着旧的关键帧）。
- 换脚本版本 / 编辑分镜同样会作废 `match`、`generate`、`compose` 的下游产物。

## 六步的实现要点

### ① 解析下载

- 平台识别是本地正则，不联网。
- `parser.mode = auto` 的顺序：直链 → 解析接口（已配置时）→ yt-dlp（可用时）；每步失败原因都收集起来。
- 解析响应自动识别 HoxHox（`success`）与 RedFox（`code` 前缀 2）两种形状，也支持自定义点路径。
- 图文/图集会被明确拒绝（`mediaType` / `awemeType` 判断），避免下到一堆图片。
- 下载带大小上限与 1KB 下限（防止把 HTML 错误页当成视频）；ffprobe 探尺寸，ffmpeg 出封面。

### ② AI 拆解

- 均匀抽帧（避开首尾黑场），每帧按最长边缩放后以 base64 `image_url` 传给视觉模型。
- 可选 ASR：ffmpeg 抽 16k 单声道 WAV → `/audio/transcriptions` → 带时间戳的口播稿。
- 一次调用拿到「分镜 + 钩子 + 节奏 + 风格 + DNA + 评分」，程序侧做严格归一化
  （`normalizeAnalysis`）：镜头时间钳制、评分钳 0–10、缺失字段给安全默认值。
- 模型偶尔把秒数当镜号写进 `cutPoints`，归一化时直接过滤非正数，不做索引假设。

### ③ AI 仿写

- 提示词把「结构 / 节奏 / 钩子 / 情绪曲线 / DNA」当硬约束，产品外观锁定到参考图。
- 语音长度约束：`voiceover 汉字数 ≤ duration × 5`（中文口播语速）。
- 归一化时把分镜时长钳到 2–12 秒、修正重叠、清空空段；至少要有 1 个可用版本。

### ④ 参考图匹配

- 每镜一张关键帧，产品图作为参考图传入；产品外观描述（视觉模型识别的一次性结果）写进提示词，
  保证跨镜头一致。
- 单张失败不阻断：失败帧记录 `error`，界面可单张重生成；全部失败才让该步失败。

### ⑤ 生成视频

- 按「≤5 镜 / ≤15 秒」把分镜切成生成块（`buildChunks`），块内首镜的参考图 + 产品图作为输入。
- 提交 → 轮询 → 下载落盘；默认并发 2（`video.concurrency`），避免网关限流。
- 单段失败不影响其它段：可单段「重新生成」，成功后直接进入合成。

### ⑥ 合成成片

- **拼接必须用 concat 滤镜**（不是 concat 解复用器）：不同批次产出的片段采样率、帧率、SAR
  可能不一致，解复用器会按首段参数硬拼导致音画错位。这里一次编码统一 scale+pad+fps。
- 音频策略：
  - 配了 TTS → 逐段配音 → 按段时长补静音/裁剪 → 顺序拼成 `narration.wav` → 合流；
  - 没配 TTS 但分镜自带音轨 → 保留原音轨（可选混 BGM）；
  - 都没有 → 输出无声成片并在界面明示。
- 字幕：文案 100% 来自脚本（口播优先，其次画面大字），按实际分镜时长铺时间轴；
  字号/边距按成片真实高度推导，中文自行按字数均分折行（libass 不给无空格中文断行）。
- 字幕烧录失败时降级为不烧字幕，仍产出成片（不让整条链路失败）。

## DSH 已配置模型的接入

设置里每一步都能二选一：`source: 'dsh'` 用 DSH 已配置的模型，`source: 'custom'` 手填接口。
两者共用同一份运行配置（`EndpointConfig.source / dshProvider / dshModel`）。

| 能力 | 走哪条路 | 实现 |
|---|---|---|
| ② 拆解、③ 仿写（含产品图识别） | DSH 宿主 `llm` 服务 | `DshModels.chat()`：抽帧经 `attachments.saveImages` 变附件，内容块 `{type:'image',attachment}` + `{type:'text'}`，`llm.stream()` 收 `text-delta` 拼成正文；调用前用 `resolveModelInfo` 检查模型是否声明图片输入，给出比上游 400 更清楚的原因 |
| ④ 参考图、⑤ 视频、⑥ 配音、ASR | 复用提供商接口地址 | `DshModels.route()` 从 `configEditor` 的 `llm-pi-ai` 提供商配置读 `baseURL` / `apiKey`（或 `apiKeyEnv` → `credentials.resolve`），再交给本插件已有的 HTTP 适配器；`source=dsh` 时协议锁定为 OpenAI 兼容族 |
| 模型目录（设置页下拉） | `llm.listProviders()` + `llm.listModels(id)` | `GET /api/dsh-video-replica/models`，结果缓存 60 秒，支持 `?refresh=1` 强制刷新；同时列出组合配置里声明但没有适配器的提供商，并用 `routeReady` 标出能否用于媒体请求 |

所有服务都经 **`ctx.get(name)`** 取并逐层 try/catch：Cordis 4 对「未 inject 的服务」取值会抛
`cannot get property "x" without inject`，直接读属性会让插件 fiber 失败、甚至拖垮整个应用启动。
这也是上一轮启动报错的根因，现在的约束是：**新增任何服务访问都必须走 `ctx.get` 并容错**。

风险与降级：宿主没有 `llm`/`attachments` 时，`source=dsh` 的拆解会报「请改用手动填写接口」；
提供商没有 `baseURL` 时，媒体步骤报明确原因；`config/test` 对聊天端点做真实调用、
对媒体端点校验提供商与接口地址。旧配置文件没有 `source` 字段时按 `custom` 处理，升级无感。

## 桥接路由

宿主注册 9 条 exact 路由（**一个路径一条**，GET/POST 在同一个 handler 里分派——
DSH 的 WebServer 把 `(kind, path)` 当成唯一键，重复注册会抛错）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/dsh-video-replica/config` | GET / POST | 读配置（密钥掩码）/ 保存配置 |
| `/api/dsh-video-replica/models` | GET | DSH 已配置的提供商与模型目录（`?refresh=1` 强制刷新） |
| `/api/dsh-video-replica/config/test` | POST | 各步骤连通性测试 |
| `/api/dsh-video-replica/detect` | POST | 本地识别链接平台 |
| `/api/dsh-video-replica/runs` | GET / POST | 运行列表 / 新建运行 |
| `/api/dsh-video-replica/run` | GET | 读取单个运行 + busy 状态 |
| `/api/dsh-video-replica/run/action` | POST | start / step / start-skip / stop / select-variant / update-segments / regenerate-* / remove-product / delete |
| `/api/dsh-video-replica/upload` | POST（原始字节） | 上传本地视频 / 产品图 |
| `/api/dsh-video-replica/media` | GET | 媒体读取，支持 HTTP Range（`<video>` 拖动进度） |
| `/api/dsh-video-replica/media/text` | GET | 读回小文本文件（字幕、报告） |

所有路由先过 `isLoopbackRequest`（回环地址 + 同源 `Origin` + 非 cross-site），
远端浏览器拿不到密钥，也无法触发本机 ffmpeg。

## 界面挂载

- 侧边栏：优先把入口塞进 dsh-imagegen 的标签条（`[data-dsh-imagegen-session-tabs]`）
  或 dsh-commentary 的入口宿主；都没有时自己在「新会话」按钮上方建一个两列入口。
- 中栏：`[data-pane="conversation"]` / `[class*="centerCol"]` 是单占用区，外部插件不能声明
  slot，所以在 DOM 层追加一个容器，用 `<html data-dvr-active>` 隐藏原生会话视图；
  会话子树保持挂载，切回来状态不丢。
- 与其它面板互斥：打开时清掉 imagegen / brainstorm / commentary 的 active 属性，
  并派发 `dsh-panel-activate` 事件；收到别人的激活事件时自动退回会话。
- 样式是一段注入到 `<head>` 的 CSS（随插件卸载移除），颜色全部走宿主主题变量
  `--dsw-alias-*`，明暗主题自动跟随。

## 验证方式

| 测试 | 覆盖 |
|---|---|
| `scripts/smoke-host.mjs` | 真实 ffmpeg + mock 网关跑完整六步；配置读写与掩码；上传；解析接口；Range 播放；目录穿越防护 |
| `scripts/smoke-client.mjs` | jsdom 里加载真实 `lib/client.js`：设置页注册、侧边栏入口位置、中栏接管、工作台渲染、卸载清理 |
| `scripts/preview/shots.py` | Playwright 渲染真实 bundle 的界面截图（`output/preview/`） |
