#!/usr/bin/env bash
# ==============================================================================
# CelestiaVid Desktop — Single-Command Installer (Linux & macOS)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aswin402/vid_automation/main/install.sh | bash
#
# Environment Variables (Optional):
#   CELESTIAVID_VERSION  Release tag to install (default: "latest", e.g. "v0.2.0")
#   CELESTIAVID_FORMAT   "auto" (default), "deb", "appimage", or "dmg"
#   CELESTIAVID_REPO     GitHub repository (default: "aswin402/vid_automation")
# ==============================================================================
set -euo pipefail

REPO="${CELESTIAVID_REPO:-aswin402/vid_automation}"
VERSION="${CELESTIAVID_VERSION:-latest}"
FORMAT="${CELESTIAVID_FORMAT:-auto}"
DRY_RUN="${CELESTIAVID_DRY_RUN:-0}"

for arg in "$@"; do
  case "$arg" in
    --appimage) FORMAT="appimage" ;;
    --deb)      FORMAT="deb" ;;
    --dmg)      FORMAT="dmg" ;;
    --dry-run)  DRY_RUN="1" ;;
  esac
done

echo "🎬 CelestiaVid Desktop Installer"
echo "--------------------------------------------------------"

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

if [[ "${VERSION}" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

echo "🔍 Fetching release metadata (${VERSION}) from ${REPO}..."
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: CelestiaVid-Installer" "${API_URL}")"

TAG_NAME="$(printf '%s\n' "${RELEASE_JSON}" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')"
if [[ -z "${TAG_NAME}" ]]; then
  echo "❌ Failed to resolve release tag from GitHub API (${API_URL})." >&2
  exit 1
fi
echo "📦 Resolved release: ${TAG_NAME}"

extract_asset_url() {
  local pattern="$1"
  printf '%s\n' "${RELEASE_JSON}" \
    | grep -oE '"browser_download_url":[[:space:]]*"[^"]+"' \
    | sed -E 's/"browser_download_url":[[:space:]]*"([^"]+)"/\1/' \
    | grep -E "${pattern}" \
    | head -n 1 || true
}

TMP_DIR="$(mktemp -d)"
chmod 755 "${TMP_DIR}"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

install_linux_deb() {
  local deb_url="$1"
  local deb_file="${TMP_DIR}/celestiavid.deb"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "🧪 [Dry Run] Would download & install .deb: ${deb_url}"
    return 0
  fi
  echo "⬇️  Downloading Debian/Ubuntu package..."
  echo "   ${deb_url}"
  curl -fL --progress-bar "${deb_url}" -o "${deb_file}"
  chmod 644 "${deb_file}"

  echo "🔧 Installing via apt-get (resolving WebKitGTK & desktop dependencies)..."
  if [[ "$(id -u)" -eq 0 ]]; then
    apt-get update -qq
    apt-get install -y "${deb_file}"
    if [[ -x "/usr/bin/celestiavid-desktop" ]] && [[ ! -e "/usr/local/bin/celestiavid" ]]; then
      ln -sf /usr/bin/celestiavid-desktop /usr/local/bin/celestiavid || true
    fi
  else
    sudo apt-get update -qq
    sudo apt-get install -y "${deb_file}"
    if [[ -x "/usr/bin/celestiavid-desktop" ]] && [[ ! -e "/usr/local/bin/celestiavid" ]]; then
      sudo ln -sf /usr/bin/celestiavid-desktop /usr/local/bin/celestiavid || true
    fi
  fi

  echo ""
  echo "✅ CelestiaVid ${TAG_NAME} installed!"
  echo "👉 Launch from your Applications menu or run: celestiavid"
}

install_linux_appimage() {
  local appimage_url="$1"
  local bin_dir="${HOME}/.local/bin"
  local apps_dir="${HOME}/.local/share/applications"
  local target_bin="${bin_dir}/celestiavid"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "🧪 [Dry Run] Would download & install AppImage: ${appimage_url} -> ${target_bin}"
    return 0
  fi

  mkdir -p "${bin_dir}" "${apps_dir}"
  echo "⬇️  Downloading standalone Linux AppImage..."
  echo "   ${appimage_url}"
  curl -fL --progress-bar "${appimage_url}" -o "${target_bin}"
  chmod +x "${target_bin}"

  cat > "${apps_dir}/celestiavid.desktop" <<EOF
[Desktop Entry]
Name=CelestiaVid
Comment=AI Branded Video Automation Studio
Exec=${target_bin}
Terminal=false
Type=Application
Categories=AudioVideo;Video;AudioVideoEditing;
EOF

  echo ""
  echo "✅ CelestiaVid ${TAG_NAME} AppImage installed to: ${target_bin}"
  if [[ ":${PATH}:" != *":${bin_dir}:"* ]]; then
    echo "ℹ️  Add ~/.local/bin to your PATH if needed:"
    echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  echo "👉 Run now: ${target_bin}"
}

install_macos_dmg() {
  local dmg_url="$1"
  local dmg_file="${TMP_DIR}/CelestiaVid.dmg"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "🧪 [Dry Run] Would download & mount macOS DMG: ${dmg_url}"
    return 0
  fi
  echo "⬇️  Downloading macOS Disk Image (.dmg)..."
  echo "   ${dmg_url}"
  curl -fL --progress-bar "${dmg_url}" -o "${dmg_file}"

  echo "💿 Mounting CelestiaVid.dmg..."
  local mount_output
  mount_output="$(hdiutil attach "${dmg_file}" -nobrowse -readonly)"
  local mount_point
  mount_point="$(printf '%s\n' "${mount_output}" | grep -o '/Volumes/.*' | head -n 1)"

  if [[ -z "${mount_point}" ]] || [[ ! -d "${mount_point}/CelestiaVid.app" ]]; then
    echo "❌ Could not locate CelestiaVid.app inside mounted DMG." >&2
    exit 1
  fi

  local dest_dir="/Applications"
  if [[ ! -w "/Applications" ]]; then
    dest_dir="${HOME}/Applications"
    mkdir -p "${dest_dir}"
  fi

  echo "📂 Copying CelestiaVid.app to ${dest_dir}..."
  rm -rf "${dest_dir}/CelestiaVid.app"
  cp -R "${mount_point}/CelestiaVid.app" "${dest_dir}/CelestiaVid.app"
  hdiutil detach "${mount_point}" -quiet || true

  # Clear Gatekeeper quarantine flag for unsigned open-source release builds
  xattr -cr "${dest_dir}/CelestiaVid.app" 2>/dev/null || true

  echo ""
  echo "✅ CelestiaVid ${TAG_NAME} installed to ${dest_dir}/CelestiaVid.app!"
  echo "👉 Launch via Spotlight or run: open -a \"${dest_dir}/CelestiaVid.app\""
}

case "${OS_NAME}" in
  Linux)
    if [[ "${ARCH_NAME}" != "x86_64" && "${ARCH_NAME}" != "amd64" ]]; then
      echo "❌ Prebuilt Linux binaries currently target x86_64/amd64 (detected: ${ARCH_NAME})." >&2
      echo "   Build from source instead: git clone https://github.com/${REPO}.git && cd vid_automation && just build-desktop" >&2
      exit 1
    fi

    if [[ "${FORMAT}" == "deb" ]] || { [[ "${FORMAT}" == "auto" ]] && command -v apt-get >/dev/null 2>&1 && { [[ "$(id -u)" -eq 0 ]] || command -v sudo >/dev/null 2>&1; }; }; then
      DEB_URL="$(extract_asset_url '\.deb$')"
      if [[ -n "${DEB_URL}" ]]; then
        install_linux_deb "${DEB_URL}"
        exit 0
      fi
    fi

    APPIMAGE_URL="$(extract_asset_url '\.AppImage$')"
    if [[ -z "${APPIMAGE_URL}" ]]; then
      echo "❌ Could not find a Linux .deb or .AppImage installer in release ${TAG_NAME}." >&2
      exit 1
    fi
    install_linux_appimage "${APPIMAGE_URL}"
    ;;

  Darwin)
    DMG_URL="$(extract_asset_url '\.dmg$')"
    if [[ -z "${DMG_URL}" ]]; then
      echo "❌ Could not find a macOS .dmg installer in release ${TAG_NAME}." >&2
      exit 1
    fi
    install_macos_dmg "${DMG_URL}"
    ;;

  *)
    echo "❌ Unsupported OS '${OS_NAME}' for install.sh." >&2
    echo "👉 On Windows (PowerShell), run:" >&2
    echo "   irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" >&2
    echo "👉 On Windows (CMD), run:" >&2
    echo "   powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex\"" >&2
    exit 1
    ;;
esac
