# PLAN: Despliegue gorila-dev (Hetzner VPS)

> **Estado:** Activo  
> **VPS:** gorila-dev (Hetzner Linux)  
> **Repo remoto:** git@github.com:vk6code/Ky-Orquester.git  
> **Ruta en VPS:** /opt/orquester/orquester  
> **Puerto daemon:** 57831  

---

## Arquitectura objetivo

```
Tu Mac (dev)
  └── git push → GitHub (vk6code/Ky-Orquester)
                    └── gorila-dev (VPS Hetzner)
                          ├── git pull
                          ├── pnpm install
                          ├── pnpm build (web)
                          └── systemctl restart orquester
                                └── Daemon :57831
                                      ├── Claude Code CLI
                                      ├── Codex CLI
                                      └── Kimi CLI
```

---

## FASE 1 — Setup VPS (una sola vez)

### 1.1 Conectar al VPS

```bash
ssh root@<IP_GORILA_DEV>
```

### 1.2 Crear usuario orquester

```bash
adduser --disabled-password --gecos "" orquester
usermod -aG sudo orquester
mkdir -p /opt/orquester
chown -R orquester:orquester /opt/orquester
```

### 1.3 Instalar Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git build-essential python3 curl wget
node --version   # debe ser v20.x
```

### 1.4 Instalar pnpm

```bash
npm install -g pnpm@10.12.1
pnpm --version
```

### 1.5 Clonar el repo

```bash
su - orquester
git clone git@github.com:vk6code/Ky-Orquester.git /opt/orquester/orquester
cd /opt/orquester/orquester
pnpm install
```

> Si el VPS no tiene tu SSH key para GitHub, usa HTTPS:  
> `git clone https://github.com/vk6code/Ky-Orquester.git /opt/orquester/orquester`

### 1.6 Build del web client

```bash
cd /opt/orquester/orquester
pnpm --filter @orquester/web build
# → genera apps/web/dist/
```

### 1.7 Crear el archivo .env con tus API keys

```bash
cat > /opt/orquester/.env << 'EOF'
# ===== Orquester HTTP =====
ORQUESTER_HTTP_ENABLED=true
ORQUESTER_HTTP_HOST=0.0.0.0
ORQUESTER_HTTP_PORT=57831
ORQUESTER_HTTP_PASSWORD=CAMBIA_ESTO_PASSWORD_SEGURO

# ===== API Keys =====
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
# KIMI_API_KEY=...
# DEEPSEEK_API_KEY=...
EOF
chmod 600 /opt/orquester/.env
```

### 1.8 Instalar agentes CLI

```bash
# Claude Code (necesita ANTHROPIC_API_KEY en env)
npm install -g @anthropic-ai/claude-code

# Codex (necesita OPENAI_API_KEY en env)
npm install -g @openai/codex

# Kimi (opcional)
npm install -g @moonshot-ai/kimi-code

# Verificar
claude --version
codex --version
```

### 1.9 Instalar el servicio systemd

```bash
# Como root:
exit   # salir de orquester si es necesario
sudo cp /opt/orquester/orquester/deploy/orquester.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable orquester
systemctl start orquester
systemctl status orquester
```

### 1.10 Verificar que el daemon está vivo

```bash
curl http://localhost:57831/health
# Debe devolver: {"ok":true,"version":"..."}
```

---

## FASE 2 — Configurar nginx (acceso HTTPS desde fuera)

### 2.1 Instalar nginx

```bash
apt-get install -y nginx
```

### 2.2 Configurar site

```bash
# Editar dominio (o usar IP):
sed 's/orquester.tudominio.com/<TU_DOMINIO_O_IP>/g' \
  /opt/orquester/orquester/deploy/nginx.conf \
  > /etc/nginx/sites-available/orquester

ln -sf /etc/nginx/sites-available/orquester /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
```

> Si no tienes dominio, accede directamente por IP:  
> `http://<IP_VPS>:57831` — sin nginx, directo al daemon.

### 2.3 SSL con Let's Encrypt (si tienes dominio)

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d tu-dominio.com
```

### 2.4 Firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# Si accedes sin nginx:
ufw allow 57831/tcp
ufw --force enable
```

---

## FASE 3 — Workflow de desarrollo (push/pull)

### En tu Mac (cada vez que tengas cambios listos)

```bash
cd /Users/victor/Documents/orquester/orquester
git add -A
git commit -m "feat: descripción del cambio"
git push origin main
```

### En el VPS (para actualizar)

```bash
ssh orquester@<IP_VPS>
cd /opt/orquester/orquester
git pull origin main
pnpm install          # solo si cambiaron deps
pnpm --filter @orquester/web build   # solo si cambiaron archivos UI
sudo systemctl restart orquester
```

O en una línea:

```bash
ssh orquester@<IP_VPS> "cd /opt/orquester/orquester && git pull && pnpm install && pnpm --filter @orquester/web build && sudo systemctl restart orquester"
```

---

## FASE 4 — Conectar desde tu Mac al daemon remoto

Una vez el daemon corre en el VPS, añádelo como remote en la app:

1. Abre Orquester desktop o web
2. Panel lateral → **Servers** → **Add Remote**
3. URL: `http://<IP_VPS>:57831` (o `https://tu-dominio.com` si usas nginx+SSL)
4. Password: el que pusiste en `ORQUESTER_HTTP_PASSWORD`

---

## Verificación rápida

```bash
# Desde tu Mac (con tu password):
curl -H "Authorization: Bearer TU_PASSWORD" http://<IP_VPS>:57831/api/registry
# → debe listar claude, codex, etc. con sus versiones

curl -H "Authorization: Bearer TU_PASSWORD" http://<IP_VPS>:57831/api/workspaces
# → lista vacía al inicio
```

---

## Comandos útiles en el VPS

```bash
# Ver logs en tiempo real
sudo journalctl -u orquester -f

# Ver logs del daemon
tail -f /opt/orquester/data/daemon/logs/$(date +%Y-%m-%d).log

# Estado del servicio
sudo systemctl status orquester

# Reiniciar
sudo systemctl restart orquester

# Ver sesiones activas (desde VPS)
curl -H "Authorization: Bearer TU_PASSWORD" http://localhost:57831/api/sessions
```

---

## Siguientes pasos (pendientes)

- [ ] TargetConfigs: configuración persistente de rutas por proyecto
- [ ] Pipeline engine: encadenamiento de agentes
- [ ] Daemon-to-daemon: ejecutar loops en remoto desde la UI local
- [ ] Script `deploy/update.sh` para automatizar el pull+build+restart

---

## Notas técnicas

- El daemon corre con `tsx` (TypeScript directo) porque `tsconfig.base.json` tiene `noEmit: true`
- El web client sí se compila con Vite a `apps/web/dist/`
- El daemon sirve el web client estático desde esa carpeta
- Las sesiones PTY sobreviven a desconexiones del cliente
- El Unix socket local sólo está disponible en el mismo host
