"""渲染插件真实客户端 bundle 的截图（预览/验收用）。"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PAGE = (ROOT / "scripts" / "preview" / "workbench.html").as_uri()
OUT = ROOT / "output" / "preview"

# (文件名, 步骤, 主题, 宽, 高, 是否演示"执行中", 是否整页)
SHOTS = [
    ("input-light", "input", "light", 1440, 900, False, False),
    ("analyze-light", "analyze", "light", 1440, 900, False, True),
    ("rewrite-light", "rewrite", "light", 1440, 900, False, True),
    ("match-dark", "match", "dark", 1440, 900, True, False),
    ("generate-light", "generate", "light", 1440, 900, False, True),
    ("compose-light", "compose", "light", 1440, 900, False, True),
    ("settings-light", "settings", "light", 1440, 1500, False, True),
    ("settings-narrow", "settings", "light", 980, 1500, False, True),
]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on("console", lambda message: errors.append(f"console.{message.type}: {message.text}") if message.type == "error" else None)
        for name, step, theme, width, height, busy, full in SHOTS:
            page.set_viewport_size({"width": width, "height": height})
            suffix = f"&busy=1" if busy else ""
            page.goto(f"{PAGE}?step={step}&theme={theme}{suffix}")
            page.wait_for_timeout(1800)
            page.screenshot(path=str(OUT / f"{name}.png"), full_page=full)
            print(f"shot {name}")
        browser.close()
        if errors:
            print("页面错误：", file=sys.stderr)
            for error in errors:
                print(" -", error, file=sys.stderr)
            return 1
    print(f"done -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
