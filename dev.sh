#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

API_PID=""
WEB_PID=""

cleanup() {
  echo ""
  echo "⏹ Stopping CelestiaVid API and Web servers..."
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

echo "🚀 Starting CelestiaVid FastAPI Backend on http://localhost:8000 ..."
(
  cd "${ROOT_DIR}/apps/api"
  uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
) &
API_PID=$!

echo "⚡ Starting CelestiaVid React + Vite Studio on http://localhost:5173 ..."
(
  cd "${ROOT_DIR}/apps/web"
  bun run dev -- --host 0.0.0.0 --port 5173
) &
WEB_PID=$!

echo "----------------------------------------------------------------"
echo "🎬 Studio UI : http://localhost:5173"
echo "🔌 REST API  : http://localhost:8000 (Docs: http://localhost:8000/docs)"
echo "Press Ctrl+C to stop both servers."
echo "----------------------------------------------------------------"

wait -n "${API_PID}" "${WEB_PID}"
