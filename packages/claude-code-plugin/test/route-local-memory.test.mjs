import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleLocalMemoryWrite,
  isClaudeLocalMemoryWrite,
  processLocalMemoryHookInput,
} from "../scripts/route-local-memory.mjs";

describe("Claude local-memory routing", () => {
  it("recognizes default auto-memory writes without reading their content", () => {
    expect(
      isClaudeLocalMemoryWrite({
        tool_name: "Write",
        tool_input: {
          file_path:
            "/Users/example/.claude/projects/project-hash/memory/MEMORY.md",
          content: "private memory body",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeLocalMemoryWrite({
        tool_name: "Edit",
        tool_input: {
          file_path:
            "C:\\Users\\example\\.claude\\projects\\project-hash\\memory\\feedback.md",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeLocalMemoryWrite({
        toolName: "Write",
        tool_input: {
          path: "/Users/example/.claude/projects/other/memory/project.md",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeLocalMemoryWrite({
        toolName: "Edit",
        toolInput: {
          file_path:
            "/Users/example/.claude/projects/another/memory/feedback.md",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeLocalMemoryWrite({
        toolName: "Edit",
        toolInput: {
          path: "/Users/example/.claude/projects/fourth/memory/reference.md",
        },
      }),
    ).toBe(true);
  });

  it("ignores ordinary file writes and unrelated tools", () => {
    expect(
      isClaudeLocalMemoryWrite({
        tool_name: "Write",
        tool_input: { file_path: "/repo/src/memory/cache.ts" },
      }),
    ).toBe(false);
    expect(isClaudeLocalMemoryWrite({ tool_name: "Read" })).toBe(false);
    expect(isClaudeLocalMemoryWrite({ tool_name: "Write" })).toBe(false);
    expect(isClaudeLocalMemoryWrite({})).toBe(false);
  });

  it("creates a shared-capture obligation without exposing the memory body", () => {
    const recordEligibility = vi.fn();
    const output = handleLocalMemoryWrite(
      {
        session_id: "claude-memory-session",
        tool_name: "Memory",
        tool_input: { content: "never echo this repository detail" },
      },
      { env: {}, recordEligibility },
    );

    expect(recordEligibility).toHaveBeenCalledWith(
      "claude-memory-session",
      expect.any(Object),
    );
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "Local memory is for facts about this human, repository, or machine",
    );
    expect(JSON.stringify(output)).not.toContain(
      "never echo this repository detail",
    );
  });

  it("honors the contribution kill switch with no marker write", () => {
    const recordEligibility = vi.fn();
    expect(
      handleLocalMemoryWrite(
        { tool_name: "Memory", session_id: "disabled" },
        {
          env: { REMEMBRANCE_AUTO_CONTRIBUTE: "0" },
          recordEligibility,
        },
      ),
    ).toBeNull();
    expect(recordEligibility).not.toHaveBeenCalled();
  });

  it("uses the process environment and default marker writer safely", () => {
    const previous = process.env.REMEMBRANCE_AUTO_CONTRIBUTE;
    process.env.REMEMBRANCE_AUTO_CONTRIBUTE = "0";
    try {
      expect(
        handleLocalMemoryWrite({
          tool_name: "Memory",
          session_id: "process-env-disabled",
        }),
      ).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.REMEMBRANCE_AUTO_CONTRIBUTE;
      } else {
        process.env.REMEMBRANCE_AUTO_CONTRIBUTE = previous;
      }
    }

    const healthDir = mkdtempSync(
      join(tmpdir(), "remembrance-memory-routing-"),
    );
    try {
      expect(
        handleLocalMemoryWrite(
          { tool_name: "Memory", session_id: "default-marker-writer" },
          { env: { REMEMBRANCE_PLUGIN_HEALTH_DIR: healthDir } },
        )?.hookSpecificOutput.hookEventName,
      ).toBe("PostToolUse");
    } finally {
      rmSync(healthDir, { recursive: true, force: true });
    }
  });

  it("parses valid hook JSON without replaying the memory body", () => {
    const recordEligibility = vi.fn();
    const privateBody = "private repository detail that must not be replayed";
    const output = processLocalMemoryHookInput(
      JSON.stringify({
        session_id: "parsed-memory-session",
        tool_name: "AutoMemory",
        tool_input: { content: privateBody },
      }),
      { env: {}, recordEligibility },
    );

    expect(recordEligibility).toHaveBeenCalledWith(
      "parsed-memory-session",
      expect.any(Object),
    );
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "This observer did not read or send the memory body.",
    );
    expect(JSON.stringify(output)).not.toContain(privateBody);
  });

  it.each(["", "   ", "{not-json", null])(
    "fails open for empty or malformed serialized input: %j",
    (raw) => {
      const recordEligibility = vi.fn();
      expect(
        processLocalMemoryHookInput(raw, { env: {}, recordEligibility }),
      ).toBeNull();
      expect(recordEligibility).not.toHaveBeenCalled();
    },
  );
});
