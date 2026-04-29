/**
 * Tiny ANSI styling + logo banner.
 *
 * No deps (chalk would pull in ~100KB for what amounts to 12 escape codes).
 * Auto-disables color when stderr isn't a TTY (so the launchd log file
 * doesn't get filled with garbage like `[1m` everywhere).
 */

const isTty = !!process.stderr.isTTY && !process.env.NO_COLOR;

function wrap(open: string, close: string) {
  return (s: string) => (isTty ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  bold:    wrap("1",  "22"),
  dim:     wrap("2",  "22"),
  red:     wrap("31", "39"),
  green:   wrap("32", "39"),
  yellow:  wrap("33", "39"),
  blue:    wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan:    wrap("36", "39"),
  gray:    wrap("90", "39"),
};

/**
 * OMA bracket-feather lockup, mirroring the web/Console SVG mark
 * (apps/console/public/logo.svg — `[ ' ]` with a diagonal feather inside
 * the left bracket). Five lines of box-drawing + half-blocks so it
 * renders at consistent width across most terminal fonts.
 *
 * Exported so other commands can reuse the exact same banner — single
 * source of truth for "what does oma bridge look like at startup".
 */
export function logo(): string {
  const lines = [
    "  ┌──┐    ▟   ┌──┐",
    "  │  │   ▟▘   │  │",
    "  │  │  ▟▘    │  │",
    "  │  │ ▟▘     │  │",
    "  └──┘        └──┘",
  ];
  return lines.map((l) => c.cyan(c.bold(l))).join("\n");
}

/** "oma bridge — <subtitle>" header line, used right after the logo. */
export function header(subtitle: string, version: string): string {
  return `${c.bold("oma bridge")}  ${c.dim(`v${version}`)}\n${c.gray(subtitle)}`;
}

/** Print the standard banner (logo + header) once at command start. */
export function printBanner(subtitle: string, version: string): void {
  process.stderr.write(`\n${logo()}\n\n${header(subtitle, version)}\n\n`);
}

export const sym = {
  ok:    () => c.green("✓"),
  warn:  () => c.yellow("!"),
  err:   () => c.red("✗"),
  arrow: () => c.cyan("→"),
  dot:   () => c.gray("·"),
};

/** Stderr writers with the matching prefix symbol. */
export const log = {
  step:  (s: string) => process.stderr.write(`${sym.arrow()} ${s}\n`),
  ok:    (s: string) => process.stderr.write(`${sym.ok()} ${s}\n`),
  warn:  (s: string) => process.stderr.write(`${sym.warn()} ${c.yellow(s)}\n`),
  err:   (s: string) => process.stderr.write(`${sym.err()} ${c.red(s)}\n`),
  hint:  (s: string) => process.stderr.write(`  ${c.gray(s)}\n`),
};
