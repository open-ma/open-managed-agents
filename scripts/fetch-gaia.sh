#!/bin/bash
# Fetch the GAIA validation set from HuggingFace.
#
# Prereqs:
#   1. pip install huggingface_hub
#   2. Request access at https://huggingface.co/datasets/gaia-benchmark/GAIA
#      (gated dataset, approval is fast — usually minutes)
#   3. Get a token at https://huggingface.co/settings/tokens (Read scope)
#
# Usage: HF_TOKEN=hf_xxxxx ./scripts/fetch-gaia.sh
#
# Writes test/eval/data/gaia-validation.jsonl (165 questions across L1/L2/L3).

set -e

if [ -z "$HF_TOKEN" ]; then
  echo "ERROR: HF_TOKEN environment variable required."
  echo "       Get one at https://huggingface.co/settings/tokens"
  exit 1
fi

OUT_DIR="test/eval/data"
mkdir -p "$OUT_DIR"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading gaia-benchmark/GAIA validation split to $TMP_DIR..."
huggingface-cli download \
  --token "$HF_TOKEN" \
  --repo-type dataset \
  --local-dir "$TMP_DIR" \
  gaia-benchmark/GAIA \
  '2023/validation/metadata.jsonl' 2>&1 | tail -5

SRC="$TMP_DIR/2023/validation/metadata.jsonl"
if [ ! -f "$SRC" ]; then
  echo "ERROR: Expected $SRC after download, not found."
  exit 1
fi

OUT="$OUT_DIR/gaia-validation.jsonl"
cp "$SRC" "$OUT"

COUNT=$(wc -l < "$OUT" | tr -d ' ')
echo "Wrote $OUT ($COUNT questions)."
echo "Run: npx tsx test/eval/runner.ts --suite gaia"
