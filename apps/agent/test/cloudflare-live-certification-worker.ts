import { CloudflareSandbox } from "../src/runtime/sandbox";
import { getSandbox, type Sandbox as CloudflareSandboxClass } from "@cloudflare/sandbox";
import { ContainerProxy } from "@cloudflare/containers";
import { OmaSandbox } from "../src/oma-sandbox";

export { ContainerProxy };

interface CertificationProxyParams {
  fence: string;
}

const certificationEgress = async (
  request: Request,
  env: unknown,
  context: { params: CertificationProxyParams },
): Promise<Response> => Response.json({
  handled_outside_sandbox: true,
  worker_secret_available: Boolean((env as CertificationEnv).CERTIFICATION_PROXY_SECRET),
  sandbox_sent_authorization: request.headers.has("authorization"),
  fence: context.params.fence,
});

const certificationDeny = async (): Promise<Response> => new Response("revoked", { status: 403 });

export class Sandbox extends OmaSandbox {}

const inheritedHandlers = (OmaSandbox as unknown as {
  outboundHandlers: Record<string, typeof certificationEgress>;
}).outboundHandlers;
(Sandbox as unknown as {
  outboundHandlers: Record<string, typeof certificationEgress>;
}).outboundHandlers = {
  ...inheritedHandlers,
  certification_egress: certificationEgress,
  certification_deny: certificationDeny,
};

interface CertificationEnv {
  SANDBOX: DurableObjectNamespace<CloudflareSandboxClass>;
  CERTIFICATION_NONCE: string;
  CERTIFICATION_PROXY_SECRET: string;
  BACKUP_BUCKET?: R2Bucket;
  R2_ENDPOINT?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

interface CertificationRequest {
  action?: "create" | "read" | "renew_lease" | "checkpoint" | "restore" | "attach_proxy" | "proxy" | "revoke_proxy" | "destroy" | "verify_destroyed";
  sandbox_id?: string;
  checkpoint?: import("@open-managed-agents/sandbox").SandboxCheckpointHandle;
}

const MARKER_PATH = "/workspace/openma-cloudflare-certification.txt";
const SAFE_SANDBOX_ID = /^oma-cert-[a-z0-9-]{1,80}$/;

export default {
  async fetch(request: Request, env: CertificationEnv): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    if (request.headers.get("authorization") !== `Bearer ${env.CERTIFICATION_NONCE}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await request.json<CertificationRequest>();
    if (!body.action || !body.sandbox_id || !SAFE_SANDBOX_ID.test(body.sandbox_id)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const sandbox = new CloudflareSandbox(env as never, body.sandbox_id);
    const marker = `${body.sandbox_id}:persisted`;

    try {
      await sandbox.setOutboundContext({
        tenantId: "certification",
        environmentId: "certification",
        sessionId: body.sandbox_id,
        workId: "certification",
        ownerId: "certification",
        generation: 1,
        fenceToken: "certification-fence",
        required: false,
      });
      if (body.action === "create") {
        await sandbox.writeFile(MARKER_PATH, marker);
        const command = await sandbox.exec(`cat ${MARKER_PATH}`);
        return Response.json({ action: body.action, marker, command });
      }
      if (body.action === "read") {
        const content = await sandbox.readFile(MARKER_PATH);
        const command = await sandbox.exec(`cat ${MARKER_PATH}`);
        return Response.json({ action: body.action, content, command });
      }
      if (body.action === "renew_lease") {
        await sandbox.renewLease({ ttlMs: 90_000 });
        return Response.json({ action: body.action, renewed: true });
      }
      if (body.action === "checkpoint") {
        const checkpoint = await sandbox.checkpoint({
          kind: "filesystem",
          name: `${body.sandbox_id}-checkpoint`,
        });
        return Response.json({ action: body.action, checkpoint });
      }
      if (body.action === "restore") {
        if (!body.checkpoint) {
          return Response.json({ error: "checkpoint_required" }, { status: 400 });
        }
        await sandbox.resume(body.checkpoint);
        return Response.json({
          action: body.action,
          restored: true,
          content: await sandbox.readFile(MARKER_PATH),
        });
      }
      if (body.action === "attach_proxy") {
        const native = getSandbox(env.SANDBOX, body.sandbox_id);
        await native.setOutboundByHost(
          "certification.openma.internal",
          "certification_egress",
          { fence: "generation-1" },
        );
        return Response.json({ action: body.action, attached: true });
      }
      if (body.action === "proxy") {
        const processEnvironment = await sandbox.exec(
          'test -z "$CERTIFICATION_PROXY_SECRET" && echo secret-not-in-process',
        );
        const proxyResponse = await sandbox.exec(
          "curl -sS -w '\\n%{http_code}' http://certification.openma.internal/probe",
        );
        return Response.json({ action: body.action, processEnvironment, proxyResponse });
      }
      if (body.action === "revoke_proxy") {
        await sandbox.revokeOutboundContext({
          workId: "certification",
          generation: 1,
          reason: "lease_lost",
        });
        const native = getSandbox(env.SANDBOX, body.sandbox_id);
        await native.setOutboundByHost(
          "certification.openma.internal",
          "certification_deny",
          { fence: "generation-2" },
        );
        const proxyResponse = await sandbox.exec(
          "curl -sS -w '\\n%{http_code}' http://certification.openma.internal/probe",
        );
        return Response.json({ action: body.action, proxyResponse });
      }
      if (body.action === "destroy") {
        await sandbox.destroy();
        return Response.json({ action: body.action, destroyed: true });
      }

      let missing = false;
      try {
        await sandbox.readFile(MARKER_PATH);
      } catch {
        missing = true;
      } finally {
        await sandbox.destroy();
      }
      return Response.json({ action: body.action, missing });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
