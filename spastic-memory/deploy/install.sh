#!/usr/bin/env bash
# install.sh — deploy spastic-memory to an AWS EC2 instance (Amazon Linux 2023 / Ubuntu)
# Usage: bash install.sh
# Run as root or with sudo.
set -euo pipefail

SERVICE_USER="spastic"
INSTALL_DIR="/opt/spastic-memory"
DATA_DIR="/workspace/.spastic"
SERVICE_NAME="spastic-memory"

echo "==> Creating service user..."
id "$SERVICE_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> Installing system dependencies..."
if command -v dnf &>/dev/null; then
    dnf install -y python3.11 python3.11-pip python3.11-devel gcc git
elif command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y python3.11 python3.11-venv python3.11-dev gcc git
fi

echo "==> Setting up install directory..."
mkdir -p "$INSTALL_DIR"
cp -r "$(dirname "$0")/.." "$INSTALL_DIR/src"

echo "==> Creating virtual environment..."
python3.11 -m venv "$INSTALL_DIR/venv"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip
"$INSTALL_DIR/venv/bin/pip" install -e "$INSTALL_DIR/src"

echo "==> Warming up embedding model (downloads ~80MB on first run)..."
"$INSTALL_DIR/venv/bin/python" -c "
from sentence_transformers import SentenceTransformer
SentenceTransformer('all-MiniLM-L6-v2')
print('Model ready.')
"

echo "==> Setting up data directory..."
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

echo "==> Installing systemd service..."
cp "$(dirname "$0")/spastic-memory.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "==> Waiting for service to start..."
sleep 3
systemctl status "$SERVICE_NAME" --no-pager

echo ""
echo "✅ spastic-memory installed and running!"
echo "   Health check: curl http://127.0.0.1:8765/api/v1/health"
echo "   Logs: journalctl -u spastic-memory -f"
echo "   Config: /opt/spastic-memory/.env"
