/**
 * Initial-circle avatar. Image when present, falls back to a brand-tinted
 * circle with the entity's first letter (uppercase). Used for tenants,
 * users, and bot personas — anywhere a visual id sits next to a name.
 *
 * Sizes follow Tailwind's existing scale, so callers don't have to think
 * about diameters: sm fits in dense rows, md is the default for nav /
 * lists, lg is for headers.
 */
const SIZE: Record<"xs" | "sm" | "md" | "lg", { box: string; text: string }> = {
  xs: { box: "w-5 h-5", text: "text-[10px]" },
  sm: { box: "w-6 h-6", text: "text-[11px]" },
  md: { box: "w-7 h-7", text: "text-[12px]" },
  lg: { box: "w-8 h-8", text: "text-[13px]" },
};

interface AvatarProps {
  /** Display name; first character is used for the fallback initial. */
  name: string;
  /** Optional image url (e.g. persona avatar from an integration). */
  src?: string | null;
  size?: keyof typeof SIZE;
  /** Use rounded-md (square-ish) instead of rounded-full. Tenant avatars
   *  use this so they read as "workspace" not "person". */
  squared?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = "md", squared, className = "" }: AvatarProps) {
  const s = SIZE[size];
  const initial = (name?.trim().charAt(0) || "?").toUpperCase();
  const shape = squared ? "rounded-md" : "rounded-full";
  const base = `${s.box} ${shape} shrink-0`;

  if (src) {
    // Defensive: hide the broken-image icon if the URL 404s. Persona
    // avatars come from third-party integrations where stale CDN URLs
    // are common.
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className={`${base} ${className}`.trim()}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className={`${base} bg-brand-subtle text-brand flex items-center justify-center ${s.text} font-mono font-bold ${className}`.trim()}
    >
      {initial}
    </div>
  );
}
