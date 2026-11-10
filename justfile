# CelestiaVid — Pure Rust + Tauri v2 Desktop Video Studio

default:
    @just --list

# Launch Native Desktop App in development mode (Tauri v2 + Pure Rust)
desktop:
    ./dev.sh --desktop

# Build single-file native Desktop Installers (.deb, .rpm, .AppImage, .msi, .dmg)
build-desktop:
    @if [ "$(uname -s)" = "Linux" ] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then \
        echo "Missing Linux GTK/WebKit2GTK dev headers. Run: just install-linux-deps"; \
        exit 1; \
    fi
    ./apps/web/node_modules/.bin/tauri build

# Install one-time Linux GTK/WebKit2GTK headers required by Tauri v2 on Ubuntu/Debian
install-linux-deps:
    sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# Run Pure Rust media server (8000) + React/Vite Studio UI (5173)
dev:
    ./dev.sh

# Run only the Pure Rust media server
dev-rust:
    cargo run -p celestiavid-core --bin celestiavid-server

# Run only the React + Vite frontend
dev-web:
    bun --cwd apps/web run dev -- --host 0.0.0.0 --port 5173

# Install frontend packages & compile Rust workspace
setup:
    bun install --cwd apps/web
    cargo build -p celestiavid-core

# Run Pure Rust unit + E2E media pipeline tests & TypeScript strict checks
test:
    cargo test -p celestiavid-core
    ./apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.app.json --noEmit

# Build optimized release Rust binary + production frontend bundle
build:
    cargo build --release -p celestiavid-core
    ./apps/web/node_modules/.bin/vite build apps/web
