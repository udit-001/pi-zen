# pi-zen

Registers [OpenCode Zen](https://opencode.ai/zen) as a model provider in [pi](https://github.com/earendil-works/pi-coding-agent), exposing **only the free models**.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

## Setup

1. Get an API key at <https://opencode.ai/zen> (sign in → add billing → copy key).
2. Export it:
   ```bash
   export ZEN_API_KEY="oc_..."
   ```
3. Run `/zen` in pi to pick a free model, or `/model opencode-zen/big-pickle`.

## Commands

| Command | Action |
| --- | --- |
| `/zen` | Pick a free model and switch to it |
| `/zen refresh` | Re-fetch the live model list |
| `/zen status` | Show model count + API-key state |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ZEN_API_KEY` | Zen API key (aliases: `OPENCODE_API_KEY`, `OPENCODE_ZEN_API_KEY`) |
| `ZEN_BASE_URL` | Override gateway base URL (default `https://opencode.ai/zen/v1`) |
| `OPENCODE_ZEN_DEFAULT_MODEL` | Auto-select this model on startup (e.g. `big-pickle`) |
