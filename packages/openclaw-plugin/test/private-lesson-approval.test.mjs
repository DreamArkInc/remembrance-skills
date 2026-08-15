import { describe, expect, it, vi } from "vitest";
import {
  handlePrivateLessonSubmitApproval,
  persistPrivateLessonSubmitApproval,
  privateLessonSubmitApproved,
} from "../src/private-lesson-approval.mjs";

describe("OpenClaw private lesson approval", () => {
  it("gates only the exact private lesson action", () => {
    expect(handlePrivateLessonSubmitApproval(null)).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval({ toolName: "submit_remembrance" }),
    ).toBeUndefined();
    expect(
      handlePrivateLessonSubmitApproval(
        { tool_name: "mcp_remembrance_submit_private_lesson_candidate" },
        { approved: true },
      ),
    ).toBeUndefined();

    const onAllowAlways = vi.fn();
    const result = handlePrivateLessonSubmitApproval(
      { toolName: "submit_private_lesson_candidate" },
      { onAllowAlways },
    );
    expect(result).toMatchObject({
      requireApproval: {
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        timeoutMs: 120_000,
      },
    });
    result.requireApproval.onResolution("allow-once");
    result.requireApproval.onResolution("deny");
    expect(onAllowAlways).not.toHaveBeenCalled();
    result.requireApproval.onResolution("allow-always");
    expect(onAllowAlways).toHaveBeenCalledOnce();
  });

  it("reads and persists the one narrow approval without dropping config", async () => {
    expect(privateLessonSubmitApproved(null)).toBe(false);
    expect(
      privateLessonSubmitApproved({
        pluginConfig: { privateLessonSubmitApproval: true },
      }),
    ).toBe(true);

    const mutateConfigFile = vi.fn(async ({ mutate }) => {
      const draft = {
        retained: true,
        plugins: {
          retained: true,
          entries: {
            retained: { enabled: true },
            remembrance: { config: { retained: true } },
          },
        },
      };
      mutate(draft);
      expect(draft).toEqual({
        retained: true,
        plugins: {
          retained: true,
          entries: {
            retained: { enabled: true },
            remembrance: {
              config: {
                retained: true,
                privateLessonSubmitApproval: true,
              },
            },
          },
        },
      });
    });
    await persistPrivateLessonSubmitApproval({
      runtime: { config: { mutateConfigFile } },
    });
    expect(mutateConfigFile).toHaveBeenCalledOnce();
  });

  it("fails clearly when the host cannot persist approval", async () => {
    await expect(persistPrivateLessonSubmitApproval(null)).rejects.toThrow(
      "config mutation is unavailable",
    );
  });

  it("initializes missing configuration containers", async () => {
    await persistPrivateLessonSubmitApproval({
      runtime: {
        config: {
          mutateConfigFile: async ({ mutate }) => {
            const draft = {};
            mutate(draft);
            expect(draft).toEqual({
              plugins: {
                entries: {
                  remembrance: {
                    config: { privateLessonSubmitApproval: true },
                  },
                },
              },
            });
          },
        },
      },
    });
  });
});
