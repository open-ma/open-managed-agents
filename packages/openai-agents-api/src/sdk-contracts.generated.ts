// Generated from openai@7.15.0; regenerate with scripts/generate-sdk-contracts.mjs.
// SDK-derived structural contracts. Handwritten validation adds documented bounds.
export const sdkContractRoots: Record<string, string> = {
  "agents.Agent": "s0",
  "agents.AgentCloseSubagentCallItem": "s68",
  "agents.AgentCommandExecutionItem": "s75",
  "agents.AgentContent": "s77",
  "agents.AgentCreateSubagentCallItem": "s82",
  "agents.AgentDeleted": "s85",
  "agents.AgentFunctionCallItem": "s87",
  "agents.AgentFunctionCallOutput": "s89",
  "agents.AgentFunctionCallOutputParam": "s96",
  "agents.AgentFunctionCallStatus": "s69",
  "agents.AgentInterruptSubagentCallItem": "s101",
  "agents.AgentMcpCallItem": "s103",
  "agents.AgentOutputCommandExecutionOutputDeltaEvent": "s105",
  "agents.AgentOutputItem": "s107",
  "agents.AgentOutputItemStatus": "s114",
  "agents.AgentReasoning": "s10",
  "agents.AgentReasoningItem": "s116",
  "agents.AgentReasoningParam": "s139",
  "agents.AgentResumeSubagentCallItem": "s135",
  "agents.AgentSendSubagentInputCallItem": "s133",
  "agents.AgentSession": "s142",
  "agents.AgentSessionAssistantMessage": "s108",
  "agents.AgentSessionCreatedEvent": "s195",
  "agents.AgentSessionDeleted": "s197",
  "agents.AgentSessionEnvironmentConnectedEvent": "s199",
  "agents.AgentSessionEnvironmentDisconnectedEvent": "s209",
  "agents.AgentSessionEnvironmentFailedEvent": "s211",
  "agents.AgentSessionEnvironmentPendingEvent": "s213",
  "agents.AgentSessionEnvironmentReadyEvent": "s215",
  "agents.AgentSessionEnvironmentState": "s200",
  "agents.AgentSessionErrorEvent": "s217",
  "agents.AgentSessionEvent": "s220",
  "agents.AgentSessionFailedEvent": "s278",
  "agents.AgentSessionIdleEvent": "s272",
  "agents.AgentSessionInProgressEvent": "s274",
  "agents.AgentSessionInputMessageParam": "s311",
  "agents.AgentSessionInputParam": "s314",
  "agents.AgentSessionItem": "s257",
  "agents.AgentSessionMessage": "s258",
  "agents.AgentSessionMessageContent": "s260",
  "agents.AgentSessionRequiresActionEvent": "s276",
  "agents.AgentSessionSubagentActiveEvent": "s288",
  "agents.AgentSessionSubagentClosedEvent": "s290",
  "agents.AgentSessionSubagentCreatedEvent": "s280",
  "agents.AgentSessionTurnCancelledEvent": "s254",
  "agents.AgentSessionTurnCompletedEvent": "s250",
  "agents.AgentSessionTurnContentPartAddedEvent": "s294",
  "agents.AgentSessionTurnContentPartDoneEvent": "s296",
  "agents.AgentSessionTurnCreatedEvent": "s221",
  "agents.AgentSessionTurnFailedEvent": "s252",
  "agents.AgentSessionTurnInProgressEvent": "s248",
  "agents.AgentSessionTurnItemAddedEvent": "s256",
  "agents.AgentSessionTurnItemDoneEvent": "s292",
  "agents.AgentSessionTurnOutputTextDeltaEvent": "s298",
  "agents.AgentSessionTurnOutputTextDoneEvent": "s300",
  "agents.AgentSessionTurnReasoningSummaryPartAddedEvent": "s302",
  "agents.AgentSessionTurnReasoningSummaryPartDoneEvent": "s304",
  "agents.AgentSessionTurnReasoningSummaryTextDeltaEvent": "s307",
  "agents.AgentSessionTurnReasoningSummaryTextDoneEvent": "s309",
  "agents.AgentText": "s28",
  "agents.AgentTextParam": "s324",
  "agents.AgentTool": "s145",
  "agents.AgentToolParam": "s330",
  "agents.AgentWaitForSubagentsCallItem": "s137",
  "agents.AgentWebSearchCallItem": "s122",
  "agents.Environment": "s157",
  "agents.EnvironmentParam": "s354",
  "agents.HostedEnvironmentFile": "s161",
  "agents.HostedEnvironmentFileID": "s162",
  "agents.HostedEnvironmentFileParam": "s362",
  "agents.HostedPlugin": "s172",
  "agents.HostedPluginParam": "s371",
  "agents.HostedSkill": "s174",
  "agents.HostedSkillParam": "s380",
  "agents.HostedSkillReference": "s175",
  "agents.InlineCapabilitySourceParam": "s372",
  "agents.InputContent": "s91",
  "agents.InputContentParam": "s98",
  "agents.McpTransport": "s151",
  "agents.McpTransportParam": "s339",
  "agents.MultiAgentConfig": "s6",
  "agents.MultiAgentConfigParam": "s384",
  "agents.OutputText": "s78",
  "agents.PersistedAgentTool": "s38",
  "agents.PersistedAgentToolParam": "s386",
  "agents.PersistedMcpTransport": "s53",
  "agents.PersistedMcpTransportParam": "s392",
  "agents.SessionError": "s218",
  "agents.SessionTurnError": "s224",
  "agents.SetupCommandParam": "s377",
  "agents.Subagent": "s281",
  "agents.SummaryText": "s119",
  "agents.TextFormat": "s29",
  "agents.TextFormatParam": "s402",
  "agents.TokenUsage": "s192",
  "agents.WebSearchAction": "s403",
  "agents.AgentCreateParams": "s404",
  "agents.AgentUpdateParams": "s413",
  "agents.AgentListParams": "s416",
  "environments.EnvironmentInfo": "s420",
  "environments.files.EnvironmentFile": "s425",
  "environments.files.FileCreateParams": "s427",
  "environments.files.FileListParams": "s430",
  "environments.templates.EnvironmentTemplate": "s431",
  "environments.templates.EnvironmentTemplateDeleted": "s443",
  "environments.templates.TemplateCreateParams": "s445",
  "environments.templates.TemplateUpdateParams": "s452",
  "environments.templates.TemplateListParams": "s459",
  "sessions.SessionCreateParams": "s460",
  "sessions.SessionCreateParamsBase": "s471",
  "sessions.SessionCreateParamsNonStreaming": "s461",
  "sessions.SessionCreateParamsStreaming": "s470",
  "sessions.SessionUpdateParams": "s472",
  "sessions.SessionListParams": "s475",
  "sessions.events.EventCreateParams": "s476",
  "sessions.items.ItemListParams": "s478",
  "sessions.turns.Turn": "s222",
  "sessions.turns.TurnRetrieveParams": "s479",
  "sessions.turns.TurnListParams": "s480",
  "sessions.artifacts.SessionArtifact": "s481",
  "sessions.artifacts.SessionArtifactDeleted": "s483",
  "sessions.artifacts.ArtifactRetrieveParams": "s485",
  "sessions.artifacts.ArtifactListParams": "s486",
  "sessions.artifacts.ArtifactDeleteParams": "s487",
  "sessions.artifacts.ArtifactContentParams": "s488",
  "sessions.subagents.SubagentRetrieveParams": "s489",
  "sessions.subagents.SubagentListParams": "s490",
  "sessions.subagents.items.ItemListParams": "s491",
  "sessions.subagents.turns.TurnRetrieveParams": "s492",
  "sessions.subagents.turns.TurnListParams": "s493",
  "sessions.subagents.turns.items.ItemListParams": "s494",
  "vaults.Vault": "s495",
  "vaults.VaultDeleted": "s498",
  "vaults.VaultStatus": "s500",
  "vaults.VaultStatusFilter": "s502",
  "vaults.VaultCreateParams": "s504",
  "vaults.VaultListParams": "s507",
  "vaults.credentials.Credential": "s509",
  "vaults.credentials.CredentialAuth": "s510",
  "vaults.credentials.CredentialAuthCreateParam": "s524",
  "vaults.credentials.CredentialAuthRotateParam": "s533",
  "vaults.credentials.CredentialDeleted": "s541",
  "vaults.credentials.McpOauthTokenEndpointAuth": "s514",
  "vaults.credentials.McpOauthTokenEndpointAuthCreateParam": "s528",
  "vaults.credentials.McpOauthTokenEndpointAuthRotateParam": "s543",
  "vaults.credentials.CredentialCreateParams": "s544",
  "vaults.credentials.CredentialRetrieveParams": "s545",
  "vaults.credentials.CredentialUpdateParams": "s546",
  "vaults.credentials.CredentialListParams": "s547",
  "vaults.credentials.CredentialDeleteParams": "s548"
};
export const sdkContractDescriptors = {
  "s0": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "instructions": {
        "schema": "s3",
        "required": true
      },
      "metadata": {
        "schema": "s5",
        "required": true
      },
      "model": {
        "schema": "s1",
        "required": true
      },
      "multi_agent": {
        "schema": "s6",
        "required": true
      },
      "name": {
        "schema": "s3",
        "required": true
      },
      "object": {
        "schema": "s9",
        "required": true
      },
      "reasoning": {
        "schema": "s10",
        "required": true
      },
      "service_tier": {
        "schema": "s23",
        "required": true
      },
      "text": {
        "schema": "s28",
        "required": true
      },
      "tools": {
        "schema": "s37",
        "required": true
      },
      "updated_at": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s1": {
    "kind": "string"
  },
  "s2": {
    "kind": "number"
  },
  "s3": {
    "kind": "union",
    "variants": [
      "s4",
      "s1"
    ]
  },
  "s4": {
    "kind": "null"
  },
  "s5": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s6": {
    "kind": "object",
    "properties": {
      "enabled": {
        "schema": "s7",
        "required": true
      },
      "max_concurrent_subagents": {
        "schema": "s8",
        "required": true
      }
    }
  },
  "s7": {
    "kind": "boolean"
  },
  "s8": {
    "kind": "union",
    "variants": [
      "s4",
      "s2"
    ]
  },
  "s9": {
    "kind": "literal",
    "value": "agent"
  },
  "s10": {
    "kind": "object",
    "properties": {
      "effort": {
        "schema": "s11",
        "required": true
      },
      "summary": {
        "schema": "s19",
        "required": true
      }
    }
  },
  "s11": {
    "kind": "union",
    "variants": [
      "s4",
      "s12",
      "s13",
      "s14",
      "s15",
      "s16",
      "s17",
      "s18"
    ]
  },
  "s12": {
    "kind": "literal",
    "value": "none"
  },
  "s13": {
    "kind": "literal",
    "value": "minimal"
  },
  "s14": {
    "kind": "literal",
    "value": "low"
  },
  "s15": {
    "kind": "literal",
    "value": "medium"
  },
  "s16": {
    "kind": "literal",
    "value": "high"
  },
  "s17": {
    "kind": "literal",
    "value": "xhigh"
  },
  "s18": {
    "kind": "literal",
    "value": "max"
  },
  "s19": {
    "kind": "union",
    "variants": [
      "s4",
      "s20",
      "s21",
      "s22"
    ]
  },
  "s20": {
    "kind": "literal",
    "value": "concise"
  },
  "s21": {
    "kind": "literal",
    "value": "detailed"
  },
  "s22": {
    "kind": "literal",
    "value": "auto"
  },
  "s23": {
    "kind": "union",
    "variants": [
      "s22",
      "s24",
      "s25",
      "s26",
      "s27"
    ]
  },
  "s24": {
    "kind": "literal",
    "value": "default"
  },
  "s25": {
    "kind": "literal",
    "value": "flex"
  },
  "s26": {
    "kind": "literal",
    "value": "priority"
  },
  "s27": {
    "kind": "literal",
    "value": "fast"
  },
  "s28": {
    "kind": "object",
    "properties": {
      "format": {
        "schema": "s29",
        "required": true
      },
      "verbosity": {
        "schema": "s36",
        "required": true
      }
    }
  },
  "s29": {
    "kind": "union",
    "variants": [
      "s30",
      "s32"
    ]
  },
  "s30": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s31",
        "required": true
      }
    }
  },
  "s31": {
    "kind": "literal",
    "value": "text"
  },
  "s32": {
    "kind": "object",
    "properties": {
      "schema": {
        "schema": "s33",
        "required": true
      },
      "type": {
        "schema": "s35",
        "required": true
      }
    }
  },
  "s33": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s34": {
    "kind": "unknown"
  },
  "s35": {
    "kind": "literal",
    "value": "json_schema"
  },
  "s36": {
    "kind": "union",
    "variants": [
      "s14",
      "s15",
      "s16"
    ]
  },
  "s37": {
    "kind": "array",
    "element": "s38"
  },
  "s38": {
    "kind": "union",
    "variants": [
      "s39",
      "s42",
      "s44",
      "s46",
      "s60"
    ]
  },
  "s39": {
    "kind": "object",
    "properties": {
      "defer_loading": {
        "schema": "s7",
        "required": true
      },
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "parameters": {
        "schema": "s40",
        "required": true
      },
      "type": {
        "schema": "s41",
        "required": true
      }
    }
  },
  "s40": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s41": {
    "kind": "literal",
    "value": "function"
  },
  "s42": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s43",
        "required": true
      }
    }
  },
  "s43": {
    "kind": "literal",
    "value": "tool_search"
  },
  "s44": {
    "kind": "object",
    "properties": {
      "enabled": {
        "schema": "s7",
        "required": true
      },
      "type": {
        "schema": "s45",
        "required": true
      }
    }
  },
  "s45": {
    "kind": "literal",
    "value": "programmatic_tool_calling"
  },
  "s46": {
    "kind": "object",
    "properties": {
      "allowed_tools": {
        "schema": "s47",
        "required": true
      },
      "connection_origin": {
        "schema": "s49",
        "required": true
      },
      "credential_id": {
        "schema": "s3",
        "required": true
      },
      "request_metadata": {
        "schema": "s52",
        "required": true
      },
      "required": {
        "schema": "s7",
        "required": true
      },
      "server_label": {
        "schema": "s1",
        "required": true
      },
      "transport": {
        "schema": "s53",
        "required": true
      },
      "type": {
        "schema": "s59",
        "required": true
      }
    }
  },
  "s47": {
    "kind": "union",
    "variants": [
      "s4",
      "s48"
    ]
  },
  "s48": {
    "kind": "array",
    "element": "s1"
  },
  "s49": {
    "kind": "union",
    "variants": [
      "s50",
      "s51"
    ]
  },
  "s50": {
    "kind": "literal",
    "value": "service"
  },
  "s51": {
    "kind": "literal",
    "value": "environment"
  },
  "s52": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s53": {
    "kind": "union",
    "variants": [
      "s54",
      "s57"
    ]
  },
  "s54": {
    "kind": "object",
    "properties": {
      "headers": {
        "schema": "s55",
        "required": true
      },
      "server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s56",
        "required": true
      }
    }
  },
  "s55": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s56": {
    "kind": "literal",
    "value": "http"
  },
  "s57": {
    "kind": "object",
    "properties": {
      "args": {
        "schema": "s48",
        "required": true
      },
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s1",
        "required": true
      },
      "env_vars": {
        "schema": "s48",
        "required": true
      },
      "type": {
        "schema": "s58",
        "required": true
      }
    }
  },
  "s58": {
    "kind": "literal",
    "value": "stdio"
  },
  "s59": {
    "kind": "literal",
    "value": "mcp"
  },
  "s60": {
    "kind": "object",
    "properties": {
      "allowed_domains": {
        "schema": "s47",
        "required": true
      },
      "context_size": {
        "schema": "s36",
        "required": true
      },
      "location": {
        "schema": "s61",
        "required": true
      },
      "mode": {
        "schema": "s63",
        "required": true
      },
      "type": {
        "schema": "s67",
        "required": true
      }
    }
  },
  "s61": {
    "kind": "union",
    "variants": [
      "s4",
      "s62"
    ]
  },
  "s62": {
    "kind": "object",
    "properties": {
      "city": {
        "schema": "s3",
        "required": true
      },
      "country": {
        "schema": "s3",
        "required": true
      },
      "region": {
        "schema": "s3",
        "required": true
      },
      "timezone": {
        "schema": "s3",
        "required": true
      }
    }
  },
  "s63": {
    "kind": "union",
    "variants": [
      "s64",
      "s65",
      "s66"
    ]
  },
  "s64": {
    "kind": "literal",
    "value": "disabled"
  },
  "s65": {
    "kind": "literal",
    "value": "cached"
  },
  "s66": {
    "kind": "literal",
    "value": "live"
  },
  "s67": {
    "kind": "literal",
    "value": "web_search"
  },
  "s68": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "recipient_agent_id": {
        "schema": "s1",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s74",
        "required": true
      }
    }
  },
  "s69": {
    "kind": "union",
    "variants": [
      "s70",
      "s71",
      "s72",
      "s73"
    ]
  },
  "s70": {
    "kind": "literal",
    "value": "in_progress"
  },
  "s71": {
    "kind": "literal",
    "value": "completed"
  },
  "s72": {
    "kind": "literal",
    "value": "failed"
  },
  "s73": {
    "kind": "literal",
    "value": "incomplete"
  },
  "s74": {
    "kind": "literal",
    "value": "close_subagent_call"
  },
  "s75": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s3",
        "required": true
      },
      "duration_ms": {
        "schema": "s8",
        "required": true
      },
      "exit_code": {
        "schema": "s8",
        "required": true
      },
      "output": {
        "schema": "s3",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s76",
        "required": true
      }
    }
  },
  "s76": {
    "kind": "literal",
    "value": "command_execution"
  },
  "s77": {
    "kind": "union",
    "variants": [
      "s78",
      "s80"
    ]
  },
  "s78": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s79",
        "required": true
      }
    }
  },
  "s79": {
    "kind": "literal",
    "value": "output_text"
  },
  "s80": {
    "kind": "object",
    "properties": {
      "encrypted_content": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s81",
        "required": true
      }
    }
  },
  "s81": {
    "kind": "literal",
    "value": "encrypted_content"
  },
  "s82": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "agent_id": {
        "schema": "s1",
        "required": true
      },
      "content": {
        "schema": "s83",
        "required": true
      },
      "model": {
        "schema": "s3",
        "required": true
      },
      "reasoning_effort": {
        "schema": "s3",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s84",
        "required": true
      }
    }
  },
  "s83": {
    "kind": "array",
    "element": "s77"
  },
  "s84": {
    "kind": "literal",
    "value": "create_subagent_call"
  },
  "s85": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s86",
        "required": true
      }
    }
  },
  "s86": {
    "kind": "literal",
    "value": "agent.deleted"
  },
  "s87": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "arguments": {
        "schema": "s34",
        "required": true
      },
      "call_id": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s88",
        "required": true
      }
    }
  },
  "s88": {
    "kind": "literal",
    "value": "function_call"
  },
  "s89": {
    "kind": "union",
    "variants": [
      "s1",
      "s90"
    ]
  },
  "s90": {
    "kind": "array",
    "element": "s91"
  },
  "s91": {
    "kind": "union",
    "variants": [
      "s92",
      "s94"
    ]
  },
  "s92": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s93",
        "required": true
      }
    }
  },
  "s93": {
    "kind": "literal",
    "value": "input_text"
  },
  "s94": {
    "kind": "object",
    "properties": {
      "image_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s95",
        "required": true
      }
    }
  },
  "s95": {
    "kind": "literal",
    "value": "input_image"
  },
  "s96": {
    "kind": "union",
    "variants": [
      "s1",
      "s97"
    ]
  },
  "s97": {
    "kind": "array",
    "element": "s98"
  },
  "s98": {
    "kind": "union",
    "variants": [
      "s99",
      "s100"
    ]
  },
  "s99": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s93",
        "required": true
      }
    }
  },
  "s100": {
    "kind": "object",
    "properties": {
      "image_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s95",
        "required": true
      }
    }
  },
  "s101": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "recipient_agent_id": {
        "schema": "s1",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s102",
        "required": true
      }
    }
  },
  "s102": {
    "kind": "literal",
    "value": "interrupt_subagent_call"
  },
  "s103": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "arguments": {
        "schema": "s34",
        "required": true
      },
      "error": {
        "schema": "s34",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "output": {
        "schema": "s34",
        "required": true
      },
      "server_label": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s104",
        "required": true
      }
    }
  },
  "s104": {
    "kind": "literal",
    "value": "mcp_call"
  },
  "s105": {
    "kind": "object",
    "properties": {
      "delta": {
        "schema": "s1",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s106",
        "required": true
      }
    }
  },
  "s106": {
    "kind": "literal",
    "value": "agent.output.command_execution_output.delta"
  },
  "s107": {
    "kind": "union",
    "variants": [
      "s68",
      "s75",
      "s82",
      "s87",
      "s101",
      "s103",
      "s108",
      "s116",
      "s122",
      "s133",
      "s135",
      "s137"
    ]
  },
  "s108": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "content": {
        "schema": "s109",
        "required": true
      },
      "phase": {
        "schema": "s110",
        "required": true
      },
      "role": {
        "schema": "s113",
        "required": true
      },
      "status": {
        "schema": "s114",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s115",
        "required": true
      }
    }
  },
  "s109": {
    "kind": "array",
    "element": "s78"
  },
  "s110": {
    "kind": "union",
    "variants": [
      "s4",
      "s111",
      "s112"
    ]
  },
  "s111": {
    "kind": "literal",
    "value": "commentary"
  },
  "s112": {
    "kind": "literal",
    "value": "final_answer"
  },
  "s113": {
    "kind": "literal",
    "value": "assistant"
  },
  "s114": {
    "kind": "union",
    "variants": [
      "s70",
      "s71",
      "s73"
    ]
  },
  "s115": {
    "kind": "literal",
    "value": "message"
  },
  "s116": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s117",
        "required": true
      },
      "summary": {
        "schema": "s118",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s121",
        "required": true
      }
    }
  },
  "s117": {
    "kind": "union",
    "variants": [
      "s4",
      "s70",
      "s71",
      "s73"
    ]
  },
  "s118": {
    "kind": "array",
    "element": "s119"
  },
  "s119": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s120",
        "required": true
      }
    }
  },
  "s120": {
    "kind": "literal",
    "value": "summary_text"
  },
  "s121": {
    "kind": "literal",
    "value": "reasoning"
  },
  "s122": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "action": {
        "schema": "s123",
        "required": true
      },
      "status": {
        "schema": "s114",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s132",
        "required": true
      }
    }
  },
  "s123": {
    "kind": "union",
    "variants": [
      "s4",
      "s124",
      "s126",
      "s128",
      "s130"
    ]
  },
  "s124": {
    "kind": "object",
    "properties": {
      "queries": {
        "schema": "s47",
        "required": true
      },
      "query": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s125",
        "required": true
      }
    }
  },
  "s125": {
    "kind": "literal",
    "value": "search"
  },
  "s126": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s127",
        "required": true
      },
      "url": {
        "schema": "s3",
        "required": true
      }
    }
  },
  "s127": {
    "kind": "literal",
    "value": "open_page"
  },
  "s128": {
    "kind": "object",
    "properties": {
      "pattern": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s129",
        "required": true
      },
      "url": {
        "schema": "s3",
        "required": true
      }
    }
  },
  "s129": {
    "kind": "literal",
    "value": "find_in_page"
  },
  "s130": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s131",
        "required": true
      }
    }
  },
  "s131": {
    "kind": "literal",
    "value": "other"
  },
  "s132": {
    "kind": "literal",
    "value": "web_search_call"
  },
  "s133": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "content": {
        "schema": "s83",
        "required": true
      },
      "recipient_agent_id": {
        "schema": "s1",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s134",
        "required": true
      }
    }
  },
  "s134": {
    "kind": "literal",
    "value": "send_subagent_input_call"
  },
  "s135": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "recipient_agent_id": {
        "schema": "s1",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s136",
        "required": true
      }
    }
  },
  "s136": {
    "kind": "literal",
    "value": "resume_subagent_call"
  },
  "s137": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "recipient_agent_ids": {
        "schema": "s48",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s138",
        "required": true
      }
    }
  },
  "s138": {
    "kind": "literal",
    "value": "wait_for_subagents_call"
  },
  "s139": {
    "kind": "object",
    "properties": {
      "effort": {
        "schema": "s140",
        "required": false
      },
      "summary": {
        "schema": "s141",
        "required": false
      }
    }
  },
  "s140": {
    "kind": "union",
    "variants": [
      "s4",
      "s12",
      "s13",
      "s14",
      "s15",
      "s16",
      "s17",
      "s18"
    ]
  },
  "s141": {
    "kind": "union",
    "variants": [
      "s4",
      "s20",
      "s21",
      "s22"
    ]
  },
  "s142": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "agent": {
        "schema": "s143",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "environment": {
        "schema": "s157",
        "required": true
      },
      "error": {
        "schema": "s3",
        "required": true
      },
      "last_active_at": {
        "schema": "s2",
        "required": true
      },
      "metadata": {
        "schema": "s181",
        "required": true
      },
      "object": {
        "schema": "s182",
        "required": true
      },
      "required_actions": {
        "schema": "s183",
        "required": true
      },
      "status": {
        "schema": "s188",
        "required": true
      },
      "usage": {
        "schema": "s191",
        "required": true
      },
      "vault_ids": {
        "schema": "s48",
        "required": true
      }
    }
  },
  "s143": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "instructions": {
        "schema": "s3",
        "required": true
      },
      "model": {
        "schema": "s1",
        "required": true
      },
      "multi_agent": {
        "schema": "s6",
        "required": true
      },
      "name": {
        "schema": "s3",
        "required": true
      },
      "reasoning": {
        "schema": "s10",
        "required": true
      },
      "service_tier": {
        "schema": "s23",
        "required": true
      },
      "text": {
        "schema": "s28",
        "required": true
      },
      "tools": {
        "schema": "s144",
        "required": true
      }
    }
  },
  "s144": {
    "kind": "array",
    "element": "s145"
  },
  "s145": {
    "kind": "union",
    "variants": [
      "s146",
      "s148",
      "s149",
      "s154"
    ]
  },
  "s146": {
    "kind": "object",
    "properties": {
      "defer_loading": {
        "schema": "s7",
        "required": true
      },
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "parameters": {
        "schema": "s147",
        "required": true
      },
      "type": {
        "schema": "s41",
        "required": true
      }
    }
  },
  "s147": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s148": {
    "kind": "object",
    "properties": {
      "enabled": {
        "schema": "s7",
        "required": true
      },
      "type": {
        "schema": "s45",
        "required": true
      }
    }
  },
  "s149": {
    "kind": "object",
    "properties": {
      "allowed_tools": {
        "schema": "s47",
        "required": true
      },
      "connection_origin": {
        "schema": "s49",
        "required": true
      },
      "credential_id": {
        "schema": "s3",
        "required": true
      },
      "request_metadata": {
        "schema": "s150",
        "required": true
      },
      "required": {
        "schema": "s7",
        "required": true
      },
      "server_label": {
        "schema": "s1",
        "required": true
      },
      "transport": {
        "schema": "s151",
        "required": true
      },
      "type": {
        "schema": "s59",
        "required": true
      }
    }
  },
  "s150": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s151": {
    "kind": "union",
    "variants": [
      "s152",
      "s153"
    ]
  },
  "s152": {
    "kind": "object",
    "properties": {
      "server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s56",
        "required": true
      }
    }
  },
  "s153": {
    "kind": "object",
    "properties": {
      "args": {
        "schema": "s48",
        "required": true
      },
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s1",
        "required": true
      },
      "env_vars": {
        "schema": "s48",
        "required": true
      },
      "type": {
        "schema": "s58",
        "required": true
      }
    }
  },
  "s154": {
    "kind": "object",
    "properties": {
      "allowed_domains": {
        "schema": "s47",
        "required": true
      },
      "context_size": {
        "schema": "s36",
        "required": true
      },
      "location": {
        "schema": "s155",
        "required": true
      },
      "mode": {
        "schema": "s63",
        "required": true
      },
      "type": {
        "schema": "s67",
        "required": true
      }
    }
  },
  "s155": {
    "kind": "union",
    "variants": [
      "s4",
      "s156"
    ]
  },
  "s156": {
    "kind": "object",
    "properties": {
      "city": {
        "schema": "s3",
        "required": true
      },
      "country": {
        "schema": "s3",
        "required": true
      },
      "region": {
        "schema": "s3",
        "required": true
      },
      "timezone": {
        "schema": "s3",
        "required": true
      }
    }
  },
  "s157": {
    "kind": "union",
    "variants": [
      "s158",
      "s159",
      "s179"
    ]
  },
  "s158": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s12",
        "required": true
      }
    }
  },
  "s159": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "capability_directories": {
        "schema": "s48",
        "required": true
      },
      "files": {
        "schema": "s160",
        "required": true
      },
      "network": {
        "schema": "s166",
        "required": true
      },
      "packages": {
        "schema": "s170",
        "required": true
      },
      "plugins": {
        "schema": "s171",
        "required": true
      },
      "skills": {
        "schema": "s173",
        "required": true
      },
      "type": {
        "schema": "s178",
        "required": true
      }
    }
  },
  "s160": {
    "kind": "array",
    "element": "s161"
  },
  "s161": {
    "kind": "union",
    "variants": [
      "s162",
      "s164"
    ]
  },
  "s162": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "file_id": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "size_bytes": {
        "schema": "s2",
        "required": true
      },
      "type": {
        "schema": "s163",
        "required": true
      }
    }
  },
  "s163": {
    "kind": "literal",
    "value": "file_id"
  },
  "s164": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "size_bytes": {
        "schema": "s2",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s165": {
    "kind": "literal",
    "value": "inline"
  },
  "s166": {
    "kind": "object",
    "properties": {
      "access": {
        "schema": "s167",
        "required": true
      },
      "allowed_domains": {
        "schema": "s48",
        "required": true
      }
    }
  },
  "s167": {
    "kind": "union",
    "variants": [
      "s64",
      "s168",
      "s169"
    ]
  },
  "s168": {
    "kind": "literal",
    "value": "enabled"
  },
  "s169": {
    "kind": "literal",
    "value": "restricted"
  },
  "s170": {
    "kind": "object",
    "properties": {
      "npm": {
        "schema": "s48",
        "required": true
      },
      "python": {
        "schema": "s48",
        "required": true
      },
      "system": {
        "schema": "s48",
        "required": true
      }
    }
  },
  "s171": {
    "kind": "array",
    "element": "s172"
  },
  "s172": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s173": {
    "kind": "array",
    "element": "s174"
  },
  "s174": {
    "kind": "union",
    "variants": [
      "s175",
      "s177"
    ]
  },
  "s175": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "skill_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s176",
        "required": true
      },
      "version": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s176": {
    "kind": "literal",
    "value": "skill_reference"
  },
  "s177": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s178": {
    "kind": "literal",
    "value": "openai_hosted"
  },
  "s179": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "capability_directories": {
        "schema": "s48",
        "required": true
      },
      "remote_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s180",
        "required": true
      },
      "workspace_directory": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s180": {
    "kind": "literal",
    "value": "self_hosted"
  },
  "s181": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s182": {
    "kind": "literal",
    "value": "agent.session"
  },
  "s183": {
    "kind": "array",
    "element": "s184"
  },
  "s184": {
    "kind": "union",
    "variants": [
      "s185",
      "s186"
    ]
  },
  "s185": {
    "kind": "object",
    "properties": {
      "arguments": {
        "schema": "s34",
        "required": true
      },
      "call_id": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s88",
        "required": true
      }
    }
  },
  "s186": {
    "kind": "object",
    "properties": {
      "environment_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s187",
        "required": true
      }
    }
  },
  "s187": {
    "kind": "literal",
    "value": "environment_connection"
  },
  "s188": {
    "kind": "union",
    "variants": [
      "s70",
      "s72",
      "s189",
      "s190"
    ]
  },
  "s189": {
    "kind": "literal",
    "value": "idle"
  },
  "s190": {
    "kind": "literal",
    "value": "requires_action"
  },
  "s191": {
    "kind": "union",
    "variants": [
      "s4",
      "s192"
    ]
  },
  "s192": {
    "kind": "object",
    "properties": {
      "input_tokens": {
        "schema": "s2",
        "required": true
      },
      "input_tokens_details": {
        "schema": "s193",
        "required": true
      },
      "output_tokens": {
        "schema": "s2",
        "required": true
      },
      "output_tokens_details": {
        "schema": "s194",
        "required": true
      },
      "total_tokens": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s193": {
    "kind": "object",
    "properties": {
      "cached_tokens": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s194": {
    "kind": "object",
    "properties": {
      "reasoning_tokens": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s195": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session": {
        "schema": "s142",
        "required": true
      },
      "type": {
        "schema": "s196",
        "required": true
      }
    }
  },
  "s196": {
    "kind": "literal",
    "value": "agent.session.created"
  },
  "s197": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s198",
        "required": true
      }
    }
  },
  "s198": {
    "kind": "literal",
    "value": "agent.session.deleted"
  },
  "s199": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s200",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s208",
        "required": true
      }
    }
  },
  "s200": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "error": {
        "schema": "s201",
        "required": true
      },
      "status": {
        "schema": "s203",
        "required": true
      },
      "type": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s201": {
    "kind": "union",
    "variants": [
      "s4",
      "s202"
    ]
  },
  "s202": {
    "kind": "object",
    "properties": {
      "code": {
        "schema": "s1",
        "required": true
      },
      "message": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s203": {
    "kind": "union",
    "variants": [
      "s72",
      "s204",
      "s205",
      "s206",
      "s207"
    ]
  },
  "s204": {
    "kind": "literal",
    "value": "pending"
  },
  "s205": {
    "kind": "literal",
    "value": "ready"
  },
  "s206": {
    "kind": "literal",
    "value": "connected"
  },
  "s207": {
    "kind": "literal",
    "value": "disconnected"
  },
  "s208": {
    "kind": "literal",
    "value": "agent.session.environment.connected"
  },
  "s209": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s200",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s210",
        "required": true
      }
    }
  },
  "s210": {
    "kind": "literal",
    "value": "agent.session.environment.disconnected"
  },
  "s211": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s200",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s212",
        "required": true
      }
    }
  },
  "s212": {
    "kind": "literal",
    "value": "agent.session.environment.failed"
  },
  "s213": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s200",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s214",
        "required": true
      }
    }
  },
  "s214": {
    "kind": "literal",
    "value": "agent.session.environment.pending"
  },
  "s215": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s200",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s216",
        "required": true
      }
    }
  },
  "s216": {
    "kind": "literal",
    "value": "agent.session.environment.ready"
  },
  "s217": {
    "kind": "object",
    "properties": {
      "error": {
        "schema": "s218",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s219",
        "required": true
      }
    }
  },
  "s218": {
    "kind": "object",
    "properties": {
      "code": {
        "schema": "s3",
        "required": true
      },
      "message": {
        "schema": "s1",
        "required": true
      },
      "param": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s219": {
    "kind": "literal",
    "value": "error"
  },
  "s220": {
    "kind": "union",
    "variants": [
      "s105",
      "s195",
      "s199",
      "s209",
      "s211",
      "s213",
      "s215",
      "s217",
      "s221",
      "s248",
      "s250",
      "s252",
      "s254",
      "s256",
      "s272",
      "s274",
      "s276",
      "s278",
      "s280",
      "s288",
      "s290",
      "s292",
      "s294",
      "s296",
      "s298",
      "s300",
      "s302",
      "s304",
      "s307",
      "s309"
    ]
  },
  "s221": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn": {
        "schema": "s222",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s247",
        "required": true
      }
    }
  },
  "s222": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "agent_id": {
        "schema": "s1",
        "required": true
      },
      "completed_at": {
        "schema": "s8",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "error": {
        "schema": "s223",
        "required": true
      },
      "object": {
        "schema": "s242",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "started_at": {
        "schema": "s8",
        "required": true
      },
      "status": {
        "schema": "s243",
        "required": true
      },
      "subagent_id": {
        "schema": "s3",
        "required": true
      },
      "usage": {
        "schema": "s191",
        "required": true
      }
    }
  },
  "s223": {
    "kind": "union",
    "variants": [
      "s4",
      "s224"
    ]
  },
  "s224": {
    "kind": "object",
    "properties": {
      "code": {
        "schema": "s225",
        "required": true
      },
      "message": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s225": {
    "kind": "union",
    "variants": [
      "s226",
      "s227",
      "s228",
      "s229",
      "s230",
      "s231",
      "s232",
      "s233",
      "s234",
      "s235",
      "s236",
      "s237",
      "s238",
      "s239",
      "s240",
      "s241"
    ]
  },
  "s226": {
    "kind": "literal",
    "value": "context_length_exceeded"
  },
  "s227": {
    "kind": "literal",
    "value": "session_budget_exceeded"
  },
  "s228": {
    "kind": "literal",
    "value": "usage_limit_exceeded"
  },
  "s229": {
    "kind": "literal",
    "value": "rate_limit_exceeded"
  },
  "s230": {
    "kind": "literal",
    "value": "server_overloaded"
  },
  "s231": {
    "kind": "literal",
    "value": "cyber_policy"
  },
  "s232": {
    "kind": "literal",
    "value": "connection_failed"
  },
  "s233": {
    "kind": "literal",
    "value": "server_error"
  },
  "s234": {
    "kind": "literal",
    "value": "authentication_error"
  },
  "s235": {
    "kind": "literal",
    "value": "invalid_request"
  },
  "s236": {
    "kind": "literal",
    "value": "resource_not_found"
  },
  "s237": {
    "kind": "literal",
    "value": "sandbox_error"
  },
  "s238": {
    "kind": "literal",
    "value": "executor_version_incompatible"
  },
  "s239": {
    "kind": "literal",
    "value": "active_turn_not_steerable"
  },
  "s240": {
    "kind": "literal",
    "value": "request_timeout"
  },
  "s241": {
    "kind": "literal",
    "value": "internal_error"
  },
  "s242": {
    "kind": "literal",
    "value": "agent.session.turn"
  },
  "s243": {
    "kind": "union",
    "variants": [
      "s70",
      "s71",
      "s72",
      "s244",
      "s245",
      "s246"
    ]
  },
  "s244": {
    "kind": "literal",
    "value": "queued"
  },
  "s245": {
    "kind": "literal",
    "value": "waiting"
  },
  "s246": {
    "kind": "literal",
    "value": "cancelled"
  },
  "s247": {
    "kind": "literal",
    "value": "agent.session.turn.created"
  },
  "s248": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn": {
        "schema": "s222",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s249",
        "required": true
      }
    }
  },
  "s249": {
    "kind": "literal",
    "value": "agent.session.turn.in_progress"
  },
  "s250": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn": {
        "schema": "s222",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s251",
        "required": true
      },
      "usage": {
        "schema": "s191",
        "required": true
      }
    }
  },
  "s251": {
    "kind": "literal",
    "value": "agent.session.turn.completed"
  },
  "s252": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn": {
        "schema": "s222",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s253",
        "required": true
      },
      "usage": {
        "schema": "s191",
        "required": true
      }
    }
  },
  "s253": {
    "kind": "literal",
    "value": "agent.session.turn.failed"
  },
  "s254": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn": {
        "schema": "s222",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s255",
        "required": true
      },
      "usage": {
        "schema": "s191",
        "required": true
      }
    }
  },
  "s255": {
    "kind": "literal",
    "value": "agent.session.turn.cancelled"
  },
  "s256": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item": {
        "schema": "s257",
        "required": true
      },
      "output_index": {
        "schema": "s8",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s271",
        "required": true
      }
    }
  },
  "s257": {
    "kind": "union",
    "variants": [
      "s68",
      "s75",
      "s82",
      "s87",
      "s101",
      "s103",
      "s116",
      "s122",
      "s133",
      "s135",
      "s137",
      "s258",
      "s266",
      "s269"
    ]
  },
  "s258": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s3",
        "required": true
      },
      "content": {
        "schema": "s259",
        "required": true
      },
      "phase": {
        "schema": "s110",
        "required": true
      },
      "role": {
        "schema": "s264",
        "required": true
      },
      "status": {
        "schema": "s114",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s115",
        "required": true
      }
    }
  },
  "s259": {
    "kind": "array",
    "element": "s260"
  },
  "s260": {
    "kind": "union",
    "variants": [
      "s261",
      "s262",
      "s263"
    ]
  },
  "s261": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s93",
        "required": true
      }
    }
  },
  "s262": {
    "kind": "object",
    "properties": {
      "image_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s95",
        "required": true
      }
    }
  },
  "s263": {
    "kind": "object",
    "properties": {
      "text": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s79",
        "required": true
      }
    }
  },
  "s264": {
    "kind": "union",
    "variants": [
      "s113",
      "s265"
    ]
  },
  "s265": {
    "kind": "literal",
    "value": "user"
  },
  "s266": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "call_id": {
        "schema": "s1",
        "required": true
      },
      "error": {
        "schema": "s3",
        "required": true
      },
      "output": {
        "schema": "s267",
        "required": true
      },
      "status": {
        "schema": "s69",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s268",
        "required": true
      }
    }
  },
  "s267": {
    "kind": "union",
    "variants": [
      "s4",
      "s1",
      "s90"
    ]
  },
  "s268": {
    "kind": "literal",
    "value": "function_call_output"
  },
  "s269": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "content": {
        "schema": "s83",
        "required": true
      },
      "recipient_agent_id": {
        "schema": "s1",
        "required": true
      },
      "sender_agent_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s270",
        "required": true
      }
    }
  },
  "s270": {
    "kind": "literal",
    "value": "agent_message"
  },
  "s271": {
    "kind": "literal",
    "value": "agent.session.turn.item.added"
  },
  "s272": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session": {
        "schema": "s142",
        "required": true
      },
      "type": {
        "schema": "s273",
        "required": true
      }
    }
  },
  "s273": {
    "kind": "literal",
    "value": "agent.session.idle"
  },
  "s274": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session": {
        "schema": "s142",
        "required": true
      },
      "type": {
        "schema": "s275",
        "required": true
      }
    }
  },
  "s275": {
    "kind": "literal",
    "value": "agent.session.in_progress"
  },
  "s276": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session": {
        "schema": "s142",
        "required": true
      },
      "type": {
        "schema": "s277",
        "required": true
      }
    }
  },
  "s277": {
    "kind": "literal",
    "value": "agent.session.requires_action"
  },
  "s278": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "session": {
        "schema": "s142",
        "required": true
      },
      "type": {
        "schema": "s279",
        "required": true
      }
    }
  },
  "s279": {
    "kind": "literal",
    "value": "agent.session.failed"
  },
  "s280": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "subagent": {
        "schema": "s281",
        "required": true
      },
      "type": {
        "schema": "s287",
        "required": true
      }
    }
  },
  "s281": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "closed_at": {
        "schema": "s8",
        "required": true
      },
      "instructions": {
        "schema": "s282",
        "required": true
      },
      "name": {
        "schema": "s3",
        "required": true
      },
      "object": {
        "schema": "s283",
        "required": true
      },
      "opened_at": {
        "schema": "s2",
        "required": true
      },
      "parent_agent_id": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s284",
        "required": true
      }
    }
  },
  "s282": {
    "kind": "union",
    "variants": [
      "s4",
      "s83"
    ]
  },
  "s283": {
    "kind": "literal",
    "value": "agent.session.subagent"
  },
  "s284": {
    "kind": "union",
    "variants": [
      "s285",
      "s286"
    ]
  },
  "s285": {
    "kind": "literal",
    "value": "active"
  },
  "s286": {
    "kind": "literal",
    "value": "closed"
  },
  "s287": {
    "kind": "literal",
    "value": "agent.session.subagent.created"
  },
  "s288": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "subagent": {
        "schema": "s281",
        "required": true
      },
      "type": {
        "schema": "s289",
        "required": true
      }
    }
  },
  "s289": {
    "kind": "literal",
    "value": "agent.session.subagent.active"
  },
  "s290": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "subagent": {
        "schema": "s281",
        "required": true
      },
      "type": {
        "schema": "s291",
        "required": true
      }
    }
  },
  "s291": {
    "kind": "literal",
    "value": "agent.session.subagent.closed"
  },
  "s292": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item": {
        "schema": "s107",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s293",
        "required": true
      }
    }
  },
  "s293": {
    "kind": "literal",
    "value": "agent.session.turn.item.done"
  },
  "s294": {
    "kind": "object",
    "properties": {
      "content_index": {
        "schema": "s2",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "part": {
        "schema": "s78",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s295",
        "required": true
      }
    }
  },
  "s295": {
    "kind": "literal",
    "value": "agent.session.turn.content_part.added"
  },
  "s296": {
    "kind": "object",
    "properties": {
      "content_index": {
        "schema": "s2",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "part": {
        "schema": "s78",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s297",
        "required": true
      }
    }
  },
  "s297": {
    "kind": "literal",
    "value": "agent.session.turn.content_part.done"
  },
  "s298": {
    "kind": "object",
    "properties": {
      "content_index": {
        "schema": "s2",
        "required": true
      },
      "delta": {
        "schema": "s1",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s299",
        "required": true
      }
    }
  },
  "s299": {
    "kind": "literal",
    "value": "agent.session.turn.output_text.delta"
  },
  "s300": {
    "kind": "object",
    "properties": {
      "content_index": {
        "schema": "s2",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "text": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s301",
        "required": true
      }
    }
  },
  "s301": {
    "kind": "literal",
    "value": "agent.session.turn.output_text.done"
  },
  "s302": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "part": {
        "schema": "s119",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "summary_index": {
        "schema": "s2",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s303",
        "required": true
      }
    }
  },
  "s303": {
    "kind": "literal",
    "value": "agent.session.turn.reasoning_summary_part.added"
  },
  "s304": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "part": {
        "schema": "s119",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "status": {
        "schema": "s305",
        "required": true
      },
      "summary_index": {
        "schema": "s2",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s306",
        "required": true
      }
    }
  },
  "s305": {
    "kind": "union",
    "variants": [
      "s4",
      "s73"
    ]
  },
  "s306": {
    "kind": "literal",
    "value": "agent.session.turn.reasoning_summary_part.done"
  },
  "s307": {
    "kind": "object",
    "properties": {
      "delta": {
        "schema": "s1",
        "required": true
      },
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "summary_index": {
        "schema": "s2",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s308",
        "required": true
      }
    }
  },
  "s308": {
    "kind": "literal",
    "value": "agent.session.turn.reasoning_summary_text.delta"
  },
  "s309": {
    "kind": "object",
    "properties": {
      "event_id": {
        "schema": "s1",
        "required": true
      },
      "item_id": {
        "schema": "s1",
        "required": true
      },
      "output_index": {
        "schema": "s2",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "summary_index": {
        "schema": "s2",
        "required": true
      },
      "text": {
        "schema": "s1",
        "required": true
      },
      "turn_id": {
        "schema": "s3",
        "required": true
      },
      "type": {
        "schema": "s310",
        "required": true
      }
    }
  },
  "s310": {
    "kind": "literal",
    "value": "agent.session.turn.reasoning_summary_text.done"
  },
  "s311": {
    "kind": "object",
    "properties": {
      "content": {
        "schema": "s312",
        "required": true
      },
      "role": {
        "schema": "s265",
        "required": true
      },
      "type": {
        "schema": "s313",
        "required": false
      }
    }
  },
  "s312": {
    "kind": "array",
    "element": "s98"
  },
  "s313": {
    "kind": "union",
    "variants": [
      "s115"
    ]
  },
  "s314": {
    "kind": "union",
    "variants": [
      "s315",
      "s318",
      "s320"
    ]
  },
  "s315": {
    "kind": "object",
    "properties": {
      "input": {
        "schema": "s316",
        "required": true
      },
      "type": {
        "schema": "s317",
        "required": true
      }
    }
  },
  "s316": {
    "kind": "array",
    "element": "s311"
  },
  "s317": {
    "kind": "literal",
    "value": "agent.session.input.message"
  },
  "s318": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s319",
        "required": true
      }
    }
  },
  "s319": {
    "kind": "literal",
    "value": "agent.session.input.cancel"
  },
  "s320": {
    "kind": "object",
    "properties": {
      "call_id": {
        "schema": "s1",
        "required": true
      },
      "success": {
        "schema": "s7",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s321",
        "required": true
      },
      "error": {
        "schema": "s322",
        "required": false
      },
      "output": {
        "schema": "s323",
        "required": false
      }
    }
  },
  "s321": {
    "kind": "literal",
    "value": "agent.session.input.tool_result"
  },
  "s322": {
    "kind": "union",
    "variants": [
      "s4",
      "s1"
    ]
  },
  "s323": {
    "kind": "union",
    "variants": [
      "s4",
      "s1",
      "s97"
    ]
  },
  "s324": {
    "kind": "object",
    "properties": {
      "format": {
        "schema": "s325",
        "required": false
      },
      "verbosity": {
        "schema": "s329",
        "required": false
      }
    }
  },
  "s325": {
    "kind": "union",
    "variants": [
      "s4",
      "s326",
      "s327"
    ]
  },
  "s326": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s31",
        "required": true
      }
    }
  },
  "s327": {
    "kind": "object",
    "properties": {
      "schema": {
        "schema": "s328",
        "required": true
      },
      "type": {
        "schema": "s35",
        "required": true
      }
    }
  },
  "s328": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s329": {
    "kind": "union",
    "variants": [
      "s4",
      "s14",
      "s15",
      "s16"
    ]
  },
  "s330": {
    "kind": "union",
    "variants": [
      "s331",
      "s336",
      "s337",
      "s338",
      "s350"
    ]
  },
  "s331": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "parameters": {
        "schema": "s332",
        "required": true
      },
      "type": {
        "schema": "s41",
        "required": true
      },
      "defer_loading": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s332": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s333": {
    "kind": "union",
    "variants": [
      "s334",
      "s335"
    ]
  },
  "s334": {
    "kind": "literal",
    "value": false
  },
  "s335": {
    "kind": "literal",
    "value": true
  },
  "s336": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s43",
        "required": true
      }
    }
  },
  "s337": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s45",
        "required": true
      },
      "enabled": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s338": {
    "kind": "object",
    "properties": {
      "server_label": {
        "schema": "s1",
        "required": true
      },
      "transport": {
        "schema": "s339",
        "required": true
      },
      "type": {
        "schema": "s59",
        "required": true
      },
      "allowed_tools": {
        "schema": "s344",
        "required": false
      },
      "connection_origin": {
        "schema": "s347",
        "required": false
      },
      "credential_id": {
        "schema": "s322",
        "required": false
      },
      "request_metadata": {
        "schema": "s348",
        "required": false
      },
      "required": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s339": {
    "kind": "union",
    "variants": [
      "s340",
      "s343"
    ]
  },
  "s340": {
    "kind": "object",
    "properties": {
      "server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s56",
        "required": true
      },
      "authorization": {
        "schema": "s322",
        "required": false
      },
      "headers": {
        "schema": "s341",
        "required": false
      }
    }
  },
  "s341": {
    "kind": "union",
    "variants": [
      "s4",
      "s342"
    ]
  },
  "s342": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s343": {
    "kind": "object",
    "properties": {
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s58",
        "required": true
      },
      "args": {
        "schema": "s344",
        "required": false
      },
      "env": {
        "schema": "s345",
        "required": false
      },
      "env_vars": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s344": {
    "kind": "union",
    "variants": [
      "s4",
      "s48"
    ]
  },
  "s345": {
    "kind": "union",
    "variants": [
      "s4",
      "s346"
    ]
  },
  "s346": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s347": {
    "kind": "union",
    "variants": [
      "s4",
      "s50",
      "s51"
    ]
  },
  "s348": {
    "kind": "union",
    "variants": [
      "s4",
      "s349"
    ]
  },
  "s349": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s350": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s67",
        "required": true
      },
      "allowed_domains": {
        "schema": "s344",
        "required": false
      },
      "context_size": {
        "schema": "s329",
        "required": false
      },
      "location": {
        "schema": "s351",
        "required": false
      },
      "mode": {
        "schema": "s353",
        "required": false
      }
    }
  },
  "s351": {
    "kind": "union",
    "variants": [
      "s4",
      "s352"
    ]
  },
  "s352": {
    "kind": "object",
    "properties": {
      "city": {
        "schema": "s322",
        "required": false
      },
      "country": {
        "schema": "s322",
        "required": false
      },
      "region": {
        "schema": "s322",
        "required": false
      },
      "timezone": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s353": {
    "kind": "union",
    "variants": [
      "s4",
      "s64",
      "s65",
      "s66"
    ]
  },
  "s354": {
    "kind": "union",
    "variants": [
      "s355",
      "s356",
      "s383"
    ]
  },
  "s355": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s12",
        "required": true
      }
    }
  },
  "s356": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s178",
        "required": true
      },
      "capability_directories": {
        "schema": "s344",
        "required": false
      },
      "env": {
        "schema": "s357",
        "required": false
      },
      "environment_template_id": {
        "schema": "s359",
        "required": false
      },
      "files": {
        "schema": "s360",
        "required": false
      },
      "network": {
        "schema": "s365",
        "required": false
      },
      "packages": {
        "schema": "s367",
        "required": false
      },
      "plugins": {
        "schema": "s369",
        "required": false
      },
      "setup_commands": {
        "schema": "s375",
        "required": false
      },
      "skills": {
        "schema": "s378",
        "required": false
      }
    }
  },
  "s357": {
    "kind": "union",
    "variants": [
      "s4",
      "s358"
    ]
  },
  "s358": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s359": {
    "kind": "union",
    "variants": [
      "s1"
    ]
  },
  "s360": {
    "kind": "union",
    "variants": [
      "s4",
      "s361"
    ]
  },
  "s361": {
    "kind": "array",
    "element": "s362"
  },
  "s362": {
    "kind": "union",
    "variants": [
      "s363",
      "s364"
    ]
  },
  "s363": {
    "kind": "object",
    "properties": {
      "file_id": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s163",
        "required": true
      }
    }
  },
  "s364": {
    "kind": "object",
    "properties": {
      "data": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s365": {
    "kind": "union",
    "variants": [
      "s4",
      "s366"
    ]
  },
  "s366": {
    "kind": "object",
    "properties": {
      "access": {
        "schema": "s167",
        "required": true
      },
      "allowed_domains": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s367": {
    "kind": "union",
    "variants": [
      "s4",
      "s368"
    ]
  },
  "s368": {
    "kind": "object",
    "properties": {
      "npm": {
        "schema": "s344",
        "required": false
      },
      "python": {
        "schema": "s344",
        "required": false
      },
      "system": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s369": {
    "kind": "union",
    "variants": [
      "s4",
      "s370"
    ]
  },
  "s370": {
    "kind": "array",
    "element": "s371"
  },
  "s371": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "source": {
        "schema": "s372",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s372": {
    "kind": "object",
    "properties": {
      "data": {
        "schema": "s1",
        "required": true
      },
      "media_type": {
        "schema": "s373",
        "required": true
      },
      "type": {
        "schema": "s374",
        "required": true
      }
    }
  },
  "s373": {
    "kind": "literal",
    "value": "application/zip"
  },
  "s374": {
    "kind": "literal",
    "value": "base64"
  },
  "s375": {
    "kind": "union",
    "variants": [
      "s4",
      "s376"
    ]
  },
  "s376": {
    "kind": "array",
    "element": "s377"
  },
  "s377": {
    "kind": "object",
    "properties": {
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s378": {
    "kind": "union",
    "variants": [
      "s4",
      "s379"
    ]
  },
  "s379": {
    "kind": "array",
    "element": "s380"
  },
  "s380": {
    "kind": "union",
    "variants": [
      "s381",
      "s382"
    ]
  },
  "s381": {
    "kind": "object",
    "properties": {
      "skill_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s176",
        "required": true
      },
      "version": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s382": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "source": {
        "schema": "s372",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s383": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s180",
        "required": true
      },
      "workspace_directory": {
        "schema": "s1",
        "required": true
      },
      "capability_directories": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s384": {
    "kind": "object",
    "properties": {
      "enabled": {
        "schema": "s7",
        "required": true
      },
      "max_concurrent_subagents": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s385": {
    "kind": "union",
    "variants": [
      "s2"
    ]
  },
  "s386": {
    "kind": "union",
    "variants": [
      "s387",
      "s389",
      "s390",
      "s391",
      "s399"
    ]
  },
  "s387": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "parameters": {
        "schema": "s388",
        "required": true
      },
      "type": {
        "schema": "s41",
        "required": true
      },
      "defer_loading": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s388": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s389": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s43",
        "required": true
      }
    }
  },
  "s390": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s45",
        "required": true
      },
      "enabled": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s391": {
    "kind": "object",
    "properties": {
      "server_label": {
        "schema": "s1",
        "required": true
      },
      "transport": {
        "schema": "s392",
        "required": true
      },
      "type": {
        "schema": "s59",
        "required": true
      },
      "allowed_tools": {
        "schema": "s344",
        "required": false
      },
      "connection_origin": {
        "schema": "s347",
        "required": false
      },
      "credential_id": {
        "schema": "s322",
        "required": false
      },
      "request_metadata": {
        "schema": "s397",
        "required": false
      },
      "required": {
        "schema": "s333",
        "required": false
      }
    }
  },
  "s392": {
    "kind": "union",
    "variants": [
      "s393",
      "s396"
    ]
  },
  "s393": {
    "kind": "object",
    "properties": {
      "server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s56",
        "required": true
      },
      "headers": {
        "schema": "s394",
        "required": false
      }
    }
  },
  "s394": {
    "kind": "union",
    "variants": [
      "s4",
      "s395"
    ]
  },
  "s395": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s396": {
    "kind": "object",
    "properties": {
      "command": {
        "schema": "s1",
        "required": true
      },
      "cwd": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s58",
        "required": true
      },
      "args": {
        "schema": "s344",
        "required": false
      },
      "env_vars": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s397": {
    "kind": "union",
    "variants": [
      "s4",
      "s398"
    ]
  },
  "s398": {
    "kind": "object",
    "properties": {},
    "additional": "s34"
  },
  "s399": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s67",
        "required": true
      },
      "allowed_domains": {
        "schema": "s344",
        "required": false
      },
      "context_size": {
        "schema": "s329",
        "required": false
      },
      "location": {
        "schema": "s400",
        "required": false
      },
      "mode": {
        "schema": "s353",
        "required": false
      }
    }
  },
  "s400": {
    "kind": "union",
    "variants": [
      "s4",
      "s401"
    ]
  },
  "s401": {
    "kind": "object",
    "properties": {
      "city": {
        "schema": "s322",
        "required": false
      },
      "country": {
        "schema": "s322",
        "required": false
      },
      "region": {
        "schema": "s322",
        "required": false
      },
      "timezone": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s402": {
    "kind": "union",
    "variants": [
      "s326",
      "s327"
    ]
  },
  "s403": {
    "kind": "union",
    "variants": [
      "s124",
      "s126",
      "s128",
      "s130"
    ]
  },
  "s404": {
    "kind": "object",
    "properties": {
      "model": {
        "schema": "s1",
        "required": true
      },
      "instructions": {
        "schema": "s322",
        "required": false
      },
      "metadata": {
        "schema": "s405",
        "required": false
      },
      "multi_agent": {
        "schema": "s407",
        "required": false
      },
      "name": {
        "schema": "s322",
        "required": false
      },
      "reasoning": {
        "schema": "s408",
        "required": false
      },
      "service_tier": {
        "schema": "s409",
        "required": false
      },
      "text": {
        "schema": "s410",
        "required": false
      },
      "tools": {
        "schema": "s411",
        "required": false
      }
    }
  },
  "s405": {
    "kind": "union",
    "variants": [
      "s4",
      "s406"
    ]
  },
  "s406": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s407": {
    "kind": "union",
    "variants": [
      "s4",
      "s384"
    ]
  },
  "s408": {
    "kind": "union",
    "variants": [
      "s4",
      "s139"
    ]
  },
  "s409": {
    "kind": "union",
    "variants": [
      "s4",
      "s22",
      "s24",
      "s25",
      "s26",
      "s27"
    ]
  },
  "s410": {
    "kind": "union",
    "variants": [
      "s4",
      "s324"
    ]
  },
  "s411": {
    "kind": "union",
    "variants": [
      "s4",
      "s412"
    ]
  },
  "s412": {
    "kind": "array",
    "element": "s386"
  },
  "s413": {
    "kind": "object",
    "properties": {
      "instructions": {
        "schema": "s322",
        "required": false
      },
      "metadata": {
        "schema": "s414",
        "required": false
      },
      "model": {
        "schema": "s359",
        "required": false
      },
      "multi_agent": {
        "schema": "s407",
        "required": false
      },
      "name": {
        "schema": "s322",
        "required": false
      },
      "reasoning": {
        "schema": "s408",
        "required": false
      },
      "service_tier": {
        "schema": "s409",
        "required": false
      },
      "text": {
        "schema": "s410",
        "required": false
      },
      "tools": {
        "schema": "s411",
        "required": false
      }
    }
  },
  "s414": {
    "kind": "union",
    "variants": [
      "s4",
      "s415"
    ]
  },
  "s415": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s416": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s417": {
    "kind": "union",
    "variants": [
      "s418",
      "s419"
    ]
  },
  "s418": {
    "kind": "literal",
    "value": "asc"
  },
  "s419": {
    "kind": "literal",
    "value": "desc"
  },
  "s420": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "files": {
        "schema": "s160",
        "required": true
      },
      "object": {
        "schema": "s421",
        "required": true
      },
      "plugins": {
        "schema": "s171",
        "required": true
      },
      "skills": {
        "schema": "s173",
        "required": true
      },
      "status": {
        "schema": "s422",
        "required": true
      },
      "type": {
        "schema": "s424",
        "required": true
      }
    }
  },
  "s421": {
    "kind": "literal",
    "value": "agent.environment"
  },
  "s422": {
    "kind": "union",
    "variants": [
      "s72",
      "s204",
      "s206",
      "s207",
      "s423"
    ]
  },
  "s423": {
    "kind": "literal",
    "value": "expired"
  },
  "s424": {
    "kind": "union",
    "variants": [
      "s178",
      "s180"
    ]
  },
  "s425": {
    "kind": "object",
    "properties": {
      "environment_id": {
        "schema": "s1",
        "required": true
      },
      "object": {
        "schema": "s426",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "size_bytes": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s426": {
    "kind": "literal",
    "value": "agent.environment.file"
  },
  "s427": {
    "kind": "union",
    "variants": [
      "s428",
      "s429"
    ]
  },
  "s428": {
    "kind": "object",
    "properties": {
      "file_id": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s163",
        "required": true
      }
    }
  },
  "s429": {
    "kind": "object",
    "properties": {
      "data": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s430": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "path": {
        "schema": "s322",
        "required": false
      },
      "page": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s431": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "capability_directories": {
        "schema": "s48",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "files": {
        "schema": "s432",
        "required": true
      },
      "name": {
        "schema": "s3",
        "required": true
      },
      "network": {
        "schema": "s436",
        "required": true
      },
      "object": {
        "schema": "s437",
        "required": true
      },
      "packages": {
        "schema": "s438",
        "required": true
      },
      "plugins": {
        "schema": "s171",
        "required": true
      },
      "skills": {
        "schema": "s439",
        "required": true
      },
      "updated_at": {
        "schema": "s2",
        "required": true
      }
    }
  },
  "s432": {
    "kind": "array",
    "element": "s433"
  },
  "s433": {
    "kind": "union",
    "variants": [
      "s434",
      "s435"
    ]
  },
  "s434": {
    "kind": "object",
    "properties": {
      "file_id": {
        "schema": "s1",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s163",
        "required": true
      }
    }
  },
  "s435": {
    "kind": "object",
    "properties": {
      "path": {
        "schema": "s1",
        "required": true
      },
      "size_bytes": {
        "schema": "s2",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s436": {
    "kind": "object",
    "properties": {
      "access": {
        "schema": "s167",
        "required": true
      },
      "allowed_domains": {
        "schema": "s48",
        "required": true
      }
    }
  },
  "s437": {
    "kind": "literal",
    "value": "agent.environment.template"
  },
  "s438": {
    "kind": "object",
    "properties": {
      "npm": {
        "schema": "s48",
        "required": true
      },
      "python": {
        "schema": "s48",
        "required": true
      },
      "system": {
        "schema": "s48",
        "required": true
      }
    }
  },
  "s439": {
    "kind": "array",
    "element": "s440"
  },
  "s440": {
    "kind": "union",
    "variants": [
      "s441",
      "s442"
    ]
  },
  "s441": {
    "kind": "object",
    "properties": {
      "skill_id": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s176",
        "required": true
      },
      "version": {
        "schema": "s3",
        "required": true
      }
    }
  },
  "s442": {
    "kind": "object",
    "properties": {
      "description": {
        "schema": "s1",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s165",
        "required": true
      }
    }
  },
  "s443": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s444",
        "required": true
      }
    }
  },
  "s444": {
    "kind": "literal",
    "value": "agent.environment.template.deleted"
  },
  "s445": {
    "kind": "object",
    "properties": {
      "capability_directories": {
        "schema": "s344",
        "required": false
      },
      "env": {
        "schema": "s446",
        "required": false
      },
      "files": {
        "schema": "s360",
        "required": false
      },
      "name": {
        "schema": "s322",
        "required": false
      },
      "network": {
        "schema": "s448",
        "required": false
      },
      "packages": {
        "schema": "s450",
        "required": false
      },
      "plugins": {
        "schema": "s369",
        "required": false
      },
      "setup_commands": {
        "schema": "s375",
        "required": false
      },
      "skills": {
        "schema": "s378",
        "required": false
      }
    }
  },
  "s446": {
    "kind": "union",
    "variants": [
      "s4",
      "s447"
    ]
  },
  "s447": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s448": {
    "kind": "union",
    "variants": [
      "s4",
      "s449"
    ]
  },
  "s449": {
    "kind": "object",
    "properties": {
      "access": {
        "schema": "s167",
        "required": true
      },
      "allowed_domains": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s450": {
    "kind": "union",
    "variants": [
      "s4",
      "s451"
    ]
  },
  "s451": {
    "kind": "object",
    "properties": {
      "npm": {
        "schema": "s344",
        "required": false
      },
      "python": {
        "schema": "s344",
        "required": false
      },
      "system": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s452": {
    "kind": "object",
    "properties": {
      "capability_directories": {
        "schema": "s344",
        "required": false
      },
      "env": {
        "schema": "s453",
        "required": false
      },
      "files": {
        "schema": "s360",
        "required": false
      },
      "name": {
        "schema": "s322",
        "required": false
      },
      "network": {
        "schema": "s455",
        "required": false
      },
      "packages": {
        "schema": "s457",
        "required": false
      },
      "plugins": {
        "schema": "s369",
        "required": false
      },
      "setup_commands": {
        "schema": "s375",
        "required": false
      },
      "skills": {
        "schema": "s378",
        "required": false
      }
    }
  },
  "s453": {
    "kind": "union",
    "variants": [
      "s4",
      "s454"
    ]
  },
  "s454": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s455": {
    "kind": "union",
    "variants": [
      "s4",
      "s456"
    ]
  },
  "s456": {
    "kind": "object",
    "properties": {
      "access": {
        "schema": "s167",
        "required": true
      },
      "allowed_domains": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s457": {
    "kind": "union",
    "variants": [
      "s4",
      "s458"
    ]
  },
  "s458": {
    "kind": "object",
    "properties": {
      "npm": {
        "schema": "s344",
        "required": false
      },
      "python": {
        "schema": "s344",
        "required": false
      },
      "system": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s459": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s460": {
    "kind": "union",
    "variants": [
      "s461",
      "s470"
    ]
  },
  "s461": {
    "kind": "object",
    "properties": {
      "stream": {
        "schema": "s462",
        "required": false
      },
      "environment": {
        "schema": "s354",
        "required": true
      },
      "agent": {
        "schema": "s463",
        "required": false
      },
      "agent_id": {
        "schema": "s359",
        "required": false
      },
      "input": {
        "schema": "s467",
        "required": false
      },
      "metadata": {
        "schema": "s468",
        "required": false
      },
      "vault_ids": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s462": {
    "kind": "union",
    "variants": [
      "s334"
    ]
  },
  "s463": {
    "kind": "union",
    "variants": [
      "s464"
    ]
  },
  "s464": {
    "kind": "object",
    "properties": {
      "instructions": {
        "schema": "s322",
        "required": false
      },
      "model": {
        "schema": "s359",
        "required": false
      },
      "multi_agent": {
        "schema": "s407",
        "required": false
      },
      "reasoning": {
        "schema": "s408",
        "required": false
      },
      "service_tier": {
        "schema": "s409",
        "required": false
      },
      "text": {
        "schema": "s410",
        "required": false
      },
      "tools": {
        "schema": "s465",
        "required": false
      }
    }
  },
  "s465": {
    "kind": "union",
    "variants": [
      "s4",
      "s466"
    ]
  },
  "s466": {
    "kind": "array",
    "element": "s330"
  },
  "s467": {
    "kind": "union",
    "variants": [
      "s4",
      "s1",
      "s316"
    ]
  },
  "s468": {
    "kind": "union",
    "variants": [
      "s4",
      "s469"
    ]
  },
  "s469": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s470": {
    "kind": "object",
    "properties": {
      "stream": {
        "schema": "s335",
        "required": true
      },
      "environment": {
        "schema": "s354",
        "required": true
      },
      "agent": {
        "schema": "s463",
        "required": false
      },
      "agent_id": {
        "schema": "s359",
        "required": false
      },
      "input": {
        "schema": "s467",
        "required": false
      },
      "metadata": {
        "schema": "s468",
        "required": false
      },
      "vault_ids": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s471": {
    "kind": "object",
    "properties": {
      "environment": {
        "schema": "s354",
        "required": true
      },
      "agent": {
        "schema": "s463",
        "required": false
      },
      "agent_id": {
        "schema": "s359",
        "required": false
      },
      "input": {
        "schema": "s467",
        "required": false
      },
      "metadata": {
        "schema": "s468",
        "required": false
      },
      "stream": {
        "schema": "s333",
        "required": false
      },
      "vault_ids": {
        "schema": "s344",
        "required": false
      }
    }
  },
  "s472": {
    "kind": "object",
    "properties": {
      "metadata": {
        "schema": "s473",
        "required": false
      }
    }
  },
  "s473": {
    "kind": "union",
    "variants": [
      "s4",
      "s474"
    ]
  },
  "s474": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s475": {
    "kind": "object",
    "properties": {
      "agent_id": {
        "schema": "s359",
        "required": false
      },
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s476": {
    "kind": "object",
    "properties": {
      "events": {
        "schema": "s477",
        "required": true
      },
      "Idempotency-Key": {
        "schema": "s359",
        "required": false
      }
    }
  },
  "s477": {
    "kind": "array",
    "element": "s314"
  },
  "s478": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s479": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s480": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s481": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "environment_id": {
        "schema": "s1",
        "required": true
      },
      "object": {
        "schema": "s482",
        "required": true
      },
      "path": {
        "schema": "s1",
        "required": true
      },
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "size_bytes": {
        "schema": "s2",
        "required": true
      },
      "turn_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s482": {
    "kind": "literal",
    "value": "agent.session.artifact"
  },
  "s483": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s484",
        "required": true
      }
    }
  },
  "s484": {
    "kind": "literal",
    "value": "agent.session.artifact.deleted"
  },
  "s485": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s486": {
    "kind": "object",
    "properties": {
      "environment_id": {
        "schema": "s322",
        "required": false
      },
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s487": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s488": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s489": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s490": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s491": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s492": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "subagent_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s493": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s494": {
    "kind": "object",
    "properties": {
      "session_id": {
        "schema": "s1",
        "required": true
      },
      "subagent_id": {
        "schema": "s1",
        "required": true
      },
      "order": {
        "schema": "s417",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s495": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "metadata": {
        "schema": "s496",
        "required": true
      },
      "name": {
        "schema": "s3",
        "required": true
      },
      "object": {
        "schema": "s497",
        "required": true
      }
    }
  },
  "s496": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s497": {
    "kind": "literal",
    "value": "vault"
  },
  "s498": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s499",
        "required": true
      }
    }
  },
  "s499": {
    "kind": "literal",
    "value": "vault.deleted"
  },
  "s500": {
    "kind": "union",
    "variants": [
      "s285",
      "s501"
    ]
  },
  "s501": {
    "kind": "literal",
    "value": "archived"
  },
  "s502": {
    "kind": "union",
    "variants": [
      "s285",
      "s501",
      "s503"
    ]
  },
  "s503": {
    "kind": "array",
    "element": "s500"
  },
  "s504": {
    "kind": "object",
    "properties": {
      "metadata": {
        "schema": "s505",
        "required": false
      },
      "name": {
        "schema": "s359",
        "required": false
      }
    }
  },
  "s505": {
    "kind": "union",
    "variants": [
      "s4",
      "s506"
    ]
  },
  "s506": {
    "kind": "object",
    "properties": {},
    "additional": "s1"
  },
  "s507": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "status": {
        "schema": "s508",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s508": {
    "kind": "union",
    "variants": [
      "s285",
      "s501",
      "s503"
    ]
  },
  "s509": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "auth": {
        "schema": "s510",
        "required": true
      },
      "created_at": {
        "schema": "s2",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      },
      "object": {
        "schema": "s523",
        "required": true
      },
      "updated_at": {
        "schema": "s2",
        "required": true
      },
      "vault_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s510": {
    "kind": "union",
    "variants": [
      "s511",
      "s521"
    ]
  },
  "s511": {
    "kind": "object",
    "properties": {
      "expires_at": {
        "schema": "s3",
        "required": true
      },
      "mcp_server_url": {
        "schema": "s1",
        "required": true
      },
      "refresh": {
        "schema": "s512",
        "required": true
      },
      "type": {
        "schema": "s520",
        "required": true
      }
    }
  },
  "s512": {
    "kind": "union",
    "variants": [
      "s4",
      "s513"
    ]
  },
  "s513": {
    "kind": "object",
    "properties": {
      "client_id": {
        "schema": "s1",
        "required": true
      },
      "resource": {
        "schema": "s3",
        "required": true
      },
      "scope": {
        "schema": "s3",
        "required": true
      },
      "token_endpoint": {
        "schema": "s1",
        "required": true
      },
      "token_endpoint_auth": {
        "schema": "s514",
        "required": true
      }
    }
  },
  "s514": {
    "kind": "union",
    "variants": [
      "s515",
      "s516",
      "s518"
    ]
  },
  "s515": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s12",
        "required": true
      }
    }
  },
  "s516": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s517",
        "required": true
      }
    }
  },
  "s517": {
    "kind": "literal",
    "value": "client_secret_basic"
  },
  "s518": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s519",
        "required": true
      }
    }
  },
  "s519": {
    "kind": "literal",
    "value": "client_secret_post"
  },
  "s520": {
    "kind": "literal",
    "value": "mcp_oauth"
  },
  "s521": {
    "kind": "object",
    "properties": {
      "mcp_server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s522",
        "required": true
      }
    }
  },
  "s522": {
    "kind": "literal",
    "value": "static_bearer"
  },
  "s523": {
    "kind": "literal",
    "value": "vault.credential"
  },
  "s524": {
    "kind": "union",
    "variants": [
      "s525",
      "s532"
    ]
  },
  "s525": {
    "kind": "object",
    "properties": {
      "access_token": {
        "schema": "s1",
        "required": true
      },
      "mcp_server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s520",
        "required": true
      },
      "expires_at": {
        "schema": "s322",
        "required": false
      },
      "refresh": {
        "schema": "s526",
        "required": false
      }
    }
  },
  "s526": {
    "kind": "union",
    "variants": [
      "s4",
      "s527"
    ]
  },
  "s527": {
    "kind": "object",
    "properties": {
      "client_id": {
        "schema": "s1",
        "required": true
      },
      "refresh_token": {
        "schema": "s1",
        "required": true
      },
      "token_endpoint": {
        "schema": "s1",
        "required": true
      },
      "token_endpoint_auth": {
        "schema": "s528",
        "required": true
      },
      "resource": {
        "schema": "s322",
        "required": false
      },
      "scope": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s528": {
    "kind": "union",
    "variants": [
      "s529",
      "s530",
      "s531"
    ]
  },
  "s529": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s12",
        "required": true
      }
    }
  },
  "s530": {
    "kind": "object",
    "properties": {
      "client_secret": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s517",
        "required": true
      }
    }
  },
  "s531": {
    "kind": "object",
    "properties": {
      "client_secret": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s519",
        "required": true
      }
    }
  },
  "s532": {
    "kind": "object",
    "properties": {
      "token": {
        "schema": "s1",
        "required": true
      },
      "mcp_server_url": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s522",
        "required": true
      }
    }
  },
  "s533": {
    "kind": "union",
    "variants": [
      "s534",
      "s540"
    ]
  },
  "s534": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s520",
        "required": true
      },
      "access_token": {
        "schema": "s322",
        "required": false
      },
      "expires_at": {
        "schema": "s322",
        "required": false
      },
      "refresh": {
        "schema": "s535",
        "required": false
      }
    }
  },
  "s535": {
    "kind": "union",
    "variants": [
      "s4",
      "s536"
    ]
  },
  "s536": {
    "kind": "object",
    "properties": {
      "refresh_token": {
        "schema": "s322",
        "required": false
      },
      "scope": {
        "schema": "s322",
        "required": false
      },
      "token_endpoint_auth": {
        "schema": "s537",
        "required": false
      }
    }
  },
  "s537": {
    "kind": "union",
    "variants": [
      "s4",
      "s538",
      "s539"
    ]
  },
  "s538": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s517",
        "required": true
      },
      "client_secret": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s539": {
    "kind": "object",
    "properties": {
      "type": {
        "schema": "s519",
        "required": true
      },
      "client_secret": {
        "schema": "s322",
        "required": false
      }
    }
  },
  "s540": {
    "kind": "object",
    "properties": {
      "token": {
        "schema": "s1",
        "required": true
      },
      "type": {
        "schema": "s522",
        "required": true
      }
    }
  },
  "s541": {
    "kind": "object",
    "properties": {
      "id": {
        "schema": "s1",
        "required": true
      },
      "deleted": {
        "schema": "s7",
        "required": true
      },
      "object": {
        "schema": "s542",
        "required": true
      }
    }
  },
  "s542": {
    "kind": "literal",
    "value": "vault.credential.deleted"
  },
  "s543": {
    "kind": "union",
    "variants": [
      "s538",
      "s539"
    ]
  },
  "s544": {
    "kind": "object",
    "properties": {
      "auth": {
        "schema": "s524",
        "required": true
      },
      "name": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s545": {
    "kind": "object",
    "properties": {
      "vault_id": {
        "schema": "s1",
        "required": true
      }
    }
  },
  "s546": {
    "kind": "object",
    "properties": {
      "vault_id": {
        "schema": "s1",
        "required": true
      },
      "auth": {
        "schema": "s533",
        "required": true
      }
    }
  },
  "s547": {
    "kind": "object",
    "properties": {
      "order": {
        "schema": "s417",
        "required": false
      },
      "status": {
        "schema": "s508",
        "required": false
      },
      "after": {
        "schema": "s359",
        "required": false
      },
      "limit": {
        "schema": "s385",
        "required": false
      }
    }
  },
  "s548": {
    "kind": "object",
    "properties": {
      "vault_id": {
        "schema": "s1",
        "required": true
      }
    }
  }
};
