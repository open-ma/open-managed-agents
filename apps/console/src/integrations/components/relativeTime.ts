// Format a unix timestamp (ms or seconds) or ISO string into a short
// relative-time string. Used by integrations workspace pages for the
// "Installed 3d ago" line and the activity timeline.
//
// Coarse buckets only — exact second precision would just add noise to a UI
// where "yesterday vs three days ago" is the load-bearing distinction.

export function relativeTime(input: number | string | Date): string {
  const now = Date.now();
  const t = parseTime(input);
  if (t == null) return "—";
  const diff = now - t;
  if (diff < 0) return "just now"; // clock skew or future timestamps
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function parseTime(input: number | string | Date): number | null {
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") {
    // Heuristic: if value looks like seconds (10-digit), promote to ms.
    return input < 1e12 ? input * 1000 : input;
  }
  if (typeof input === "string") {
    const t = Date.parse(input);
    return isNaN(t) ? null : t;
  }
  return null;
}
