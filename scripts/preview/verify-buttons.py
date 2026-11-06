"""在「宿主 token 混搭」的坏情况下检查按钮文字对比度（settings / workbench 两个视图）。"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PAGE = (ROOT / "scripts" / "preview" / "workbench.html").as_uri()
OUT = ROOT / "output" / "preview"
OUT.mkdir(parents=True, exist_ok=True)

BROKEN = """
:root{
  --dsw-alias-bg-base:#ffffff !important;
  --dsw-alias-bg-layer-1:#1c1f24 !important;
  --dsw-alias-bg-layer-2:#24282e !important;
  --dsw-alias-border-l1:#2c3138 !important;
  --dsw-alias-border-l2:#3a4048 !important;
  --dsw-alias-label-primary:#e8ecf1 !important;
  --dsw-alias-label-secondary:#a8b2bd !important;
}
body{background:#16181c !important;color:#e8ecf1 !important}
"""


SELECT_MEASURE = """() => {
  const selects = Array.from(document.querySelectorAll('select'))
  const parse = value => (value.match(/[\d.]+/g) || []).map(Number)
  const lum = ([r, g, b]) => {
    const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  return selects.flatMap(select => Array.from(select.options).slice(0, 3).map(option => {
    const cs = getComputedStyle(option)
    const color = parse(cs.color)
    const bg = parse(cs.backgroundColor)
    if (color.length < 3 || bg.length < 3) return { text: option.textContent, contrast: 1, color: cs.color, bg: cs.backgroundColor }
    const l1 = lum(color), l2 = lum(bg)
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    return { text: option.textContent.trim().slice(0, 14), contrast: Number(contrast.toFixed(2)), color: cs.color, bg: cs.backgroundColor }
  }))
}"""

MEASURE = """() => {
  const buttons = Array.from(document.querySelectorAll('.vr-btn'))
  const parse = value => (value.match(/[\\d.]+/g) || []).map(Number)
  const lum = ([r, g, b]) => {
    const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  return buttons.map(button => {
    const style = getComputedStyle(button)
    const color = parse(style.color)
    const alpha = (style.backgroundColor.match(/[\\d.]+/g) || ['0','0','0','0']).map(Number)
    const pageBg = [22, 24, 28]
    const a = alpha.length === 4 ? alpha[3] : 1
    const bg = [0,1,2].map(i => Math.round((alpha[i] ?? 0) * a + pageBg[i] * (1 - a)))
    const l1 = lum(color), l2 = lum(bg)
    const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    return { text: button.textContent.trim().slice(0, 14), color: style.color, bg: style.backgroundColor, contrast: Number(contrast.toFixed(2)) }
  })
}"""

targets = [("settings", "settings"), ("rewrite", "workbench"), ("input", "workbench")]
with sync_playwright() as p:
    browser = p.chromium.launch()
    for step, label in targets:
        page = browser.new_page(viewport={"width": 1400, "height": 1000}, device_scale_factor=2)
        page.goto(f"{PAGE}?step={step}&theme=dark")
        page.add_style_tag(content=BROKEN)
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / f"broken-host-{label}-{step}.png"), full_page=(step == "settings"))
        stats = page.evaluate(MEASURE)
        worst = min((item["contrast"] for item in stats), default=0)
        options = page.evaluate(SELECT_MEASURE)
        worst_option = min((item["contrast"] for item in options), default=0)
        print(f"{label}/{step}: buttons={len(stats)} worst_contrast={worst} | options={len(options)} worst_option_contrast={worst_option}")
        if options and worst_option < 3.0:
            print(f"  ✗ 下拉选项看不清：{options[:3]}")
            raise SystemExit(1)
        page.close()
    browser.close()
print("done")
