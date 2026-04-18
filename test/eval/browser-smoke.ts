/**
 * Smoke test for browser_* tools end-to-end.
 *
 * Creates an agent with the browser toolset, asks it to navigate to
 * example.com and report what it sees. Verifies the trajectory shows
 * browser_navigate + browser_get_text + Claude's text answer mentioning
 * "Example Domain".
 *
 * Run: OMA_API_URL=https://openma.dev OMA_API_KEY=... npx tsx test/eval/browser-smoke.ts
 */
import {
  createAgent,
  createSession,
  sendAndWait,
  getOrCreateEnvironment,
} from "./client.js";

async function main() {
  const apiUrl = process.env.OMA_API_URL;
  const apiKey = process.env.OMA_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("OMA_API_URL and OMA_API_KEY required");
  }

  console.log("Creating agent (claude-sonnet-4-5 + browser toolset)...");
  const agentId = await createAgent({
    name: `browser-smoke-${Date.now()}`,
    model: "claude-sonnet-4-5",
    system:
      "You are a web-capable assistant. Use browser_navigate to open URLs and " +
      "browser_get_text to read page content. Be concise.",
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
  });
  console.log("agent:", agentId);

  console.log("Getting environment...");
  const envId = await getOrCreateEnvironment();
  console.log("env:", envId);

  console.log("Creating session...");
  const sessionId = await createSession(agentId, envId);
  console.log("session:", sessionId);

  const message =
    "Open https://example.com using browser_navigate, then use browser_get_text " +
    "(no selector) to read the page. Tell me the H1 heading. One line.";

  console.log("Sending message and waiting for idle (max 180s)...");
  const events = await sendAndWait(sessionId, message, 180_000);
  console.log(`Got ${events.length} events.`);

  const browserUses = events.filter(
    (e: any) =>
      (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") &&
      (e.name as string)?.startsWith("browser_"),
  );
  console.log(`\n--- browser_* tool calls: ${browserUses.length} ---`);
  for (const e of browserUses as any[]) {
    console.log(`  ${e.name}: ${JSON.stringify(e.input).slice(0, 120)}`);
  }

  const browserResults = events.filter((e: any) => {
    if (e.type !== "agent.tool_result") return false;
    const matched = events.find(
      (u: any) =>
        (u.type === "agent.tool_use" || u.type === "agent.custom_tool_use") &&
        u.id === e.tool_use_id,
    );
    return matched && (matched as any).name?.startsWith("browser_");
  });
  console.log(`\n--- browser_* tool results: ${browserResults.length} ---`);
  for (const e of browserResults as any[]) {
    if (typeof e.content === "string") {
      console.log(`  result (string): ${e.content.slice(0, 200)}`);
    } else if (Array.isArray(e.content)) {
      const summary = e.content.map((b: any) => {
        if (b.type === "text") return `[text:${b.text.slice(0, 60)}]`;
        if (b.type === "image") return `[image media=${b.source?.media_type} b64_len=${b.source?.data?.length ?? "?"}]`;
        return `[${b.type}]`;
      });
      console.log(`  result (array): ${summary.join(" ")}`);
    }
  }

  const agentMsgs = events.filter((e: any) => e.type === "agent.message");
  const last = agentMsgs[agentMsgs.length - 1] as any;
  console.log("\n--- final agent.message ---");
  if (last?.content) {
    for (const b of last.content) {
      if (b.type === "text") console.log(b.text);
    }
  }

  // Pass criteria: at least one browser_navigate, one browser_get_text result,
  // and "example domain" appears in final message
  const hasNav = browserUses.some((e: any) => e.name === "browser_navigate");
  const hasText = browserResults.some(
    (e: any) =>
      typeof e.content === "string" && e.content.toLowerCase().includes("example domain"),
  );
  const finalText = (last?.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ");
  const finalMentions = /example\s+domain/i.test(finalText);

  console.log("\n--- check ---");
  console.log(`browser_navigate called?   ${hasNav ? "YES" : "NO"}`);
  console.log(`text result found "Example Domain"? ${hasText ? "YES" : "NO"}`);
  console.log(`final message mentions it? ${finalMentions ? "YES" : "NO"}`);
  console.log(`\n→ ${hasNav && hasText && finalMentions ? "PASS" : "FAIL"}`);
  console.log("\nKept session for inspection:", sessionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
