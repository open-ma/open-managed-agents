import type {
  EnvironmentWorkWakeupPort,
  NotifyEnvironmentWorkRunStarted,
} from "@open-managed-agents/managed-agents-application";
import { Webhook } from "standardwebhooks";

export interface StandardWebhookEnvironmentWorkWakeupOptions {
  endpoint: string;
  signingKey: string;
  organizationId:
    | string
    | ((input: { workspaceId: string }) => string);
  nextEventId(): string;
  now?: () => Date;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
}

function retryable(status: number): boolean {
  // Anthropic disables a webhook endpoint immediately on a redirect. Every
  // other non-2xx response consumes the normal three-attempt retry budget.
  return status < 300 || status >= 400;
}

/**
 * Emits the official `session.status_run_started` payload and Standard
 * Webhooks headers. Delivery is a wake hint only; durable recovery is polling.
 */
export class StandardWebhookEnvironmentWorkWakeup
  implements EnvironmentWorkWakeupPort
{
  private readonly endpoint: string;
  private readonly webhook: Webhook;
  private readonly now: () => Date;
  private readonly send: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;

  constructor(
    private readonly options: StandardWebhookEnvironmentWorkWakeupOptions,
  ) {
    this.endpoint = new URL(options.endpoint).toString();
    this.webhook = new Webhook(options.signingKey);
    this.now = options.now ?? (() => new Date());
    this.send = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
  }

  async notifyRunStarted(
    input: NotifyEnvironmentWorkRunStarted,
  ): Promise<void> {
    const eventId = this.options.nextEventId();
    const body = JSON.stringify({
      type: "event",
      id: eventId,
      created_at: input.occurredAt,
      data: {
        type: "session.status_run_started",
        id: input.sessionId,
        organization_id: typeof this.options.organizationId === "string"
          ? this.options.organizationId
          : this.options.organizationId({ workspaceId: input.workspaceId }),
        workspace_id: input.workspaceId,
      },
    });
    let lastFailure: unknown = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      // The event identity/body is stable across retries, while each delivery
      // gets a fresh timestamp and signature so SDK freshness validation keeps
      // working after backoff.
      const timestamp = this.now();
      const timestampSeconds = String(Math.floor(timestamp.getTime() / 1_000));
      const signature = this.webhook.sign(eventId, timestamp, body);
      let response: Response | null = null;
      try {
        response = await this.send(this.endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "webhook-id": eventId,
            "webhook-timestamp": timestampSeconds,
            "webhook-signature": signature,
          },
          body,
        });
      } catch (error) {
        lastFailure = error;
      }
      if (response?.ok) return;
      if (response !== null) {
        lastFailure = new Error(`Managed Agents webhook returned HTTP ${response.status}`);
        if (!retryable(response.status)) throw lastFailure;
      }
      if (attempt < this.maxAttempts) {
        const exponential = 5_000 * 2 ** (attempt - 1);
        const jittered = Math.floor(exponential * (0.5 + this.random()));
        await this.sleep(Math.min(120_000, Math.max(5_000, jittered)));
      }
    }
    throw lastFailure instanceof Error
      ? lastFailure
      : new Error("Managed Agents webhook delivery failed");
  }
}
