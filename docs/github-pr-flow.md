# End-to-End GitHub PR Flow

How a managed agent goes from session creation to submitting a pull request.

## Architecture

```
User API Request                     Sandbox (Container)
─────────────────                    ──────────────────
POST /v1/sessions                    
  { resources: [{                    
      type: "github_repository",     
      url: "https://github.com/…",  
      authorization_token: "ghp_…"   ← write-only, never returned
    }],                              
    vault_ids: ["vault_xxx"]         
  }                                  
       │                             
       ▼                             
   SessionDO.warmup()                
       │                             
       ├─ mountResources()           
       │   ├─ git clone (token in URL, one-time)
       │   ├─ git remote set-url origin CLEAN_URL
       │   ├─ git config credential.helper → reads $GITHUB_TOKEN
       │   ├─ registerCommandSecrets("git", { GITHUB_TOKEN })
       │   ├─ registerCommandSecrets("gh",  { GH_TOKEN })
       │   └─ ensureGhCli() → apt install gh (if github_repository present)
       │                             
       ├─ Load vault credentials     
       │   └─ command_secret type:   
       │       registerCommandSecrets("wrangler", { CF_API_TOKEN })
       │                             
       └─ Ready for harness          
```

## Credential Security Model

```
Secret injection path:

  Vault/Resource API         KV Store              Sandbox exec()
  ──────────────────         ────────              ──────────────
  authorization_token  ───►  secret:{sid}:{rid}    
                             (separate key,         
                              never in resource     
                              metadata)             
                                    │               
                                    ▼               
                             secretStore Map        
                                    │               
                                    ▼               
                             registerCommandSecrets()
                                    │               
                                    ▼               
                             sandbox.exec(cmd, {    
                               env: { GITHUB_TOKEN: "ghp_…" }  ← per-exec injection
                             })                     
```

**Key properties:**
- `authorization_token` and `value` are **write-only** — never appear in any API response
- Secrets stored in separate KV keys (`secret:{sessionId}:{resourceId}`), not in resource metadata
- `registerCommandSecrets(prefix, secrets)` only injects env vars for commands matching the prefix
- `echo $GITHUB_TOKEN` → empty (no global env var, only per-exec for `git`/`gh`/`cd` commands)
- `git remote -v` → clean URL (token removed after clone)
- Credential helper reads `$GITHUB_TOKEN` from per-exec env: `git config credential.helper '!f() { echo "password=${GITHUB_TOKEN}"; }; f'`

## Three Credential Types

| Type | Use Case | Matching | Injected As |
|------|----------|----------|-------------|
| `static_bearer` | MCP server auth | `mcp_server_url` | Bearer token header |
| `mcp_oauth` | MCP OAuth flow | `mcp_server_url` | OAuth token refresh |
| `command_secret` | CLI tool auth | `command_prefixes` | Per-exec env var |

### command_secret Example

```json
POST /v1/vaults/{id}/credentials
{
  "display_name": "Wrangler Token",
  "auth": {
    "type": "command_secret",
    "command_prefixes": ["wrangler", "npx wrangler"],
    "env_var": "CLOUDFLARE_API_TOKEN",
    "token": "cf_xxx"                    // write-only
  }
}
```

When the agent runs `wrangler deploy`, the sandbox injects `CLOUDFLARE_API_TOKEN=cf_xxx` only for that exec call.

## GitHub Resource Flow (Step by Step)

### 1. Session Creation

```json
POST /v1/sessions
{
  "agent": "agent_xxx",
  "environment_id": "env_xxx",
  "resources": [{
    "type": "github_repository",
    "url": "https://github.com/org/repo",
    "authorization_token": "ghp_xxx",
    "checkout": { "type": "branch", "name": "main" }
  }]
}
```

Response contains the resource with `url` but **no** `authorization_token`.

### 2. Warmup (SessionDO)

```
sandbox.gitCheckout(url_with_token, { branch: "main", targetDir: "/workspace" })
  or
sandbox.exec("git clone https://TOKEN@github.com/… /workspace")

sandbox.exec("git remote set-url origin https://github.com/…")     // clean URL
sandbox.exec("git config credential.helper '!f() { … }; f'")       // env-based auth
sandbox.exec("git config user.name Agent && git config user.email …")

registerCommandSecrets("git", { GITHUB_TOKEN: token, GH_TOKEN: token })
registerCommandSecrets("gh",  { GITHUB_TOKEN: token, GH_TOKEN: token })
registerCommandSecrets("cd ", { GITHUB_TOKEN: token, GH_TOKEN: token })

ensureGhCli()  // apt install gh if not present
```

### 3. Agent Creates PR (via harness + tools)

The agent (Claude) uses bash tool:

```bash
cd /workspace
git checkout -b fix/improve-readme
echo "..." >> README.md
git add README.md
git commit -m "docs: improve readme"
git push origin fix/improve-readme
gh pr create --title "docs: improve readme" --body "..."
```

Each `git`/`gh` command gets `GITHUB_TOKEN` and `GH_TOKEN` injected per-exec.

## Environment Secrets (env_secret)

For non-command secrets that the agent needs globally:

```json
POST /v1/sessions
{
  "resources": [{
    "type": "env_secret",
    "name": "TAVILY_API_KEY",
    "value": "tvly_xxx"           // write-only
  }]
}
```

Injected via `sandbox.setEnvVars()` — visible to all commands (same as Anthropic's model).

## wrangler.jsonc Environment Configuration

```jsonc
{
  "name": "managed-agents",
  "containers": [{
    "class_name": "Sandbox",
    "image": "./node_modules/@cloudflare/sandbox/Dockerfile",
    "instance_type": "lite",
    "max_instances": 10
  }],

  "env": {
    "dev": {
      // Local dev: use pre-built image to avoid Docker Hub dependency
      "containers": [{
        "class_name": "Sandbox",
        "image": "/tmp/Dockerfile.sandbox",
        "instance_type": "lite",
        "max_instances": 2
      }]
    }
  }
}
```

- `npx wrangler dev` → uses top-level config (pulls from Docker Hub)
- `npx wrangler dev --env dev` → uses cached local image
- `npx wrangler deploy` → builds + pushes to Cloudflare registry

## Current Gaps

1. **gh CLI not in base image** — installed at runtime via `ensureGhCli()` during warmup (~30s overhead). Should be added to Dockerfile for production.
2. **Docker Hub dependency** — `wrangler dev` and `wrangler deploy` both trigger `docker build` which needs Docker Hub for base images. Use `--env dev` with local cache for offline development.
3. **workers.dev DNS** — some networks (China) have DNS pollution for `*.workers.dev`. Use a custom domain for production deployments.
