#!/usr/bin/env bash
# ---------------------------------------------------------------
# add-agent.sh — Add a new OpenClaw agent to Hetzner VPS
#
# Usage: ./add-agent.sh <agent-name> <domain> <openrouter-api-key> [openai-api-key] [anthropic-api-key]
# Example: ./add-agent.sh agentalfa agentik.mx sk-or-v1-abc123... sk-proj-xyz... sk-ant-api03-...
#
# What it does:
#   1. Generates a gateway token
#   2. Creates data directories with correct permissions
#   3. Writes openclaw.json (allowedOrigins, auth token)
#   4. Writes auth-profiles.json (AuthProfileStore format)
#   5. Sets default model to anthropic/claude-haiku-4-5
#   6. Copies entrypoint.sh (auto-installs CLI tools on start)
#   7. Adds service to docker-compose.yml (with workspace mount)
#   8. Adds Caddy reverse proxy entry
#   9. Starts the container + reloads Caddy
# ---------------------------------------------------------------

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <agent-name> <domain> <openrouter-api-key> [openai-api-key] [anthropic-api-key]"
  echo "Example: $0 agentalfa agentik.mx sk-or-v1-abc123... sk-proj-xyz... sk-ant-api03-..."
  echo ""
  echo "  openrouter-api-key  — Required. Used for chat models via OpenRouter."
  echo "  openai-api-key      — Optional. Used for Whisper transcription + embeddings."
  echo "  anthropic-api-key   — Optional. Used for direct Anthropic model access."
  exit 1
fi

AGENT_NAME="$1"
DOMAIN="$2"
OPENROUTER_KEY="$3"
OPENAI_KEY="${4:-}"
ANTHROPIC_KEY="${5:-}"
AGENTS_DIR="/opt/agents"
COMPOSE_FILE="$AGENTS_DIR/docker-compose.yml"
CADDYFILE="/etc/caddy/Caddyfile"

FULL_DOMAIN="${AGENT_NAME}.${DOMAIN}"
CONTAINER_NAME="agent-${AGENT_NAME}"
DATA_DIR="$AGENTS_DIR/data/${AGENT_NAME}"
OPENCLAW_DIR="$DATA_DIR/.openclaw"
AGENT_DIR="$OPENCLAW_DIR/agents/main/agent"
WORKSPACE_DIR="$DATA_DIR/workspace"

# --- Find next available port ---
if [[ -f "$COMPOSE_FILE" ]]; then
  LAST_PORT=$(grep -oP '"(\d+):18789"' "$COMPOSE_FILE" | grep -oP '\d+(?=:)' | sort -n | tail -1)
  NEXT_PORT=$((LAST_PORT + 1))
else
  NEXT_PORT=3001
fi

# --- Check if agent already exists ---
if [[ -d "$DATA_DIR" ]]; then
  echo "ERROR: Agent '$AGENT_NAME' already exists at $DATA_DIR"
  exit 1
fi

# --- Generate gateway token ---
GATEWAY_TOKEN=$(openssl rand -hex 24)

echo "============================================"
echo "  Adding agent: $AGENT_NAME"
echo "  Domain: $FULL_DOMAIN"
echo "  Container: $CONTAINER_NAME"
echo "  Port: $NEXT_PORT -> 18789"
echo "  Gateway Token: $GATEWAY_TOKEN"
echo "============================================"

# --- Create data directories ---
mkdir -p "$AGENT_DIR"
mkdir -p "$WORKSPACE_DIR/memory"

# --- Determine default model ---
if [[ -n "$ANTHROPIC_KEY" ]]; then
  DEFAULT_MODEL="anthropic/claude-haiku-4-5"
else
  DEFAULT_MODEL="openrouter/auto"
fi

# --- Write openclaw.json ---
cat > "$OPENCLAW_DIR/openclaw.json" << OCEOF
{
  "agents": {
    "defaults": {
      "model": "${DEFAULT_MODEL}",
      "compaction": {
        "mode": "safeguard"
      }
    }
  },
  "commands": {
    "native": "auto",
    "nativeSkills": "auto",
    "restart": true,
    "ownerDisplay": "raw"
  },
  "gateway": {
    "controlUi": {
      "allowedOrigins": [
        "https://${FULL_DOMAIN}"
      ]
    },
    "auth": {
      "mode": "token",
      "token": "${GATEWAY_TOKEN}"
    }
  }
}
OCEOF

# --- Write auth-profiles.json (AuthProfileStore format) ---
# Build profiles object based on which keys are provided
PROFILES=""

# OpenRouter profile (always present)
PROFILES="\"openrouter-default\": {
      \"type\": \"api_key\",
      \"provider\": \"openrouter\",
      \"key\": \"${OPENROUTER_KEY}\"
    }"

# Anthropic profile (optional)
if [[ -n "$ANTHROPIC_KEY" ]]; then
  PROFILES="${PROFILES},
    \"anthropic-default\": {
      \"type\": \"api_key\",
      \"provider\": \"anthropic\",
      \"key\": \"${ANTHROPIC_KEY}\"
    }"
fi

cat > "$AGENT_DIR/auth-profiles.json" << APEOF
{
  "version": 1,
  "profiles": {
    ${PROFILES}
  }
}
APEOF

# --- Write models.json ---
cat > "$AGENT_DIR/models.json" << MDEOF
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "auto",
          "name": "OpenRouter Auto",
          "reasoning": false,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ],
      "apiKey": "OPENROUTER_API_KEY"
    }
  }
}
MDEOF

# --- Ensure entrypoint script exists ---
if [[ ! -f "$AGENTS_DIR/entrypoint.sh" ]]; then
  echo "ERROR: entrypoint.sh not found at $AGENTS_DIR/entrypoint.sh"
  echo "Copy it from the openclaw repo: cp /opt/openclaw/scripts/entrypoint.sh $AGENTS_DIR/"
  exit 1
fi

# --- Set permissions (OpenClaw runs as uid 1000 / node) ---
chmod -R 777 "$DATA_DIR"
chmod +x "$AGENTS_DIR/entrypoint.sh"

# --- Build environment variables block ---
ENV_BLOCK="      - OPENCLAW_STATE_DIR=/data/.openclaw
      - OPENCLAW_WORKSPACE_DIR=/data/workspace
      - OPENROUTER_API_KEY=${OPENROUTER_KEY}"

if [[ -n "$OPENAI_KEY" ]]; then
  ENV_BLOCK="${ENV_BLOCK}
      - OPENAI_API_KEY=${OPENAI_KEY}"
fi

# --- Add to docker-compose.yml ---
if [[ ! -f "$COMPOSE_FILE" ]]; then
  cat > "$COMPOSE_FILE" << 'DCEOF'
services:

networks:
DCEOF
fi

# Insert service before the "networks:" line
NETWORK_NAME="isolated-${AGENT_NAME}"
SERVICE_BLOCK="  ${CONTAINER_NAME}:
    build:
      context: /opt/openclaw
    container_name: ${CONTAINER_NAME}
    restart: unless-stopped
    user: root
    entrypoint: [\"/opt/entrypoint.sh\"]
    command: [\"node\", \"openclaw.mjs\", \"gateway\", \"--allow-unconfigured\", \"--bind\", \"lan\"]
    ports:
      - \"${NEXT_PORT}:18789\"
    volumes:
      - ./data/${AGENT_NAME}:/data
      - ./data/${AGENT_NAME}/workspace:/home/node/.openclaw/workspace
      - ./entrypoint.sh:/opt/entrypoint.sh:ro
    environment:
${ENV_BLOCK}
    networks:
      - ${NETWORK_NAME}"

# Add service block before "networks:" line
sed -i "/^networks:/i\\
${SERVICE_BLOCK}\n" "$COMPOSE_FILE"

# Add network under networks:
echo "  ${NETWORK_NAME}:" >> "$COMPOSE_FILE"

# --- Add Caddy entry ---
cat >> "$CADDYFILE" << CEOF

${FULL_DOMAIN} {
    reverse_proxy localhost:${NEXT_PORT}
}
CEOF

# --- Start container + reload Caddy ---
cd "$AGENTS_DIR"
docker compose up -d --build "$CONTAINER_NAME"
systemctl reload caddy

echo ""
echo "============================================"
echo "  Agent '$AGENT_NAME' is live!"
echo "============================================"
echo ""
echo "  URL: https://${FULL_DOMAIN}"
echo "  Gateway Token: ${GATEWAY_TOKEN}"
echo "  Model: ${DEFAULT_MODEL}"
echo ""
echo "  Skills auto-installed (9): gog, summarize, ddg-search, pdf-text-extractor,"
echo "    openai-whisper-api, openai-image-gen, weather, healthcheck, skill-creator"
echo "  Workspace: persistent (survives container recreations)"
echo ""
echo "  Next steps:"
echo "  1. Add DNS A record: ${AGENT_NAME} -> $(curl -s ifconfig.me)"
echo "  2. Open https://${FULL_DOMAIN}"
echo "  3. Enter the Gateway Token and click Connect"
echo "  4. Approve the device:"
echo "     docker exec ${CONTAINER_NAME} node /app/openclaw.mjs devices list"
echo "     docker exec ${CONTAINER_NAME} node /app/openclaw.mjs devices approve <requestId>"
echo "  5. Set up Telegram (optional):"
echo "     docker exec ${CONTAINER_NAME} node /app/openclaw.mjs config set channels.telegram.accounts.default.botToken 'BOT_TOKEN'"
echo "     docker compose restart ${CONTAINER_NAME}"
echo ""
