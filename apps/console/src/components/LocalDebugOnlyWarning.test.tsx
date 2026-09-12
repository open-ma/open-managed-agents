import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { LocalDebugOnlyWarning } from "./LocalDebugOnlyWarning";

describe("LocalDebugOnlyWarning", () => {
  it("makes the direct-host credential boundary explicit", () => {
    render(<LocalDebugOnlyWarning />);

    expect(screen.getByRole("note", { name: "Local debugging only" })).toBeInTheDocument();
    expect(screen.getByText(/Local debugging only — high risk/)).toBeInTheDocument();
    const warning = screen.getByRole("note", { name: "Local debugging only" });
    expect(warning).toHaveTextContent(/never copy.*auth\.json.*OAuth token/i);
    expect(warning).toHaveTextContent(/remote or managed sandboxes/i);
    expect(warning).toHaveTextContent(/not a production integration/i);
  });
});
