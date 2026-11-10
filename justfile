# CelestiaVid AI Video Automation Platform — Root Justfile

default:
    @just --list

# Run both FastAPI backend (8000) and React+Vite frontend (5173) in a single command
dev:
    ./dev.sh

# Run only the FastAPI backend server
dev-api:
    cd apps/api && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Run only the React + Vite frontend server
dev-web:
    cd apps/web && bun run dev -- --host 0.0.0.0 --port 5173

# Install/sync dependencies for both backend and frontend
setup:
    cd apps/api && uv sync
    cd apps/web && bun install

# Run backend unit & E2E media pipeline tests + frontend TypeScript check
test:
    cd apps/api && uv run pytest -v
    ./apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.app.json --noEmit

# Build frontend production bundle
build:
    cd apps/web && bun run build
