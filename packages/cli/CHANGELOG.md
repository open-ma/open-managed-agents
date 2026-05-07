# @openma/cli

## 0.4.1

### Patch Changes

- [#41](https://github.com/open-ma/open-managed-agents/pull/41) [`e370a4a`](https://github.com/open-ma/open-managed-agents/commit/e370a4ab550ca18a37e27761695fb9bbd2e8bdb7) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge setup` now exits cleanly after "Done." instead of hanging
  for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
  fetch and the runtime-token probe. Daemon was already started by
  launchd / systemd / Task Scheduler — only the foreground setup process
  itself was waiting on the undici dispatcher to time out its sockets.
  Force-exits at end of runSetup, matching how npm / pnpm / gh handle
  the same constraint in their CLI commands.

  Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
  handles + requests every 2s — useful for diagnosing future "process
  won't exit" regressions without redeploying.

## 0.4.0

### Minor Changes

- [`4df9a0e`](https://github.com/open-ma/open-managed-agents/commit/4df9a0e677eb1712688134fc140edb6d0db3969a) Thanks [@hrhrng](https://github.com/hrhrng)! - Bridge: expand local ACP agent support to the full official registry,
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

## 0.3.2

### Patch Changes

- [`018b647`](https://github.com/open-ma/open-managed-agents/commit/018b647536eb5d1398510fcc37f6c65447a801fd) Thanks [@hrhrng](https://github.com/hrhrng)! - Add Bridge subcommand section to top-level `oma` help so `setup`, `daemon`,
  `status`, `uninstall` are discoverable without grepping or guessing.
