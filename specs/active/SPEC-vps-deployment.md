# SPEC: Despliegue de Orquester en VPS Linux

> **Fecha:** 2025-01-xx
> **Estado:** Draft
> **Objetivo:** Desplegar Orquester en un VPS Linux para lanzar agentes de IA (Claude, Codex, Kimi, Pi) de forma remota, accesible desde cualquier navegador.

---

## 1. Contexto

Orquester es un daemon Node.js que ejecuta agentes de coding en terminales PTY y expone una API HTTP/WebSocket. Actualmente se ejecuta localmente (macOS) con un cliente desktop Electron o web.

Queremos:

- Ejecutar el daemon en un VPS Linux (Linux)
- Tener los agentes instalados en el VPS (Claude, Codex, Kimi, Pi, DeepSeek)
- Conectar desde cualquier máquina al VPS vía navegador web
- Mantener sesiones PTY vivas aunque desconectes
- Poder gestionar todo desde CLI o navegador

## 2. Arquitectura

```
┌─────────────────┐         HTTPS (nginx/caddy)         ┌──────────────────┐
│  Tu Mac/Laptop  │ ──────────────────────────────────► │  Nginx/Caddy     │
│  (navegador)    │                                     │  (proxy inverso) │
└─────────────────┘                                     └────────┬─────────┘
                                                                 │ http
                                                                 ▼
                                                      ┌──────────────────┐
                                                      │  Orquester       │
                                                      │  Daemon (Node)   │
                                                      │  :57831          │
                                                      └────────┬─────────┘
                                                               │
                                    ┌──────────────────────────┼────────────────┐
                                    │                          │                │
                                    ▼                          ▼                ▼
                              ┌──────────┐           ┌──────────┐   ┌──────────┐
                              │ Claude   │           │ Codex    │   │ Kimi     │
                              │ Code CLI │           │ CLI      │   │ Code CLI │
                              └──────────┘           └──────────┘   └──────────┘
                                    │                          │
                                    ▼                          ▼
                              ┌────────────────────────────────────────────┐
                              │            API Keys (env vars)              │
                              │   ANTHROPIC, OPENAI, KIMI, etc.           │
                              └────────────────────────────────────────────┘
```

## 3. Componentes del despliegue

### 3.1 Orquester Daemon

El daemon Node.js que:
- Ejecuta agentes en PTYs via `node-pty`
- Expone API REST + WebSocket events
- Sirve el web client estático
- Soporta autenticación bcrypt

### 3.2 Web Client

Build estático React + Vite que:
- Se conecta al daemon vía HTTP/WebSocket
- Muestra sesiones, terminales, workspaces
- Soporta autenticación con password

### 3.3 Agentes

Cada agente se instala como CLI global en el VPS:

| Agente | Paquete npm | CLI | API Key |
|--------|-------------|-----|---------|
| Claude Code | `@anthropic-ai/claude-code` | `claude` | `ANTHROPIC_API_KEY` |
| Codex | `@openai/codex` | `codex` | `OPENAI_API_KEY` |
| Kimi Code | `@moonshot-ai/kimi-code` | `kimi` | `KIMI_API_KEY` |
| Pi Agent | `@earendil-works/pi-coding-agent` | `pi` | `~/.pi/agent/auth.json` |
| DeepSeek | `@deepseek-ai/deepseek-cli` | `deepseek` | `DEEPSEEK_API_KEY` |

### 3.4 Proxy Inverso (opcional pero recomendado)

Nginx o Caddy para:
- HTTPS con certificado TLS
- Proxy inverso al daemon
- WebSockets upgrade

## 4. Requisitos del VPS

### 4.1 Sistema

- Ubuntu 22.04+ o Debian 12+
- Node.js 20+ (LTS)
- npm 10+
- 2 vCPUs mínimo, 4GB RAM mínimo
- 20GB disco mínimo

### 4.2 Software

```bash
# Instalación básica
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git nginx certbot python3-certbot-nginx

# O con nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20
```

## 5. Instrucciones de instalación (Guía para Hermés Agent)

### 5.1 Clone y build en local

```bash
# En tu Mac:
cd /Users/victor/Documents/orquester/orquester
pnpm install
pnpm --filter @orquester/web build
```

Esto genera `apps/web/dist/` con el build estático.

### 5.2 Copiar al VPS

```bash
VPS_USER=deploy
VPS_HOST=tu-vps-ip
VPS_PATH=/opt/orquester

# Crear estructura en VPS
ssh $VPS_USER@$VPS_HOST "mkdir -p $VPS_PATH/web/dist $VPS_PATH/data"

# Copiar web client
scp -r apps/web/dist/* $VPS_USER@$VPS_HOST:$VPS_PATH/web/dist/

# Copiar daemon (o clonar el repo en el VPS)
git clone https://github.com/vk6code/Ky-Orquester.git $VPS_PATH/orquester
cd $VPS_PATH/orquester
pnpm install
```

### 5.3 Instalar agentes en el VPS

```bash
ssh $VPS_USER@$VPS_HOST << 'EOF'
cd /opt/orquester/orquester
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @moonshot-ai/kimi-code
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g @deepseek-ai/deepseek-cli
EOF
```

### 5.4 Configurar API keys en el VPS

```bash
ssh $VPS_USER@$VPS_HOST << 'EOF'
cat >> ~/.bashrc << 'ENVA'
export ANTHROPIC_API_KEY=sk-ant-tu-api-key-aqui
export OPENAI_API_KEY=sk-proj-tu-api-key-aqui
export KIMI_API_KEY=tu-kimi-api-key-aqui
export DEEPSEEK_API_KEY=sk-ds-tu-api-key-aqui
ENVA
source ~/.bashrc
EOF
```

### 5.5 Configurar y arrancar el daemon

Crear `~/.orquester/daemon/daemon.json` en el VPS:

```json
{
  "version": 1,
  "workspacesDir": "/opt/orquester/workspaces",
  "logsDir": "/opt/orquester/logs",
  "transports": {
    "http": {
      "enabled": true,
      "host": "0.0.0.0",
      "port": 57831,
      "password": "tu_password_seguro_minimo_8_caracteres"
    }
  }
}
```

Crear `~/.orquester/app/remotes.json`:

```json
{
  "version": 1,
  "remotes": []
}
```

### 5.6 Crear servicio systemd

Crear `/etc/systemd/system/orquester.service`:

```ini
[Unit]
Description=Orquester Daemon
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/orquester/orquester
Environment=NODE_ENV=production
Environment=ORQUESTER_APPDIR=/opt/orquester/data
EnvironmentFile=-/home/deploy/.bashrc
ExecStart=/home/deploy/.nvm/versions/node/v20.x.x/bin/node apps/daemon/src/cli.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Activar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable orquester
sudo systemctl start orquester
sudo systemctl status orquester
```

### 5.7 Configurar Nginx + HTTPS (opcional)

```nginx
server {
    listen 80;
    server_name orquester.tudominio.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name orquester.tudominio.com;

    ssl_certificate /etc/letsencrypt/live/orquester.tudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/orquester.tudominio.com/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:57831;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }
}
```

Obtener certificado SSL:

```bash
sudo certbot --nginx -d orquester.tudominio.com
```

### 5.8 Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 6. Docker Deployment (alternativa)

### 6.1 Dockerfile

Ver `deploy/Dockerfile`.

### 6.2 docker-compose.yml

Ver `deploy/docker-compose.yml`.

### 6.3 Build y deploy

```bash
cd /opt/orquester
docker compose up -d
docker compose logs -f
```

## 7. Verificación

```bash
# Health check
curl http://localhost:57831/health

# Con token
curl -H "Authorization: Bearer tu_password" http://localhost:57831/api/info

# Listar registry (agentes detectados)
curl -H "Authorization: Bearer tu_password" http://localhost:57831/api/registry

# Listar workspaces
curl -H "Authorization: Bearer tu_password" http://localhost:57831/api/workspaces

# Listar sesiones
curl -H "Authorization: Bearer tu_password" http://localhost:57831/api/sessions
```

## 8. Seguridad

| Aspecto | Detalle |
|---------|---------|
| Autenticación | Bearer token (bcrypt hash del password) |
| HTTPS | Let's Encrypt con certbot |
| Firewall | UFW con solo puertos necesarios |
| API Keys | Variables de entorno, nunca en código |
| Daemon | Solo escucha en localhost si proxy inverso está configurado |
| Filesystem | Workspaces en directorio dedicado con permisos limitados |

## 9. Mantenimiento

### Actualizar Orquester

```bash
cd /opt/orquester/orquester
git pull
pnpm install
pnpm --filter @orquester/web build
sudo systemctl restart orquester
```

### Actualizar agentes

```bash
npm update -g @anthropic-ai/claude-code
npm update -g @openai/codex
npm update -g @moonshot-ai/kimi-code
npm update -g --ignore-scripts @earendil-works/pi-coding-agent
```

### Logs

```bash
sudo journalctl -u orquester -f --since "1 hour ago"
tail -f /opt/orquester/data/daemon/logs/$(date +%Y-%m-%d).log
```

## 10. Estado actual vs. lo que falta

| Componente | Estado | Notas |
|------------|--------|-------|
| Daemon core | ✅ Funcional | Soporta HTTP + unix socket, auth, PTYs |
| Web client build | ✅ Funcional | Vite + React, listo para servir estático |
| Remote connections | ✅ Funcional | `remotes.json` ya implementado |
| Registry de agentes | ✅ Definido | Claude, Codex, Kimi, Pi en `packages/registry` |
| Dockerfile | 🔲 Por crear | `deploy/Dockerfile` |
| docker-compose | 🔲 Por crear | `deploy/docker-compose.yml` |
| Nginx config | 🔲 Por crear | `deploy/nginx.conf` |
| systemd service | 🔲 Por crear | En spec, crear archivo .service |
| Docs de deploy | 🔲 Por crear | Este archivo |
| Scripts de deploy | 🔲 Por crear | `deploy/deploy.sh` para automatizar |

## 11. Proximamente

- [ ] `deploy/Dockerfile` para build autocontenido
- [ ] `deploy/docker-compose.yml` con servicios completos
- [ ] `deploy/nginx.conf` con SSL
- [ ] `deploy/deploy.sh` script de un-click deploy
- [ ] `deploy/setup.sh` script de preparación del VPS
- [ ] Soporte para multiple proyectos/workspaces por agente
- [ ] Health checks de agentes en el registry
- [ ] Backup automático de workspaces y sesiones
