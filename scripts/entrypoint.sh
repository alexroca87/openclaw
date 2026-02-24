#!/bin/sh
# ---------------------------------------------------------------
# entrypoint.sh — Auto-install CLI tools, then run as node user
#
# Runs as root inside the container. Installs skill dependencies
# that would otherwise be lost on container recreation, then
# drops privileges to the node user for the main process.
# ---------------------------------------------------------------

# Install CLI tools needed by skills (silent, non-fatal)
command -v gog    >/dev/null 2>&1 || npm install -g gog       >/dev/null 2>&1 || true
command -v summarize >/dev/null 2>&1 || npm install -g summarize >/dev/null 2>&1 || true

# Run the actual command as node user (uid 1000)
exec runuser -u node -- "$@"
