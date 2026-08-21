# pi-zen

Free [OpenCode Zen](https://opencode.ai/zen) models in [pi](https://github.com/earendil-works/pi-coding-agent) — registered straight from Zen's live catalog, so a new free model (stealth drops included) works the day it appears.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

1. Get an API key at <https://opencode.ai/zen> (sign in → billing → copy key).
2. `/login pi-zen` — pi stores it in `~/.pi/agent/auth.json`. No env var needed.
3. `/model` → pick a `pi-zen/*` model.

## What you get

- **No premature compaction** — pi sizes sessions to the model's real memory. Ox Alpha summarizes at 1M tokens, not 128k.
- **The thinking picker tells the truth** — low/high/max show up only when the model accepts them.
- **Screenshots work** — paste images to the models that can see them.
- **New free models appear by themselves** — when Zen adds one, it shows up in `/model` without an extension update.
- **Free means free** — nothing billable ever enters the picker.

Model metadata comes from [models.dev](https://models.dev) — the same catalog pi generates its own model list from.

No custom commands — pi's built-ins (`/model`, `/login`) cover everything.

## Env (optional)

- `ZEN_API_KEY` — key for headless/CI use (skips `/login`)
- `ZEN_BASE_URL` — override the endpoint (default `https://opencode.ai/zen/v1`)
- `PI_CODING_AGENT_DIR` — alternate pi config dir

## License

MIT
