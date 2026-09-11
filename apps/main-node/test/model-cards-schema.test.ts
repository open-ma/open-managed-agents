import { describe, expect, it } from "vitest";
import { model_cards } from "@open-managed-agents/db-schema/node-pg";

describe("Node-PG model_cards schema", () => {
  it("matches the model-card repository contract", () => {
    expect(model_cards).toHaveProperty("model");
    expect(model_cards).toHaveProperty("pi_config");
    expect(model_cards).not.toHaveProperty("display_name");
  });
});
