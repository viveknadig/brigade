#!/bin/sh
# Brigade installer for macOS / Linux.
#
# Installs Node.js (latest LTS) if it's missing or older than 22.12, then installs
# @spinabot/brigade globally via npm. Safe to re-run.
#
#   curl -fsSL https://brigade.spinabot.com/install.sh | sh
#
# (Or directly from GitHub:)
#   curl -fsSL https://raw.githubusercontent.com/spinabot/brigade/main/packaging/install/install.sh | sh
set -eu

BRIGADE_PKG="@spinabot/brigade"
MIN_MAJOR=22
MIN_MINOR=12
RUNTIME_DIR="${HOME}/.brigade/runtime"
FALLBACK_NODE="v22.18.0"

info() { printf '\033[1;33m>>\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; }

need() { command -v "$1" >/dev/null 2>&1; }

node_ok() {
  need node || return 1
  v=$(node -v 2>/dev/null | sed 's/^v//')
  [ -n "$v" ] || return 1
  maj=${v%%.*}
  rest=${v#*.}
  min=${rest%%.*}
  if [ "$maj" -gt "$MIN_MAJOR" ]; then return 0; fi
  if [ "$maj" -eq "$MIN_MAJOR" ] && [ "$min" -ge "$MIN_MINOR" ]; then return 0; fi
  return 1
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) err "Unsupported OS: $os. Install Node ${MIN_MAJOR}.${MIN_MINOR}+ manually, then: npm i -g ${BRIGADE_PKG}"; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) err "Unsupported architecture: $arch. Install Node manually, then: npm i -g ${BRIGADE_PKG}"; exit 1 ;;
  esac
}

latest_lts() {
  # Newest LTS version (vXX.YY.ZZ) from the official dist index. Empty on failure.
  curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null \
    | tr '}' '\n' | grep '"lts":"' | grep -o '"version":"v[^"]*"' \
    | head -1 | cut -d'"' -f4 || true
}

install_node() {
  need curl || { err "curl is required to install Node. Install curl, or install Node ${MIN_MAJOR}.${MIN_MINOR}+ yourself."; exit 1; }
  detect_platform
  NV=$(latest_lts)
  [ -n "${NV:-}" ] || NV="$FALLBACK_NODE"
  TARBALL="node-${NV}-${OS}-${ARCH}.tar.gz"
  URL="https://nodejs.org/dist/${NV}/${TARBALL}"
  info "Installing Node ${NV} (${OS}-${ARCH}) into ${RUNTIME_DIR} ..."
  mkdir -p "$RUNTIME_DIR"
  TMP=$(mktemp -d)
  curl -fsSL "$URL" -o "${TMP}/${TARBALL}" || { err "Download failed: $URL"; rm -rf "$TMP"; exit 1; }
  tar -xzf "${TMP}/${TARBALL}" -C "$RUNTIME_DIR" --strip-components=1
  rm -rf "$TMP"
  PATH="${RUNTIME_DIR}/bin:${PATH}"
  export PATH
  persist_path
  NODE_FRESHLY_INSTALLED=1
}

persist_path() {
  line="export PATH=\"${RUNTIME_DIR}/bin:\$PATH\""

  # Pick the rc file for the user's login shell and CREATE it if it's missing.
  # A fresh macOS account commonly has NO ~/.zshrc yet — only updating files
  # that already exist would silently persist nothing, leaving `brigade` absent
  # from every new terminal (so the user re-runs the installer forever).
  case "${SHELL:-}" in
    *zsh)  primary="$HOME/.zshrc" ;;
    *bash) primary="$HOME/.bashrc" ;;
    *)     primary="$HOME/.profile" ;;
  esac

  # Always write the primary (creating it via >>); also update any other shell
  # rc that already exists, so PATH is live whichever terminal opens next.
  for rc in "$primary" "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ "$rc" = "$primary" ] || [ -e "$rc" ] || continue
    grep -qF "${RUNTIME_DIR}/bin" "$rc" 2>/dev/null && continue
    printf '\n# Brigade Node runtime\n%s\n' "$line" >> "$rc"
  done
}

main() {
  NODE_FRESHLY_INSTALLED=0
  info "Brigade installer"
  if node_ok; then
    info "Node $(node -v) detected - good."
  else
    if need node; then
      info "Node $(node -v) is too old (need ${MIN_MAJOR}.${MIN_MINOR}+)."
    else
      info "Node not found."
    fi
    install_node
  fi
  need npm || { err "npm is not available even after installing Node. Please report this."; exit 1; }
  info "Installing ${BRIGADE_PKG} ..."
  npm i -g "$BRIGADE_PKG"
  printf '\n\033[1;32mOK: Brigade installed.\033[0m  Run:  \033[1mbrigade onboard\033[0m\n'
  if [ "$NODE_FRESHLY_INSTALLED" -eq 1 ]; then
    printf '   Node was just installed. Open a new terminal (or run: exec $SHELL) so it is on your PATH.\n'
  fi
}

main
