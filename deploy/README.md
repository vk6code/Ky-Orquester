# Deploy

Archivos de despliegue de Orquester en VPS Linux.

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `Dockerfile` | Multi-stage build para Docker |
| `docker-compose.yml` | Despliegue con Docker Compose |
| `.env.example` | Variables de entorno (copiar a `.env`) |
| `nginx.conf` | Configuración de Nginx + SSL |
| `orquester.service` | Servicio systemd |
| `setup.sh` | Script de instalación automática en VPS |

## Quick Start

### Opción 1: Instalación automática

```bash
curl -fsSL https://raw.githubusercontent.com/vk6code/Ky-Orquester/main/deploy/setup.sh | sudo bash -s -- \
  --user deploy \
  --password TuPasswordSeguro123 \
  --domain orquester.tudominio.com
```

### Opción 2: Docker Compose

```bash
cd deploy
cp .env.example .env
# Editar .env con tus API keys
docker compose up -d
```

### Opción 3: Manual (systemd)

```bash
# En el VPS
git clone https://github.com/vk6code/Ky-Orquester.git /opt/orquester/orquester
cd /opt/orquester/orquester
pnpm install
pnpm --filter @orquester/web build

# Copiar service file
sudo cp deploy/orquester.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orquester
sudo systemctl start orquester
```

Ver `SPEC-vps-deployment.md` en `specs/active/` para la guía completa.
