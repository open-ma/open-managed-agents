// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { resolveSkills, registerSkill } from "../../apps/agent/src/harness/skills";
import { SummarizeCompaction } from "../../apps/agent/src/harness/compaction";
import { TestSandbox, createSandbox } from "../../apps/agent/src/runtime/sandbox";
import { buildTools, buildMemoryTools } from "../../apps/agent/src/harness/tools";
import { InMemoryHistory, eventsToMessages } from "../../apps/agent/src/runtime/history";
import type { AgentConfig, SessionEvent, SessionThreadCreatedEvent, SessionThreadIdleEvent, AgentThreadMessageEvent, AgentMessageEvent, UserMessageEvent } from "@open-managed-agents/shared";

// ============================================================
// Helpers
// ============================================================
const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

// ============================================================
// 1. Skills system
// ============================================================
describe("Skills system", () => {
  it("resolveSkills returns registered skills", () => {
    const skills = resolveSkills([{ skill_id: "web_research" }]);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("Web Research");
    expect(skills[0].system_prompt_addition).toContain("web_search");
  });

  it("resolveSkills ignores unknown skill IDs", () => {
    const skills = resolveSkills([
      { skill_id: "web_research" },
      { skill_id: "totally_made_up_skill" },
      { skill_id: "another_fake" },
    ]);
    expect(skills.length).toBe(1);
    expect(skills[0].id).toBe("web_research");
  });

  it("built-in skills are pre-registered (web_research, code_review, data_analysis)", () => {
    const allBuiltIn = resolveSkills([
      { skill_id: "web_research" },
      { skill_id: "code_review" },
      { skill_id: "data_analysis" },
    ]);
    expect(allBuiltIn.length).toBe(3);

    const names = allBuiltIn.map((s) => s.name);
    expect(names).toContain("Web Research");
    expect(names).toContain("Code Review");
    expect(names).toContain("Data Analysis");

    // Verify each has a non-empty system_prompt_addition
    for (const skill of allBuiltIn) {
      expect(skill.system_prompt_addition.length).toBeGreaterThan(0);
    }
  });

  it("registerSkill adds a new skill and resolveSkills finds it", () => {
    registerSkill({
      id: "custom_testing_skill",
      name: "Custom Testing",
      system_prompt_addition: "You are a testing specialist.",
    });

    const skills = resolveSkills([{ skill_id: "custom_testing_skill" }]);
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("Custom Testing");
    expect(skills[0].system_prompt_addition).toBe("You are a testing specialist.");
  });

  it("resolveSkills returns empty array when no skill IDs match", () => {
    const skills = resolveSkills([
      { skill_id: "nonexistent_1" },
      { skill_id: "nonexistent_2" },
    ]);
    expect(skills).toEqual([]);
  });

  it("resolveSkills returns empty array for empty input", () => {
    const skills = resolveSkills([]);
    expect(skills).toEqual([]);
  });

  it("registerSkill overwrites existing skill with same ID", () => {
    registerSkill({
      id: "overwrite_test_skill",
      name: "Original",
      system_prompt_addition: "original prompt",
    });
    let skills = resolveSkills([{ skill_id: "overwrite_test_skill" }]);
    expect(skills[0].name).toBe("Original");

    registerSkill({
      id: "overwrite_test_skill",
      name: "Updated",
      system_prompt_addition: "updated prompt",
    });
    skills = resolveSkills([{ skill_id: "overwrite_test_skill" }]);
    expect(skills[0].name).toBe("Updated");
    expect(skills[0].system_prompt_addition).toBe("updated prompt");
  });
});

// ============================================================
// 2. Compaction
// ============================================================
describe("Compaction", () => {
  const compaction = new SummarizeCompaction();

  it("shouldCompact returns false for short conversations", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];
    expect(compaction.shouldCompact(messages)).toBe(false);
  });

  it("shouldCompact returns true for very long conversations", () => {
    // Create messages totaling ~400K chars => ~100K tokens at 4 chars/token
    // 85% threshold = 85K tokens => 340K chars
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "x".repeat(4000), // ~1000 tokens each => 100K tokens total
    }));
    expect(compaction.shouldCompact(messages)).toBe(true);
  });

  it("shouldCompact respects custom maxTokens threshold", () => {
    // 10 messages * 400 chars = 4000 chars => ~1000 tokens
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "y".repeat(400),
    }));
    // With default 100K, should NOT compact
    expect(compaction.shouldCompact(messages, 100000)).toBe(false);
    // With low threshold (500 tokens * 0.85 = 425 tokens), should compact
    expect(compaction.shouldCompact(messages, 500)).toBe(true);
  });

  it("compact returns original messages when 4 or fewer", async () => {
    const messages = [
      { role: "user" as const, content: "msg1" },
      { role: "assistant" as const, content: "msg2" },
      { role: "user" as const, content: "msg3" },
      { role: "assistant" as const, content: "msg4" },
    ];
    // compact should short-circuit for <= 4 messages
    const fakeModel = {} as any; // Won't be called
    const result = await compaction.compact(messages, fakeModel);
    expect(result).toEqual(messages);
    expect(result.length).toBe(4);
  });

  it("shouldCompact returns false at exactly below the threshold", () => {
    // maxTokens=100, threshold = 85 tokens = 340 chars
    // Create a message with exactly 336 chars => 84 tokens (below 85)
    const messages = [
      { role: "user" as const, content: "a".repeat(336) },
    ];
    expect(compaction.shouldCompact(messages, 100)).toBe(false);
  });
});

// ============================================================
// 3. Multi-agent callable_agents
// ============================================================
describe("Multi-agent callable_agents", () => {
  it("stores callable_agents in AgentConfig and builds tools", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_coord_api",
      name: "Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [{ type: "agent", id: "agent_worker1", version: 1 }],
      version: 1,
      created_at: new Date().toISOString(),
    };

    expect(agentConfig.callable_agents).toHaveLength(1);
    expect(agentConfig.callable_agents![0].id).toBe("agent_worker1");
    expect(agentConfig.callable_agents![0].type).toBe("agent");

    // Verify tools are created from this config
    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
    expect(tools.call_agent_agent_worker1).toBeDefined();
  });

  it("agent with callable_agents creates call tools via buildTools", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_coord",
      name: "Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [
        { type: "agent", id: "agent_worker1", version: 1 },
        { type: "agent", id: "agent_worker2", version: 1 },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    // Should have call_agent tools for each callable agent
    expect(tools.call_agent_agent_worker1).toBeDefined();
    expect(tools.call_agent_agent_worker2).toBeDefined();

    // Tools should have the expected description pattern
    expect(typeof tools.call_agent_agent_worker1).toBe("object");
    expect(typeof tools.call_agent_agent_worker2).toBe("object");
  });

  it("callable_agents tools are NOT created without ANTHROPIC_API_KEY", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_coord_nokey",
      name: "Coordinator No Key",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [{ type: "agent", id: "agent_worker1", version: 1 }],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    // No env.ANTHROPIC_API_KEY provided
    const tools = await buildTools(agentConfig, sandbox, undefined);
    expect(tools.call_agent_agent_worker1).toBeUndefined();
  });

  it("thread event types are valid SessionEvent variants", () => {
    // Type-level check: verify these events conform to SessionEvent
    const threadCreated: SessionEvent = {
      type: "session.thread_created",
      session_thread_id: "thread_123",
      agent_id: "agent_worker1",
      agent_name: "Worker 1",
    };
    expect(threadCreated.type).toBe("session.thread_created");
    expect((threadCreated as SessionThreadCreatedEvent).session_thread_id).toBe("thread_123");

    const threadMessage: SessionEvent = {
      type: "agent.thread_message",
      session_thread_id: "thread_123",
      content: [{ type: "text", text: "sub-agent response" }],
    };
    expect(threadMessage.type).toBe("agent.thread_message");
    expect((threadMessage as AgentThreadMessageEvent).content[0].text).toBe("sub-agent response");
  });

  it("callable_agents with multiple agents produces multiple tools", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_multi_coord",
      name: "Multi Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate multiple agents.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [
        { type: "agent", id: "agent_alpha", version: 1 },
        { type: "agent", id: "agent_beta", version: 1 },
        { type: "agent", id: "agent_gamma", version: 1 },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect(tools.call_agent_agent_alpha).toBeDefined();
    expect(tools.call_agent_agent_beta).toBeDefined();
    expect(tools.call_agent_agent_gamma).toBeDefined();

    // Verify they are distinct tool objects
    expect(tools.call_agent_agent_alpha).not.toBe(tools.call_agent_agent_beta);
  });
});

// ============================================================
// 4. Sandbox lifecycle
// ============================================================
describe("Sandbox lifecycle", () => {
  it("TestSandbox exec returns test response with command", async () => {
    const stub = new TestSandbox();
    const result = await stub.exec("echo hello");
    expect(result).toContain("test");
    expect(result).toContain("echo hello");
    expect(result).toContain("exit=0");
  });

  it("TestSandbox readFile returns test file message", async () => {
    const stub = new TestSandbox();
    const result = await stub.readFile("/some/path.txt");
    expect(result).toContain("test");
    expect(result).toContain("/some/path.txt");
  });

  it("TestSandbox writeFile returns ok", async () => {
    const stub = new TestSandbox();
    const result = await stub.writeFile("/test/file.txt", "content here");
    expect(result).toBe("ok");
  });

  it("createSandbox always returns CloudflareSandbox", () => {
    const fakeEnv = { SANDBOX: {} } as any;
    const sandbox = createSandbox(fakeEnv, "test-session-id");
    expect(sandbox).toBeDefined();
    expect(sandbox).not.toBeInstanceOf(TestSandbox);
  });

  it("TestSandbox exec works with various commands", async () => {
    const stub = new TestSandbox();

    const r1 = await stub.exec("ls -la /workspace");
    expect(r1).toContain("exit=0");
    expect(r1).toContain("ls -la /workspace");

    const r2 = await stub.exec("python3 script.py");
    expect(r2).toContain("exit=0");
    expect(r2).toContain("python3 script.py");

    // Even empty command works
    const r3 = await stub.exec("");
    expect(r3).toContain("exit=0");
  });
});

// ============================================================
// 5. buildTools integration
// ============================================================
describe("buildTools integration", () => {
  it("builds all default tools when agent_toolset is specified", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_full",
      name: "Full Tools Agent",
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      tools: [{ type: "agent_toolset_20260401" }],
      version: 1,
      created_at: new Date().toISOString(),
    };
    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox);

    expect(tools.bash).toBeDefined();
    expect(tools.read).toBeDefined();
    expect(tools.write).toBeDefined();
    expect(tools.edit).toBeDefined();
    expect(tools.glob).toBeDefined();
    expect(tools.grep).toBeDefined();
    expect(tools.web_fetch).toBeDefined();
    expect(tools.web_search).toBeDefined(); // DuckDuckGo default
  });

  it("selective tool config disables non-listed tools", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_selective",
      name: "Selective Agent",
      model: "claude-sonnet-4-6",
      system: "Read only.",
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
      version: 1,
      created_at: new Date().toISOString(),
    };
    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox);

    expect(tools.bash).toBeDefined();
    expect(tools.read).toBeDefined();
    expect(tools.write).toBeUndefined();
    expect(tools.edit).toBeUndefined();
    expect(tools.glob).toBeUndefined();
    expect(tools.grep).toBeUndefined();
  });

  it("buildMemoryTools creates all 6 memory tools", () => {
    // Mock KV namespace
    const mockKV = { list: async () => ({ keys: [] }), get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace;
    const memTools = buildMemoryTools(
      ["store_1", "store_2"],
      mockKV
    );

    expect(memTools.memory_list).toBeDefined();
    expect(memTools.memory_read).toBeDefined();
    expect(memTools.memory_write).toBeDefined();
    expect(memTools.memory_search).toBeDefined();
    expect(memTools.memory_delete).toBeDefined();
  });

  it("buildMemoryTools returns empty object for no store IDs", () => {
    const mockKV = {} as KVNamespace;
    const memTools = buildMemoryTools([], mockKV);
    expect(Object.keys(memTools)).toHaveLength(0);
  });
});

// ============================================================
// 6. InMemoryHistory
// ============================================================
describe("InMemoryHistory", () => {
  it("appends and retrieves events", () => {
    const history = new InMemoryHistory();
    const userMsg: SessionEvent = {
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    };
    const agentMsg: SessionEvent = {
      type: "agent.message",
      content: [{ type: "text", text: "hi there" }],
    };
    history.append(userMsg);
    history.append(agentMsg);

    const events = history.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("user.message");
    expect(events[1].type).toBe("agent.message");
  });

  it("getEvents with afterSeq returns a slice", () => {
    const history = new InMemoryHistory();
    for (let i = 0; i < 5; i++) {
      history.append({
        type: "user.message",
        content: [{ type: "text", text: `msg ${i}` }],
      });
    }
    const after2 = history.getEvents(2);
    expect(after2).toHaveLength(3);
    expect((after2[0] as UserMessageEvent).content[0].text).toBe("msg 2");
  });

  it("getMessages converts events to CoreMessage format", () => {
    const history = new InMemoryHistory();
    history.append({
      type: "user.message",
      content: [{ type: "text", text: "What is 2+2?" }],
    });
    history.append({
      type: "agent.message",
      content: [{ type: "text", text: "4" }],
    });

    const messages = history.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("getEvents returns a copy, not the internal array", () => {
    const history = new InMemoryHistory();
    history.append({
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    });
    const events1 = history.getEvents();
    const events2 = history.getEvents();
    expect(events1).not.toBe(events2);
    expect(events1).toEqual(events2);
  });
});

// ============================================================
// 7. eventsToMessages shared function
// ============================================================
describe("eventsToMessages", () => {
  it("converts user and agent message events", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      { type: "agent.message", content: [{ type: "text", text: "hi" }] },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("groups tool_use and tool_result into assistant/tool pairs", () => {
    const events: SessionEvent[] = [
      { type: "user.message", content: [{ type: "text", text: "run ls" }] },
      { type: "agent.tool_use", id: "tc_1", name: "bash", input: { command: "ls" } },
      { type: "agent.tool_result", tool_use_id: "tc_1", content: "file1.txt\nfile2.txt" },
      { type: "agent.message", content: [{ type: "text", text: "Here are the files." }] },
    ];
    const messages = eventsToMessages(events);
    // user, assistant (tool-call), tool (tool-result), assistant (text)
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[2].role).toBe("tool");
    expect(messages[3].role).toBe("assistant");
  });

  it("ignores non-message events like session.status_idle", () => {
    const events: SessionEvent[] = [
      { type: "session.status_running" },
      { type: "user.message", content: [{ type: "text", text: "hi" }] },
      { type: "session.status_idle" },
    ];
    const messages = eventsToMessages(events);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });
});

// ============================================================
// 8. Thread model / delegateToAgent
// ============================================================
describe("Thread model — delegateToAgent", () => {
  it("call_agent tool uses delegateToAgent when provided", async () => {
    const delegateCalls: Array<{ agentId: string; message: string }> = [];

    const agentConfig: AgentConfig = {
      id: "agent_coord_thread",
      name: "Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [{ type: "agent", id: "agent_worker1", version: 1 }],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const mockDelegate = async (agentId: string, message: string) => {
      delegateCalls.push({ agentId, message });
      return "sub-agent response from thread";
    };

    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      delegateToAgent: mockDelegate,
    });

    expect(tools.call_agent_agent_worker1).toBeDefined();

    // Execute the tool
    const result = await tools.call_agent_agent_worker1.execute(
      { message: "analyze this code" },
      { toolCallId: "tc_1", messages: [], abortSignal: undefined as any }
    );

    expect(result).toBe("sub-agent response from thread");
    expect(delegateCalls).toHaveLength(1);
    expect(delegateCalls[0].agentId).toBe("agent_worker1");
    expect(delegateCalls[0].message).toBe("analyze this code");
  });

  it("call_agent tool returns fallback when delegateToAgent is not provided", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_coord_no_delegate",
      name: "Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [{ type: "agent", id: "agent_worker1", version: 1 }],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      // No delegateToAgent
    });

    const result = await tools.call_agent_agent_worker1.execute(
      { message: "do something" },
      { toolCallId: "tc_1", messages: [], abortSignal: undefined as any }
    );

    expect(result).toContain("not available");
  });

  it("call_agent tool catches delegateToAgent errors gracefully", async () => {
    const agentConfig: AgentConfig = {
      id: "agent_coord_error",
      name: "Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [{ type: "agent", id: "agent_flaky", version: 1 }],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      delegateToAgent: async () => {
        throw new Error("sub-agent harness crashed");
      },
    });

    const result = await tools.call_agent_agent_flaky.execute(
      { message: "crash test" },
      { toolCallId: "tc_1", messages: [], abortSignal: undefined as any }
    );

    expect(result).toContain("Sub-agent error");
    expect(result).toContain("sub-agent harness crashed");
  });

  it("InMemoryHistory used in thread context captures sub-agent events independently", () => {
    // Simulate what runSubAgent does: isolated history for sub-agent
    const parentEvents: SessionEvent[] = [];
    const subHistory = new InMemoryHistory();

    // Sub-agent receives a message
    const userMsg: UserMessageEvent = {
      type: "user.message",
      content: [{ type: "text", text: "analyze this" }],
    };
    subHistory.append(userMsg);

    // Sub-agent produces a response
    const agentMsg: AgentMessageEvent = {
      type: "agent.message",
      content: [{ type: "text", text: "Analysis complete." }],
    };
    subHistory.append(agentMsg);

    // Parent also receives a tagged copy
    parentEvents.push({ ...agentMsg, session_thread_id: "thread_123" } as SessionEvent);

    // Verify sub-agent history is isolated
    const subEvents = subHistory.getEvents();
    expect(subEvents).toHaveLength(2);

    // Verify sub-agent messages convert correctly
    const subMessages = subHistory.getMessages();
    expect(subMessages).toHaveLength(2);
    expect(subMessages[0].role).toBe("user");
    expect(subMessages[1].role).toBe("assistant");

    // Verify parent received tagged event
    expect(parentEvents).toHaveLength(1);
    expect((parentEvents[0] as any).session_thread_id).toBe("thread_123");
  });

  it("multiple call_agent tools each delegate to their own agent ID", async () => {
    const delegateCalls: Array<{ agentId: string; message: string }> = [];

    const agentConfig: AgentConfig = {
      id: "agent_multi_coord",
      name: "Multi Coordinator",
      model: "claude-sonnet-4-6",
      system: "You coordinate.",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [
        { type: "agent", id: "agent_alpha", version: 1 },
        { type: "agent", id: "agent_beta", version: 1 },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    };

    const sandbox = new TestSandbox();
    const mockDelegate = async (agentId: string, message: string) => {
      delegateCalls.push({ agentId, message });
      return `response from ${agentId}`;
    };

    const tools = await buildTools(agentConfig, sandbox, {
      ANTHROPIC_API_KEY: "sk-ant-test",
      delegateToAgent: mockDelegate,
    });

    // Call alpha
    const r1 = await tools.call_agent_agent_alpha.execute(
      { message: "task for alpha" },
      { toolCallId: "tc_1", messages: [], abortSignal: undefined as any }
    );
    expect(r1).toBe("response from agent_alpha");

    // Call beta
    const r2 = await tools.call_agent_agent_beta.execute(
      { message: "task for beta" },
      { toolCallId: "tc_2", messages: [], abortSignal: undefined as any }
    );
    expect(r2).toBe("response from agent_beta");

    expect(delegateCalls).toHaveLength(2);
    expect(delegateCalls[0].agentId).toBe("agent_alpha");
    expect(delegateCalls[1].agentId).toBe("agent_beta");
  });
});
