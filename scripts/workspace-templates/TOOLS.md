# TOOLS.md - Herramientas Disponibles

## Herramientas Nativas (siempre disponibles)

Estas herramientas hablan directamente con el gateway via WebSocket. Usalas directamente — NUNCA generes comandos CLI para que alguien los corra en terminal.

### Archivos
- **read** — Leer contenido de archivos del workspace
- **write** — Crear o sobrescribir archivos
- **edit** — Editar archivos con precision

### Ejecucion
- **exec** — Ejecutar comandos de shell
- **process** — Manejar procesos en background

### Web
- **web_search** — Buscar en la web
- **web_fetch** — Obtener contenido de URLs

### Memoria
- **memory_search** — Busqueda semantica en tu memoria
- **memory_get** — Leer archivos de memoria

### Sesiones y Agentes
- **sessions_list** — Listar sesiones
- **sessions_history** — Ver historial de sesion
- **sessions_send** — Enviar mensaje a una sesion
- **sessions_spawn** — Crear sub-agente
- **agents_list** — Listar agentes

### Comunicacion
- **message** — Enviar mensajes (Telegram, WhatsApp, etc.)

### Automatizacion
- **cron** — Crear, listar, editar y eliminar cron jobs. Usa esta herramienta directamente para programar recordatorios y tareas recurrentes. NO uses `openclaw cron add` por CLI.
- **gateway** — Control del gateway
- **nodes** — Nodos y dispositivos conectados

### Media
- **image** — Entender/analizar imagenes
- **tts** — Texto a voz

## Skills Instaladas (9 de 53)

| Skill | Descripcion | Uso |
|---|---|---|
| gog | Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets, Docs) | Email, calendario, docs |
| summarize | Resumir URLs, podcasts, videos, archivos locales | Transcribir YouTube, resumir articulos |
| ddg-search | Busqueda web via DuckDuckGo (sin API key) | Busquedas cuando web_search no tiene Brave API |
| pdf-text-extractor | Extraer texto de PDFs con OCR | Digitalizar documentos, facturas |
| openai-whisper-api | Transcribir audio via OpenAI Whisper API | Transcripcion de notas de voz |
| openai-image-gen | Generar imagenes via OpenAI Images API | Crear imagenes, galeria HTML |
| weather | Clima actual y pronostico (wttr.in / Open-Meteo) | Consultar clima de cualquier ciudad |
| healthcheck | Auditoria de seguridad del host | Revisar seguridad del servidor |
| skill-creator | Crear o actualizar skills | Empaquetar nuevas skills |

## Skills que puedes instalar tu mismo

Tu directorio de skills (/app/skills/) esta montado en un volumen persistente. Cualquier skill que instales **sobrevive reinicios y recreaciones del contenedor**. Instala lo que necesites con confianza.

```
# Buscar skills disponibles
npx clawhub search <query>

# Instalar una skill (persistente)
npx clawhub install <skill-name>

# Listar skills instaladas
npx clawhub list
```

Hay 53 skills disponibles en el catalogo de OpenClaw. Explora e instala las que tu owner necesite.

## Setup Especifico

### Telegram
- Bot: @__TELEGRAM_BOT__
- Owner chat ID: __TELEGRAM_CHAT_ID__

### Gateway
- WebSocket local: ws://127.0.0.1:18789
- Configurado en gateway.remote — todas las herramientas nativas saben conectarse
