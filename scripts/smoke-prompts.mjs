/**
 * 提示词接线回归测试：不联网、不调模型，只验证「参数有没有真的拼进提示词」。
 *
 * 起因：stepMatch 那批生成曾经漏传 lens / subjectAnchors，导致角色锚点和鱼眼镜头
 * 明明生成了、提示词里却没有——这种「接线错误」用 typecheck 抓不到，只能断字符串。
 *
 * 用法：node --experimental-strip-types scripts/smoke-prompts.mjs
 */

import { framePrompt, videoPrompt, rewritePrompt } from '../src/host/prompts.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`[prompts] ✓ ${name}`)
    return
  }
  failures += 1
  console.log(`[prompts] ✗ ${name}${detail === '' ? '' : `：${detail}`}`)
}

const aspect = { width: 1080, height: 1920 }
const lens = '鱼眼超广角镜头（门禁/猫眼视角），画面四角桶形畸变、中心放大'
const anchors = [
  { name: '橘猫', description: '浅橘白双色短毛幼猫，头戴南瓜帽，颈系黑蝴蝶结' },
  { name: '灰猫', description: '灰色短毛猫，白色胸口，披白布斗篷' },
]

const frame = framePrompt({
  segment: { index: 2, shotType: '中近景', camera: '固定', visualPrompt: '两只猫站在门口', productPlacement: '无' },
  productVisual: '',
  hasProduct: false,
  aspect,
  styleHint: '实拍写实',
  subjectAnchors: anchors,
  lens,
})
check('首帧提示词带 [角色锚定]', frame.includes('[角色锚定]'))
check('首帧提示词点名每个角色', frame.includes('「橘猫」') && frame.includes('「灰猫」'))
check('首帧提示词带 [镜头]', frame.includes('[镜头]') && frame.includes('鱼眼'))
check('纯复刻首帧提示词不含“产品”', !/产品/.test(frame), frame.split('\n').filter(line => /产品/.test(line)).join(' | ').slice(0, 120))

const video = videoPrompt({
  shots: [{ shotType: '中近景', camera: '固定', visualPrompt: '两只猫讨糖', voiceover: '不给糖就捣蛋', emotion: '凶萌' }],
  hasProduct: false,
  productVisual: '',
  styleHint: '实拍写实',
  continuation: false,
  aspect,
  lens,
  subjectIdentity: '橘猫：浅橘白幼猫，头戴南瓜帽；灰猫：灰色短毛猫，披白布斗篷',
})
check('视频提示词带镜头语言锁', video.includes('镜头语言：') && video.includes('鱼眼'))
check('视频提示词锁角色', video.includes('橘猫') && video.includes('灰猫'))
check('纯复刻视频提示词不含“产品”', !/产品/.test(video), video.split('\n').filter(line => /产品/.test(line)).join(' | ').slice(0, 120))

const analysis = {
  coreIdea: '两只猫万圣节讨糖',
  creativeDevice: '反差萌',
  whyItWorks: '反差',
  summary: '萌宠讨糖',
  meta: { durationSec: 30, shotCount: 4, resolution: '1080x1920', fps: 30, style: '实拍写实', pacing: '快', lens },
  hook: { type: '萌', text: '', whyItWorks: '', seconds: 3 },
  shots: [],
  rhythm: { avgShotSec: 3, beatPattern: '', cutPoints: [] },
  style: { palette: ['暖'], typography: '', music: '', colorGrade: '', subject: '两只猫' },
  dna: [],
  scores: { hook: 8, retention: 8, conversion: 8, overall: 8 },
  occasion: { name: '万圣节', why: '临近节日' },
}
const rewrite = rewritePrompt({
  analysis,
  productBrief: '',
  hasProductImages: false,
  productNames: [],
  targetDurationSec: 30,
  mode: 'faithful',
})
check('仿写提示词写清镜头语言', rewrite.includes('镜头语言：') && rewrite.includes('鱼眼'))
check('仿写提示词要求逐镜贯穿', rewrite.includes('每一镜') && rewrite.includes('镜头语言'))
check('仿写提示词保留节令', rewrite.includes('万圣节'))

if (failures > 0) {
  console.log(`[prompts] 失败 ${failures} 项`)
  process.exit(1)
}
console.log('[prompts] 全部通过 ✓')
