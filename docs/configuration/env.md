---
title: Environment (.env)
---

# Environment (.env)

Secrets live in `~/.dotclaw/.env`. Only set secrets here; non-secret runtime settings go in `~/.dotclaw/config/runtime.json`.

::: tip File Location
The `.env` file must be placed at `~/.dotclaw/.env` (or `$DOTCLAW_HOME/.env` if you've customized the home directory).
:::

## Required

- `OPENROUTER_API_KEY`
- at least one provider token:
  - `TELEGRAM_BOT_TOKEN`, or
  - `DISCORD_BOT_TOKEN`

## Optional

- `BRAVE_SEARCH_API_KEY` (enables WebSearch)
- `TZ` (override host timezone; affects scheduler timing and agent timestamp interpretation)
- `GH_TOKEN` (enables `gh` usage in agent containers)

Container-only env overrides (for example `DOTCLAW_VISION_MODEL` or `OPENAI_API_KEY`) should be set per group in `~/.dotclaw/data/registered_groups.json` under `containerConfig.env`.

`DOTCLAW_HOME` is a process-level environment variable and should be set in your shell or service unit, not in `.env`.

## Example

```bash
TELEGRAM_BOT_TOKEN=123456789:replace-with-real-token
OPENROUTER_API_KEY=sk-or-replace-with-real-key
DISCORD_BOT_TOKEN=replace-with-discord-token
BRAVE_SEARCH_API_KEY=replace-with-brave-key
GH_TOKEN=ghp_your_token
```

## Non-interactive setup variables

These are read by `npm run bootstrap` and `npm run configure` when running non-interactively:

- `DOTCLAW_BOOTSTRAP_NONINTERACTIVE=1`
- `DOTCLAW_CONFIGURE_NONINTERACTIVE=1`
- `DOTCLAW_BOOTSTRAP_PROVIDER` — `telegram` or `discord` (auto-detected if omitted)
- `DOTCLAW_BOOTSTRAP_CHAT_ID`
- `DOTCLAW_BOOTSTRAP_GROUP_NAME`
- `DOTCLAW_BOOTSTRAP_GROUP_FOLDER`
- `DOTCLAW_BOOTSTRAP_BUILD`
- `DOTCLAW_BOOTSTRAP_SELF_CHECK`
- `DOTCLAW_CONFIGURE_CHAT_ID` (used when migrating registered groups between providers in non-interactive `configure`)
