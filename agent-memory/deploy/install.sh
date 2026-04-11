#!/usr/bin/env bash
# Idempotent installer for agent-memory service.
# Run as root or with sudo on Ubuntu/Debian.
set -euo pipefail

SERVICE_USER="agent-memory"
INSTALL_DIR="/opt/agent-memory"
DATA_DIR="/var/lib/agent-memory"
SERVICE_NAME="agent-memory"
PYTHON_MIN="3.11"

echo "=== Agent Memory Installer ==="

# --- Check Python version ---
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found. Install Python >= $PYTHON_MIN first."
    exit 1
fi

PY_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
if python3 -c "import sys; exit(0 if sys.version_info >= (3,11) else 1)"; then
    echo "Python $PY_VERSION detected. OK."
else
    echo "ERROR: Python >= $PYTHON_MIN required, found $PY_VERSION."
    exit 1
fi

# --- Create service user ---
if id "$SERVICE_USER" &>/dev/null; then
    echo "User $SERVICE_USER already exists."
else
    echo "Creating system user $SERVICE_USER..."
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# --- Create directories ---
echo "Setting up directories..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$DATA_DIR"

# --- Copy application ---
echo "Installing application to $INSTALL_DIR..."
cp -r . "$INSTALL_DIR/"

# --- Set up virtual environment ---
if [ ! -d "$INSTALL_DIR/.venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$INSTALL_DIR/.venv"
fi

echo "Installing dependencies..."
"$INSTALL_DIR/.venv/bin/pip" install --upgrade pip -q
"$INSTALL_DIR/.venv/bin/pip" install -e "$INSTALL_DIR" -q

# --- Set permissions ---
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# --- Install systemd service ---
if [ -f "$INSTALL_DIR/deploy/$SERVICE_NAME.service" ]; then
    echo "Installing systemd service..."
    cp "$INSTALL_DIR/deploy/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    echo "Service installed and enabled."
    echo ""
    echo "Configure environment variables in /etc/systemd/system/$SERVICE_NAME.service"
    echo "Then start with: systemctl start $SERVICE_NAME"
else
    echo "WARNING: systemd service file not found at $INSTALL_DIR/deploy/$SERVICE_NAME.service"
fi

# --- Summary ---
echo ""
echo "=== Installation Complete ==="
echo "  Install dir:  $INSTALL_DIR"
echo "  Data dir:     $DATA_DIR"
echo "  Service user: $SERVICE_USER"
echo "  Service:      $SERVICE_NAME"
echo ""
echo "Next steps:"
echo "  1. Edit /etc/systemd/system/$SERVICE_NAME.service for your environment"
echo "  2. Set AGENT_MEMORY_API_KEY in the service file"
echo "  3. systemctl start $SERVICE_NAME"
echo "  4. curl http://127.0.0.1:8765/api/v1/health"
