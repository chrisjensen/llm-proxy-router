#!/usr/bin/env bash
# Per-box setup for the LLM proxy router. Idempotent.
# Builds the LiteLLM venv (not committed) so the ollama leg works.
# Config (routes.mjs, zai.env, systemd units) is delivered by chezmoi separately.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv-litellm"

if [ ! -x "$venv/bin/litellm" ]; then
  echo "==> creating LiteLLM venv at $venv"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --upgrade pip
  "$venv/bin/pip" install 'litellm[proxy]'
else
  echo "==> LiteLLM venv already present"
fi

echo "==> node: $(command -v node || echo 'NOT FOUND — install via nvm')"
echo "==> done. Next: chezmoi apply, then enable systemd units."
