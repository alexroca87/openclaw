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
#   npm:     gog (Google), summarize (URLs/YouTube)
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

# --- Install npm CLI tools (as root, to system path) ---
command -v gog       >/dev/null 2>&1 || npm install -g gog       >/dev/null 2>&1 || true
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
