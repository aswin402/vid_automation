#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--desktop" ]]; then
  if [[ "$(uname -s)" == "Linux" ]] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "⚠️  Missing Linux WebKitGTK development headers required to compile the native Tauri window."
    echo "👉 Run this once in your terminal:"
    echo "   sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev"
    exit 1
  fi
  echo "🖥  Launching CelestiaVid Native Desktop App (Tauri v2 + Pure Rust)..."
  exec "${ROOT_DIR}/apps/web/node_modules/.bin/tauri" dev
fi

API_PID=""
WEB_PID=""

cleanup() {
  echo ""
  echo "⏹ Stopping CelestiaVid Rust Engine and Studio UI..."
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    kill "${API_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WEB_PID}" ]] && kill -0 "${WEB_PID}" 2>/dev/null; then
    kill "${WEB_PID}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "✅ Stopped."
}

trap cleanup EXIT INT TERM

echo "🦀 Building & starting CelestiaVid Pure Rust Engine on http://127.0.0.1:8000 ..."
cargo build -p celestiavid-core --bin celestiavid-server
(
  cd "${ROOT_DIR}"
  HOST=127.0.0.1 PORT=8000 "${ROOT_DIR}/target/debug/celestiavid-server"
) &
API_PID=$!

echo "⚡ Starting CelestiaVid React + Vite Studio on http://localhost:5173 ..."
(
  cd "${ROOT_DIR}/apps/web"
  bun run dev -- --host 0.0.0.0 --port 5173
) &
WEB_PID=$!

echo "----------------------------------------------------------------"
echo "🎬 Studio UI       : http://localhost:5173"
echo "🦀 Rust Engine API : http://127.0.0.1:8000/health"
echo "🖥  Desktop Window  : ./dev.sh --desktop  (or: just desktop)"
echo "Press Ctrl+C to stop."
echo "----------------------------------------------------------------"

wait -n "${API_PID}" "${WEB_PID}"
