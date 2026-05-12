# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Open Managed Agents, please
report it privately. **Do not file a public GitHub issue for security
issues.**

Report via GitHub's private vulnerability reporting:
https://github.com/open-ma/open-managed-agents/security/advisories/new

Please include:
- A description of the issue and its potential impact
- Steps to reproduce, or a proof-of-concept if possible
- The version / commit affected
- Your contact info if you'd like a follow-up

We aim to acknowledge reports within 3 business days and to issue a fix
or mitigation within 30 days for high-severity issues. We will credit
you in the advisory unless you prefer to remain anonymous.

## Scope

In scope:
- The runtime (`apps/agent`, `apps/main`, `apps/main-node`,
  `apps/integrations`, `apps/oma-vault`)
- Published packages (`@openma/cli`, `@openma/sdk`)
- Self-host deployment paths documented in `docs/self-host.md`

Out of scope:
- Vulnerabilities in third-party LLM providers (Anthropic, OpenAI, etc.)
  — please report to the respective vendor.
- Self-inflicted misconfigurations (e.g. running with `AUTH_DISABLED=1`
  in production).
- Issues only reproducible against the hosted instance at `openma.dev`
  — those should go through the vendor's own channel.

## Supported Versions

Only the latest minor release line is actively supported with security
fixes. Older versions may receive backports at maintainer discretion.
