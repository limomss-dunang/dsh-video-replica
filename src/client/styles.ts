/**
 * 工作台样式（纯 CSS 字符串，随插件卸载一起移除）。
 *
 * 设计语言沿用 dsh-imagegen 的工作台：接管中栏、左侧流程轨道、中间主舞台、
 * 右侧详情与日志；颜色全部走宿主主题变量（--dsw-alias-*），因此明暗主题自动跟随。
 */

export const VIEW_SELECTOR = '[data-dvr-view]'
export const ACTIVE_ATTR = 'data-dvr-active'
export const ENTRY_ATTR = 'data-dvr-entry'
export const ENTRY_HOST_ATTR = 'data-dvr-entry-host'

export function shellStyle(): string {
  return `
${VIEW_SELECTOR}{
  display:none;min-width:0;min-height:0;grid-column:1;grid-row:1;
  background:transparent;color:inherit;
  z-index:60;overflow:hidden;
}
html[${ACTIVE_ATTR}] :is([data-pane="conversation"],[class*="centerCol"]){
  position:relative;display:grid!important;grid-template-columns:minmax(0,1fr);
  grid-template-rows:minmax(0,1fr);overflow:hidden;
}
html[${ACTIVE_ATTR}] ${VIEW_SELECTOR}{display:flex!important}
html[${ACTIVE_ATTR}] :is([data-pane="conversation"],[class*="centerCol"])>:not(${VIEW_SELECTOR}){display:none!important}

/* ---------- 侧边栏入口 ---------- */
[${ENTRY_HOST_ATTR}]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;padding:3px;
  border:1px solid color-mix(in srgb,currentColor 17%,transparent);border-radius:10px;margin:2px 0}
[data-dsh-imagegen-session-tabs]:has([${ENTRY_ATTR}]){grid-template-columns:repeat(3,minmax(0,1fr))}
[${ENTRY_ATTR}],[${ENTRY_HOST_ATTR}]>button{
  display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;height:30px;padding:0 8px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));
  cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;transition:background .15s,color .15s;
}
[${ENTRY_ATTR}]:hover,[${ENTRY_HOST_ATTR}]>button:hover{color:inherit;
  background:color-mix(in srgb,currentColor 9%,transparent)}
[${ENTRY_ATTR}][data-active]{color:inherit;
  background:color-mix(in srgb,currentColor 9%,transparent);font-weight:600}
[data-sidebar-collapsed] [${ENTRY_ATTR}]{width:34px;height:34px;padding:0}
[data-sidebar-collapsed] .vr-entry-label{display:none}

/* ---------- 工作台骨架 ---------- */
.vr-app{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;
  font-size:13px;line-height:1.55;letter-spacing:.01em;
  background:linear-gradient(180deg,transparent 0%,transparent 100%)}
.vr-header{display:flex;align-items:center;gap:12px;padding:12px 18px;flex:none;
  border-bottom:1px solid color-mix(in srgb,currentColor 17%,transparent);background:color-mix(in srgb,currentColor 4%,transparent)}
.vr-brand{display:flex;align-items:center;gap:10px;min-width:0}
.vr-brand-mark{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;color:#fff;
  background:linear-gradient(135deg,var(--dsw-alias-brand-primary,#3b6ef6),#7b46f0);
  box-shadow:0 4px 12px rgba(59,110,246,.28)}
.vr-brand-text{display:flex;flex-direction:column;min-width:0}
.vr-brand-title{font-weight:650;font-size:14px;white-space:nowrap}
.vr-brand-sub{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-header-spacer{flex:1}
.vr-header-run{display:flex;align-items:center;gap:6px;min-width:0;padding:4px 10px;border-radius:8px;
  background:color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));font-size:12px;
  max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.vr-body{display:flex;flex:1;min-height:0}

/* ---------- 左栏：流程 + 历史 ---------- */
.vr-rail{width:252px;flex:none;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid color-mix(in srgb,currentColor 17%,transparent);background:color-mix(in srgb,currentColor 4%,transparent)}
.vr-rail-section{padding:12px 12px 8px}
.vr-rail-title{font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));margin:0 0 8px 2px}
.vr-new{width:100%;height:34px;border-radius:9px;border:1px dashed color-mix(in srgb,currentColor 30%,transparent);
  background:transparent;color:inherit;font:inherit;font-size:12.5px;
  display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;transition:.15s}
.vr-new:hover{border-color:var(--dsw-alias-brand-primary,#3b6ef6);color:var(--dsw-alias-brand-primary,#3b6ef6);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 6%,transparent)}
.vr-steps{display:flex;flex-direction:column;gap:2px;padding:4px 8px 8px}
.vr-step{display:flex;gap:10px;align-items:flex-start;padding:8px 8px;border-radius:9px;border:0;
  background:transparent;text-align:left;font:inherit;cursor:pointer;position:relative;transition:background .15s}
.vr-step:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
.vr-step[data-active]{background:color-mix(in srgb,currentColor 9%,transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 17%,transparent)}
.vr-step-idx{width:22px;height:22px;border-radius:50%;flex:none;display:grid;place-items:center;
  font-size:11px;font-weight:650;border:1.5px solid color-mix(in srgb,currentColor 30%,transparent);
  color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));background:transparent;transition:.2s}
.vr-step[data-status="running"] .vr-step-idx{border-color:var(--dsw-alias-brand-primary,#3b6ef6);
  color:var(--dsw-alias-brand-primary,#3b6ef6);animation:vr-pulse 1.4s ease-in-out infinite}
.vr-step[data-status="done"] .vr-step-idx{border-color:var(--dsw-alias-state-success-primary,#18a058);
  background:var(--dsw-alias-state-success-primary,#18a058);color:#fff}
.vr-step[data-status="failed"] .vr-step-idx{border-color:var(--dsw-alias-state-error-primary,#d92d20);
  background:var(--dsw-alias-state-error-primary,#d92d20);color:#fff}
.vr-step[data-status="skipped"] .vr-step-idx{border-style:dashed;opacity:.6}
@keyframes vr-pulse{0%,100%{box-shadow:0 0 0 0 rgba(59,110,246,.35)}50%{box-shadow:0 0 0 4px rgba(59,110,246,.08)}}
.vr-step-text{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}
.vr-step-label{font-size:12.5px;font-weight:600;color:inherit}
.vr-step-msg{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;max-width:150px}
.vr-step[data-status="failed"] .vr-step-msg{color:var(--dsw-alias-state-error-primary,#d92d20)}
.vr-progress{height:2px;border-radius:2px;background:color-mix(in srgb,currentColor 17%,transparent);overflow:hidden;margin-top:2px}
.vr-progress>i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#3b6ef6);border-radius:2px;transition:width .4s}

.vr-history{flex:1;min-height:0;display:flex;flex-direction:column;padding:6px 8px 12px;overflow:auto}
.vr-run{display:flex;gap:8px;align-items:center;padding:7px 8px;border-radius:8px;border:0;background:transparent;
  font:inherit;cursor:pointer;text-align:left;width:100%;transition:background .15s}
.vr-run:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
.vr-run[data-active]{background:color-mix(in srgb,currentColor 9%,transparent)}
.vr-run-thumb{width:30px;height:40px;border-radius:6px;flex:none;object-fit:cover;
  background:linear-gradient(135deg,#dbe3ff,#f0e4ff);border:1px solid color-mix(in srgb,currentColor 17%,transparent)}
.vr-run-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.vr-run-title{font-size:12px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vr-run-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));display:flex;gap:6px;align-items:center}
.vr-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;font-size:10px;
  background:color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));white-space:nowrap}
.vr-pill[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#18a058) 14%,transparent);
  color:var(--dsw-alias-state-success-primary,#18a058)}
.vr-pill[data-tone="warn"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 16%,transparent);
  color:var(--dsw-alias-state-warn-primary,#b45309)}
.vr-pill[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 14%,transparent);
  color:var(--dsw-alias-state-error-primary,#d92d20)}
.vr-pill[data-tone="brand"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 14%,transparent);
  color:var(--dsw-alias-brand-primary,#3b6ef6)}

/* ---------- 中栏：主舞台 ---------- */
.vr-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow:auto;
  background:transparent;padding:18px 20px 40px}
.vr-stage{max-width:980px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.vr-stage-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.vr-h1{font-size:17px;font-weight:680;margin:0;letter-spacing:-.01em}
.vr-muted{color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));font-size:12px}
.vr-card{border:1px solid color-mix(in srgb,currentColor 17%,transparent);border-radius:12px;
  background:color-mix(in srgb,currentColor 4%,transparent);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.vr-card-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
.vr-card-title{font-size:12.5px;font-weight:650;margin:0;display:flex;align-items:center;gap:6px}
.vr-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));margin:0}
.vr-row{display:flex;gap:10px;flex-wrap:wrap}
.vr-row>.vr-field{flex:1;min-width:200px}
.vr-field{display:flex;flex-direction:column;gap:4px}
.vr-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent))}
.vr-input,.vr-textarea,.vr-select{width:100%;box-sizing:border-box;border-radius:8px;
  border:1px solid color-mix(in srgb,currentColor 20%,transparent);
  background:color-mix(in srgb,currentColor 5%,transparent);
  color:inherit;-webkit-text-fill-color:currentColor;font:inherit;font-size:12.5px;padding:7px 10px;outline:none;transition:.15s}
.vr-input:focus,.vr-textarea:focus,.vr-select:focus{border-color:var(--dsw-alias-brand-primary,#3b6ef6);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 14%,transparent)}
.vr-textarea{resize:vertical;min-height:64px;line-height:1.5}
/* 按钮：文字色跟随所在容器（容器文字在宿主主题下已确认可见），
   底色用同色半透明；避免混搭「表面 token」与「文字 token」造成白字白底。 */
.vr-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:32px;padding:0 14px;border-radius:8px;box-sizing:border-box;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:color-mix(in srgb,currentColor 6%,transparent);
  color:inherit;-webkit-text-fill-color:currentColor;
  font:inherit;font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;
  transition:background .15s,border-color .15s;white-space:nowrap}
.vr-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent);
  border-color:color-mix(in srgb,currentColor 34%,transparent)}
.vr-btn:active:not(:disabled){background:color-mix(in srgb,currentColor 18%,transparent)}
.vr-btn:disabled{opacity:.45;cursor:not-allowed}
.vr-btn[data-variant="primary"]{background:#3462e8;border-color:#3462e8;color:#fff;-webkit-text-fill-color:#fff}
.vr-btn[data-variant="primary"]:hover:not(:disabled){background:#3f6ff0;border-color:#3f6ff0;color:#fff}
.vr-btn[data-variant="danger"]{color:#e5484d;-webkit-text-fill-color:#e5484d;
  background:color-mix(in srgb,#e5484d 8%,transparent);border-color:color-mix(in srgb,#e5484d 45%,transparent)}
.vr-btn[data-variant="ghost"]{border-color:transparent;background:transparent}
.vr-btn[data-variant="ghost"]:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent)}
.vr-btn[data-size="sm"]{height:26px;padding:0 9px;font-size:11.5px;border-radius:7px}

.vr-drop{border:1.5px dashed color-mix(in srgb,currentColor 30%,transparent);border-radius:12px;padding:18px;
  display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;transition:.18s;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 2%,transparent);text-align:center}
.vr-drop:hover{border-color:var(--dsw-alias-brand-primary,#3b6ef6);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 6%,transparent)}
.vr-drop>strong{font-size:12.5px}
.vr-drop>span{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent))}
.vr-thumbs{display:flex;gap:8px;flex-wrap:wrap}
.vr-thumb{width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid color-mix(in srgb,currentColor 17%,transparent)}
.vr-thumb-wrap{position:relative}
.vr-thumb-x{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:0;
  background:var(--dsw-alias-state-error-primary,#d92d20);color:#fff;font-size:11px;line-height:1;cursor:pointer}

.vr-score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}
.vr-score{border-radius:10px;padding:8px 10px;background:color-mix(in srgb,currentColor 9%,transparent);display:flex;flex-direction:column;gap:2px}
.vr-score>b{font-size:18px;font-weight:700;line-height:1.1}
.vr-score>span{font-size:10.5px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent))}
.vr-score[data-tone="good"]>b{color:var(--dsw-alias-state-success-primary,#18a058)}
.vr-score[data-tone="mid"]>b{color:var(--dsw-alias-state-warn-primary,#d97706)}
.vr-score[data-tone="low"]>b{color:var(--dsw-alias-state-error-primary,#d92d20)}
.vr-dna{display:flex;flex-wrap:wrap;gap:6px}
.vr-dna>span{font-size:11.5px;padding:4px 9px;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 9%,transparent);
  color:var(--dsw-alias-brand-primary,#3b6ef6);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#3b6ef6) 18%,transparent)}

.vr-frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
.vr-frame{margin:0;border-radius:9px;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 17%,transparent);
  background:color-mix(in srgb,currentColor 9%,transparent);position:relative;aspect-ratio:9/16}
.vr-frame img{width:100%;height:100%;object-fit:cover;display:block}
.vr-frame>figcaption{position:absolute;left:0;right:0;bottom:0;padding:2px 6px;font-size:10px;color:#fff;
  background:linear-gradient(transparent,rgba(0,0,0,.62));text-align:center}
.vr-frame[data-kind="ref"]{aspect-ratio:3/4}
.vr-frame-actions{position:absolute;top:4px;right:4px;display:flex;gap:4px;opacity:0;transition:.15s}
.vr-frame:hover .vr-frame-actions{opacity:1}
.vr-frame-err{display:grid;place-items:center;height:100%;padding:8px;text-align:center;font-size:10.5px;
  color:var(--dsw-alias-state-error-primary,#d92d20)}

.vr-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
.vr-table th{text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));
  padding:6px 8px;border-bottom:1px solid color-mix(in srgb,currentColor 17%,transparent);white-space:nowrap}
.vr-table td{padding:6px 8px;border-bottom:1px solid color-mix(in srgb,currentColor 17%,transparent);vertical-align:top}
.vr-table tr:last-child td{border-bottom:0}
.vr-table .vr-cell-input{width:100%;box-sizing:border-box;border-radius:6px;border:1px solid transparent;
  background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:4px 6px;resize:none;min-height:26px;overflow:auto}
.vr-table .vr-cell-input:hover{border-color:color-mix(in srgb,currentColor 17%,transparent)}
.vr-table .vr-cell-input:focus{border-color:var(--dsw-alias-brand-primary,#3b6ef6);background:color-mix(in srgb,currentColor 6%,transparent);outline:none}
.vr-idx{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));font-size:11px}

.vr-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:color-mix(in srgb,currentColor 9%,transparent);
  border:1px solid color-mix(in srgb,currentColor 17%,transparent);flex-wrap:wrap}
.vr-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));font:inherit;font-size:12px;
  font-weight:600;padding:5px 12px;border-radius:8px;cursor:pointer;transition:.15s;display:flex;gap:6px;align-items:center}
.vr-tab:hover{color:inherit}
.vr-tab[data-active]{background:color-mix(in srgb,currentColor 10%,transparent);color:inherit;-webkit-text-fill-color:currentColor;
  box-shadow:0 1px 3px rgba(15,23,42,.08)}

.vr-seg{border:1px solid color-mix(in srgb,currentColor 17%,transparent);border-radius:10px;padding:10px 12px;
  display:flex;flex-direction:column;gap:6px;background:transparent}
.vr-seg-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vr-seg-no{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:11px;font-weight:700;
  background:color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));flex:none}
.vr-seg-prompt{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));font-family:ui-monospace,Menlo,Consolas,monospace;
  background:color-mix(in srgb,currentColor 9%,transparent);border-radius:7px;padding:6px 8px;max-height:96px;overflow:auto;
  white-space:pre-wrap;word-break:break-word}
.vr-video{width:100%;max-height:520px;border-radius:12px;background:#000;border:1px solid color-mix(in srgb,currentColor 17%,transparent)}

.vr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  padding:48px 20px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));text-align:center;font-size:12.5px}
.vr-empty-mark{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;
  background:color-mix(in srgb,currentColor 9%,transparent);color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent))}

.vr-banner{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:9px;font-size:12px;
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 10%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 26%,transparent);
  color:inherit}
.vr-banner[data-tone="err"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 9%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d92d20) 26%,transparent)}
.vr-banner[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#18a058) 9%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#18a058) 26%,transparent)}

/* ---------- 右栏：详情 + 日志 ---------- */
.vr-side{width:296px;flex:none;display:flex;flex-direction:column;min-height:0;
  border-left:1px solid color-mix(in srgb,currentColor 17%,transparent);background:color-mix(in srgb,currentColor 4%,transparent)}
.vr-side-section{padding:12px 14px;border-bottom:1px solid color-mix(in srgb,currentColor 17%,transparent)}
.vr-kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:3px 0}
.vr-kv>span:first-child{color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));flex:none}
.vr-kv>span:last-child{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;max-width:170px}
.vr-logs{flex:1;min-height:120px;overflow:auto;padding:8px 12px 16px;display:flex;flex-direction:column;gap:3px;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.5}
.vr-log{display:flex;gap:6px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 62%,transparent));word-break:break-word}
.vr-log>time{flex:none;opacity:.7}
.vr-log[data-level="warn"]{color:var(--dsw-alias-state-warn-primary,#b45309)}
.vr-log[data-level="error"]{color:var(--dsw-alias-state-error-primary,#d92d20)}

.vr-spin{width:13px;height:13px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;
  animation:vr-rotate .8s linear infinite;display:inline-block;flex:none}
@keyframes vr-rotate{to{transform:rotate(360deg)}}

/* ---------- 设置页 ---------- */
.vr-settings{display:flex;flex-direction:column;gap:14px;font-size:12.5px}
.vr-settings .vr-card{padding:16px}
.vr-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.vr-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vr-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px}
.vr-switch input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#3b6ef6)}

@media (max-width:1180px){
  .vr-side{display:none}
  .vr-main{padding:14px 14px 32px}
}
@media (max-width:900px){
  .vr-rail{width:190px}
  .vr-step-msg{display:none}
}
.vr-step[data-stale]{opacity:.62}
.vr-step[data-stale] .vr-step-msg{color:#b26a00;-webkit-text-fill-color:#b26a00;font-style:italic}
.vr-step[data-stale] .vr-step-idx{border-color:color-mix(in srgb,#b26a00 45%,transparent);color:#b26a00;-webkit-text-fill-color:#b26a00}
/* 原生下拉：弹层由浏览器绘制，不跟我们的半透明底色走，
   深色主题下会变成「白底 + 浅色字」看不见。这里把选项钉成深字白底。 */
.vr-select,select.vr-input{color-scheme:light}
.vr-select option,select.vr-input option{background:#ffffff;color:#1f2329;-webkit-text-fill-color:#1f2329}
.vr-select optgroup,select.vr-input optgroup{background:#ffffff;color:#1f2329}

`
}
