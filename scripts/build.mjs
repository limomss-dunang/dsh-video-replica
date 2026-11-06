// 构建脚本：清理 lib/ 后依次构建宿主（ESM）与客户端（CJS + __ModuleLoader__ 包装）。
// 用法：node scripts/build.mjs  （或 pnpm --filter dsh-video-replica build）
import { rm, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const libDir = path.join(root, 'lib')
const tsdownBin = path.join(root, 'node_modules', 'tsdown', 'dist', 'run.mjs')

async function main() {
  await rm(libDir, { recursive: true, force: true })
  await mkdir(libDir, { recursive: true })

  const run = (args, label) => {
    const res = spawnSync(process.execPath, [tsdownBin, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    })
    if (res.status !== 0) {
      console.error(`[build] ${label} failed (exit ${res.status})`)
      process.exit(res.status ?? 1)
    }
  }

  run(['--config', 'tsdown.config.ts'], 'host')
  run(['--config', 'tsdown.client.config.ts'], 'client')

  console.log('[build] done: lib/index.js (host) + lib/client.js (client)')
}

main().catch((error) => {
  console.error('[build] error:', error)
  process.exit(1)
})
