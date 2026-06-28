#!/usr/bin/env bash
set -euo pipefail

# Ejecuta el agente de coding con el TASK.md escrito dentro del target.
# Uso:
#   loop-run-agent.sh <target-dir> <claude|codex>

TARGET_DIR="${1:-}"
AGENT="${2:-}"

if [[ -z "$TARGET_DIR" || -z "$AGENT" ]]; then
  echo "❌ Uso: $0 <target-dir> <claude|codex>" >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "❌ No existe el target: $TARGET_DIR" >&2
  exit 1
fi

TASK_FILE="$TARGET_DIR/.orquester-task.md"
if [[ ! -f "$TASK_FILE" ]]; then
  echo "❌ No existe el archivo de tarea: $TASK_FILE" >&2
  exit 1
fi

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
  echo "❌ Agente no soportado: $AGENT" >&2
  exit 1
fi

cd "$TARGET_DIR"

echo "🚀 Ejecutando $AGENT en $TARGET_DIR..."
if [[ "$AGENT" == "claude" ]]; then
  exec claude -p --dangerously-skip-permissions "$(cat "$TASK_FILE")"
else
  exec codex exec "$(cat "$TASK_FILE")"
fi
