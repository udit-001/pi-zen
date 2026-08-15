# pi-zen

Registers [OpenCode Zen](https://opencode.ai/zen) as a model provider in [pi](https://github.com/earendil-works/pi-coding-agent), exposing **only the free models**.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

## Setup

1. Get an API key at <https://opencode.ai/zen> (sign in → add billing → copy key).
2. Enter it in pi:
   ```
   /login pi-zen
   ```
   Pi stores the key in `~/.pi/agent/auth.json` (user-only permissions).
   No env var needed. (Alternatively, set `ZEN_API_KEY` in your shell.)
3. Open `/model` in pi and pick a `pi-zen/*` model.

## Commands

No custom commands. pi's built-ins cover everything: `/model` to pick a model, `/login` to manage keys.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ZEN_API_KEY` | Zen API key (fallback to `/login pi-zen`; for headless/CI use) |
| `ZEN_BASE_URL` | Override gateway base URL (default `https://opencode.ai/zen/v1`) |
