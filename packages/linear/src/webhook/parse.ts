// Linear webhook payload shapes — typed from Linear's documented schema with
// only the fields we consume. Keep narrow: extracting more later is cheap,
// pretending we know fields we don't is expensive.
//
// Reference: https://linear.app/developers/webhooks
//            https://linear.app/developers/agent-interaction

/** Top-level webhook envelope. Linear sends this for every event; our parser
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
  /** AgentSessionEvent: the full agent session record (with .issue, .creator, etc.). */
  agentSession?: Record<string, unknown>;
  /** AgentSessionEvent: pre-rendered prompt context (XML, HTML-escaped). */
  promptContext?: string;
}

/** Notification subtypes we route on. Linear emits more — ignore unknowns. */
export type NotificationKind =
  | "issueAssignedToYou"
  | "issueMention"
  | "issueCommentMention"
  | "issueNewComment"
  | "agentSessionCreated"
  | "agentSessionPrompted"
  /** Top-level Comment with a non-null parent — possibly a human reply to a
   *  comment the bot authored via linear_post_comment. The router resolves
   *  the parent against linear_authored_comments to decide whether to wake a
   *  bot session. */
  | "commentReply";

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
  /** Linear AgentSession id (only for AgentSessionEvent webhooks). Used to
   * post replies back into the same Linear thread via Linear's MCP. */
  agentSessionId?: string | null;
  /** AgentSessionEvent: Linear's pre-rendered prompt context (decoded XML).
   * Includes the issue title/description plus any prior comment thread —
   * the cleanest "what to send to the LLM" payload. */
  promptContext?: string | null;
  /** Comment events: parent comment id when this is a threaded reply. The
   *  Linear webhook payload exposes it as either `data.parentId` or
   *  `data.parent.id`; we normalize. Null for top-level comments. */
  parentCommentId?: string | null;
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

  // Handle AgentSessionEvent — fired when a Linear OAuth app is
  // delegated/mentioned via the new agent surface. This is the primary
  // trigger for the A1 dedicated-app flow.
  if (eventType === "AgentSessionEvent") {
    return parseAgentSessionEvent(raw, deliveryId, eventType, action);
  }

  // Handle Comment events — a top-level threaded reply to a bot-authored
  // comment is how humans answer the bot's `linear_post_comment`. The
  // router does the actual is-this-a-reply-to-the-bot check by looking up
  // parentCommentId in linear_authored_comments; this parser just surfaces
  // the data.
  if (eventType === "Comment" && action === "create") {
    return parseCommentCreate(raw, deliveryId, eventType);
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

function parseAgentSessionEvent(
  raw: RawWebhookEnvelope,
  deliveryId: string,
  eventType: string,
  action: string,
): NormalizedWebhookEvent | null {
  const session = raw.agentSession ?? pickObject(raw.data ?? {}, "agentSession") ?? {};
  const issue = pickObject(session, "issue") ?? {};
  const creator = pickObject(session, "creator") ?? {};
  const comment = pickObject(session, "comment") ?? null;

  // Action: "created" = first delegation, "prompted" = follow-up message.
  const kind: NotificationKind | null =
    action === "created" ? "agentSessionCreated"
    : action === "prompted" ? "agentSessionPrompted"
    : null;

  const labelObjects = (issue.labels as { nodes?: unknown[] } | undefined)?.nodes;
  const labels = Array.isArray(labelObjects)
    ? labelObjects
        .map((n) => (n as { name?: string }).name?.toLowerCase())
        .filter((n): n is string => typeof n === "string")
    : [];

  return {
    kind,
    workspaceId: raw.organizationId ?? pickString(session, "organizationId") ?? "",
    issueId: pickString(issue, "id") ?? pickString(session, "issueId"),
    issueIdentifier: pickString(issue, "identifier"),
    issueTitle: pickString(issue, "title"),
    issueDescription: pickString(issue, "description"),
    commentBody: comment ? pickString(comment, "body") : null,
    commentId: comment ? pickString(comment, "id") : pickString(session, "commentId"),
    labels,
    actorUserId: pickString(creator, "id"),
    actorUserName: pickString(creator, "name"),
    deliveryId,
    eventType,
    agentSessionId: pickString(session, "id"),
    promptContext: typeof raw.promptContext === "string" ? decodeHtmlEntities(raw.promptContext) : null,
  };
}

/** Linear's promptContext is XML with HTML-escaped angle brackets. Undo that. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseCommentCreate(
  raw: RawWebhookEnvelope,
  deliveryId: string,
  eventType: string,
): NormalizedWebhookEvent {
  const data = raw.data ?? {};
  const parent = pickObject(data, "parent");
  // Linear webhook payload sometimes nests the parent comment id under
  // `data.parent.id`, sometimes flattens to `data.parentId`. Accept either.
  // We surface it for the prompt body but no longer route on it.
  const parentCommentId =
    pickString(data, "parentId") ??
    (parent ? pickString(parent, "id") : null);
  const issueId = pickString(data, "issueId");
  const commentId = pickString(data, "id");
  const body = pickString(data, "body");
  const userId = pickString(data, "userId");
  // Any Comment.create with an issueId is a candidate to wake an active
  // session. The router does the bot-self-check + active-session lookup
  // via linear_issue_sessions (issueId-keyed). Top-level vs threaded
  // doesn't matter at this layer.
  const kind: NotificationKind | null = issueId ? "commentReply" : null;
  return {
    kind,
    workspaceId: raw.organizationId ?? "",
    issueId,
    issueIdentifier: null,
    issueTitle: null,
    issueDescription: null,
    commentBody: body,
    commentId,
    labels: [],
    actorUserId: userId,
    actorUserName: null,
    deliveryId,
    eventType,
    parentCommentId,
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
