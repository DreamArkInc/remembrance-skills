import { describe, expect, it } from "vitest";
import {
  CURSOR_REMEMBRANCE_CONTEXT,
  handleSessionStart,
} from "../scripts/session-start.mjs";

describe("Cursor sessionStart hook", () => {
  it("injects compact Remembrance operating context", () => {
    const output = handleSessionStart(
      { session_id: "session_1" },
      { env: {} },
    );
    expect(output.additional_context).toBe(CURSOR_REMEMBRANCE_CONTEXT);
    expect(output.additional_context).toContain("query_skills");
    expect(output.additional_context).toContain("submit redacted feedback");
  });

  it("can be disabled without failing the session", () => {
    expect(
      handleSessionStart({}, { env: { REMEMBRANCE_CURSOR_SESSION_CONTEXT: "0" } }),
    ).toEqual({});
  });
});
