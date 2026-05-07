---
"@openma/cli": minor
---

Bridge: expand local ACP agent support to the full official registry,
add cross-platform service install (launchd / systemd / Task Scheduler,
all no-admin), and wire end-to-end conversation recovery so daemon
restarts no longer drop context. `oma bridge setup` is now the single
command on every platform — installs the system service, starts the
daemon, and audits + offers ACP wrappers for install (npm packages or
GitHub release tarballs). Includes `OMA_PROFILE` for prod/staging
side-by-side daemons (default behavior unchanged for current users).

Fixes a multi-profile bug where the launchd-spawned daemon silently
dropped `OMA_PROFILE` and read the default profile's credentials,
causing the "wrong" daemon to compete for the WS attach slot.

