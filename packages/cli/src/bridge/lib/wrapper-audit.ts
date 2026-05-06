/**
 * Audit ACP-relevant agents the user has on this machine, then offer to
 * install whatever's missing. Shared between
 * `oma bridge setup` (first-run flow) and
 * `oma bridge agents refresh` (later, run on demand).
 *
 * The view shows three buckets:
 *   1. **Built-in ACP** — agents the user has installed that ship with
 *      ACP themselves (gemini, hermes, opencode, openclaw, …). Already
 *      detected, no action needed; rendered as info-only entries so
 *      the user knows OMA sees them.
 *   2. **Wrapped, ready** — wrappers that are already installed AND
 *      whose upstream binary the user has (claude-acp + claude). Also
 *      info-only.
 *   3. **Wrapped, missing** — overlay-marked `wraps:` entries where the
 *      upstream binary is on PATH but the wrapper isn't. Selectable in
 *      the multi-select prompt. npm-distributed wrappers install via
 *      `npm i -g`; binary-distributed (e.g. codex-acp from Zed
 *      releases) are shown but disabled — the user has to grab the
 *      tarball themselves.
 *
 * UX: single multi-select TUI prompt (space toggles, enter confirms)
 * via @inquirer/checkbox. Non-TTY contexts (CI, scripts redirecting
 * stdin) print the audit but skip the prompt. `yes` auto-installs all
 * npm-distributed wrappers.
 */

import { spawn } from "node:child_process";
import checkbox, { Separator } from "@inquirer/checkbox";
import { detectAll, getKnownAgents, type KnownAgentEntry } from "@open-managed-agents/acp-runtime/registry";
import { log, c } from "./style.js";

export interface AuditOptions {
  /** Skip prompts; install all offerable npm wrappers. */
  yes?: boolean;
  /** Print the audit and exit without prompting/installing. */
  dryRun?: boolean;
}

interface AuditRow {
  id: string;
  label: string;
  /** Where the agent comes from in the manifest model. */
  status:
    | { kind: "builtin-detected" }                                // agent has built-in ACP, on PATH
    | { kind: "wrapper-detected"; wraps: string }                 // wrapper installed + upstream present
    | { kind: "wrapper-needs-install"; wraps: string;
        install: NonNullable<KnownAgentEntry["install"]> };       // upstream present, wrapper missing
}

/**
 * Run the audit. Returns the (possibly updated) list of detected
 * agents — caller can pass this back to whatever displays the manifest
 * so the post-install state is reflected without an extra detectAll
 * call.
 */
export async function auditAndOfferWrappers(
  initialAgents: Array<{ id: string }>,
  opts: AuditOptions = {},
): Promise<Array<{ id: string; binary?: string }>> {
  let agents: Array<{ id: string; binary?: string }> = initialAgents.map((a) => ({ id: a.id }));
  const detectedIds = new Set(agents.map((a) => a.id));

  // Build the audit rows. Every entry in the merged registry that is
  // either detected OR has its upstream-binary present gets a row.
  // Anything else (registry agents the user doesn't have at all) is
  // intentionally hidden — that list would be 30+ entries on most
  // machines and contradicts the "show what you have" rule.
  const rows: AuditRow[] = [];
  for (const e of getKnownAgents()) {
    if (detectedIds.has(e.id)) {
      // Detected. Either built-in (no `wraps`) or a wrapper already
      // installed against an upstream the user has.
      if (e.wraps) {
        rows.push({ id: e.id, label: e.label, status: { kind: "wrapper-detected", wraps: e.wraps } });
      } else {
        rows.push({ id: e.id, label: e.label, status: { kind: "builtin-detected" } });
      }
      continue;
    }
    // Not detected. Only interesting if it's a wrapper for an upstream
    // binary the user has — then we can offer to install.
    if (e.wraps && e.install && (await isOnPath(e.wraps))) {
      rows.push({
        id: e.id,
        label: e.label,
        status: { kind: "wrapper-needs-install", wraps: e.wraps, install: e.install },
      });
    }
  }
  if (rows.length === 0) return agents;

  // Dry-run / non-interactive: print the audit and bail.
  const tty = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (opts.dryRun) {
    printAuditPlain(rows);
    return agents;
  }
  if (!tty && !opts.yes) {
    printAuditPlain(rows);
    log.hint("non-interactive context — skipping prompts. Re-run from a terminal to install.");
    return agents;
  }

  // Decide what to install. --yes auto-takes every npm wrapper; TTY
  // shows the multi-select.
  let toInstall: AuditRow[];
  if (opts.yes) {
    toInstall = rows.filter(
      (r) => r.status.kind === "wrapper-needs-install" && r.status.install.kind === "npm",
    );
  } else {
    const choices = buildChoices(rows);
    if (!choices.some((c) => "value" in c && !("disabled" in c && c.disabled))) {
      // No selectable rows — show the audit (informational) and return.
      printAuditPlain(rows);
      log.hint("nothing to install — your ACP agents are already in sync");
      return agents;
    }
    const selected = await checkbox<string>({
      message: "Install ACP wrappers? (space to toggle, enter to confirm)",
      choices,
      pageSize: Math.min(20, choices.length + 2),
      loop: false,
    }).catch(() => [] as string[]);
    toInstall = rows.filter(
      (r) =>
        r.status.kind === "wrapper-needs-install" &&
        r.status.install.kind === "npm" &&
        selected.includes(r.id),
    );
  }

  if (toInstall.length === 0) {
    log.hint("nothing to install");
    return agents;
  }

  let installed = 0;
  for (const r of toInstall) {
    if (r.status.kind !== "wrapper-needs-install" || r.status.install.kind !== "npm") continue;
    log.step(`installing ${r.status.install.package}`);
    const ok = await npmInstallGlobal(r.status.install.package);
    if (ok) {
      log.ok(`${r.id} installed`);
      installed += 1;
    } else {
      log.warn(`install failed — try manually: npm i -g ${r.status.install.package}`);
    }
  }

  if (installed > 0) {
    agents = (await detectAll()).map((a) => ({ id: a.id, binary: a.spec.command }));
  }
  return agents;
}

/**
 * Build the @inquirer/checkbox choices array, grouped via Separator.
 *   Group 1: detected entries (built-in or wrapper) — disabled-info.
 *   Group 2: missing wrappers — selectable (npm) or disabled (binary).
 *
 * checkbox renders Separator lines as plain text dividers and disabled
 * choices as non-interactive lines; only the un-disabled choices
 * contribute to the returned values array.
 */
function buildChoices(rows: AuditRow[]) {
  const detected = rows.filter((r) => r.status.kind !== "wrapper-needs-install");
  const missing = rows.filter((r) => r.status.kind === "wrapper-needs-install");
  const out: Array<
    Separator | { name: string; value: string; checked?: boolean; disabled?: string | boolean }
  > = [];
  if (detected.length) {
    out.push(new Separator(c.dim("─── already detected on this machine ───")));
    for (const r of detected) {
      const tag =
        r.status.kind === "wrapper-detected"
          ? `wrapper for \`${r.status.wraps}\``
          : "built-in ACP";
      out.push({
        name: `${r.id.padEnd(18)}${c.dim(tag)}`,
        value: r.id,
        disabled: " (already installed)",
      });
    }
  }
  if (missing.length) {
    out.push(new Separator(c.dim("─── ACP wrappers available to install ───")));
    for (const r of missing) {
      if (r.status.kind !== "wrapper-needs-install") continue;
      const wrapsLabel = c.dim(`wraps \`${r.status.wraps}\``);
      if (r.status.install.kind === "npm") {
        out.push({
          name: `${r.id.padEnd(18)}${wrapsLabel} ${c.dim(`— npm i -g ${r.status.install.package}`)}`,
          value: r.id,
          checked: false,
        });
      } else {
        out.push({
          name: `${r.id.padEnd(18)}${wrapsLabel} ${c.dim(`— binary; download from ${r.status.install.downloadUrl}`)}`,
          value: r.id,
          disabled: " (manual download required)",
        });
      }
    }
  }
  return out;
}

/** Plain-text audit listing for non-TTY / dry-run paths. */
function printAuditPlain(rows: AuditRow[]): void {
  process.stderr.write("\n");
  log.step(`ACP audit (${rows.length} relevant on this machine):`);
  for (const r of rows) {
    let line: string;
    if (r.status.kind === "builtin-detected") {
      line = `  ${c.green("✓")} ${r.id.padEnd(18)} ${c.dim("built-in ACP")}`;
    } else if (r.status.kind === "wrapper-detected") {
      line = `  ${c.green("✓")} ${r.id.padEnd(18)} ${c.dim(`wrapper for \`${r.status.wraps}\``)}`;
    } else if (r.status.install.kind === "npm") {
      line = `  ${c.yellow("○")} ${r.id.padEnd(18)} ${c.dim(`wraps \`${r.status.wraps}\` — npm i -g ${r.status.install.package}`)}`;
    } else {
      line = `  ${c.yellow("○")} ${r.id.padEnd(18)} ${c.dim(`wraps \`${r.status.wraps}\` — binary, see ${r.status.install.downloadUrl}`)}`;
    }
    process.stderr.write(line + "\n");
  }
}

function isOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const p = spawn(probe, [cmd], { stdio: "ignore" });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
}

function npmInstallGlobal(pkg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("npm", ["install", "-g", pkg], { stdio: "inherit" });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
}
