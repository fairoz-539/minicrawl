#!/usr/bin/env bash
# Creates .env with YOUR OWN freshly generated keys (macOS / Linux / Git Bash).
# Usage:  bash scripts/setup.sh      (run from the minicrawl folder)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists - not touching it. Delete it first to start over."
  exit 0
fi

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

api_key="$(rand)"
searxng_secret="$(rand)"
postgres_password="$(rand)"

echo "Optional: your own Anthropic API key for AI extraction (https://console.anthropic.com)."
read -r -s -p "Paste it, or press Enter to skip: " anthropic_key || true
echo

sed -e "s|^API_KEY=.*|API_KEY=${api_key}|" \
    -e "s|^SEARXNG_SECRET=.*|SEARXNG_SECRET=${searxng_secret}|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
    .env.example > .env
if [ -n "${anthropic_key}" ]; then
  sed -i.bak "s|^# ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${anthropic_key}|" .env && rm -f .env.bak
fi
chmod 600 .env

echo
echo "Created .env with a new API key. Use it as:  Authorization: Bearer <key>"
echo "Your API key: ${api_key}"
echo "(It is stored only in .env on this machine.)"
echo
echo "Next:  docker compose pull && docker compose up -d     (or: docker compose up -d --build, to build from source)"
