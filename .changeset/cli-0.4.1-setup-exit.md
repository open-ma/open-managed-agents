---
"@openma/cli": patch
---

`oma bridge setup` now exits cleanly after "Done." instead of hanging
for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
fetch and the runtime-token probe. Daemon was already started by
launchd / systemd / Task Scheduler — only the foreground setup process
itself was waiting on the undici dispatcher to time out its sockets.
Force-exits at end of runSetup, matching how npm / pnpm / gh handle
the same constraint in their CLI commands.

Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
handles + requests every 2s — useful for diagnosing future "process
won't exit" regressions without redeploying.
