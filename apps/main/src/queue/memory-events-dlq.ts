// DLQ consumer for the memory-events queue. Receives messages that
// exhausted the main consumer's retries (max_retries=5) — almost always
// because:
//
//   - downstream D1 was unavailable for the full retry window
//   - R2 GET 404'd because the object was deleted between event and read
//   - the consumer code has a bug that throws on a specific key shape
//
// The original message body is the same R2EventMessage shape; the only
// thing different is the delivery path. We MUST always ack here — there's
// no DLQ-of-DLQ in CF Queues, and a thrown handler would re-deliver
// indefinitely until message expiry (4 days), holding queue resources.
//
// What we do per message:
//   1. logError with the raw body so it's recoverable from Workers Logs
//   2. recordEvent to Analytics Engine — `op: "queue.dlq.memory_events"`
//      so dashboards / alerts can count occurrences over time without
//      grepping logs
//   3. Best-effort POST to OPS_WEBHOOK_URL secret (Slack-incoming-webhook
//      shape) — no-op when the secret isn't set, so dev / pre-rollout
//      doesn't need any extra config to deploy
//   4. ack — even on internal handler exception, never throw
//
// Why we don't try to "retry" or "replay" here: replaying a stuck message
// just loops it through the same broken consumer. Replay is a manual ops
// action — see docs/runbooks/memory-dlq-replay.md (TBD). This handler's
// job is to ensure the message stops being silent.

import {
  errFields,
  log,
  logError,
  recordEvent,
  type Env,
  type R2EventMessage,
} from "@open-managed-agents/shared";

export async function handleMemoryEventsDlq(
  batch: MessageBatch<R2EventMessage>,
  env: Env,
): Promise<void> {
  log(
    { op: "queue.dlq.memory_events", batch_size: batch.messages.length },
    "memory-events DLQ batch received",
  );

  for (const msg of batch.messages) {
    try {
      const body = msg.body;
      const action = (body as { action?: string })?.action ?? "(no action)";
      const key = (body as { object?: { key?: string } })?.object?.key ?? "(no key)";

      logError(
        {
          op: "queue.dlq.memory_events.message",
          message_id: msg.id,
          attempts: msg.attempts,
          r2_action: action,
          r2_key: key,
          body,
        },
        "memory event reached DLQ — main consumer failed past retry limit",
      );

      recordEvent(env.ANALYTICS, {
        op: "queue.dlq.memory_events",
        // R2 key is `<store_id>/<path>` so the leading segment is the
        // store id; surface it in the AE blob for grouping queries.
        tenant_id: storeIdFromKey(key),
        error_name: "DLQReached",
        error_message: `${action} ${key} attempts=${msg.attempts}`,
      });

      await maybeNotify(env, {
        action,
        key,
        attempts: msg.attempts,
        message_id: msg.id,
      });
    } catch (err) {
      // The DLQ handler itself failed. Don't re-throw — that would loop
      // the message until expiry. Log and move on; AE alert on
      // "queue.dlq.memory_events.handler_failed" if you ever see this.
      logError(
        {
          op: "queue.dlq.memory_events.handler_failed",
          message_id: msg.id,
          ...errFields(err),
        },
        "DLQ handler threw — swallowing to keep DLQ draining",
      );
    } finally {
      msg.ack();
    }
  }
}

/** Extract the store_id segment from an R2 key shaped `<store_id>/<path>`.
 *  Returns "" on malformed keys — caller treats as "unknown store". */
function storeIdFromKey(key: string): string {
  const i = key.indexOf("/");
  if (i <= 0) return "";
  return key.slice(0, i);
}

interface DlqAlert {
  action: string;
  key: string;
  attempts: number;
  message_id: string;
}

/**
 * POST to OPS_WEBHOOK_URL if configured. Compatible with Slack incoming
 * webhooks (the `text` field renders as a message). Other webhook receivers
 * that accept a JSON body with `text` (Discord, Mattermost) work too.
 *
 * Failures are swallowed — webhook downtime must not block ack of the
 * underlying DLQ message.
 */
async function maybeNotify(env: Env, alert: DlqAlert): Promise<void> {
  const url = (env as unknown as { OPS_WEBHOOK_URL?: string }).OPS_WEBHOOK_URL;
  if (!url) return;
  const text =
    `:warning: memory-events DLQ\n` +
    `action=\`${alert.action}\`\n` +
    `key=\`${alert.key}\`\n` +
    `attempts=${alert.attempts}\n` +
    `message_id=\`${alert.message_id}\``;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      // Don't logError — webhook quirks happen (rate limits, transient
      // 5xxs); just a warn so we know if it's persistent.
      log(
        {
          op: "queue.dlq.memory_events.notify_non_ok",
          status: res.status,
        },
        "ops webhook returned non-OK; alert not delivered",
      );
    }
  } catch (err) {
    log(
      {
        op: "queue.dlq.memory_events.notify_failed",
        ...errFields(err),
      },
      "ops webhook fetch threw; alert not delivered",
    );
  }
}
