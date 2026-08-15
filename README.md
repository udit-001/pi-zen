# pi-zen

Registers [OpenCode Zen](https://opencode.ai/zen) as a model provider in [pi](https://github.com/earendil-works/pi-coding-agent), exposing **only the free models**.

## Install

```bash
pi install git:github.com/udit-001/pi-zen
```

## Use

1. Get an API key at <https://opencode.ai/zen> (sign in → add billing → copy key).
2. Enter it in pi: `/login pi-zen`. Pi stores it in `~/.pi/agent/auth.json` — no env var needed.
3. Open `/model` and pick a `pi-zen/*` model.

No custom commands — pi's built-ins (`/model`, `/login`) cover everything.

## Env (optional)

- `ZEN_API_KEY` — key for headless/CI use (skips `/login`)
- `ZEN_BASE_URL` — override the endpoint (default `https://opencode.ai/zen/v1`)

## License

MIT
