// Shared fixtures for the search-hygiene tests of every prompt adapter: a
// host-generated prompt a trigger matches, registry bodies, a recording fake
// registry, and the results block a stopped search must leave out.
import { vi } from "vitest";

// Codex's pull-request generation prompt (its own first two lines), with a
// trigger word in the context, so only hygiene stops its search.
export const STOPPED_PROMPT = [
  "You are a helpful assistant. Generate a pull request title and body.",
  "Write the result into the structured response fields title and body.",
  "",
  "Commits: add the vercel deployment workflow",
].join("\n");

export const REQUIRED_SETTING = Object.freeze({
  key: "workflow.release_approval",
  value: "written",
  label: "Release approval",
  behavior: "Never deploy without written approval.",
  effect: "workflow",
  strength: "prefer",
  definition_version: 1,
  source: "mandatory_org",
});
export const DISCRETIONARY_SETTING = Object.freeze({
  key: "explanation_depth",
  value: "concise",
  label: "Explanation depth",
  behavior: "Keep explanations concise and focused.",
  effect: "presentation",
  strength: "prefer",
  definition_version: 1,
  source: "explicit_member",
});
export const ORG_ONLY_ACCESS = Object.freeze({
  scope: "organization",
  policy: "org_only",
  public_skills_allowed: false,
  offline_public_fallback_allowed: false,
});
export const ORG_ALLOW_ACCESS = Object.freeze({
  scope: "organization",
  policy: "allow",
  public_skills_allowed: true,
  offline_public_fallback_allowed: true,
});
export const ANONYMOUS_ACCESS = Object.freeze({
  scope: "anonymous",
  policy: "allow",
  public_skills_allowed: true,
  offline_public_fallback_allowed: true,
});

const candidate = (slug, tier) => ({
  slug,
  source: "org_overlay",
  description: `Checklist for ${slug}.`,
  result_id: `qres_${slug}`,
  match_tier: tier,
  match_reason: "Strong task coverage",
  why_matched: { lexical_signal: "strong", semantic_signal: "strong" },
  estimated_tokens: 300,
  verified_uses: 4,
  risk_level: "low",
});

export function searchBody(access, preferences) {
  return {
    query_id: "rq_hygiene",
    query_feedback: { available: true, query_id: "rq_hygiene" },
    skill_access: access,
    effective_preferences: preferences,
    skills: [
      candidate("release-checklist", "high"),
      candidate("pull-request-style", "possible"),
    ],
    resources: [],
    contribution_directive: { message: "Report whether the result helped." },
  };
}

export function effectiveBody(access, preferences) {
  return {
    definition_version: "agent-preferences-v4",
    effective_preferences: preferences,
    personalization: {
      available: false,
      reason_code: "organization_scope_only",
      retryable: false,
    },
    skill_access: access,
  };
}

// Answers the query and effective-preferences routes and records each
// request; other background calls (identity warm-up) get 404. Either route
// can fail with a status or a thrown error, and the effective route can hang
// until the hook's timeout aborts it.
export function registry({
  query,
  queryStatus = 200,
  queryThrows = null,
  effective,
  effectiveStatus = 200,
  effectiveThrows = null,
  effectiveHangs = false,
} = {}) {
  const requests = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    requests.push({
      path,
      headers: { ...(init.headers ?? {}) },
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === "/api/v1/agent/query") {
      if (queryThrows) throw queryThrows;
      return queryStatus === 200
        ? Response.json(query)
        : Response.json({ error: "unavailable" }, { status: queryStatus });
    }
    if (path === "/api/v1/agent/preferences/effective") {
      if (effectiveThrows) throw effectiveThrows;
      if (effectiveHangs) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        });
      }
      return effectiveStatus === 200
        ? Response.json(effective)
        : Response.json({ error: "unavailable" }, { status: effectiveStatus });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  const on = (route) => requests.filter((request) => request.path === route);
  return {
    fetchImpl,
    queries: () => on("/api/v1/agent/query"),
    effectives: () => on("/api/v1/agent/preferences/effective"),
  };
}

// The results block of a query context: every line that exists only because
// the search ran. What is left governs the task regardless of results.
const RESULT_LINE =
  /^(?:Trigger: |Query receipt: |HIGH MATCH|Skills:$|Resources:$|- \[|\(\+\d+ more match|No matching skill\/resource|After using Remembrance: |Delegating this task\?)/u;

export function withoutResults(context) {
  const kept = String(context ?? "")
    .split("\n")
    .filter((line) => !RESULT_LINE.test(line));
  return kept.length === 1 && kept[0] === "Remembrance auto-query context:"
    ? null
    : kept.join("\n");
}
