#!/usr/bin/env python3
"""Minimal read-only Python client for the Loop Engineering SSoT API.

Read-only: only calls GET /api/rag/search, /api/knowledge, /api/knowledge/graph,
/api/sources -- the same whitelist the server's LOOP_READONLY_TOKEN accepts (writes
get 403; see READONLY_PREFIXES in src/server/app.ts). The token is never hard-coded
here -- it is read from the LOOP_READONLY_TOKEN environment variable or from
~/.config/loop-engineering/env; if neither has it set, this exits with an error
instead of silently proceeding unauthenticated.

Usage: python3 ssot_client.py {search|recall|sources|graph} [query]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_FILE = os.path.join(os.path.expanduser('~'), '.config', 'loop-engineering', 'env')


def _read_env_file():
    out = {}
    try:
        with open(ENV_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                out[key.strip()] = value.strip()
    except OSError:
        pass
    return out


def _config():
    env_file = _read_env_file()
    base = os.environ.get('LOOP_API_URL') or env_file.get('LOOP_API_URL') or 'http://127.0.0.1:4711'
    token = os.environ.get('LOOP_READONLY_TOKEN') or env_file.get('LOOP_READONLY_TOKEN')
    if not token:
        raise SystemExit(
            'error: LOOP_READONLY_TOKEN not set (env var or %s). Refusing to call the '
            'SSoT API unauthenticated.' % ENV_FILE
        )
    return base.rstrip('/'), token


class SsotClient:
    """Read-only client for the Loop Engineering SSoT REST API."""

    def __init__(self, base=None, token=None):
        if base is None or token is None:
            default_base, default_token = _config()
            base = base or default_base
            token = token or default_token
        self.base = base.rstrip('/')
        self.token = token

    def _get(self, path, params=None):
        url = self.base + path
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if params:
            url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'Authorization': 'Bearer %s' % self.token})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            raise SystemExit('error: GET %s -> HTTP %s: %s' % (url, e.code, body[:300]))
        except urllib.error.URLError as e:
            raise SystemExit('error: cannot reach %s (%s)' % (self.base, e.reason))

    def search(self, q, top_k=None):
        """Hybrid RAG search over the SSoT corpus (documents/chunks)."""
        return self._get('/api/rag/search', {'q': q, 'topK': top_k})

    def recall(self, q):
        """Full-text search the curated knowledge base."""
        return self._get('/api/knowledge', {'q': q})

    def sources(self):
        """List registered SSoT ingestion sources."""
        return self._get('/api/sources')

    def graph(self):
        """Fetch the curated knowledge graph (nodes/edges)."""
        return self._get('/api/knowledge/graph')


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('action', choices=['search', 'recall', 'sources', 'graph'])
    ap.add_argument('query', nargs='?', default=None)
    args = ap.parse_args()

    if args.action in ('search', 'recall') and not args.query:
        raise SystemExit('error: %s requires a query argument' % args.action)

    client = SsotClient()
    if args.action == 'search':
        result = client.search(args.query)
    elif args.action == 'recall':
        result = client.recall(args.query)
    elif args.action == 'sources':
        result = client.sources()
    else:
        result = client.graph()

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
