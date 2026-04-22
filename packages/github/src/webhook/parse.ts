// GitHub webhook payload shapes — typed from GitHub's documented schema with
// only the fields we route on. Keep narrow: parsing more fields later is
// cheap, pretending to know fields we don't is expensive.
//
// Reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads

/** Headers GitHub sends on every webhook POST. Lowercased keys. */
export interface WebhookHeaders {
  /** Event name e.g. "issues", "pull_request", "issue_comment". */
  "x-github-event"?: string;
  /** Per-delivery uuid; doubles as our idempotency key. */
  "x-github-delivery"?: string;
  /** "sha256=<hex>" of the raw body keyed by the App's webhook secret. */
  "x-hub-signature-256"?: string;
}

/**
 * Top-level webhook envelope. GitHub sends this for every event; our parser
 * narrows by `x-github-event` + `action`.
 */
export interface RawWebhookEnvelope {
  action?: string;
  /** Present on all installed-App webhooks; identifies the installation. */
  installation?: { id: number; node_id?: string };
  /** Present on App-related events (installation, installation_repositories). */
  repositories_added?: ReadonlyArray<RawRepository>;
  repositories_removed?: ReadonlyArray<RawRepository>;
  repositories?: ReadonlyArray<RawRepository>;
  /** Present on most repo-scoped events. */
  repository?: RawRepository;
  /** Sender of the event. */
  sender?: RawUser;
  /** Issue payloads (also embedded under PR for issue_comment-on-PR). */
  issue?: RawIssue;
  /** Pull request payloads. */
  pull_request?: RawPullRequest;
  /** Comment payloads. */
  comment?: RawComment;
  /** Pull request review payloads. */
  review?: RawReview;
  /** Workflow run payloads. */
  workflow_run?: { id: number; name?: string; conclusion?: string | null; status?: string; html_url?: string };
  /** Check suite payloads. */
  check_run?: { id: number; name?: string; conclusion?: string | null; status?: string; html_url?: string };
}

export interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  html_url?: string;
  private?: boolean;
  default_branch?: string;
}

export interface RawUser {
  id: number;
  login: string;
  type?: "User" | "Bot" | "Organization";
}

export interface RawIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url?: string;
  user?: RawUser;
  labels?: ReadonlyArray<{ name: string }>;
  assignees?: ReadonlyArray<RawUser>;
  /** Set when the issue is actually a PR; differentiates issues from PRs. */
  pull_request?: { html_url: string };
}

export interface RawPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  user?: RawUser;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  requested_reviewers?: ReadonlyArray<RawUser>;
  assignees?: ReadonlyArray<RawUser>;
  labels?: ReadonlyArray<{ name: string }>;
}

export interface RawComment {
  id: number;
  body: string;
  user?: RawUser;
  html_url?: string;
}

export interface RawReview {
  id: number;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  body?: string | null;
  user?: RawUser;
  html_url?: string;
}

/** Notification subtypes we route on. Add as we wire more event handlers. */
export type EventKind =
  | "issue_assigned"
  | "issue_opened"
  | "issue_commented"
  | "issue_mentioned"
  | "pr_opened"
  | "pr_assigned"
  | "pr_review_requested"
  | "pr_commented"
  | "pr_review_submitted"
  | "pr_review_comment"
  | "pr_mentioned"
  | "workflow_run_failed"
  | "check_run_failed"
  | "installation_created"
  | "installation_deleted";

/**
 * Normalized event consumed by the router and handler. One per dispatched
 * webhook. `kind` is null for events we receive but don't act on.
 */
export interface NormalizedWebhookEvent {
  kind: EventKind | null;
  /** GitHub installation id (always present on installed-App webhooks). */
  installationId: string | null;
  /** Repository full name like "acme/api". */
  repository: string | null;
  /** Numeric issue or PR number; the same number namespace is shared. */
  itemNumber: number | null;
  /** "issue" or "pull_request" — what `itemNumber` refers to. */
  itemKind: "issue" | "pull_request" | null;
  /** Display title of the issue / PR. */
  itemTitle: string | null;
  /** Plain-text body, may be empty. */
  itemBody: string | null;
  /** Comment / review body when applicable. */
  commentBody: string | null;
  /** Numeric comment id, if applicable. */
  commentId: number | null;
  /** Issue / PR labels (lowercased name) for routing. */
  labels: ReadonlyArray<string>;
  /** GitHub login of the user who triggered this. */
  actorLogin: string | null;
  /** GitHub user id of the actor. */
  actorUserId: number | null;
  /** Echo of `X-GitHub-Delivery` for idempotency. */
  deliveryId: string;
  /** Echo of `X-GitHub-Event` for logging. */
  eventType: string;
  /** Action when the event has one (e.g. "opened", "assigned"). */
  action: string | null;
  /** URL of the issue / PR / comment for human navigation. */
  htmlUrl: string | null;
}

export interface ParseInput {
  eventType: string;
  deliveryId: string;
  raw: RawWebhookEnvelope;
  /**
   * Login of the bot user the App publishes as. Used to filter "@mention"
   * events to only those that actually mention the bot, and to detect
   * assigned-to-bot vs assigned-to-human.
   */
  botLogin: string | null;
}

/** Parses a raw GitHub webhook into our normalized shape. Pure function. */
export function parseWebhook({
  eventType,
  deliveryId,
  raw,
  botLogin,
}: ParseInput): NormalizedWebhookEvent | null {
  if (!deliveryId) return null;

  const installationId = raw.installation?.id != null ? String(raw.installation.id) : null;
  const repository = raw.repository?.full_name ?? null;
  const action = raw.action ?? null;

  const base = {
    installationId,
    repository,
    deliveryId,
    eventType,
    action,
    actorLogin: raw.sender?.login ?? null,
    actorUserId: raw.sender?.id ?? null,
  };

  // Self-wakeup guard: if the sender IS the bot, never dispatch.
  // (We still return a parsed envelope for observability — kind=null.)
  // Without this filter, the bot's own comment fires `issue_comment.created`
  // with sender == bot, which would trigger an infinite reply loop.
  const senderIsBot = botLogin != null && raw.sender?.login === botLogin;

  const lowercaseLabels = (l?: ReadonlyArray<{ name: string }>): string[] =>
    Array.isArray(l) ? l.map((x) => x.name.toLowerCase()).filter(Boolean) : [];

  // ─── installation lifecycle ────────────────────────────────────────
  if (eventType === "installation") {
    return {
      ...base,
      kind:
        action === "created" ? "installation_created" :
        action === "deleted" ? "installation_deleted" :
        null,
      itemNumber: null,
      itemKind: null,
      itemTitle: null,
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: null,
    };
  }

  // ─── issues ────────────────────────────────────────────────────────
  if (eventType === "issues" && raw.issue) {
    const issue = raw.issue;
    const isAssignedToBot =
      botLogin != null &&
      Array.isArray(issue.assignees) &&
      issue.assignees.some((a) => a.login === botLogin);
    // Default matrix is "directly addressed only" — issues.opened fires for
    // every new issue in the repo, which would be a noise firehose. A future
    // `--mode triage` binding can opt back in by re-emitting issue_opened
    // here when a flag is set; for now: assigned-to-bot only.
    const kind =
      senderIsBot ? null :
      action === "assigned" && isAssignedToBot ? "issue_assigned" :
      null;
    return {
      ...base,
      kind,
      itemNumber: issue.number,
      itemKind: "issue",
      itemTitle: issue.title,
      itemBody: issue.body ?? null,
      commentBody: null,
      commentId: null,
      labels: lowercaseLabels(issue.labels),
      htmlUrl: issue.html_url ?? null,
    };
  }

  // ─── pull_request ───────────────────────────────────────────────────
  if (eventType === "pull_request" && raw.pull_request) {
    const pr = raw.pull_request;
    const isAssignedToBot =
      botLogin != null &&
      Array.isArray(pr.assignees) &&
      pr.assignees.some((a) => a.login === botLogin);
    const isReviewerBot =
      botLogin != null &&
      Array.isArray(pr.requested_reviewers) &&
      pr.requested_reviewers.some((u) => u.login === botLogin);
    // Same rationale as issues.opened: pull_request.opened fires on every
    // new PR — opt-in via future --mode reviewer.
    const kind =
      senderIsBot ? null :
      action === "review_requested" && isReviewerBot ? "pr_review_requested" :
      action === "assigned" && isAssignedToBot ? "pr_assigned" :
      null;
    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: null,
      commentId: null,
      labels: lowercaseLabels(pr.labels),
      htmlUrl: pr.html_url ?? null,
    };
  }

  // ─── issue_comment ─────────────────────────────────────────────────
  // GitHub fires `issue_comment` for both issues and PR conversation comments.
  if (eventType === "issue_comment" && raw.issue && raw.comment) {
    const issue = raw.issue;
    const comment = raw.comment;
    const isPr = !!issue.pull_request;
    const mentionsBot = botLogin != null && commentMentions(comment.body, botLogin);
    // Only wake on direct mention — without it, every comment in every
    // watched repo would dispatch.
    const kind =
      senderIsBot ? null :
      action === "created" && mentionsBot
        ? (isPr ? "pr_mentioned" : "issue_mentioned")
        : null;
    return {
      ...base,
      kind,
      itemNumber: issue.number,
      itemKind: isPr ? "pull_request" : "issue",
      itemTitle: issue.title,
      itemBody: issue.body ?? null,
      commentBody: comment.body,
      commentId: comment.id,
      labels: lowercaseLabels(issue.labels),
      htmlUrl: comment.html_url ?? issue.html_url ?? null,
    };
  }

  // ─── pull_request_review ────────────────────────────────────────────
  if (eventType === "pull_request_review" && raw.pull_request && raw.review) {
    const pr = raw.pull_request;
    // Only act when we're the requested reviewer AND the review came from
    // someone other than us — otherwise our own review submission would
    // wake us up again.
    const wasRequestedReviewer =
      botLogin != null &&
      Array.isArray(pr.requested_reviewers) &&
      pr.requested_reviewers.some((u) => u.login === botLogin);
    const kind =
      senderIsBot ? null :
      action === "submitted" && wasRequestedReviewer ? "pr_review_submitted" :
      null;
    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: raw.review.body ?? null,
      commentId: raw.review.id,
      labels: lowercaseLabels(pr.labels),
      htmlUrl: raw.review.html_url ?? pr.html_url ?? null,
    };
  }

  // ─── pull_request_review_comment ────────────────────────────────────
  if (eventType === "pull_request_review_comment" && raw.pull_request && raw.comment) {
    const pr = raw.pull_request;
    const mentionsBot = botLogin != null && commentMentions(raw.comment.body, botLogin);
    const kind =
      senderIsBot ? null :
      action === "created" && mentionsBot ? "pr_mentioned" :
      null;
    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: raw.comment.body,
      commentId: raw.comment.id,
      labels: lowercaseLabels(pr.labels),
      htmlUrl: raw.comment.html_url ?? pr.html_url ?? null,
    };
  }

  // ─── workflow_run / check_run failures ──────────────────────────────
  // Default matrix: NOT dispatched. These are CI-bot territory; a future
  // --mode ci-watch binding can opt into them. We still parse for
  // observability so an oma operator can see what's flowing through.
  if (eventType === "workflow_run" && raw.workflow_run) {
    const wr = raw.workflow_run;
    return {
      ...base,
      kind: null,
      itemNumber: null,
      itemKind: null,
      itemTitle: wr.name ?? "workflow",
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: wr.html_url ?? null,
    };
  }
  if (eventType === "check_run" && raw.check_run) {
    const cr = raw.check_run;
    return {
      ...base,
      kind: null,
      itemNumber: null,
      itemKind: null,
      itemTitle: cr.name ?? "check",
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: cr.html_url ?? null,
    };
  }

  // Fall-through: still record the event for idempotency / observability.
  return {
    ...base,
    kind: null,
    itemNumber: null,
    itemKind: null,
    itemTitle: null,
    itemBody: null,
    commentBody: null,
    commentId: null,
    labels: [],
    htmlUrl: null,
  };
}

/**
 * `@<login>` mention check. Case-insensitive, allows `@<login>` followed by
 * end-of-input, whitespace, or a punctuation char. Doesn't try to be smart
 * about code blocks — overcounting is OK; the agent's harness can still ignore
 * spurious wakeups.
 *
 * GitHub Apps surface as `<slug>[bot]` for ownership/audit, but humans @-
 * mention them by typing `@<slug>` (GitHub's autocomplete strips the suffix
 * before the `@` token reaches the comment body). Match both forms.
 */
function commentMentions(body: string, botLogin: string): boolean {
  const candidates = new Set<string>([botLogin]);
  const stripped = botLogin.endsWith("[bot]") ? botLogin.slice(0, -"[bot]".length) : null;
  if (stripped) candidates.add(stripped);
  for (const name of candidates) {
    const re = new RegExp(`@${escapeRegex(name)}(?![A-Za-z0-9_-])`, "i");
    if (re.test(body)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
