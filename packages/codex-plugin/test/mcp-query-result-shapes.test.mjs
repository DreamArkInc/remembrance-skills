import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  preferenceCompatibilityEvidenceFromResponse,
  readCompletionObligations,
  readHighMatchSurface,
  readRegistryUseCount,
  readValueEpisodeSurfaces,
} from "../scripts/hook-core.mjs";
import { handlePostToolUse } from "../scripts/record-detail-open.mjs";

// The shipped MCP bundle shapes query_skills results; the shipped hook reads
// them. This drives both across a real stdio process and a loopback API, so the
// compact shape is proved to flow through the post-tool hook, not assumed.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-codex-shapes-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const QUERY_ID = "rq_bundle_shapes";
const DEPTH_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const depth = {
  key: "explanation_depth",
  value: "concise",
  label: "Explanation depth",
  behavior: "Keep explanations concise and focused on decisions and outcomes.",
  effect: "presentation",
  strength: "prefer",
  definition_version: 1,
};
const statement = {
  ...depth,
  scope: "member",
  source: "explicit_member",
  confidence: 1,
  profile_revision: 2,
};
const description = "Verify the dashboard at every breakpoint. ".repeat(40);

function restSkill(slug, index) {
  const resultId = `qres_bundle_${index}`;
  return {
    result_id: resultId,
    task_outcome_eligible: true,
    name: slug,
    slug,
    description,
    version: "2",
    match_tier: index === 0 ? "high" : "possible",
    match_reason: "Strong task coverage",
    estimated_tokens: 1200,
    verified_uses: 3,
    risk_level: "low",
    source: "public",
    value_estimate_id: `vest_bundle_${index}`,
    why_matched: {
      matched_terms: ["dashboard"],
      matched_capabilities: [],
      domain_match: true,
      satisfied_constraints: [],
      missed_constraints: [],
      lexical_signal: "strong",
      semantic_signal: "strong",
    },
    applicability: {
      fit: "likely",
      scope: "general",
      reason: "Covers dashboard review.",
      use_when: [],
      avoid_when: [],
    },
    effective_preferences: [statement],
    preference_compatibility_feedback: {
      available: true,
      query_id: QUERY_ID,
      result_id: resultId,
      skill_version_id: `skv_bundle_${index}`,
      preferences: [
        { preference_fingerprint: DEPTH_FINGERPRINT, setting: depth },
      ],
    },
    preference_application: {
      mode: "surgical_overlay",
      runtime_compatibility: "not_evaluated",
      applied_preferences: [
        { ...depth, source: "explicit_member", authority: "explicit" },
      ],
      blocked_preferences: [],
      overridden_skill_defaults: [],
      preserves: ["safety", "authorization", "privacy"],
      instruction: "Apply applied_preferences only as a surgical sidecar.",
    },
  };
}

// The REST body a query returns, with every result repeating its preference.
const restBody = {
  query_id: QUERY_ID,
  preference_definition_version: "agent-preferences-v4",
  effective_preferences: [statement],
  skill_access: {
    scope: "anonymous",
    policy: "allow",
    public_skills_allowed: true,
    offline_public_fallback_allowed: true,
  },
  skills: ["dashboard-review", "flake-triage"].map(restSkill),
  resources: [],
  skill_bundles: [],
  task_outcome: {
    available: true,
    eligible_result_ids: ["qres_bundle_0", "qres_bundle_1"],
    query_id: QUERY_ID,
  },
  query_feedback: {
    available: true,
    query_id: QUERY_ID,
    result_ids: ["qres_bundle_0", "qres_bundle_1"],
  },
};

async function startApi() {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      const query =
        request.method === "POST" && request.url === "/api/v1/agent/query";
      response.writeHead(query ? 200 : 404, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(query ? restBody : { error: "Not found" }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function callBundledQuery(apiUrl) {
  const profile = mkdtempSync(join(tempRoot, "profile-"));
  const child = spawn(
    process.execPath,
    [resolve(root, "servers/remembrance-mcp.mjs")],
    {
      env: {
        HOME: join(profile, "home"),
        XDG_CONFIG_HOME: join(profile, "config"),
        XDG_STATE_HOME: join(profile, "state"),
        XDG_CACHE_HOME: join(profile, "cache"),
        XDG_DATA_HOME: join(profile, "data"),
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        REMEMBRANCE_API_URL: apiUrl,
        REMEMBRANCE_PROJECT_KEY: "prj_codex_bundle_shapes",
        REMEMBRANCE_HEALTH_REPORTING: "0",
        REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN: "0",
        REMEMBRANCE_AGENT_KEY_PATH: join(profile, "config", "agent-key.json"),
        REMEMBRANCE_PRINCIPAL_SESSION_DIR: join(profile, "state", "sessions"),
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  try {
    send({ id: 1, method: "initialize", params: {} });
    send({
      id: 2,
      method: "tools/call",
      params: {
        name: "query_skills",
        arguments: {
          task: {
            domain: "web-ui-qa",
            summary: "Review a responsive dashboard before release.",
          },
        },
      },
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000) {
      // Parse complete lines only; the last one may still be arriving.
      const response = stdout
        .split("\n")
        .slice(0, -1)
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2);
      if (response) return response;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`No query_skills response. stderr: ${stderr}`);
  } finally {
    child.kill();
  }
}

describe("bundled MCP query_skills result through the Codex post-tool hook", () => {
  it("records the same lifecycle state and preference evidence from the compact result", async () => {
    const api = await startApi();
    let response;
    try {
      response = await callBundledQuery(api.url);
    } finally {
      await api.close();
    }
    expect(api.requests).toContain("POST /api/v1/agent/query");
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBeUndefined();

    const text = response.result.content[0].text;
    expect(text).not.toContain("\n");
    const body = JSON.parse(text).body;
    expect(Object.keys(body).slice(0, 5)).toEqual([
      "query_id",
      "skill_access",
      "skills",
      "resources",
      "skill_bundles",
    ]);
    expect(body.effective_preferences).toEqual([
      { ...statement, preference_fingerprint: DEPTH_FINGERPRINT },
    ]);
    expect(body.skills[0]).toMatchObject({
      description_truncated: true,
      effective_preference_keys: ["explanation_depth"],
      preference_compatibility_feedback: {
        available: true,
        skill_version_id: "skv_bundle_0",
        preference_fingerprints: [DEPTH_FINGERPRINT],
      },
      preference_application: {
        applied_preferences: [
          { key: "explanation_depth", authority: "explicit" },
        ],
      },
    });
    expect(body.skills[0]).not.toHaveProperty("effective_preferences");

    // The hook reads the compact MCP result exactly as it reads REST.
    expect(
      preferenceCompatibilityEvidenceFromResponse(response.result),
    ).toEqual(preferenceCompatibilityEvidenceFromResponse({ body: restBody }));
    expect(
      preferenceCompatibilityEvidenceFromResponse(response.result),
    ).toHaveLength(2);

    const env = {
      REMEMBRANCE_USAGE_DIR: join(tempRoot, "usage"),
      XDG_STATE_HOME: join(tempRoot, "state"),
      XDG_CONFIG_HOME: join(tempRoot, "config"),
    };
    const fetchImpl = vi.fn();
    const outcome = await handlePostToolUse(
      {
        session_id: "sess-bundle-shapes",
        hook_event_name: "PostToolUse",
        tool_name: "mcp__remembrance__query_skills",
        tool_input: {
          task: { domain: "web-ui-qa", summary: "Review a dashboard" },
        },
        tool_response: response.result,
      },
      { env, fetchImpl, recordHealth: () => undefined },
    );

    expect(outcome).toEqual({
      cleared: false,
      directive_followed: false,
      why: "no_current_directive",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readRegistryUseCount("sess-bundle-shapes", env)).toBe(1);
    expect(readHighMatchSurface("sess-bundle-shapes", env)).toMatchObject({
      query_id: QUERY_ID,
      result_id: "qres_bundle_0",
      slug: "dashboard-review",
    });
    expect(readCompletionObligations("sess-bundle-shapes", env)).toEqual([
      expect.objectContaining({ kind: "query_feedback", query_id: QUERY_ID }),
    ]);
    expect(readValueEpisodeSurfaces("sess-bundle-shapes", env)).toEqual([
      expect.objectContaining({
        query_id: QUERY_ID,
        candidates: [
          { result_id: "qres_bundle_0", value_estimate_id: "vest_bundle_0" },
          { result_id: "qres_bundle_1", value_estimate_id: "vest_bundle_1" },
        ],
      }),
    ]);
  }, 30_000);
});
