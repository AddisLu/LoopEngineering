#!/usr/bin/env bash
# Copy one model's HF cache folder to the other Sparks of the cluster, so a two-node recipe finds
# its weights on every node (vLLM runs with HF_HUB_OFFLINE=1). Newer `hf download` keeps the real
# files in a shared content store (hub/blobs/xx/<sha>) and only links them from the model's blobs/,
# so the blobs are sent with -L (their content) while snapshots/refs keep their relative links:
# the worker ends up with one self-contained copy.
#   sync-weights.sh <hub dir> <models--org--name> <worker> [worker...]
set -euo pipefail
hub="$1"; model_dir="$2"; shift 2
export RSYNC_RSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
for w in "$@"; do
  echo "同步到 ${w}：資料夾結構"
  timeout 900 rsync -a --partial --exclude 'trees/' --exclude 'blobs/' "${hub}/${model_dir}" "${w}:.cache/huggingface/hub/"
  echo "同步到 ${w}：權重檔（實體內容）"
  timeout 10800 rsync -aL --partial --info=progress2 "${hub}/${model_dir}/blobs/" "${w}:.cache/huggingface/hub/${model_dir}/blobs/"
  echo "同步到 ${w}：完成"
done
echo "同步完成"
