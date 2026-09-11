import { Hono, type Context } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { MANAGED_AGENTS_BETA, requireBeta } from "../beta";
import { invalidRequest, notFound } from "../errors";
import type { SessionsApplicationPort } from "../ports/sessions";

export interface ManagedSessionOutputView {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

export interface ManagedSessionOutputReadResult {
  body: ConstructorParameters<typeof Response>[0];
  size: number;
  contentType: string;
}

export interface ManagedSessionOutputsStore {
  list(
    workspaceId: string,
    sessionId: string,
  ): Promise<ManagedSessionOutputView[] | null>;
  read(
    workspaceId: string,
    sessionId: string,
    filename: string,
  ): Promise<ManagedSessionOutputReadResult | null>;
}

export interface ManagedSessionOutputsExtension {
  workspaceId(context: Context): string;
  store: ManagedSessionOutputsStore;
}

async function sessionExists(
  source: ApplicationPortSource<SessionsApplicationPort>,
  context: Context,
  sessionId: string,
): Promise<boolean> {
  const result = await resolveApplicationPort(source, context).retrieveSession({
    sessionId,
  });
  return result.type === "found";
}

function isSafeOutputFilename(filename: string): boolean {
  return filename.length > 0 &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.includes("\0");
}

/**
 * OpenMA extension over the official Managed Sessions surface. Outputs are
 * deliberately scoped through the authenticated request workspace and an
 * existing Managed Session; callers cannot use the filesystem/object-store
 * adapter as an unscoped blob browser.
 */
export function buildManagedSessionOutputRoutes(
  sessions: ApplicationPortSource<SessionsApplicationPort>,
  extension: ManagedSessionOutputsExtension,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(MANAGED_AGENTS_BETA));

  app.get("/:sessionId/outputs", async (c) => {
    const sessionId = c.req.param("sessionId");
    if (!await sessionExists(sessions, c, sessionId)) {
      return c.json(notFound(`Session ${sessionId} was not found`), 404);
    }

    const outputs = await extension.store.list(
      extension.workspaceId(c),
      sessionId,
    );
    if (outputs === null) {
      return c.json(notFound("Session outputs are not available"), 404);
    }
    return c.json({ data: outputs, has_more: false }, 200);
  });

  app.get("/:sessionId/outputs/:filename", async (c) => {
    const sessionId = c.req.param("sessionId");
    const filename = c.req.param("filename");
    if (!isSafeOutputFilename(filename)) {
      return c.json(invalidRequest("Invalid session output filename"), 400);
    }
    if (!await sessionExists(sessions, c, sessionId)) {
      return c.json(notFound(`Session ${sessionId} was not found`), 404);
    }

    const output = await extension.store.read(
      extension.workspaceId(c),
      sessionId,
      filename,
    );
    if (output === null) {
      return c.json(notFound(`Session output ${filename} was not found`), 404);
    }
    return new Response(output.body, {
      status: 200,
      headers: {
        "content-length": String(output.size),
        "content-type": output.contentType,
      },
    });
  });

  return app;
}
