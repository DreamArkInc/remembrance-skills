import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  observeSuccessfulCompletionTool,
  readCompletionObligations,
} from "../scripts/hook-core.mjs";

// Review R2-7 (round 2): the hook decides to hold on the inventory itself (a
// retained consumer, or anything it left unaccounted for), as the outbox
// does; the hold codes only word the remediation. An area the codes do not
// know, which a later inventory could add, must still hold.
vi.mock("../scripts/pending-action-payload.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const none = { count: 0, areas: [] };
  return {
    ...actual,
    inventoryRetainedKeyConsumers: () => ({
      consumers: {
        total: 0,
        kinds: {
          private_lesson: 0,
          private_skill: 0,
          remembrance_followup: 0,
          capture_next_action: 0,
        },
        sources: { os_keychain: 0, mode_0600_file: 0 },
      },
      incomplete: true,
      reasons: {
        unclassified: 1,
        unlisted: 0,
        areas: ["a_future_area"],
        causes: {
          bounded: none,
          unreadable: none,
          unclassified: { count: 1, areas: ["a_future_area"] },
          unlisted: none,
        },
      },
      unretained: { count: 0, kinds: [] },
    }),
  };
});

describe("first-key hold decision", () => {
  it("holds, making no key and keeping no arguments, while the inventory is incomplete in an area its hold codes do not name", () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-hold-decision-"));
    const env = {
      REMEMBRANCE_USAGE_DIR: join(root, "usage"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
    };
    const session = "r2-7-unknown-area";
    observeSuccessfulCompletionTool(
      session,
      "capture_learning",
      {},
      {
        capture_route: "preference",
        persisted_locally: false,
        next_action: {
          tool: "record_preference",
          arguments: {
            setting: {
              key: "workflow.changelog_first",
              value: "before_code",
              label: "Changelog first",
              behavior: "Write the changelog entry before changing the code.",
              effect: "workflow",
            },
            scope: "member",
          },
        },
      },
      env,
    );
    const [obligation] = readCompletionObligations(session, env);
    expect(obligation).toMatchObject({
      kind: "capture_next_action",
      local_resupply_envelope: null,
      local_resupply_payload_omitted: "key_unavailable",
    });
    expect(obligation).not.toHaveProperty("local_resupply_hold");
    expect(
      existsSync(join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key")),
    ).toBe(false);
  });
});
