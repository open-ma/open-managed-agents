import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { AgentCreateBody } from "../src/contracts/agents";

type OfficialAgentCreateBody = Omit<AgentCreateParams, "betas">;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

const agentCreateBodyMatchesOfficialContract: Equal<
  Omit<AgentCreateBody, "_oma">,
  OfficialAgentCreateBody
> = true;

void agentCreateBodyMatchesOfficialContract;
