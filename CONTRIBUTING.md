# Contributing / 贡献指南

感谢改进 dsh-video-replica。这是一个 DeepSeek Harness 插件：宿主半边（Node / Cordis）负责六步流水线与模型适配，浏览器半边（React）负责工作台与设置页。

## 环境要求

- Node.js **22+**
- `ffmpeg` / `ffprobe` 在 `PATH` 里（合成、抽帧、混音都要用；Windows 可把安装目录加进 PATH，或在设置里填绝对路径）
- 可选：`yt-dlp`（部分平台的下载兜底）、Python 3 + `playwright`（只用于生成界面截图）

## 本地开发

```bash
npm install            # 安装依赖；prepare 会自动构建 lib/
npm run build          # 单独重新构建：lib/index.js（宿主）+ lib/client.js（浏览器）
npm run typecheck      # tsc --noEmit
npm run smoke          # 客户端 + 宿主冒烟
```

| 命令 | 作用 |
|---|---|
| `npm run smoke:client` | 在 jsdom 里加载真实 client bundle，验证挂载与渲染 |
| `npm run smoke:host` | 起本地 mock 网关（聊天/图像/视频/TTS/ASR/解析），用**真实 ffmpeg** 跑完整六步，最后校验成片时长、分辨率、音轨、Range 播放与目录穿越防护。数据写在系统临时目录，不碰真实配置 |
| `npm run preview` | 用 Playwright 渲染工作台/设置页截图到 `output/preview/` |
| `python scripts/preview/verify-buttons.py` | 在「宿主 token 混搭」的坏配色下检查按钮/下拉对比度，低于阈值会失败 |

`node scripts/run-real.mjs` 可以跑真实链路（会消耗上游额度）：

```bash
node scripts/run-real.mjs --url "<分享链接>" --steps parse,analyze,rewrite
node scripts/run-real.mjs --preview-prompts <runId>            # 只拼提示词，不调模型
node scripts/run-real.mjs --run-id <runId> --regenerate-frame 2 --prompt "<改后的提示词>"
```

测试时建议用独立的 `DSH_VIDEO_REPLICA_HOME`，避免和正在运行的 DSH 宿主抢写 `run.json`。

## 代码结构

```
src/shared/types.ts        宿主/浏览器共用的类型与路由常量
src/host/index.ts          Cordis 插件入口（slots、locale、webServer 路由）
src/host/pipeline.ts       六步实现 + 单张/单段重生成 + 提示词预览
src/host/prompts.ts        拆解、仿写、首帧、分镜视频提示词
src/host/engine.ts         步骤调度、取消、自动推进、重启修复
src/host/store.ts          运行状态落盘（单文件 run.json，原子写）
src/host/routes.ts         loopback 桥接路由（一个路径一条 WebRoute）
src/host/providers/        chat / image / video / tts / asr / parser 适配器
src/client/                工作台、设置页、样式、文案
scripts/                   构建、冒烟、真实运行、界面截图
docs/                      架构、模型配置、提示词规范
```

两条硬约束：

1. **宿主半边只用 Node 内置模块 + 原生 `fetch`**，不引入运行时第三方依赖；
2. **浏览器半边不依赖宿主主题 token**（按钮/输入框用 `currentColor` + `color-mix` 上色），避免宿主换肤后出现白字白底。

## 提交前

```bash
npm run typecheck && npm run smoke
```

CI 会额外跑 Playwright 截图与对比度检查。所有检查都在 `.github/workflows/ci.yml` 里，本地能跑通一般就不会红。

## 提交 PR

- 一个 PR 只做一件事；修 bug 附上复现步骤（链接、日志、`run.json` 里相关字段）。
- 涉及提示词改动的，请说明改前/改后的实际效果（有截图或成片更好）。
- 提交信息用 `feat: / fix: / docs: / chore:` 前缀。
- 不要在仓库里提交任何真实密钥、`run.json`、成片或抽帧产物（`.gitignore` 已排除 `lib/`、`output/`、`node_modules/`）。

## 发版

```bash
npm run build && npm run typecheck && npm run smoke
git add -A && git commit -m "feat: ..." && git push origin main
git tag -a v0.x.0 -m "v0.x.0" && git push origin v0.x.0
gh release create v0.x.0 --title "v0.x.0" --notes "..."
```

预构建产物会随 `npm install`（`prepare`）生成；如果发布 npm 包或 Release tarball，安装方可跳过源码构建。

## 安全

发现安全问题请不要开公开 issue，按 [SECURITY.md](SECURITY.md) 的流程私下报告。
