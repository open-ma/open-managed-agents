import { createAgent, createSession, sendAndWait, getOrCreateEnvironment, deleteAgent, deleteSession } from "./client.js";

async function main() {
  const envId = await getOrCreateEnvironment();
  console.log("env:", envId);

  // Big page that Jina handles cleanly
  const targetUrl = "https://en.wikipedia.org/wiki/Mercedes_Sosa";

  const agentId = await createAgent({
    name: `aux-smoke-${Date.now()}`,
    model: "MiniMax-M2-highspeed",
    aux_model: "MiniMax-M2-highspeed",
    system: `Your job: call web_fetch with the URL the user provides, then state in one sentence what the page is about. Do nothing else. Use ONLY web_fetch.`,
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "web_fetch", enabled: true }, { name: "read", enabled: true }] }],
  });
  console.log("agent:", agentId);

  const sessionId = await createSession(agentId, envId);
  console.log("session:", sessionId);

  console.log("sending...");
  const events = await sendAndWait(sessionId, `Fetch ${targetUrl} and tell me in one sentence what the page is about.`, 240_000);

  const auxEvents = events.filter((e: any) => e.type === "aux.model_call");
  const fetchUses = events.filter((e: any) => (e.type === "agent.tool_use" || e.type === "agent.custom_tool_use") && e.name === "web_fetch");

  console.log("");
  console.log("=== RESULTS ===");
  console.log("session:", sessionId);
  console.log("web_fetch calls:", fetchUses.length);
  console.log("aux.model_call events:", auxEvents.length);
  for (const a of auxEvents) {
    console.log(`  - ${a.status} ${a.duration_ms}ms tokens=${JSON.stringify(a.tokens)} task=${a.task}`);
    if (a.error) console.log(`    error: ${a.error}`);
  }
  // dump tool result snippet to see if _meta was included
  for (const e of events) {
    if ((e as any).type === "agent.tool_result" || (e as any).type === "agent.mcp_tool_result") {
      const c = (e as any).content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.text || "").join("") : "";
      if (text.includes("_meta") || text.includes("extractor")) {
        console.log("\n=== tool result with _meta (first 700 chars) ===");
        console.log(text.slice(0, 700));
      }
    }
  }
  // Cleanup
  console.log("(keeping session for inspection: " + sessionId + ")");
  console.log("(keeping agent for inspection: " + agentId + ")");
}

main().catch(e => { console.error(e); process.exit(1); });
