#!/usr/bin/env bash
# One turn of a multi-agent relay loop. Runs an agent ONE-SHOT reading the shared
# baton file, mirrors its output to the terminal AND to an out-file (so the
# orchestrator can append it to the baton), then writes a done-file to signal the
# turn is over. The orchestrator polls for the done-file and advances to the next
# agent.
#
# Usage:
#   loop-chain-turn.sh <work-dir> <claude|codex> <baton-file> <out-file> <done-file> <round>
#
# Never exits the shell session non-zero (the session is reused across turns):
# the agent's exit code is written into the done-file instead.
set -uo pipefail

WORK_DIR="${1:-}"
AGENT="${2:-}"
BATON="${3:-}"
OUTFILE="${4:-}"
DONEFILE="${5:-}"
ROUND="${6:-?}"

if [[ -z "$WORK_DIR" || -z "$AGENT" || -z "$BATON" || -z "$OUTFILE" || -z "$DONEFILE" ]]; then
  echo "❌ Uso: $0 <work-dir> <agente> <baton> <out> <done> <round>" >&2
  echo "127" > "${DONEFILE:-/dev/null}" 2>/dev/null || true
  exit 0
fi

cd "$WORK_DIR" || { echo "127" > "$DONEFILE"; exit 0; }

echo ""
echo "════════════════════════════════════════════════════════"
echo "🔁 Turno $((ROUND + 1)) — agente: $AGENT  ·  $WORK_DIR"
echo "════════════════════════════════════════════════════════"

PROMPT="$(cat "$BATON")"

if [[ "$AGENT" == "claude" ]]; then
  claude -p --dangerously-skip-permissions "$PROMPT" 2>&1 | tee "$OUTFILE"
  CODE=${PIPESTATUS[0]}
elif [[ "$AGENT" == "codex" ]]; then
  codex exec "$PROMPT" 2>&1 | tee "$OUTFILE"
  CODE=${PIPESTATUS[0]}
else
  echo "❌ Agente no soportado: $AGENT" | tee "$OUTFILE"
  CODE=2
fi

echo ""
echo "✅ Turno $((ROUND + 1)) terminado (exit $CODE)"
# Signal turn completion to the orchestrator (content = agent exit code).
echo "$CODE" > "$DONEFILE"
