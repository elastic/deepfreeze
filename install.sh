#!/usr/bin/env bash
# Deepfreeze Installer
# Installs deepfreeze packages, builds the web frontend, scaffolds config,
# and optionally sets up the systemd service.
#
# Usage:
#   ./install.sh                  # Interactive install
#   ./install.sh --cli-only       # Install CLI + core only (no server)
#   ./install.sh --dev            # Development mode (editable installs)
#   ./install.sh --provider aws   # Storage provider: aws (default), azure, gcp
#   ./install.sh --uninstall      # Remove deepfreeze packages

set -euo pipefail

# -- Colors --
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}==>${NC} ${BOLD}$*${NC}"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
warn()  { echo -e "${YELLOW}  !${NC} $*"; }
err()   { echo -e "${RED}  ✗${NC} $*" >&2; }
ask()   { echo -en "${BLUE}  ?${NC} $* "; }

fatal() { err "$*"; exit 1; }

# -- Defaults --
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ONLY=false
DEV_MODE=false
UNINSTALL=false
YES_MODE=false
PROVIDER=""
CONFIG_DIR="${HOME}/.deepfreeze"
CONFIG_FILE="${CONFIG_DIR}/config.yml"

# -- Parse args --
while [[ $# -gt 0 ]]; do
  case $1 in
    --cli-only)  CLI_ONLY=true; shift ;;
    --dev)       DEV_MODE=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -y|--yes)    YES_MODE=true; shift ;;
    --provider)
      PROVIDER="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --cli-only         Install CLI + core only (no server/web UI)"
      echo "  --dev              Development mode (pip install -e)"
      echo "  --provider NAME    Storage provider: aws (default), azure, gcp"
      echo "  --uninstall        Remove deepfreeze packages"
      echo "  -y, --yes          Answer yes to all prompts (non-interactive)"
      echo "  -h, --help         Show this help"
      exit 0
      ;;
    *) fatal "Unknown option: $1"; ;;
  esac
done

# -- Uninstall --
if $UNINSTALL; then
  info "Uninstalling deepfreeze packages..."
  python3 -m pip uninstall -y deepfreeze-server deepfreeze-cli deepfreeze-core 2>/dev/null || \
    pip uninstall -y deepfreeze-server deepfreeze-cli deepfreeze-core 2>/dev/null || true
  ok "Packages removed"
  echo ""
  warn "Config file at ${CONFIG_FILE} was NOT removed."
  warn "systemd units (if installed) were NOT removed."
  echo "  To remove manually:"
  echo "    rm -rf ${CONFIG_DIR}"
  echo "    sudo rm /etc/systemd/system/deepfreeze-server.service"
  echo "    sudo systemctl daemon-reload"
  exit 0
fi

# -- Pre-flight checks --
info "Checking prerequisites..."

# Python
if ! command -v python3 &>/dev/null; then
  fatal "Python 3 is required but not found."
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

if [[ "$PYTHON_MAJOR" -lt 3 ]] || [[ "$PYTHON_MAJOR" -eq 3 && "$PYTHON_MINOR" -lt 10 ]]; then
  if $CLI_ONLY && [[ "$PYTHON_MINOR" -ge 8 ]]; then
    ok "Python ${PYTHON_VERSION} (sufficient for CLI-only)"
  else
    err "Python 3.10+ is required for the server (found ${PYTHON_VERSION})."
    fatal "Use --cli-only to install just the CLI (requires Python 3.8+)."
  fi
else
  ok "Python ${PYTHON_VERSION}"
fi

# pip — resolve to a Python 3 pip and use it consistently throughout
if python3 -m pip --version &>/dev/null 2>&1; then
  PIP="python3 -m pip"
elif command -v pip3 &>/dev/null; then
  PIP="pip3"
elif command -v pip &>/dev/null; then
  # Verify it's for Python 3
  PIP_PYVER=$(pip --version 2>/dev/null | grep -o 'python [0-9]\+' | awk '{print $2}')
  if [[ "$PIP_PYVER" == "3" ]]; then
    PIP="pip"
  else
    fatal "pip found but it targets Python ${PIP_PYVER:-unknown}. Install pip for Python 3."
  fi
else
  fatal "pip for Python 3 is required but not found."
fi
ok "pip (${PIP})"

# Node.js (only for server)
if ! $CLI_ONLY; then
  if ! command -v node &>/dev/null; then
    err "Node.js is required to build the web frontend."
    fatal "Install Node.js 18+ or use --cli-only to skip the server."
  fi
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -lt 18 ]]; then
    err "Node.js 18+ is required (found $(node -v))."
    fatal "Install Node.js 18+ from https://nodejs.org or use --cli-only."
  fi
  ok "Node.js $(node -v)"

  if ! command -v npm &>/dev/null; then
    fatal "npm is required to build the web frontend."
  fi
  ok "npm $(npm --version)"
fi

echo ""

# -- Resolve storage provider --
if [[ -z "$PROVIDER" ]]; then
  if $YES_MODE; then
    PROVIDER="aws"
  else
    ask "Storage provider [aws/azure/gcp] (default: aws):"
    read -r PROVIDER
    PROVIDER="${PROVIDER:-aws}"
  fi
fi

case "$PROVIDER" in
  aws|azure|gcp) ;;
  *) fatal "Unknown provider '${PROVIDER}'. Choose: aws, azure, gcp" ;;
esac
ok "Provider: ${PROVIDER}"
echo ""

# -- Helper: pip install with full error output on failure --
_pip_install() {
  local label="$1"; shift
  local log; log=$(mktemp)
  if ! $PIP install "$@" > "$log" 2>&1; then
    err "Failed to install ${label}:"
    cat "$log" >&2
    rm -f "$log"
    exit 1
  fi
  rm -f "$log"
  ok "${label}"
}

# -- Build frontend (before pip install so assets get packaged) --
STATIC_DIR="${SCRIPT_DIR}/packages/deepfreeze-server/deepfreeze_server/static"
if ! $CLI_ONLY; then
  FRONTEND_DIR="${SCRIPT_DIR}/packages/deepfreeze-server/frontend"
  if [[ -f "${FRONTEND_DIR}/package.json" ]]; then
    info "Building web frontend..."

    if ! (cd "$FRONTEND_DIR" && npm install); then
      fatal "npm install failed. See output above."
    fi
    ok "npm dependencies installed"

    if ! (cd "$FRONTEND_DIR" && npm run build); then
      fatal "Frontend build failed. See output above."
    fi

    if [[ ! -f "${FRONTEND_DIR}/dist/index.html" ]]; then
      fatal "Build completed but dist/index.html is missing. The build may be incomplete."
    fi
    ok "Frontend built"

    # Copy built assets into the Python package so pip install includes them
    rm -rf "$STATIC_DIR"
    cp -r "${FRONTEND_DIR}/dist" "$STATIC_DIR"
    ok "Frontend assets copied to package"
  else
    fatal "Frontend package.json not found at ${FRONTEND_DIR}/package.json"
  fi
  echo ""
fi

# -- Install Python packages --
info "Installing Python packages..."

PIP_FLAGS=""
if $DEV_MODE; then
  PIP_FLAGS="-e"
  warn "Development mode: using editable installs"
fi

# Install core with provider extras (azure/gcp are optional; aws/boto3 is always included)
case "$PROVIDER" in
  azure) CORE_EXTRAS="[azure]" ;;
  gcp)   CORE_EXTRAS="[gcp]" ;;
  *)     CORE_EXTRAS="" ;;
esac

_pip_install "deepfreeze-core${CORE_EXTRAS}" \
  $PIP_FLAGS "${SCRIPT_DIR}/packages/deepfreeze-core${CORE_EXTRAS}"
_pip_install "deepfreeze-cli" \
  $PIP_FLAGS "${SCRIPT_DIR}/packages/deepfreeze-cli"

if ! $CLI_ONLY; then
  _pip_install "deepfreeze-server" \
    $PIP_FLAGS "${SCRIPT_DIR}/packages/deepfreeze-server"
fi

echo ""

# -- Scaffold config --
if [[ ! -f "$CONFIG_FILE" ]]; then
  info "Creating configuration file..."
  mkdir -p "$CONFIG_DIR"

  ask "Elasticsearch host [https://localhost:9200]:"
  read -r ES_HOST
  ES_HOST="${ES_HOST:-https://localhost:9200}"

  ask "Elasticsearch username [elastic]:"
  read -r ES_USER
  ES_USER="${ES_USER:-elastic}"

  ask "Elasticsearch password:"
  read -rs ES_PASS
  echo ""

  SERVER_PORT=""
  if ! $CLI_ONLY; then
    ask "Server port [8000]:"
    read -r SERVER_PORT
    SERVER_PORT="${SERVER_PORT:-8000}"
  fi

  # Write config using Python + PyYAML so all special characters in
  # credentials are safely handled — no shell heredoc expansion.
  python3 - "$CONFIG_FILE" "$ES_HOST" "$ES_USER" "$ES_PASS" \
            "$SERVER_PORT" "$CLI_ONLY" << 'PYEOF'
import sys, datetime
try:
    import yaml
except ImportError:
    yaml = None

config_path  = sys.argv[1]
es_host      = sys.argv[2]
es_user      = sys.argv[3]
es_pass      = sys.argv[4]
server_port  = sys.argv[5]   # empty string when cli-only
cli_only     = sys.argv[6] == "true"

ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

if yaml is not None:
    cfg = {
        "elasticsearch": {
            "hosts": [es_host],
            "username": es_user,
            "password": es_pass,
        },
        "logging": {"loglevel": "INFO"},
    }
    if not cli_only and server_port:
        cfg["server"] = {"host": "0.0.0.0", "port": int(server_port)}

    header = (
        f"# Deepfreeze Configuration\n"
        f"# Generated by install.sh on {ts}\n\n"
    )
    with open(config_path, "w") as fh:
        fh.write(header)
        yaml.dump(cfg, fh, default_flow_style=False, allow_unicode=True)
else:
    # Fallback: manual safe quoting via json (valid YAML superset for scalars)
    import json
    lines = [
        f"# Deepfreeze Configuration",
        f"# Generated by install.sh on {ts}",
        "",
        "elasticsearch:",
        "  hosts:",
        f"    - {json.dumps(es_host)}",
        f"  username: {json.dumps(es_user)}",
        f"  password: {json.dumps(es_pass)}",
        "",
        "logging:",
        "  loglevel: INFO",
    ]
    if not cli_only and server_port:
        lines += ["", "server:", f"  host: 0.0.0.0", f"  port: {server_port}"]
    with open(config_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
PYEOF

  chmod 600 "$CONFIG_FILE"

  # Verify the written config is valid YAML
  if ! python3 -c "import yaml; yaml.safe_load(open('$CONFIG_FILE'))" 2>/dev/null; then
    err "Generated config file is not valid YAML. Check ${CONFIG_FILE}."
    exit 1
  fi
  ok "Config written to ${CONFIG_FILE} (mode 600)"

  # Test Elasticsearch connectivity (non-fatal — misconfigured credentials
  # shouldn't block the install, but the user should know immediately)
  info "Testing Elasticsearch connectivity..."
  if python3 - "$CONFIG_FILE" << 'PYEOF' 2>/dev/null
import sys, ssl, base64, yaml
try:
    import urllib.request
    cfg_path = sys.argv[1]
    with open(cfg_path) as f:
        cfg = yaml.safe_load(f)
    es = cfg.get("elasticsearch", {})
    host = (es.get("hosts") or ["https://localhost:9200"])[0].rstrip("/")
    user = es.get("username", "")
    pw   = str(es.get("password", ""))
    url  = host + "/_cluster/health"
    req  = urllib.request.Request(url)
    if user:
        token = base64.b64encode(f"{user}:{pw}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    urllib.request.urlopen(req, context=ctx, timeout=5)
    sys.exit(0)
except Exception:
    sys.exit(1)
PYEOF
  then
    ok "Elasticsearch is reachable at ${ES_HOST}"
  else
    warn "Could not reach Elasticsearch at ${ES_HOST}"
    warn "Check host, credentials, and network access before running deepfreeze commands."
    warn "Update the config if needed: ${CONFIG_FILE}"
  fi
else
  ok "Config file already exists: ${CONFIG_FILE}"
fi

echo ""

# -- systemd setup --
if ! $CLI_ONLY && [[ -d /etc/systemd/system ]]; then
  UNIT_FILE="/etc/systemd/system/deepfreeze-server.service"

  if systemctl is-active --quiet deepfreeze-server 2>/dev/null; then
    # Service is already running — offer to restart it
    ok "deepfreeze-server service is running"
    if $YES_MODE; then
      RESTART_SERVICE="y"
    else
      ask "Restart deepfreeze-server to pick up changes? [y/N]:"
      read -r RESTART_SERVICE
    fi
    if [[ "${RESTART_SERVICE,,}" == "y" ]]; then
      sudo systemctl restart deepfreeze-server
      ok "deepfreeze-server restarted"
      echo ""
      echo "  View logs:    journalctl -u deepfreeze-server -f"
    fi
  else
    if $YES_MODE; then
      INSTALL_SYSTEMD="y"
    else
      ask "Install systemd service for deepfreeze-server? [y/N]:"
      read -r INSTALL_SYSTEMD
    fi
    if [[ "${INSTALL_SYSTEMD,,}" == "y" ]]; then
      # Verify sudo is available before proceeding
      if ! sudo -v 2>/dev/null; then
        warn "sudo is not available — cannot install systemd service automatically."
        warn "Install it manually: see packages/deepfreeze-server/deepfreeze-server.service"
      else
        DEEPFREEZE_SERVER_BIN=$(command -v deepfreeze-server 2>/dev/null || \
          echo "$(python3 -c 'import sysconfig; print(sysconfig.get_path("scripts"))')/deepfreeze-server")
        CURRENT_USER=$(whoami)

        sudo tee "$UNIT_FILE" > /dev/null << EOF
[Unit]
Description=Deepfreeze Server
After=network.target elasticsearch.service

[Service]
Type=simple
User=${CURRENT_USER}
ExecStart=${DEEPFREEZE_SERVER_BIN} --config ${CONFIG_FILE}
WorkingDirectory=${HOME}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
ReadWritePaths=${CONFIG_DIR}

[Install]
WantedBy=multi-user.target
EOF

        sudo systemctl daemon-reload
        ok "systemd unit installed: ${UNIT_FILE}"

        if $YES_MODE; then
          START_NOW="y"
        else
          ask "Enable and start deepfreeze-server now? [y/N]:"
          read -r START_NOW
        fi
        if [[ "${START_NOW,,}" == "y" ]]; then
          sudo systemctl enable deepfreeze-server
          sudo systemctl start deepfreeze-server
          ok "deepfreeze-server is running"
          echo ""
          echo "  View logs:    journalctl -u deepfreeze-server -f"
          echo "  Stop:         sudo systemctl stop deepfreeze-server"
          echo "  Restart:      sudo systemctl restart deepfreeze-server"
        fi
      fi
    fi
  fi
fi

echo ""

# -- Post-install verification --
info "Verifying installation..."
SCRIPTS_DIR=$(python3 -c 'import sysconfig; print(sysconfig.get_path("scripts"))')
PATH_HINT=false

if ! command -v deepfreeze &>/dev/null; then
  warn "deepfreeze not found in PATH."
  warn "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.) and open a new terminal:"
  warn "  export PATH=\"${SCRIPTS_DIR}:\$PATH\""
  PATH_HINT=true
else
  ok "deepfreeze in PATH"
  if deepfreeze --version &>/dev/null 2>&1; then
    ok "deepfreeze: $(deepfreeze --version 2>&1)"
  else
    err "deepfreeze --version failed — the package may not have installed correctly."
    err "Try: python3 -m deepfreeze --version"
  fi
fi

if ! $CLI_ONLY; then
  if ! command -v deepfreeze-server &>/dev/null; then
    warn "deepfreeze-server not found in PATH (see PATH note above)."
    PATH_HINT=true
  else
    ok "deepfreeze-server in PATH"
  fi
fi

echo ""

# -- Summary --
info "Installation complete!"
echo ""
echo "  Installed:"
ok "deepfreeze-core${CORE_EXTRAS}"
ok "deepfreeze-cli"
if ! $CLI_ONLY; then
  ok "deepfreeze-server"
  ok "Web UI frontend"
fi
echo ""
echo "  Configuration: ${CONFIG_FILE}"
echo ""

if $PATH_HINT; then
  warn "PATH update required — see above. Commands below will not work until PATH is updated."
  echo ""
fi

echo "  First-time setup (required before other commands):"
echo "    deepfreeze --config ${CONFIG_FILE} setup \\"
echo "      --provider ${PROVIDER} \\"
echo "      --bucket_name_prefix my-deepfreeze \\"
echo "      --repo_name_prefix my-deepfreeze"
echo ""
echo "  Quick start:"
echo "    deepfreeze --config ${CONFIG_FILE} status"
if ! $CLI_ONLY; then
  echo "    deepfreeze-server --config ${CONFIG_FILE}"
  echo ""
  echo "  Web UI: http://localhost:${SERVER_PORT:-8000}"
fi
echo ""
echo "  For more information:"
echo "    deepfreeze --help"
echo "    ${SCRIPT_DIR}/README.md"
