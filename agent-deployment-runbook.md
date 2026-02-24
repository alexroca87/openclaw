# Agent Deployment Runbook — Full Setup from Zero to Live

Complete step-by-step record of deploying an OpenClaw agent on Hetzner VPS with Caddy HTTPS, Telegram, and all skills. Use this as the definitive guide for future agents.

---

## Infrastructure Setup (One-Time per Server)

### 1. Hetzner VPS Creation

- **Provider:** Hetzner Cloud (hetzner.com)
- **Server:** CPX22 (2 vCPU AMD, 4GB RAM, 40GB NVMe) — ~$7/mo
- **Location:** Helsinki (cheapest) — latency is fine for agents
- **Image:** Ubuntu 24.04
- **Auth:** SSH key only (paste `~/.ssh/id_ed25519.pub`)
- **Server IP:** `89.167.94.10`
- **Server name:** `Agentik-product`

### 2. SSH In and Install Docker

```bash
ssh root@89.167.94.10
curl -fsSL https://get.docker.com | sh
```

### 3. Install Caddy (Reverse Proxy + Auto-HTTPS)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Caddy is free, auto-provisions Let's Encrypt SSL certificates, and auto-renews them. Zero maintenance.

### 4. Clone OpenClaw (Your Fork)

```bash
apt update && apt install -y git
git clone https://github.com/alexroca87/openclaw.git /opt/openclaw
```

Using our fork which includes the `model-router` extension.

### 5. Firewall Setup

```bash
# Disable password SSH login
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Enable firewall — only SSH + HTTPS exposed
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (Caddy auto-redirects to HTTPS)
ufw allow 443/tcp    # HTTPS (Caddy)
ufw enable
```

Important: Agent ports (3001, 3002, etc.) are NOT exposed publicly. Caddy proxies HTTPS to them internally.

### 6. Create Agents Directory

```bash
mkdir -p /opt/agents
```

### 7. Copy Add-Agent Script

From your Mac:

```bash
scp /Users/alexrojas/Luka/openclaw/scripts/add-agent.sh root@89.167.94.10:/opt/agents/
ssh root@89.167.94.10 "chmod +x /opt/agents/add-agent.sh"
```

### 8. CLI Alias (Convenience)

Added to `/root/.bashrc` on the server:

```bash
alias oc="docker exec -it agent-client-1 node /app/openclaw.mjs"
```

Usage: `oc devices list`, `oc config set ...`, `oc channels status`, etc.

---

## Per-Agent Setup

### Step 1: DNS Record

In Namecheap → `agentik.mx` → Advanced DNS → Add A Record:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A Record | `agentalfa` | `89.167.94.10` | Automatic |

This creates `agentalfa.agentik.mx`.

### Step 2: Docker Compose

Create `/opt/agents/docker-compose.yml`:

```yaml
services:
  agent-client-1:
    build:
      context: /opt/openclaw
    container_name: agent-client-1
    restart: unless-stopped
    user: root
    entrypoint: ["/opt/entrypoint.sh"]
    command: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"]
    ports:
      - "3001:18789"
    volumes:
      - ./data/client-1:/data
      - ./data/client-1/workspace:/home/node/.openclaw/workspace
      - ./entrypoint.sh:/opt/entrypoint.sh:ro
    environment:
      - OPENCLAW_STATE_DIR=/data/.openclaw
      - OPENCLAW_WORKSPACE_DIR=/data/workspace
      - OPENROUTER_API_KEY=sk-or-v1-your-key-here
      - OPENAI_API_KEY=sk-proj-your-key-here
    networks:
      - isolated-1

networks:
  isolated-1:
```

Key details:
- **Port 18789** is OpenClaw's gateway port (NOT 3000)
- **`--bind lan`** is required for non-loopback access
- **`--allow-unconfigured`** lets the gateway start without full onboarding
- **`user: root` + `entrypoint`** — runs `entrypoint.sh` as root to auto-install CLI tools (gog, summarize), then drops to `node` user via `runuser`
- **Workspace volume mount** — `./data/client-1/workspace:/home/node/.openclaw/workspace` ensures workspace files (IDENTITY.md, SOUL.md, memory, etc.) persist across container recreations
- **OPENROUTER_API_KEY** — used for all chat/reasoning models
- **OPENAI_API_KEY** — used ONLY for Whisper transcription and embeddings (memory search)

### Step 3: Build and Start

```bash
cd /opt/agents
docker compose up -d --build
```

First build: ~5-10 minutes (downloads Node 22, Bun, builds everything).
Subsequent starts: seconds.

### Step 4: Fix Data Directory Permissions

OpenClaw runs as `node` user (uid 1000) but Docker creates host volumes as root:

```bash
chmod -R 777 /opt/agents/data/client-1
```

### Step 5: Caddy HTTPS Configuration

Edit `/etc/caddy/Caddyfile`:

```
agentalfa.agentik.mx {
    reverse_proxy localhost:3001
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Caddy automatically obtains an SSL certificate from Let's Encrypt (~5 seconds). You can verify in logs:

```bash
journalctl -u caddy --since '5 min ago' --no-pager | tail -20
```

Look for: `certificate obtained successfully`

### Step 6: OpenClaw Configuration

The config lives at `/opt/agents/data/client-1/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": "openrouter/auto",
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
        "https://agentalfa.agentik.mx"
      ]
    },
    "auth": {
      "mode": "token",
      "token": "YOUR_GENERATED_GATEWAY_TOKEN"
    }
  }
}
```

Key settings:
- **`agents.defaults.model: "openrouter/auto"`** — routes chat through OpenRouter (NOT direct Anthropic)
- **`allowedOrigins`** — must include the HTTPS domain for Control UI access
- **`auth.mode: "token"`** — token-based auth for the gateway
- **`compaction.mode: "safeguard"`** — auto-compacts long conversations

Set model via CLI:

```bash
docker exec agent-client-1 node /app/openclaw.mjs config set agents.defaults.model openrouter/auto
```

### Step 7: OpenRouter Auth Profile

Create `/opt/agents/data/client-1/.openclaw/agents/main/agent/auth-profiles.json`:

```json
{
  "openrouter": {
    "apiKey": "sk-or-v1-your-key-here"
  }
}
```

This tells the agent WHERE to send LLM requests. Without this, it defaults to direct Anthropic and fails with "No API key found for provider anthropic."

### Step 8: Control UI — Device Pairing

1. Open `https://agentalfa.agentik.mx` in browser
2. Enter the **Gateway Token** and click **Connect**
3. The UI shows "pairing required"
4. On the server, approve the device:

```bash
docker exec agent-client-1 node /app/openclaw.mjs devices list
docker exec agent-client-1 node /app/openclaw.mjs devices approve <requestId>
```

5. Refresh browser — status changes to **Online**

Why this works: HTTPS gives the browser a "secure context" which allows Web Crypto API to generate device identity keys. Without HTTPS (plain HTTP to a remote IP), the browser blocks this. We learned this the hard way.

Workaround for debugging without HTTPS: SSH tunnel `ssh -N -L 3001:localhost:3001 root@SERVER_IP` then access `http://localhost:3001` (localhost is always a secure context).

### Step 9: Telegram Bot Connection

1. Create bot with @BotFather on Telegram, get token
2. Set the token:

```bash
docker exec agent-client-1 node /app/openclaw.mjs config set channels.telegram.accounts.default.botToken 'YOUR_BOT_TOKEN'
```

Note: The config path is `channels.telegram.accounts.default.botToken` — NOT `telegram.bots.0.token` (old format) or `channels.telegram.token` (wrong key name).

3. Restart the gateway:

```bash
docker compose restart agent-client-1
```

4. Verify in logs:

```bash
docker logs agent-client-1 --tail 15
```

Look for: `[telegram] [default] starting provider (@YourBot_bot)`

5. Send a message to the bot on Telegram — it responds with a **pairing code**
6. Approve the Telegram user:

```bash
docker exec agent-client-1 node /app/openclaw.mjs pairing approve telegram PAIRING_CODE
```

### Step 10: CLI Tools for Skills (Auto-Installed)

The `entrypoint.sh` script automatically installs CLI tools on container start:
- **gog** — Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets, Docs)
- **summarize** — Summarize URLs, YouTube videos, podcasts

These survive container restarts automatically. No manual installation needed.

To add more CLI tools to auto-install, edit `/opt/agents/entrypoint.sh` on the server.

Manual install (if needed for debugging):

```bash
docker exec -u root agent-client-1 npm install -g gog summarize
```

### Step 11: Install ClawHub Skills

For skills from the community registry:

```bash
docker exec agent-client-1 npx clawhub install ddg-web-search
```

### Step 12: Verify All Skills

```bash
docker exec agent-client-1 node /app/openclaw.mjs skills check
```

Current ready skills after full setup:

| Skill | Purpose | Dependency |
|-------|---------|------------|
| **gog** | Google Workspace (Gmail, Calendar, Drive, etc.) | `gog` CLI + Google OAuth |
| **openai-whisper-api** | Voice note transcription | `OPENAI_API_KEY` env var |
| **openai-image-gen** | Image generation | `OPENAI_API_KEY` env var |
| **ddg-search** | Web search (DuckDuckGo) | ClawHub package |
| **summarize** | Summarize URLs/YouTube/podcasts | `summarize` CLI |
| **weather** | Weather forecasts | None (uses wttr.in) |
| **healthcheck** | Server security checks | None |
| **skill-creator** | Create custom skills | None |

### Step 13: Memory System Setup

OpenClaw has built-in memory with three layers:

1. **Session Memory Hook** — Auto-saves session summaries on `/new` or `/reset`
2. **Memory Tools** — Agent can read/write memory files during conversations
3. **Memory Search** — Vector + full-text search over all memory files (uses `text-embedding-3-small` via OpenAI key)

Create the memory directory inside the container's workspace:

```bash
docker exec -u root agent-client-1 mkdir -p /home/node/.openclaw/workspace/memory
docker exec -u root agent-client-1 chown node:node /home/node/.openclaw/workspace/memory
```

Important: The workspace inside the container is at `/home/node/.openclaw/workspace/`, NOT at `/data/workspace/`. The `OPENCLAW_WORKSPACE_DIR=/data/workspace` env var sets a different path for the state directory, but the agent's actual workspace resolves to the home directory path.

Verify memory is ready:

```bash
docker exec agent-client-1 node /app/openclaw.mjs memory status
```

Should show: `Vector: ready`, `FTS: ready`, no "directory missing" issues.

Memory hygiene is automatic — no manual cleanup needed. Compaction mode `safeguard` handles long conversations.

---

## Gotchas and Lessons Learned

### Port Mapping
OpenClaw gateway listens on **port 18789**, not 3000. The Docker compose port mapping must be `"3001:18789"`.

### Model Default
Fresh OpenClaw defaults to `anthropic/claude-opus-4-6` which requires a direct Anthropic API key. Must explicitly set `agents.defaults.model` to `openrouter/auto` and create `auth-profiles.json` with the OpenRouter key.

### HTTPS Requirement
The Control UI requires a "secure context" (HTTPS or localhost) for device identity via Web Crypto API. Plain HTTP to a remote IP will show "control ui requires device identity" and block pairing. Solutions: Caddy reverse proxy (production) or SSH tunnel (debugging).

### Container Recreates (SOLVED)
`docker compose up -d` (after changing docker-compose.yml) **recreates** the container. Previously this lost globally installed npm packages (gog, summarize). Now solved with two mechanisms:
- **`entrypoint.sh`** — auto-installs CLI tools on every container start (gog, summarize)
- **Workspace volume mount** — `./data/AGENT/workspace:/home/node/.openclaw/workspace` persists workspace files (IDENTITY.md, SOUL.md, memory, etc.)

The `/data` volume persists configs, auth, and memory. Nothing is lost on recreate.

### Config Key Names
Telegram token config path is `channels.telegram.accounts.default.botToken` — not `telegram.bots.0.token`, not `channels.telegram.token`, not `channels.telegram.accounts.default.token`. All of those fail validation.

### Permissions
The container runs as `user: root` (for entrypoint to install tools), then drops to `node` user via `runuser`. Data directories should still be `chmod -R 777` for safety.

### Auth Profiles Format
The `auth-profiles.json` must use the AuthProfileStore format:
```json
{
  "version": 1,
  "profiles": {
    "anthropic-default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "sk-ant-..."
    }
  }
}
```
NOT the simple `{ "anthropic": { "apiKey": "..." } }` format — that silently fails.

### Workspace Path
The workspace volume must mount to `/home/node/.openclaw/workspace` (where OpenClaw actually reads it), not `/data/workspace`. The `OPENCLAW_WORKSPACE_DIR` env var is for the state directory, but the agent resolves workspace from `~/.openclaw/workspace`.

---

## Quick Reference: All CLI Commands

```bash
# SSH into server
ssh root@89.167.94.10

# Container management
cd /opt/agents
docker compose up -d --build          # Build and start
docker compose restart agent-client-1  # Restart
docker compose down                    # Stop all
docker logs agent-client-1 --tail 20   # View logs

# OpenClaw CLI (inside container)
docker exec agent-client-1 node /app/openclaw.mjs <command>

# Or use the alias (if set up):
oc <command>

# Device pairing
oc devices list
oc devices approve <requestId>

# Telegram pairing
oc pairing approve telegram <PAIRING_CODE>

# Config
oc config set agents.defaults.model openrouter/auto
oc config get agents.defaults.model

# Channels
oc channels status
oc channels list
oc config set channels.telegram.accounts.default.botToken 'TOKEN'

# Skills
oc skills list
oc skills check
oc skills info <skill-name>

# Memory
oc memory status
oc memory search --query "some topic"
oc memory index --force

# Agents
oc agents list

# Install CLI tools (as root)
docker exec -u root agent-client-1 npm install -g gog summarize

# Install ClawHub skills
docker exec agent-client-1 npx clawhub install <skill-name>
```

---

## Architecture Summary

```
Client Browser / Telegram / WhatsApp
        │
        ▼
  Caddy (HTTPS, port 443)
        │
        ▼
  Docker: agent-client-1 (port 3001 → 18789)
        │
        ├── OpenClaw Gateway
        │     ├── Chat Models → OpenRouter API → Gemini/Claude/DeepSeek
        │     ├── Whisper → OpenAI API (transcription only)
        │     ├── Embeddings → OpenAI API (memory search only)
        │     ├── Telegram Bot → Telegram API
        │     └── Skills (gog, summarize, weather, etc.)
        │
        └── /data (persistent volume)
              ├── .openclaw/
              │     ├── openclaw.json (gateway config)
              │     ├── agents/main/agent/
              │     │     ├── auth-profiles.json (OpenRouter key)
              │     │     └── models.json (model definitions)
              │     └── memory/main.sqlite (vector search index)
              └── workspace/
                    └── memory/ (markdown memory files)
```

---

## Cost Breakdown (Per Agent)

| Item | Monthly Cost |
|------|-------------|
| Hetzner share (~$7/mo ÷ 5 agents) | ~$1.40 |
| OpenRouter (chat models, routed) | $7-18 |
| OpenAI (Whisper + embeddings) | $1-3 |
| **Total per agent** | **$10-23** |
| **Client pays** | **$49/mo** |
| **Margin** | **$26-39/mo** |

---

## Automation Status

### Done
- [x] `entrypoint.sh` auto-installs gog + summarize on container start (survives recreates)
- [x] Workspace volume mount persists agent identity + memory across recreates
- [x] `add-agent.sh` script handles full agent provisioning in one command
- [x] Correct AuthProfileStore format in auth-profiles.json

### TODO
- [ ] Automate Google OAuth setup flow for clients
- [ ] Create `remove-agent.sh` script (reverse of add-agent.sh)
- [ ] Add monitoring/alerting for agent health
- [ ] Set up HEARTBEAT.md tasks for periodic agent maintenance
- [ ] Consider Watchtower for auto-updating containers when the repo updates
