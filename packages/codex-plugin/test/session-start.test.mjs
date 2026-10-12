import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleSessionStart } from "../scripts/session-start.mjs";
import { useIsolatedHookEnvironment } from "./fixtures/isolated-hook-environment.mjs";

const SESSION_SKILLS_HEADER = "Remembrance organization session skills:";
const network = useIsolatedHookEnvironment();

describe("Codex SessionStart health hook", () => {
  const trustedHookTrust = vi.fn(async () => ({
    status: "trusted",
    checked_at: "2026-08-13T12:00:00.000Z",
    review_events: [],
    hooks: [],
  }));

  it("records startup and tells the agent how to verify complete activation", async () => {
    const recordHealth = vi.fn(() => true);
    const output = await handleSessionStart(
      {
        codex_version: "0.145.0-alpha.30",
        turn_id: "session-health-check",
      },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.37",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
        inspectHookTrust: trustedHookTrust,
      },
    );

    expect(recordHealth).toHaveBeenCalledWith(
      {
        surface: "codex",
        component: "session_start",
        pluginVersion: "0.1.37",
        hostVersion: "0.145.0-alpha.30",
        credentialSource: "environment",
        sessionId: "session-health-check",
        hookTrust: expect.objectContaining({ status: "trusted" }),
      },
      expect.any(Object),
    );
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "bundled local MCP server",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "partial activation",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("falls back to anonymous public access without failing startup", async () => {
    const recordHealth = vi.fn(() => false);
    const env = {
      XDG_CONFIG_HOME: `/tmp/remembrance-codex-session-test-${process.pid}`,
    };
    const output = await handleSessionStart(
      {},
      {
        env,
        pluginVersion: "unknown",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
        inspectHookTrust: trustedHookTrust,
      },
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "none" }),
      env,
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "public anonymous registry access",
    );
  });

  it("loads organization session skills per Codex start source", async () => {
    const root = mkdtempSync(join(tmpdir(), "remembrance-codex-session-"));
    try {
      let online = true;
      const fetchImpl = vi.fn(async () => {
        if (!online) throw new TypeError("fetch failed");
        return new Response(
          JSON.stringify({
            contract_version: "session-skills-v1",
            available: true,
            reason_code: null,
            session_skills: [
              {
                slug: "ponytail",
                version_id: "sv_7f7777fba96c441f86",
                pinned: true,
              },
            ],
            omitted_count: 0,
          }),
        );
      });
      const options = {
        env: {
          REMEMBRANCE_API_KEY: "rk_never_print",
          REMEMBRANCE_USAGE_DIR: join(root, "usage"),
          XDG_CONFIG_HOME: join(root, "config"),
        },
        pluginVersion: "0.2.0",
        recordHealth: vi.fn(),
        warmSession: vi.fn(async () => null),
        checkUpdate: vi.fn(async () => null),
        inspectHookTrust: trustedHookTrust,
        fetchImpl,
      };
      const directive = (output) => {
        const context = output.hookSpecificOutput.additionalContext;
        return context.includes(SESSION_SKILLS_HEADER)
          ? context.slice(context.indexOf(SESSION_SKILLS_HEADER))
          : null;
      };

      const started = await handleSessionStart(
        { source: "startup", session_id: "codex-thread-1" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "https://remembrance.dev/api/v1/agent/session-skills",
      );
      expect(directive(started)).toMatch(
        /\n- \{"slug":"ponytail","version_id":"sv_7f7777fba96c441f86","scope":"session","idempotency_key":"rss_[0-9a-f]{32}"\} \(pinned\)\n/,
      );

      // Resume falls back to the cache when the registry is unreachable;
      // compaction reads only the cache.
      online = false;
      const resumed = await handleSessionStart(
        { source: "resume", session_id: "codex-thread-1" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(directive(resumed)).toBe(directive(started));
      const compacted = await handleSessionStart(
        { source: "compact", session_id: "codex-thread-1" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(directive(compacted)).toBe(directive(started));

      // A turn id is not a stable session id.
      const turnOnly = await handleSessionStart(
        { source: "startup", turn_id: "codex-turn-1" },
        options,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(directive(turnOnly)).toBeNull();
      expect(
        JSON.stringify([started, resumed, compacted, turnOnly]),
      ).not.toContain("rk_never_print");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reset lifecycle health when Codex compacts an active turn", async () => {
    const recordHealth = vi.fn();
    const checkUpdate = vi.fn();
    const output = await handleSessionStart(
      {
        source: "compact",
        session_id: "active-task",
      },
      { env: {}, pluginVersion: "0.1.53", recordHealth, checkUpdate },
    );

    expect(recordHealth).not.toHaveBeenCalled();
    expect(checkUpdate).not.toHaveBeenCalled();
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("gives the agent a locally authored update command and restart boundary", async () => {
    const output = await handleSessionStart(
      { session_id: "update-session" },
      {
        env: { REMEMBRANCE_API_KEY: "rk_never_print" },
        pluginVersion: "0.1.54",
        recordHealth: vi.fn(),
        checkUpdate: vi.fn(async (input) => ({
          current_version: input.currentVersion,
          latest_version: "0.1.55",
          notice:
            "Remembrance update available. Ask permission, run the trusted local command, then fully quit and reopen Codex.",
        })),
        inspectHookTrust: trustedHookTrust,
      },
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Remembrance update available",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "fully quit and reopen Codex",
    );
    expect(JSON.stringify(output)).not.toContain("rk_never_print");
  });

  it("reports exactly which updated hook needs trust without exposing local details", async () => {
    const recordHealth = vi.fn();
    const output = await handleSessionStart(
      { session_id: "trust-review" },
      {
        env: {},
        pluginVersion: "0.1.63",
        recordHealth,
        checkUpdate: vi.fn(async () => null),
        inspectHookTrust: vi.fn(async () => ({
          status: "review_required",
          checked_at: "2026-08-13T12:00:00.000Z",
          review_events: ["PostToolUse"],
          hooks: [
            {
              event: "PostToolUse",
              enabled: true,
              trust_status: "modified",
              current_hash: "sha256:do_not_expose",
              command: "/private/plugin/script.mjs",
            },
          ],
        })),
      },
    );

    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        hookTrust: expect.objectContaining({
          status: "review_required",
          review_events: ["PostToolUse"],
        }),
      }),
      expect.any(Object),
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "hook trust review is required for PostToolUse",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "run_connection_doctor",
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      "Querying, opening skills, bounded feedback, and private submissions remain available",
    );
    expect(JSON.stringify(output)).not.toMatch(
      /do_not_expose|private\/plugin|sha256/i,
    );
  });

  it("sends its default requests only to the stubbed fetch", async () => {
    network.fetch.mockClear();
    for (const source of ["startup", "resume", "clear", "compact"]) {
      await handleSessionStart(
        { source, session_id: "codex-offline-thread" },
        { env: { REMEMBRANCE_API_KEY: "rk_never_print" } },
      );
    }
    expect(network.fetch).toHaveBeenCalledWith(
      "https://remembrance.dev/api/v1/agent/session-skills",
      expect.anything(),
    );
    expect(network.realRequests).toEqual([]);
  });
});
