// From review round 1 of t14-openclaw-subagent (zz-review-subagent-retry-pass):
// the hooks in the order OpenClaw 2026.7.1-2 called them natively for a
// subagent whose finalize revise it honored. Its task prompt, its finalize,
// and, if that finalize revises, the retry pass's before_prompt_build with the
// host's retry prompt (BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX plus the
// plugin's reason), which the plugin would send to the registry as a query,
// then the next finalize. The registry offers query feedback for every query,
// as the query route does by default. Required: the subagent is not asked, so
// no retry pass and no extra query, and what it leaves reaches the spawning
// session.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { ledgerIdFromEvent } from "../src/index.mjs";
import { readCompletionObligations } from "../src/hook-core.mjs";
import { useIsolatedHookEnvironment } from "../../codex-plugin/test/fixtures/isolated-hook-environment.mjs";

useIsolatedHookEnvironment();

const CHILD_KEY = "agent:main:subagent:7f1c2b4e-9a0d-4c55-8e21-3b6f0d9c1a77";
const child = {
  runId: "run-child",
  sessionId: "child-session",
  sessionKey: CHILD_KEY,
  agentId: "main",
};
const parent = (runId) => ({
  runId,
  sessionId: "parent-session",
  sessionKey: "agent:main:main",
  agentId: "main",
});
const owed = (ctx) =>
  readCompletionObligations(ledgerIdFromEvent({ context: ctx }), process.env);
const RETRY_PREFIX =
  "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";
const TASK =
  "Review the Vercel production deploy runbook for the Next.js app and report back.";

describe("OpenClaw subagent retry pass", () => {
  let usage;
  let hook;
  let queries;
  let matched;
  beforeEach(() => {
    queries = [];
    usage = mkdtempSync(join(tmpdir(), "remembrance-openclaw-retry-"));
    vi.stubEnv("REMEMBRANCE_USAGE_DIR", usage);
    vi.stubEnv("REMEMBRANCE_PLUGIN_HEALTH_DIR", join(usage, "health"));
    vi.stubEnv("REMEMBRANCE_CLIENT_UPDATE_CHECK", "0");
    vi.stubEnv("REMEMBRANCE_API_URL", "https://remembrance.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/v1/agent/query")) {
          const id = `rq_reviewretry${queries.length + 1}`;
          queries.push({
            id,
            task: JSON.parse(String(init.body)).task?.summary?.slice(0, 60),
          });
          return Response.json({
            query_id: id,
            skills: matched
              ? [
                  {
                    slug: "deploy-runbook-review",
                    description: "Review deploy runbooks.",
                    trust_tier: "tofu_verified",
                    verified_uses: 7,
                    total_uses: 9,
                    result_id: `qres_${id}`,
                    match_tier: "high",
                    match_reason: "Strong task coverage",
                    estimated_tokens: 360,
                    risk_level: "low",
                  },
                ]
              : [],
            resources: [],
            query_feedback: {
              available: true,
              query_id: id,
              result_ids: matched ? [`qres_${id}`] : [],
            },
          });
        }
        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const on = vi.fn();
    plugin.register({ on, logger: { info: vi.fn() }, registerCli: vi.fn() });
    hook = (name) => on.mock.calls.find(([hookName]) => hookName === name)[1];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(usage, { recursive: true, force: true });
  });

  it.each([
    ["matches", true],
    ["finds nothing", false],
  ])(
    "does not ask a subagent and hands its leftovers up when the registry %s",
    async (_case, registryMatches) => {
      matched = registryMatches;
      await hook("after_tool_call")(
        {
          toolName: "sessions_spawn",
          params: { task: TASK },
          runId: "run-parent-1",
          result: {
            content: [],
            details: {
              status: "accepted",
              childSessionKey: CHILD_KEY,
              runId: child.runId,
              mode: "run",
            },
          },
        },
        parent("run-parent-1"),
      );
      const finalize = () =>
        hook("before_agent_finalize")(
          {
            runId: child.runId,
            sessionId: child.sessionId,
            stopHookActive: false,
            lastAssistantMessage: "Runbook reviewed.",
          },
          child,
        );
      const decisions = [];
      await hook("before_prompt_build")({ prompt: TASK, messages: [] }, child);
      for (let pass = 0; pass < 3; pass += 1) {
        const decision = await finalize();
        decisions.push(decision.action);
        if (decision.action !== "revise") break;
        // OpenClaw's retry pass: before_prompt_build runs again with the
        // host's retry prompt.
        await hook("before_prompt_build")(
          { prompt: `${RETRY_PREFIX}\n\n${decision.reason}`, messages: [] },
          child,
        );
      }
      expect(decisions).toEqual(["finalize"]);
      expect(queries).toHaveLength(1);
      expect(queries[0].task).not.toContain("Before accepting");
      expect(owed(child)).toEqual([]);
      expect(owed(parent("run-parent-2")).length).toBeGreaterThan(0);
    },
  );
});
