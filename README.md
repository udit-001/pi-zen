# pi-zen

Free [OpenCode Zen](https://opencode.ai/zen) models in [pi](https://github.com/earendil-works/pi-coding-agent) — registered from a curated list maintained by a GitHub Action, with full model metadata baked in.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

1. Get an API key at <https://opencode.ai/zen> (sign in → billing → copy key).
2. `/login pi-zen` — pi stores it in `~/.pi/agent/auth.json`. No env var needed.
3. `/model` → pick a `pi-zen/*` model.

## What you get

- **No premature compaction** — pi sizes sessions to the model's real memory.
- **The thinking picker tells the truth** — low/high/max show up only when the model accepts them.
- **Screenshots work** — paste images to the models that can see them.
- **Free means free** — nothing billable ever enters the picker.

No custom commands — pi's built-ins (`/model`, `/login`) cover everything.

## How it works

```
┌──────────────────────────────────┐
│       GitHub Action              │  runs every 6h + on-demand
│  scrape docs → enrich metadata  │
│  → commit free-models.json      │
└──────────────┬───────────────────┘
               │ jsdelivr CDN (1h cache)
               ▼
┌──────────────────────────────────┐
│       Extension (index.ts)       │
│  fetch JSON → register provider │
│  fallback: local snapshot       │
└──────────────────────────────────┘
```

The extension fetches `free-models.json` from a `data` branch via jsdelivr CDN. The file contains all model metadata (context window, reasoning, thinking levels, compat flags) — no runtime models.dev join needed.

A GitHub Action (`.github/workflows/update-free-models.yml`) maintains the file by scraping the [opencode.ai Zen docs](https://opencode.ai/docs/zen) table and cross-referencing [models.dev](https://models.dev) for metadata. It runs every 6 hours and on manual dispatch.

The `data` branch keeps the JSON separate from the extension code, so updates to the model list don't trigger re-installation for users who installed via GitHub.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Extension entry — fetches JSON, registers provider |
| `free-models.snapshot.json` | Offline fallback (ships with extension) |
| `free-models.schema.json` | JSON schema for the curated file |
| `scripts/build-free-models.mjs` | Build script (used by Action + local testing) |
| `.github/workflows/update-free-models.yml` | GitHub Action workflow |

## Env (optional)

- `ZEN_API_KEY` — key for headless/CI use (skips `/login`)
- `ZEN_BASE_URL` — override the endpoint (default `https://opencode.ai/zen/v1`)
- `PI_CODING_AGENT_DIR` — alternate pi config dir

## Local testing

```bash
# Build free-models.json locally (dry run)
node scripts/build-free-models.mjs --dry-run --pretty

# Build and write to repo root
node scripts/build-free-models.mjs --pretty
```

## License

MIT
