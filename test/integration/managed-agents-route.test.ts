import Anthropic from "@anthropic-ai/sdk";
import { exports } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createManagedEnvironmentWorker,
  type ManagedRuntimeHost,
  type ManagedRuntimeProfile,
} from "@open-managed-agents/managed-runtime-host";
import { withAnthropicFormDataSupport } from "../anthropic-sdk-fetch";
import { verifyManagedAgentsClientStateModel } from "../model/managed-agents-client-state-model";

const SKILL_MARKDOWN = `---
name: repository-guide
description: How to work in this repository
---
# Repository guide
`;

const workerFetch: typeof fetch = withAnthropicFormDataSupport(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const source =
      input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
    const url = new URL(source.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fetch(source);
    }
    return exports.default.fetch(
      new Request(`http://localhost${url.pathname}${url.search}`, source),
    );
  },
);

beforeAll(async () => {
  await workerFetch("http://localhost/health");
});

async function mintEnvironmentKey(
  environmentId: string,
  fetchImpl: typeof fetch = workerFetch,
): Promise<string> {
  const response = await fetchImpl("http://localhost/v1/oma/api_keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key",
    },
    body: JSON.stringify({
      name: `worker-${crypto.randomUUID()}`,
      environment_id: environmentId,
    }),
  });
  if (!response.ok) {
    throw new Error(`Environment key creation failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { key?: unknown };
  if (typeof body.key !== "string" || !body.key.startsWith("oma_env_")) {
    throw new Error("Environment key creation returned an invalid credential");
  }
  return body.key;
}

describe("Cloudflare official Managed Agents route", () => {
  it("serves an exact official SDK create and retrieve shape", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const modelId = `route-test-model-${crypto.randomUUID()}`;
    const modelCard = await workerFetch("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        provider: "ant",
        model_id: modelId,
        api_key: "sk-ant-route-test-key",
      }),
    });
    expect(modelCard.status).toBe(201);

    const created = await client.beta.agents.create({
      name: "Cloudflare Managed Agent",
      model: modelId,
      metadata: { owner: "platform" },
    });
    const retrieved = await client.beta.agents.retrieve(created.id);

    expect(created).toMatchObject({
      id: expect.stringMatching(/^agent_/),
      type: "agent",
      name: "Cloudflare Managed Agent",
      model: { id: modelId },
      metadata: { owner: "platform" },
      version: 1,
    });
    expect(Object.keys(created).sort()).toEqual([
      "archived_at",
      "created_at",
      "description",
      "id",
      "mcp_servers",
      "metadata",
      "model",
      "multiagent",
      "name",
      "skills",
      "system",
      "tools",
      "type",
      "updated_at",
      "version",
    ]);
    expect(retrieved).toEqual(created);

    const models = await client.beta.models.list({ limit: 100 });
    const retrievedModel = await client.beta.models.retrieve(modelId);
    expect(models.data).toContainEqual(retrievedModel);
    expect(retrievedModel).toEqual({
      id: modelId,
      allowed_fallback_models: null,
      capabilities: null,
      created_at: expect.any(String),
      display_name: modelId,
      max_input_tokens: null,
      max_tokens: null,
      type: "model",
    });
    const omaModels = await workerFetch(
      "http://localhost/v1/oma/models/list",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
        },
        body: JSON.stringify({ provider: "unknown", api_key: "unused" }),
      },
    );
    expect(omaModels.status).toBe(200);
    expect(await omaModels.json()).toEqual({ data: [] });
    const omaModelsOnOfficialPath = await workerFetch(
      "http://localhost/v1/models/list",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
        },
        body: JSON.stringify({ provider: "ant", api_key: "unused" }),
      },
    );
    expect(omaModelsOnOfficialPath.status).toBe(404);

    const createdEnvironment = await client.beta.environments.create({
      name: "Cloudflare managed environment",
      description: "Cloudflare official environment",
      metadata: { owner: "platform" },
      scope: "organization",
      config: { type: "self_hosted" },
    });
    const retrievedEnvironment = await client.beta.environments.retrieve(
      createdEnvironment.id,
    );

    expect(createdEnvironment).toMatchObject({
      id: expect.stringMatching(/^env_/),
      type: "environment",
      name: "Cloudflare managed environment",
      description: "Cloudflare official environment",
      metadata: { owner: "platform" },
      scope: "organization",
      config: { type: "self_hosted" },
    });
    expect(retrievedEnvironment).toEqual(createdEnvironment);

    const uploadedFile = await client.beta.files.upload({
      file: new File(["hello from cf"], "notes.txt", {
        type: "text/plain",
      }),
    });
    const retrievedFile = await client.beta.files.retrieveMetadata(
      uploadedFile.id,
    );
    const downloadedFile = await client.beta.files.download(uploadedFile.id);

    expect(uploadedFile).toMatchObject({
      id: expect.stringMatching(/^file_/),
      type: "file",
      filename: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 13,
      downloadable: true,
    });
    expect(retrievedFile).toEqual(uploadedFile);
    expect(await downloadedFile.text()).toBe("hello from cf");

    const createdMemoryStore = await client.beta.memoryStores.create({
      name: "Cloudflare project memory",
      description: "Cloudflare official memory store",
      metadata: { owner: "platform" },
    });
    const retrievedMemoryStore = await client.beta.memoryStores.retrieve(
      createdMemoryStore.id,
    );

    expect(createdMemoryStore).toMatchObject({
      id: expect.stringMatching(/^memstore_/),
      type: "memory_store",
      name: "Cloudflare project memory",
      description: "Cloudflare official memory store",
      metadata: { owner: "platform" },
      archived_at: null,
    });
    expect(retrievedMemoryStore).toEqual(createdMemoryStore);

    const createdMemory = await client.beta.memoryStores.memories.create(
      createdMemoryStore.id,
      {
        content: "hello from managed memory",
        path: "/notes/one.md",
        view: "full",
      },
    );
    const retrievedMemory = await client.beta.memoryStores.memories.retrieve(
      createdMemory.id,
      { memory_store_id: createdMemoryStore.id, view: "full" },
    );
    const retrievedMemoryVersion =
      await client.beta.memoryStores.memoryVersions.retrieve(
        createdMemory.memory_version_id,
        { memory_store_id: createdMemoryStore.id, view: "full" },
      );

    expect(createdMemory).toMatchObject({
      id: expect.stringMatching(/^mem_/),
      type: "memory",
      content: "hello from managed memory",
      content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      content_size_bytes: 25,
      memory_store_id: createdMemoryStore.id,
      memory_version_id: expect.stringMatching(/^memver_/),
      path: "/notes/one.md",
    });
    expect(retrievedMemory).toEqual(createdMemory);
    expect(retrievedMemoryVersion).toMatchObject({
      id: createdMemory.memory_version_id,
      type: "memory_version",
      content: "hello from managed memory",
      memory_id: createdMemory.id,
      memory_store_id: createdMemoryStore.id,
      operation: "created",
      path: createdMemory.path,
    });

    const createdDream = await client.beta.dreams.create({
      inputs: [
        { type: "memory_store", memory_store_id: createdMemoryStore.id },
      ],
      model: modelId,
      instructions: "Keep durable project decisions",
    });
    expect(createdDream).toMatchObject({
      id: expect.stringMatching(/^dream_/),
      type: "dream",
      status: "pending",
      error: null,
      inputs: [
        { type: "memory_store", memory_store_id: createdMemoryStore.id },
      ],
      model: { id: modelId },
      output_behavior: { type: "create_new" },
      outputs: [],
    });
    const completedDream = await waitForTerminalDream(
      () => client.beta.dreams.retrieve(createdDream.id),
    );
    expect(completedDream).toMatchObject({
      id: createdDream.id,
      status: "completed",
      error: null,
      ended_at: expect.any(String),
      outputs: [
        {
          type: "memory_store",
          memory_store_id: expect.stringMatching(/^memstore_/),
        },
      ],
    });
    const outputMemoryStoreId = completedDream.outputs[0]!.memory_store_id;
    const outputMemories = await client.beta.memoryStores.memories.list(
      outputMemoryStoreId,
      { view: "full" },
    );
    expect(outputMemories.data).toMatchObject([
      { path: "/notes/one.md", content: "hello from managed memory" },
    ]);
    const dreamsPage = await client.beta.dreams.list({ statuses: ["completed"] });
    expect(dreamsPage.data).toEqual([completedDream]);
    const archivedDream = await client.beta.dreams.archive(createdDream.id);
    expect(archivedDream).toMatchObject({
      id: createdDream.id,
      archived_at: expect.any(String),
      status: "completed",
    });

    const createdSkill = await client.beta.skills.create({
      display_title: "Repository guide",
      files: [
        new File([SKILL_MARKDOWN], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
        new File(["reference"], "repository-guide/reference.txt", {
          type: "text/plain",
        }),
      ],
    });
    const retrievedSkill = await client.beta.skills.retrieve(createdSkill.id);
    const initialSkillVersion = await client.beta.skills.versions.retrieve(
      createdSkill.latest_version!,
      { skill_id: createdSkill.id },
    );
    const downloadedSkillVersion = await client.beta.skills.versions.download(
      createdSkill.latest_version!,
      { skill_id: createdSkill.id },
    );

    expect(createdSkill).toMatchObject({
      id: expect.stringMatching(/^skill_/),
      type: "skill",
      display_title: "Repository guide",
      latest_version: expect.any(String),
      source: "custom",
    });
    expect(retrievedSkill).toEqual(createdSkill);
    expect(initialSkillVersion).toMatchObject({
      id: expect.stringMatching(/^skv_/),
      type: "skill_version",
      description: "How to work in this repository",
      directory: "repository-guide",
      name: "repository-guide",
      skill_id: createdSkill.id,
      version: createdSkill.latest_version,
    });
    expect(
      Object.keys(
        unzipSync(new Uint8Array(await downloadedSkillVersion.arrayBuffer())),
      ).sort(),
    ).toEqual([
      "repository-guide/SKILL.md",
      "repository-guide/reference.txt",
    ]);

    const createdVault = await client.beta.vaults.create({
      display_name: "Cloudflare production credentials",
      metadata: { owner: "platform" },
    });
    const retrievedVault = await client.beta.vaults.retrieve(createdVault.id);

    expect(createdVault).toMatchObject({
      id: expect.stringMatching(/^vlt_/),
      type: "vault",
      display_name: "Cloudflare production credentials",
      metadata: { owner: "platform" },
      archived_at: null,
    });
    expect(retrievedVault).toEqual(createdVault);

    const createdCredential = await client.beta.vaults.credentials.create(
      createdVault.id,
      {
        auth: {
          type: "static_bearer",
          token: "cf-bearer-secret",
          mcp_server_url: "https://mcp.example.com/sse",
        },
        display_name: "Cloudflare MCP bearer",
        metadata: { owner: "platform" },
      },
    );
    const retrievedCredential = await client.beta.vaults.credentials.retrieve(
      createdCredential.id,
      { vault_id: createdVault.id },
    );

    expect(createdCredential).toEqual({
      id: expect.stringMatching(/^vcrd_/),
      archived_at: null,
      auth: {
        type: "static_bearer",
        mcp_server_url: "https://mcp.example.com/sse",
      },
      created_at: expect.any(String),
      display_name: "Cloudflare MCP bearer",
      metadata: { owner: "platform" },
      type: "vault_credential",
      updated_at: expect.any(String),
      vault_id: createdVault.id,
    });
    expect(retrievedCredential).toEqual(createdCredential);
    expect(JSON.stringify(createdCredential)).not.toContain("cf-bearer-secret");

    const createdTunnel = await client.beta.tunnels.create({
      display_name: "Cloudflare production gateway",
    });
    expect(createdTunnel).toEqual({
      id: expect.stringMatching(/^tnl_/),
      archived_at: null,
      created_at: expect.any(String),
      display_name: "Cloudflare production gateway",
      domain: expect.stringMatching(/\.tunnels\.localhost$/),
      type: "tunnel",
    });
    await expect(client.beta.tunnels.retrieve(createdTunnel.id)).resolves.toEqual(
      createdTunnel,
    );
    const revealedTunnelToken = await client.beta.tunnels.revealToken(
      createdTunnel.id,
    );
    expect(revealedTunnelToken).toMatchObject({
      id: expect.stringMatching(/^ttok_/),
      tunnel_token: expect.stringMatching(/^tnl_tok_/),
      type: "tunnel_token",
    });
    const rotatedTunnelToken = await client.beta.tunnels.rotateToken(
      createdTunnel.id,
      { reason: "Cloudflare e2e rotation" },
    );
    expect(rotatedTunnelToken.id).not.toBe(revealedTunnelToken.id);
    expect(rotatedTunnelToken.tunnel_token).not.toBe(
      revealedTunnelToken.tunnel_token,
    );
    await expect(
      client.beta.tunnels.revealToken(createdTunnel.id),
    ).resolves.toEqual(rotatedTunnelToken);
    const createdTunnelCertificate =
      await client.beta.tunnels.certificates.create(createdTunnel.id, {
        ca_certificate_pem: testCertificatePem(),
      });
    expect(createdTunnelCertificate).toEqual({
      id: expect.stringMatching(/^tcrt_/),
      archived_at: null,
      created_at: expect.any(String),
      expires_at: null,
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      tunnel_id: createdTunnel.id,
      type: "tunnel_certificate",
    });
    await expect(
      client.beta.tunnels.certificates.retrieve(createdTunnelCertificate.id, {
        tunnel_id: createdTunnel.id,
      }),
    ).resolves.toEqual(createdTunnelCertificate);
    const tunnelCertificatePage =
      await client.beta.tunnels.certificates.list(createdTunnel.id);
    expect(tunnelCertificatePage.data).toEqual([createdTunnelCertificate]);
    const archivedTunnelCertificate =
      await client.beta.tunnels.certificates.archive(
        createdTunnelCertificate.id,
        { tunnel_id: createdTunnel.id },
      );
    expect(archivedTunnelCertificate.archived_at).toEqual(expect.any(String));
    const archivedTunnel = await client.beta.tunnels.archive(createdTunnel.id);
    expect(archivedTunnel).toMatchObject({
      id: createdTunnel.id,
      archived_at: expect.any(String),
    });

    const createdUserProfile = await client.beta.userProfiles.create({
      access_type: "application",
      external_id: "cf-customer-01",
      metadata: { owner: "platform" },
      name: "Cloudflare Customer",
      relationship: "external",
    });
    const retrievedUserProfile = await client.beta.userProfiles.retrieve(
      createdUserProfile.id,
    );

    expect(createdUserProfile).toEqual({
      id: expect.stringMatching(/^uprof_/),
      created_at: expect.any(String),
      metadata: { owner: "platform" },
      trust_grants: {},
      type: "user_profile",
      updated_at: expect.any(String),
      access_type: "application",
      external_id: "cf-customer-01",
      name: "Cloudflare Customer",
      relationship: "external",
    });
    expect(retrievedUserProfile).toEqual(createdUserProfile);

    const createdDeployment = await client.beta.deployments.create({
      agent: { type: "agent", id: created.id, version: created.version },
      environment_id: createdEnvironment.id,
      initial_events: [
        {
          type: "system.message",
          content: [{ type: "text", text: "Use read-only checks" }],
        },
      ],
      name: "cf-repository-maintenance",
      metadata: { owner: "platform" },
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
      },
      vault_ids: [createdVault.id],
    });
    const retrievedDeployment = await client.beta.deployments.retrieve(
      createdDeployment.id,
    );

    expect(createdDeployment).toMatchObject({
      id: expect.stringMatching(/^depl_/),
      type: "deployment",
      agent: {
        id: created.id,
        type: "agent",
        version: created.version,
      },
      environment_id: createdEnvironment.id,
      name: "cf-repository-maintenance",
      status: "active",
      schedule: {
        type: "cron",
        expression: "0 9 * * 1-5",
        timezone: "UTC",
        upcoming_runs_at: expect.any(Array),
      },
      vault_ids: [createdVault.id],
    });
    expect(retrievedDeployment).toEqual(createdDeployment);
    const pausedDeployment = await client.beta.deployments.pause(
      createdDeployment.id,
    );
    expect(pausedDeployment).toMatchObject({
      status: "paused",
      paused_reason: { type: "manual" },
    });
    const unpausedDeployment = await client.beta.deployments.unpause(
      createdDeployment.id,
    );
    expect(unpausedDeployment).toMatchObject({
      status: "active",
      paused_reason: null,
    });
    const deploymentRun = await client.beta.deployments.run(
      createdDeployment.id,
    );
    expect(deploymentRun).toMatchObject({
      id: expect.stringMatching(/^drun_/),
      type: "deployment_run",
      deployment_id: createdDeployment.id,
      session_id: expect.stringMatching(/^session_/),
      trigger_context: { type: "manual" },
      error: null,
    });
    await expect(
      client.beta.deploymentRuns.retrieve(deploymentRun.id),
    ).resolves.toEqual(deploymentRun);

    const polledWork = await client.beta.environments.work.poll(
      createdEnvironment.id,
      { "Anthropic-Worker-ID": "cf-worker-01" },
    );
    expect(polledWork).not.toBeNull();
    if (polledWork === null) throw new Error("Expected queued Environment Work");
    expect(polledWork).toMatchObject({
      id: expect.stringMatching(/^work_/),
      type: "work",
      data: { type: "session", id: deploymentRun.session_id },
      environment_id: createdEnvironment.id,
      secret: expect.any(String),
      state: "queued",
    });
    expect(decodeWorkSecret(polledWork.secret!)).toEqual({
      sessions_token: expect.stringMatching(/^sk-ant-req-/),
      api_base_url: "http://localhost",
    });
    expect(
      await client.beta.environments.work.retrieve(polledWork.id, {
        environment_id: createdEnvironment.id,
      }),
    ).toEqual({ ...polledWork, secret: null });
    expect(
      await client.beta.environments.work.update(polledWork.id, {
        environment_id: createdEnvironment.id,
        metadata: { worker: "cf-worker-01" },
      }),
    ).toMatchObject({ metadata: { worker: "cf-worker-01" }, secret: null });
    const workPage = await client.beta.environments.work.list(
      createdEnvironment.id,
    );
    expect(workPage.data).toHaveLength(1);
    expect(workPage.data[0]).toMatchObject({ id: polledWork.id, secret: null });
    await expect(
      client.beta.environments.work.stats(createdEnvironment.id),
    ).resolves.toEqual({
      type: "work_queue_stats",
      depth: 0,
      pending: 1,
      oldest_queued_at: expect.any(String),
      workers_polling: 1,
    });
    const acknowledgedWork = await client.beta.environments.work.ack(
      polledWork.id,
      { environment_id: createdEnvironment.id },
    );
    expect(acknowledgedWork).toMatchObject({
      id: polledWork.id,
      state: "starting",
      acknowledged_at: expect.any(String),
      secret: null,
    });
    const heartbeat = await client.beta.environments.work.heartbeat(
      polledWork.id,
      {
        environment_id: createdEnvironment.id,
        desired_ttl_seconds: 120,
        expected_last_heartbeat: "NO_HEARTBEAT",
      },
    );
    expect(heartbeat).toEqual({
      type: "work_heartbeat",
      last_heartbeat: expect.any(String),
      lease_extended: true,
      state: "active",
      ttl_seconds: 120,
    });
    const stoppedWork = await client.beta.environments.work.stop(
      polledWork.id,
      { environment_id: createdEnvironment.id, force: true },
    );
    expect(stoppedWork).toMatchObject({
      id: polledWork.id,
      state: "stopped",
      stop_requested_at: expect.any(String),
      stopped_at: expect.any(String),
      secret: null,
    });
    await expect(
      client.beta.environments.work.stats(createdEnvironment.id),
    ).resolves.toEqual({
      type: "work_queue_stats",
      depth: 0,
      pending: 0,
      oldest_queued_at: null,
      workers_polling: 1,
    });

    const createdSession = await client.beta.sessions.create({
      agent: { type: "agent", id: created.id, version: created.version },
      environment_id: "env-local-runtime",
      title: "Cloudflare managed session",
    });
    const retrievedSession = await client.beta.sessions.retrieve(
      createdSession.id,
    );

    expect(createdSession).toMatchObject({
      id: expect.stringMatching(/^session_/),
      type: "session",
      agent: {
        id: created.id,
        type: "agent",
        version: created.version,
      },
      environment_id: "env-local-runtime",
      title: "Cloudflare managed session",
      status: "running",
    });
    expect(retrievedSession).toEqual(createdSession);
    expect(await client.beta.sessions.delete(createdSession.id)).toEqual({
      id: createdSession.id,
      type: "session_deleted",
    });
  });

  it("refines the official SDK client state model under conflicts", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const modelId = `state-model-${suffix}`;
    const modelCard = await workerFetch("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        provider: "ant",
        model_id: modelId,
        api_key: "sk-ant-state-model-key",
      }),
    });
    expect(modelCard.status).toBe(201);

    await verifyManagedAgentsClientStateModel({
      client,
      model: modelId,
      prefix: `cf-${suffix}`,
    });
  }, 60_000);

  it("accepts the official worker's environment bearer and scopes its per-work sessions token", async () => {
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const modelId = `worker-auth-${suffix}`;
    const modelCard = await workerFetch("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        provider: "ant",
        model_id: modelId,
        api_key: "sk-ant-worker-auth-test-key",
      }),
    });
    expect(modelCard.status).toBe(201);
    const environment = await client.beta.environments.create({
      name: `worker-auth-${suffix}`,
      config: { type: "self_hosted" },
    });
    const environmentKey = await mintEnvironmentKey(environment.id);
    const attachedFile = await client.beta.files.upload({
      file: new File(["cloudflare work input"], "input.txt", {
        type: "text/plain",
      }),
    });
    const attachedSkill = await client.beta.skills.create({
      display_title: "Cloudflare worker skill",
      files: [
        new File([SKILL_MARKDOWN], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
      ],
    });
    const attachedMemoryStore = await client.beta.memoryStores.create({
      name: `worker-memory-${suffix}`,
    });
    const attachedMemory = await client.beta.memoryStores.memories.create(
      attachedMemoryStore.id,
      {
        content: "cloudflare worker memory",
        path: "/input.md",
        view: "full",
      },
    );
    const agent = await client.beta.agents.create({
      name: `worker-auth-${suffix}`,
      model: modelId,
      skills: [{
        type: "custom",
        skill_id: attachedSkill.id,
        version: "latest",
      }],
    });
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: "Official worker bearer auth",
      resources: [
        { type: "file", file_id: attachedFile.id },
        {
          type: "memory_store",
          memory_store_id: attachedMemoryStore.id,
          access: "read_only",
        },
      ],
    });

    const poller = client.beta.environments.work.poller({
      environmentId: environment.id,
      environmentKey,
      workerId: `worker-${suffix}`,
      blockMs: null,
      autoStop: false,
    });
    const iterator = poller[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    const work = next.value!;
    const secret = decodeWorkSecret(work.secret!);
    const sessionsToken = secret.sessions_token;
    expect(sessionsToken).toMatch(/^sk-ant-req-v1\./);

    const sessionClient = new Anthropic({
      apiKey: null,
      authToken: String(sessionsToken),
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    await expect(sessionClient.beta.sessions.retrieve(session.id)).resolves.toMatchObject({
      id: session.id,
      environment_id: environment.id,
    });
    await expect(
      sessionClient.beta.sessions.events.list(session.id),
    ).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(
      sessionClient.beta.files.download(attachedFile.id).then((file) => file.text()),
    ).resolves.toBe("cloudflare work input");
    const versions = await sessionClient.beta.skills.versions.list(attachedSkill.id);
    expect(versions.data).toHaveLength(1);
    await expect(
      sessionClient.beta.skills.versions.download(versions.data[0]!.version, {
        skill_id: attachedSkill.id,
      }).then((file) => file.arrayBuffer()),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(
      sessionClient.beta.memoryStores.memories.list(attachedMemoryStore.id, {
        view: "full",
      }),
    ).resolves.toMatchObject({
      data: [expect.objectContaining({
        id: attachedMemory.id,
        content: "cloudflare worker memory",
      })],
    });
    await expect(
      sessionClient.beta.memoryStores.memories.create(attachedMemoryStore.id, {
        content: "must remain read-only",
        path: "/denied.md",
      }),
    ).rejects.toMatchObject({ status: 401 });

    const unrelated = await workerFetch("http://localhost/v1/agents", {
      headers: { Authorization: `Bearer ${sessionsToken}` },
    });
    expect(unrelated.status).toBe(401);
    const tampered = await workerFetch(`http://localhost/v1/sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${sessionsToken}tampered` },
    });
    expect(tampered.status).toBe(401);

    await expect(
      sessionClient.beta.environments.work.heartbeat(work.id, {
        environment_id: environment.id,
        desired_ttl_seconds: 90,
      }),
    ).resolves.toMatchObject({ type: "work_heartbeat", lease_extended: true });
    await expect(
      sessionClient.beta.environments.work.stop(work.id, {
        environment_id: environment.id,
        force: true,
      }),
    ).resolves.toMatchObject({ id: work.id, state: "stopped" });
    poller.abort();
    await iterator.return?.();
  }, 60_000);

  it("reclaims an expired acknowledged lease once across competing official SDK workers", async () => {
    const parent = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const modelId = `worker-reclaim-${suffix}`;
    const modelCard = await workerFetch("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        provider: "ant",
        model_id: modelId,
        api_key: "sk-ant-worker-reclaim-test-key",
      }),
    });
    expect(modelCard.status).toBe(201);
    const environment = await parent.beta.environments.create({
      name: `worker-reclaim-${suffix}`,
      config: { type: "self_hosted" },
    });
    const environmentKey = await mintEnvironmentKey(environment.id);
    const worker = new Anthropic({
      apiKey: null,
      authToken: environmentKey,
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const agent = await parent.beta.agents.create({
      name: `worker-reclaim-${suffix}`,
      model: modelId,
    });
    const session = await parent.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: "Official worker reclaim",
    });

    const originallyClaimed = await worker.beta.environments.work.poll(
      environment.id,
      { "Anthropic-Worker-ID": `dead-${suffix}` },
    );
    expect(originallyClaimed).not.toBeNull();
    if (originallyClaimed === null) throw new Error("expected work");
    const originalSessionsToken = String(
      decodeWorkSecret(originallyClaimed.secret!).sessions_token,
    );
    await worker.beta.environments.work.ack(originallyClaimed.id, {
      environment_id: environment.id,
    });
    const originalHeartbeat = await worker.beta.environments.work.heartbeat(
      originallyClaimed.id,
      {
        environment_id: environment.id,
        desired_ttl_seconds: 0,
        expected_last_heartbeat: "NO_HEARTBEAT",
      },
    );

    const replacements = await Promise.all([
      worker.beta.environments.work.poll(environment.id, {
        "Anthropic-Worker-ID": `replacement-a-${suffix}`,
        reclaim_older_than_ms: 5_000,
      }),
      worker.beta.environments.work.poll(environment.id, {
        "Anthropic-Worker-ID": `replacement-b-${suffix}`,
        reclaim_older_than_ms: 5_000,
      }),
    ]);
    expect(replacements.filter((candidate) => candidate !== null)).toHaveLength(1);
    const replacement = replacements.find((candidate) => candidate !== null);
    if (replacement === undefined || replacement === null) {
      throw new Error("expected one replacement claim");
    }
    expect(replacement).toMatchObject({
      id: originallyClaimed.id,
      acknowledged_at: null,
      latest_heartbeat_at: null,
      started_at: null,
      state: "queued",
    });
    const replacementSessionsToken = String(
      decodeWorkSecret(replacement.secret!).sessions_token,
    );
    expect(replacementSessionsToken).not.toBe(originalSessionsToken);

    await expect(worker.beta.environments.work.heartbeat(originallyClaimed.id, {
      environment_id: environment.id,
      expected_last_heartbeat: originalHeartbeat.last_heartbeat,
    })).rejects.toMatchObject({ status: 412 });
    await worker.beta.environments.work.ack(replacement.id, {
      environment_id: environment.id,
    });
    const staleSessionClient = new Anthropic({
      apiKey: null,
      authToken: originalSessionsToken,
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    const replacementSessionClient = new Anthropic({
      apiKey: null,
      authToken: replacementSessionsToken,
      baseURL: "http://localhost",
      fetch: workerFetch,
      maxRetries: 0,
    });
    await expect(staleSessionClient.beta.sessions.events.send(session.id, {
      events: [{
        type: "system.message",
        content: [{ type: "text", text: "stale executor must be fenced" }],
      }],
    })).rejects.toMatchObject({ status: 401 });
    await expect(
      replacementSessionClient.beta.sessions.events.list(session.id),
    ).resolves.toMatchObject({ data: expect.any(Array) });
    const runtimeEventId = `runtime-${suffix}`;
    const runtimeRequest = (token: string, eventId: string) => workerFetch(
      `http://localhost/v1/oma/sessions/${session.id}/runtime-events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: [{
            id: eventId,
            type: "session.status_idle",
            processed_at: new Date().toISOString(),
            stop_reason: { type: "end_turn" },
          }],
        }),
      },
    );
    await expect(runtimeRequest(
      originalSessionsToken,
      `runtime-stale-${suffix}`,
    )).resolves.toMatchObject({ status: 401 });
    const runtimeIngress = await runtimeRequest(
      replacementSessionsToken,
      runtimeEventId,
    );
    expect(runtimeIngress.status).toBe(200);
    await expect(runtimeIngress.json()).resolves.toEqual({
      data: [{ id: runtimeEventId }],
    });
    const runtimeHistory = await replacementSessionClient.beta.sessions.events.list(
      session.id,
      { types: ["session.status_idle"] },
    );
    expect(runtimeHistory.data).toContainEqual(expect.objectContaining({
      id: runtimeEventId,
      type: "session.status_idle",
    }));
    await expect(worker.beta.environments.work.heartbeat(replacement.id, {
      environment_id: environment.id,
      expected_last_heartbeat: "NO_HEARTBEAT",
    })).resolves.toMatchObject({
      type: "work_heartbeat",
      state: "active",
      lease_extended: true,
    });
    await worker.beta.environments.work.stop(replacement.id, {
      environment_id: environment.id,
      force: true,
    });
    await expect(runtimeRequest(
      replacementSessionsToken,
      `runtime-after-stop-${suffix}`,
    )).resolves.toMatchObject({ status: 401 });
  }, 60_000);

  it("recovers a lost webhook and crashed host through one fenced replacement", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const requestTrace: Array<{ method: string; path: string; status: number }> = [];
    const tracedWorkerFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request
        ? input
        : new Request(input instanceof URL ? input.toString() : input, init);
      const response = await workerFetch(input, init);
      requestTrace.push({
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    };
    const parent = new Anthropic({
      apiKey: "test-key",
      baseURL: "http://localhost",
      fetch: tracedWorkerFetch,
      maxRetries: 0,
    });
    const modelId = `worker-chaos-${suffix}`;
    const modelCard = await workerFetch("http://localhost/v1/oma/model_cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        provider: "ant",
        model_id: modelId,
        api_key: "sk-ant-worker-chaos-test-key",
      }),
    });
    expect(modelCard.status).toBe(201);
    const environment = await parent.beta.environments.create({
      name: `worker-chaos-${suffix}`,
      config: { type: "self_hosted" },
    });
    const environmentKey = await mintEnvironmentKey(
      environment.id,
      tracedWorkerFetch,
    );
    const runner = new Anthropic({
      apiKey: null,
      authToken: environmentKey,
      baseURL: "http://localhost",
      fetch: tracedWorkerFetch,
      maxRetries: 0,
    });
    const agent = await parent.beta.agents.create({
      name: `worker-chaos-${suffix}`,
      model: modelId,
    });
    const session = await parent.beta.sessions.create({
      agent: { type: "agent", id: agent.id, version: agent.version },
      environment_id: environment.id,
      title: "Lost webhook and crashed environment host",
    });

    const profile: ManagedRuntimeProfile = {
      workspace: { requirement: "ephemeral" },
      outputs: { requirement: "disabled" },
      runtimeCheckpoint: "disabled",
      driver: {
        type: "ama_worker",
        process: { command: "node", args: ["worker.mjs"] },
      },
    };
    let deadHeartbeat: string | null = null;
    const firstErrors: unknown[] = [];
    const crashedHost: ManagedRuntimeHost = {
      async run({ scope }) {
        const heartbeat = await runner.beta.environments.work.heartbeat(
          scope.workId,
          {
            environment_id: environment.id,
            desired_ttl_seconds: 0,
            expected_last_heartbeat: "NO_HEARTBEAT",
          },
        );
        deadHeartbeat = heartbeat.last_heartbeat;
        throw new Error("injected host crash after ACK");
      },
    };
    const lostWebhookAbort = new AbortController();
    const firstWorker = createManagedEnvironmentWorker({
      client: parent,
      environmentId: environment.id,
      environmentKey,
      workspaceId: "default",
      workerId: `dead-${suffix}`,
      host: crashedHost,
      profileFor: async () => profile,
      scheduler: {
        async sleep() {
          lostWebhookAbort.abort(new Error("end fallback poll probe"));
          lostWebhookAbort.signal.throwIfAborted();
        },
      },
      onError: async (error) => {
        firstErrors.push(error);
      },
    });

    // No webhook is delivered. run() must poll immediately, ACK the work and
    // survive the injected host crash so another replica can reclaim it.
    try {
      await within(firstWorker.run(lostWebhookAbort.signal), 5_000, "fallback worker");
    } catch (error) {
      lostWebhookAbort.abort(error);
      throw new Error(`fallback worker failed; trace=${JSON.stringify(requestTrace)}`, {
        cause: error,
      });
    }
    expect(firstErrors).toEqual([
      expect.objectContaining({ message: "injected host crash after ACK" }),
    ]);
    expect(deadHeartbeat).not.toBeNull();

    const replacementRuns: string[] = [];
    const staleHeartbeatStatuses: number[] = [];
    const replacement = (workerId: string) => createManagedEnvironmentWorker({
      client: parent,
      environmentId: environment.id,
      environmentKey,
      workspaceId: "default",
      workerId,
      reclaimOlderThanMs: 5_000,
      host: {
        async run({ scope }) {
          replacementRuns.push(workerId);
          try {
            await runner.beta.environments.work.heartbeat(scope.workId, {
              environment_id: environment.id,
              expected_last_heartbeat: deadHeartbeat!,
            });
          } catch (error) {
            staleHeartbeatStatuses.push(
              typeof error === "object" && error !== null && "status" in error
                ? Number(error.status)
                : -1,
            );
          }
          await runner.beta.environments.work.heartbeat(scope.workId, {
            environment_id: environment.id,
            expected_last_heartbeat: "NO_HEARTBEAT",
          });
          await runner.beta.environments.work.stop(scope.workId, {
            environment_id: environment.id,
            force: true,
          });
          return { type: "completed", revision: 1 };
        },
      },
      profileFor: async () => profile,
    });

    await within(Promise.all([
      replacement(`replacement-a-${suffix}`).drain(),
      replacement(`replacement-b-${suffix}`).drain(),
    ]), 5_000, "replacement workers");

    expect(replacementRuns).toHaveLength(1);
    expect(staleHeartbeatStatuses).toEqual([412]);
    await expect(
      parent.beta.sessions.retrieve(session.id),
    ).resolves.toMatchObject({ id: session.id });
  }, 60_000);
});

function decodeWorkSecret(secret: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(secret, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

async function waitForTerminalDream<T extends { status: string }>(
  retrieve: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const dream = await retrieve();
    if (!["pending", "running"].includes(dream.status)) return dream;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Dream did not reach a terminal state");
}

async function within<T>(promise: Promise<T>, milliseconds: number, stage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${stage} did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function testCertificatePem(): string {
  return [
    "-----BEGIN CERTIFICATE-----",
    Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]).toString("base64"),
    "-----END CERTIFICATE-----",
  ].join("\n");
}
