#!/usr/bin/env python3
"""Transcribe one audio file with faster-whisper. Prints ONLY the transcript
text to stdout (progress/errors go to stderr); non-zero exit on failure.

Usage: transcribe.py --audio <path> --model <name> [--terms <file>] [--lang zh]
"""
import argparse
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--model', default='large-v3')
    ap.add_argument('--terms', default=None)
    ap.add_argument('--lang', default=None)
    args = ap.parse_args()

    initial_prompt = load_terms(args.terms)
    model = load_model(args.model)

    segments, info = model.transcribe(args.audio, language=args.lang, initial_prompt=initial_prompt)
    print(f'detected language={info.language} p={info.language_probability:.2f}', file=sys.stderr)

    text = ''.join(seg.text for seg in segments).strip()
    sys.stdout.write(text + '\n')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # noqa: BLE001 - report and fail loudly
        print(f'transcribe failed: {e}', file=sys.stderr)
        sys.exit(1)
