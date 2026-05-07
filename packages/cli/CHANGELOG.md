# @openma/cli

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
