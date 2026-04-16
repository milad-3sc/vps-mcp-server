#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8443}"
HOST="${HOST:-0.0.0.0}"
RUN_DIR="${RUN_DIR:-$REPO_DIR/.codespace}"
PID_FILE="$RUN_DIR/mcp-server.pid"
LOG_FILE="$RUN_DIR/mcp-server.log"
mkdir -p "$RUN_DIR"

stop_existing_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Stopping existing MCP server (PID $pid)..."
      kill "$pid"
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi

  if command -v lsof >/dev/null 2>&1; then
    local port_pid
    port_pid="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${port_pid:-}" ]; then
      echo "Port $PORT is already in use by PID $port_pid. Stopping it..."
      kill "$port_pid" || true
      sleep 1
    fi
  fi
}

print_connection_details() {
  local codespace_url=""
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    codespace_url="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  fi

  cat <<EOF

MCP server is running.
Local endpoint:  http://127.0.0.1:${PORT}
Bearer token:    ${BEARER_TOKEN}
Log file:        ${LOG_FILE}
EOF

  if [ -n "$codespace_url" ]; then
    cat <<EOF
Codespaces URL:  ${codespace_url}

If you need the port visible outside the Codespace, expose port ${PORT} in the Ports tab.
EOF
  fi
}

echo "Preparing MCP server in $REPO_DIR..."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found in PATH." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/package.json" ] || [ ! -f "$REPO_DIR/index.js" ]; then
  echo "Expected package.json and index.js in $REPO_DIR." >&2
  exit 1
fi

cd "$REPO_DIR"
echo "Installing npm dependencies..."
npm ci --omit=dev

if [ -n "${BEARER_TOKEN:-}" ]; then
  :
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  BEARER_TOKEN="$GITHUB_TOKEN"
else
  echo "GITHUB_TOKEN is required in the Codespaces environment." >&2
  exit 1
fi

stop_existing_server

echo "Starting MCP server on ${HOST}:${PORT}..."
nohup env PORT="$PORT" HOST="$HOST" BEARER_TOKEN="$BEARER_TOKEN" node "$REPO_DIR/index.js" \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "The MCP server failed to start. Check $LOG_FILE for details." >&2
  exit 1
fi

print_connection_details
