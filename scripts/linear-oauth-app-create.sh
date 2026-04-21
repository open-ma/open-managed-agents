#!/usr/bin/env bash
# linear-oauth-app-create — create a Linear OAuth Application via GraphQL,
# using auth context borrowed from a logged-in browser tab.
#
# Why not drive the web form? The "New OAuth application" form has flaky
# React rendering for the webhook section (toggle → URL field appears
# asynchronously, no reliable settle signal). The mutation is just a single
# GraphQL POST — much faster and more reliable.
#
# Why borrow auth from the browser? Linear's GraphQL endpoint requires
# auth headers (organization/user/useraccount IDs + linear-client-id). We
# extract them from the cookies + a meta-tag in the running app. No need
# for an API key or admin OAuth setup.
#
# Requires:
#   - agent-browser on PATH
#   - Chrome with --remote-debugging-port=<port> running, signed in to the
#     target Linear workspace. Default port 9333.
#
# Usage:
#   scripts/linear-oauth-app-create.sh \
#     --workspace boai \
#     --name MyBot \
#     --callback-url https://gateway/linear/oauth/app/<APP_ID>/callback \
#     [--webhook-url https://gateway/linear/webhook/app/<APP_ID>] \
#     [--webhook-events Comment,Issue,AgentSessionEvent] \
#     [--developer "OpenMA"] [--developer-url "https://openma.dev"] \
#     [--description "..."] [--cdp-port 9333]
#
# Output (stdout): JSON with appId / clientId / clientSecret / webhookSecret /
# webhookUrl. Pipe to jq, or feed into `oma linear submit`.
#
# Exit codes:
#   0  success
#   1  unrecoverable (not logged in, GraphQL error, schema change)
#   2  bad usage

set -euo pipefail

WORKSPACE=
NAME=
CALLBACK_URL=
WEBHOOK_URL=
WEBHOOK_EVENTS="Comment,Issue,AgentSessionEvent"
DEVELOPER="OpenMA"
DEVELOPER_URL="https://openma.dev"
DESCRIPTION=""
CDP_PORT=9333

usage() {
  sed -n '2,30p' "$0" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)        WORKSPACE="$2"; shift 2;;
    --name)             NAME="$2"; shift 2;;
    --callback-url)     CALLBACK_URL="$2"; shift 2;;
    --webhook-url)      WEBHOOK_URL="$2"; shift 2;;
    --webhook-events)   WEBHOOK_EVENTS="$2"; shift 2;;
    --developer)        DEVELOPER="$2"; shift 2;;
    --developer-url)    DEVELOPER_URL="$2"; shift 2;;
    --description)      DESCRIPTION="$2"; shift 2;;
    --cdp-port)         CDP_PORT="$2"; shift 2;;
    -h|--help)          usage;;
    *) echo "unknown arg: $1" >&2; usage;;
  esac
done

[[ -z "$WORKSPACE" ]]    && { echo "missing --workspace" >&2; exit 2; }
[[ -z "$NAME" ]]         && { echo "missing --name" >&2; exit 2; }
[[ -z "$CALLBACK_URL" ]] && { echo "missing --callback-url" >&2; exit 2; }

# Ensure agent-browser is connected. Idempotent — re-running is safe.
if ! agent-browser connect "$CDP_PORT" >/dev/null 2>&1; then
  echo "agent-browser failed to connect to Chrome CDP on port $CDP_PORT." >&2
  exit 1
fi

# ── Step 1: open the workspace so the page state populates auth headers ──
# We only need to land somewhere inside linear.app/<workspace> so that the
# Linear web client has hydrated its in-memory userId/organizationId. The
# Settings page is fast and doesn't trigger heavy data loads.
agent-browser open "https://linear.app/${WORKSPACE}/settings/account/profile" >/dev/null
sleep 2

# Linear's GraphQL endpoint requires special headers (organization, user,
# useraccount, linear-client-id, linear-client-version) on top of the session
# cookie. The values come from the live page state — we extract them below
# and resend on every API call.
META_JS=$(cat <<'JS'
new Promise(function(resolve) {
  (async function() {
    var dbs = await indexedDB.databases();
    var linearDb = dbs.find(function(d) { return d.name && d.name.startsWith('linear_') && d.name.length > 16; });
    if (!linearDb) return resolve(null);
    var open = indexedDB.open(linearDb.name);
    open.onerror = function() { resolve(null); };
    open.onsuccess = function() {
      var db = open.result;
      // Find the workspace by urlKey and the user record (any with email).
      var orgRow = null;
      var userRow = null;
      var stores = Array.from(db.objectStoreNames).filter(function(n) { return !n.endsWith('_partial') && !n.startsWith('_'); });
      var pending = stores.length;
      if (!pending) return resolve(null);
      var wantedKey = (window.__linearWorkspaceKey || '').toLowerCase();
      stores.forEach(function(s) {
        try {
          var tx = db.transaction(s, 'readonly');
          var req = tx.objectStore(s).getAll();
          req.onsuccess = function() {
            (req.result || []).forEach(function(row) {
              if (!row || typeof row !== 'object') return;
              // Org rows have urlKey + name (and a UUID id).
              if (row.urlKey && row.name && row.id && row.id.length === 36) {
                if (!wantedKey || String(row.urlKey).toLowerCase() === wantedKey) {
                  if (!orgRow || String(row.urlKey).toLowerCase() === wantedKey) {
                    orgRow = { id: row.id, urlKey: row.urlKey };
                  }
                }
              }
              // User rows have email + a UUID id.
              if (row.email && row.id && row.id.length === 36 && !userRow) {
                userRow = { id: row.id, email: row.email };
              }
            });
            if (--pending === 0) resolve({ userId: userRow && userRow.id, orgId: orgRow && orgRow.id });
          };
          req.onerror = function() { if (--pending === 0) resolve({ userId: userRow && userRow.id, orgId: orgRow && orgRow.id }); };
        } catch (e) { if (--pending === 0) resolve({ userId: userRow && userRow.id, orgId: orgRow && orgRow.id }); }
      });
    };
  })();
}).then(function(r) { return JSON.stringify(r); })
JS
)

# Tell the IDB scan which workspace we want.
agent-browser eval "window.__linearWorkspaceKey = $(printf '%s' "$WORKSPACE" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))"); 'set'" >/dev/null

META=$(agent-browser eval "$META_JS" 2>/dev/null | python3 -c "import sys, json; v = json.loads(sys.stdin.read()); print(v if isinstance(v, str) else 'null')")
USER_ID=$(echo "$META" | python3 -c "import sys, json; v = json.loads(sys.stdin.read() or 'null'); print((v or {}).get('userId') or '')")
ORG_ID=$(echo "$META"  | python3 -c "import sys, json; v = json.loads(sys.stdin.read() or 'null'); print((v or {}).get('orgId')  or '')")

if [[ -z "$USER_ID" || -z "$ORG_ID" ]]; then
  echo "Couldn't extract user/org IDs from Linear's IndexedDB (got user='$USER_ID' org='$ORG_ID'). Are you signed in to https://linear.app/$WORKSPACE?" >&2
  exit 1
fi

# linear-client-id is just a free-form identifier; useraccount sits in a cookie.
USERACCOUNT=$(agent-browser eval "
  (function() {
    try {
      var raw = localStorage.getItem('ApplicationStore');
      if (!raw) return '';
      var obj = JSON.parse(raw);
      return obj.currentUserAccountId || obj.userAccount?.id || obj.userAccountId || '';
    } catch { return ''; }
  })()
" 2>/dev/null | python3 -c "import sys, json; print(json.loads(sys.stdin.read()))")

if [[ -z "$USERACCOUNT" ]]; then
  echo "Couldn't extract useraccount ID from cookies or localStorage. Linear may have changed its session storage layout." >&2
  echo "(Got user=$USER_ID org=$ORG_ID, useraccount empty)" >&2
  exit 1
fi

# ── Step 2: issue OauthClientCreate mutation ─────────────────────────────
# We POST from inside the page context with credentials:'include' so the
# session cookie is sent, plus the special org/user/useraccount headers
# Linear's UI normally adds.
APP_UUID=$(python3 -c "import uuid; print(str(uuid.uuid4()))")

# Build the GraphQL request body. webhookResourceTypes is part of the create
# payload — pass the events the user requested.
WEBHOOK_TYPES_JSON=$(python3 -c "
import json, sys
events = '''$WEBHOOK_EVENTS'''.split(',')
mapping = {'comment': 'Comment', 'issue': 'Issue', 'agentsessionevent': 'AgentSessionEvent', 'agentsession': 'AgentSessionEvent'}
out = []
for e in events:
    e2 = e.strip()
    norm = e2.lower().replace('_','').replace('-','').replace(' ','')
    out.append(mapping.get(norm, e2))
print(json.dumps(out))
")

CREATE_INPUT=$(python3 -c "
import json
inp = {
  'id': '$APP_UUID',
  'name': '''$NAME''',
  'description': '''$DESCRIPTION''',
  'developer': '''$DEVELOPER''',
  'developerUrl': '''$DEVELOPER_URL''',
  'redirectUris': ['''$CALLBACK_URL'''],
  'publicEnabled': False,
  'webhookEnabled': bool('''$WEBHOOK_URL'''),
  'webhookUrl': '''$WEBHOOK_URL''' if '''$WEBHOOK_URL''' else None,
  'webhookResourceTypes': $WEBHOOK_TYPES_JSON if '''$WEBHOOK_URL''' else [],
  'useRefreshTokens': True,
  'supportsClientCredentials': False,
}
# Drop None values — Linear is strict about types.
inp = {k: v for k, v in inp.items() if v is not None}
print(json.dumps({
  'operationName': 'OauthClientCreate',
  'query': 'mutation OauthClientCreate(\$oauthClientCreateInput: OauthClientCreateInput!) { oauthClientCreate(input: \$oauthClientCreateInput) { lastSyncId } }',
  'variables': { 'oauthClientCreateInput': inp },
}))
")

CREATE_JS=$(cat <<JS
fetch('https://client-api.linear.app/graphql', {
  method: 'POST', credentials: 'include',
  headers: {
    'content-type': 'application/json',
    'organization': '$ORG_ID',
    'user': '$USER_ID',
    'useraccount': '$USERACCOUNT',
    'linear-client-id': 'oma-script',
    'linear-client-version': '1.0.0',
  },
  body: $(printf '%s' "$CREATE_INPUT" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))"),
}).then(function(r) { return r.text(); })
JS
)

CREATE_RES=$(agent-browser eval "$CREATE_JS" 2>/dev/null | python3 -c "import sys, json; print(json.loads(sys.stdin.read()))")
if echo "$CREATE_RES" | grep -q '"errors"'; then
  echo "OauthClientCreate failed:" >&2
  echo "$CREATE_RES" >&2
  exit 1
fi

# ── Step 3: read clientId/clientSecret + webhookSecret via follow-up queries ─
QUERY_JS=$(cat <<JS
fetch('https://client-api.linear.app/graphql', {
  method: 'POST', credentials: 'include',
  headers: {
    'content-type': 'application/json',
    'organization': '$ORG_ID',
    'user': '$USER_ID',
    'useraccount': '$USERACCOUNT',
    'linear-client-id': 'oma-script',
    'linear-client-version': '1.0.0',
  },
  body: JSON.stringify({
    operationName: 'OauthAppDetails',
    query: 'query OauthAppDetails(\$id: String!) { oauthClient(id: \$id) { id clientId clientSecret webhookUrl webhookSecret } }',
    variables: { id: '$APP_UUID' },
  }),
}).then(function(r) { return r.text(); })
JS
)

# Linear sometimes needs a beat to materialize the row. Retry up to 5 s.
DETAILS=
for i in $(seq 1 10); do
  DETAILS=$(agent-browser eval "$QUERY_JS" 2>/dev/null | python3 -c "import sys, json; print(json.loads(sys.stdin.read()))")
  if echo "$DETAILS" | grep -q '"clientId"' && ! echo "$DETAILS" | grep -q '"clientId":null'; then break; fi
  sleep 0.5
done

if ! echo "$DETAILS" | grep -q '"clientId"'; then
  echo "OauthAppDetails query failed:" >&2
  echo "$DETAILS" >&2
  exit 1
fi

# Emit the final JSON — fields the OMA `linear submit` command expects.
python3 -c "
import json
d = json.loads('''$DETAILS''')
client = d.get('data', {}).get('oauthClient', {}) or {}
out = {
  'appId': client.get('id') or '$APP_UUID',
  'clientId': client.get('clientId') or '',
  'clientSecret': client.get('clientSecret') or '',
  'webhookSecret': client.get('webhookSecret') or '',
  'webhookUrl': client.get('webhookUrl') or '$WEBHOOK_URL',
}
print(json.dumps(out, indent=2))
"
