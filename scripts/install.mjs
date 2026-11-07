#!/usr/bin/env node
/**
 * 把本插件安装进本机的 DSH profile（给用户 / 给 AI 的一条命令）。
 *
 * 做的事：
 *   1. 检查 lib/ 是否已构建（没有就提示先 npm install && npm run build）；
 *   2. 把插件包（lib/、cordis.patch.yml、locale/、icon.svg、package.json）复制进
 *      ~/.dsh/profiles/<profile>/node_modules/dsh-video-replica/；
 *   3. 把包名加进该 profile 的 package.json → dsh.profile.bundles。
 *
 * 用法：
 *   node scripts/install.mjs                 # 默认 desktop profile（自动探测）
 *   node scripts/install.mjs --profile web   # 指定 profile
 *   DSH_PROFILE_ROOT=/path/to/profile node scripts/install.mjs   # 自定义 profile 目录
 *
 * 装完需要**完全退出 DSH 再打开**（宿主要重新加载插件包）。
 *
 * 这是把包复制进 profile 的文件式安装：之后的升级重跑一次即可。
 * 图形界面里的「设置 → 插件 → 安装」走的是 tarball 流程，效果一样，二选一。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function argValue(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const manifestPath = join(root, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`✗ 没找到 ${manifestPath}（请在插件仓库根目录运行）`)
  process.exit(1)
}
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const manifest = readJson(manifestPath)
const packageName = manifest.name
if (typeof packageName !== 'string' || packageName === '') {
  console.error('✗ package.json 缺少 name')
  process.exit(1)
}

if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error('✗ 还没有构建产物 lib/：先运行 npm install && npm run build')
  process.exit(1)
}

/** 找 profile 目录：显式路径 > --profile > 环境变量 > 自动探测 desktop/web。 */
function resolveProfileRoot() {
  const explicit = process.env.DSH_PROFILE_ROOT
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(dshHome, 'profiles')
  const named = argValue('--profile') ?? process.env.DSH_PROFILE
  if (named !== undefined && named !== '') {
    const candidate = join(profiles, named)
    if (existsSync(candidate)) return candidate
    console.error(`✗ profile 不存在：${candidate}`)
    console.error(`  当前已有 profile：${existsSync(profiles) ? readdirNames(profiles).join('、') || '（空）' : '（没有 profiles 目录）'}`)
    process.exit(1)
  }
  for (const name of ['desktop', 'web']) {
    const candidate = join(profiles, name)
    if (existsSync(candidate)) return candidate
  }
  console.error(`✗ 找不到 DSH profile：${profiles}`)
  console.error('  请先启动一次 DSH，或用 --profile <name> / DSH_PROFILE_ROOT 指定。')
  process.exit(1)
}

function readdirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

const profileRoot = resolveProfileRoot()
const profilePkgPath = join(profileRoot, 'package.json')
if (!existsSync(profilePkgPath)) {
  console.error(`✗ profile 缺少 package.json：${profilePkgPath}`)
  process.exit(1)
}
const profilePkg = readJson(profilePkgPath)

const target = join(profileRoot, 'node_modules', packageName)
console.log(`→ 安装 ${packageName} → ${target}`)
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const copyItems = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  ...(manifest.files ?? ['lib', 'cordis.patch.yml', 'locale', 'icon.svg']),
])
for (const item of copyItems) {
  const from = join(root, item)
  if (existsSync(from)) cpSync(from, join(target, item), { recursive: true })
}
console.log('  ✓ 复制插件包')

profilePkg.dsh = profilePkg.dsh ?? {}
profilePkg.dsh.profile = profilePkg.dsh.profile ?? {}
const bundles = Array.isArray(profilePkg.dsh.profile.bundles) ? profilePkg.dsh.profile.bundles : []
if (!bundles.includes(packageName)) {
  bundles.push(packageName)
  profilePkg.dsh.profile.bundles = bundles
  writeFileSync(profilePkgPath, `${JSON.stringify(profilePkg, null, 2)}\n`, 'utf8')
  console.log(`  ✓ 已加入 ${profilePkgPath} → dsh.profile.bundles`)
} else {
  console.log('  ✓ bundles 里已有该插件（跳过）')
}

console.log('')
console.log('装好了。接下来：')
console.log('  1. 完全退出 DSH（不是刷新窗口）再重新打开；')
console.log('  2. 侧边栏出现「视频复刻」，设置里出现「视频复刻」配置页；')
console.log('  3. 首次使用先到 设置 → 视频复刻 选模型（或手动填接口）。')
console.log('')
console.log('如果侧边栏没有出现：确认 DSH 已重启，并检查上面打印的 profile 目录是否是你在用的那个。')
