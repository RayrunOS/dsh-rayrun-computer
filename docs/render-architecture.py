"""Render the architecture diagram from README.md / README.zh-CN.md to PNG.

Draws the same flowchart the mermaid block describes, so the README keeps an
image that platforms without mermaid (chat apps, issue trackers) can show.

    python .mermaid/render.py
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SCALE = 2
W, H = 1180, 400

INK = "#1f2430"
MUTED = "#5b6472"
BORDER = "#8a94a6"
ACCENT = "#4b6ef5"
FILL = "#f7f9ff"
GROUP = "#eef2ff"
FONT_EN = "C:/Windows/Fonts/segoeui.ttf"
FONT_EN_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_ZH = "C:/Windows/Fonts/msyh.ttc"
FONT_ZH_BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def font(path, size):
    return ImageFont.truetype(path, int(size * SCALE))


def box(draw, xy, label, sub, font_bold, font_reg, pad=18):
    x0, y0, x1, y1 = [v * SCALE for v in xy]
    draw.rounded_rectangle([x0, y0, x1, y1], radius=10 * SCALE, fill=FILL, outline=BORDER, width=max(1, SCALE))
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    draw.text((cx, cy - 11 * SCALE), label, font=font_bold, fill=INK, anchor="mm")
    draw.text((cx, cy + 13 * SCALE), sub, font=font_reg, fill=MUTED, anchor="mm")


def group(draw, xy, label, font_reg):
    x0, y0, x1, y1 = [v * SCALE for v in xy]
    draw.rounded_rectangle(
        [x0, y0, x1, y1], radius=12 * SCALE, fill=GROUP, outline=ACCENT, width=max(1, SCALE)
    )
    draw.text((x0 + 12 * SCALE, y0 - 8 * SCALE), label, font=font_reg, fill=ACCENT, anchor="ls")


def arrow(draw, points, dashed=False, head=True, tail=False, color=INK):
    pts = [(x * SCALE, y * SCALE) for x, y in points]
    dash = 7 * SCALE if dashed else None
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        if not dashed:
            draw.line([x0, y0, x1, y1], fill=color, width=max(1, SCALE))
            continue
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0:
            continue
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        pos = 0.0
        while pos < length:
            end = min(pos + dash, length)
            draw.line([x0 + ux * pos, y0 + uy * pos, x0 + ux * end, y0 + uy * end], fill=color, width=max(1, SCALE))
            pos = end + dash
    size = 9 * SCALE
    spread = 0.42

    def head_at(tip, frm):
        angle = math.atan2(tip[1] - frm[1], tip[0] - frm[0])
        draw.polygon(
            [
                (tip[0], tip[1]),
                (tip[0] - size * math.cos(angle - spread), tip[1] - size * math.sin(angle - spread)),
                (tip[0] - size * math.cos(angle + spread), tip[1] - size * math.sin(angle + spread)),
            ],
            fill=color,
        )

    if head:
        head_at(pts[-1], pts[-2])
    if tail:
        head_at(pts[0], pts[1])


def label(draw, xy, text, font_reg, color=MUTED):
    """A label with a white mask, the way mermaid keeps edge text off the line."""
    x, y = xy[0] * SCALE, xy[1] * SCALE
    box = draw.textbbox((x, y), text, font=font_reg, anchor="mm")
    pad = 4 * SCALE
    draw.rectangle([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], fill="white")
    draw.text((x, y), text, font=font_reg, fill=color, anchor="mm")


def render(copy, out_path):
    img = Image.new("RGB", (W * SCALE, H * SCALE), "white")
    draw = ImageDraw.Draw(img)

    f_title = font(copy["font_bold"], 17)
    f_sub = font(copy["font"], 13)
    f_note = font(copy["font"], 12)
    f_edge = font(copy["font"], 12)

    group(draw, (40, 70, 400, 380), copy["group"], f_note)
    box(draw, (70, 105, 370, 195), copy["page"][0], copy["page"][1], f_title, f_sub)
    box(draw, (70, 275, 370, 365), copy["host"][0], copy["host"][1], f_title, f_sub)
    box(draw, (500, 150, 760, 260), copy["api"][0], copy["api"][1], f_title, f_sub)
    box(draw, (860, 150, 1140, 260), copy["vm"][0], copy["vm"][1], f_title, f_sub)

    arrow(draw, [(220, 195), (220, 275)], head=True, tail=True)
    arrow(draw, [(370, 320), (500, 240)])
    label(draw, (505, 300), copy["edge_https"], f_edge)
    arrow(draw, [(760, 205), (860, 205)])
    arrow(draw, [(370, 120), (600, 70), (860, 185)], dashed=True)
    label(draw, (615, 52), copy["edge_vnc"], f_edge)

    img.save(out_path)
    print(f"{out_path} -> {img.size[0]}x{img.size[1]}")


EN = {
    "font": FONT_EN,
    "font_bold": FONT_EN_BOLD,
    "group": "Your computer",
    "page": ("DSH page", "sidebar · desktop · toggle"),
    "host": ("Plugin host", "same-origin RPC · tools"),
    "api": ("Rayrun API", "api.rayrunos.com/v1"),
    "vm": ("Cloud computer", "Linux · persistent workspace"),
    "edge_https": "HTTPS · token stays local",
    "edge_vnc": "noVNC over ingress",
}

ZH = {
    "font": FONT_ZH,
    "font_bold": FONT_ZH_BOLD,
    "group": "你的电脑",
    "page": ("DSH 页面", "侧边栏 · 桌面 · 切换"),
    "host": ("插件 Host", "同源 RPC · 工具"),
    "api": ("Rayrun API", "api.rayrunos.com/v1"),
    "vm": ("云电脑", "Linux · 持久工作区"),
    "edge_https": "HTTPS · Token 只留本地",
    "edge_vnc": "noVNC 走 ingress",
}

if __name__ == "__main__":
    render(EN, ROOT / "docs" / "architecture.png")
    render(ZH, ROOT / "docs" / "architecture.zh.png")
