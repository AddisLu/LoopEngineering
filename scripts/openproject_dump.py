#!/usr/bin/env python3
"""Dump OpenProject work packages + projects as line-delimited JSON docs for the Loop
SSoT ingest pipeline (see plan-OP-ingest.md).

Reuses the user's existing ~/Coding/OpenProject_Exec_Report/op_api.py (stdlib-only,
already wraps auth/pagination/custom-fields/normalize) instead of re-implementing an
OpenProject client — this script only adds --op-repo to sys.path, imports it, and calls
its documented functions (get_work_packages/get_projects). Real API only — no demo-mode
fallback is ever selected here.

Governance: op_api_key lives in --op-repo's config.json and is never read, copied, or
logged by this script; op_base_url is the only config value this script inspects
directly (and only as a last-resort fallback if op_api itself doesn't expose it).

Output: one JSON object per line on stdout — {ext_id,title,text,uri,doc_kind,updated_at}.
Progress/errors go to stderr. A malformed/unusable item is skipped (never crashes the
whole run); a non-zero exit means the run failed.

Usage: openproject_dump.py --op-repo <path> [--op-config <path>] [--kinds work_packages,projects]
"""
import argparse
import json
import os
import sys

VALID_KINDS = ('work_packages', 'projects')


def _force_utf8_streams():
    # Company deployment target is Windows 11 + Python 3.8.10, whose console default
    # encoding is often cp950/cp1252, not UTF-8 — without this, printing Chinese work
    # package titles/descriptions raises UnicodeEncodeError instead of just writing bytes.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:
            pass


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def first(d, *keys, **kw):
    default = kw.get('default')
    if not isinstance(d, dict):
        return default
    for k in keys:
        if k in d and d[k] not in (None, ''):
            return d[k]
    return default


def text_of(value):
    """OpenProject v3 rich-text fields are often {'raw': ..., 'html': ...}; op_api's
    normalize() may already flatten these to a plain string — handle both shapes."""
    if isinstance(value, dict):
        return value.get('raw') or value.get('html') or value.get('text') or ''
    if isinstance(value, str):
        return value
    return ''


def name_of(value):
    """A referenced entity (status/type/assignee/project) may already be normalized to a
    plain string, or still be a dict like {'name': ...} / {'title': ...}."""
    if isinstance(value, dict):
        return value.get('name') or value.get('title') or value.get('subject') or ''
    if isinstance(value, str):
        return value
    return ''


def resolve_base_url(op_api_mod, config_path):
    for attr in ('OP_BASE_URL', 'BASE_URL', 'op_base_url'):
        val = getattr(op_api_mod, attr, None)
        if isinstance(val, str) and val:
            return val.rstrip('/')

    config_mgr = getattr(op_api_mod, 'config_mgr', None)
    if config_mgr is not None:
        for getter_name in ('get_base_url', 'get_op_base_url'):
            getter = getattr(config_mgr, getter_name, None)
            if callable(getter):
                try:
                    val = getter()
                    if isinstance(val, str) and val:
                        return val.rstrip('/')
                except Exception:
                    pass
        for key in ('op_base_url', 'base_url'):
            val = getattr(config_mgr, key, None)
            if isinstance(val, str) and val:
                return val.rstrip('/')
            get_fn = getattr(config_mgr, 'get', None)
            if callable(get_fn):
                try:
                    val = get_fn(key)
                    if isinstance(val, str) and val:
                        return val.rstrip('/')
                except Exception:
                    pass

    # Last resort: read only the op_base_url field ourselves — never touch/log op_api_key.
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        val = data.get('op_base_url') if isinstance(data, dict) else None
        if isinstance(val, str) and val:
            return val.rstrip('/')
    except Exception:
        pass
    return None


def dump_work_packages(op_api_mod, base_url):
    get_wps = getattr(op_api_mod, 'get_work_packages', None)
    if not callable(get_wps):
        log('op_api.get_work_packages not found -- skipping work_packages')
        return
    try:
        wps = get_wps() or []
    except Exception as e:
        raise RuntimeError('get_work_packages failed: %s' % e)

    count = 0
    for wp in wps:
        try:
            wp_id = first(wp, 'id', 'wp_id')
            if wp_id is None:
                continue
            subject = first(wp, 'subject', 'title', default='(no subject)')
            description = text_of(first(wp, 'description'))
            status = name_of(first(wp, 'status'))
            wtype = name_of(first(wp, 'type'))
            assignee = name_of(first(wp, 'assignee', 'assigned_to'))
            project = name_of(first(wp, 'project'))
            updated_at = first(wp, 'updatedAt', 'updated_at', 'updated_on')

            meta_lines = []
            if wtype:
                meta_lines.append('類型: %s' % wtype)
            if status:
                meta_lines.append('狀態: %s' % status)
            if assignee:
                meta_lines.append('負責人: %s' % assignee)
            if project:
                meta_lines.append('專案: %s' % project)

            # text = subject + description + a handful of meaningful classification
            # fields. Activity-log comments (timestamp/author-prefixed noise) are
            # deliberately excluded -- they diluted keyword/vector search with dates
            # and names instead of searchable content (title is stored separately,
            # unchanged, and now also flows into every chunk's embed/FTS text —
            # see chunk.ts).
            parts = [subject]
            if description.strip():
                parts.append(description.strip())
            if meta_lines:
                parts.append('\n'.join(meta_lines))
            text = '\n\n'.join(parts)

            doc = {
                'ext_id': 'wp:%s' % wp_id,
                'title': '#%s %s' % (wp_id, subject),
                'text': text,
                'uri': ('%s/work_packages/%s' % (base_url, wp_id)) if base_url else None,
                'doc_kind': 'op_work_package',
                'updated_at': updated_at,
            }
            print(json.dumps(doc, ensure_ascii=False))
            count += 1
        except Exception as e:
            log('skip work package (error: %s): %r' % (e, str(wp)[:200]))
    log('work_packages: %d written (of %d fetched)' % (count, len(wps)))


def dump_projects(op_api_mod, base_url):
    get_projects = getattr(op_api_mod, 'get_projects', None)
    if not callable(get_projects):
        log('op_api.get_projects not found -- skipping projects')
        return
    try:
        projects = get_projects() or []
    except Exception as e:
        raise RuntimeError('get_projects failed: %s' % e)

    count = 0
    for p in projects:
        try:
            identifier = first(p, 'identifier', 'id')
            if identifier is None:
                continue
            name = first(p, 'name', default=str(identifier))
            description = text_of(first(p, 'description'))

            extra_lines = []
            custom_fields = first(p, 'customFields', 'custom_fields')
            if isinstance(custom_fields, dict):
                for k, v in custom_fields.items():
                    v_text = text_of(v) if isinstance(v, dict) else ('' if v is None else str(v))
                    if v_text.strip():
                        extra_lines.append('%s: %s' % (k, v_text))
            elif isinstance(custom_fields, list):
                for cf in custom_fields:
                    cf_name = first(cf, 'name')
                    cf_value = first(cf, 'value')
                    if cf_name and cf_value not in (None, ''):
                        extra_lines.append('%s: %s' % (cf_name, cf_value))

            parts = []
            if description.strip():
                parts.append(description.strip())
            if extra_lines:
                parts.append('\n'.join(extra_lines))
            text = '\n\n'.join(parts).strip() or name

            doc = {
                'ext_id': 'project:%s' % identifier,
                'title': name,
                'text': text,
                'uri': ('%s/projects/%s' % (base_url, identifier)) if base_url else None,
                'doc_kind': 'op_project',
                'updated_at': first(p, 'updatedAt', 'updated_at', 'updated_on'),
            }
            print(json.dumps(doc, ensure_ascii=False))
            count += 1
        except Exception as e:
            log('skip project (error: %s): %r' % (e, str(p)[:200]))
    log('projects: %d written (of %d fetched)' % (count, len(projects)))


def cmd_list_projects(op_api_mod):
    """--list-projects: print every project as one JSON line ({id,name,identifier}) —
    lets a caller resolve a human-typed project name/identifier to an id before running
    --project --structured."""
    get_projects = getattr(op_api_mod, 'get_projects', None)
    if not callable(get_projects):
        log('op_api.get_projects not found')
        sys.exit(1)
    try:
        projects = get_projects() or []
    except Exception as e:
        log('get_projects failed: %s' % e)
        sys.exit(1)
    for p in projects:
        pid = first(p, 'id')
        if pid is None:
            continue
        print(json.dumps({
            'id': pid,
            'name': first(p, 'name', default=str(pid)),
            'identifier': first(p, 'identifier', default=''),
        }, ensure_ascii=False))
    log('projects: %d listed' % len(projects))


def _match_score(query, name, identifier):
    """Fuzzy match score for --project resolution against one project's name/identifier
    (case-insensitive); higher is better, None means no match at all."""
    q = query.strip().lower()
    n = (name or '').strip().lower()
    ident = (identifier or '').strip().lower()
    if not q:
        return None
    if q == n or q == ident:
        return 2
    if q in n or q in ident:
        return 1
    return None


def resolve_project_id(op_api_mod, query):
    """Resolve --project <name|identifier|id> to (id, name).

    A pure-digit query is used as the id directly (still looked up in get_projects() for
    a display name, best-effort). Otherwise fuzzy-matches name/identifier; multiple
    matches are logged to stderr as candidates and the highest-scoring one (first on
    ties) is used. Returns (None, None) when nothing matches.
    """
    get_projects = getattr(op_api_mod, 'get_projects', None)
    projects = []
    if callable(get_projects):
        try:
            projects = get_projects() or []
        except Exception as e:
            log('get_projects failed during --project resolution: %s' % e)

    stripped = query.strip()
    if stripped.isdigit():
        pid = int(stripped)
        match = next((p for p in projects if first(p, 'id') == pid), None)
        return pid, (first(match, 'name', default=str(pid)) if match else str(pid))

    scored = [(s, p) for p in projects for s in [_match_score(query, first(p, 'name'), first(p, 'identifier'))] if s is not None]
    if not scored:
        return None, None
    if len(scored) > 1:
        log('multiple projects match %r:' % query)
        for score, p in scored:
            log('  candidate: id=%s name=%r identifier=%r (score=%d)' % (
                first(p, 'id'), first(p, 'name'), first(p, 'identifier'), score))
    scored.sort(key=lambda t: -t[0])
    best = scored[0][1]
    return first(best, 'id'), first(best, 'name', default=str(first(best, 'id')))


def dump_structured_project(op_api_mod, project_query):
    """--project <query> --structured: resolve the project, then print every one of its
    work packages as one complete JSON line, fields taken from op_api._normalize_wp
    (subject/status/%done/dates/hours/assignee/project + best-effort description/
    custom_fields -- _normalize_wp doesn't carry those through today, so they degrade to
    empty rather than guessing)."""
    project_id, project_name = resolve_project_id(op_api_mod, project_query)
    if project_id is None:
        log('no project matches %r' % project_query)
        sys.exit(1)
    log('resolved project %r -> id=%s name=%r' % (project_query, project_id, project_name))

    get_wps_by_project = getattr(op_api_mod, 'get_work_packages_by_projects', None)
    if not callable(get_wps_by_project):
        log('op_api.get_work_packages_by_projects not found')
        sys.exit(1)
    try:
        wps = get_wps_by_project([project_id]) or []
    except Exception as e:
        log('get_work_packages_by_projects failed: %s' % e)
        sys.exit(1)

    count = 0
    for wp in wps:
        try:
            doc = {
                'id': first(wp, 'id'),
                'subject': first(wp, 'subject', default=''),
                'status': first(wp, 'status', default=''),
                'is_closed': bool(first(wp, 'is_closed', default=False)),
                'type': first(wp, 'type', default=''),
                'assignee_name': first(wp, 'assignee_name', default=''),
                'project_id': first(wp, 'project_id', default=project_id),
                'project_name': first(wp, 'project_name', default=project_name),
                'start_date': first(wp, 'start_date', default=''),
                'due_date': first(wp, 'due_date', default=''),
                'percent_done': first(wp, 'percent_done', default=0),
                'estimated_hours': first(wp, 'estimated_hours', default=0),
                'spent_hours': first(wp, 'spent_hours', default=0),
                'remaining_hours': first(wp, 'remaining_hours', default=0),
                'description': text_of(first(wp, 'description', default='')),
                'custom_fields': first(wp, 'custom_fields', default={}) or {},
                'updated_at': first(wp, 'updated_at', default=''),
            }
            print(json.dumps(doc, ensure_ascii=False))
            count += 1
        except Exception as e:
            log('skip work package (error: %s): %r' % (e, str(wp)[:200]))
    log('structured work_packages: %d written (of %d fetched) for project %r' % (count, len(wps), project_name))


def main():
    _force_utf8_streams()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--op-repo', required=True, help='path to the local OpenProject_Exec_Report repo (provides op_api.py)')
    ap.add_argument('--op-config', default=None, help='override path to config.json (default: <op-repo>/config.json)')
    ap.add_argument('--kinds', default='work_packages,projects', help='comma-separated: work_packages,projects')
    ap.add_argument('--list-projects', action='store_true', help='print every project as JSON lines ({id,name,identifier}) and exit')
    ap.add_argument('--project', default=None, help='project name/identifier/id, for --structured mode')
    ap.add_argument('--structured', action='store_true', help='with --project: print that project\'s work packages as structured JSON (one line per work package) instead of running the prose ingest dump')
    args = ap.parse_args()

    op_repo = os.path.abspath(args.op_repo)
    if not os.path.isdir(op_repo):
        log('op-repo not found: %s' % op_repo)
        sys.exit(1)
    sys.path.insert(0, op_repo)

    config_path = os.path.abspath(args.op_config) if args.op_config else os.path.join(op_repo, 'config.json')
    config_dir = os.path.dirname(config_path) or '.'
    # op_api's config_mgr is documented to read a relative "config.json" for
    # op_base_url/op_api_key -- chdir so that lookup resolves to the requested config,
    # for the lifetime of this one-shot process (never restored; the process exits
    # right after dumping).
    os.chdir(config_dir)

    try:
        import op_api  # local module resolved via --op-repo on sys.path above
    except Exception as e:
        log('failed to import op_api from %s: %s' % (op_repo, e))
        sys.exit(1)

    if args.list_projects:
        cmd_list_projects(op_api)
        return

    if args.project and args.structured:
        dump_structured_project(op_api, args.project)
        return

    base_url = resolve_base_url(op_api, config_path)
    if not base_url:
        log('warning: could not resolve op_base_url from op_api or %s -- document uri will be null' % config_path)

    requested = [k.strip() for k in args.kinds.split(',') if k.strip()]
    unknown = [k for k in requested if k not in VALID_KINDS]
    if unknown:
        log('ignoring unknown --kinds value(s): %s' % ', '.join(unknown))
    kinds = [k for k in requested if k in VALID_KINDS]
    if not kinds:
        log('no valid --kinds requested (expected work_packages,projects)')
        sys.exit(1)

    had_error = False
    if 'work_packages' in kinds:
        try:
            dump_work_packages(op_api, base_url)
        except Exception as e:
            log('work_packages dump failed: %s' % e)
            had_error = True
    if 'projects' in kinds:
        try:
            dump_projects(op_api, base_url)
        except Exception as e:
            log('projects dump failed: %s' % e)
            had_error = True

    if had_error:
        sys.exit(1)


if __name__ == '__main__':
    main()
