import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  autoQueryTimeoutMs,
  buildQueryPayload,
  clearHighMatchSurfaceIfOpened,
  clearHighMatchSurfaceForExplicitSelection,
  contributionReason,
  countRegistryConsumption,
  countTaskEligibility,
  detectHighValueLessonSignal,
  detectHighValueLessonSignalInText,
  directSelectionFromResponse,
  decideStop,
  formatContext,
  highMatchFromResponse,
  isContextualContinuationPrompt,
  hostedMcpSplitNotice,
  inferDomain,
  parseCodexMcpRegistration,
  parseCodexMcpUrl,
  markValueEpisodeSelection,
  readDirectSelectionSurface,
  readDirectSelectionSurfaces,
  readPromptedCount,
  readPluginLifecycleHealth,
  readHighMatchSurface,
  readDirectiveSurface,
  readRegistryUseCount,
  readTaskEligibilityCount,
  readRemembranceConfig,
  readValueEpisodeSurfaces,
  queryResponseHasMatches,
  recordRegistryUse,
  recordDirectiveFollowThroughForTool,
  recordDirectSelectionSurface,
  recordDirectiveSurface,
  recordHighMatchSurface,
  recordPluginLifecycleHealth,
  recordTaskEligibility,
  recordValueEpisodeSurface,
  redactPrompt,
  remembranceConfigPath,
  reportTaskOutcomesOnStop,
  resolveApiConfiguration,
  resolveApiCredential,
  resolveApiKey,
  sharedConfigCredentialNotice,
  shouldQueryPrompt,
  valueEpisodeFromResponse,
  writePromptedCount,
} from "../scripts/hook-core.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-codex-core-"));
let counter = 0;

// Point the marker mechanism at an isolated temp dir per test.
function markerEnv(extra = {}) {
  counter += 1;
  return {
    REMEMBRANCE_USAGE_DIR: join(tempRoot, `usage-${counter}`),
    ...extra,
  };
}

function isolatedCodexMcpEnv(extra = {}) {
  counter += 1;
  return {
    REMEMBRANCE_CODEX_CONFIG_PATH: join(
      tempRoot,
      `missing-codex-config-${counter}.toml`,
    ),
    ...extra,
  };
}

describe("autoQueryTimeoutMs", () => {
  it("keeps the fail-open default while allowing a bounded remote-integration override", () => {
    expect(autoQueryTimeoutMs({})).toBe(2_000);
    expect(
      autoQueryTimeoutMs({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "30000" }),
    ).toBe(30_000);
    expect(
      autoQueryTimeoutMs({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "30001" }),
    ).toBe(2_000);
  });
});

describe("native plugin lifecycle health markers", () => {
  it("records content-free component observations and preserves version metadata", () => {
    const env = {
      REMEMBRANCE_PLUGIN_HEALTH_DIR: join(tempRoot, "plugin-health"),
    };
    expect(
      recordPluginLifecycleHealth(
        {
          surface: "codex",
          component: "session_start",
          pluginVersion: "0.1.37",
          hostVersion: "0.145.0",
          credentialSource: "shared_config",
        },
        env,
      ),
    ).toBe(true);
    expect(
      recordPluginLifecycleHealth(
        { surface: "codex", component: "prompt_hook" },
        env,
      ),
    ).toBe(true);
    expect(readPluginLifecycleHealth("codex", env)).toMatchObject({
      schema_version: 1,
      surface: "codex",
      plugin_version: "0.1.37",
      host_version: "0.145.0",
      credential_source: "shared_config",
      components: {
        session_start: expect.any(String),
        prompt_hook: expect.any(String),
      },
    });
    expect(readPluginLifecycleHealth("codex", env)).not.toHaveProperty(
      "prompt",
    );
  });

  it("starts each host session without stale component observations", () => {
    const env = {
      REMEMBRANCE_PLUGIN_HEALTH_DIR: join(tempRoot, "reset-plugin-health"),
    };
    expect(
      recordPluginLifecycleHealth(
        { surface: "codex", component: "prompt_hook" },
        env,
      ),
    ).toBe(true);
    expect(
      recordPluginLifecycleHealth(
        { surface: "codex", component: "completion_hook" },
        env,
      ),
    ).toBe(true);

    expect(
      recordPluginLifecycleHealth(
        { surface: "codex", component: "session_start" },
        env,
      ),
    ).toBe(true);
    expect(readPluginLifecycleHealth("codex", env)?.components).toEqual({
      session_start: expect.any(String),
    });
  });

  it("keeps concurrent host-session lifecycle evidence isolated", () => {
    const env = {
      REMEMBRANCE_PLUGIN_HEALTH_DIR: join(tempRoot, "concurrent-plugin-health"),
    };
    for (const component of ["session_start", "prompt_hook"]) {
      expect(
        recordPluginLifecycleHealth(
          { surface: "codex", component, sessionId: "session-a" },
          env,
        ),
      ).toBe(true);
    }
    for (const component of [
      "session_start",
      "prompt_hook",
      "tool_observer",
      "completion_hook",
    ]) {
      expect(
        recordPluginLifecycleHealth(
          { surface: "codex", component, sessionId: "session-b" },
          env,
        ),
      ).toBe(true);
    }

    expect(
      readPluginLifecycleHealth("codex", env, "session-a")?.components,
    ).toEqual({
      session_start: expect.any(String),
      prompt_hook: expect.any(String),
    });
    expect(
      readPluginLifecycleHealth("codex", env, "session-b")?.components,
    ).toEqual({
      session_start: expect.any(String),
      prompt_hook: expect.any(String),
      tool_observer: expect.any(String),
      completion_hook: expect.any(String),
    });
    expect(
      readdirSync(env.REMEMBRANCE_PLUGIN_HEALTH_DIR).filter((name) =>
        name.startsWith("codex."),
      ),
    ).toHaveLength(2);
  });

  it("fails open for invalid surfaces, components, and unreadable markers", () => {
    const env = {
      REMEMBRANCE_PLUGIN_HEALTH_DIR: join(tempRoot, "invalid-plugin-health"),
    };
    expect(
      recordPluginLifecycleHealth(
        { surface: "other", component: "session_start" },
        env,
      ),
    ).toBe(false);
    expect(
      recordPluginLifecycleHealth(
        { surface: "codex", component: "unknown" },
        env,
      ),
    ).toBe(false);
    expect(readPluginLifecycleHealth("other", env)).toBeNull();
    mkdirSync(env.REMEMBRANCE_PLUGIN_HEALTH_DIR, { recursive: true });
    writeFileSync(join(env.REMEMBRANCE_PLUGIN_HEALTH_DIR, "codex.json"), "{");
    expect(readPluginLifecycleHealth("codex", env)).toBeNull();
  });
});

// The bundled local MCP shares hook configuration. A notice is reserved for a
// manual hosted override whose registry actually differs.
describe("hostedMcpSplitNotice", () => {
  it("stays silent when the hooks target the default registry", () => {
    expect(
      hostedMcpSplitNotice({ REMEMBRANCE_API_URL: "https://remembrance.dev" }),
    ).toBeNull();
    // A trailing slash normalizes to the default too.
    expect(
      hostedMcpSplitNotice({ REMEMBRANCE_API_URL: "https://remembrance.dev/" }),
    ).toBeNull();
  });

  it("stays silent for the packaged local MCP registration", () => {
    expect(
      hostedMcpSplitNotice({
        REMEMBRANCE_API_URL: "https://dev.remembrance.example",
        ...isolatedCodexMcpEnv(),
      }),
    ).toBeNull();
  });

  it("flags an actual split introduced by a manual hosted registration", () => {
    const configPath = join(tempRoot, "codex-split.toml");
    writeFileSync(
      configPath,
      [
        "[mcp_servers.remembrance]",
        'url = "https://remembrance.dev/api/mcp"',
      ].join("\n"),
    );
    const notice = hostedMcpSplitNotice({
      REMEMBRANCE_API_URL: "https://dev.remembrance.example",
      REMEMBRANCE_CODEX_CONFIG_PATH: configPath,
    });
    expect(notice).toContain("https://dev.remembrance.example");
    expect(notice).toContain("https://remembrance.dev");
    expect(notice).toContain("active Codex MCP config");
    expect(notice).not.toContain("may still target");
  });

  it("stays silent when an env override points hosted MCP at the hook registry", () => {
    expect(
      hostedMcpSplitNotice({
        REMEMBRANCE_API_URL: "https://dev.remembrance.example",
        REMEMBRANCE_CODEX_MCP_URL: "https://dev.remembrance.example/api/mcp",
        ...isolatedCodexMcpEnv(),
      }),
    ).toBeNull();
  });

  it("stays silent when Codex config.toml points hosted MCP at the hook registry", () => {
    const configPath = join(tempRoot, "codex-aligned.toml");
    writeFileSync(
      configPath,
      [
        "[mcp_servers.remembrance]",
        'url = "https://dev.remembrance.example/api/mcp"',
      ].join("\n"),
    );

    expect(
      hostedMcpSplitNotice({
        REMEMBRANCE_API_URL: "https://dev.remembrance.example/",
        REMEMBRANCE_CODEX_CONFIG_PATH: configPath,
      }),
    ).toBeNull();
  });

  it("parses only the Codex remembrance MCP server URL", () => {
    expect(
      parseCodexMcpUrl(`
        [mcp_servers.other]
        url = "https://other.example/api/mcp"

        [mcp_servers.remembrance]
        url = "https://dev.remembrance.example/api/mcp"
      `),
    ).toBe("https://dev.remembrance.example/api/mcp");
  });
});

describe("Codex hosted MCP credential registration parsing", () => {
  it("recognizes a local stdio registration without inventing hosted credentials", () => {
    expect(
      parseCodexMcpRegistration(`
        [mcp_servers.remembrance]
        command = "node"
      `),
    ).toEqual({
      url: null,
      command: "node",
      credentialEnvVars: [],
      hasStaticCredential: false,
    });
  });

  it("parses bearer and env-header credential declarations without values", () => {
    expect(
      parseCodexMcpRegistration(`
        [mcp_servers.remembrance]
        url = "https://remembrance.dev/api/mcp"
        bearer_token_env_var = "REMEMBRANCE_API_KEY"
      `),
    ).toEqual({
      url: "https://remembrance.dev/api/mcp",
      credentialEnvVars: ["REMEMBRANCE_API_KEY"],
      hasStaticCredential: false,
    });
    expect(
      parseCodexMcpRegistration(`
        [mcp_servers.remembrance]
        url = "https://remembrance.dev/api/mcp"
        env_http_headers = { "X-Remembrance-API-Key" = "ORG_MCP_KEY", "X-Trace" = "TRACE_ID" }
      `),
    ).toEqual({
      url: "https://remembrance.dev/api/mcp",
      credentialEnvVars: ["ORG_MCP_KEY"],
      hasStaticCredential: false,
    });
    expect(
      parseCodexMcpRegistration(`
        [mcp_servers.remembrance]
        url = "https://remembrance.dev/api/mcp"

        [mcp_servers.remembrance.env_http_headers]
        Authorization = "REMEMBRANCE_BEARER"
      `),
    ).toEqual({
      url: "https://remembrance.dev/api/mcp",
      credentialEnvVars: ["REMEMBRANCE_BEARER"],
      hasStaticCredential: false,
    });
  });
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("hook-core trigger + payload helpers", () => {
  it("injects the query receipt needed to close query-fit feedback", () => {
    const context = formatContext({
      body: {
        query_id: "rq_hook_context",
        query_feedback: { query_id: "rq_hook_context" },
        skills: [
          {
            slug: "remembrancer",
            description: "Operational memory.",
            result_id: "qres_hook_context",
            match_tier: "high",
            match_reason: "Strong task and constraint coverage",
            why_matched: {
              matched_terms: ["operational", "memory"],
              matched_capabilities: ["query_registry"],
              domain_match: true,
              satisfied_constraints: ["reviewed memory"],
              missed_constraints: [],
              lexical_signal: "strong",
              semantic_signal: "moderate",
            },
            applicability: {
              fit: "likely",
              scope: "general",
              reason: "A stated use condition matches this task",
              use_when: ["Reusable operational work"],
              avoid_when: [],
            },
            estimated_tokens: 420,
            verified_uses: 12,
            risk_level: "low",
            value_estimate_id: "vpr_hook_context",
            potential_savings: {
              unit: "tokens",
              context_tokens: 420,
              estimated_saved: { low: 5200, median: 6900, high: 8700 },
              proof_grade: "B",
              measured_episodes: 114,
              proof_url: "/api/v1/value-proofs/vpr_hook_context",
              caveat: "Estimate, not a guarantee.",
            },
          },
        ],
        resources: [],
      },
    });

    expect(context).toContain("Query receipt: rq_hook_context");
    expect(context).toContain("result qres_hook_context");
    expect(context).toContain("submit_query_feedback");
    expect(context).toContain("HIGH MATCH — required next step");
    expect(context).toContain('"query_id":"rq_hook_context"');
    expect(context).toContain("~420 tokens, 12 verified uses, risk low");
    expect(context).toContain("terms operational, memory");
    expect(context).toContain("capabilities query_registry");
    expect(context).toContain("constraints met reviewed memory");
    expect(context).toContain("signals lexical strong, semantic moderate");
    expect(context).toContain("applicability likely/general");
    expect(context).toContain("use only when Reusable operational work");
    expect(context).toContain(
      "5.2k-8.7k potential tokens saved (grade B signed proof)",
    );
    expect(context.toLowerCase()).not.toMatch(
      /usd|price|rebate|credit|payment/,
    );
    expect(context).toContain("Delegating this task?");
    expect(
      highMatchFromResponse({ body: { query_id: "rq", skills: [] } }),
    ).toBeNull();
  });

  it("filters public candidates from org-only context and high-match selection", () => {
    const response = {
      body: {
        query_id: "rq_org_only",
        skill_access: {
          policy: "org_only",
          public_skills_allowed: false,
          effective_scope: "organization",
        },
        skills: [
          {
            slug: "public-high-match",
            source: "public",
            description: "A public result that must not reach the agent.",
            result_id: "qres_public",
            match_tier: "high",
          },
          {
            slug: "private-org-skill",
            source: "org_overlay",
            description: "The organization-owned result.",
            result_id: "qres_org",
            match_tier: "possible",
          },
        ],
        resources: [],
      },
    };

    const context = formatContext(response);
    expect(context).toContain(
      "Organization policy: use organization skills only",
    );
    expect(context).toContain("private-org-skill");
    expect(context).not.toContain("public-high-match");
    expect(context).not.toContain("HIGH MATCH — required next step");
    expect(highMatchFromResponse(response)).toBeNull();
    expect(queryResponseHasMatches(response)).toBe(true);
    expect(
      queryResponseHasMatches({
        body: {
          skill_access: { public_skills_allowed: false },
          skills: [{ slug: "public-only", source: "public" }],
          resources: [],
        },
      }),
    ).toBe(false);
    expect(
      queryResponseHasMatches({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              body: { skills: [], resources: [{ slug: "docs" }] },
            }),
          },
        ],
      }),
    ).toBe(true);
  });

  it("surfaces bounded corner-case exclusions so the agent can discard a poor match", () => {
    const response = {
      body: {
        query_id: "rq_corner_case",
        skills: [
          {
            slug: "atlas-federation-spill-workaround",
            description: "A narrow MongoDB aggregation workaround.",
            result_id: "qres_corner_case",
            match_tier: "exploratory",
            estimated_tokens: 300,
            verified_uses: 2,
            risk_level: "low",
            why_matched: {
              matched_terms: [
                "mongodb",
                "aggregation",
                "pipeline",
                "optimize",
                "ignored-fifth-term",
              ],
              matched_capabilities: ["optimize_mongodb_aggregation"],
              domain_match: true,
              satisfied_constraints: [],
              missed_constraints: ["routine index tuning"],
              lexical_signal: "strong",
              semantic_signal: "strong",
            },
            applicability: {
              fit: "unlikely",
              scope: "corner_case",
              reason: "No stated use condition matches this task",
              use_when: [
                "Atlas Data Federation spill-to-disk failure",
                "Federated query memory limit",
                "ignored third condition",
              ],
              avoid_when: ["Routine aggregation index tuning"],
            },
          },
        ],
        resources: [],
      },
    };

    const context = formatContext(response);
    expect(context).toContain(
      "applicability unlikely/corner_case: No stated use condition matches this task",
    );
    expect(context).toContain(
      "use only when Atlas Data Federation spill-to-disk failure; Federated query memory limit",
    );
    expect(context).toContain("avoid when Routine aggregation index tuning");
    expect(context).toContain("constraints missing routine index tuning");
    expect(context).not.toContain("ignored-fifth-term");
    expect(context).not.toContain("ignored third condition");
    expect(context).not.toContain("required next step");
    expect(highMatchFromResponse(response)).toBeNull();
  });

  it("reports one bounded, correlated plugin-observed outcome without task content", async () => {
    const env = markerEnv({
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_API_KEY: "org_test_key",
    });
    const sessionId = "value-outcome-session";
    const episode = valueEpisodeFromResponse({
      body: {
        query_id: "rq_value_hook",
        task_outcome: {
          available: true,
          eligible_result_ids: ["qres_value_hook"],
        },
        skills: [
          {
            result_id: "qres_value_hook",
            value_estimate_id: "vpr_value_hook",
            task_outcome_eligible: true,
          },
          {
            result_id: "qres_private_opted_out",
            value_estimate_id: "vpr_private_opted_out",
            task_outcome_eligible: false,
          },
        ],
      },
    });
    expect(episode?.candidates).toEqual([
      {
        result_id: "qres_value_hook",
        value_estimate_id: "vpr_value_hook",
      },
    ]);
    expect(
      valueEpisodeFromResponse({
        body: {
          query_id: "rq_no_eligible_results",
          task_outcome: { available: true, eligible_result_ids: [] },
          skills: [],
        },
      }),
    ).toBeNull();
    expect(recordValueEpisodeSurface(sessionId, episode, env)).toBe(true);
    expect(
      markValueEpisodeSelection(
        sessionId,
        "rq_value_hook",
        "qres_value_hook",
        env,
      ),
    ).toBe(true);

    const requests = [];
    const recorded = await reportTaskOutcomesOnStop(
      sessionId,
      {
        observed_model_revision: "gpt-5.6-2026-07-01",
        reasoning_effort: "high",
        token_usage: {
          input_tokens: 1_000,
          output_tokens: 300,
          cache_read_tokens: 100,
          cache_write_tokens: 50,
          reasoning_tokens: 80,
        },
        prompt: "private prompt must never be transmitted",
        output: "private output must never be transmitted",
      },
      {
        env,
        userAgent: "@remembrance/test-plugin",
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          return { ok: true };
        },
      },
    );

    expect(recorded).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://registry.example/api/v1/agent/task-outcomes",
    );
    expect(requests[0].init.headers).toMatchObject({
      "x-remembrance-api-key": "org_test_key",
      "user-agent": "@remembrance/test-plugin",
    });
    const body = JSON.parse(requests[0].init.body);
    expect(body).toMatchObject({
      query_id: "rq_value_hook",
      result_ids: ["qres_value_hook"],
      estimate_id: "vpr_value_hook",
      status: "completed",
      measurement_source: "plugin_observed",
      observed_model_revision: "gpt-5.6-2026-07-01",
      reasoning_effort: "high",
      token_usage: {
        uncached_input_tokens: 850,
        cache_read_tokens: 100,
        cache_write_tokens: 50,
        visible_output_tokens: 220,
        reasoning_tokens: 80,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/private prompt|private output/);
    expect(readValueEpisodeSurfaces(sessionId, env)[0]?.reported_at).toEqual(
      expect.any(String),
    );
    expect(
      await reportTaskOutcomesOnStop(
        sessionId,
        {},
        {
          env,
          fetchImpl: vi.fn(),
        },
      ),
    ).toBe(0);
  });

  it("uses the exact pair bundle when two of three surfaced results are selected", async () => {
    const env = markerEnv({
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_API_KEY: "org_bundle_key",
    });
    const sessionId = "value-bundle-outcome-session";
    const episode = valueEpisodeFromResponse({
      body: {
        query_id: "rq_value_bundle_hook",
        task_outcome: {
          available: true,
          eligible_result_ids: [
            "qres_bundle_one",
            "qres_bundle_two",
            "qres_bundle_three",
          ],
        },
        skills: [
          {
            result_id: "qres_bundle_one",
            value_estimate_id: "vpr_individual_one",
            task_outcome_eligible: true,
          },
          {
            result_id: "qres_bundle_two",
            value_estimate_id: "vpr_individual_two",
            task_outcome_eligible: true,
          },
          {
            result_id: "qres_bundle_three",
            value_estimate_id: "vpr_individual_three",
            task_outcome_eligible: true,
          },
        ],
        skill_bundles: [
          {
            bundle_id: "vbun_hook_full",
            result_ids: [
              "qres_bundle_one",
              "qres_bundle_two",
              "qres_bundle_three",
            ],
            value_estimate_id: "vpr_bundle_full",
            task_outcome_eligible: true,
          },
          {
            bundle_id: "vbun_hook_pair",
            result_ids: ["qres_bundle_one", "qres_bundle_two"],
            value_estimate_id: "vpr_bundle_pair",
            task_outcome_eligible: true,
          },
        ],
      },
    });
    expect(episode?.bundles).toHaveLength(2);
    expect(recordValueEpisodeSurface(sessionId, episode, env)).toBe(true);
    expect(
      markValueEpisodeSelection(
        sessionId,
        "rq_value_bundle_hook",
        "qres_bundle_two",
        env,
      ),
    ).toBe(true);
    expect(
      markValueEpisodeSelection(
        sessionId,
        "rq_value_bundle_hook",
        "qres_bundle_one",
        env,
      ),
    ).toBe(true);

    const requests = [];
    await expect(
      reportTaskOutcomesOnStop(
        sessionId,
        {},
        {
          env,
          fetchImpl: async (_url, init) => {
            requests.push(JSON.parse(init.body));
            return { ok: true };
          },
        },
      ),
    ).resolves.toBe(1);
    expect(requests).toEqual([
      expect.objectContaining({
        query_id: "rq_value_bundle_hook",
        result_ids: ["qres_bundle_two", "qres_bundle_one"],
        estimate_id: "vpr_bundle_pair",
        bundle_id: "vbun_hook_pair",
      }),
    ]);
  });

  it("matches relevant prompts and skips one-off facts", () => {
    expect(shouldQueryPrompt("Deploy a Next.js app on Vercel")).toMatchObject({
      likely_match: true,
    });
    expect(
      shouldQueryPrompt("Redesign the dashboard and declutter the review card"),
    ).toMatchObject({ likely_match: true, reason: "ui_or_dashboard_work" });
    expect(shouldQueryPrompt("What is the capital of France?")).toMatchObject({
      likely_match: false,
    });
    expect(shouldQueryPrompt("Search the web for current news")).toMatchObject({
      likely_match: false,
    });
    expect(shouldQueryPrompt("fix these issues")).toMatchObject({
      likely_match: false,
    });
    expect(isContextualContinuationPrompt("fix these issues")).toBe(true);
    expect(isContextualContinuationPrompt("continue")).toBe(true);
    expect(
      shouldQueryPrompt(
        "Use remembrance://skills/web-ui-ux-qa for this dashboard",
      ),
    ).toEqual({
      likely_match: false,
      reason: "explicit_skill_reference",
    });
    expect(
      shouldQueryPrompt(
        "Use the Remembrance skill web-ui-ux-qa for this dashboard",
      ),
    ).toEqual({
      likely_match: false,
      reason: "explicit_skill_reference",
    });
    expect(
      shouldQueryPrompt(
        'Load the skill named "mongodb-aggregation" from Remembrance',
      ),
    ).toEqual({
      likely_match: false,
      reason: "explicit_skill_reference",
    });
    expect(
      isContextualContinuationPrompt("/remembrance:use web-ui-ux-qa"),
    ).toBe(false);
    expect(
      isContextualContinuationPrompt("What is the capital of France?"),
    ).toBe(false);
  });

  it("infers seeded domains and clamps the limit", () => {
    expect(
      inferDomain("Fix the Vercel Next.js build error in GitHub Actions"),
    ).toBe("deployment");
    expect(inferDomain("Find an MPP endpoint for x402 payments")).toBe("mpp");
    expect(inferDomain("Build a Tailwind modal component with a tooltip")).toBe(
      "web-ui-qa",
    );
    expect(inferDomain("Help me think through an unrelated idea")).toBe(
      "agent-skills",
    );
    const payload = buildQueryPayload("Run Playwright QA", {
      REMEMBRANCE_AUTO_QUERY_LIMIT: "99",
    });
    expect(payload.limit).toBe(3);
    // provider must be a value the server's agentProviderSchema accepts; the old
    // "openai" was rejected, silently disabling the codex auto-query.
    expect(payload.agent).toMatchObject({ provider: "codex", model: "codex" });
    expect(
      buildQueryPayload("Run Playwright QA", {}, undefined, {
        surface: "plugin_hook",
        trigger_reason: "ui_or_dashboard_work",
      }).client_context,
    ).toEqual({
      surface: "plugin_hook",
      trigger_reason: "ui_or_dashboard_work",
    });
  });

  it("lets a runtime override the agent identity (e.g. OpenClaw)", () => {
    const payload = buildQueryPayload(
      "Run Playwright QA",
      {},
      {
        provider: "openclaw",
        model: "openclaw",
      },
    );
    expect(payload.agent).toMatchObject({
      provider: "openclaw",
      model: "openclaw",
    });
  });

  it("redacts secrets and private URLs", () => {
    expect(redactPrompt("api_key=secret123 for Vercel")).toContain(
      "[redacted-secret]",
    );
    expect(redactPrompt("github_pat_123456789012345678901234")).toBe(
      "[redacted-secret]",
    );
    expect(redactPrompt("https://payments.internal/path")).toBe(
      "[redacted-private-url]",
    );
  });

  it("redacts DB connection strings for every scheme, credentials and all", () => {
    // Regression: the ':' must apply to all schemes, not just postgres —
    // otherwise mongodb/redis URIs (which also trip TOOL_PATTERNS and fire the
    // hook) leak credentials to the registry.
    for (const [uri, credential] of [
      ["mongodb://admin:hunter2@db.example.com/prod", "hunter2"],
      ["mongodb+srv://user:corgi9@cluster.mongodb.net/db", "corgi9"],
      ["redis://:zebra7@cache.example.com:6379/0", "zebra7"],
      ["rediss://:kiwi42@cache.example.com/0", "kiwi42"],
      ["postgres://user:llama3@host/db", "llama3"],
      ["postgresql://user:mango5@host/db", "mango5"],
    ]) {
      const redacted = redactPrompt(`connect to ${uri} now`);
      expect(redacted).not.toContain(credential);
      expect(redacted).not.toContain("@");
      expect(redacted).toContain("[redacted-secret]");
    }
  });
});

describe("hook-core countRegistryConsumption", () => {
  const usedTranscript =
    '{"content":"Remembrance auto-query context: Trigger: external_service."}\n';
  const twoUses = `${usedTranscript}{"tool":"mcp__plugin_remembrance_remembrance__query_skills"}\n`;

  it("counts consumption markers, not submissions", () => {
    expect(countRegistryConsumption(usedTranscript)).toBe(1);
    expect(countRegistryConsumption(twoUses)).toBe(2);
    expect(countRegistryConsumption('{"content":"rename a variable"}')).toBe(0);
    // Submissions are not consumption, so contributing never counts.
    expect(
      countRegistryConsumption(
        "POST /api/v1/agent/remembrances and mcp__x_remembrance__submit_feedback",
      ),
    ).toBe(0);
    expect(
      countRegistryConsumption(
        '{"tool":"mcp__remembrance__invoke_skill"}\nPOST /api/v1/agent/skill-invocations',
      ),
    ).toBe(2);
  });

  it("counts each unresolved contextual or unavailable-query task", () => {
    expect(
      countTaskEligibility(
        "Remembrance task-continuation reminder\n" +
          "Remembrance query-unavailable context",
      ),
    ).toBe(2);
    expect(countTaskEligibility(usedTranscript)).toBe(0);
  });
});

describe("hook-core marker round-trip", () => {
  it("records and reads a per-session use count", () => {
    const env = markerEnv();
    expect(readRegistryUseCount("sess-a", env)).toBe(0);
    expect(recordRegistryUse("sess-a", env)).toBe(1);
    expect(recordRegistryUse("sess-a", env)).toBe(2);
    expect(readRegistryUseCount("sess-a", env)).toBe(2);
    // A different session id is isolated.
    expect(readRegistryUseCount("sess-b", env)).toBe(0);
  });

  it("records and reads the prompted-count sentinel independently", () => {
    const env = markerEnv();
    expect(readPromptedCount("sess-c", env)).toBe(0);
    recordRegistryUse("sess-c", env);
    recordRegistryUse("sess-c", env);
    // Use and prompted counters are separate files.
    expect(readRegistryUseCount("sess-c", env)).toBe(2);
    expect(readPromptedCount("sess-c", env)).toBe(0);
    writePromptedCount("sess-c", 2, env);
    expect(readPromptedCount("sess-c", env)).toBe(2);
    // Use counter is unaffected by writing the prompted counter.
    expect(readRegistryUseCount("sess-c", env)).toBe(2);
  });

  it("records, replaces, and clears bounded high-match state", () => {
    const env = markerEnv();
    expect(readHighMatchSurface("sess-high", env)).toBeNull();
    recordHighMatchSurface(
      "sess-high",
      {
        query_id: "rq_high",
        result_id: "qres_high",
        target_type: "skill",
        slug: "web-ui-ux-qa",
        match_reason: "Strong task coverage",
        estimated_tokens: 420,
        verified_uses: 12,
        risk_level: "low",
      },
      env,
    );
    expect(readHighMatchSurface("sess-high", env)).toMatchObject({
      query_id: "rq_high",
      slug: "web-ui-ux-qa",
      estimated_tokens: 420,
    });
    recordHighMatchSurface("sess-high", null, env);
    expect(readHighMatchSurface("sess-high", env)).toBeNull();
  });

  it("stores only bounded direct-selection metadata and clears a matching high reminder", () => {
    const env = markerEnv();
    const response = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            body: {
              invocation_id: "rinv_direct",
              query_id: "rinv_direct",
              result_id: "qres_direct",
              selection_mode: "explicit",
              skill: {
                slug: "mongodb-aggregation",
                version: 4,
                version_id: "skv_direct",
                source: "org_overlay",
                skill_md: "# Private instructions\nNever persist this body.",
                task_outcome_eligible: true,
              },
              feedback: { available: true },
              task_outcome: {
                available: true,
                eligible_result_ids: ["qres_direct"],
              },
            },
          }),
        },
      ],
    };
    const selection = directSelectionFromResponse(response);
    expect(selection).toMatchObject({
      query_id: "rinv_direct",
      result_id: "qres_direct",
      slug: "mongodb-aggregation",
      version: "4",
      version_id: "skv_direct",
      feedback_available: true,
      task_outcome_available: true,
    });
    recordRegistryUse("sess-direct", env);
    expect(
      recordDirectSelectionSurface(
        "sess-direct",
        { ...selection, use_count: 1 },
        env,
      ),
    ).toBe(true);
    expect(readDirectSelectionSurface("sess-direct", env)).toMatchObject({
      slug: "mongodb-aggregation",
      use_count: 1,
    });
    const marker = readFileSync(
      join(
        env.REMEMBRANCE_USAGE_DIR,
        readdirSync(env.REMEMBRANCE_USAGE_DIR).find((file) =>
          file.endsWith(".direct-skill.json"),
        ),
      ),
      "utf8",
    );
    expect(marker).not.toContain("Private instructions");
    expect(marker).not.toContain("skill_md");

    recordHighMatchSurface(
      "sess-direct",
      {
        query_id: "rq_ranked",
        result_id: "qres_ranked",
        target_type: "skill",
        slug: "mongodb-aggregation",
      },
      env,
    );
    expect(
      clearHighMatchSurfaceForExplicitSelection(
        "sess-direct",
        "mongodb-aggregation",
        env,
      ),
    ).toBe(true);
    expect(readHighMatchSurface("sess-direct", env)).toBeNull();
  });

  it("retains multiple direct selections and prompts for the new set only once", () => {
    const env = markerEnv();
    const firstUse = recordRegistryUse("sess-direct-batch", env);
    recordDirectSelectionSurface(
      "sess-direct-batch",
      {
        query_id: "rinv_first",
        result_id: "qres_first",
        slug: "first-skill",
        version: "1.0.0",
        feedback_available: true,
        use_count: firstUse,
      },
      env,
    );
    const markerPath = join(
      env.REMEMBRANCE_USAGE_DIR,
      readdirSync(env.REMEMBRANCE_USAGE_DIR).find((file) =>
        file.endsWith(".direct-skill.json"),
      ),
    );
    const stored = JSON.parse(readFileSync(markerPath, "utf8"));
    writeFileSync(markerPath, JSON.stringify(stored[0]));
    expect(readDirectSelectionSurfaces("sess-direct-batch", env)).toHaveLength(
      1,
    );

    const secondUse = recordRegistryUse("sess-direct-batch", env);
    recordDirectSelectionSurface(
      "sess-direct-batch",
      {
        query_id: "rinv_second",
        result_id: "qres_second",
        slug: "second-skill",
        version: "2.0.0",
        feedback_available: true,
        use_count: secondUse,
      },
      env,
    );
    expect(
      readDirectSelectionSurfaces("sess-direct-batch", env).map(
        (selection) => selection.slug,
      ),
    ).toEqual(["first-skill", "second-skill"]);

    const decision = decideStop(
      { session_id: "sess-direct-batch" },
      {
        env,
        readEligibilityCount: () => 9,
        readPromptedCount: () => 0,
        readHighMatch: () => null,
      },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("2 Remembrance skills");
    expect(decision.reason).toContain("first-skill");
    expect(decision.reason).toContain("second-skill");
    expect(decision.reason.match(/Call submit_feedback once/g)).toHaveLength(1);
    expect(decision.useCount).toBe(9);

    writePromptedCount("sess-direct-batch", decision.useCount, env);
    expect(
      decideStop(
        { session_id: "sess-direct-batch" },
        {
          env,
          readEligibilityCount: () => 9,
          readHighMatch: () => null,
        },
      ),
    ).toEqual({ allow: true, why: "no_new_usage" });

    const thirdUse = recordRegistryUse("sess-direct-batch", env);
    recordDirectSelectionSurface(
      "sess-direct-batch",
      {
        query_id: "rinv_third",
        result_id: "qres_third",
        slug: "third-skill",
        feedback_available: true,
        use_count: thirdUse,
      },
      env,
    );
    const laterDecision = decideStop(
      { session_id: "sess-direct-batch" },
      {
        env,
        readEligibilityCount: () => 9,
        readHighMatch: () => null,
      },
    );
    expect(laterDecision.allow).toBe(false);
    expect(laterDecision.reason).toContain("third-skill");
    expect(laterDecision.reason).not.toContain("first-skill");
  });

  it("builds a selected direct outcome episode and never asks for query-fit feedback", () => {
    const response = {
      selection_mode: "explicit",
      query_id: "rinv_episode",
      result_id: "qres_episode",
      skill: {
        slug: "web-ui-ux-qa",
        version: 7,
        version_id: "skv_episode",
        skill_md: "# Instructions",
        task_outcome_eligible: true,
      },
      feedback: { available: true },
      task_outcome: {
        available: true,
        eligible_result_ids: ["qres_episode"],
      },
    };
    expect(valueEpisodeFromResponse(response)).toMatchObject({
      query_id: "rinv_episode",
      interaction_kind: "direct_selection",
      candidates: [{ result_id: "qres_episode" }],
      selected_result_ids: ["qres_episode"],
      feedback_available: true,
    });
    const reason = contributionReason(null, null, {
      slug: "web-ui-ux-qa",
      version: "7",
      query_id: "rinv_episode",
      result_id: "qres_episode",
    });
    expect(reason).toContain("explicitly used");
    expect(reason).toContain("Do not submit query-fit feedback");
    expect(reason).not.toContain("submit_query_feedback");
  });

  it("reports a directly selected skill outcome exactly once at completion", async () => {
    const env = markerEnv({
      REMEMBRANCE_API_URL: "https://registry.example",
      REMEMBRANCE_API_KEY: "org_direct_outcome_key",
    });
    const sessionId = "direct-outcome-session";
    const episode = valueEpisodeFromResponse({
      selection_mode: "explicit",
      query_id: "rinv_direct_outcome",
      result_id: "qres_direct_outcome",
      skill: {
        slug: "web-ui-ux-qa",
        version: 8,
        version_id: "skv_direct_outcome",
        skill_md: "# Instructions",
        task_outcome_eligible: true,
      },
      feedback: { available: true },
      task_outcome: {
        available: true,
        eligible_result_ids: ["qres_direct_outcome"],
      },
    });
    expect(recordValueEpisodeSurface(sessionId, episode, env)).toBe(true);

    const requests = [];
    expect(
      await reportTaskOutcomesOnStop(
        sessionId,
        {},
        {
          env,
          fetchImpl: async (url, init) => {
            requests.push({ url, init });
            return { ok: true };
          },
        },
      ),
    ).toBe(1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].init.body)).toMatchObject({
      query_id: "rinv_direct_outcome",
      result_ids: ["qres_direct_outcome"],
      status: "completed",
      measurement_source: "plugin_observed",
    });
    expect(
      await reportTaskOutcomesOnStop(
        sessionId,
        {},
        { env, fetchImpl: vi.fn() },
      ),
    ).toBe(0);
  });

  it("does not prompt a direct invocation when feedback is unavailable", () => {
    expect(
      decideStop(
        { session_id: "query-only" },
        {
          env: {},
          readUseCount: () => 1,
          readEligibilityCount: () => 1,
          readPromptedCount: () => 0,
          readHighMatch: () => null,
          readDirectSelection: () => ({
            slug: "private-skill",
            use_count: 1,
            feedback_available: false,
          }),
        },
      ),
    ).toEqual({ allow: true, why: "direct_feedback_unavailable" });
  });

  it("clears high-match state only for the exact correlated detail open", () => {
    const env = markerEnv();
    recordHighMatchSurface(
      "sess-open",
      {
        query_id: "rq_open",
        result_id: "qres_open",
        target_type: "skill",
        slug: "web-ui-ux-qa",
      },
      env,
    );

    expect(
      clearHighMatchSurfaceIfOpened(
        "sess-open",
        "mcp__remembrance__get_skill",
        {
          slug: "web-ui-ux-qa",
          query_id: "rq_other",
          result_id: "qres_open",
        },
        env,
      ),
    ).toBe(false);
    expect(readHighMatchSurface("sess-open", env)).not.toBeNull();
    expect(
      clearHighMatchSurfaceIfOpened(
        "sess-open",
        "mcp__remembrance__get_skill",
        {
          slug: "web-ui-ux-qa",
          query_id: "rq_open",
          result_id: "qres_open",
        },
        env,
      ),
    ).toBe(true);
    expect(readHighMatchSurface("sess-open", env)).toBeNull();
  });

  it("counts each eligible prompt so later tasks in one session remain recoverable", () => {
    const env = markerEnv();
    expect(readTaskEligibilityCount("sess-eligible", env)).toBe(0);
    expect(recordTaskEligibility("sess-eligible", env)).toBe(1);
    expect(recordTaskEligibility("sess-eligible", env)).toBe(2);
    expect(readTaskEligibilityCount("sess-eligible", env)).toBe(2);
    expect(readRegistryUseCount("sess-eligible", env)).toBe(0);
  });

  it("correlates and consumes the exact task directive after query_skills", async () => {
    const env = markerEnv();
    recordDirectiveSurface(
      "sess-directive",
      {
        directive_id: "dir_1234567890abcdef1234567890abcdef",
        runtime: "codex",
        trigger_reason: "contextual_continuation",
        shown_at: new Date().toISOString(),
      },
      env,
    );
    const calls = [];
    const recorded = await recordDirectiveFollowThroughForTool(
      "sess-directive",
      "mcp__remembrance__query_skills",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ body: { query_id: "rq_directive" } }),
          },
        ],
      },
      {
        env,
        fetchImpl: vi.fn(async (url, init) => {
          calls.push({ url, body: JSON.parse(String(init.body)) });
          return Response.json({ recorded: true });
        }),
      },
    );

    expect(recorded).toBe(true);
    expect(calls).toEqual([
      {
        url: "https://remembrance.dev/api/v1/agent/directive-events",
        body: {
          event: "followed",
          directive_id: "dir_1234567890abcdef1234567890abcdef",
          query_id: "rq_directive",
        },
      },
    ]);
    expect(readDirectiveSurface("sess-directive", env)).toBeNull();
  });

  it("drops an expired directive marker instead of claiming a later query", () => {
    const env = markerEnv();
    recordDirectiveSurface(
      "sess-stale-directive",
      {
        directive_id: "dir_abcdef1234567890abcdef1234567890",
        runtime: "cursor",
        trigger_reason: "contextual_continuation",
        shown_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      },
      env,
    );
    expect(readDirectiveSurface("sess-stale-directive", env)).toBeNull();
  });

  it("fails open (returns 0) when the marker dir is unreadable", () => {
    // Non-existent dir: readers must return 0, never throw.
    expect(
      readRegistryUseCount("never", {
        REMEMBRANCE_USAGE_DIR: join(tempRoot, "nope"),
      }),
    ).toBe(0);
    expect(
      readPromptedCount("never", {
        REMEMBRANCE_USAGE_DIR: join(tempRoot, "nope"),
      }),
    ).toBe(0);
  });

  it("writes markers under the usage dir", () => {
    const env = markerEnv();
    recordRegistryUse("sess-d", env);
    writePromptedCount("sess-d", 1, env);
    const files = readdirSync(env.REMEMBRANCE_USAGE_DIR);
    expect(files.some((f) => f.endsWith(".use"))).toBe(true);
    expect(files.some((f) => f.endsWith(".prompt"))).toBe(true);
    recordTaskEligibility("sess-d", env);
    expect(
      readdirSync(env.REMEMBRANCE_USAGE_DIR).some((f) =>
        f.endsWith(".eligible"),
      ),
    ).toBe(true);
  });

  it("exposes a stable contribution reason", () => {
    const reason = contributionReason();
    expect(reason).toContain("you used Remembrance this session");
    expect(reason).toContain("submit_query_feedback");
    expect(reason).toContain("propose_private_skill");
    // Case-insensitive: this pins the safety CLAIM, not one capitalization of
    // it, so reordering the surrounding sentences cannot break it spuriously.
    expect(reason).toMatch(
      /never remove or bypass the key to force a public candidate/i,
    );
    expect(reason).toContain("queue_private_skill_import");
    expect(reason).toContain("host privacy-policy denial");
    expect(reason.indexOf("submit_query_feedback")).toBeLessThan(
      reason.indexOf("submit_feedback"),
    );
    // The menu must state the exact auth boundary: omitting a key is the
    // intentional public path, while a supplied bad or insufficient key fails
    // without creating a candidate.
    expect(reason).toMatch(/active organization key keeps it private/i);
    expect(reason).toMatch(/invalid\/inactive key fails with 401/i);
    expect(reason).toMatch(/insufficient key fails with 403/i);
    expect(reason).toContain("organization_private");
    expect(reason).toContain("public_candidate");
    // The safe default must be listed FIRST, because reading order is what made
    // the credential-dependent tool look like the primary path.
    expect(reason.indexOf("propose_private_skill")).toBeLessThan(
      reason.indexOf("propose_skill_idea"),
    );
    expect(contributionReason("release versioning miss")).toContain(
      "High-value lesson detected: release versioning miss",
    );
    expect(
      contributionReason(null, {
        query_id: "rq_high",
        result_id: "qres_high",
        target_type: "skill",
        slug: "web-ui-ux-qa",
        estimated_tokens: 420,
        verified_uses: 12,
        risk_level: "low",
      }),
    ).toContain("If you have not opened it, call get_skill");
  });

  it("detects self-corrections that should become remembrance contributions", () => {
    expect(
      detectHighValueLessonSignal({
        last_assistant_message:
          "I missed the MCP package version bump after publish-impacting plugin changes.",
      }),
    ).toBe("release versioning miss");
    expect(
      detectHighValueLessonSignalInText(
        "I submitted it to Remembrance as rpub_769ded635ea04884a8.",
      ),
    ).toBeNull();
  });
});

describe("hook-core org key resolution", () => {
  // Point XDG_CONFIG_HOME at an isolated temp dir; optionally seed a config.json
  // (a string is written verbatim so we can exercise fail-closed parsing).
  function configEnv(config, extra = {}) {
    counter += 1;
    const dir = join(tempRoot, `cfg-${counter}`);
    if (config !== undefined) {
      mkdirSync(join(dir, "remembrance"), { recursive: true });
      writeFileSync(
        join(dir, "remembrance", "config.json"),
        typeof config === "string" ? config : JSON.stringify(config),
      );
    }
    return { XDG_CONFIG_HOME: dir, ...extra };
  }

  it("resolves the config path under the XDG config dir", () => {
    expect(remembranceConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/remembrance/config.json",
    );
  });

  it("prefers an explicit env key over the config file", () => {
    const env = configEnv(
      { apiKey: "from-file" },
      { REMEMBRANCE_API_KEY: "from-env" },
    );
    expect(resolveApiKey(env)).toBe("from-env");
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "from-env",
      source: "environment",
    });
    expect(sharedConfigCredentialNotice(env)).toBeNull();
    expect(
      resolveApiCredential(
        configEnv(
          { apiKey: " from-file " },
          { REMEMBRANCE_API_KEY: " from-env " },
        ),
      ),
    ).toEqual({ apiKey: "from-env", source: "environment" });
  });

  it("falls back to the config-file key when the env var is unset or empty", () => {
    const env = configEnv({ apiKey: "rmb_file_key" });
    expect(resolveApiKey(env)).toBe("rmb_file_key");
    expect(resolveApiCredential(env)).toEqual({
      apiKey: "rmb_file_key",
      source: "shared_config",
    });
    const notice = sharedConfigCredentialNotice(env);
    expect(notice).toContain("shared Remembrance config file");
    expect(notice).toContain("REMEMBRANCE_API_KEY may be unset");
    expect(notice).toContain("get_connection_status");
    expect(notice).not.toContain("rmb_file_key");
    // `.mcp.json` injects an empty string when the var is unset — treat as unset.
    expect(
      resolveApiKey(
        configEnv({ apiKey: "rmb_file_key" }, { REMEMBRANCE_API_KEY: "" }),
      ),
    ).toBe("rmb_file_key");
    expect(
      resolveApiCredential(
        configEnv({ apiKey: " rmb_file_key " }, { REMEMBRANCE_API_KEY: "  " }),
      ),
    ).toEqual({ apiKey: "rmb_file_key", source: "shared_config" });
  });

  it("returns empty string when neither env nor file provides a key", () => {
    const env = configEnv();
    expect(resolveApiKey(env)).toBe("");
    expect(resolveApiCredential(env)).toEqual({ apiKey: "", source: "none" });
    expect(sharedConfigCredentialNotice(env)).toBeNull();
    expect(resolveApiKey(configEnv({ apiUrl: "https://example.test" }))).toBe(
      "",
    );
  });

  it("distinguishes an absent config from a present but unusable config", () => {
    expect(readRemembranceConfig(configEnv())).toEqual({});
    expect(readRemembranceConfig(configEnv("{not json"))).toEqual({});
    expect(readRemembranceConfig(configEnv("[1,2,3]"))).toEqual({});
    const malformed = configEnv("garbage");
    expect(resolveApiKey(malformed)).toBe("");
    expect(resolveApiCredential(malformed)).toEqual({
      apiKey: "",
      source: "unusable_shared_config",
    });
    expect(sharedConfigCredentialNotice(malformed)).toMatch(
      /calls are paused locally/i,
    );
    expect(resolveApiCredential(configEnv("[1,2,3]"))).toEqual({
      apiKey: "",
      source: "unusable_shared_config",
    });
    for (const config of [{ apiKey: 123 }, { apiKey: "" }]) {
      expect(resolveApiCredential(configEnv(config))).toEqual({
        apiKey: "",
        source: "unusable_shared_config",
      });
    }
  });

  it("fails closed for invalid registry URLs without overriding a complete environment", () => {
    for (const apiUrl of [
      42,
      "",
      "registry.example",
      "https://user:secret@registry.example",
      "https://registry.example?tenant=private",
    ]) {
      const env = configEnv({ apiKey: "rk_file", apiUrl });
      expect(resolveApiConfiguration(env)).toEqual({
        apiUrl: "https://remembrance.dev",
        source: "unusable_shared_config",
      });
      expect(resolveApiCredential(env)).toEqual({
        apiKey: "",
        source: "unusable_shared_config",
      });
    }

    const invalidEnvironment = configEnv(undefined, {
      REMEMBRANCE_API_KEY: "rk_environment",
      REMEMBRANCE_API_URL: "javascript:alert(1)",
    });
    expect(resolveApiConfiguration(invalidEnvironment)).toEqual({
      apiUrl: "https://remembrance.dev",
      source: "unusable_environment",
    });
    expect(resolveApiCredential(invalidEnvironment)).toEqual({
      apiKey: "",
      source: "unusable_environment",
    });
    expect(sharedConfigCredentialNotice(invalidEnvironment)).toContain(
      "absolute HTTP(S) registry URL",
    );

    const completeEnvironment = configEnv("{not json", {
      REMEMBRANCE_API_KEY: "rk_environment",
      REMEMBRANCE_API_URL: "https://registry.example/",
    });
    expect(resolveApiConfiguration(completeEnvironment)).toEqual({
      apiUrl: "https://registry.example",
      source: "environment",
    });
    expect(resolveApiCredential(completeEnvironment)).toEqual({
      apiKey: "rk_environment",
      source: "environment",
    });
  });
});

describe("hook-core context budget", () => {
  const richCandidate = (index, tier) => ({
    slug: `checkout-payment-retry-orchestration-runbook-${index}`,
    match_tier: tier,
    result_id: `qres_${"a1b2c3d4e5f6a7b8".repeat(2)}${index}`,
    estimated_tokens: 4200,
    verified_uses: 12,
    risk_level: "medium",
    description:
      "Guides resilient retry orchestration for mobile checkout payment intents across gateway timeouts, webhook replays, idempotency-key rotation, and partial-capture reconciliation, including the exact backoff schedule and observability counters the payments team standardized on.",
    why_matched: {
      matched_terms: ["checkout", "payment", "retry", "webhook"],
      matched_capabilities: [
        "payment gateway integration",
        "idempotent retry orchestration",
        "webhook replay reconciliation",
      ],
      domain_match: true,
      satisfied_constraints: [
        "must not double-charge the customer",
        "must keep p95 checkout latency under 900ms",
        "works with the legacy tokenization proxy",
      ],
      missed_constraints: ["requires the v2 ledger event schema"],
      lexical_signal: "strong",
      semantic_signal: "moderate",
    },
    applicability: {
      fit: "conditional",
      scope: "specialized",
      reason:
        "Fits gateway-timeout retries on card payments; the runbook assumes the tokenization proxy and does not cover wallet or bank-transfer rails.",
      use_when: [
        "the failure is a gateway timeout or 5xx during capture",
        "idempotency keys are already threaded through checkout",
      ],
      avoid_when: [
        "the charge already settled and needs a refund flow instead",
        "the org uses direct acquirer integration without the proxy",
      ],
    },
  });

  it("never lets rich decision labels evict the contribution directive or delegation line", () => {
    // Five worst-case candidates (~1k chars each) exceed the 4000-char context
    // cap. The directive + delegation tail must be reserved first; dropped
    // candidates are announced, never silently cut mid-line.
    const directive =
      "Close the loop so the next agent inherits what you learned: fetch a high match before custom work, submit query feedback with explicit judgments, then submit_feedback after real use and submit_remembrance when the lesson is reusable.";
    const context = formatContext(
      {
        body: {
          query_id: "rq_0123456789abcdef0123",
          skills: [
            richCandidate(1, "possible"),
            richCandidate(2, "possible"),
            richCandidate(3, "exploratory"),
          ],
          resources: [
            { ...richCandidate(4, "possible"), kind: "reference" },
            { ...richCandidate(5, "exploratory"), kind: "playbook" },
          ],
          contribution_directive: { message: directive },
        },
      },
      "workflow_shape",
      5,
    );
    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context).toContain(`After using Remembrance: ${directive}`);
    expect(context).toContain("Delegating this task?");
    expect(context).toMatch(
      /\(\+\d+ more match(es)? omitted to fit this context; call query_skills with the current task context to retrieve the full list\.\)/,
    );
    // Whatever was kept ends cleanly at a full line, not a mid-line ellipsis.
    expect(context).not.toMatch(/\.\.\.$/);
  });

  it("keeps small responses byte-complete with no omission note", () => {
    const context = formatContext(
      {
        body: {
          query_id: "rq_small",
          skills: [
            {
              slug: "tiny-skill",
              match_tier: "possible",
              description: "Small skill.",
              estimated_tokens: 100,
              verified_uses: 1,
              risk_level: "low",
            },
          ],
          resources: [],
          contribution_directive: { message: "Close the loop." },
        },
      },
      "trigger_match",
      3,
    );
    expect(context).toContain("tiny-skill");
    expect(context).toContain("After using Remembrance: Close the loop.");
    expect(context).toContain("Delegating this task?");
    expect(context).not.toContain("omitted to fit this context");
  });
});

describe("hook-core context budget boundary sweep", () => {
  it("never clips the delegation tail at any directive length (exact-fit boundaries included)", () => {
    // The off-by-one this guards: inserting the candidate block costs one more
    // newline than its internal joins, so an exact-fit block used to push the
    // joined string to 4001 chars and the backstop clipped the tail to "...".
    const skill = (index) => ({
      slug: `sk-skill-${String(index).padStart(2, "0")}`,
      match_tier: "possible",
      description: "d".repeat(280),
      estimated_tokens: 500,
      verified_uses: 3,
      risk_level: "low",
    });
    const resource = (index) => ({
      ...skill(index),
      slug: `rs-skill-${String(index).padStart(2, "0")}`,
      kind: "reference",
    });
    const skills = Array.from({ length: 10 }, (_, i) => skill(i));
    const resources = Array.from({ length: 10 }, (_, i) => resource(i));
    for (
      let directiveLength = 1;
      directiveLength <= 900;
      directiveLength += 1
    ) {
      const context = formatContext(
        {
          body: {
            query_id: "q".repeat(40),
            skills,
            resources,
            contribution_directive: { message: "x".repeat(directiveLength) },
          },
        },
        "trigger_match",
        10,
      );
      expect(context.length).toBeLessThanOrEqual(4000);
      // The tail must end with the full delegation sentence, never an ellipsis.
      expect(
        context.endsWith(
          "it should fetch that result or run its own full-context query before custom work.",
        ),
      ).toBe(true);
    }
  });
});
