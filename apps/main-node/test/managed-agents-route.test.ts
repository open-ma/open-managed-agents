import Anthropic from "@anthropic-ai/sdk";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detachedProcessOptions,
  killProcessTree,
} from "./helpers/process-tree";
import { verifyManagedAgentsClientStateModel } from "../../../test/model/managed-agents-client-state-model";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  logBuffer: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");
const SKILL_MARKDOWN = `---
name: repository-guide
description: How to work in this repository
---
# Repository guide
`;

describe("main-node official Managed Agents route", () => {
  let dataDirectory: string;
  let handle: ProcessHandle | null = null;

  beforeEach(() => {
    dataDirectory = join(
      tmpdir(),
      `openma-managed-agents-node-${randomBytes(6).toString("hex")}`,
    );
    mkdirSync(dataDirectory, { recursive: true });
  });

  afterEach(async () => {
    if (handle !== null) {
      await killHard(handle).catch(() => undefined);
      handle = null;
    }
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it("serves an official SDK create and retrieve through the scoped application slice", async () => {
    handle = await startMainNode(dataDirectory);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${handle.port}`,
      maxRetries: 0,
    });
    const modelId = `route-test-model-${randomBytes(6).toString("hex")}`;
    const modelCard = await fetch(
      `http://127.0.0.1:${handle.port}/v1/oma/model_cards`,
      {
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
      },
    );
    expect(modelCard.status).toBe(201);

    const created = await client.beta.agents.create({
      name: "Node Managed Agent",
      model: modelId,
      metadata: { owner: "platform" },
    });
    const retrieved = await client.beta.agents.retrieve(created.id);

    expect(created).toMatchObject({
      id: expect.stringMatching(/^agent_/),
      type: "agent",
      name: "Node Managed Agent",
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
    const omaModels = await fetch(
      `http://127.0.0.1:${handle.port}/v1/oma/models/list`,
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
    const omaModelsOnOfficialPath = await fetch(
      `http://127.0.0.1:${handle.port}/v1/models/list`,
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
      name: "Node managed environment",
      description: "Node official environment",
      metadata: { owner: "platform" },
      scope: "account",
      config: { type: "self_hosted" },
    });
    const retrievedEnvironment = await client.beta.environments.retrieve(
      createdEnvironment.id,
    );

    expect(createdEnvironment).toMatchObject({
      id: expect.stringMatching(/^env_/),
      type: "environment",
      name: "Node managed environment",
      description: "Node official environment",
      metadata: { owner: "platform" },
      scope: "account",
      config: { type: "self_hosted" },
    });
    expect(retrievedEnvironment).toEqual(createdEnvironment);

    const uploadedFile = await client.beta.files.upload({
      file: new File(["hello from node"], "notes.txt", {
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
      size_bytes: 15,
      downloadable: true,
    });
    expect(retrievedFile).toEqual(uploadedFile);
    expect(await downloadedFile.text()).toBe("hello from node");

    const createdMemoryStore = await client.beta.memoryStores.create({
      name: "Node project memory",
      description: "Node official memory store",
      metadata: { owner: "platform" },
    });
    const retrievedMemoryStore = await client.beta.memoryStores.retrieve(
      createdMemoryStore.id,
    );

    expect(createdMemoryStore).toMatchObject({
      id: expect.stringMatching(/^memstore_/),
      type: "memory_store",
      name: "Node project memory",
      description: "Node official memory store",
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
      display_name: "Node production credentials",
      metadata: { owner: "platform" },
    });
    const retrievedVault = await client.beta.vaults.retrieve(createdVault.id);

    expect(createdVault).toMatchObject({
      id: expect.stringMatching(/^vlt_/),
      type: "vault",
      display_name: "Node production credentials",
      metadata: { owner: "platform" },
      archived_at: null,
    });
    expect(retrievedVault).toEqual(createdVault);

    const createdCredential = await client.beta.vaults.credentials.create(
      createdVault.id,
      {
        auth: {
          type: "static_bearer",
          token: "node-bearer-secret",
          mcp_server_url: "https://mcp.example.com/sse",
        },
        display_name: "Node MCP bearer",
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
      display_name: "Node MCP bearer",
      metadata: { owner: "platform" },
      type: "vault_credential",
      updated_at: expect.any(String),
      vault_id: createdVault.id,
    });
    expect(retrievedCredential).toEqual(createdCredential);
    expect(JSON.stringify(createdCredential)).not.toContain("node-bearer-secret");

    const createdTunnel = await client.beta.tunnels.create({
      display_name: "Node production gateway",
    });
    expect(createdTunnel).toEqual({
      id: expect.stringMatching(/^tnl_/),
      archived_at: null,
      created_at: expect.any(String),
      display_name: "Node production gateway",
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
      { reason: "Node e2e rotation" },
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
      external_id: "node-customer-01",
      metadata: { owner: "platform" },
      name: "Node Customer",
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
      external_id: "node-customer-01",
      name: "Node Customer",
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
      name: "node-repository-maintenance",
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
      name: "node-repository-maintenance",
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
      { "Anthropic-Worker-ID": "node-worker-01" },
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
    expect(decodeWorkSecret(polledWork.secret!)).toMatchObject({
      sessions_token: expect.stringMatching(/^sk-ant-req-/),
    });
    expect(
      await client.beta.environments.work.retrieve(polledWork.id, {
        environment_id: createdEnvironment.id,
      }),
    ).toEqual({ ...polledWork, secret: null });
    expect(
      await client.beta.environments.work.update(polledWork.id, {
        environment_id: createdEnvironment.id,
        metadata: { worker: "node-worker-01" },
      }),
    ).toMatchObject({ metadata: { worker: "node-worker-01" }, secret: null });
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
      title: "Node managed session",
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
      title: "Node managed session",
      status: "running",
    });
    expect(retrievedSession).toEqual(createdSession);

    const statsResponse = await fetch(
      `http://127.0.0.1:${handle.port}/v1/oma/stats`,
      { headers: { "x-api-key": "test-key" } },
    );
    expect(statsResponse.status).toBe(200);
    expect(await statsResponse.json()).toEqual({
      agents: 1,
      sessions: 2,
      environments: 1,
      vaults: 1,
      skills: 1,
      model_cards: 1,
      api_keys: 0,
    });

    expect(await client.beta.sessions.delete(createdSession.id)).toEqual({
      id: createdSession.id,
      type: "session_deleted",
    });
  }, 60_000);

  it("refines the official SDK client state model under conflicts", async () => {
    handle = await startMainNode(dataDirectory);
    const client = new Anthropic({
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${handle.port}`,
      maxRetries: 0,
    });
    const suffix = randomBytes(8).toString("hex");
    const modelId = `state-model-${suffix}`;
    const modelCard = await fetch(
      `http://127.0.0.1:${handle.port}/v1/oma/model_cards`,
      {
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
      },
    );
    expect(modelCard.status).toBe(201);

    await verifyManagedAgentsClientStateModel({
      client,
      model: modelId,
      prefix: `node-${suffix}`,
    });
  }, 60_000);

  it("runs official worker bearer auth with scoped per-work credentials when auth is enabled", async () => {
    handle = await startMainNode(dataDirectory, {
      authDisabled: false,
      apiKey: "test-key",
    });
    const baseURL = `http://127.0.0.1:${handle.port}`;
    const client = new Anthropic({ apiKey: "test-key", baseURL, maxRetries: 0 });
    const suffix = randomBytes(8).toString("hex");
    const modelId = `worker-auth-${suffix}`;
    const modelCard = await fetch(`${baseURL}/v1/oma/model_cards`, {
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
    const environmentKeyResponse = await fetch(`${baseURL}/v1/oma/api_keys`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      body: JSON.stringify({
        name: `worker-${suffix}`,
        environment_id: environment.id,
      }),
    });
    expect(environmentKeyResponse.status).toBe(201);
    const environmentCredential = await environmentKeyResponse.json() as {
      id: string;
      key: string;
    };
    expect(environmentCredential.key).toMatch(/^oma_env_/);
    expect((await fetch(`${baseURL}/v1/agents`, {
      headers: { authorization: `Bearer ${environmentCredential.key}` },
    })).status).toBe(403);
    expect((await fetch(`${baseURL}/v1/environments/env_other/work/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${environmentCredential.key}` },
    })).status).toBe(403);
    expect((await fetch(`${baseURL}/v1/environments/${environment.id}/work/poll`, {
      method: "POST",
      headers: { "x-api-key": environmentCredential.key },
    })).status).toBe(403);
    const attachedFile = await client.beta.files.upload({
      file: new File(["attached work input"], "input.txt", {
        type: "text/plain",
      }),
    });
    const unrelatedFile = await client.beta.files.upload({
      file: new File(["not attached"], "unrelated.txt", {
        type: "text/plain",
      }),
    });
    const attachedSkill = await client.beta.skills.create({
      display_title: "Worker attached skill",
      files: [
        new File([SKILL_MARKDOWN], "repository-guide/SKILL.md", {
          type: "text/markdown",
        }),
      ],
    });
    const unrelatedSkill = await client.beta.skills.create({
      display_title: "Worker unrelated skill",
      files: [
        new File([SKILL_MARKDOWN], "unrelated/SKILL.md", {
          type: "text/markdown",
        }),
      ],
    });
    const attachedMemoryStore = await client.beta.memoryStores.create({
      name: `worker-memory-${suffix}`,
    });
    const unrelatedMemoryStore = await client.beta.memoryStores.create({
      name: `worker-unrelated-memory-${suffix}`,
    });
    const attachedMemory = await client.beta.memoryStores.memories.create(
      attachedMemoryStore.id,
      {
        content: "worker memory input",
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
          access: "read_write",
        },
      ],
    });

    const environmentClient = new Anthropic({
      apiKey: null,
      authToken: environmentCredential.key,
      baseURL,
      maxRetries: 0,
    });
    const poller = client.beta.environments.work.poller({
      environmentId: environment.id,
      environmentKey: environmentCredential.key,
      workerId: `worker-${suffix}`,
      blockMs: null,
      autoStop: false,
    });
    const iterator = poller[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    const work = next.value!;
    const sessionsToken = decodeWorkSecret(work.secret!).sessions_token;
    expect(sessionsToken).toMatch(/^sk-ant-req-v1\./);
    const sessionClient = new Anthropic({
      apiKey: null,
      authToken: String(sessionsToken),
      baseURL,
      maxRetries: 0,
    });

    await expect(sessionClient.beta.sessions.retrieve(session.id)).resolves.toMatchObject({
      id: session.id,
      environment_id: environment.id,
    });
    await expect(
      sessionClient.beta.files.retrieveMetadata(attachedFile.id),
    ).resolves.toMatchObject({ id: attachedFile.id, filename: "input.txt" });
    await expect(
      sessionClient.beta.files.download(attachedFile.id).then((file) => file.text()),
    ).resolves.toBe("attached work input");
    await expect(
      sessionClient.beta.files.download(unrelatedFile.id),
    ).rejects.toMatchObject({ status: 401 });

    const attachedSkillVersions = await sessionClient.beta.skills.versions.list(
      attachedSkill.id,
    );
    expect(attachedSkillVersions.data).toHaveLength(1);
    const concreteSkillVersion = attachedSkillVersions.data[0]!.version;
    await expect(
      sessionClient.beta.skills.versions.retrieve(concreteSkillVersion, {
        skill_id: attachedSkill.id,
      }),
    ).resolves.toMatchObject({
      skill_id: attachedSkill.id,
      version: concreteSkillVersion,
    });
    await expect(
      sessionClient.beta.skills.versions.download(concreteSkillVersion, {
        skill_id: attachedSkill.id,
      }).then((file) => file.arrayBuffer()),
    ).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(
      sessionClient.beta.skills.versions.list(unrelatedSkill.id),
    ).rejects.toMatchObject({ status: 401 });

    const memories = await sessionClient.beta.memoryStores.memories.list(
      attachedMemoryStore.id,
      { view: "full" },
    );
    expect(memories.data).toMatchObject([{
      id: attachedMemory.id,
      content: "worker memory input",
    }]);
    await expect(
      sessionClient.beta.memoryStores.memories.update(attachedMemory.id, {
        memory_store_id: attachedMemoryStore.id,
        content: "worker memory output",
        view: "full",
      }),
    ).resolves.toMatchObject({
      id: attachedMemory.id,
      content: "worker memory output",
    });
    await expect(
      sessionClient.beta.memoryStores.memories.list(unrelatedMemoryStore.id),
    ).rejects.toMatchObject({ status: 401 });
    const unrelated = await fetch(`${baseURL}/v1/agents`, {
      headers: { Authorization: `Bearer ${sessionsToken}` },
    });
    expect(unrelated.status).toBe(401);
    await expect(
      sessionClient.beta.environments.work.heartbeat(work.id, {
        environment_id: environment.id,
        desired_ttl_seconds: 0,
      }),
    ).resolves.toMatchObject({ type: "work_heartbeat", lease_extended: true });
    poller.abort();
    await iterator.return?.();
    const replacement = await environmentClient.beta.environments.work.poll(
      environment.id,
      {
        "Anthropic-Worker-ID": `replacement-${suffix}`,
        reclaim_older_than_ms: 5_000,
      },
    );
    expect(replacement).not.toBeNull();
    if (replacement === null) throw new Error("expected replacement Work claim");
    const replacementToken = String(
      decodeWorkSecret(replacement.secret!).sessions_token,
    );
    expect(replacementToken).not.toBe(String(sessionsToken));
    await environmentClient.beta.environments.work.ack(replacement.id, {
      environment_id: environment.id,
    });
    await expect(
      sessionClient.beta.sessions.retrieve(session.id),
    ).rejects.toMatchObject({ status: 401 });
    const replacementSessionClient = new Anthropic({
      apiKey: null,
      authToken: replacementToken,
      baseURL,
      maxRetries: 0,
    });
    await expect(
      replacementSessionClient.beta.sessions.retrieve(session.id),
    ).resolves.toMatchObject({ id: session.id });
    await replacementSessionClient.beta.environments.work.heartbeat(
      replacement.id,
      {
        environment_id: environment.id,
        expected_last_heartbeat: "NO_HEARTBEAT",
      },
    );
    const runtimeEventId = `runtime-${suffix}`;
    const runtimeIngress = await fetch(
      `${baseURL}/v1/oma/sessions/${session.id}/runtime-events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${replacementToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: [{
            id: runtimeEventId,
            type: "session.status_idle",
            processed_at: new Date().toISOString(),
            stop_reason: { type: "end_turn" },
          }],
        }),
      },
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
    await expect(
      environmentClient.beta.environments.work.stop(work.id, {
        environment_id: environment.id,
        force: true,
      }),
    ).resolves.toMatchObject({ id: work.id, state: "stopped" });
    const revoked = await fetch(
      `${baseURL}/v1/oma/api_keys/${environmentCredential.id}`,
      { method: "DELETE", headers: { "x-api-key": "test-key" } },
    );
    expect(revoked.status).toBe(200);
    expect((await fetch(
      `${baseURL}/v1/environments/${environment.id}/work/poll`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${environmentCredential.key}` },
      },
    )).status).toBe(401);
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

function testCertificatePem(): string {
  return [
    "-----BEGIN CERTIFICATE-----",
    Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]).toString("base64"),
    "-----END CERTIFICATE-----",
  ].join("\n");
}

async function startMainNode(
  dataDirectory: string,
  options: { authDisabled?: boolean; apiKey?: string } = {},
): Promise<ProcessHandle> {
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    ...detachedProcessOptions,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Let the server bind port 0 itself. Picking and releasing an ephemeral
      // port before spawning leaves a TOCTOU window where another process can
      // claim it and made this state-model E2E intermittently fail EADDRINUSE.
      PORT: "0",
      DATABASE_PATH: join(dataDirectory, "oma.db"),
      AUTH_DATABASE_PATH: join(dataDirectory, "auth.db"),
      SANDBOX_WORKDIR: join(dataDirectory, "sandboxes"),
      MEMORY_BLOB_DIR: join(dataDirectory, "memory-blobs"),
      FILES_BLOB_DIR: join(dataDirectory, "file-blobs"),
      SESSION_OUTPUTS_DIR: join(dataDirectory, "outputs"),
      AUTH_DISABLED: options.authDisabled === false ? "0" : "1",
      ...(options.apiKey === undefined ? {} : { API_KEY: options.apiKey }),
      BETTER_AUTH_SECRET: "managed-agents-node-test-secret",
      PLATFORM_ROOT_SECRET: "managed-agents-node-credential-test-root-secret",
      DREAM_CURATOR_MODE: "dedup",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuffer: string[] = [];
  child.stdout?.on("data", (data: Buffer) => logBuffer.push(data.toString()));
  child.stderr?.on("data", (data: Buffer) => logBuffer.push(data.toString()));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`main-node exited before becoming ready:\n${logBuffer.join("")}`);
    }
    const port = listeningPort(logBuffer);
    if (port !== null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) return { child, port, logBuffer };
      } catch {
        // The listener was announced but the health route is still booting.
      }
    }
    await new Promise((resolveReady) => setTimeout(resolveReady, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`main-node did not become ready:\n${logBuffer.join("")}`);
}

function listeningPort(chunks: readonly string[]): number | null {
  for (const line of chunks.join("").split("\n")) {
    try {
      const event = JSON.parse(line) as { op?: unknown; port?: unknown };
      if (
        event.op === "main-node.listening"
        && Number.isSafeInteger(event.port)
        && Number(event.port) > 0
      ) {
        return Number(event.port);
      }
    } catch {
      // Startup can include non-JSON dependency logs; ignore those lines.
    }
  }
  return null;
}

function killHard(handle: ProcessHandle): Promise<void> {
  return killProcessTree(handle.child);
}
