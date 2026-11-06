# 模型与网关配置

## 方式 A：直接用 DSH 已配置的模型（推荐）

设置页每一步顶部都有「DSH 已配置模型 / 手动填写接口」两个标签。选前者时：

- **② AI 拆解 / ③ AI 仿写**：选提供商 + 模型即可。调用走宿主 `llm` 服务，
  密钥与路由由 DSH 管理；拆解的抽帧图片会作为附件图片块交给模型，
  所以请选支持图片输入的视觉模型（设置页会对未声明图片能力的模型给出提示）。
- **④ 参考图 / ⑤ 视频 / ⑥ 配音 / 语音识别**：这些模态 DSH 没有内置适配器，
  插件会读取该提供商在 DSH 组合配置里的 `baseURL` 与 `apiKey`（没有 `apiKey` 时用
  `apiKeyEnv` 指向的凭据），再用 OpenAI 兼容协议发请求。因此：

| 提供商配置情况 | 能否用于图片/视频/语音 |
|---|---|
| 配了 `baseURL`（并配了 key 或 keyEnv 凭据） | ✅ 可用 |
| 只有内置目录地址、配置里没有 `baseURL` | ❌ 界面提示改用「手动填写接口」 |
| 提供商不存在 / 没有模型 | ❌ 下拉里不会出现或提示刷新 |

「刷新模型」重新探测提供商与模型列表；「用 DSH 默认模型」填入「设置 → 模型」的默认选择。
切换提供商时，模型会自动重选为该提供商下第一个支持图片的模型（拆解）或第一个模型。

## 方式 B：手动填写接口

每一步独立配置「接口地址 + API Key + 模型名 + 协议」，可以指向同一个网关，也可以各用各家。
密钥只存本机；界面里回读是掩码，留空保存表示不修改。

## ① 解析下载（第三方解析服务）

协议 `parser-json`。填服务方给的解析地址与 Key。

- HoxHox 形态：`https://sph.hoxhox.cn/api/parse.php`，响应 `{"success":true,"data":{...}}`
- RedFox 形态：`https://redfox.hk/story/api/parseWork/parse`，响应 `{"code":"200","data":{...}}`

插件会自动识别这两种响应形状；其它网关如果字段名不同，在「视频地址字段路径」里写点路径
（例如 `data.videoUrl`）。

可以再填一个**备用解析接口**（地址 + Key）：主接口返回业务错误、鉴权失败或超时时自动切过去，
失败原因会写进运行日志（例如「主解析接口（sph.hoxhox.cn）：抖音解析服务异常」）。

不填解析接口也能用：

- 抖音 / 快手 / B 站可以直接靠本机 `yt-dlp`（设置里填 yt-dlp 路径，或在 PATH 里）；
- 视频直链直接下载；
- 任何平台都可以「下载视频后上传」。

## ② AI 拆解（视觉模型）

协议 `chat`。任意 OpenAI 兼容、支持 `image_url` 的视觉模型：

| 网关 | 接口地址 | 模型名 |
|---|---|---|
| 小米 MiMo | `https://api.xiaomimimo.com/v1` | `mimo-v2.5` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 通义兼容层 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| 任意聚合网关 | 网关的 `/v1` | 网关模型目录里的视觉模型 |

请求里会带上 `response_format: {"type":"json_object"}`；网关不支持时自动去掉重试一次。
「抽帧数量」默认 12 帧，长视频可调到 16；「单帧最长边」默认 1024，模型对分辨率敏感时再调。

## ③ AI 仿写（文本模型）

协议 `chat`。同上，用文本模型即可（不需要视觉能力）：

- MiMo：`mimo-v2.5-pro`
- OpenAI：`gpt-4.1` / `gpt-4o`
- 其它网关的等价模型

## ④ 参考图匹配（图像模型）

协议 `openai-images`。带参考图时请求体里会带 JSON `image: [dataURL...]`（Seedream 风格）；
如果网关只接受 multipart，插件会自动改用 `/images/edits`。

| 网关 | 接口地址 | 模型名 | 备注 |
|---|---|---|---|
| 火山方舟 Seedream | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-seedream-5-0-260128` | 尺寸自动映射到 2K 档 |
| OpenAI | `https://api.openai.com/v1` | `gpt-image-1` | 走 `/images/generations` |
| 聚合网关 | 网关 `/v1` | 网关目录里的图像模型 | 参考图协议不兼容时用「附加请求参数」补字段 |

## ⑤ AI 生成视频

### `ark-seedance`（火山方舟 Seedance）

- 接口地址：`https://ark.cn-beijing.volces.com/api/v3`
- 模型名：`doubao-seedance-2-0-260128`（mini 版用 `doubao-seedance-2-0-mini-260615`）
- 行为：`POST /contents/generations/tasks` 提交（`content` 数组 + `ratio` + `duration` +
  `resolution` + `generate_audio`），`GET …/tasks/{id}` 轮询，完成后下载落盘。
- 「分辨率 / 画幅」填 `720x1280` 或 `9:16`；`duration` 由插件按分块秒数自动填（≤15）。
- 附加参数示例：`{"watermark":false,"return_last_frame":false}`

### `openai-video`（通用 OpenAI 风格视频任务）

- `POST {base}/videos` 提交，失败自动再试 `/videos/generations`
- `GET {base}/videos/{id}` 轮询（也兼容 `/videos/generations/{id}` 与 `/videos/{id}/content`）
- 请求体：`{model, prompt, size, seconds, input_reference?}`，网关要别的字段就用「附加请求参数」补
- 结果地址从响应里任意 `video_url` / `url` 字段递归识别，也可从 `/content` 直接取二进制

## ⑥ 配音（可选）

- `openai-tts`：`POST {base}/audio/speech`，`{model, input, voice, response_format:'mp3', speed}`
- `chat-tts`：`POST {base}/chat/completions` + `audio:{format,voice}`，取 `choices[0].message.audio.data`（base64 WAV）

不配置配音时：成片沿用分镜视频自带的音轨（大多数视频模型 `generate_audio:true` 时自带配音）。

## 语音识别（可选，强烈建议）

两种协议：

- `chat-asr`（MiMo / 小米 `mimo-v2.5-asr` 等）：`POST {base}/chat/completions`，
  音频作为 `input_audio` 内容块：

  ```json
  {
    "model": "mimo-v2.5-asr",
    "messages": [{"role": "user", "content": [
      {"type": "input_audio", "input_audio": {"data": "data:audio/wav;base64,…"}}
    ]}],
    "asr_options": {"language": "auto"}
  }
  ```

  返回 `choices[0].message.content` 为纯文本（没有时间戳，插件按句子长度铺到时间轴）。

- `openai-transcription`（Whisper 协议）：`POST {base}/audio/transcriptions`
  （multipart，`model` + 音频 + `response_format=verbose_json`）。

选 `openai-transcription` 但网关返回 404/405（没有该端点）时，插件会自动改用 `chat-asr` 再试一次。

配置后拆解会先把源片音轨转成带时间戳的口播稿，仿写还原度明显提升；
不配置时口播稿只能从画面文字推断，界面会明确提示这一点。

## 附加请求参数

「高级选项 → 附加请求参数（JSON）」会原样合并进请求体，用来补网关私有字段，例如：

```json
{"watermark": false, "generate_audio": true, "seed": 1234}
```

解析失败时会被忽略，不会让整次生成失败。


## 火山方舟一个 Key 跑「生图 + 视频」

ARK 的图片生成和视频生成共用同一个 Key 与域名，插件不需要新协议（图片走 `openai-images`）：

| 项 | 图片（Seedream） | 视频（Seedance） |
|---|---|---|
| 接口地址 | `https://ark.cn-beijing.volces.com/api/v3` | 同左 |
| 协议 | `openai-images` | `ark-seedance` |
| 模型 | `doubao-seedream-5-0-260128` / `doubao-seedream-5-0-pro-260628` / `doubao-seedream-5-0-flash-260915` / `doubao-seedream-4-5-251128` | `doubao-seedance-2-0-mini-260615` 等 |

注意事项：

- **尺寸表**：Seedream 5.0 pro/flash 与 lite/4.5 的 2K 尺寸表不同（如 9:16 分别是 `1584x2816` 与 `1600x2848`），插件内置了两套表并按模型自动选择；传错尺寸会 400。
- **参考图**：走 JSON `image: [dataURL...]`，最多 10 张；插件把产品图按这个格式传，不发 `/images/edits`。
- **PrivacyInformation 实测结论**（同一账号连续测试）：

  | 首帧内容 | Seedance 结果 |
  |---|---|
  | Seedream 写实成人（无产品） | ✅ 通过 |
  | Seedream 写实小孩（公园，无产品） | ✅ 通过 |
  | Seedream 写实男孩（砖石路，无产品） | ✅ 通过 |
  | Seedream 写实成人 + 红色方块 | ✅ 通过 |
  | Seedream 写实成人 + 产品瓶 | ❌ PrivacyInformation |
  | Seedream 写实成人 + 产品瓶（远景） | ❌ |
  | Seedream 写实小孩 + 产品瓶 | ❌（两次） |
  | 3D 卡通（猫/小孩 + 产品） | ✅ 通过 |

  即：**写实 AI 人物本身可以过**；高概率被拦的是「写实人物 + 产品」同框。遇到 `PrivacyInformation` 时优先把「首帧画风」切到 3D 卡通/国风插画，或让人物与产品不同框。

  **正确用法（官方「信任模型产物」规则）**：[Seedance 人像素材指南](https://ark.volcengine.com/region:cn-beijing/docs/seedance-portrait-asset-guide#trust-model-output) 规定，方舟只信任三类产物的**人脸**审核：

  | 信任产物 | 生效时间 | 有效期 |
  |---|---|---|
  | Seedance 2.5/2.0 生成的含人脸**视频** | 2026-03-11 起 | 30 天 |
  | 上述视频对应的**尾帧图片** | 2026-04-16 起 | 30 天 |
  | **Seedream 5.0 lite/pro/flash 文生图**得到的含人脸图片 | 2026-04-16 起 | 30 天 |

  限制：仅同账号、仅模型**原始**产物（二次剪辑/压缩/转发都可能失效，建议直接转存 TOS）；只对输入生效，输出仍可能命中审核。

  由此得到关键结论：**「图生图」产物不在信任名单** —— 带产品参考图生成的首帧会被当「疑似真实人物」拦掉，而**不传参考图、纯提示词描述产品的「文生图」首帧可以通过**（本项目实测：成人+产品同框，文生图 ✅ / 图生图 ❌）。

  **插件的两段式做法**（实测可行）：

  1. **首帧用 Seedream 文生图**（不带产品参考图）——产物进入方舟信任名单，人脸可过；
  2. **生视频时把产品图也递给 Seedance**，但注意 role 规则（实测）：
     - `first_frame` + `reference_image` **混用 → 400**：`first/last frame content cannot be mixed with reference media content`；
     - **两张都用 `reference_image`** → 通过。所以产品图（图片1）+ 首帧（图片2）都按 `reference_image` 传。

  其它视频网关（Grok 等）基本只吃一张图，此时只传首帧，产品外观交给提示词里的文字描述。

  设置里的「产品融入方式」控制的是**首帧生成**：`auto`（默认）= 视频为 ark-seedance、画风写实、且图片模型是 Seedream 时，首帧走文生图；其它情况首帧仍带参考图。

  官方文档只写了这一条规则（[创建视频生成任务 API](https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api)）：

  > Seedance 2.5、Seedance 2.0 系列模型不支持直接上传含有真人人脸的参考图 / 视频。
  > 支持使用预置虚拟人像作为输入素材；支持使用已授权真人素材作为输入。
  > 方舟平台信任 Seedance 2.5、Seedance 2.0 系列模型生成的含人脸视频，您可使用本账号下近 30 天内由上述模型生成的含人脸原始视频，作为输入素材进行二次创作。

  文档**没有**解释「人物 + 产品同框」为什么更容易触发，也没有给出判定细则；这部分属于上游审核模型的黑盒行为，「人+产品同框"是高危组合」这是本项目的实测结论，不是官方规则。
- 账号模型权限因账号而异（例如常见账号只有 Seedream 5.0 系列、没有 4.0），模型不存在时 ARK 返回 `InvalidEndpointOrModel.NotFound`。

## 网关字段兼容（实测后加的规则）

| 模态 | 行为 |
|---|---|
| 图片 | 优先请求 `response_format: b64_json`（避免受保护 URL 下载 401）；网关拒绝该参数时自动去掉重试；带参考图被拒时改走 `/images/edits`；上游偶发 502/503 会自动重试 2 次 |
| 视频（成品地址） | 有的网关任务 `completed` 也不返回 URL，成品只在 `GET /videos/{id}/content`，而且 CDN 会晚几秒就绪。插件会重试 6 次并重新拉取任务，仍失败才报错（错误里带任务 id）。 |
| 图片输入体积 | 视频网关对 request body 有上限（Grok 系超限返回 `400 Failed to read request body: length limit exceeded`）。首帧 PNG 常见 2–3MB，插件会在超过 900KB 时用 ffmpeg 转 JPEG 并限制长边 1280 再提交。 |
| 解析接口的时长单位 | 有的网关给毫秒（RedFox 的 `duration: 9000` = 9 秒）。插件会把 >900 的值按毫秒换算，并以 ffprobe 的时长为准。 |
| 视频（上游 503） | 网关报 `生成服务暂时不可用` 时，插件把两个候选端点的错误一起抛出并提示「稍后重试」，不让你误以为是配置问题。 |
| 仿写输出被截断 | 模型输出超长（`max_tokens` 打满）时 JSON 没闭合，插件会自动补齐括号/引号（可能丢最后一条分镜）后重试解析；同时提示词限制「每版最多 8 镜、visualPrompt ≤60 字」。 |
| 视频（Grok Imagine 系） | 用最小字段集 `{model, prompt, duration, size, image?}`。实测多塞 `seconds/num_frames/width/height` 等别名会返回 `internal_error` |
| 视频（其它通用网关） | 一次带上 `size+width/height`、`seconds+duration`、`frame_rate+num_frames`、`image+input_reference` 等别名，多余字段一般被忽略 |
| 配音 | 先发 `/audio/speech`；404/405 时自动切「聊天接口返回音频」形态；音色不被支持时解析报错里的可用音色并自动重试 |
| 语音识别 | `/audio/transcriptions` 404 时明确提示网关不支持该端点，并继续只用画面拆解 |

## 拆解模型怎么选（决定能不能抓住「核心创意」）

爆款复刻的上游是**理解**：拆解要能说出「这条片子真正在做什么」以及「哪一条手法可以迁移」。
实测同一条视频号（AI 做短剧翻车，2 分钟，含大量中文多义词梗）：

| 拆解模型 | 结果 |
|---|---|
| `dimexplore / glm-5v-turbo`（12 帧） | 只抓到元素级：`AI幻觉/橘猫替身/猪乱入`，仿写只能换题材重拍（AI 做饭、AI 装修） |
| `yezi-gemini / gemini-3.1-pro-preview`（长视频自动 18 帧） | 抓到机制：`器义字面化反讽` —— 把「蛐蛐=议论」「尖子生=头发尖」这类词按字面生成画面 |

因此：

- 拆解建议用**多模态强模型**（Gemini 3.x pro / GPT-6 系），它能结合口播文稿找语言梗；
- 拆解提示词必须要求 `coreIdea / creativeDevice / whyItWorks` 三个字段，DNA 只许写**可迁移的手法**；
- 时长 > 60 秒的视频自动抽 18 帧（上限 24），否则看不清创意细节。
