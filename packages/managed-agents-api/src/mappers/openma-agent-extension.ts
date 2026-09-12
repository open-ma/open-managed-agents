import type { AgentOpenMaExtensions } from "@open-managed-agents/managed-agents-application";

/** Project a versioned OpenMA Agent extension onto its public wire shape. */
export function fromOpenMaAgentExtension(
  extension: AgentOpenMaExtensions,
): object {
  return {
    ...(extension.auxiliaryModel !== undefined && {
      aux_model: {
        id: extension.auxiliaryModel.id,
        ...(extension.auxiliaryModel.effort !== undefined && {
          effort: { type: extension.auxiliaryModel.effort },
        }),
        ...(extension.auxiliaryModel.inferenceGeo !== undefined && {
          inference_geo: extension.auxiliaryModel.inferenceGeo,
        }),
        ...(extension.auxiliaryModel.speed !== undefined && {
          speed: extension.auxiliaryModel.speed,
        }),
      },
    }),
    ...(extension.appendablePrompts !== undefined && {
      appendable_prompts: extension.appendablePrompts,
    }),
    ...(extension.harness !== undefined && { harness: extension.harness }),
    ...(extension.acp !== undefined && {
      acp: {
        agent: extension.acp.agent,
        ...(extension.acp.restart !== undefined && {
          restart: {
            mode: extension.acp.restart.mode,
            ...(extension.acp.restart.maxRestarts !== undefined && {
              max_restarts: extension.acp.restart.maxRestarts,
            }),
            ...(extension.acp.restart.windowMs !== undefined && {
              window_ms: extension.acp.restart.windowMs,
            }),
          },
        }),
        ...(extension.acp.idleTimeoutMs !== undefined && {
          idle_timeout_ms: extension.acp.idleTimeoutMs,
        }),
        ...(extension.acp.perTurnTimeoutMs !== undefined && {
          per_turn_timeout_ms: extension.acp.perTurnTimeoutMs,
        }),
      },
    }),
    ...(extension.runtimeBinding !== undefined && {
      runtime_binding: {
        runtime_id: extension.runtimeBinding.runtimeId,
        acp_agent_id: extension.runtimeBinding.acpAgentId,
        ...(extension.runtimeBinding.localSkillBlocklist !== undefined && {
          local_skill_blocklist: extension.runtimeBinding.localSkillBlocklist,
        }),
      },
    }),
    ...(extension.enableGeneralSubagent !== undefined && {
      enable_general_subagent: extension.enableGeneralSubagent,
    }),
  };
}
