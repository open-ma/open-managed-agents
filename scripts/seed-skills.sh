#!/bin/bash
# Import skills from github.com/anthropics/skills into open-managed-agents.
# Now uploads binary files too (PNG, fonts, archives) using base64 encoding —
# the storage layer is R2, no longer KV-string.
# Usage: BASE=https://your-api.workers.dev KEY=your-api-key ./scripts/seed-skills.sh

set -e
BASE="${BASE:-http://localhost:8787}"
KEY="${KEY:-test-key}"
SKILLS_DIR="${SKILLS_DIR:-/tmp/anthropic-skills/skills}"

if [ ! -d "$SKILLS_DIR" ]; then
  echo "Cloning github.com/anthropics/skills..."
  git clone https://github.com/anthropics/skills /tmp/anthropic-skills
fi

for skill_dir in "$SKILLS_DIR"/*/; do
  name=$(basename "$skill_dir")
  echo "=== Importing skill: $name ==="

  # Build a JSON files array. Text files use utf8 encoding (raw content).
  # Binary files use base64 so bytes survive intact through R2.
  payload=$(python3 - "$skill_dir" <<'PY'
import os, sys, json, base64
root = sys.argv[1].rstrip('/')
files = []
TEXT_EXT = {'.md', '.txt', '.json', '.yaml', '.yml', '.py', '.js', '.ts', '.html',
            '.css', '.csv', '.xml', '.toml', '.ini', '.sh', '.bash'}
for cur, _, names in os.walk(root):
    for fn in names:
        path = os.path.join(cur, fn)
        rel = os.path.relpath(path, root)
        ext = os.path.splitext(fn)[1].lower()
        with open(path, 'rb') as f:
            data = f.read()
        if ext in TEXT_EXT:
            try:
                files.append({"filename": rel, "content": data.decode('utf-8'), "encoding": "utf8"})
                continue
            except UnicodeDecodeError:
                pass
        files.append({"filename": rel, "content": base64.b64encode(data).decode('ascii'), "encoding": "base64"})
print(json.dumps({"files": files}))
PY
)

  if response=$(curl -sf "$BASE/v1/skills" \
    -H "x-api-key: $KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null); then
    echo "  Created: $(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'), d.get('name','?'))" 2>/dev/null)"
  else
    echo "  Failed"
  fi
done

echo "Done!"
