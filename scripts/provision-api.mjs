#!/usr/bin/env node
import http from 'http'
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import crypto from 'crypto'

const PORT = 4000
const TOKEN = process.env.PROVISION_API_TOKEN
const AGENTS_DIR = '/opt/agents'

if (!TOKEN) {
  console.error('ERROR: PROVISION_API_TOKEN env var is required')
  process.exit(1)
}

// --- Helper: replace placeholders in a file on the host ---
function fillTemplate(filePath, replacements) {
  if (!existsSync(filePath)) return false
  let content = readFileSync(filePath, 'utf8')
  for (const [placeholder, value] of Object.entries(replacements)) {
    content = content.replaceAll(placeholder, value)
  }
  writeFileSync(filePath, content, 'utf8')
  return true
}

// --- Helper: generate a random setup password ---
function generateSetupPassword() {
  return crypto.randomBytes(12).toString('base64url')
}

const server = http.createServer(async (req, res) => {
  // CORS headers (only agentik-platform Vercel + localhost)
  const origin = req.headers.origin || ''
  const allowed = [
    'https://agentik-platform.vercel.app',
    'http://localhost:3001',
    'http://localhost:3000',
  ]
  if (allowed.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Auth (skip for health check GET)
  const auth = req.headers['authorization'] || ''
  if (req.url !== '/health' && auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // =====================================================================
  // POST /provision — Create a new agent with onboarding data
  // =====================================================================
  if (req.method === 'POST' && req.url === '/provision') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      let agentName, domain, apiKey, openrouterKey, openaiKey, telegramBotToken, onboarding

      try {
        const parsed = JSON.parse(body)
        agentName = parsed.agentName?.trim()
        domain = parsed.domain?.trim() || 'agentik.mx'
        apiKey = parsed.apiKey?.trim() || ''           // Anthropic key
        openrouterKey = parsed.openrouterKey?.trim() || ''
        openaiKey = parsed.openaiKey?.trim() || ''
        telegramBotToken = parsed.telegramBotToken?.trim() || null
        onboarding = parsed.onboarding || null
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!agentName) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentName is required' }))
        return
      }

      if (!apiKey && !openrouterKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'At least one of apiKey (Anthropic) or openrouterKey is required' }))
        return
      }

      // Validate agentName: lowercase alphanumeric + hyphens only
      if (!/^[a-z0-9-]+$/.test(agentName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentName must be lowercase letters, numbers, and hyphens only' }))
        return
      }

      // Generate a setup password for initial web UI access
      const setupPassword = generateSetupPassword()

      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const send = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
      }

      // Run add-agent.sh with: <name> <domain> [openrouter] [openai] [anthropic]
      send('log', `Iniciando aprovisionamiento de agente: ${agentName}`)
      send('log', '─────────────────────────────────────────')

      const addAgent = spawn('/opt/agents/add-agent.sh', [
        agentName, domain, openrouterKey, openaiKey, apiKey
      ], {
        cwd: '/opt/agents',
      })

      let gatewayToken = null
      const containerName = `agent-${agentName}`
      const workspaceDir = `${AGENTS_DIR}/data/${agentName}/workspace`

      addAgent.stdout.on('data', data => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          send('log', line)
          // Extract gateway token from script output
          const match = line.match(/Gateway Token:\s*([a-f0-9]{48})/i)
          if (match) gatewayToken = match[1]
        }
      })

      addAgent.stderr.on('data', data => {
        const lines = data.toString().split('\n').filter(Boolean)
        for (const line of lines) {
          // Skip Docker build noise (layer downloads)
          if (line.startsWith('#') || line.includes(' => ') || line.includes('CACHED')) continue
          send('log', `  ${line}`)
        }
      })

      addAgent.on('error', err => {
        send('error', `Error ejecutando add-agent.sh: ${err.message}`)
        res.end()
      })

      addAgent.on('close', code => {
        if (code !== 0) {
          send('error', `add-agent.sh terminó con código ${code}`)
          res.end()
          return
        }

        // --- Post-setup step 1: Fill workspace templates with onboarding data ---
        if (onboarding) {
          send('log', '')
          send('log', 'Personalizando workspace con datos de onboarding...')

          const checks = Array.isArray(onboarding.periodicChecks)
            ? onboarding.periodicChecks
            : []
          const helpTasks = Array.isArray(onboarding.helpTasks)
            ? onboarding.helpTasks
            : []

          // Fill HEARTBEAT.md placeholders
          const heartbeatFilled = fillTemplate(`${workspaceDir}/HEARTBEAT.md`, {
            '__OWNER_NAME__': onboarding.ownerName || agentName,
            '__TIMEZONE__': onboarding.timezone || 'UTC',
            '__PRIMARY_CHANNEL__': onboarding.agentChannel || 'web',
            '__YES_NO__': checks.length > 0 ? 'Yes' : 'No',
            '__CUSTOM_CHECKS__': checks.join(', ') || 'None configured',
            '__QUIET_START__': onboarding.quietStart || '23:00',
            '__QUIET_END__': onboarding.quietEnd || '08:00',
          })
          if (heartbeatFilled) send('log', '  HEARTBEAT.md personalizado')

          // Fill USER.md placeholders
          const userFilled = fillTemplate(`${workspaceDir}/USER.md`, {
            '__OWNER_NAME__': onboarding.ownerName || agentName,
            '__NICKNAME__': onboarding.nickname || onboarding.ownerName || agentName,
            '__OCCUPATION__': onboarding.occupation || 'Not specified',
            '__LANGUAGE__': onboarding.language || 'English',
            '__TONE__': onboarding.tone || 'Professional',
            '__PRIMARY_CHANNEL__': onboarding.agentChannel || 'web',
            '__TIMEZONE__': onboarding.timezone || 'UTC',
            '__QUIET_START__': onboarding.quietStart || '23:00',
            '__QUIET_END__': onboarding.quietEnd || '08:00',
            '__ABOUT_ME__': onboarding.aboutMe || 'Not provided yet.',
            '__GOALS__': onboarding.goals || 'Not provided yet.',
            '__HELP_TASKS__': helpTasks.length > 0
              ? helpTasks.map(t => `- ${t}`).join('\n')
              : '- General assistance',
          })
          if (userFilled) send('log', '  USER.md personalizado')

          // Fill TOOLS.md Telegram placeholders if bot token is provided
          if (telegramBotToken) {
            fillTemplate(`${workspaceDir}/TOOLS.md`, {
              '__TELEGRAM_BOT__': `(configured)`,
              '__TELEGRAM_CHAT_ID__': '(pending first message)',
            })
          }
        }

        // --- Post-setup step 2: Copy USER.md template if onboarding didn't create it ---
        if (!onboarding && existsSync('/opt/openclaw/scripts/workspace-templates/USER.md')) {
          try {
            copyFileSync('/opt/openclaw/scripts/workspace-templates/USER.md', `${workspaceDir}/USER.md`)
          } catch { /* template will have placeholders */ }
        }

        // --- Post-setup step 3: Install CLI tools ---
        // NOTE: Do NOT install "gog" via npm — that's a wrong package (bash script runner v0.0.12).
        // The real Google Workspace CLI (gogcli) is a Go binary auto-installed by entrypoint.sh
        // from github.com/steipete/gogcli releases. See entrypoint.sh for details.
        send('log', '')
        send('log', 'Instalando herramientas CLI (summarize)...')

        const npmInstall = spawn('docker', [
          'exec', '-u', 'root', containerName,
          'npm', 'install', '-g', 'summarize'
        ])

        npmInstall.stdout.on('data', d => {
          const lines = d.toString().split('\n').filter(Boolean)
          for (const l of lines) send('log', `  ${l}`)
        })
        npmInstall.stderr.on('data', d => {
          const lines = d.toString().split('\n').filter(Boolean)
          for (const l of lines) {
            if (l.includes('npm warn') || l.includes('added ')) send('log', `  ${l}`)
          }
        })

        npmInstall.on('close', () => {
          // --- Post-setup step 4: Memory directory ---
          send('log', '')
          send('log', 'Configurando directorio de memoria...')

          const memSetup = spawn('docker', [
            'exec', '-u', 'root', containerName,
            'sh', '-c',
            'mkdir -p /home/node/.openclaw/workspace/memory && chown -R node:node /home/node/.openclaw'
          ])

          memSetup.on('close', () => {
            // --- Post-setup step 5: Telegram ---
            if (telegramBotToken) {
              send('log', '')
              send('log', 'Configurando Telegram...')

              const tgSetup = spawn('docker', [
                'exec', containerName,
                'node', '/app/openclaw.mjs', 'config', 'set',
                'channels.telegram.accounts.default.botToken', telegramBotToken
              ])

              tgSetup.on('close', () => {
                spawn('docker', ['compose', '-f', '/opt/agents/docker-compose.yml', 'restart', containerName])
                send('log', '  Telegram configurado — reiniciando container...')
                finalize()
              })
            } else {
              finalize()
            }
          })
        })

        function finalize() {
          const agentUrl = `https://${agentName}.${domain}`

          send('log', '')
          send('log', 'Agente listo!')
          send('log', `   URL: ${agentUrl}`)
          send('log', `   Gateway Token: ${gatewayToken}`)
          send('done', {
            ok: true,
            agentUrl,
            gatewayToken,
            containerName,
            setupPassword,
          })
          res.end()
        }
      })
    })
    return
  }


  // =====================================================================
  // POST /file-ingest — Write file content to agent workspace
  // =====================================================================
  if (req.method === 'POST' && req.url === '/file-ingest') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      let agentName, filename, content

      try {
        const parsed = JSON.parse(body)
        agentName = parsed.agentName?.trim()
        filename = parsed.filename?.trim()
        content = parsed.content
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!agentName || !filename || content === undefined) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentName, filename and content are required' }))
        return
      }

      // Sanitize filename
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      const containerName = 'agent-' + agentName

      const mkdir = spawn('docker', [
        'exec', '-u', 'root', containerName,
        'sh', '-c', 'mkdir -p /home/node/.openclaw/workspace/uploads'
      ])

      mkdir.on('close', code => {
        if (code !== 0) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Failed to create uploads dir' }))
          return
        }

        const write = spawn('docker', [
          'exec', '-u', 'root', '-i', containerName,
          'sh', '-c', 'cat > /home/node/.openclaw/workspace/uploads/' + safeName
        ])

        write.stdin.write(content)
        write.stdin.end()

        write.on('close', wCode => {
          if (wCode !== 0) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Failed to write file' }))
            return
          }

          // Wake the agent immediately with a system event
          try {
            const cfgPath = `${AGENTS_DIR}/data/${agentName}/.openclaw/openclaw.json`
            const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
            const internalToken = cfg?.gateway?.auth?.token || ''
            if (internalToken) {
              spawn('docker', [
                'exec', containerName,
                'node', 'openclaw.mjs', 'system', 'event',
                '--text', '[SISTEMA] Nuevo archivo en workspace/uploads/' + safeName + '. Procésalo y guarda lo relevante en tu memoria.',
                '--mode', 'now',
                '--token', internalToken,
                '--timeout', '8000'
              ])
            }
          } catch (e) {
            console.warn('[file-ingest] wake error:', e.message)
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, path: 'uploads/' + safeName }))
        })
      })
    })
    return
  }

  // =====================================================================
  // POST /update-env — Update a credential on a running agent
  //
  // Body: { agentUrl, field, value }
  //   field: "anthropic_api_key" | "brave_api_key"
  //
  // anthropic_api_key → update auth-profiles.json + restart container
  // brave_api_key     → update BRAVE_API_KEY in docker-compose.yml + restart
  // =====================================================================
  if (req.method === 'POST' && req.url === '/update-env') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      let agentUrl, field, value

      try {
        const parsed = JSON.parse(body)
        agentUrl = parsed.agentUrl?.trim()
        field = parsed.field?.trim()
        value = parsed.value?.trim()
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!agentUrl || !field || !value) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentUrl, field, and value are required' }))
        return
      }

      // Extract agent name from URL: https://mari.agentik.mx → mari
      const urlMatch = agentUrl.match(/^https?:\/\/([^.]+)\./)
      if (!urlMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Could not parse agent name from agentUrl' }))
        return
      }
      const agentName = urlMatch[1]
      const containerName = `agent-${agentName}`
      const composeFile = `${AGENTS_DIR}/docker-compose.yml`

      // Validate field
      const allowedFields = ['anthropic_api_key', 'brave_api_key']
      if (!allowedFields.includes(field)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `field must be one of: ${allowedFields.join(', ')}` }))
        return
      }

      // Verify agent data dir exists
      const dataDir = `${AGENTS_DIR}/data/${agentName}`
      if (!existsSync(dataDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Agent '${agentName}' not found` }))
        return
      }

      try {
        if (field === 'anthropic_api_key') {
          // Update auth-profiles.json
          const profilesPath = `${dataDir}/.openclaw/agents/main/agent/auth-profiles.json`
          let profiles
          if (existsSync(profilesPath)) {
            profiles = JSON.parse(readFileSync(profilesPath, 'utf8'))
          } else {
            profiles = { version: 1, profiles: {} }
          }

          profiles.profiles['anthropic-default'] = {
            type: 'api_key',
            provider: 'anthropic',
            key: value,
          }

          writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8')
          console.log(`[update-env] Updated anthropic key for ${agentName}`)

        } else if (field === 'brave_api_key') {
          // Update BRAVE_API_KEY in docker-compose.yml (multi-agent safe)
          const lines = readFileSync(composeFile, 'utf8').split('\n')
          let inTargetService = false
          let inEnvironment = false
          let replaced = false
          let lastEnvLineIdx = -1

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            // Detect entering our target service
            if (line.match(new RegExp(`^  ${containerName}:`))) {
              inTargetService = true
              continue
            }
            // Detect leaving service (next service or networks: at root level)
            if (inTargetService && /^  \S/.test(line) && !line.startsWith(`  ${containerName}`)) {
              inTargetService = false
              inEnvironment = false
            }
            if (inTargetService && line.includes('environment:')) {
              inEnvironment = true
              continue
            }
            // Detect leaving environment section (next non-env key)
            if (inTargetService && inEnvironment && /^\s{4}\w/.test(line) && !line.includes('- ')) {
              inEnvironment = false
            }
            if (inTargetService && inEnvironment && line.includes('- ')) {
              lastEnvLineIdx = i
              if (line.includes('BRAVE_API_KEY=')) {
                lines[i] = `      - BRAVE_API_KEY=${value}`
                replaced = true
              }
            }
          }

          // If not replaced, insert after last env var in this service
          if (!replaced && lastEnvLineIdx >= 0) {
            lines.splice(lastEnvLineIdx + 1, 0, `      - BRAVE_API_KEY=${value}`)
          }

          writeFileSync(composeFile, lines.join('\n'), 'utf8')
          console.log(`[update-env] Updated BRAVE_API_KEY in compose for ${agentName}`)
        }

        // Restart container to pick up changes
        const restart = spawn('docker', [
          'compose', '-f', composeFile, 'up', '-d', containerName
        ], { cwd: AGENTS_DIR })

        restart.on('close', (code) => {
          if (code !== 0) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `Container restart failed with code ${code}` }))
            return
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, field, agentName, restarted: true }))
        })

      } catch (e) {
        console.error(`[update-env] Error:`, e.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Provision API listening on port ${PORT}`)
})
