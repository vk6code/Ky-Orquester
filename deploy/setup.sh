#!/bin/bash
# ============================================================
# Orquester - VPS Setup Script
# ============================================================
# Prepares a fresh Ubuntu/Debian VPS for Orquester deployment.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/vk6code/Ky-Orquester/main/deploy/setup.sh | sudo bash
#
# Or download and run:
#   wget https://raw.githubusercontent.com/vk6code/Ky-Orquester/main/deploy/setup.sh
#   sudo bash setup.sh --user deploy --password YOUR_PASSWORD
#
# Options:
#   --user USERNAME       System user for Orquester (default: orquester)
#   --password PASSWORD   HTTP password for daemon (default: random)
#   --domain DOMAIN       Domain for SSL cert (optional)
#   --no-docker           Skip Docker installation
#   --no-nginx            Skip Nginx installation
#   --no-ssl              Skip SSL cert (use HTTP only)
# ============================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse arguments
USER="orquester"
PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
DOMAIN=""
INSTALL_DOCKER=true
INSTALL_NGINX=true
INSTALL_SSL=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --user)    USER="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        --domain)  DOMAIN="$2"; shift 2 ;;
        --no-docker) INSTALL_DOCKER=false; shift ;;
        --no-nginx)  INSTALL_NGINX=false; shift ;;
        --no-ssl)    INSTALL_SSL=false; shift ;;
        *) log_error "Unknown option: $1"; exit 1 ;;
    esac
done

if [ -z "$DOMAIN" ]; then
    INSTALL_NGINX=false
    INSTALL_SSL=false
fi

log_info "================================================"
log_info "  Orquester VPS Setup"
log_info "================================================"
log_info "  User:      $USER"
log_info "  Password:  $PASSWORD"
log_info "  Domain:    ${DOMAIN:-none}"
log_info "  Docker:    $INSTALL_DOCKER"
log_info "  Nginx:     $INSTALL_NGINX"
log_info "  SSL:       $INSTALL_SSL"
log_info "================================================"

# ============================================================
# 1. Update system
# ============================================================
log_info "Updating system packages..."
apt-get update -y
apt-get upgrade -y

# ============================================================
# 2. Install base dependencies
# ============================================================
log_info "Installing base dependencies..."
apt-get install -y \
    curl wget git unzip socat \
    build-essential python3

# ============================================================
# 3. Install Node.js 20 LTS
# ============================================================
log_info "Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

log_info "Node.js version: $(node --version)"
log_info "npm version: $(npm --version)"

# ============================================================
# 4. Install Docker (optional)
# ============================================================
if [ "$INSTALL_DOCKER" = true ]; then
    log_info "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker $USER
    log_ok "Docker installed"
fi

# ============================================================
# 5. Install Nginx (optional)
# ============================================================
if [ "$INSTALL_NGINX" = true ]; then
    log_info "Installing Nginx..."
    apt-get install -y nginx
    log_ok "Nginx installed"
fi

# ============================================================
# 6. Install Certbot (optional)
# ============================================================
if [ "$INSTALL_SSL" = true ]; then
    log_info "Installing Certbot..."
    apt-get install -y certbot python3-certbot-nginx
    log_ok "Certbot installed"
fi

# ============================================================
# 7. Create system user
# ============================================================
log_info "Creating system user: $USER"
if id "$USER" &>/dev/null; then
    log_warn "User $USER already exists, skipping creation"
else
    adduser --disabled-password --gecos "" $USER
    log_ok "User $USER created"
fi

# ============================================================
# 8. Setup Orquester directory
# ============================================================
log_info "Setting up Orquester directory..."
ORQUESTER_DIR="/opt/orquester"
mkdir -p "$ORQUESTER_DIR"
chown -R $USER:$USER "$ORQUESTER_DIR"

# ============================================================
# 9. Clone Orquester repo
# ============================================================
log_info "Cloning Orquester repository..."
git clone https://github.com/vk6code/Ky-Orquester.git "$ORQUESTER_DIR/orquester"
chown -R $USER:$USER "$ORQUESTER_DIR/orquester"

# ============================================================
# 10. Install pnpm and project deps
# ============================================================
log_info "Installing pnpm..."
npm install -g pnpm@10.12.1

log_info "Installing project dependencies..."
cd "$ORQUESTER_DIR/orquester"
pnpm install --frozen-lockfile

# ============================================================
# 11. Build web client
# ============================================================
log_info "Building web client..."
pnpm --filter @orquester/web build
log_ok "Web client built to apps/web/dist/"

# ============================================================
# 12. Create .env with API keys (placeholder)
# ============================================================
log_info "Creating environment file..."
cat > "$ORQUESTER_DIR/.env" << ENVA
# Orquester Environment Variables
# Edit this file to add your API keys

# HTTP Authentication
ORQUESTER_HTTP_ENABLED=true
ORQUESTER_HTTP_HOST=0.0.0.0
ORQUESTER_HTTP_PORT=57831
ORQUESTER_HTTP_PASSWORD=$PASSWORD

# Agent API Keys (fill these in!)
# ANTHROPIC_API_KEY=sk-ant-your-key-here
# OPENAI_API_KEY=sk-proj-your-key-here
# KIMI_API_KEY=your-kimi-key-here
# DEEPSEEK_API_KEY=sk-ds-your-key-here
ENVA
chown $USER:$USER "$ORQUESTER_DIR/.env"
chmod 600 "$ORQUESTER_DIR/.env"
log_ok "Environment file created at $ORQUESTER_DIR/.env"
log_warn "IMPORTANT: Edit $ORQUESTER_DIR/.env and add your API keys!"

# ============================================================
# 13. Install agents (optional, requires API keys)
# ============================================================
log_info "Installing AI agents..."
cd "$ORQUESTER_DIR/orquester"
npm install -g @anthropic-ai/claude-code || log_warn "Claude Code installation failed (may need ANTHROPIC_API_KEY)"
npm install -g @openai/codex || log_warn "Codex installation failed (may need OPENAI_API_KEY)"
npm install -g @moonshot-ai/kimi-code || log_warn "Kimi Code installation failed (may need KIMI_API_KEY)"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent || log_warn "Pi Agent installation failed"
npm install -g @deepseek-ai/deepseek-cli || log_warn "DeepSeek CLI installation failed (may need DEEPSEEK_API_KEY)"
log_ok "Agents installed"

# ============================================================
# 14. Create workspaces directory
# ============================================================
log_info "Creating workspaces directory..."
mkdir -p "$ORQUESTER_DIR/workspaces"
chown -R $USER:$USER "$ORQUESTER_DIR/workspaces"

# ============================================================
# 15. Setup systemd service
# ============================================================
log_info "Setting up systemd service..."
cat > /etc/systemd/system/orquester.service << 'SERVICE'
[Unit]
Description=Orquester Daemon - AI Coding Agent Orchestrator
After=network.target

[Service]
Type=simple
User=orquester
Group=orquester
WorkingDirectory=/opt/orquester/orquester
Environment=NODE_ENV=production
EnvironmentFile=-/opt/orquester/.env
ExecStart=/opt/orquester/orquester/node_modules/.bin/tsx apps/daemon/src/cli.ts
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable orquester
log_ok "Systemd service configured"

# ============================================================
# 16. Configure Nginx (if domain provided)
# ============================================================
if [ "$INSTALL_NGINX" = true ] && [ -n "$DOMAIN" ]; then
    log_info "Configuring Nginx..."
    cp deploy/nginx.conf /etc/nginx/sites-available/orquester 2>/dev/null || {
        # Use inline config if deploy dir not available
        cat > /etc/nginx/sites-available/orquester << NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$server_name\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:57831;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
}
NGINX
    }

    ln -sf /etc/nginx/sites-available/orquester /etc/nginx/sites-enabled/
    nginx -t && systemctl restart nginx
    log_ok "Nginx configured"

    # Get SSL cert
    if [ "$INSTALL_SSL" = true ]; then
        log_info "Obtaining SSL certificate..."
        mkdir -p /var/www/certbot
        certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@$(echo "$DOMAIN" | cut -d. -f2-)
        log_ok "SSL certificate obtained"
    fi
fi

# ============================================================
# 17. Start the daemon
# ============================================================
log_info "Starting Orquester daemon..."
systemctl start orquester
sleep 2

if systemctl is-active --quiet orquester; then
    log_ok "Orquester daemon is running!"
else
    log_error "Orquester daemon failed to start. Check logs:"
    log_error "  journalctl -u orquester -n 50"
    log_error "  tail -f /opt/orquester/data/daemon/logs/\$(date +%Y-%m-%d).log"
    exit 1
fi

# ============================================================
# 18. Firewall
# ============================================================
if command -v ufw &>/dev/null; then
    log_info "Configuring firewall..."
    ufw allow 22/tcp || true
    if [ "$INSTALL_NGINX" = true ]; then
        ufw allow 80/tcp || true
        ufw allow 443/tcp || true
    fi
    ufw --force enable 2>/dev/null || true
    log_ok "Firewall configured"
fi

# ============================================================
# Summary
# ============================================================
echo ""
log_info "================================================"
log_info "  Orquester Setup Complete!"
log_info "================================================"
echo ""
log_info "  Access URL:    ${DOMAIN:-http://YOUR_VPS_IP:57831}"
log_info "  HTTP Password: $PASSWORD"
log_info "  Data Dir:      $ORQUESTER_DIR/data"
log_info "  Config:        $ORQUESTER_DIR/.env"
log_info "================================================"
echo ""
log_info "  Next steps:"
log_info "  1. Edit $ORQUESTER_DIR/.env and add your API keys"
log_info "  2. Restart: sudo systemctl restart orquester"
log_info "  3. Check status: sudo systemctl status orquester"
log_info "  4. View logs: sudo journalctl -u orquester -f"
echo ""
