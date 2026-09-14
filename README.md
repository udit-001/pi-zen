# pi-zen

Free [OpenCode Zen](https://opencode.ai/zen) models for [pi](https://github.com/earendil-works/pi-coding-agent) — install, paste a key, pick a model. The model list stays current without reinstalling.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

1. Get an API key at <https://opencode.ai/zen> (sign in → billing → copy key).
2. `/login pi-zen` — pi stores it in `~/.pi/agent/auth.json`. No env var needed.
3. `/model` → pick a `pi-zen/*` model.

No extra commands — pi's `/model` and `/login` do everything.

## What you get

- **No premature compaction** — pi sizes sessions to the model's real context window.
- **A thinking picker that tells the truth** — low/high/max appear only when the model accepts them.
- **Free means free** — only models on Zen's free tier enter the picker.
- **Self-updating** — the model list refreshes itself; updates land without reinstalling.

## Env (optional)

- `ZEN_API_KEY` — headless/CI use (skips `/login`)
- `ZEN_BASE_URL` — override the endpoint (default `https://opencode.ai/zen/v1`)
- `PI_CODING_AGENT_DIR` — alternate pi config dir

## License

MIT
