/**
 * 流水线提示词（中文）。
 *
 * 写作规范借鉴了《AI 短剧提示词知识库》，
 * 落成下面几条硬规则：
 *
 * 1. **一条视频提示词的结构**：任务 → 素材职责 → 连续性锁定 → 逐镜（运镜 → 单一动作
 *    → 位置/空间 → 环境动态 → 声音）→ 光线/风格 → 输出限制。
 *    见 `videoPrompt`：用「镜头1/镜头2」而不是硬塞秒数（Seedance 对精确时间戳支持不稳）。
 * 2. **素材绑定**：每张参考图只承担一个职责（图片1=产品身份锚定，图片2=起始帧/构图），
 *    一段文字不承担全部约束。
 * 3. **首帧只画动作开始前的状态**，视频只补一个主动作：起点 → 过程 → 结束姿态。
 * 4. **一个镜头一个主动作**，复杂动作拆镜；身体反应发生在触发之后。
 * 5. **电影感不是形容词**：把"高级感/氛围感"拆成景别、光线方向、前景遮挡、镜头运动。
 * 6. **正向表述优先**：描述"镜头固定、主体稳定、画面干净"，少写"不要抖/不要变形"；
 *    只保留视频模型必需的几条洁净约束（无文字/无 Logo/无水印）。
 * 7. **禁止同义词改写**：产品外观描述逐字复制进每个镜头，不在镜头之间换说法。
 */

import type { AnalysisReport, ProductImage, ScriptVariant, TranscriptCue } from '../shared/types.ts'
import { CAMERA_MOVES, SHOT_TYPES } from '../shared/types.ts'
import { transcriptToText } from './providers/asr.ts'

export { CAMERA_MOVES, SHOT_TYPES }

export const ANALYZE_SYSTEM =
  '你是一位资深短视频拆解专家。你的工作是把一条爆款视频拆成可复用的结构与创意 DNA，只输出严格 JSON，不输出任何解释文字。'




/** 首帧画风：文案与说明（Seedance 不接受写实人脸，卡通/插画风可通过）。 */
export const FRAME_STYLES: Record<'photo' | 'cartoon' | 'illustration', { label: string, prompt: string }> = {
  photo: { label: '写实摄影', prompt: '真实摄影质感，自然光，构图干净' },
  cartoon: {
    label: '3D 卡通',
    prompt: '3D 卡通渲染风格（皮克斯/迪士尼质感）：圆润的角色比例、干净的材质与体积光，人物是卡通角色而非写实人脸',
  },
  illustration: {
    label: '国风插画',
    prompt: '国风插画风格：淡彩晕染、细腻笔触、留白构图，人物是插画角色而非写实人脸',
  },
}

/** 去掉片段结尾的标点，拼接时统一补句号，避免出现「。。」。 */
function clean(value: string): string {
  return value.trim().replace(/[。；;，,、\s]+$/u, '')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function orientationOf(aspect: { width: number, height: number } | undefined): string {
  if (aspect === undefined) return '竖屏 9:16'
  if (aspect.width === 0 || aspect.height === 0) return '竖屏 9:16'
  const ratio = aspect.width / aspect.height
  if (Math.abs(ratio - 1) < 0.08) return `方形 1:1（${aspect.width}×${aspect.height}）`
  return ratio > 1
    ? `横屏 16:9（${aspect.width}×${aspect.height}）`
    : `竖屏 9:16（${aspect.width}×${aspect.height}）`
}

/** 拆解提示词：输入均匀抽帧（+ 可选口播文稿）。 */
export function analyzePrompt(options: {
  platformLabel: string
  title: string
  durationSec: number
  frameCount: number
  width: number
  height: number
  transcript?: TranscriptCue[]
  productBrief?: string
}): string {
  const duration = options.durationSec > 0 ? options.durationSec.toFixed(1) : '未知'
  const transcript = options.transcript !== undefined && options.transcript.length > 0
    ? transcriptToText(options.transcript)
    : '（未提供音频转写。请只依据画面与画面文字判断，凡涉及声音的字段一律写「未识别（无音频输入）」。）'
  return `# 待拆解视频
- 平台：${options.platformLabel}
- 标题：${options.title}
- 时长：${duration} 秒
- 分辨率：${options.width || '?'}x${options.height || '?'}
- 你看到的图片：按时间顺序均匀抽取的 ${options.frameCount} 帧（第 1 张最早，最后一张最晚）

# 口播文稿（可能为空）
${transcript}

# 分析要求（逐条照做）
1. 逐个镜头拆解：依据画面变化切分镜头，起止秒必须落在 0~${duration} 之间且递增。帧数少于镜头数时，按画面内容合理推断镜头边界。
2. 每个镜头都要写清：
   - shotType：景别，只能从【特写 / 近景 / 中近景 / 中景 / 全景 / 远景】里选一个；
   - camera：运镜，只能从【固定 / 缓慢推近 / 缓慢拉远 / 横摇 / 跟拍 / 环绕 / 手持 / 拉焦】里选一个；
   - visual：画面内容，要写可见事实：主体是谁、在画面左/中/右、朝向与视线、正在做什么（一个主动作）、手里拿着什么；
   - lighting：光线，写方向/色温/明暗（例：左侧窗光、暖色实用灯、冷色顶光、硬逆光勾轮廓）；
   - environment：环境动态（例：风带动窗帘和碎发、杯中蒸汽上升、虚焦人群经过、灯光闪烁）；
   - onscreenText：画面上的大字或字幕；emotion / purpose：该镜头的情绪与功能（钩子/痛点/卖点/证明/行动号召/收尾）。
3. 动作戏拆成"起手—动作—结果"，不要在一镜里塞多个动作；对白戏优先近景/中近景。
4. 用可见事实替代抽象判断：不写"很伤心、很有气场、电影感"，改写成眉眼/呼吸/视线/站位/光线。
5. voiceover 字段：有口播文稿时，按时间把文稿分配到对应镜头；没有文稿时写「」（空字符串），不要编造台词。
6. hook（开场钩子）：说明它在几秒内、用什么手法抓住注意力，以及为什么有效。
7. rhythm：平均每镜秒数、剪辑节拍描述、关键切点秒数数组。
8. style：主色调（写颜色词或色值）、字幕排版风格、音乐风格（无音频输入时写「未识别（无音频输入）」）、调色风格、画面主体。
9. coreIdea：**一句话**说清这条片子的创意核心 = **前提关系 + 核心把戏**（写成「谁、在什么前提下、做什么把戏、结果如何」；例：「节日里两只小动物上门讨糖，却用凶狠嗓音要糖，形成反差萌」）。只写手法不写关系是不完整的。
10. creativeDevice：把它的创意手法抽象成**一条可跨题材迁移**的机制（例：隐喻字面化；把类型片套路做成实体反讽；让配角当创作者心理的外化）。不要写角色名、道具名、具体桥段。
11. whyItWorks：为什么成立 —— 预期如何被违背（指令→字面结果→人类的无奈接受）、情绪节奏怎么走、观众代入点在哪。
11.1 **只有当口播/画面文字里真的存在「被字面执行的词」时**，才在 creativeDevice 里写清这层语言歧义（例：「蛐蛐=议论」被错听成虫子、「尖子生=头发尖」被画成尖头）。没有这类词就不要硬套，更不要为了套模板编造不存在的信息。
12. dna：3~6 条「这条视频靠什么爆」的**手法**，每条一句话且必须能迁移到完全不同的题材。禁止写具体角色/道具/场景（写「动物当创作者替身」，不要写「橘猫打字」）。
12.5 characters（角色清单，**必填**）：列出画面里出现、且需要逐镜保持一致的**每一个**主要角色（1–3 个），每个写：
   - name：称呼，用画面能区分的短名（「橘猫」「灰猫」「店主」「小男孩」）；
   - identity：30–60 个汉字的外形身份证——物种或身份、毛色/肤色/材质、花纹分布（如「白色胸口与四爪、耳尖深色」）、眼睛颜色、体型、标志性配饰或穿着。
   - 例：一个橘猫 + 一个灰猫同框时，必须写两条，不能只写一条。写**具体、可复现**的特征，不要写「一只可爱的猫」。
12.6 subjectIdentity（兼容字段）：等于 characters 第一条的 identity。
14. occasion（节令/时效钩子，**必填字段，没有就写空对象**）：这条片子是不是靠「时间点」才成立？
   - 如果是：写 {"name": "节令或热点名（例：万圣节/春节/开学季/双11/世界杯）", "why": "为什么必须在这个时间点发才有流量（一句话）"}。
   - 例子：万圣节萌宠装扮上门讨糖 → 观众当天正在过节，装扮+讨糖话术直接命中节日情绪。
   - 不是：写 {}。不要为了填而编。
15. 只描述真实看到的内容，不要脑补不存在的画面。
10. scores：钩子力 / 完播力 / 转化力 / 综合，0~10 的整数。


# 只输出这个 JSON（不要 markdown 代码块）
{
  "videoType": "talking_head | character_narrative | product_showcase | atmosphere_montage",
  "hasHumanSubject": true 或 false,
  "visualStyle": "画面美术风格短语（实拍写实 / 3D动画 / 2D动画 / 国风水墨 …）",
  "summary": "一句话概括这条视频靠什么爆",
  "coreIdea": "一句话说清它真正在做什么（创意主张，不是内容摘要）",
  "creativeDevice": "抽象到可跨题材迁移的创意手法（一条）",
  "whyItWorks": "预期违背机制 + 情绪节奏 + 观众代入点",
  "hook": {"type": "钩子类型", "text": "钩子文案或画面", "whyItWorks": "为什么有效", "seconds": 数字},
  "shots": [
    {"index": 1, "startSec": 0, "endSec": 3.2, "shotType": "特写", "camera": "固定",
     "visual": "主体在画面右侧，朝向左侧，单手抬起做一次动作", "lighting": "左侧柔和窗光",
     "environment": "背景轻微虚焦，衣摆随动作轻晃", "voiceover": "", "onscreenText": "画面大字",
     "emotion": "好奇", "purpose": "钩子"}
  ],
  "rhythm": {"avgShotSec": 2.5, "beatPattern": "节奏描述", "cutPoints": [3.2, 6.8]},
  "style": {"palette": ["主色", "辅色"], "typography": "字幕排版", "music": "音乐风格", "colorGrade": "调色", "subject": "画面主体"},
  "characters": [{"name": "橘猫", "identity": "外形身份证（30–60 字，具体到毛色/花纹/眼睛/体型/配饰）"}],
  "subjectIdentity": "同 characters[0].identity",
  "occasion": {"name": "节令/热点名，没有就写空字符串", "why": "为什么必须在这个时间点发"},
  "dna": ["可复用套路 1", "可复用套路 2"],
  "scores": {"hook": 8, "retention": 7, "conversion": 6, "overall": 7}
}`
}

export const REWRITE_SYSTEM =
  '你是一位资深短视频仿写编剧 + 分镜师。你擅长把一条爆款视频的创意 DNA（结构、节奏、钩子、情绪曲线）移植到新的产品或题材上，产出可以直接喂给 AI 视频模型的分镜脚本。只输出严格 JSON。'

/** 仿写提示词：输入拆解 JSON + 产品简述。 */
export function rewritePrompt(options: {
  analysis: AnalysisReport
  productBrief: string
  hasProductImages: boolean
  productNames: string[]
  targetDurationSec: number
  /** 仿写取向：redesign 提炼机制重新设计；faithful 结构照搬。 */
  mode?: 'redesign' | 'faithful'
}): string {
  const { analysis } = options
  const shotLines = analysis.shots
    .map(shot => `${shot.index}. ${shot.startSec}-${shot.endSec}s ${shot.shotType}/${shot.camera}｜${shot.visual}` +
      `${shot.lighting === '' ? '' : `｜光线：${shot.lighting}`}` +
      `${shot.environment === '' ? '' : `｜环境：${shot.environment}`}` +
      `${shot.onscreenText === '' ? '' : `｜大字：${shot.onscreenText}`}` +
      `${shot.voiceover === '' ? '' : `｜口播：${shot.voiceover}`}`)
    .join('\n')
  const dna = analysis.dna.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const transcript = analysis.transcript !== undefined && analysis.transcript.length > 0
    ? transcriptToText(analysis.transcript)
    : (options.hasProductImages
        ? '（源片识别不到口播文稿：这是产品复刻，请按产品卖点自行创作口播文案，不要编造源片的台词）'
        : '（源片无口播文稿：不要编造配音台词，voiceover 一律留空字符串）')
  const productLine = options.hasProductImages
    ? `- 参考图：用户提供了 ${options.productNames.length} 张产品/主体图（文件名：${options.productNames.join('、') || '已上传'}）。
- 要求：把画面里的核心主体替换成该产品，产品的外观、材质、颜色、包装文字以参考图为准；分镜的 visualPrompt 必须写成「产品以什么方式出现在画面里」，不要出现其它品牌。`
    : '- 本次没有上传产品图：按「纯复刻」处理，忠实复刻源片的题材与画面，严禁植入任何产品、品牌或带货话术。'
  const seconds = Math.round(options.targetDurationSec)
  const occasionName = analysis.occasion?.name?.trim() ?? ''
  const occasionWhy = analysis.occasion?.why?.trim() ?? ''
  const coreSection = `## 源片的核心创意（先理解这一节，再动笔）
- 核心创意：${analysis.coreIdea === '' ? '（模型未给出，请从下面的分镜与 DNA 自行归纳）' : analysis.coreIdea}
- 创意手法：${analysis.creativeDevice === '' ? '（未给出）' : analysis.creativeDevice}
- 为什么成立：${analysis.whyItWorks === '' ? '（未给出）' : analysis.whyItWorks}
- 节令/时效钩子：${occasionName === '' ? '（无：这条片子不依赖特定时间点）' : `${occasionName} —— ${occasionWhy}`}
`
  return `# 源视频拆解
- 时长：${analysis.meta.durationSec.toFixed(1)} 秒，共 ${analysis.meta.shotCount} 个镜头
- 综合评分：${analysis.scores.overall}/10（钩子 ${analysis.scores.hook} / 完播 ${analysis.scores.retention} / 转化 ${analysis.scores.conversion}）
- 一句话概括：${analysis.summary}
- 视觉风格：${analysis.meta.style}；节奏：${analysis.meta.pacing}
- 钩子：${analysis.hook.type}｜${analysis.hook.text}｜为什么有效：${analysis.hook.whyItWorks}

${options.mode === 'faithful' ? '## 源片分镜（必须继承其结构与节奏）' : '## 源片分镜（只用于理解它的节奏与技巧，**禁止照抄画面、角色、台词**）'}
${shotLines}

## 源片口播文稿
${transcript}

${coreSection}
## 爆款 DNA（必须复用）
${dna}

## 风格特征（必须复刻）
- 主色调：${analysis.style.palette.join(' / ')}
- 字幕排版：${analysis.style.typography}
- 调色：${analysis.style.colorGrade}
- 主体：${analysis.style.subject}

# 复刻目标
- 目标成片时长：约 ${seconds} 秒（不得超过它的 1.2 倍）
${productLine}
${options.hasProductImages
    ? `- 用户给的产品/卖点简述：${options.productBrief.trim() === '' ? '（未填写）' : options.productBrief.trim()}`
    : '- 纯复刻模式：本次不植入任何产品、品牌或卖点诉求（新建任务里填写的卖点简述本轮不参与创作）。'}

# 创作边界（最重要，先读这一节）

## 先记住三条铁律（所有模式通用）
1. **核心创意照 analysis.coreIdea 原文保留**：它写的是什么关系，你就保留什么关系。不要把它替换成你自己熟悉的那套设定（例如源片是「萌宠节日讨糖」，就不要硬套「人机指令翻车」）。
2. **节令/时效是第一优先级，不许弄丢**：${occasionName === ''
    ? '本条没有节令依赖，正常处理。'
    : `本条靠「${occasionName}」成立（${occasionWhy}）。你必须保留同一个节令，并且把它落到三处——① 画面：节令专属的装扮/装饰/道具（节日服饰、南瓜灯、彩灯、门贴、糖果篮…）；② 台词：节令专属话术（讨糖/祝福/口号），让观众一听就知道是哪个节；③ 字幕/音效：至少一处出现节令字样或节日音效。**不得换成别的节日或无关场景**（把万圣节换成春节/外卖/取件都算失败）。`}
3. 三个版本的差异必须体现在「结构/视角/钩子顺序」上，**不能靠换掉节令或换掉题材来制造差异**。

${options.mode === 'faithful'
    ? `## 本次模式：忠于原片（faithful）
- **保留**：题材、节令、角色类型（例如「两只小动物」）、场景类型（例如「鱼眼门禁视角」）、桥段顺序、镜头节奏。
- **可以换**：具体台词措辞、表演细节、道具材质、画面构图微调；有产品图时用产品替换主体。
- **不许**：换成与源片无关的题材或桥段；不许丢掉节令；不许照抄源片原句台词。
- 三个版本的差异：A 最贴近原片；B 换钩子顺序（先给结果再回放）；C 换叙述视角（仍保持同一题材与节令）。`
    : `## 本次模式：重新设计（redesign）
1. **必须保留** analysis.coreIdea 里的前提关系与核心把戏，一字不改地保留它的逻辑。
2. **必须更换**：具体桥段、台词、道具细节、叙事顺序；可以换任务领域，但**节令必须保留**（见上面第 2 条铁律）。
3. **禁止**沿用源片的具体台词，或让分镜与源片某一镜「看起来是同一个画面」。
4. 三个版本：A 换叙事载体但保留核心机制；B 换钩子顺序；C 换视角，但核心关系与节令不变。
5. 必须保住爆款机制：3 秒内钩子、每 15–20 秒一个新信息/小反转、结尾卡在动作或选择上。
6. notes 里写清：保留了哪条核心关系；保留了哪个节令（若有）；换了什么。`}

# 硬性要求
1. 输出 3 个版本，id 分别为 "A"、"B"、"C"，角度要有明显差异：${options.mode === 'faithful'
    ? '（A 忠于原片结构；B 换钩子手法；C 换叙事视角或情绪切入点）'
    : '（A 换题材但保留最核心的机制；B 保留情绪曲线、换钩子与叙事顺序；C 只借最抽象的一条机制，用完全不同的结构讲一个新故事）'}。
2. 每个版本 3–6 个分镜（源片镜头多时合并同类镜头），时长分配对齐源片的节奏感；不要为了塞镜头把每镜压到 3 秒以下。
3. 每个分镜 duration = endSec - startSec，且 3 秒 ≤ duration ≤ 8 秒；全部分镜时长之和不得超过 ${Math.round(options.targetDurationSec * 1.2)} 秒。
4. **一镜一主动作**：每个分镜只安排一个可被单镜头拍出来的主动作，并写清起点姿态与结束姿态；复杂动作拆成多个分镜（起手—动作—结果），不要塞进同一镜。身体反应要发生在触发之后（听到台词才变脸，被碰到才后退）。
5. 每镜必须填：
   - shotType：只能从【特写 / 近景 / 中近景 / 中景 / 全景 / 远景】选一个；对白镜用近景/中近景；
   - camera：只能从【固定 / 缓慢推近 / 缓慢拉远 / 横摇 / 跟拍 / 环绕 / 手持 / 拉焦】选一个，一镜只用一种；
   - lighting：本镜光线（方向/色温/明暗），按**你自己的新场景**写，不要照抄源片；
   - environment：本镜环境动态（风、蒸汽、雨、人群、灯光变化…），同样按新场景写；
   - emotion：本镜的情绪，随剧情**逐级升级**（例：期待 → 疑惑 → 无语 → 气急败坏 → 认命），用 2–6 个汉字。
   - speaker：这句台词**由画面里的谁说出**。
     - 主角称谓取拆解里的画面主体（style.subject / coreIdea 里的称呼，如「橘猫」「柴犬」「小男孩」「店主」）；拆解没给明确称呼时写「主角」。
     - 其它角色写具体身份（「老板」「同事」「门卫」「店员」「路人」…），按你自己的新场景来写，不要沿用这里的举例。
     - **台词必须归给画面里说话的人**：不要出现「画面是 A、台词却是 B」的错位；一句话只能属于一个角色。
     - 多个角色轮流出场时，每个角色的台词都要标 speaker，方便后期用不同音色配音。
   - **动作必须对上台词**：台词里提到某个动作（递、推、敲、按、举、抓、指），visualPrompt 就必须真的画出那个动作的起点与终点，不能写成站着说话。
   - **双关必须落地成物件**：如果笑点来自中文多义词/俗语（画饼、背锅、摸鱼、穿小鞋…），visualPrompt 必须写清那个**字面物件的形状、大小、位置、颜色**（例：「白板上画着一个巨大的圆形披萨状饼图，饼上写着『未来三年规划』」），不能只写词语本身。
   - 每镜 **5–7 秒**，不要写 8 秒以上的单镜。
6. voiceover 是口播台词：短句化，**单句不超过 15 个汉字**，字数按「中文每秒约 4.5 字」控制（汉字数 ≤ duration × 4.5），给听、反应、呼吸留时间。
   ${options.hasProductImages
    ? '这是产品复刻（有产品图/卖点）：**每个镜头都必须写口播**——即使源片没有口播，也要围绕卖点写出可直接朗读的带货文案，并与该镜画面动作对应。'
    : '源片无口播时留空字符串，不要编台词（纯复刻要忠实）。'}
7. onscreenText 是画面大字，从 voiceover 里提炼（最多 12 个字），voiceover 为空时也留空。
8. visualPrompt 是给图像/视频模型看的画面描述，按固定顺序写：**景别 → 主体位置 → 一个主动作（起点→终点）→ 环境动态 → 光线**；总长 ≤60 个汉字。
   - 只写可见事实，不写"电影感、高级感、氛围感"这类形容词；
   - 不要在一镜里同时写两种运镜（例如"固定"+"推近"）；
   - 不要写互相抵消的风格词（电影感 + 纪实手持、胶片感 + 4K 超清、慢动作 + 高速动作）。
9. productPlacement 说明该镜头里产品如何出现（手持特写 / 使用中 / 桌面静物 / 递出…，≤20 字）；纯复刻时写「无产品」。
10. 第一镜必须在 3 秒内给出钩子（复用源片的钩子类型）；每 15–20 秒要出现一次新信息、关系变化或小反转。
11. notes 说明该版如何继承源片 DNA，≤80 字。

# 输出体积控制（重要，否则会被截断）
- 不要输出解释、不要重复源片分镜全文、不要输出 markdown 代码块。

# 只输出这个 JSON
{
  "variants": [
    {
      "id": "A",
      "angle": "创作角度（8 字内）",
      "title": "该版本标题",
      "hookLine": "开场钩子文案",
      "totalDurationSec": ${seconds},
      "notes": "该版本如何继承源片 DNA",
      "segments": [
        {"index": 1, "startSec": 0, "endSec": 4, "shotType": "中近景", "camera": "固定",
         "voiceover": "短句口播", "onscreenText": "画面大字",
         "visualPrompt": "中近景，主体在画面右侧，抬手做出一次动作",
         "lighting": "左侧柔和窗光，暖色调", "environment": "锅上蒸汽缓慢升起", "emotion": "期待", "speaker": "柴犬",
         "productPlacement": "产品出现方式"}
      ]
    }
  ],
  "recommendedId": "A",
  "checks": {
    "keptCoreIdea": "这一版保留了 coreIdea 的哪条关系（一句话，必须能对上原文）",
    "keptOccasion": "保留了什么节令；源片没有节令就写「无」",
    "keptSubject": "保留了什么主体/角色类型（如「两只小动物」「鱼眼门禁视角」）",
    "changed": "换了什么（桥段/台词/道具），不许写「换掉节令或题材」"
  }
}`
}

/**
 * 参考图（分镜首帧）提示词。
 *
 * 按知识库的「首帧生成」模板：只画动作开始前的清晰状态；资产职责单一；
 * 留出下方干净区域方便后期烧字幕。
 */
export function framePrompt(options: {
  segment: {
    index: number
    shotType?: string
    camera?: string
    visualPrompt: string
    productPlacement: string
    lighting?: string
    environment?: string
  }
  productVisual: string
  hasProduct: boolean
  aspect: { width: number, height: number }
  styleHint: string
  /** 全片光线基准（拆解里最常见的光线描述）。 */
  lightingBaseline?: string
  /** 首帧画风；默认写实。 */
  frameStyle?: 'photo' | 'cartoon' | 'illustration'
  /**
   * 产品融入方式：`reference` 传参考图（图生图）；`text` 只用文字描述（文生图）。
   * 方舟只信任 Seedream **文生图**产物，图生图产物会被判「疑似真实人物」。
   */
  productMode?: 'reference' | 'text'
  /** 角色锚点：纯复刻时为每个角色各有一张设定图，各镜首帧以它们为参考（按数组顺序对应图片1..N）。 */
  subjectAnchors?: Array<{ name: string, description: string }>
}): string {
  const textMode = options.productMode === 'text'
  const style = FRAME_STYLES[options.frameStyle ?? 'photo'] ?? FRAME_STYLES.photo
  const shotType = (options.segment.shotType ?? '').trim() || '中景'
  const camera = (options.segment.camera ?? '').trim()
  const lighting = clean(options.segment.lighting ?? '') || clean(options.lightingBaseline ?? '')
  const environment = clean(options.segment.environment ?? '')

  const placement = options.segment.productPlacement.trim() === '' ? '自然出现在画面里，与主体动作产生关系' : options.segment.productPlacement.trim()
  const anchors = options.subjectAnchors ?? []
const subject = anchors.length === 0
  ? ''
  : (() => {
      const offset = options.hasProduct ? 1 : 0
      const lines = anchors
        .map((anchor, index) => `图片${index + 1 + offset} =「${anchor.name}」的角色设定图：${clean(anchor.description)}`)
        .join('；');
      const names = anchors.map(anchor => `「${anchor.name}」`).join('、')
      return `\n[角色锚定] ${lines}。画面里出现的每个角色都必须与对应设定图**完全一致**：同样的物种/身份、毛色与花纹分布、眼睛颜色、体型比例、配饰与穿着；只改变姿态、动作、场景与光线。不要换品种、不要改毛色、不要换配饰、不要少人。本镜必须出现的角色：${names}。`
    })()
const material = !options.hasProduct
    ? '\n[素材] 无产品参考图：画面中不出现任何品牌 Logo、广告文字或包装文字。'
    : textMode
      ? `\n[产品] 按下面的文字描述把产品画进画面（本图不提供产品参考图）：${options.productVisual === '' ? '一个干净的产品瓶' : clean(options.productVisual)}。\n产品在本镜的呈现：${placement}。产品外形、主色与材质必须与描述一致，不要出现品牌 Logo 或文字。`
      : `\n[素材] 图片1 = 产品外观锚定。${options.productVisual === '' ? '产品的容器外形、主色、材质与包装文字严格以图片1为准。' : `产品视觉身份证：${clean(options.productVisual)}；容器外形、主色、材质、包装文字与朝向严格以图片1为准。`}\n产品在本镜的呈现：${placement}。`

  return `为镜头 SH${String(options.segment.index).padStart(2, '0')} 生成一张适合「图生视频」的首帧。
[构图] 景别：${shotType}${camera === '' ? '' : `；运镜意图：${camera}（首帧是动作开始前的定格，镜头参数只影响构图）`}。画面内容：${options.segment.visualPrompt}
[起始姿态] 只表现动作开始前的清晰状态：主体姿态、手部、产品与空间关系完整，产品落点符合支撑与重力；不要把后续动作提前画出来，不要出现运动残影。${subject}${material}
[反讽落地] 如果本镜是中文双关/俗语的字面化（画饼、背锅、摸鱼、穿小鞋…），必须把那个**字面物件**画成**真实存在的实物**：画饼要画成一张真实的、刚出锅的大饼（金黄、有焦斑、冒热气，像真食物），背锅要画成真实的铁锅，不能画成饼图、图标、示意图、剪贴画或文字。形状、尺寸、位置、颜色都要具体可辨。
${lighting === '' ? '' : `[光线] ${lighting}；光向全片保持一致。\n`}${environment === '' ? '' : `[环境动态] ${environment}（首帧里保持静止或轻微可辨，不要抢主体）。\n`}[画面] 主体清晰、前景/中景/背景分层；画面下方留出干净区域便于后期字幕；画面内不生成任何文字。
${options.hasProduct ? '[合规] 如有真人风格人物，请让其为全新虚构角色（五官、发型与任何真实人物不同），避免与真实人物雷同。\n' : ''}
[风格] ${style.prompt}${options.styleHint.trim() === '' ? '' : `；参考拆解出的视觉风格：${options.styleHint.trim()}`}。
[输出限制] 单张静帧；无文字、字幕、Logo、水印；不出现其它品牌产品或多余人物。`
}

/**
 * 分镜视频提示词（按块生成）。
 *
 * 结构 = 任务 + 素材职责 + 连续性锁定 + 逐镜（运镜→动作→位置→环境→台词）+ 风格 + 输出限制。
 * 一镜一行、用镜头序号而不是时间戳（Seedance 一类模型对精确时间戳支持不稳）。
 */
export function videoPrompt(options: {
  shots: Array<{
    shotType: string
    camera: string
    visualPrompt: string
    voiceover: string
    environment?: string
    lighting?: string
    /** 本镜情绪，写进表演要求。 */
    emotion?: string
  }>
  hasProduct: boolean
  productVisual: string
  styleHint: string
  continuation: boolean
  /** 画幅（源片宽高），用于在提示词开头声明。 */
  aspect?: { width: number, height: number }
  /** 全片光线基准。 */
  lightingBaseline?: string
  /** 本段计划时长（秒），用于给模型一个总长度预期。 */
  seconds?: number
  /** 与首帧一致的画风（卡通/插画时视频也要保持同一画风）。 */
  frameStyle?: 'photo' | 'cartoon' | 'illustration'
  /**
   * 是否把产品图作为参考图一起传：
   * - ark-seedance（全模态参考，最多 9 张）传「产品图 + 首帧」，两张都用 reference_image
   *   （first_frame 不能与 reference_image 混用，实测 400）；
   * - 其它网关大多只吃一张图，那就只传首帧，产品外观靠文字描述。
   */
  includeProductImage?: boolean
  /** 角色锚点：写进连续性锁，避免 Seedance 每镜把角色换掉。 */
  subjectIdentity?: string
}): string {
  const usesProductImage = options.hasProduct && (options.includeProductImage ?? true)
  const subjectLock = options.subjectIdentity === undefined || options.subjectIdentity.trim() === ''
    ? ''
    : `\n[角色锁定] 全片必须固定这几个角色：${clean(options.subjectIdentity)}。每一镜里这些角色的外形（物种/毛色/花纹/眼睛/体型/配饰）必须与首帧完全一致，不得换品种、换毛色、换配饰，也不得凭空多出或少掉角色；只随剧情改变姿态、表情与场景。`
  const baseline = clean(options.lightingBaseline ?? '')

  const shotLines = options.shots
    .map((shot, index) => {
      const shotType = (shot.shotType ?? '').trim() || '中景'
      const camera = (shot.camera ?? '').trim()
      const head = camera === '' ? shotType : `${shotType}${camera}`
      // 模型写的 visualPrompt 常常已经以景别/运镜开头，避免重复一遍。
      const visualBody = clean(shot.visualPrompt)
      const visual = visualBody.startsWith(shotType) ? visualBody : `${head}，${visualBody}`
      const extra = [
        shot.environment === undefined || clean(shot.environment) === '' ? '' : `环境动态：${clean(shot.environment)}。`,
        shot.lighting === undefined || clean(shot.lighting) === '' ? '' : `光线：${clean(shot.lighting)}。`,
      ].filter(item => item !== '').join('')
      const voice = shot.voiceover.trim() === '' ? '' : ` 配音说道{${shot.voiceover.trim()}}`
      const act = shot.emotion === undefined || clean(shot.emotion) === '' ? '' : ` 表演：${clean(shot.emotion)}（面部表情、呼吸、肢体都要体现出来）。`
      return `镜头${index + 1}：${visual}${extra === '' ? '' : ` ${extra}`}${voice}${act}`
    })
    .join('\n')

  // 素材职责：reference 模式两张图（产品锚定 + 起始帧）；text/纯复刻只有起始帧。
  const materialTask = usesProductImage
    ? '图片1 = 产品外观锚定（身份参考）；图片2 = 本段起始帧（构图、主体位置、光线以此为准）'
    : '图片1 = 本段起始帧（构图、主体位置、光线以此为准）'
  const task = options.continuation
    ? `【任务】承接上一段视频继续拍：从上一段最后一帧接着往下，保留主体的位置、朝向、视线、${usesProductImage ? '产品外观、' : ''}光线方向与镜头朝向；前 0.5 秒延续上一段的运动方向与节奏，再完成本段第一个动作；不重新建立场景，不改变主体外观与服装。`
    : `【任务】参考图生视频。${materialTask}。本段从起始帧的状态开始，按镜头顺序只完成下列动作；镜头之间按原片节奏硬切，不添加转场特效。`

  const lockLines: string[] = []
  if (options.hasProduct) {
    lockLines.push(`产品：${options.productVisual.trim() === '' ? '外观、材质、颜色、包装文字与图片1完全一致' : `${clean(options.productVisual)}（外观、材质、颜色、包装文字与图片1完全一致）`}。本段只改变产品在画面中的位置、角度与被手持的状态，不改变形状、标签文字与配色，不出现其它品牌。`)
  } else {
    lockLines.push('画面中不出现任何品牌 Logo、广告文字或额外人物。')
  }
  if (subjectLock !== '') lockLines.push(subjectLock.replace(/^\n/, ''))
  if (baseline !== '') lockLines.push(`光线基准：${baseline}，全段保持同一光向与色温。`)
  lockLines.push(`空间：保持${usesProductImage ? '图片2' : '图片1'}中的空间结构与背景固定元素，主体脚下的接触关系真实。`)

  const frameStyle = FRAME_STYLES[options.frameStyle ?? 'photo'] ?? FRAME_STYLES.photo
  const style = `${frameStyle.label === '写实摄影' ? '真实摄影质感' : frameStyle.label}${options.styleHint.trim() === '' ? '，光影柔和，色彩自然' : `；${options.styleHint.trim()}`}`
  const outputLimits = [
    '画面干净，主体清晰，单镜一个主动作，动作连贯自然',
    '主体面部与产品外观稳定，不出现多余肢体或重复人物',
    '画面内不出现文字、字幕、Logo 与水印',
  ].join('；')

  return `${task}

[CONTINUITY_LOCK]
${lockLines.join('\n')}
[/CONTINUITY_LOCK]

${shotLines}

【风格】${style}。镜头运动缓慢、有目的，不为追动作而失焦或无目的旋转。
【输出】${outputLimits}。`
}

/** 产品图客观描述（用于把外观写进提示词，充当"视觉身份证"）。 */
export function productDescribePrompt(name: string): string {
  return `这是产品参考图（名称「${name}」）。请只根据图中确实可见的内容，用一句话（不超过 60 个汉字）写出它的「视觉身份证」：
1. 容器/外形类别（例如圆柱瓶、方盒、袋装、罐装）；
2. 主色与材质（透明/磨砂/金属/纸盒，是否反光）；
3. 包装上的图案与文字（若有，逐字写出可见的文字）；
4. 最显著的识别特征（瓶盖形状、标签位置、配色、比例）。
不要臆测看不到的内容，不要用"高级、质感很好"这类无锚点形容词，不要写营销词。
只输出 JSON：{"visual":"…"}`
}

export interface ProductVisualSummary {
  visual: string
  name: string
}

export function productImageNames(images: ProductImage[]): string[] {
  return images.map(image => image.name)
}

export function recommendedVariant(variants: ScriptVariant[], recommendedId: string): ScriptVariant | undefined {
  return variants.find(variant => variant.id === recommendedId) ?? variants[0]
}

// ---------------------------------------------------------------------------
// 第 7 步：发布文案（标题 / 话题 / 描述）
// ---------------------------------------------------------------------------

export const CAPTION_SYSTEM =
  '你是短视频账号运营，专门给已经做好的竖屏短视频写发布文案。你懂视频号的流量分发：短标题决定点击，话题决定推荐池，描述决定完播后的互动。只输出严格 JSON，不要解释、不要 Markdown。'

/** 发布文案提示词：吃拆解结论 + 仿写脚本，产出发布用的标题/话题/描述。 */
export function captionPrompt(options: {
  platform: string
  sourceTitle: string
  analysis: AnalysisReport
  variantTitle: string
  variantLines: string[]
  targetDurationSec: number
  extra?: string
}): string {
  const occasion = options.analysis.occasion?.name?.trim() ?? ''
  const lines = options.variantLines.slice(0, 6).map((line, index) => `${index + 1}. ${line}`).join('\n')
  return [
    `平台：${options.platform}`,
    `成片时长：${options.targetDurationSec.toFixed(0)} 秒`,
    `源片标题（不要照抄，只用来理解题材）：${options.sourceTitle}`,
    '',
    '这条片子在讲什么（拆解结论）：',
    `- 创意核心：${options.analysis.coreIdea}`,
    `- 手法：${options.analysis.creativeDevice}`,
    `- 为什么成立：${options.analysis.whyItWorks}`,
    `- 一句话概括：${options.analysis.summary}`,
    '',
    `仿写后的版本标题：${options.variantTitle}`,
    '仿写后的台词片段：',
    lines,
    options.extra === undefined || options.extra.trim() === '' ? '' : `额外要求：${options.extra.trim()}`,
    '',
    '请写三样东西：',
    '1. title：视频号「短标题」。不超过 16 个汉字，必须是钩子（反差、痛点、悬念三选一），不要书名号/引号/emoji/句末标点，不要出现「复刻」「搬运」「AI 生成」这类词，不要照抄源片标题。',
    occasion === ''
      ? '2. topics：5 到 8 个话题，不带 # 号。三层搭配：2 个平台流量话题（从 AI创作、短视频、职场、搞笑、生活记录 里挑）、2 个场景或人群话题、1 到 3 个来自这条片子具体元素的话题。不要生造没有流量的词，不要出现品牌名。'
      : `2. topics：5 到 8 个话题，不带 # 号。**第 1 个必须是「${occasion}」**（节令话题是这条片子的流量入口）；再加 2 个平台流量话题、2 个场景/人群话题、1 到 3 个内容梗话题。不要生造没有流量的词，不要出现品牌名。`,
    '3. description：70 到 130 字，最多两段。第一句 15 字内做钩子；中间一句讲清「发生了什么 + 反转在哪」；最后一句用问句引互动。口语化、有情绪；不要写话题、不要带 #、不要出现「本视频」「复刻」「AI 生成」。',
    occasion === '' ? '' : `注意：这条片子靠「${occasion}」的时效性，标题或描述第一句里要出现节令相关字样，不要写成泛泛的视频。`,
    '',
    '只输出一个 JSON 对象：',
    '{"title":"","description":"","topics":["",""]}',
  ].filter(line => line !== '').join('\n')
}
