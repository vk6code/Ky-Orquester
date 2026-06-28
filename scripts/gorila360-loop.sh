#!/usr/bin/env bash
set -euo pipefail

# Gorila360 Rails Loop Runner para Orquester.
# Uso:
#   gorila360-loop.sh <repo> <branch> <plan-file> <phase> [agent]
#
# Ejemplo:
#   gorila360-loop.sh backend feature/banana-system-db \
#     /Users/victor/Documents/gorila360/frontend/docs/superpowers/plans/2026-06-23-diet-banana-system.md \
#     B1+B2

REPO="${1:-}"
BRANCH="${2:-}"
PLAN_FILE="${3:-}"
PHASE="${4:-}"
AGENT="${5:-}"

GORILA360_ROOT="/Users/victor/Documents/gorila360"
WORKTREE_SCRIPT="/Users/victor/Documents/orquester/orquester/scripts/gorila360-worktree.sh"

if [[ -z "$REPO" || -z "$BRANCH" || -z "$PLAN_FILE" || -z "$PHASE" ]]; then
  echo "❌ Uso: $0 <repo> <branch> <plan-file> <phase> [agent]" >&2
  exit 1
fi

if [[ "$REPO" != "backend" && "$REPO" != "frontend" ]]; then
  echo "❌ repo debe ser 'backend' o 'frontend'" >&2
  exit 1
fi

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "❌ No existe el archivo de plan: $PLAN_FILE" >&2
  exit 1
fi

# Inferir agente si no se proporcionó.
if [[ -z "$AGENT" ]]; then
  case "$PHASE" in
    B*|b*|A*|a*) AGENT="claude" ;;
    fix*|hotfix*|patch*) AGENT="codex" ;;
    *) AGENT="claude" ;;
  esac
fi

if [[ "$AGENT" != "claude" && "$AGENT" != "codex" ]]; then
  echo "❌ Agente no soportado: $AGENT (usa 'claude' o 'codex')" >&2
  exit 1
fi

WT_DIR="$GORILA360_ROOT/worktrees/$REPO/$(echo "$BRANCH" | tr '/' '-')"

# 1. Crear worktree si no existe.
if [[ ! -d "$WT_DIR" ]]; then
  echo "🌳 Creando worktree $REPO/$BRANCH..."
  "$WORKTREE_SCRIPT" create "$REPO" "$BRANCH"
else
  echo "🌳 Worktree ya existe: $WT_DIR"
fi

# 2. Escribir archivo de tarea.
TASK_FILE="$WT_DIR/.orquester-task.md"
cat > "$TASK_FILE" <<EOF
# Tarea asignada por Orquester — Rails: Coding

## Plan
- Fichero: $PLAN_FILE
- Fase: $PHASE
- Repositorio: $REPO
- Worktree: $WT_DIR
- Agente: $AGENT

## Instrucciones
1. Lee el plan completo en "$PLAN_FILE".
2. Ejecuta **solo** la fase "$PHASE".
3. Sigue el contrato del Rails de Gorila360:
   - Trabaja SIEMPRE dentro del worktree: $WT_DIR
   - Usa los skills indicados en el plan.
   - No escribas tests E2E; eso es QA.
   - Añade \\\`Co-authored-by: Claude <claude@anthropic.com>\\\` en los commits.
4. Al finalizar, haz un resumen de archivos tocados y riesgos.
5. No salgas del worktree ni toques otras ramas.

## Plan completo
$(cat "$PLAN_FILE")
EOF

echo "📝 Tarea escrita en: $TASK_FILE"

# 3. Ejecutar agente no interactivo.
echo "🚀 Lanzando agente $AGENT en $WT_DIR..."
cd "$WT_DIR"

if [[ "$AGENT" == "claude" ]]; then
  # Claude Code modo no interactivo con prompt file.
  exec claude -p --dangerously-skip-permissions "$(cat "$TASK_FILE")"
else
  # Codex CLI modo no interactivo.
  exec codex exec "$(cat "$TASK_FILE")"
fi
