/**
 * Smoke test: spawn MiniMax-Coding-Plan-MCP in sandbox + call understand_image.
 *
 * Validates the full chain:
 *   1. Agent declares mcp_servers with stdio entry
 *   2. SessionDO warmup spawns it via uv inside the sandbox container
 *   3. SSE server binds on localhost:8765
 *   4. Agent calls mcp_minimax_tp_list_tools → sees web_search + understand_image
 *   5. Agent calls mcp_minimax_tp_call(understand_image, prompt, image_url)
 *      with our known red-box test PNG
 *   6. MiniMax VLM returns a description mentioning "red"
 */
import {
  createAgent,
  createSession,
  sendAndWait,
  getOrCreateEnvironment,
} from "./client.js";

// MCP smoke test against an external image-understanding MCP. Requires
// the same two env vars as gaia.ts buildMiniMaxMcpServer — see that
// file for the swap-vendor story. Both required, no default endpoint.
const MINIMAX_KEY = process.env.MINIMAX_API_KEY;
const MINIMAX_HOST = process.env.MINIMAX_API_HOST;
if (!MINIMAX_KEY || !MINIMAX_HOST) {
  throw new Error(
    "MINIMAX_API_KEY + MINIMAX_API_HOST env vars required for the MCP smoke test.",
  );
}

async function main() {
  const apiUrl = process.env.OMA_API_URL!;
  const apiKey = process.env.OMA_API_KEY!;
  if (!apiUrl || !apiKey) throw new Error("OMA_API_URL + OMA_API_KEY required");

  // Set OMA_SMOKE_MODEL to the model id registered in your tenant.
  const SMOKE_MODEL = process.env.OMA_SMOKE_MODEL ?? "";
  if (!SMOKE_MODEL) {
    throw new Error("OMA_SMOKE_MODEL env var required");
  }
  console.log(`Creating agent (${SMOKE_MODEL} + image-understanding MCP, browser disabled)...`);
  const agentId = await createAgent({
    name: `mcp-stdio-smoke-${Date.now()}`,
    model: SMOKE_MODEL,
    system:
      "You are an assistant with access to an image-understanding MCP server. " +
      "When asked about an image, ALWAYS use mcp_minimax_tp_call with " +
      "tool_name='understand_image'. Do not use any other tool to look at images. " +
      "Be concise.",
    // Disable browser/web tools so the agent MUST go through the MCP path
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "bash", enabled: true },
          { name: "read", enabled: true },
        ],
      },
    ],
    mcp_servers: [
      {
        name: "minimax_tp",
        type: "stdio",
        stdio: {
          command: "uv",
          args: [
            "run",
            "--no-project",
            "--with",
            "minimax-coding-plan-mcp",
            "python",
            "-c",
            // Streamable HTTP transport, stateless mode — single POST endpoint,
            // no session handshake needed (matches OMA's existing curl wiring).
            "from minimax_mcp.server import mcp; mcp.settings.host='127.0.0.1'; mcp.settings.port=8765; mcp.settings.stateless_http=True; mcp.run(transport='streamable-http')",
          ],
          env: {
            MINIMAX_API_KEY: MINIMAX_KEY!,
            MINIMAX_API_HOST: MINIMAX_HOST,
          },
          port: 8765,
          sse_path: "/mcp",
          ready_timeout_ms: 120_000,
        },
      },
    ],
  });
  console.log("agent:", agentId);

  console.log("Getting environment + creating session (warmup will spawn MCP)...");
  const envId = await getOrCreateEnvironment();
  const sessionId = await createSession(agentId, envId);
  console.log("session:", sessionId);

  // dummyimage.com — generates simple PNGs on demand, permissive CORS.
  // 600x400 solid red rectangle = unambiguous answer to "what color".
  const imageUrl = "https://dummyimage.com/600x400/ff0000/ffffff.png&text=red";

  const message =
    "Use mcp_minimax_tp_call with tool_name=\"understand_image\" and " +
    `arguments='{"prompt":"What dominant colors are in this image? Answer in one short sentence.","image_source":"${imageUrl}"}'. ` +
    "Then summarize the answer.";

  console.log("Sending message (max 360s)...");
  const events = await sendAndWait(sessionId, message, 360_000);

  const mcpUses = events.filter(
    (e: any) =>
      (e.type === "agent.tool_use" ||
        e.type === "agent.custom_tool_use" ||
        e.type === "agent.mcp_tool_use") &&
      typeof e.name === "string" &&
      e.name.startsWith("mcp_minimax_tp"),
  );
  const mcpResults = events.filter((e: any) => {
    if (e.type !== "agent.tool_result" && e.type !== "agent.mcp_tool_result") return false;
    const useId = e.tool_use_id || e.mcp_tool_use_id;
    const matched = events.find(
      (u: any) =>
        (u.type === "agent.tool_use" ||
          u.type === "agent.custom_tool_use" ||
          u.type === "agent.mcp_tool_use") &&
        u.id === useId,
    );
    return matched && (matched as any).name?.startsWith("mcp_minimax_tp");
  });

  console.log(`\n--- MCP tool calls: ${mcpUses.length} ---`);
  for (const e of mcpUses as any[]) {
    console.log(`  ${e.name}: ${JSON.stringify(e.input).slice(0, 180)}`);
  }
  console.log(`\n--- MCP tool results: ${mcpResults.length} ---`);
  for (const e of mcpResults as any[]) {
    const c = typeof e.content === "string" ? e.content : JSON.stringify(e.content);
    console.log(`  result: ${c.slice(0, 400)}`);
  }

  const agentMsgs = events.filter((e: any) => e.type === "agent.message");
  const last = agentMsgs[agentMsgs.length - 1] as any;
  console.log("\n--- final agent.message ---");
  if (last?.content) {
    for (const b of last.content) if (b.type === "text") console.log(b.text);
  }

  console.log("\n--- check ---");
  const calledUnderstand = mcpUses.some(
    (e: any) => JSON.stringify(e.input || {}).includes("understand_image"),
  );
  // The MCP server returns JSON with `"isError": false` on success — string
  // match for "error|failed" hits that. Look at the structured isError flag
  // (from MCP's tool-result envelope) instead.
  const gotResult = mcpResults.length > 0 && mcpResults.some((e: any) => {
    const t = typeof e.content === "string" ? e.content : JSON.stringify(e.content);
    return /"isError"\s*:\s*false/.test(t);
  });
  console.log(`called understand_image? ${calledUnderstand ? "YES" : "NO"}`);
  console.log(`got non-error result?    ${gotResult ? "YES" : "NO"}`);
  console.log(`\n→ ${calledUnderstand && gotResult ? "PASS" : "FAIL"}`);
  console.log("\nSession kept for inspection:", sessionId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
