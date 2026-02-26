#!/bin/sh
# ---------------------------------------------------------------
# entrypoint.sh — Auto-install CLI tools + skills, then run as node user
#
# Runs as root inside the container. Installs all baseline skill
# dependencies on every start, then drops privileges to the node user.
#
# Also sets up a persistent npm prefix so the agent can self-install
# packages (npm install -g) without root, and they survive restarts.
#
# /app/skills/ is mounted to a persistent volume, so ClawHub skills
# installed by the agent (or this script) survive container recreations.
#
# What gets auto-installed:
#   gogcli:  Google Workspace CLI (Gmail, Calendar, Drive, etc.)
#            Binary from github.com/steipete/gogcli (NOT the npm "gog" package)
#   npm:     summarize (URLs/YouTube)
#   ClawHub: ddg-web-search (DuckDuckGo), pdf-text-extractor (PDF OCR)
#   Built-in (no install needed): weather, healthcheck, skill-creator,
#            openai-whisper-api, openai-image-gen (need OPENAI_API_KEY)
# ---------------------------------------------------------------

# --- Persistent npm global prefix (on the /data volume) ---
PERSISTENT_NPM="/data/npm-global"
mkdir -p "$PERSISTENT_NPM/bin" "$PERSISTENT_NPM/lib"
chown -R node:node "$PERSISTENT_NPM"

# --- Ensure /app/skills/ is owned by node (mounted volume may be root) ---
chown -R node:node /app/skills 2>/dev/null || true

# --- Restore gogcli binary + config from persistent volume (survives rebuilds) ---
if [ -f "/data/gog-bin" ]; then
  cp /data/gog-bin /usr/local/bin/gog
  chmod +x /usr/local/bin/gog
fi
# Restore config for root (used by docker exec)
if [ -d "/data/.gogcli-config" ]; then
  mkdir -p /root/.config/gogcli
  cp -r /data/.gogcli-config/* /root/.config/gogcli/
fi
# Restore config for node user (used by the agent process)
if [ -d "/data/.gogcli-config-node" ]; then
  mkdir -p /home/node/.config/gogcli
  cp -r /data/.gogcli-config-node/* /home/node/.config/gogcli/
  chown -R node:node /home/node/.config/gogcli
fi

# --- Install gogcli (Google Workspace CLI) ---
# IMPORTANT: Do NOT use "npm install -g gog" — that installs a wrong package
# (a bash script runner, v0.0.12). The real Google CLI is "gogcli" from
# github.com/steipete/gogcli, a Go binary.
#
# The binary is restored from /data/gog-bin above (persistent volume).
# If not present there either, download it from GitHub releases.
GOG_VERSION="v0.11.0"
if ! command -v gog >/dev/null 2>&1; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  GOG_ARCH="linux_amd64" ;;
    aarch64) GOG_ARCH="linux_arm64" ;;
    *)       GOG_ARCH="" ;;
  esac
  if [ -n "$GOG_ARCH" ]; then
    GOG_URL="https://github.com/steipete/gogcli/releases/download/${GOG_VERSION}/gog_${GOG_ARCH}"
    curl -fsSL "$GOG_URL" -o /usr/local/bin/gog >/dev/null 2>&1 && chmod +x /usr/local/bin/gog || true
    # Save to persistent volume so we don't re-download next time
    if [ -f /usr/local/bin/gog ]; then
      cp /usr/local/bin/gog /data/gog-bin 2>/dev/null || true
    fi
  fi
fi

# --- Install npm CLI tools (as root, to system path) ---
command -v summarize >/dev/null 2>&1 || npm install -g summarize >/dev/null 2>&1 || true

# --- Install ClawHub skills (to /app/skills/, persistent on volume) ---
install_clawhub_skill() {
  SKILL="$1"
  FLAGS="${2:-}"
  if [ ! -d "/app/skills/$SKILL" ] || [ ! -f "/app/skills/$SKILL/SKILL.md" ]; then
    runuser -u node -- npx clawhub install $SKILL $FLAGS >/dev/null 2>&1 || true
  fi
}

install_clawhub_skill "ddg-web-search"
install_clawhub_skill "pdf-text-extractor" "--force"

# --- Set npm prefix for node user (agent self-install, persistent) ---
export NPM_CONFIG_PREFIX="$PERSISTENT_NPM"
export PATH="$PERSISTENT_NPM/bin:$PATH"

# Run the actual command as node user (uid 1000)
exec runuser -u node -- "$@"
