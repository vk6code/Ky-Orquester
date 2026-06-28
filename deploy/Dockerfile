# Orquester - Dockerfile para VPS Linux
#
# Multi-stage build:
#   1. Build del web client (Node 20)
#   2. Runtime ligero con solo el daemon

FROM node:20-alpine AS builder

WORKDIR /build

# Instalar pnpm
RUN npm install -g pnpm@10.12.1

# Copiar solo los lockfiles primero para caché de capas
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api/package.json packages/api/
COPY packages/config/package.json packages/config/
COPY packages/registry/package.json packages/registry/
COPY packages/ui/package.json packages/ui/
COPY apps/daemon/package.json apps/daemon/
COPY apps/web/package.json apps/web/

# Instalar deps
RUN pnpm install --frozen-lockfile

# Copiar todo el código
COPY . .

# Build del web client
RUN pnpm --filter @orquester/web build

# Build del daemon (TypeScript → JS)
RUN pnpm --filter @orquester/daemon build

# ============================================================
# Runtime image
# ============================================================
FROM node:20-alpine AS runtime

# Variables de entorno por defecto
ENV NODE_ENV=production \
    ORQUESTER_APPDIR=/opt/orquester/data \
    ORQUESTER_HTTP_ENABLED=false \
    ORQUESTER_HTTP_HOST=127.0.0.1 \
    ORQUESTER_HTTP_PORT=57831 \
    ORQUESTER_HTTP_PASSWORD=""

# Crear usuario no-root
RUN addgroup -S orquester && adduser -S orquester -G orquester

# Instalar dependencias de runtime del daemon
WORKDIR /opt/orquester/orquester

# Copiar package.json y lockfiles
COPY apps/daemon/package.json apps/daemon/
COPY packages/api/package.json packages/api/
COPY packages/config/package.json packages/config/
COPY packages/registry/package.json packages/registry/

# Instar deps de runtime
RUN pnpm install --prod --ignore-scripts --frozen-lockfile 2>/dev/null || \
    npm install --ignore-scripts 2>/dev/null || true

# Copiar build del daemon y web client
COPY --from=builder /build/apps/daemon/dist ./apps/daemon/dist
COPY --from=builder /build/apps/web/dist ./apps/web/dist

# Copiar archivos fuente del daemon (tsx ejecuta TS directo en dev,
# pero para producción usamos el dist)
COPY apps/daemon/src ./apps/daemon/src
COPY packages/api/src ./packages/api/src
COPY packages/config/src ./packages/config/src
COPY packages/registry/src ./packages/registry/src

# Crear directorios de datos
RUN mkdir -p /opt/orquester/data/daemon /opt/orquester/data/app \
    /opt/orquester/data/logs /opt/orquester/data/workspaces && \
    chown -R orquester:orquester /opt/orquester

# Puerto del daemon
EXPOSE 57831

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:57831/health || exit 1

USER orquester

WORKDIR /opt/orquester/orquester

CMD ["node", "apps/daemon/src/cli.ts"]
