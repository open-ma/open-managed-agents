/**
 * R2 key scheme for file storage.
 *
 * Single bucket (FILES_BUCKET), tenant isolation by key prefix.
 * Used by:
 * - apps/main/src/routes/files.ts        (upload/download/delete)
 * - apps/main/src/routes/sessions.ts     (file_id resolver in events POST,
 *                                         scoped-copy in createSession resources)
 * - apps/agent/src/runtime/resource-mounter.ts (mount file_id to sandbox FS)
 */
export function fileR2Key(tenantId: string, fileId: string): string {
  return `t/${tenantId}/files/${fileId}`;
}

/**
 * R2 key for a single file inside a custom skill version.
 * One R2 object per skill file — keeps individual file size bounded and lets
 * us stream them into the sandbox without loading the whole bundle.
 */
export function skillFileR2Key(
  tenantId: string,
  skillId: string,
  version: string,
  filename: string,
): string {
  return `t/${tenantId}/skills/${skillId}/${version}/${filename}`;
}
