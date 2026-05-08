-- 0015_model_card_handle_rename.sql
--
-- Reframe model_cards columns:
--   * `model_id`  — was "the LLM API model string". Now repurposed as the
--                   tenant-unique USER-FACING HANDLE that agents reference
--                   via agent.model. The existing UNIQUE(tenant_id, model_id)
--                   index keeps its shape; only the semantic shifts.
--   * `model`     — NEW column. Holds the actual LLM API model string
--                   (e.g. "claude-sonnet-4-6"). Sent verbatim to the
--                   provider on each turn. No uniqueness constraint —
--                   multiple cards may serve the same underlying LLM with
--                   different keys / base_urls / providers.
--   * `display_name` — DROPPED. The handle (`model_id`) is itself the
--                   human-meaningful identifier; a separate label was a
--                   second namespace nobody asked for.
--
-- Backfill is identity:
--   - Pre-migration rows had model_id = "claude-sonnet-4-6" (the LLM string)
--     and used display_name as a free-text label.
--   - Post-migration: model_id stays "claude-sonnet-4-6" (now interpreted as
--     the handle), and `model` is initialized to the same string so the
--     first turn after deploy still hits the same provider endpoint.
--   - Existing agent.model values ("claude-sonnet-4-6") continue to resolve
--     against the same card by handle. Zero ref breakage.
--
-- D1 supports ALTER TABLE DROP COLUMN directly (see note in
-- 0010_memory_anthropic_alignment.sql); using it here rather than the
-- table-rebuild dance because there's only one column to drop and the
-- add+update+drop sequence is naturally atomic at the migration level.

ALTER TABLE "model_cards" ADD COLUMN "model" TEXT NOT NULL DEFAULT '';

UPDATE "model_cards" SET "model" = "model_id" WHERE "model" = '';

ALTER TABLE "model_cards" DROP COLUMN "display_name";
