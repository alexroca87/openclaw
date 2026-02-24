# Hetzner VPS Deploy Guide — OpenClaw Agents

## Prerequisites

- Hetzner Cloud account (hetzner.com)
- OpenRouter API key (openrouter.ai)
- SSH key on your Mac
- Domain with DNS access (e.g. agentik.mx on Namecheap)

---

## Step 1: Get your SSH key

```bash
# Check if you already have one
cat ~/.ssh/id_ed25519.pub

# If not, create one
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Copy the output — you'll paste it in Hetzner.

---

## Step 2: Create Hetzner server

1. Go to **Hetzner Cloud Console** → Create Project
2. Add Server:
   - **Location:** Helsinki (cheapest) or Ashburn (closest to Mexico)
   - **Image:** Ubuntu 24.04
   - **Type:** CPX22 (2 vCPU, 4GB RAM) — ~$7/mo, runs ~5 agents
   - **SSH Key:** Paste your public key from Step 1
3. Click **Create Server**
4. Note the IP address (e.g. `89.167.94.10`)

---

## Step 3: SSH into your server

```bash
ssh root@YOUR_SERVER_IP
```

---

## Step 4: Install Docker + Caddy

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Caddy (reverse proxy with auto-HTTPS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

---

## Step 5: Clone OpenClaw

```bash
apt update && apt install -y git
git clone https://github.com/alexroca87/openclaw.git /opt/openclaw
```

---

## Step 6: Firewall + server hardening

```bash
# Disable password login
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Enable firewall
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (Caddy redirect)
ufw allow 443/tcp    # HTTPS (Caddy)
ufw enable
```

Note: We do NOT expose agent ports (3001-3050) directly. Caddy handles HTTPS on port 443 and proxies to the containers internally.

---

## Step 7: Initial setup (one time)

```bash
mkdir -p /opt/agents
```

Copy the add-agent script to the server (from your Mac):

```bash
scp /Users/alexrojas/Luka/openclaw/scripts/add-agent.sh root@YOUR_SERVER_IP:/opt/agents/
```

On the server, make it executable:

```bash
chmod +x /opt/agents/add-agent.sh
```

Build the Docker image (first time only, takes ~5-10 min):

```bash
cd /opt/agents
# Create a minimal compose file to trigger the build
cat > docker-compose.yml << 'EOF'
services: {}
EOF
docker compose build 2>/dev/null || true
```

---

## Step 8: Add your first agent

On the server:

```bash
cd /opt/agents
./add-agent.sh agentalfa agentik.mx sk-or-v1-YOUR_OPENROUTER_KEY
```

This script:
1. Adds the agent service to docker-compose.yml
2. Creates the data directory with correct permissions
3. Configures OpenRouter auth and model (openrouter/auto)
4. Sets up the openclaw.json with HTTPS allowedOrigins
5. Adds a Caddy entry for `agentalfa.agentik.mx` with auto-SSL
6. Starts the container

---

## Step 9: DNS setup (per agent)

In your DNS provider (Namecheap → Advanced DNS), add an **A Record**:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A Record | `agentalfa` | `YOUR_SERVER_IP` | Automatic |

---

## Step 10: Pair the Control UI

1. Open `https://agentalfa.agentik.mx` in your browser
2. Enter the **Gateway Token** (shown by the add-agent script) and click **Connect**
3. Approve the device from the server:

```bash
# List pending pairing requests
docker exec agent-agentalfa node /app/openclaw.mjs devices list

# Approve the request
docker exec agent-agentalfa node /app/openclaw.mjs devices approve <requestId>
```

4. Refresh the browser — status should show **Online**

---

## Adding more agents

```bash
cd /opt/agents
./add-agent.sh clientname agentik.mx sk-or-v1-YOUR_OPENROUTER_KEY
```

Then add the DNS A record for `clientname.agentik.mx` → `YOUR_SERVER_IP`.

That's it — Caddy auto-provisions the SSL certificate.

---

## Quick reference commands

```bash
# SSH into server
ssh root@YOUR_SERVER_IP

# Start all agents
cd /opt/agents && docker compose up -d

# Stop all agents
docker compose down

# Restart one agent
docker compose restart agent-agentalfa

# View logs (follow)
docker compose logs -f agent-agentalfa

# List pending device pairings
docker exec agent-agentalfa node /app/openclaw.mjs devices list

# Approve a device
docker exec agent-agentalfa node /app/openclaw.mjs devices approve <requestId>

# Edit one agent's config
nano /opt/agents/data/agentalfa/.openclaw/openclaw.json

# Update OpenClaw for all agents
cd /opt/openclaw && git pull
cd /opt/agents && docker compose up -d --build

# Check resource usage
docker stats
```

---

## Editing individual agents

Each agent's data is isolated in its own folder:

```
/opt/agents/data/
  ├── agentalfa/
  │   ├── .openclaw/
  │   │   ├── openclaw.json
  │   │   └── agents/main/agent/
  │   │       ├── auth-profiles.json   (OpenRouter API key)
  │   │       └── models.json          (model config)
  │   └── workspace/
  │       └── instructions.md
  ├── clientname/
  │   └── ...
```

Edit one agent's instructions:

```bash
nano /opt/agents/data/agentalfa/workspace/instructions.md
docker compose restart agent-agentalfa
```

---

## Model router tiers

The model-router extension routes messages by complexity:

| Tier | Model | Cost (per 1M tokens) | % of messages |
|------|-------|---------------------|---------------|
| Simple | Gemini 2.0 Flash | $0.10 in / $0.40 out | ~80% |
| Complex | Claude Haiku 4.5 | $0.80 in / $4.00 out | ~15% |
| Hard | Claude Sonnet | $3.00 in / $15.00 out | ~5% |
| Background | DeepSeek V3 | $0.27 in / $1.10 out | Summaries only |

Override models via environment variables in docker-compose.yml:

```yaml
environment:
  - MODEL_ROUTER_SIMPLE=google/gemini-2.0-flash-exp
  - MODEL_ROUTER_COMPLEX=anthropic/claude-haiku-4-5
  - MODEL_ROUTER_HARD=anthropic/claude-sonnet-4
  - MODEL_ROUTER_BACKGROUND=deepseek/deepseek-chat
```

---

## Cost estimate

### Hosting (Hetzner)

| Server | RAM | Agents | Cost |
|--------|-----|--------|------|
| CPX22 | 4 GB | ~5 | ~$7/mo |
| CX32 | 8 GB | ~10-12 | $7.50/mo |
| CX42 | 16 GB | ~20-25 | $15/mo |

### AI (per agent, ~100 msgs/day with routing)

| Item | Cost |
|------|------|
| Gemini Flash (80%) | $2-5/mo |
| Claude Haiku (15%) | $3-8/mo |
| Claude Sonnet (5%) | $2-5/mo |
| **Total AI per agent** | **$7-18/mo** |

### Total per agent (hosting + AI)

- **Low usage:** ~$12-17/mo
- **Medium usage:** ~$20-28/mo
- **Heavy usage:** ~$35-45/mo

---

## Security

- Each agent has its own Docker network (can't reach other agents)
- Each agent only sees its own `/data` folder
- API keys are per-container environment variables
- SSH key auth only (password login disabled)
- Caddy handles HTTPS (auto Let's Encrypt certificates)
- Agent ports NOT exposed — only Caddy (80/443) is public
- UFW firewall blocks everything else
