import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-vscode-posttool-"));
const hookTmp = join(tempRoot, "usage-");

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// Mirrors packages/codex-plugin/test/record-detail-open.test.mjs. The scripts are
// copied from the Claude plugin, so these assertions are what prove the copy is
// wired to the VS Code surface and still enforces the "only successful use
// counts" rules.
describe("VS Code post-tool detail tracking", () => {
  it("records post-tool health under the VS Code surface", async () => {
    const recordHealth = vi.fn();
    await handlePostToolUse(
      {
        session_id: "s-health",
        tool_name: "mcp__remembrance__get_skill",
        tool_input: { slug: "web-ui-ux-qa" },
      },
      {
        env: {},
        recordHealth,
        clearHighMatchSurfaceIfOpened: vi.fn(() => true),
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "vs_code" }),
      expect.any(Object),
    );
  });

  it("clears the current high match after the correlated detail opens", async () => {
    const clear = vi.fn(() => true);
    const result = await handlePostToolUse(
      {
        session_id: "s-detail",
        tool_name: "mcp__remembrance__get_skill",
        tool_input: {
          slug: "web-ui-ux-qa",
          query_id: "rq_1",
          result_id: "qres_1",
        },
      },
      {
        env: {},
        clearHighMatchSurfaceIfOpened: clear,
        recordHealth: vi.fn(),
      },
    );
    expect(result).toMatchObject({ cleared: true, why: "matched_detail_open" });
    expect(clear).toHaveBeenCalled();
  });

  it("does not clear a marker after a failed detail call", async () => {
    const clear = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "s-failed",
          tool_name: "mcp__remembrance__get_resource",
          tool_input: '{"slug":"docs"}',
          tool_response: { isError: true },
        },
        {
          env: {},
          clearHighMatchSurfaceIfOpened: clear,
          recordHealth: vi.fn(),
        },
      ),
    ).toMatchObject({ cleared: false, why: "tool_failed" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("records a successful query as directive follow-through", async () => {
    const recordDirectiveFollowThrough = vi.fn(async () => true);
    expect(
      await handlePostToolUse(
        {
          session_id: "s-directive",
          tool_name: "mcp__remembrance__query_skills",
          tool_response: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ body: { query_id: "rq_directive" } }),
              },
            ],
          },
        },
        { env: {}, recordDirectiveFollowThrough, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ directive_followed: true, why: "directive_followed" });
    expect(recordDirectiveFollowThrough).toHaveBeenCalled();
  });

  it("does not count a catalog handle or a malformed invocation as use", async () => {
    const recordRegistryUse = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "s-list",
          tool_name: "mcp__remembrance__list_skills",
          tool_response: { skills: [{ slug: "catalog-only" }] },
        },
        { env: {}, recordRegistryUse, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ why: "not_current_match" });
    expect(
      await handlePostToolUse(
        {
          session_id: "s-bad-invoke",
          tool_name: "mcp__remembrance__invoke_skill",
          tool_response: {
            selection_mode: "explicit",
            skill: { slug: "missing-body" },
          },
        },
        { env: {}, recordRegistryUse, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ recorded: false, why: "invocation_not_loaded" });
    expect(recordRegistryUse).not.toHaveBeenCalled();
  });

  it("marks successful feedback as handled so completion does not repeat it", async () => {
    const markCurrentEngagementHandled = vi.fn(() => 2);
    expect(
      await handlePostToolUse(
        {
          session_id: "s-feedback",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: { accepted: true },
        },
        { env: {}, markCurrentEngagementHandled, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ recorded: true, why: "contribution_handled" });
    expect(markCurrentEngagementHandled).toHaveBeenCalled();
  });

  it("does not mark an HTTP-rejected contribution as handled", async () => {
    const markCurrentEngagementHandled = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "s-rejected",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  status: 403,
                  body: { error: "Missing submission:create scope" },
                }),
              },
            ],
          },
        },
        { env: {}, markCurrentEngagementHandled, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ why: "tool_failed" });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });

  it("keeps completion pending when feedback requests a remembrance follow-up", async () => {
    const markCurrentEngagementHandled = vi.fn();
    expect(
      await handlePostToolUse(
        {
          session_id: "s-followup",
          tool_name: "mcp__remembrance__submit_feedback",
          tool_response: {
            body: {
              next_step: {
                submit_remembrance_payload: {
                  type: "skill_feedback",
                  lesson: "Reusable correction.",
                },
              },
            },
          },
        },
        { env: {}, markCurrentEngagementHandled, recordHealth: vi.fn() },
      ),
    ).toMatchObject({ why: "remembrance_followup_pending" });
    expect(markCurrentEngagementHandled).not.toHaveBeenCalled();
  });

  // Fail-open is provided by the script's main() wrapper, not by the handler, so
  // assert it at the layer that actually protects the user: the process boundary.
  it("exits zero on malformed hook input so a completed tool call is never disturbed", async () => {
    const script = resolve(root, "scripts/record-detail-open.mjs");
    for (const stdin of ["not json at all", "", '{"tool_name":']) {
      const result = await runHook(script, stdin);
      expect(
        result.code,
        `exit ${result.code} for stdin ${JSON.stringify(stdin)}`,
      ).toBe(0);
    }
  });
});

function runHook(script, stdin) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, REMEMBRANCE_USAGE_DIR: mkdtempSync(hookTmp) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
