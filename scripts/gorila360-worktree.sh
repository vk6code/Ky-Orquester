#!/usr/bin/env bash
set -euo pipefail

# Wrapper para invocar el gestor de worktrees de Gorila360 desde Orquester.
# Uso:
#   gorila360-worktree.sh create <backend|frontend> <branch> [base_ref]
#   gorila360-worktree.sh list [backend|frontend|all]
#   gorila360-worktree.sh remove <backend|frontend> <branch>

GORILA360_SCRIPTS="/Users/victor/Documents/gorila360/scripts"

if [[ ! -x "$GORILA360_SCRIPTS/worktree.sh" ]]; then
  echo "❌ No se encontró el script de worktrees de Gorila360: $GORILA360_SCRIPTS/worktree.sh" >&2
  exit 1
fi

exec "$GORILA360_SCRIPTS/worktree.sh" "$@"
