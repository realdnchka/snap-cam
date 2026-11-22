#!/bin/sh
# Type-checks the mod against the newest claude-code.d.ts on this Mac.
set -eu
mod=$(cd "$(dirname "$0")/.." && pwd)

version() { head -1 "$1" | sed -n 's/^\/\/ Written by Claude Code \([0-9.]*\)\..*/\1/p'; }

types=${CLAUDE_CODE_TYPES:-}
if [ -z "$types" ]; then
  best=''
  for f in "$mod/.claude-plugin/types/claude-code/index.d.ts" /private/tmp/claude-"$(id -u)"/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts; do
    [ -f "$f" ] || continue
    v=$(version "$f")
    [ -n "$v" ] || continue
    if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best" "$v" | sort -V | tail -1)" = "$v" ]; then
      best=$v
      types=$f
    fi
  done
fi
if [ -z "$types" ]; then
  echo "No claude-code.d.ts found: load the plugin-authoring skill once, or set CLAUDE_CODE_TYPES." >&2
  exit 1
fi
echo "types: $types ($(version "$types"))"

work=$(mktemp -d "${TMPDIR:-/tmp}/snap-cam-tsc.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir "$work/claude-code"
cp "$types" "$work/claude-code/index.d.ts"
cat > "$work/tsconfig.json" <<JSON
{
  "extends": "$mod/tsconfig.json",
  "compilerOptions": { "typeRoots": ["$work"], "types": ["claude-code"] },
  "include": ["$mod/hooks", "$mod/types", "$mod/contract.ts"]
}
JSON

if [ -n "${TSC:-}" ]; then
  "$TSC" -p "$work/tsconfig.json"
else
  npm_config_cache="$work/npm" npx -y -p typescript@5.9.3 tsc -p "$work/tsconfig.json"
fi
echo "tsc: no errors"
