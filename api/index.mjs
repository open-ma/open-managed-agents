let handler;

async function loadHandler() {
  return handler ??= import("../apps/main-vercel/dist/api.mjs")
    .then((module) => module.default);
}

// The build step bundles all TypeScript-exporting OpenMA workspaces into the
// generated module. Keep this repository-root entry tiny so Vercel discovers
// one Function and can trace the remaining platform dependencies normally.
export default {
  async fetch(request) {
    try {
      return await (await loadHandler()).fetch(request);
    } catch (error) {
      console.error("[openma:vercel-bootstrap]", error);
      const code = error !== null && typeof error === "object" && "code" in error
        && typeof error.code === "string"
        ? error.code
        : "BOOTSTRAP_FAILED";
      return Response.json(
        { error: "openma_bootstrap_failed", code },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  },
};
