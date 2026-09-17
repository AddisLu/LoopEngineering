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


def embed_one(model, req):
    texts = req.get('texts')
    if not isinstance(texts, list) or not texts:
        raise ValueError('request missing non-empty "texts" list')
    vectors = model.encode(texts, normalize_embeddings=True, batch_size=BATCH)
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
