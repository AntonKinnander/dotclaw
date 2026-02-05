---
title: launchd (macOS)
---

# launchd (macOS)

The repo includes `launchd/com.dotclaw.plist`.

## Setup

```bash
cp launchd/com.dotclaw.plist ~/Library/LaunchAgents/
```

Edit the plist to set:

- `{{NODE_PATH}}`
- `{{PROJECT_ROOT}}`
- `{{HOME}}`
- `{{DOTCLAW_HOME}}`

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

Logs are written to `~/.dotclaw/logs/` by default.

## Multiple instances

To run multiple DotClaw instances on the same machine:

1. Use a different `DOTCLAW_HOME` for each instance.
2. Set `host.container.instanceId` in `~/.dotclaw/config/runtime.json` so daemon container names don't collide.
3. Use a distinct launchd label (e.g. `com.dotclaw.alt`) for the second plist.

Example (instance B):

```bash
DOTCLAW_HOME=~/.dotclaw-alt dotclaw start --foreground
```

Or use the CLI to create and start a new instance automatically:

```bash
dotclaw add-instance alt
```

You can also target instance-specific actions:

```bash
dotclaw status --id alt
dotclaw restart --all
```

List discovered instances:

```bash
dotclaw instances
```

## Using the CLI

The recommended approach is to use the CLI which handles template substitution automatically:

```bash
dotclaw install-service
dotclaw start
```
