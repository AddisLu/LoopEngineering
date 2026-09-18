#!/usr/bin/env python3
"""Render one chat answer into a .pptx.

Reads a deck JSON on stdin (built by src/chat/pptx.ts — slides are already sliced, clamped and
ordered there) and draws it on python-pptx's default 16:9 canvas. Deliberately NOT the weekly
report renderer (scripts/report_pptx.py): that one fills a fixed company template and may not
invent layout, which is exactly what an arbitrary answer needs.

  --out <file.pptx>        where to write            (required)
  --probe                  print "ok <version>" if python-pptx is importable, then exit

Slide kinds: bullets | code | image (raw SVG, rasterised with PyMuPDF) | table.
Anything that fails to render degrades to a note on the slide — never to a broken file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

# The deck is Chinese; PowerPoint on Windows picks the East Asian font from the run's `ea`
# typeface, which python-pptx does not expose, so it is written into the XML directly.
EA_FONT = "Microsoft JhengHei"
LATIN_FONT = "Calibri"
MONO_FONT = "Consolas"

INK = (0x2A, 0x27, 0x23)
MUTED = (0x6B, 0x65, 0x5C)
ACCENT = (0xB2, 0x5A, 0x34)
RULE = (0xE3, 0xDC, 0xCF)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _set_font(run, *, size, bold=False, mono=False, color=INK):
    from pptx.dml.color import RGBColor
    from pptx.util import Pt

    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.name = MONO_FONT if mono else LATIN_FONT
    f.color.rgb = RGBColor(*color)
    # east-asian typeface: <a:ea typeface="..."/> next to <a:latin/>
    rpr = run._r.get_or_add_rPr()
    ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    for tag in (f"{ns}ea", f"{ns}cs"):
        el = rpr.find(tag)
        if el is None:
            from lxml import etree

            el = etree.SubElement(rpr, tag)
        el.set("typeface", MONO_FONT if mono else EA_FONT)


def _textbox(slide, left, top, width, height):
    from pptx.util import Emu

    box = slide.shapes.add_textbox(Emu(int(left)), Emu(int(top)), Emu(int(width)), Emu(int(height)))
    tf = box.text_frame
    tf.word_wrap = True
    return tf


def _blank(prs):
    # 6 is the blank layout in the default template; fall back to the last layout if absent
    layouts = prs.slide_layouts
    layout = layouts[6] if len(layouts) > 6 else layouts[-1]
    return prs.slides.add_slide(layout)


def _title(slide, text, geom):
    tf = _textbox(slide, geom["m"], geom["m"], geom["w"] - 2 * geom["m"], geom["title_h"])
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = text or ""
    _set_font(run, size=26, bold=True)
    return tf


def _rule(slide, geom):
    from pptx.dml.color import RGBColor
    from pptx.util import Emu

    top = geom["m"] + geom["title_h"]
    shape = slide.shapes.add_shape(1, Emu(int(geom["m"])), Emu(int(top)), Emu(int(geom["w"] - 2 * geom["m"])), Emu(int(geom["in"] * 0.02)))
    shape.fill.solid()
    shape.fill.fore_color.rgb = RGBColor(*RULE)
    shape.line.fill.background()
    shape.shadow.inherit = False


def _footer(slide, text, geom):
    if not text:
        return
    tf = _textbox(slide, geom["m"], geom["h"] - geom["m"], geom["w"] - 2 * geom["m"], geom["in"] * 0.3)
    run = tf.paragraphs[0].add_run()
    run.text = text
    _set_font(run, size=10, color=MUTED)


def svg_to_png(svg: str, out_dir: str, index: int) -> str | None:
    """SVG → PNG with PyMuPDF (the office venv already carries it). None when it cannot."""
    svg_path = os.path.join(out_dir, f"fig{index}.svg")
    png_path = os.path.join(out_dir, f"fig{index}.png")
    with open(svg_path, "w", encoding="utf-8") as fh:
        fh.write(svg)
    try:
        import pymupdf  # type: ignore

        doc = pymupdf.open(svg_path)
        page = doc[0]
        pix = page.get_pixmap(dpi=180)
        pix.save(png_path)
        return png_path
    except Exception as exc:  # noqa: BLE001 - any failure means "no picture", never a crash
        log(f"svg->png failed: {exc}")
        return None


def render(deck: dict, out: str) -> int:
    from pptx import Presentation
    from pptx.util import Emu, Inches, Pt

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    inch = Emu(Inches(1))
    geom = {
        "w": int(prs.slide_width),
        "h": int(prs.slide_height),
        "m": int(Inches(0.62)),
        "title_h": int(Inches(0.75)),
        "in": int(inch),
    }
    body_top = geom["m"] + geom["title_h"] + int(Inches(0.18))
    body_h = geom["h"] - body_top - int(Inches(0.8))
    body_w = geom["w"] - 2 * geom["m"]
    footer = deck.get("footer") or ""

    # ---- cover ----
    cover = _blank(prs)
    tf = _textbox(cover, geom["m"], int(Inches(2.4)), body_w, int(Inches(1.6)))
    run = tf.paragraphs[0].add_run()
    run.text = deck.get("title") or "對話回答"
    _set_font(run, size=40, bold=True)
    if deck.get("subtitle"):
        p = tf.add_paragraph()
        r2 = p.add_run()
        r2.text = deck["subtitle"]
        _set_font(r2, size=16, color=MUTED)
    _footer(cover, footer, geom)

    tmp = tempfile.mkdtemp(prefix="answer-pptx-")
    figures = 0

    for item in deck.get("slides", []):
        kind = item.get("kind")
        slide = _blank(prs)
        _title(slide, item.get("title") or "", geom)
        _rule(slide, geom)
        _footer(slide, footer, geom)

        if kind == "bullets":
            tf = _textbox(slide, geom["m"], body_top, body_w, body_h)
            first = True
            for line in item.get("bullets") or []:
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                first = False
                p.space_after = Pt(10)
                dot = p.add_run()
                dot.text = "・"
                _set_font(dot, size=18, color=ACCENT)
                run = p.add_run()
                run.text = line
                _set_font(run, size=18)

        elif kind == "code":
            tf = _textbox(slide, geom["m"], body_top, body_w, body_h)
            first = True
            for line in (item.get("code") or "").split("\n"):
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                first = False
                p.space_after = Pt(0)
                run = p.add_run()
                run.text = line or " "
                _set_font(run, size=12, mono=True)

        elif kind == "image":
            figures += 1
            png = svg_to_png(item.get("svg") or "", tmp, figures)
            if png:
                from PIL import Image  # pillow ships with the office venv

                with Image.open(png) as im:
                    iw, ih = im.size
                scale = min(body_w / iw, body_h / ih)
                w, h = int(iw * scale), int(ih * scale)
                slide.shapes.add_picture(png, Emu(int(geom["m"] + (body_w - w) / 2)), Emu(int(body_top)), Emu(w), Emu(h))
            else:
                tf = _textbox(slide, geom["m"], body_top, body_w, body_h)
                run = tf.paragraphs[0].add_run()
                run.text = "（這張圖轉不出來，請用回答下方的「存檔 → 圖」下載 SVG）"
                _set_font(run, size=16, color=MUTED)

        elif kind == "table":
            table = item.get("table") or {}
            header = table.get("header") or []
            rows = table.get("rows") or []
            cols = max(1, len(header))
            shape = slide.shapes.add_table(len(rows) + 1, cols, Emu(int(geom["m"])), Emu(int(body_top)), Emu(int(body_w)), Emu(int(min(body_h, Inches(0.42) * (len(rows) + 1)))))
            tbl = shape.table
            for c in range(cols):
                cell = tbl.cell(0, c)
                cell.text = ""
                run = cell.text_frame.paragraphs[0].add_run()
                run.text = header[c] if c < len(header) else ""
                _set_font(run, size=13, bold=True)
            for r, row in enumerate(rows, start=1):
                for c in range(cols):
                    cell = tbl.cell(r, c)
                    cell.text = ""
                    run = cell.text_frame.paragraphs[0].add_run()
                    run.text = row[c] if c < len(row) else ""
                    _set_font(run, size=12)
            if item.get("note"):
                tf = _textbox(slide, geom["m"], geom["h"] - int(Inches(1.05)), body_w, int(Inches(0.3)))
                run = tf.paragraphs[0].add_run()
                run.text = item["note"]
                _set_font(run, size=11, color=MUTED)

    prs.save(out)
    return len(prs.slides._sldIdLst)  # noqa: SLF001 - slide count


def main() -> None:
    ap = argparse.ArgumentParser(description="render one chat answer into a .pptx")
    ap.add_argument("--out", help="output .pptx path")
    ap.add_argument("--probe", action="store_true", help="report whether python-pptx is importable")
    args = ap.parse_args()

    if args.probe:
        try:
            import pptx  # noqa: F401

            print(f"ok {pptx.__version__}")
            return
        except Exception as exc:  # noqa: BLE001
            print(f"missing {exc}")
            sys.exit(3)

    if not args.out:
        log("--out is required")
        sys.exit(2)
    raw = sys.stdin.read()
    try:
        deck = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        log(f"bad deck json: {exc}")
        sys.exit(2)
    try:
        n = render(deck, args.out)
    except Exception as exc:  # noqa: BLE001
        log(f"render failed: {exc}")
        sys.exit(1)
    print(f"ok {n}")


if __name__ == "__main__":
    main()
