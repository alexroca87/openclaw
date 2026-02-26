#!/usr/bin/env node
import http from 'http'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'

const PORT = 4000
const TOKEN = process.env.PROVISION_API_TOKEN

if (!TOKEN) {
  console.error('ERROR: PROVISION_API_TOKEN env var is required')
  process.exit(1)
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Auth
  const auth = req.headers['authorization'] || ''
  if (auth !== `Bearer ${TOKEN}`) {
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

  // Provision endpoint
  if (req.method === 'POST' && req.url === '/provision') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      let agentName, openrouterKey, telegramToken

      try {
        const parsed = JSON.parse(body)
        agentName = parsed.agentName?.trim()
        openrouterKey = parsed.openrouterKey?.trim()
        telegramToken = parsed.telegramToken?.trim() || null
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      if (!agentName || !openrouterKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentName and openrouterKey are required' }))
        return
      }

      // Validate agentName: lowercase alphanumeric + hyphens only
      if (!/^[a-z0-9-]+$/.test(agentName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'agentName must be lowercase letters, numbers, and hyphens only' }))
        return
      }

      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      const send = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
      }

      // Run add-agent.sh
      send('log', `🚀 Iniciando aprovisionamiento de agente: ${agentName}`)
      send('log', '─────────────────────────────────────────')

      const addAgent = spawn('/opt/agents/add-agent.sh', [agentName, 'agentik.mx', openrouterKey], {
        cwd: '/opt/agents',
      })

      let gatewayToken = null
      const containerName = `agent-${agentName}`

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
          send('log', `⚠️  ${line}`)
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

        // Post-setup: install gog + summarize (they're lost on container recreate)
        send('log', '')
        send('log', '📦 Instalando herramientas CLI (gog, summarize)...')

        const npmInstall = spawn('docker', [
          'exec', '-u', 'root', containerName,
          'npm', 'install', '-g', 'gog', 'summarize'
        ])

        npmInstall.stdout.on('data', d => {
          const lines = d.toString().split('\n').filter(Boolean)
          for (const l of lines) send('log', `  ${l}`)
        })
        npmInstall.stderr.on('data', d => {
          // npm install writes progress to stderr — filter noise
          const lines = d.toString().split('\n').filter(Boolean)
          for (const l of lines) {
            if (l.includes('npm warn') || l.includes('added ')) send('log', `  ${l}`)
          }
        })

        npmInstall.on('close', () => {
          // Post-setup: memory directory
          send('log', '')
          send('log', '🧠 Configurando directorio de memoria...')

          const memSetup = spawn('docker', [
            'exec', '-u', 'root', containerName,
            'sh', '-c',
            'mkdir -p /home/node/.openclaw/workspace/memory && chown -R node:node /home/node/.openclaw'
          ])

          memSetup.on('close', () => {
            // Set Telegram bot token if provided
            if (telegramToken) {
              send('log', '')
              send('log', '🤖 Configurando Telegram...')

              const tgSetup = spawn('docker', [
                'exec', containerName,
                'node', '/app/openclaw.mjs', 'config', 'set',
                'channels.telegram.accounts.default.botToken', telegramToken
              ])

              tgSetup.on('close', () => {
                // Restart container to apply Telegram config
                spawn('docker', ['compose', '-f', '/opt/agents/docker-compose.yml', 'restart', containerName])
                send('log', '  ✅ Telegram configurado — reiniciando container...')
                finalize()
              })
            } else {
              finalize()
            }
          })
        })

        function finalize() {
          send('log', '')
          send('log', '✅ ¡Agente listo!')
          send('log', `   URL: https://${agentName}.agentik.mx`)
          send('log', `   Gateway Token: ${gatewayToken}`)
          send('done', {
            agentUrl: `https://${agentName}.agentik.mx`,
            gatewayToken,
            containerName,
          })
          res.end()
        }
      })
    })
    return
  }


  // File ingest endpoint — write file content to agent workspace
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

      const { spawn } = await import('child_process')
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
            // readFileSync already imported at top
            const cfgPath = '/opt/agents/data/' + agentName + '/.openclaw/openclaw.json'
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

  res.writeHead(404)
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Provision API listening on port ${PORT}`)
})

