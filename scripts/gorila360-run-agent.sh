#!/usr/bin/env bash
set -euo pipefail

# Wrapper de compatibilidad para Gorila360.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/loop-run-agent.sh" "$@"
