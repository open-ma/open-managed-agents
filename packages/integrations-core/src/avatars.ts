// Built-in avatars for integration personas. Files live at
// apps/console/public/integration-avatars/ and are served by apps/main's
// ASSETS binding from `https://openma.dev/integration-avatars/<file>.png`.
//
// `id` is a stable positional slug matching the filename — safe to persist
// in DB rows or external configs. `label` is a human-readable description
// shown in pickers; rename freely without invalidating stored ids.
//
// All URL construction goes through `getIntegrationAvatarUrl` /
// `isIntegrationAvatarUrl`. To migrate to R2 later, change AVATAR_BASE_URL
// in one place; nothing else needs to know.

export interface IntegrationAvatar {
  id: string;
  label: string;
  url: string;
}

const AVATAR_BASE_URL = "https://openma.dev/integration-avatars";

export function getIntegrationAvatarUrl(id: string): string {
  return `${AVATAR_BASE_URL}/avatar_${id}.png`;
}

export function isIntegrationAvatarUrl(url: string): boolean {
  return url.startsWith(`${AVATAR_BASE_URL}/avatar_`) && url.endsWith(".png");
}

const entries: ReadonlyArray<readonly [string, string]> = [
  ["1_01", "Blank"],
  ["1_02", "Red"],
  ["1_03", "Noir"],
  ["1_04", "Blush"],
  ["1_05", "Wink"],
  ["2_01", "Balloon"],
  ["2_02", "Sleepy Mint"],
  ["2_03", "Sparkle"],
  ["2_04", "Glasses"],
  ["2_05", "Headphones"],
  ["3_01", "Mustache"],
  ["3_02", "Bow"],
  ["3_03", "Sleepy Zzz"],
  ["3_04", "Detective"],
  ["3_05", "Beret"],
  ["4_01", "Wink Navy"],
  ["4_02", "Motion"],
  ["4_03", "Neon"],
  ["4_04", "Ocean"],
  ["4_05", "Party"],
  ["5_01", "Sparkles"],
  ["5_02", "Dots"],
  ["5_03", "Cloud"],
  ["5_04", "Heart"],
  ["5_05", "Night"],
] as const;

export const INTEGRATION_AVATARS: ReadonlyArray<IntegrationAvatar> = entries.map(
  ([id, label]) => ({ id, label, url: getIntegrationAvatarUrl(id) }),
);

export const DEFAULT_INTEGRATION_AVATAR: IntegrationAvatar = INTEGRATION_AVATARS[0]!;

const byId = new Map(INTEGRATION_AVATARS.map((a) => [a.id, a]));

export function getIntegrationAvatar(id: string): IntegrationAvatar | undefined {
  return byId.get(id);
}

