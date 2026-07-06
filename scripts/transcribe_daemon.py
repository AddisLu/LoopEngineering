#!/usr/bin/env python3
"""Warm faster-whisper worker: loads the model ONCE, then serves transcribe
requests from stdin until killed or stdin closes. Saves the ~1.6s model-load
+ CUDA-init cost scripts/transcribe.py otherwise pays on every recording.

Protocol (line-delimited JSON, one request per line, one response per line):
  stdin  -> {"audio": "<path>", "terms_file": "<path or "">", "model": "<name>", "lang": "zh"}
  stdout -> {"text": "..."}                 on success
  stdout -> {"error": "..."}                on failure for that one request (worker keeps running)

Progress/errors unrelated to a specific request go to stderr. Never talks to
the DB/network — src/voice/daemon.ts owns process lifecycle (spawn/respawn/idle-kill).

Usage: transcribe_daemon.py --model <name> [--lang zh]
"""
import argparse
import json
import sys


def load_terms(path):
    """Comma/newline-separated glossary file -> a single initial_prompt string, or None."""
    if not path:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = f.read()
    except OSError as e:
        print(f'terms file unreadable ({path}): {e}', file=sys.stderr)
        return None
    terms = [t.strip() for line in raw.splitlines() for t in line.split(',')]
    terms = [t for t in terms if t]
    return ', '.join(terms) if terms else None


def load_model(name):
    from faster_whisper import WhisperModel

    attempts = [('cuda', 'float16'), ('cuda', 'int8_float16'), ('cpu', 'int8')]
    last_err = None
    for device, compute_type in attempts:
        try:
            print(f'loading model={name} device={device} compute_type={compute_type}...', file=sys.stderr)
            return WhisperModel(name, device=device, compute_type=compute_type)
        except Exception as e:  # noqa: BLE001 - fall through to the next attempt
            last_err = e
            print(f'  failed ({device}/{compute_type}): {e}', file=sys.stderr)
    raise RuntimeError(f'could not load whisper model {name!r} on cuda or cpu: {last_err}')


def transcribe_one(model, req, default_lang):
    audio = req.get('audio')
    if not audio:
        raise ValueError('request missing "audio"')
    initial_prompt = load_terms(req.get('terms_file'))
    lang = req.get('lang') or default_lang
    segments, info = model.transcribe(audio, language=lang, initial_prompt=initial_prompt)
    print(f'detected language={info.language} p={info.language_probability:.2f}', file=sys.stderr)
    return ''.join(seg.text for seg in segments).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='large-v3')
    ap.add_argument('--lang', default='zh')
    args = ap.parse_args()

    model = load_model(args.model)
    print('warm worker ready', file=sys.stderr)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = transcribe_one(model, req, args.lang)
            print(json.dumps({'text': text}), flush=True)
        except Exception as e:  # noqa: BLE001 - report and keep serving the next request
            print(f'request failed: {e}', file=sys.stderr)
            print(json.dumps({'error': str(e)}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - fatal (e.g. model failed to load at all)
        print(f'warm worker fatal: {e}', file=sys.stderr)
        sys.exit(1)
