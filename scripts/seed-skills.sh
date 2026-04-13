#!/bin/bash
# Import skills from github.com/anthropics/skills into open-managed-agents
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

  # Collect all files in the skill directory
  files="["
  first=true
  find "$skill_dir" -type f | while read -r filepath; do
    relpath="${filepath#$skill_dir}"
    # Skip binary files (PDFs, images)
    if file "$filepath" | grep -qE 'text|ASCII|UTF-8|JSON'; then
      content=$(python3 -c "
import json, sys
with open(sys.argv[1], 'r', errors='replace') as f:
    print(json.dumps(f.read()))
" "$filepath")
      if [ "$first" = true ]; then first=false; else files="$files,"; fi
      files="$files{\"filename\":\"$relpath\",\"content\":$content}"
    fi
  done
  files="$files]"

  # Create skill via API
  response=$(curl -sf "$BASE/v1/skills" \
    -H "x-api-key: $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"files\": $files}" 2>/dev/null)

  if [ $? -eq 0 ]; then
    echo "  Created: $(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'), d.get('name','?'))" 2>/dev/null)"
  else
    echo "  Failed"
  fi
done

echo "Done!"
