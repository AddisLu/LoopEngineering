#!/usr/bin/env python3
"""Deterministic fill-only PPTX renderer for the weekly report deck (see
docs/report-pptx-authoring.md). Opens the company's fixed-layout template
(fillready.pptx) and ONLY fills text/pictures/colors into pre-named LOOP:
shapes -- it never generates or alters layout at runtime. The template is
company-confidential and never lives in this repo; scripts/report_pptx_fixture.py
provides a structurally-identical throwaway template for development/CI.

Target runtime: the company Windows 11 machine, Python 3.8.10 -- this script
is restricted to <=Python 3.8 syntax (no `dict | dict`, no `str.removeprefix`,
no `match` statements; type hints use the `typing` module) and to stdlib +
python-pptx (target version 1.0.2).

Four modes:
  --render <spec on stdin> --template T --manifest M --out O
  --probe <pptx>
  --validate --template T --manifest M
  --selftest
See each cmd_* function below, or --help, for details.
"""
import sys

if sys.version_info < (3, 8):
    sys.stderr.write(
        'report_pptx.py requires Python 3.8 or newer (found %s).\n' % sys.version.split()[0]
    )
    sys.exit(2)

import argparse
import copy
import hashlib
import json
import os
import struct
import tempfile
import zlib
from typing import Any, Dict, List, Optional, Set

try:
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.util import Emu, Pt
except ImportError:
    sys.stderr.write(
        'python-pptx is required but not installed.\n'
        'Install it with:\n'
        '  python -m pip install --user python-pptx==1.0.2\n'
    )
    sys.exit(2)


def _force_utf8_streams():
    # Company deployment target is Windows 11 + Python 3.8.10, whose console default
    # encoding is often cp950/cp1252, not UTF-8 -- without this, printing Chinese slide
    # text raises UnicodeEncodeError instead of just writing bytes (copied from
    # scripts/openproject_dump.py, same rationale).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:
            pass


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


SHAPE_PREFIX_DEFAULT = 'LOOP:'

# StatusItem.color ('black'|'blue'|'red') -> manifest colors{} key. The manifest's keys
# describe *business meaning* (carried-over / new / highlighted-risk), not raw color
# names, so this fixed mapping is the only place that translates between the two.
COLOR_KEY_MAP = {'black': 'carried', 'blue': 'new', 'red': 'highlight'}

# Collected across one --render/--selftest invocation; reset by _reset_warnings(). A
# module-level list (rather than threading a `warnings` param through every fill_*
# helper) keeps the core function signatures the ones documented in the plan.
_WARNINGS: List[str] = []


def _reset_warnings() -> None:
    global _WARNINGS
    _WARNINGS = []


def _warn(msg: str) -> None:
    _WARNINGS.append(msg)
    log('warning: %s' % msg)


def _get_warnings() -> List[str]:
    return list(_WARNINGS)


def _die(msg: str) -> None:
    log('error: %s' % msg)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Shape indexing
# ---------------------------------------------------------------------------

def _shapes_on_slide(slide: Any, prefix: str) -> Dict[str, Any]:
    """{shape_name: shape} for shapes on one slide whose name starts with prefix,
    recursing into group shapes. Later duplicate names overwrite earlier ones (a
    template-authoring bug -- --probe is how you catch that before it bites)."""
    named: Dict[str, Any] = {}

    def collect(shapes):
        for shape in shapes:
            name = getattr(shape, 'name', '')
            if name and name.startswith(prefix):
                named[name] = shape
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                collect(shape.shapes)

    collect(slide.shapes)
    return named


def index_shapes(prs: Any, prefix: str) -> Dict[int, Dict[str, Any]]:
    """{slide_idx: {shape_name: shape}}, only shapes named with `prefix` (manifest's
    shape_prefix, e.g. 'LOOP:'); recurses into group shapes."""
    return {idx: _shapes_on_slide(slide, prefix) for idx, slide in enumerate(prs.slides)}


# ---------------------------------------------------------------------------
# Text / style-preserving fill primitives
# ---------------------------------------------------------------------------

def _text_frame_of(shape: Any) -> Optional[Any]:
    # Regular shapes expose has_text_frame (False for e.g. Picture/Chart); table _Cell
    # objects have no has_text_frame attribute at all but ALWAYS have a text_frame, so a
    # naive `getattr(shape, 'has_text_frame', False)` guard would wrongly treat every
    # cell as text-frame-less. try/except handles both shapes and cells uniformly.
    try:
        return shape.text_frame
    except Exception:
        return None


def _collapse_to_single_run(para: Any, text: str) -> None:
    """Sets para's displayed text to `text` via its first existing run (preserving that
    run's font/color/etc.), dropping any other runs on the paragraph; falls back to
    python-pptx's Paragraph.text setter (which creates a fresh, unstyled run) only when
    the paragraph started with no runs at all."""
    if para.runs:
        para.runs[0].text = text
        for extra in list(para.runs[1:]):
            extra._r.getparent().remove(extra._r)
    else:
        para.text = text


def set_text_preserve_style(shape: Any, text: str) -> None:
    """Rewrites only the text of shape's first paragraph/run, preserving every style
    attribute (font family/size/color/bold/alignment/...) already authored on the
    template -- this is the entire reason the renderer exists instead of regenerating
    slides. Extra runs on the first paragraph and any extra paragraphs are dropped. A
    shape with no text_frame is a template-authoring bug: warn to stderr and skip."""
    tf = _text_frame_of(shape)
    if tf is None:
        log('warning: shape %r has no text_frame -- skipped' % getattr(shape, 'name', '?'))
        return
    _collapse_to_single_run(tf.paragraphs[0], text)
    for extra_p in list(tf.paragraphs[1:]):
        extra_p._p.getparent().remove(extra_p._p)


def set_status_paragraphs(
    shape: Any, items: List[Dict[str, Any]], colors: Dict[str, str], max_item_chars: int = 200
) -> None:
    """Fills a status shape with one paragraph per item, each run colored per
    COLOR_KEY_MAP + manifest colors{}. The first paragraph reuses the shape's existing
    paragraph (preserving its pPr/run style); paragraphs 2..N are deep XML clones of the
    first so they inherit the exact same style -- python-pptx's public add_paragraph()
    always creates a bare, unstyled paragraph instead."""
    tf = _text_frame_of(shape)
    if tf is None:
        log('warning: status shape %r has no text_frame -- skipped' % getattr(shape, 'name', '?'))
        return
    if not items:
        set_text_preserve_style(shape, '')
        return

    base_el = tf.paragraphs[0]._p
    for extra_p in list(tf.paragraphs[1:]):
        extra_p._p.getparent().remove(extra_p._p)

    insert_after = base_el
    for _ in range(len(items) - 1):
        clone = copy.deepcopy(base_el)
        insert_after.addnext(clone)
        insert_after = clone

    for para, item in zip(tf.paragraphs, items):
        text = str(item.get('text') or '')
        if len(text) > max_item_chars:
            text = text[: max(0, max_item_chars - 1)] + '…'
            _warn('status item truncated to %d chars: %r' % (max_item_chars, str(item.get('text') or '')[:40]))
        _collapse_to_single_run(para, text)
        color_key = COLOR_KEY_MAP.get(item.get('color'), 'new')
        hex_color = colors.get(color_key)
        if hex_color and para.runs:
            para.runs[0].font.color.rgb = RGBColor.from_string(hex_color)


# ---------------------------------------------------------------------------
# Main-page fill
# ---------------------------------------------------------------------------

def _cp_shape_name(template: str, n: int) -> str:
    return template.format(n=n)


def fill_main(slide: Any, shapes: Dict[str, Any], project: Dict[str, Any], manifest: Dict[str, Any]) -> None:
    """Fills one 'main' pool slide: title, benefit, status block, checkpoint label/date/at
    triples, and moves the progress marker to align under the current checkpoint."""
    main_cfg = manifest.get('main', {})
    shape_names = main_cfg.get('shapes', {})

    title_shape = shapes.get(shape_names.get('title', ''))
    if title_shape is not None:
        fab, name = project.get('fab', ''), project.get('name', '')
        set_text_preserve_style(title_shape, ('%s %s' % (fab, name)).strip())
    else:
        _warn('main title shape not found for project %r' % project.get('key'))

    benefit_shape = shapes.get(shape_names.get('benefit', ''))
    if benefit_shape is not None:
        set_text_preserve_style(benefit_shape, project.get('benefit') or '')

    status_shape = shapes.get(shape_names.get('status', ''))
    if status_shape is not None:
        set_status_paragraphs(
            status_shape,
            project.get('status_items') or [],
            manifest.get('colors', {}),
            manifest.get('summary', {}).get('max_item_chars', 200),
        )
    else:
        _warn('main status shape not found for project %r' % project.get('key'))

    capacity = main_cfg.get('checkpoints', 0)
    cp_shapes = main_cfg.get('checkpoint_shapes', {})
    checkpoints = (project.get('roadmap') or {}).get('checkpoints') or []
    anchor_shapes: List[Any] = []
    for n in range(1, capacity + 1):
        idx = n - 1
        label_shape = shapes.get(_cp_shape_name(cp_shapes.get('label', ''), n))
        date_shape = shapes.get(_cp_shape_name(cp_shapes.get('date', ''), n))
        at_shape = shapes.get(_cp_shape_name(cp_shapes.get('at', ''), n))
        if idx < len(checkpoints):
            cp = checkpoints[idx]
            if label_shape is not None:
                set_text_preserve_style(label_shape, cp.get('label') or '')
            if date_shape is not None:
                set_text_preserve_style(date_shape, cp.get('date') or '')
            if at_shape is not None:
                set_text_preserve_style(at_shape, cp.get('at') or '')
            anchor_shapes.append(label_shape)
        else:
            # unused checkpoint box in the template's capacity -- clear its text
            for s in (label_shape, date_shape, at_shape):
                if s is not None:
                    set_text_preserve_style(s, '')
            anchor_shapes.append(None)

    marker_shape = shapes.get(shape_names.get('marker', ''))
    roadmap = project.get('roadmap') or {}
    current_index = roadmap.get('current_index', 0)
    if marker_shape is not None and checkpoints:
        clamped = max(0, min(int(current_index), len(checkpoints) - 1))
        anchor = anchor_shapes[clamped] if clamped < len(anchor_shapes) else None
        if anchor is not None:
            # Horizontal-only realignment -- geometry/size of the marker itself is
            # never touched, only its left offset, so it slides along the timeline to
            # sit centered under the current checkpoint's label box.
            marker_shape.left = int(anchor.left + (anchor.width - marker_shape.width) / 2)
        else:
            _warn('move_marker: no anchor shape for checkpoint index %d (project %r)' % (clamped, project.get('key')))


# ---------------------------------------------------------------------------
# Explain-page fill
# ---------------------------------------------------------------------------

def _apply_font_like(run: Any, template_shape: Optional[Any]) -> None:
    if template_shape is None:
        return
    tf = _text_frame_of(template_shape)
    if tf is None or not tf.paragraphs or not tf.paragraphs[0].runs:
        return
    src = tf.paragraphs[0].runs[0].font
    run.font.size = src.size
    run.font.name = src.name
    run.font.bold = src.bold
    run.font.italic = src.italic
    try:
        if src.color and src.color.type is not None:
            run.font.color.rgb = src.color.rgb
    except Exception:
        pass


def _fit_and_center(pic: Any, box_left: int, box_top: int, box_width: int, box_height: int) -> None:
    """Scales pic (already added at native size) to fit box_width x box_height while
    preserving aspect ratio, then centers it -- add_picture() already computed
    pic.width/height from the source image via python-pptx's own Pillow dependency, so
    this never has to inspect image bytes itself."""
    if pic.width <= 0 or pic.height <= 0:
        return
    scale = min(box_width / pic.width, box_height / pic.height)
    new_w, new_h = int(pic.width * scale), int(pic.height * scale)
    pic.width, pic.height = new_w, new_h
    pic.left = int(box_left + (box_width - new_w) / 2)
    pic.top = int(box_top + (box_height - new_h) / 2)


def place_pictures(
    slide: Any, imgbox_shape: Any, images: List[Dict[str, Any]], caption_font_shape: Optional[Any] = None
) -> None:
    """Places 1-3 images inside imgbox_shape's geometry, aspect-fit + auto-arranged
    (1=centered, 2=side-by-side halves, 3=thirds); a caption textbox styled like
    caption_font_shape's font is added under any image that has one. Callers are
    expected to have already confirmed every path exists (see _missing_images) -- a
    path that still fails at add_picture time is warned and that one image is skipped,
    rather than failing the whole page."""
    if not images:
        return
    if len(images) > 3:
        _warn('explain page has %d images, only first 3 are placed' % len(images))
        images = images[:3]

    box_left, box_top = imgbox_shape.left, imgbox_shape.top
    box_width, box_height = imgbox_shape.width, imgbox_shape.height
    gap = Emu(91440)  # ~0.1in between images
    has_caption = any(img.get('caption') for img in images)
    caption_h = Emu(274320) if has_caption else Emu(0)  # ~0.3in reserved per image
    n = len(images)
    cell_w = int((box_width - gap * (n - 1)) / n)
    cell_h = int(box_height - caption_h)

    for i, img in enumerate(images):
        cell_left = int(box_left + i * (cell_w + gap))
        try:
            pic = slide.shapes.add_picture(img['path'], cell_left, box_top)
        except Exception as e:
            _warn('could not place image %r: %s' % (img.get('path'), e))
            continue
        _fit_and_center(pic, cell_left, box_top, cell_w, cell_h)
        caption = img.get('caption')
        if caption:
            cap_box = slide.shapes.add_textbox(cell_left, box_top + cell_h, cell_w, caption_h)
            cap_box.text_frame.text = str(caption)
            if cap_box.text_frame.paragraphs[0].runs:
                _apply_font_like(cap_box.text_frame.paragraphs[0].runs[0], caption_font_shape)


def _missing_images(images: List[Dict[str, Any]]) -> List[str]:
    missing = []
    for img in images:
        p = img.get('path') if isinstance(img, dict) else None
        if not p or not os.path.isfile(p):
            missing.append(p or '(no path)')
    return missing


def _format_sources(sources: Optional[List[Dict[str, Any]]]) -> str:
    if not sources:
        return ''
    parts = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        if 'wp' in s:
            parts.append('WP#%s' % s['wp'])
        elif 'commit' in s:
            parts.append('commit %s' % s['commit'])
        elif 'node' in s:
            parts.append('node %s' % s['node'])
    return ('來源: ' + ', '.join(parts)) if parts else ''


def fill_explain(slide: Any, shapes: Dict[str, Any], page: Dict[str, Any], manifest: Dict[str, Any]) -> None:
    """Fills one 'explain' pool slide: title, note, 1-3 pictures auto-arranged in the
    image_box's footprint, then clears the image_box's own placeholder text."""
    explain_cfg = manifest.get('explain', {}).get('shapes', {})

    title_shape = shapes.get(explain_cfg.get('title', ''))
    if title_shape is not None:
        set_text_preserve_style(title_shape, page.get('title') or '')

    note_shape = shapes.get(explain_cfg.get('note', ''))
    if note_shape is not None:
        set_text_preserve_style(note_shape, page.get('note') or '')

    imgbox_shape = shapes.get(explain_cfg.get('image_box', ''))
    if imgbox_shape is not None:
        place_pictures(slide, imgbox_shape, page.get('images') or [], note_shape)
        set_text_preserve_style(imgbox_shape, '')
    else:
        _warn('explain image_box shape not found')


# ---------------------------------------------------------------------------
# Summary-table fill
# ---------------------------------------------------------------------------

def _fill_summary_cell(table_row: Any, col_idx: Optional[int], text: str, font_size: Any) -> None:
    if col_idx is None:
        return
    cell = table_row.cells[col_idx]
    set_text_preserve_style(cell, text)
    for para in cell.text_frame.paragraphs:
        for run in para.runs:
            run.font.size = font_size


def fill_summary(slide: Any, manifest: Dict[str, Any], rows: List[Dict[str, Any]]) -> None:
    """Writes into the summary slide's pre-merged table (merging is a template-authoring
    step, never done at render time): one row per project, grouped into fixed-capacity
    pillar blocks per manifest.summary.rows_per_pillar, in that dict's key order. The
    pillar column is only written on a block's first data row. Font size is force-set to
    font_size_pt on every written cell (the one place this renderer overrides template
    style, since the summary table must stay legible at a fixed size regardless of how
    the template's placeholder text was authored). A pillar with more rows than its
    declared capacity is a hard error -- the template must be rebuilt with more rows,
    never silently overflowed or truncated. Rows within a block with no data this week
    are cleared, not deleted (see delete_unused_slides docstring: row deletion touches
    table XML in ways that are much riskier than clearing text)."""
    summary_cfg = manifest.get('summary', {})
    table_shape_name = summary_cfg.get('table_shape', '')
    named = _shapes_on_slide(slide, manifest.get('shape_prefix', SHAPE_PREFIX_DEFAULT))
    table_shape = named.get(table_shape_name)
    if table_shape is None or not getattr(table_shape, 'has_table', False):
        _warn('summary table shape %r not found or is not a table' % table_shape_name)
        return

    table = table_shape.table
    columns = summary_cfg.get('columns', {})
    header_rows = summary_cfg.get('header_rows', 1)
    rows_per_pillar = summary_cfg.get('rows_per_pillar', {})
    font_size = Pt(summary_cfg.get('font_size_pt', 10))
    max_chars = summary_cfg.get('max_item_chars', 200)
    colors = manifest.get('colors', {})

    rows_by_pillar: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        rows_by_pillar.setdefault(r.get('pillar', ''), []).append(r)

    row_idx = header_rows
    for pillar, capacity in rows_per_pillar.items():
        block_rows = rows_by_pillar.get(pillar, [])
        if len(block_rows) > capacity:
            _die(
                'summary pillar %r has %d rows but manifest capacity is %d -- '
                'rebuild the template with more rows for this pillar' % (pillar, len(block_rows), capacity)
            )
        for i in range(capacity):
            if row_idx >= len(table.rows):
                _die('summary table has fewer rows than manifest declares (pillar %r) -- rebuild the template' % pillar)
            table_row = table.rows[row_idx]
            if i < len(block_rows):
                data_row = block_rows[i]
                _fill_summary_cell(table_row, columns.get('pillar'), pillar if i == 0 else '', font_size)
                _fill_summary_cell(table_row, columns.get('project'), data_row.get('project', ''), font_size)
                _fill_summary_cell(table_row, columns.get('fab_line'), data_row.get('fab_line', ''), font_size)
                status_col = columns.get('status')
                if status_col is not None:
                    cell = table_row.cells[status_col]
                    set_status_paragraphs(cell, data_row.get('status_items') or [], colors, max_chars)
                    for para in cell.text_frame.paragraphs:
                        for run in para.runs:
                            run.font.size = font_size
            else:
                for col_idx in columns.values():
                    _fill_summary_cell(table_row, col_idx, '', font_size)
            row_idx += 1


# ---------------------------------------------------------------------------
# Notes / slide deletion
# ---------------------------------------------------------------------------

def set_notes(slide: Any, text: str) -> None:
    """Writes text into slide's speaker notes -- zero layout impact, used to make
    sources/context (WP refs, commits) traceable without cluttering the deck itself."""
    if not text:
        return
    slide.notes_slide.notes_text_frame.text = text


def delete_unused_slides(prs: Any, keep_indexes) -> None:
    """Drops every pool slide not in keep_indexes via standard sldIdLst XML surgery --
    python-pptx has no public delete-slide API. The pool is pre-built with enough pages
    at template-authoring time; this renderer only ever fills or deletes, it never
    clones a slide at render time."""
    keep = set(keep_indexes)
    xml_slides = list(prs.slides._sldIdLst)
    for idx, sld_id_elem in enumerate(xml_slides):
        if idx in keep:
            continue
        rId = sld_id_elem.rId
        prs.part.drop_rel(rId)
        prs.slides._sldIdLst.remove(sld_id_elem)


# ---------------------------------------------------------------------------
# Render orchestration (shared by --render and --selftest)
# ---------------------------------------------------------------------------

def render_deck(prs: Any, manifest: Dict[str, Any], spec: Dict[str, Any]) -> Set[int]:
    """Fills prs in place per spec/manifest; returns the set of kept (used) slide
    indexes. Every pool slot not referenced by spec (unused project/explain slots, or an
    explain page with a missing image file) is left out of the returned set, and
    delete_unused_slides removes it before save."""
    _reset_warnings()
    shapes_by_slide = index_shapes(prs, manifest.get('shape_prefix', SHAPE_PREFIX_DEFAULT))

    pool = manifest.get('pool', [])
    summary_idx: Optional[int] = None
    main_slots: Dict[int, int] = {}
    explain_slots: Dict[int, Dict[int, int]] = {}
    for entry in pool:
        kind = entry.get('kind')
        if kind == 'summary':
            summary_idx = entry.get('slide')
        elif kind == 'main':
            main_slots[entry.get('slot')] = entry.get('slide')
        elif kind == 'explain':
            explain_slots.setdefault(entry.get('slot'), {})[entry.get('sub')] = entry.get('slide')

    keep: Set[int] = set()

    if summary_idx is not None:
        keep.add(summary_idx)
        fill_summary(prs.slides[summary_idx], manifest, (spec.get('summary') or {}).get('rows') or [])
    else:
        _warn('manifest has no summary pool slide')

    projects = spec.get('projects') or []
    if len(projects) > len(main_slots):
        _die(
            'deck spec has %d projects but manifest pool only has %d main slots -- '
            'rebuild the template with more capacity' % (len(projects), len(main_slots))
        )

    for i, project in enumerate(projects):
        slide_idx = main_slots.get(i)
        if slide_idx is None:
            _die('manifest pool has no main slot at index %d' % i)
        keep.add(slide_idx)
        fill_main(prs.slides[slide_idx], shapes_by_slide.get(slide_idx, {}), project, manifest)

        explain_pages = project.get('explain_pages') or []
        subs = explain_slots.get(i, {})
        if len(explain_pages) > len(subs):
            _die(
                'project %r has %d explain pages but manifest pool only has %d explain slots '
                '(slot %d) -- rebuild the template with more capacity' % (project.get('key'), len(explain_pages), len(subs), i)
            )
        for j, page in enumerate(explain_pages):
            explain_idx = subs.get(j)
            if explain_idx is None:
                _die('manifest pool has no explain slot (slot=%d, sub=%d)' % (i, j))
            missing = _missing_images(page.get('images') or [])
            if missing:
                _warn(
                    'explain page (project=%r, page=%d) skipped -- missing image file(s): %s'
                    % (project.get('key'), j, ', '.join(missing))
                )
                continue
            keep.add(explain_idx)
            eslide = prs.slides[explain_idx]
            fill_explain(eslide, shapes_by_slide.get(explain_idx, {}), page, manifest)
            notes_text = _format_sources(page.get('sources'))
            if notes_text:
                set_notes(eslide, notes_text)

    delete_unused_slides(prs, keep)
    return keep


# ---------------------------------------------------------------------------
# --probe
# ---------------------------------------------------------------------------

def _probe_shapes(shapes: Any, slide_idx: int) -> None:
    for shape in shapes:
        entry: Dict[str, Any] = {
            'slide': slide_idx,
            'shape_id': shape.shape_id,
            'name': getattr(shape, 'name', ''),
            'type': str(shape.shape_type) if shape.shape_type is not None else '',
            'text': '',
            'is_table': False,
        }
        if getattr(shape, 'has_text_frame', False):
            entry['text'] = shape.text_frame.text[:80]
        if getattr(shape, 'has_table', False):
            entry['is_table'] = True
            table = shape.table
            entry['rows'] = len(table.rows)
            entry['cols'] = len(table.columns)
        print(json.dumps(entry, ensure_ascii=False))
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            _probe_shapes(shape.shapes, slide_idx)


def cmd_probe(pptx_path: str) -> None:
    prs = Presentation(pptx_path)
    for slide_idx, slide in enumerate(prs.slides):
        _probe_shapes(slide.shapes, slide_idx)


# ---------------------------------------------------------------------------
# --validate
# ---------------------------------------------------------------------------

def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def _expected_shape_names(manifest: Dict[str, Any], pool: List[Dict[str, Any]]) -> Dict[str, List[int]]:
    result: Dict[str, List[int]] = {}

    def add(name: str, idx: Optional[int]) -> None:
        if name and idx is not None:
            result.setdefault(name, []).append(idx)

    main_slots: Dict[int, int] = {}
    explain_slots: Dict[Any, int] = {}
    summary_entry = None
    for entry in pool:
        kind = entry.get('kind')
        if kind == 'summary':
            summary_entry = entry
        elif kind == 'main':
            main_slots[entry.get('slot')] = entry.get('slide')
        elif kind == 'explain':
            explain_slots[(entry.get('slot'), entry.get('sub'))] = entry.get('slide')

    if summary_entry is not None:
        add(manifest.get('summary', {}).get('table_shape', ''), summary_entry.get('slide'))

    main_cfg = manifest.get('main', {})
    main_shape_names = main_cfg.get('shapes', {})
    cp_shapes = main_cfg.get('checkpoint_shapes', {})
    capacity = main_cfg.get('checkpoints', 0)
    for idx in main_slots.values():
        for name in main_shape_names.values():
            add(name, idx)
        for n in range(1, capacity + 1):
            for tmpl in cp_shapes.values():
                add(_cp_shape_name(tmpl, n), idx)

    explain_cfg = manifest.get('explain', {}).get('shapes', {})
    for idx in explain_slots.values():
        for name in explain_cfg.values():
            add(name, idx)

    return result


def cmd_validate(template_path: str, manifest_path: str) -> None:
    manifest = load_manifest(manifest_path)
    errors: List[str] = []

    template_sha = manifest.get('template_sha256')
    if template_sha:
        actual = _sha256_file(template_path)
        if actual != template_sha:
            errors.append('template_sha256 mismatch: manifest=%s actual=%s' % (template_sha, actual))

    try:
        prs = Presentation(template_path)
    except Exception as e:
        log('error: could not open template %s: %s' % (template_path, e))
        sys.exit(1)

    slide_count = len(prs.slides)
    pool = manifest.get('pool', [])
    for entry in pool:
        idx = entry.get('slide')
        if idx is None or idx < 0 or idx >= slide_count:
            errors.append('pool entry references out-of-range slide %r' % idx)

    shapes_by_slide = index_shapes(prs, manifest.get('shape_prefix', SHAPE_PREFIX_DEFAULT))
    for name, slide_idxs in _expected_shape_names(manifest, pool).items():
        for idx in slide_idxs:
            if idx not in shapes_by_slide or name not in shapes_by_slide[idx]:
                errors.append('shape %r not found on slide %d' % (name, idx))

    summary_entry = next((e for e in pool if e.get('kind') == 'summary'), None)
    if summary_entry is None:
        errors.append('manifest pool has no "summary" entry')
    else:
        idx = summary_entry.get('slide')
        table_name = manifest.get('summary', {}).get('table_shape', '')
        shape = shapes_by_slide.get(idx, {}).get(table_name)
        if shape is None or not getattr(shape, 'has_table', False):
            errors.append('summary table shape %r not found or not a table on slide %d' % (table_name, idx))
        else:
            header_rows = manifest.get('summary', {}).get('header_rows', 1)
            capacity_total = sum(manifest.get('summary', {}).get('rows_per_pillar', {}).values())
            needed = header_rows + capacity_total
            actual_rows = len(shape.table.rows)
            if actual_rows < needed:
                errors.append(
                    'summary table has %d rows, manifest declares %d needed (header=%d + capacity=%d)'
                    % (actual_rows, needed, header_rows, capacity_total)
                )

    if errors:
        for e in errors:
            log('  - %s' % e)
        log('validate: %d error(s)' % len(errors))
        sys.exit(1)
    log('validate: OK')


# ---------------------------------------------------------------------------
# --render
# ---------------------------------------------------------------------------

def load_manifest(path: str) -> Dict[str, Any]:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def cmd_render(template_path: str, manifest_path: str, out_path: str) -> None:
    manifest = load_manifest(manifest_path)
    try:
        spec = json.loads(sys.stdin.read())
    except Exception as e:
        log('error: could not parse deck spec JSON from stdin: %s' % e)
        sys.exit(1)

    prs = Presentation(template_path)
    keep = render_deck(prs, manifest, spec)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    prs.save(out_path)

    result = {'output': os.path.abspath(out_path), 'slides': len(keep), 'warnings': _get_warnings()}
    print(json.dumps(result, ensure_ascii=False))


# ---------------------------------------------------------------------------
# --selftest
# ---------------------------------------------------------------------------

def _write_tiny_png(path: str) -> None:
    """A single valid 1x1 RGB PNG, built with only stdlib (struct+zlib) so --selftest
    never needs an extra image-authoring dependency beyond python-pptx's own Pillow."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)  # 1x1, 8-bit depth, color type 2 (RGB)
    raw = b'\x00' + bytes([200, 30, 30])  # filter byte 0 + one RGB pixel
    idat = zlib.compress(raw)
    png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def _sample_spec_for_fixture(img1: str, img2: str) -> Dict[str, Any]:
    """Built-in sample DeckSpec matching report_pptx_fixture.MANIFEST's reduced capacity
    (1 project, 3 checkpoints, pillars AMC/Energy). Deliberately uses 3 status items
    (black/blue/red) to exercise every palette color, even though the TypeScript-side
    DeckSpec contract caps status_items at 2 in normal production use -- that cap lives
    in src/report/pptx/spec.ts's validateDeckSpec, not in this renderer."""
    return {
        'version': 1,
        'week': '2026-W28',
        'summary': {
            'rows': [
                {
                    'pillar': 'AMC',
                    'project': 'AOI 專案',
                    'fab_line': 'Fab1/LineA',
                    'status_items': [{'text': '進度正常', 'color': 'black'}],
                },
                {
                    'pillar': 'Energy',
                    'project': '能源專案',
                    'fab_line': 'Fab2/LineB',
                    'status_items': [{'text': 'delay', 'color': 'red'}],
                },
            ]
        },
        'projects': [
            {
                'key': 'aoi',
                'pillar': 'AMC',
                'fab': 'Fab1',
                'name': 'AOI 專案',
                'benefit': '提升良率 3%',
                'roadmap': {
                    'checkpoints': [
                        {'label': 'Kickoff', 'date': '2026-06-01', 'at': 'Fab1'},
                        {'label': 'Pilot', 'date': '2026-07-01', 'at': 'Fab1'},
                        {'label': 'MP', 'date': '2026-08-01', 'at': 'Fab1'},
                    ],
                    'current_index': 1,
                },
                'status_items': [
                    {'text': '進度正常，如期交付', 'color': 'black'},
                    {'text': '新增風險項目', 'color': 'blue'},
                    {'text': '需高層關注', 'color': 'red'},
                ],
                'explain_pages': [
                    {
                        'title': 'AOI 專案說明',
                        'note': '本週重點說明',
                        'images': [
                            {'path': img1, 'caption': '圖一'},
                            {'path': img2, 'caption': '圖二'},
                        ],
                        'sources': [{'wp': 123}, {'commit': 'abc1234'}],
                    }
                ],
            }
        ],
    }


def cmd_selftest() -> None:
    import report_pptx_fixture  # local sibling script (scripts/report_pptx_fixture.py)

    with tempfile.TemporaryDirectory(prefix='report_pptx_selftest_') as tmp:
        template_path, manifest_path = report_pptx_fixture.build_fixture(tmp)
        manifest = load_manifest(manifest_path)

        img1, img2 = os.path.join(tmp, 'img1.png'), os.path.join(tmp, 'img2.png')
        _write_tiny_png(img1)
        _write_tiny_png(img2)
        spec = _sample_spec_for_fixture(img1, img2)

        prs = Presentation(template_path)
        keep = render_deck(prs, manifest, spec)
        out_path = os.path.join(tmp, 'out.pptx')
        prs.save(out_path)

        failures: List[str] = []

        reopened = Presentation(out_path)
        if len(reopened.slides) != len(keep):
            failures.append('expected %d slides (unused pool pages deleted), found %d' % (len(keep), len(reopened.slides)))

        shapes = index_shapes(reopened, manifest.get('shape_prefix', SHAPE_PREFIX_DEFAULT))

        main_shapes = shapes.get(1, {})
        title_shape = main_shapes.get(manifest['main']['shapes']['title'])
        expected_title = 'Fab1 AOI 專案'
        if title_shape is None or title_shape.text_frame.text != expected_title:
            failures.append('main title text mismatch: got %r' % (title_shape.text_frame.text if title_shape else None))

        status_shape = main_shapes.get(manifest['main']['shapes']['status'])
        if status_shape is None:
            failures.append('main status shape missing after reopen')
        else:
            paras = status_shape.text_frame.paragraphs
            expected_colors = ['000000', '0000FF', 'FF0000']
            if len(paras) != len(expected_colors):
                failures.append('expected %d status paragraphs, found %d' % (len(expected_colors), len(paras)))
            else:
                for para, expected_hex in zip(paras, expected_colors):
                    actual_hex = str(para.runs[0].font.color.rgb) if para.runs else None
                    if actual_hex != expected_hex:
                        failures.append('status run color mismatch: expected %s got %s' % (expected_hex, actual_hex))

        explain_shapes = shapes.get(2, {})
        note_shape = explain_shapes.get(manifest['explain']['shapes']['note'])
        if note_shape is None or note_shape.text_frame.text != '本週重點說明':
            failures.append('explain note text mismatch')

        summary_shapes = shapes.get(0, {})
        table_shape = summary_shapes.get(manifest['summary']['table_shape'])
        if table_shape is None or not table_shape.has_table:
            failures.append('summary table shape missing after reopen')
        else:
            cell = table_shape.table.cell(1, 1)
            if not cell.text_frame.paragraphs[0].runs or cell.text_frame.paragraphs[0].runs[0].font.size != Pt(10):
                failures.append('summary cell font size is not forced to 10pt')

        if len(reopened.slides) > 2 and reopened.slides[2].has_notes_slide:
            notes_text = reopened.slides[2].notes_slide.notes_text_frame.text
        else:
            notes_text = ''
        if not notes_text:
            failures.append('explain page notes_slide text is empty (sources should be recorded there)')

        if failures:
            for f in failures:
                log('SELFTEST FAIL: %s' % f)
            sys.exit(1)

        print('SELFTEST OK')


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    _force_utf8_streams()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument('--render', action='store_true', help='render a deck spec (JSON on stdin) into --out using --template/--manifest')
    group.add_argument('--probe', metavar='PPTX', help='list every shape (name/type/text/table dims) in a .pptx, for template-authoring discovery')
    group.add_argument('--validate', action='store_true', help='validate --template against --manifest (shape names / pool / capacity / sha256)')
    group.add_argument('--selftest', action='store_true', help='build the fixture, render the built-in sample spec, and assert the output (deployment smoke test)')
    ap.add_argument('--template', default=None, help='path to the fillready.pptx template (required for --render/--validate)')
    ap.add_argument('--manifest', default=None, help='path to manifest.json (required for --render/--validate)')
    ap.add_argument('--out', default=None, help='output .pptx path (required for --render)')
    args = ap.parse_args()

    if args.selftest:
        cmd_selftest()
        return
    if args.probe:
        cmd_probe(args.probe)
        return
    if args.validate:
        if not args.template or not args.manifest:
            log('--validate requires --template and --manifest')
            sys.exit(2)
        cmd_validate(args.template, args.manifest)
        return
    if args.render:
        if not args.template or not args.manifest or not args.out:
            log('--render requires --template, --manifest and --out')
            sys.exit(2)
        cmd_render(args.template, args.manifest, args.out)
        return


if __name__ == '__main__':
    main()
