# llm-proxy-router

Config-driven model router for Claude Code. Dispatches on `body.model`:

```
claude -> headroom :8787 -> model-router :8789 -> upstream (per route)
```

Routes live **outside** this repo in `~/.config/headroom-router/routes.mjs`
(delivered by chezmoi). Adding a provider = append a route entry + restart; no code edit.

## Legs

- `glm-*` -> z.ai (Anthropic-compatible, keyed via `x-api-key`)
- `deepseek|qwen|llama` -> LiteLLM :4000 -> Ollama (Anthropic->Ollama translation)
- everything else -> api.anthropic.com **verbatim** (preserves Claude Pro/Max OAuth)

## Files

- `router.mjs` — the router (zero deps, Node >=18)
- `litellm.config.yaml` — LiteLLM model list (Ollama backends)
- `bootstrap.sh` — builds the LiteLLM venv (not committed)

## Migrate to a new box

1. `git clone <this repo> ~/src/llm-proxy-router`
2. `bash ~/src/llm-proxy-router/bootstrap.sh`  # builds .venv-litellm
3. `chezmoi apply`  # delivers routes.mjs, zai.env, systemd units, bashrc aliases
4. `systemctl --user daemon-reload`
5. `systemctl --user enable --now litellm.service model-router.service`
6. Verify: `curl -s localhost:8789/healthz` -> `ok`

## Machine-specific

- **node path** in `model-router.service` ExecStart — templated by chezmoi per box.
- **LiteLLM venv** — rebuilt by `bootstrap.sh`, never committed.
- **Ollama IP** in `litellm.config.yaml` — assumes the box reaches the LAN host.
