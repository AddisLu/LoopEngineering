#!/usr/bin/env python3
"""Embed texts with bge-m3, one shot (no warm daemon). Reads ONE line of JSON
from stdin ({"texts": [...]}), prints ONE line of JSON to stdout
({"embeddings": [...]}); progress/errors go to stderr; non-zero exit on failure.

Usage: embed_oneshot.py --model <name>
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='BAAI/bge-m3')
    args = ap.parse_args()

    line = sys.stdin.readline().strip()
    req = json.loads(line)
    texts = req.get('texts')
    if not isinstance(texts, list) or not texts:
        raise ValueError('request missing non-empty "texts" list')

    model = load_model(args.model)
    vectors = model.encode(texts, normalize_embeddings=True)
    sys.stdout.write(json.dumps({'embeddings': [v.tolist() for v in vectors]}) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - report and fail loudly
        print(f'embed failed: {e}', file=sys.stderr)
        sys.exit(1)
