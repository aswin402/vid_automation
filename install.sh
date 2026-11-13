#!/usr/bin/env bash
# ==============================================================================
# CelestiaVid Studio — Minimal Terminal Installer & Auto-Updater (Linux & macOS)
#
# Usage (Install or Update):
#   curl -fsSL https://raw.githubusercontent.com/aswin402/vid_automation/main/install.sh | bash
#   bash install.sh --update
#
# Flags:
#   --update        Run in explicit update mode (backs up app data + upgrades binary)
#   --skip-backup   Skip automatic app data snapshot before install/update
#   --appimage      Force standalone AppImage install on Linux (~/.local/bin/celestiavid)
#   --deb           Force Debian/Ubuntu .deb install on Linux
#   --dmg           Force macOS .dmg install
#   --dry-run       Preview resolved release, backup plan & target package without writing
#
# Environment Variables (Optional):
#   CELESTIAVID_VERSION              Release tag to install (default: "latest")
#   CELESTIAVID_FORMAT               "auto" (default), "deb", "appimage", or "dmg"
#   CELESTIAVID_REPO                 GitHub repository (default: "aswin402/vid_automation")
#   CELESTIAVID_DATA_DIR             Custom app data directory override
#   CELESTIAVID_UPDATE_MANIFEST_URL  Custom release manifest URL override
# ==============================================================================
set -euo pipefail

REPO="${CELESTIAVID_REPO:-aswin402/vid_automation}"
VERSION="${CELESTIAVID_VERSION:-latest}"
FORMAT="${CELESTIAVID_FORMAT:-auto}"
DRY_RUN="${CELESTIAVID_DRY_RUN:-0}"
MODE="install"
SKIP_BACKUP="0"

for arg in "$@"; do
  case "$arg" in
    --update|-u)     MODE="update" ;;
    --skip-backup)   SKIP_BACKUP="1" ;;
    --appimage)      FORMAT="appimage" ;;
    --deb)           FORMAT="deb" ;;
    --dmg)           FORMAT="dmg" ;;
    --dry-run)       DRY_RUN="1" ;;
    --help|-h)
      printf "Usage: install.sh [--update] [--appimage|--deb|--dmg] [--skip-backup] [--dry-run]\n"
      exit 0
      ;;
  esac
done

# -------------------------- Minimal TUI Theme & TTY --------------------------
IS_TTY=0
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
  IS_TTY=1
fi

if [[ "${IS_TTY}" -eq 1 ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_ACCENT=$'\033[38;5;75m'    # Soft sky/indigo accent
  C_PURPLE=$'\033[38;5;141m'   # Studio violet
  C_GREEN=$'\033[38;5;78m'     # Clean emerald
  C_YELLOW=$'\033[38;5;221m'   # Warm amber
  C_RED=$'\033[38;5;203m'      # Soft coral red
  C_MUTED=$'\033[38;5;245m'    # Neutral slate
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_ACCENT=""
  C_PURPLE=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_MUTED=""
fi

SPINNER_FRAMES=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")

TMP_DIR="$(mktemp -d)"
chmod 755 "${TMP_DIR}"

restore_cursor() {
  if [[ "${IS_TTY}" -eq 1 ]]; then
    printf '\033[?25h' >&2 || true
  fi
}

cleanup() {
  restore_cursor
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

hide_cursor() {
  if [[ "${IS_TTY}" -eq 1 ]]; then
    printf '\033[?25l'
  fi
}

show_cursor() {
  if [[ "${IS_TTY}" -eq 1 ]]; then
    printf '\033[?25h'
  fi
}

ui_step_ok() {
  printf "  ${C_GREEN}✓${C_RESET} %s\n" "$1"
}

ui_step_info() {
  printf "  ${C_ACCENT}•${C_RESET} %s\n" "$1"
}

ui_step_warn() {
  printf "  ${C_YELLOW}!${C_RESET} %s\n" "$1"
}

ui_step_err() {
  printf "  ${C_RED}✗${C_RESET} %s\n" "$1" >&2
}

format_mb() {
  local bytes="${1:-0}"
  awk -v b="${bytes}" 'BEGIN { printf "%.1f MB", b / (1024 * 1024) }'
}

# Runs a command in the background with a clean single-line braille spinner
run_with_spinner() {
  local label="$1"
  shift
  local log_file="${TMP_DIR}/step.log"
  : > "${log_file}"

  if [[ "${IS_TTY}" -eq 0 ]]; then
    if "$@" >"${log_file}" 2>&1; then
      ui_step_ok "${label}"
      return 0
    else
      ui_step_err "${label}"
      cat "${log_file}" >&2 || true
      return 1
    fi
  fi

  hide_cursor
  "$@" >"${log_file}" 2>&1 &
  local pid=$!
  local idx=0

  while kill -0 "${pid}" 2>/dev/null; do
    local frame="${SPINNER_FRAMES[$idx]}"
    printf "\r\033[K  ${C_PURPLE}%s${C_RESET} %s" "${frame}" "${label}"
    idx=$(( (idx + 1) % 10 ))
    sleep 0.08
  done

  local rc=0
  wait "${pid}" || rc=$?
  printf "\r\033[K"
  show_cursor

  if [[ "${rc}" -ne 0 ]]; then
    ui_step_err "${label}"
    if [[ -s "${log_file}" ]]; then
      sed 's/^/    /' "${log_file}" >&2 || true
    fi
    return "${rc}"
  fi
  return 0
}

# Downloads a URL with a minimal live progress bar + braille spinner
download_with_progress() {
  local url="$1"
  local dest="$2"
  local label="$3"
  local expected_bytes="${4:-0}"
  local part_file="${dest}.part"
  local err_file="${TMP_DIR}/curl.err"
  rm -f "${part_file}" "${err_file}"

  if [[ "${expected_bytes}" -le 0 ]]; then
    local hdr_len
    hdr_len="$(curl -fsSLI -H "User-Agent: CelestiaVid-Installer" "${url}" 2>/dev/null \
      | grep -i '^content-length:' | tail -n 1 | awk '{print $2}' | tr -d '\r[:space:]' || true)"
    if [[ "${hdr_len}" =~ ^[0-9]+$ ]]; then
      expected_bytes="${hdr_len}"
    fi
  fi

  if [[ "${IS_TTY}" -eq 0 ]]; then
    curl -fsSL -H "User-Agent: CelestiaVid-Installer" "${url}" -o "${part_file}"
    mv "${part_file}" "${dest}"
    local final_sz
    final_sz="$(wc -c < "${dest}" | tr -d '[:space:]')"
    ui_step_ok "Downloaded ${label} ($(format_mb "${final_sz}"))"
    return 0
  fi

  hide_cursor
  curl -fsSL -H "User-Agent: CelestiaVid-Installer" "${url}" -o "${part_file}" 2>"${err_file}" &
  local pid=$!
  local idx=0
  local bar_width=22
  local pulse_pos=0

  while kill -0 "${pid}" 2>/dev/null; do
    local frame="${SPINNER_FRAMES[$idx]}"
    local cur_bytes=0
    if [[ -f "${part_file}" ]]; then
      cur_bytes="$(wc -c < "${part_file}" 2>/dev/null | tr -d '[:space:]' || echo 0)"
    fi

    if [[ "${expected_bytes}" -gt 0 ]]; then
      local pct=$(( cur_bytes * 100 / expected_bytes ))
      if [[ "${pct}" -gt 100 ]]; then pct=100; fi
      local filled=$(( pct * bar_width / 100 ))
      local empty=$(( bar_width - filled ))
      local bar_fill=""
      local bar_empty=""
      local i=0
      while [[ $i -lt $filled ]]; do bar_fill="${bar_fill}━"; i=$(( i + 1 )); done
      i=0
      while [[ $i -lt $empty ]]; do bar_empty="${bar_empty}─"; i=$(( i + 1 )); done
      local cur_mb total_mb
      cur_mb="$(format_mb "${cur_bytes}")"
      total_mb="$(format_mb "${expected_bytes}")"
      printf "\r\033[K  ${C_PURPLE}%s${C_RESET} %-28s ${C_ACCENT}%s${C_MUTED}%s${C_RESET} ${C_BOLD}%3d%%${C_RESET} ${C_MUTED}(%s / %s)${C_RESET}" \
        "${frame}" "${label}" "${bar_fill}" "${bar_empty}" "${pct}" "${cur_mb}" "${total_mb}"
    else
      # Indeterminate minimal pulse bar
      local bar=""
      local i=0
      while [[ $i -lt $bar_width ]]; do
        if [[ $i -ge $pulse_pos && $i -lt $(( pulse_pos + 5 )) ]]; then
          bar="${bar}${C_ACCENT}━${C_RESET}"
        else
          bar="${bar}${C_MUTED}─${C_RESET}"
        fi
        i=$(( i + 1 ))
      done
      pulse_pos=$(( (pulse_pos + 1) % (bar_width - 3) ))
      printf "\r\033[K  ${C_PURPLE}%s${C_RESET} %-28s %s ${C_MUTED}%s${C_RESET}" \
        "${frame}" "${label}" "${bar}" "$(format_mb "${cur_bytes}")"
    fi

    idx=$(( (idx + 1) % 10 ))
    sleep 0.08
  done

  local rc=0
  wait "${pid}" || rc=$?
  printf "\r\033[K"
  show_cursor

  if [[ "${rc}" -ne 0 ]]; then
    ui_step_err "Download failed for ${label}"
    if [[ -s "${err_file}" ]]; then
      sed 's/^/    /' "${err_file}" >&2 || true
    fi
    return "${rc}"
  fi

  mv "${part_file}" "${dest}"
  local done_bytes
  done_bytes="$(wc -c < "${dest}" | tr -d '[:space:]')"
  ui_step_ok "Downloaded ${C_BOLD}${label}${C_RESET} ${C_MUTED}($(format_mb "${done_bytes}"))${C_RESET}"
}

# ---------------------------- System Detection -------------------------------
OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

resolve_app_data_dir() {
  if [[ -n "${CELESTIAVID_DATA_DIR:-}" ]]; then
    printf '%s' "${CELESTIAVID_DATA_DIR}"
    return
  fi
  case "${OS_NAME}" in
    Darwin) printf '%s' "${HOME}/Library/Application Support/celestiavid" ;;
    *)      printf '%s' "${XDG_DATA_HOME:-${HOME}/.local/share}/celestiavid" ;;
  esac
}

APP_DATA_DIR="$(resolve_app_data_dir)"
BACKUP_SUMMARY="None required (fresh install)"

HEADER_ACTION="Installer"
if [[ "${MODE}" == "update" ]]; then
  HEADER_ACTION="Updater"
fi

printf "\n"
printf "  ${C_MUTED}╭────────────────────────────────────────────────────────╮${C_RESET}\n"
printf "  ${C_MUTED}│${C_RESET}  ${C_PURPLE}◆${C_RESET} ${C_BOLD}CelestiaVid Studio${C_RESET}                     ${C_ACCENT}%10s${C_RESET}   ${C_MUTED}│${C_RESET}\n" "${HEADER_ACTION}"
printf "  ${C_MUTED}│${C_RESET}    ${C_MUTED}AI Branded Video Automation · %-21s${C_RESET} ${C_MUTED}│${C_RESET}\n" "${OS_NAME} (${ARCH_NAME})"
printf "  ${C_MUTED}╰────────────────────────────────────────────────────────╯${C_RESET}\n\n"

# ------------------------ Step 1: Fetch Release Info -------------------------
if [[ -n "${CELESTIAVID_UPDATE_MANIFEST_URL:-}" ]]; then
  API_URL="${CELESTIAVID_UPDATE_MANIFEST_URL}"
elif [[ "${VERSION}" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
fi

RELEASE_FILE="${TMP_DIR}/release.json"
fetch_release_metadata() {
  curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: CelestiaVid-Installer" \
    "${API_URL}" -o "${RELEASE_FILE}"
}

run_with_spinner "Checking release feed (${VERSION})..." fetch_release_metadata
RELEASE_JSON="$(cat "${RELEASE_FILE}")"

TAG_NAME="$(printf '%s\n' "${RELEASE_JSON}" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')"
if [[ -z "${TAG_NAME}" ]]; then
  ui_step_err "Could not resolve release tag from ${API_URL}"
  exit 1
fi
ui_step_ok "Resolved target release ${C_BOLD}${TAG_NAME}${C_RESET}"

extract_asset_url() {
  local pattern="$1"
  printf '%s\n' "${RELEASE_JSON}" \
    | grep -oE '"browser_download_url":[[:space:]]*"[^"]+"' \
    | sed -E 's/"browser_download_url":[[:space:]]*"([^"]+)"/\1/' \
    | grep -E "${pattern}" \
    | head -n 1 || true
}

# ------------------- Step 2: Automatic App Data Backup -----------------------
backup_existing_app_data() {
  if [[ "${SKIP_BACKUP}" == "1" ]]; then
    BACKUP_SUMMARY="Skipped (--skip-backup)"
    ui_step_info "Skipped app data backup (--skip-backup)"
    return 0
  fi

  local db_file="${APP_DATA_DIR}/celestiavid.db"
  if [[ ! -f "${db_file}" ]]; then
    BACKUP_SUMMARY="Fresh setup (no prior DB)"
    return 0
  fi

  local ts
  ts="$(date -u +%Y%m%d-%H%M%S)"
  local clean_ver="${TAG_NAME#v}"
  local backup_id="backup-cli-${clean_ver}-${ts}"
  local backup_dir="${APP_DATA_DIR}/backups/${backup_id}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    BACKUP_SUMMARY="[Dry Run] ${backup_id}"
    ui_step_info "[Dry Run] Would back up existing app data → ${backup_dir}"
    return 0
  fi

  perform_snapshot() {
    mkdir -p "${backup_dir}"
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "${db_file}" "VACUUM INTO '${backup_dir}/celestiavid.db';" 2>/dev/null \
        || cp -p "${db_file}" "${backup_dir}/celestiavid.db"
    else
      cp -p "${db_file}" "${backup_dir}/celestiavid.db"
      [[ -f "${db_file}-wal" ]] && cp -p "${db_file}-wal" "${backup_dir}/celestiavid.db-wal" || true
      [[ -f "${db_file}-shm" ]] && cp -p "${db_file}-shm" "${backup_dir}/celestiavid.db-shm" || true
    fi

    local has_storage="false"
    if [[ -d "${APP_DATA_DIR}/storage" ]]; then
      mkdir -p "${backup_dir}/storage"
      cp -Rp "${APP_DATA_DIR}/storage/." "${backup_dir}/storage/" 2>/dev/null || true
      has_storage="true"
    fi

    local created_iso
    created_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat > "${backup_dir}/backup_manifest.json" <<EOF
{
  "id": "${backup_id}",
  "label": "CLI Pre-Install Backup (→ ${TAG_NAME})",
  "reason": "pre-update",
  "app_version": "${clean_ver}",
  "created_at": "${created_iso}",
  "path": "${backup_dir}",
  "size_bytes": 0,
  "project_count": 0,
  "batch_count": 0,
  "asset_count": 0,
  "includes_storage": ${has_storage}
}
EOF
  }

  run_with_spinner "Backing up existing CelestiaVid projects & database..." perform_snapshot
  BACKUP_SUMMARY="${backup_id}"
  ui_step_ok "Backed up app data ${C_MUTED}(${backup_id})${C_RESET}"
}

backup_existing_app_data

# ------------------------ Step 3: Download & Install -------------------------
render_summary_card() {
  local binary_label="$1"
  local launch_cmd="$2"
  printf "\n"
  printf "  ${C_MUTED}╭────────────────────────────────────────────────────────╮${C_RESET}\n"
  printf "  ${C_MUTED}│${C_RESET}  ${C_GREEN}✓${C_RESET} ${C_BOLD}CelestiaVid %-10s is ready${C_RESET}                     ${C_MUTED}│${C_RESET}\n" "${TAG_NAME}"
  printf "  ${C_MUTED}│${C_RESET}                                                        ${C_MUTED}│${C_RESET}\n"
  printf "  ${C_MUTED}│${C_RESET}  ${C_MUTED}Location${C_RESET}  %-43s ${C_MUTED}│${C_RESET}\n" "${binary_label:0:43}"
  printf "  ${C_MUTED}│${C_RESET}  ${C_MUTED}Backup${C_RESET}    %-43s ${C_MUTED}│${C_RESET}\n" "${BACKUP_SUMMARY:0:43}"
  printf "  ${C_MUTED}│${C_RESET}  ${C_MUTED}Launch${C_RESET}    ${C_ACCENT}%-43s${C_RESET} ${C_MUTED}│${C_RESET}\n" "${launch_cmd:0:43}"
  printf "  ${C_MUTED}╰────────────────────────────────────────────────────────╯${C_RESET}\n\n"
}

install_linux_deb() {
  local deb_url="$1"
  local deb_file="${TMP_DIR}/celestiavid.deb"
  if [[ "${DRY_RUN}" == "1" ]]; then
    ui_step_info "[Dry Run] Would download & install .deb: ${deb_url}"
    render_summary_card "/usr/bin/celestiavid-desktop (dry-run)" "celestiavid"
    return 0
  fi

  download_with_progress "${deb_url}" "${deb_file}" "CelestiaVid (.deb)" 0
  chmod 644 "${deb_file}"

  do_apt_install() {
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
  }

  if [[ "$(id -u)" -ne 0 ]]; then
    # Prompt sudo credentials cleanly before starting spinner if needed
    sudo -v
  fi
  run_with_spinner "Installing package & desktop integration..." do_apt_install
  ui_step_ok "Installed system package & launcher"
  render_summary_card "/usr/bin/celestiavid-desktop" "celestiavid"
}

install_linux_appimage() {
  local appimage_url="$1"
  local bin_dir="${HOME}/.local/bin"
  local apps_dir="${HOME}/.local/share/applications"
  local target_bin="${bin_dir}/celestiavid"
  if [[ "${DRY_RUN}" == "1" ]]; then
    ui_step_info "[Dry Run] Would download & install AppImage: ${appimage_url} -> ${target_bin}"
    render_summary_card "~/.local/bin/celestiavid (dry-run)" "celestiavid"
    return 0
  fi

  mkdir -p "${bin_dir}" "${apps_dir}"
  local staged_bin="${target_bin}.new"
  download_with_progress "${appimage_url}" "${staged_bin}" "CelestiaVid (AppImage)" 0

  finalize_appimage() {
    chmod +x "${staged_bin}"
    mv -f "${staged_bin}" "${target_bin}"
    cat > "${apps_dir}/celestiavid.desktop" <<EOF
[Desktop Entry]
Name=CelestiaVid
Comment=AI Branded Video Automation Studio
Exec=${target_bin}
Terminal=false
Type=Application
Categories=AudioVideo;Video;AudioVideoEditing;
EOF
  }

  run_with_spinner "Configuring executable & desktop launcher..." finalize_appimage
  ui_step_ok "Configured desktop entry (~/.local/bin/celestiavid)"

  if [[ ":${PATH}:" != *":${bin_dir}:"* ]]; then
    ui_step_warn "Add ~/.local/bin to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
  render_summary_card "~/.local/bin/celestiavid" "celestiavid"
}

install_macos_dmg() {
  local dmg_url="$1"
  local dmg_file="${TMP_DIR}/CelestiaVid.dmg"
  if [[ "${DRY_RUN}" == "1" ]]; then
    ui_step_info "[Dry Run] Would download & mount macOS DMG: ${dmg_url}"
    render_summary_card "/Applications/CelestiaVid.app (dry-run)" "open -a CelestiaVid"
    return 0
  fi

  download_with_progress "${dmg_url}" "${dmg_file}" "CelestiaVid (.dmg)" 0

  local dest_dir="/Applications"
  if [[ ! -w "/Applications" ]]; then
    dest_dir="${HOME}/Applications"
    mkdir -p "${dest_dir}"
  fi

  deploy_macos_app() {
    local mount_output
    mount_output="$(hdiutil attach "${dmg_file}" -nobrowse -readonly)"
    local mount_point
    mount_point="$(printf '%s\n' "${mount_output}" | grep -o '/Volumes/.*' | head -n 1)"
    if [[ -z "${mount_point}" ]] || [[ ! -d "${mount_point}/CelestiaVid.app" ]]; then
      echo "Could not locate CelestiaVid.app inside mounted DMG." >&2
      return 1
    fi
    rm -rf "${dest_dir}/CelestiaVid.app"
    cp -R "${mount_point}/CelestiaVid.app" "${dest_dir}/CelestiaVid.app"
    hdiutil detach "${mount_point}" -quiet || true
    xattr -cr "${dest_dir}/CelestiaVid.app" 2>/dev/null || true
  }

  run_with_spinner "Installing CelestiaVid.app into ${dest_dir}..." deploy_macos_app
  ui_step_ok "Installed bundle to ${dest_dir}/CelestiaVid.app"
  render_summary_card "${dest_dir}/CelestiaVid.app" "open -a CelestiaVid"
}

case "${OS_NAME}" in
  Linux)
    if [[ "${ARCH_NAME}" != "x86_64" && "${ARCH_NAME}" != "amd64" ]]; then
      ui_step_err "Prebuilt Linux packages target x86_64/amd64 (detected: ${ARCH_NAME})."
      ui_step_info "Build from source: git clone https://github.com/${REPO}.git && cd vid_automation && just build-desktop"
      exit 1
    fi

    if [[ "${FORMAT}" == "deb" ]] || { [[ "${FORMAT}" == "auto" ]] && [[ "${MODE}" != "update" || -x "/usr/bin/celestiavid-desktop" ]] && command -v apt-get >/dev/null 2>&1 && { [[ "$(id -u)" -eq 0 ]] || command -v sudo >/dev/null 2>&1; }; }; then
      DEB_URL="$(extract_asset_url '\.deb$')"
      if [[ -n "${DEB_URL}" ]]; then
        install_linux_deb "${DEB_URL}"
        exit 0
      fi
    fi

    APPIMAGE_URL="$(extract_asset_url '\.AppImage$')"
    if [[ -z "${APPIMAGE_URL}" ]]; then
      ui_step_err "No Linux .deb or .AppImage asset found in release ${TAG_NAME}."
      exit 1
    fi
    install_linux_appimage "${APPIMAGE_URL}"
    ;;

  Darwin)
    DMG_URL="$(extract_asset_url '\.dmg$')"
    if [[ -z "${DMG_URL}" ]]; then
      ui_step_err "No macOS .dmg asset found in release ${TAG_NAME}."
      exit 1
    fi
    install_macos_dmg "${DMG_URL}"
    ;;

  *)
    ui_step_err "Unsupported OS '${OS_NAME}' for install.sh."
    ui_step_info "On Windows (PowerShell): irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex"
    exit 1
    ;;
esac
