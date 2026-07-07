#!/usr/bin/env python3
"""Warm bge-m3 embedding worker: loads the model ONCE, then serves embed
requests from stdin until killed or stdin closes. Saves the multi-second
model-load + CUDA-init cost scripts/embed_oneshot.py otherwise pays on every call.

Protocol (line-delimited JSON, one request per line, one response per line):
  stdin  -> {"texts": ["...", "..."]}
  stdout -> {"embeddings": [[...], ...]}    on success
  stdout -> {"error": "..."}                on failure for that one request (worker keeps running)

Progress/errors unrelated to a specific request go to stderr. Never talks to
the DB/network — src/voice/daemon.ts owns process lifecycle (spawn/respawn/idle-kill).

Usage: embed_daemon.py --model <name>
"""
import argparse
import json
import sys


def load_model(name):
    from sentence_transformers import SentenceTransformer

    last_err = None
    for device in ('cuda', 'cpu'):
        try:
            print(f'loading model={name} device={device}...', file=sys.stderr)
            return SentenceTransformer(name, device=device)
        except Exception as e:  # noqa: BLE001 - fall through to the next attempt
            last_err = e
            print(f'  failed ({device}): {e}', file=sys.stderr)
    raise RuntimeError(f'could not load embedding model {name!r} on cuda or cpu: {last_err}')


def embed_one(model, req):
    texts = req.get('texts')
    if not isinstance(texts, list) or not texts:
        raise ValueError('request missing non-empty "texts" list')
    vectors = model.encode(texts, normalize_embeddings=True)
    return [v.tolist() for v in vectors]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='BAAI/bge-m3')
    args = ap.parse_args()

    model = load_model(args.model)
    print('warm worker ready', file=sys.stderr)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            embeddings = embed_one(model, req)
            print(json.dumps({'embeddings': embeddings}), flush=True)
        except Exception as e:  # noqa: BLE001 - report and keep serving the next request
            print(f'request failed: {e}', file=sys.stderr)
            print(json.dumps({'error': str(e)}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - fatal (e.g. model failed to load at all)
        print(f'warm worker fatal: {e}', file=sys.stderr)
        sys.exit(1)
