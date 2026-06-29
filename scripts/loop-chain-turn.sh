#!/usr/bin/env bash
# One turn of a multi-agent relay loop. Runs an agent ONE-SHOT with cwd at the
# PROJECT dir (so it edits real code), feeding it a per-turn prompt file from
# Orquester's work folder. Output is mirrored to the terminal AND an out-file;
# a done-file is written at the end to signal the turn is over.
#
# Usage:
#   loop-chain-turn.sh <project-dir> <agent> <prompt-file> <out-file> <done-file> <round>
#
# Never exits the shell session non-zero (the session is reused across turns):
# the agent's exit code is written into the done-file instead.
set -uo pipefail

PROJECT_DIR="${1:-}"
AGENT="${2:-}"
PROMPTFILE="${3:-}"
OUTFILE="${4:-}"
DONEFILE="${5:-}"
ROUND="${6:-?}"

if [[ -z "$PROJECT_DIR" || -z "$AGENT" || -z "$PROMPTFILE" || -z "$OUTFILE" || -z "$DONEFILE" ]]; then
  echo "❌ Uso: $0 <project-dir> <agente> <prompt-file> <out-file> <done-file> <round>" >&2
  echo "127" > "${DONEFILE:-/dev/null}" 2>/dev/null || true
  exit 0
fi

cd "$PROJECT_DIR" || { echo "127" > "$DONEFILE"; exit 0; }

echo ""
echo "════════════════════════════════════════════════════════"
echo "🔁 Turno $((ROUND + 1)) — agente: $AGENT  ·  $PROJECT_DIR"
echo "════════════════════════════════════════════════════════"

PROMPT="$(cat "$PROMPTFILE")"

# Each agent runs ONE-SHOT, non-interactive, auto-approving tool calls, with
# output mirrored to the terminal and to OUTFILE. CODE captures the agent's
# exit status (not tee's).
case "$AGENT" in
  claude)
    claude -p --dangerously-skip-permissions "$PROMPT" 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  codex)
    codex exec "$PROMPT" 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  opencode)
    opencode run "$PROMPT" 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  kimi)
    kimi --print --yolo --prompt "$PROMPT" 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  pi)
    pi --print "$PROMPT" 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  gemini)
    gemini -p "$PROMPT" --yolo 2>&1 | tee "$OUTFILE"
    CODE=${PIPESTATUS[0]} ;;
  *)
    echo "❌ Agente no soportado: $AGENT" | tee "$OUTFILE"
    CODE=2 ;;
esac

echo ""
echo "✅ Turno $((ROUND + 1)) terminado (exit $CODE)"
# Signal turn completion to the orchestrator (content = agent exit code).
echo "$CODE" > "$DONEFILE"
