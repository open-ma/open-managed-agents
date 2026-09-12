import type { ThreadListParams } from "@anthropic-ai/sdk/resources/beta/sessions/threads/threads";
import { z } from "zod";
import {
  advisorResponseSchema,
  sessionThreadAgentResponseSchema,
} from "./agent-response-components";
import { sessionUsageResponseSchema } from "./sessions";

export type SessionThreadListQuery = Omit<ThreadListParams, "betas">;

export const sessionThreadListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

const sessionThreadAgentSchema = z.union([
  sessionThreadAgentResponseSchema,
  advisorResponseSchema,
]);

const sessionThreadStatsSchema = z
  .object({
    active_seconds: z.number().optional(),
    duration_seconds: z.number().optional(),
    startup_seconds: z.number().optional(),
  })
  .strict();

export const sessionThreadResponseSchema = z
    .object({
      id: z.string().min(1),
      agent: sessionThreadAgentSchema,
      archived_at: z.string().nullable(),
      created_at: z.string(),
      parent_thread_id: z.string().nullable(),
      session_id: z.string().min(1),
      stats: sessionThreadStatsSchema.nullable(),
      status: z.enum(["running", "idle", "rescheduling", "terminated"]),
      type: z.literal("session_thread"),
      updated_at: z.string(),
      usage: sessionUsageResponseSchema.nullable(),
    })
    .strict();

export const sessionThreadPageResponseSchema = z
  .object({
    data: z.array(sessionThreadResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();
