#!/usr/bin/env python3
"""Embed texts with bge-m3, one shot (no warm daemon). Reads ONE line of JSON
from stdin ({"texts": [...]}), prints ONE line of JSON to stdout
({"embeddings": [...]}); progress/errors go to stderr; non-zero exit on failure.

Usage: embed_oneshot.py --model <name>
"""
import argparse
import json
import os
import sys


# Optional limits for hosts where the GPU is shared (e.g. DGX Spark with vLLM holding most of
# the unified memory): LOOP_EMBED_DEVICE=cuda|cpu pins the device, LOOP_EMBED_MAX_SEQ_LEN caps
# tokens per text (bge-m3 defaults to 8192, whose activations alone can take several GB), and
# LOOP_EMBED_BATCH sets the encode batch size. Unset = previous behaviour.
MAX_SEQ_LEN = int(os.environ.get('LOOP_EMBED_MAX_SEQ_LEN') or 0)
BATCH = int(os.environ.get('LOOP_EMBED_BATCH') or 32)


def load_model(name):
    from sentence_transformers import SentenceTransformer

    pinned = os.environ.get('LOOP_EMBED_DEVICE')
    last_err = None
    for device in ((pinned,) if pinned else ('cuda', 'cpu')):
        try:
            print(f'loading model={name} device={device}...', file=sys.stderr)
            model = SentenceTransformer(name, device=device)
            if MAX_SEQ_LEN > 0:
                model.max_seq_length = MAX_SEQ_LEN
            return model
        except Exception as e:  # noqa: BLE001 - fall through to the next attempt
            last_err = e
            print(f'  failed ({device}): {e}', file=sys.stderr)
    raise RuntimeError(f'could not load embedding model {name!r} on {pinned or "cuda or cpu"}: {last_err}')


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
    vectors = model.encode(texts, normalize_embeddings=True, batch_size=BATCH)
    sys.stdout.write(json.dumps({'embeddings': [v.tolist() for v in vectors]}) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - report and fail loudly
        print(f'embed failed: {e}', file=sys.stderr)
        sys.exit(1)
