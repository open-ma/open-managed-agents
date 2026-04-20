// Linear webhook payload shapes — typed from Linear's documented schema with
// only the fields we consume. Keep narrow: extracting more later is cheap,
// pretending we know fields we don't is expensive.
//
// Reference: https://linear.app/developers/webhooks
//            https://linear.app/developers/agent-interaction

/**
 * Top-level webhook envelope. Linear sends this for every event; our parser
 * narrows by `type` + `action`.
 */
export interface RawWebhookEnvelope {
  type: string;
  action?: string;
  /** Linear's per-delivery uuid; doubles as our idempotency key. */
  webhookId?: string;
  /** Best-effort delivery timestamp; we use server-side `received_at` instead. */
  createdAt?: string;
  /** Workspace id at top level on most event shapes. */
  organizationId?: string;
  /** Some payloads put the org under `data`; check both. */
  data?: Record<string, unknown>;
  /** Notification body for AppUserNotification events. */
  notification?: Record<string, unknown>;
}

/** Notification subtypes we route on. Linear emits more — ignore unknowns. */
export type NotificationKind =
  | "issueAssignedToYou"
  | "issueMention"
  | "issueCommentMention"
  | "issueNewComment";

/**
 * Normalized event consumed by the router and handler. One per dispatched
 * webhook. `kind` is null for events we receive but don't act on.
 */
export interface NormalizedWebhookEvent {
  kind: NotificationKind | null;
  workspaceId: string;
  /** Linear issue id if the event references one. */
  issueId: string | null;
  /** Issue identifier like "ENG-142", surfaced for human-readable logs. */
  issueIdentifier: string | null;
  /** Plain-text issue title (best-effort). */
  issueTitle: string | null;
  /** Plain-text issue description, may be empty. */
  issueDescription: string | null;
  /** Comment body for comment-mention events. */
  commentBody: string | null;
  /** Linear comment id, if applicable. */
  commentId: string | null;
  /** Issue label keys (lowercased name) for routing. */
  labels: ReadonlyArray<string>;
  /** Linear user id of the actor (the human who triggered this). */
  actorUserId: string | null;
  actorUserName: string | null;
  /** Echo of the raw `webhookId` for idempotency. */
  deliveryId: string;
  /** Echo of the raw event type for logging. */
  eventType: string;
}

/** Parses Linear's raw webhook into our normalized shape. Pure function. */
export function parseWebhook(raw: RawWebhookEnvelope): NormalizedWebhookEvent | null {
  const deliveryId = raw.webhookId ?? "";
  if (!deliveryId) return null; // unsignable / undeduplicatable; drop

  const eventType = raw.type ?? "";
  const action = raw.action ?? "";

  // Handle AppUserNotification (the primary trigger for B+).
  if (eventType === "AppUserNotification") {
    return parseAppUserNotification(raw, deliveryId, eventType, action);
  }

  // Handle Issue/Comment shape webhooks (used by A1 in Phase 11).
  // For now, return null — they're recorded for idempotency but not dispatched.
  return {
    kind: null,
    workspaceId: raw.organizationId ?? "",
    issueId: null,
    issueIdentifier: null,
    issueTitle: null,
    issueDescription: null,
    commentBody: null,
    commentId: null,
    labels: [],
    actorUserId: null,
    actorUserName: null,
    deliveryId,
    eventType,
  };
}

function parseAppUserNotification(
  raw: RawWebhookEnvelope,
  deliveryId: string,
  eventType: string,
  action: string,
): NormalizedWebhookEvent | null {
  const notif = raw.notification ?? raw.data ?? {};
  const issue = pickObject(notif, "issue") ?? {};
  const comment = pickObject(notif, "comment");
  const actor = pickObject(notif, "actor");

  // Map Linear's notification subtype → our routing kind.
  const subtype = pickString(notif, "type") ?? action;
  const kind = mapNotificationKind(subtype);

  const issueId = pickString(issue, "id");
  const workspaceId =
    raw.organizationId ?? pickString(issue, "organizationId") ?? "";

  const labelObjects = (issue.labels as { nodes?: unknown[] } | undefined)?.nodes;
  const labels = Array.isArray(labelObjects)
    ? labelObjects
        .map((n) => (n as { name?: string }).name?.toLowerCase())
        .filter((n): n is string => typeof n === "string")
    : [];

  return {
    kind,
    workspaceId,
    issueId: issueId ?? null,
    issueIdentifier: pickString(issue, "identifier"),
    issueTitle: pickString(issue, "title"),
    issueDescription: pickString(issue, "description"),
    commentBody: comment ? pickString(comment, "body") : null,
    commentId: comment ? pickString(comment, "id") : null,
    labels,
    actorUserId: actor ? pickString(actor, "id") : null,
    actorUserName: actor ? pickString(actor, "name") : null,
    deliveryId,
    eventType,
  };
}

function mapNotificationKind(subtype: string): NotificationKind | null {
  switch (subtype) {
    case "issueAssignedToYou":
    case "issueMention":
    case "issueCommentMention":
    case "issueNewComment":
      return subtype;
    default:
      return null;
  }
}

function pickObject(o: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = o[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickString(o: Record<string, unknown>, key: string): string | null {
  const value = o[key];
  return typeof value === "string" ? value : null;
}
