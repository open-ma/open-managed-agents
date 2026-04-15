# Console E2E Test — Agent Manual Walkthrough

This document describes the end-to-end test steps for the openma console UI. An AI agent should follow these steps using browser automation (agent-browser, Playwright, etc.), verifying each assertion before proceeding.

## Prerequisites

- Backend running on `http://localhost:8787` (wrangler dev)
- Frontend running on `http://localhost:5173` (vite dev) or built + served from wrangler
- D1 migration applied (`0001_auth_tables.sql`)

---

## Test 1: Unauthenticated Redirect

1. Navigate to `http://localhost:5173/`
2. **Assert**: Redirected to `/login`
3. **Assert**: "Welcome back" heading visible
4. **Assert**: Email and Password input fields visible
5. **Assert**: "Sign in" button visible and disabled
6. **Assert**: "Sign up" link visible

---

## Test 2: User Registration

1. On the login page, click **"Sign up"**
2. **Assert**: Heading changes to "Create your account"
3. Fill in:
   - Name: `Test User`
   - Email: `test-<timestamp>@openma.dev`
   - Password: `testpass123`
4. Click **"Create account"**
5. **Assert**: Redirected to `/` (dashboard)
6. **Assert**: "Quickstart" heading visible
7. **Assert**: User name visible in sidebar bottom
8. **Assert**: User email visible in sidebar bottom

---

## Test 3: Logout

1. From the dashboard, click the **Sign out** button (logout icon in sidebar bottom)
2. **Assert**: Redirected to `/login`
3. **Assert**: "Welcome back" heading visible

---

## Test 4: Login

1. On the login page, fill in email and password from Test 2
2. Click **"Sign in"**
3. **Assert**: Redirected to `/` (dashboard)
4. **Assert**: "Quickstart" heading visible

---

## Test 5: Forgot Password

1. On the login page, click **"Forgot password?"**
2. **Assert**: Heading changes to "Reset password"
3. **Assert**: "Enter your email to receive a reset link" text visible
4. Fill email: `test@example.com`
5. Click **"Send reset link"**
6. **Assert**: "Check your email" message visible
7. Click **"Back to sign in"**
8. **Assert**: Returns to login form

---

## Test 6: API Key Management

1. Login and navigate to **API Keys** (sidebar → Configuration → API Keys)
2. **Assert**: "API Keys" heading visible
3. **Assert**: "No API keys yet" empty state
4. Click **"+ New API key"**
5. **Assert**: Dialog opens with "New API Key" title
6. Fill Name: `My CLI Key`
7. Click **"Create"**
8. **Assert**: Dialog shows "API Key Created"
9. **Assert**: Key starts with `oma_`
10. **Assert**: "Copy to clipboard" link visible
11. Copy the key value for later use
12. Click **"Done"**
13. **Assert**: Key appears in the table with name "My CLI Key"
14. **Assert**: Key column shows `oma_xxxx...` prefix
15. Click **"Revoke"** on the key row
16. **Assert**: Confirmation dialog appears
17. Accept confirmation
18. **Assert**: Key removed from table

**Bonus**: Test the copied API key works via curl:
```bash
curl -s http://localhost:8787/v1/agents -H "x-api-key: <copied-key>"
# Should return 200 with {"data":[]}
```

---

## Test 7: Model Card Creation

1. Navigate to **Model Cards** (sidebar → Configuration → Model Cards)
2. **Assert**: "Model Cards" heading visible
3. Click **"+ New model card"**
4. **Assert**: Dialog with "API Format" 4-option grid:
   - Anthropic (selected by default)
   - Anthropic-compatible
   - OpenAI
   - OpenAI-compatible
5. **Assert**: No "Base URL" or "Custom Headers" fields visible (Anthropic is official)

### 7a: Create Anthropic-compatible card
6. Click **"Anthropic-compatible"**
7. **Assert**: "Base URL" field appears
8. **Assert**: "Custom Headers" section appears
9. Fill:
   - Name: `My Proxy`
   - API Key: `sk-test-12345678`
   - Model ID: `claude-sonnet-4-6`
   - Base URL: `https://my-proxy.example.com/v1`
10. Click **"+ Add header"** under Custom Headers
11. Fill header: `X-Project-Id` = `proj_123`
12. Click **"Create"**
13. **Assert**: Card appears in table with provider badge "Anthropic-compatible"

### 7b: Create OpenAI card
14. Click **"+ New model card"** again
15. Click **"OpenAI"**
16. **Assert**: No Base URL, no Custom Headers
17. Fill:
    - Name: `GPT-4o`
    - API Key: `sk-test-openai-key`
18. **Assert**: Model ID shows combobox (if key is valid, suggestions appear on blur)
19. Type `gpt-4o` in Model ID
20. Click **"Create"**
21. **Assert**: Card appears in table

---

## Test 8: ClawHub Skill Install

1. Navigate to **Skills** (sidebar → Configuration → Skills)
2. **Assert**: "Skills" heading visible
3. **Assert**: "ClawHub" button in header
4. Click **"ClawHub"**
5. **Assert**: Dialog with "Install from ClawHub" title
6. **Assert**: Search input with placeholder
7. Type `github` in search input
8. Click **"Search"**
9. **Assert**: Results appear with skill names, descriptions, and "Install" buttons
10. Click **"Install"** on any skill
11. **Assert**: Button changes to "Installing..."
12. Wait for install to complete
13. Close the ClawHub dialog
14. **Assert**: Installed skill appears in the Custom Skills table
15. Click the installed skill row
16. **Assert**: Detail dialog shows skill name, SKILL.md content, version history

---

## Test 9: Sidebar Navigation

Verify all sidebar links navigate to the correct page:

| Link | Expected Heading |
|------|-----------------|
| Quickstart | Quickstart |
| Agents | Agents |
| Sessions | Sessions |
| Environments | Environments |
| Credential Vaults | Credential Vaults |
| Skills | Skills |
| Memory Stores | Memory Stores |
| Model Cards | Model Cards |
| API Keys | API Keys |

For each:
1. Click the sidebar link
2. **Assert**: Correct heading visible
3. **Assert**: Page content loads (no error)

---

## Test 10: Theme Toggle

1. From any page, find the Light / Dark / System toggle in sidebar bottom
2. Click **"Dark"**
3. **Assert**: Background color changes to dark
4. Click **"Light"**
5. **Assert**: Background color changes to light
6. Click **"System"**
7. **Assert**: Follows system preference

---

## Test 11: Session with Vault (if vault exists)

1. Create a **Vault** first (Credential Vaults → + New vault, name: "Test Vault")
2. Navigate to **Sessions**
3. Click **"+ New session"**
4. **Assert**: Agent dropdown, Environment dropdown, Title input visible
5. **Assert**: "Credential Vaults" section shows "Test Vault" checkbox
6. Select an agent and environment
7. Check the "Test Vault" checkbox
8. Click **"Create"**
9. **Assert**: Session created, redirected to session detail

---

## Running the Playwright version

```bash
# Make sure backend is running
npx wrangler dev -c apps/main/wrangler.jsonc --port 8787 &

# Run D1 migration
npx wrangler d1 execute openma-auth --local --file=apps/main/migrations/0001_auth_tables.sql -c apps/main/wrangler.jsonc

# Run Playwright tests
npx playwright test test/e2e/console.spec.ts

# With headed browser (visible)
npx playwright test test/e2e/console.spec.ts --headed

# Single test
npx playwright test test/e2e/console.spec.ts -g "signup"
```
