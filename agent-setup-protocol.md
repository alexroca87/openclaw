# Agent Setup Protocol — Productivity Agents

Standard setup checklist for configuring client agents on Agentik.mx.

---

## Phase 1: Core Skills Installation

Install these for every client agent:

```bash
clawhub install web-search-pro
clawhub install google-calendar-sync
clawhub install gmail-assistant
clawhub install cognitive-memory
```

| Skill | Purpose | API Key needed? |
|-------|---------|-----------------|
| **web-search-pro** | Real-time info, fact-checking, current data | DuckDuckGo (free, no key) or Brave Search (free tier) |
| **google-calendar-sync** | Schedule viewing, event creation, reminders | Google OAuth (browser auth) |
| **gmail-assistant** | Read, compose, search, send emails | Google OAuth (browser auth) |
| **cognitive-memory** | Remembers preferences and context across sessions | None |

---

## Phase 2: Google OAuth Setup

Both calendar and Gmail require Google OAuth. Do this during client onboarding call.

1. Run the skill's auth flow (opens browser)
2. Client logs into their Google account
3. Grant permissions:
   - **Calendar:** Start with read-only, add write later
   - **Gmail:** Start with read-only, add send/modify later
4. Verify: Ask the agent "what's on my calendar today?" and "show my latest emails"

---

## Phase 3: Web Search Configuration

Two options:

| Provider | Cost | Quality | Setup |
|----------|------|---------|-------|
| **DuckDuckGo** | Free, no key | Good | Default, no config needed |
| **Brave Search** | Free tier (2,000 queries/mo) | Better | Get API key at brave.com/search/api |

For Brave Search:
```bash
openclaw config set skills.entries.web-search-pro.apiKey "YOUR_BRAVE_API_KEY"
```

---

## Phase 4: Optional Skills (per client needs)

| Client type | Skill | Install command |
|-------------|-------|----------------|
| Uses Notion | Notion Integration | `clawhub install notion-integration` |
| Developer | Code Review | `clawhub install code-review` |
| Developer | Codebase Navigator | `clawhub install codebase-navigator` |
| Apple Calendar | CalDAV Connect | `clawhub install caldav-connect` |
| Outlook email | Outlook Connector | `clawhub install outlook-connector` |

---

## Phase 5: Verification Checklist

Test each skill before handing off to client:

- [ ] **Web Search:** "Search for the latest news about [topic]"
- [ ] **Calendar:** "What's on my calendar this week?"
- [ ] **Calendar write:** "Create a meeting tomorrow at 3pm called Team Sync"
- [ ] **Gmail read:** "Show me my latest unread emails"
- [ ] **Gmail send:** "Draft an email to test@example.com saying hello"
- [ ] **Memory:** Tell agent a preference, start new chat, verify it remembers
- [ ] **WhatsApp/Telegram:** Send a message from the client's channel, verify response

---

## Built-in Tools (no installation needed)

These come with OpenClaw by default:

- File system (read/write/move files)
- Command execution (run scripts)
- Web browsing (fetch and parse pages)
- Memory read/write (persistent storage)
- Message send (across connected channels)
- Image viewing (multimodal input)
- Code execution (Python/JS in sandbox)

---

## Model Router Configuration

Each agent uses the model-router extension for cost optimization:

| Tier | Model | % of messages | Cost per 1M tokens |
|------|-------|---------------|---------------------|
| Simple | Gemini 2.0 Flash | ~80% | $0.10 in / $0.40 out |
| Complex | Claude Haiku 4.5 | ~15% | $0.80 in / $4.00 out |
| Hard | Claude Sonnet | ~5% | $3.00 in / $15.00 out |
| Background | DeepSeek V3 | Summaries only | $0.27 in / $1.10 out |

Environment variables (set in docker-compose.yml):
```yaml
- OPENROUTER_API_KEY=your-key
- MODEL_ROUTER_SIMPLE=google/gemini-2.0-flash-exp
- MODEL_ROUTER_COMPLEX=anthropic/claude-haiku-4-5
- MODEL_ROUTER_HARD=anthropic/claude-sonnet-4
- MODEL_ROUTER_BACKGROUND=deepseek/deepseek-chat
```

---

## Estimated cost per agent (monthly)

| Item | Low usage | Medium usage | Heavy usage |
|------|-----------|--------------|-------------|
| Hosting (Hetzner share) | $0.75 | $1.50 | $3.00 |
| AI models (with routing) | $5-10 | $13-20 | $25-31 |
| **Total** | **$6-11** | **$15-22** | **$28-34** |

Client pays: $49/mo → Margin: $15-43/mo per client.

---

## Setup time estimate

- Fresh agent deploy: ~10 min
- Skills installation: ~5 min
- Google OAuth (with client): ~10 min
- Verification testing: ~10 min
- **Total: ~35 min per client**
