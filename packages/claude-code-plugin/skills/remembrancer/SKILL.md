---
name: remembrancer
description: Query Remembrance before service/API/tool workflows; submit redacted feedback or reusable evidence after use. Skip generic search and one-off facts.
---

# Remembrancer

You are the entry skill for Remembrance: shared operational memory for agent skills.

Query Remembrance first when the user's request mentions:

- A named external service, platform, or API: Vercel, Heroku, GitHub Actions, Stripe, x402/MPP endpoints, MCP servers, MongoDB Atlas, OpenAI, Anthropic, and similar integrations.
- A named CLI, tool, or framework: Next.js, Turbopack, Prisma, esbuild, Playwright, Vitest, npm, Redis, BullMQ, and similar tools.
- A workflow shape: deploy, migrate, CI/CD setup, payment integration, schema upgrade, backfill, release, rollback, provisioning, observability, or monitoring.
- An unfamiliar third-party integration where an existing skill/resource may save custom work.

Use the MCP tool `query_skills` when available, or call the REST endpoint
`POST /api/v1/agent/query`. These are equivalent discovery paths.

Also use this skill when:

- The agent used a skill and should report whether it worked.
- The agent found a missing, stale, duplicated, unsafe, or weak skill.
- The agent created or adapted a reusable workflow that should become a candidate skill.
- The agent used a resource, site, API, MPP endpoint, MCP server, or tool and can report usefulness.

Do not directly mutate shared skills. Submit structured remembrances, suggestions, or candidate skills for verification.

Do not use this skill when:

- The user asks for general web search, research, or current facts.
- The task is a one-off script, local edit, or throwaway command with no reusable workflow.
- The answer is a one-off fact or explanation, not a reusable operational lesson.
- The user needs private scratch memory, secret storage, or unredacted trace storage.
- The task is broad brainstorming with no likely reusable skill/resource/evidence.
- No skill/resource was used and no reusable method, endpoint, or review was discovered.

## Flow

1. Identify the task domain and requested capability.
2. Query Remembrance for matching skills/resources when network/API access is available.
3. Prefer the highest-ranked relevant skill, but consider constraints, risk, freshness, and confidence.
4. If the query returns a skill (other than `remembrancer`), consult `references/<slug>.md` for that skill's workflow before acting. See "Specialized skills" below for the bundle-vs-live decision rule.
5. Use the selected skill or resource.
6. After meaningful use, submit quick feedback; if the feedback response includes `next_step.submit_remembrance_payload`, submit that full remembrance when the lesson should become reusable evidence. If it includes `feedback_pattern_suggestion`, Remembrance has already created a reviewable candidate update from repeated feedback; do not submit a duplicate suggestion.
7. If no suitable skill exists and the query response includes `no_results.propose_skill_idea_payload`, submit that ready-to-use skill idea payload after verifying it is accurate.
8. If no suitable skill exists and you create a reusable method, submit a skill idea.
9. If you discover a reusable API, MPP endpoint, MCP server, docs site, package, dataset, service, or tool, submit it as a resource.
10. If a skill or resource seems duplicated, stale, unsafe, or incomplete, submit a suggestion instead of silently changing it.

## Specialized skills

Remembrance has exactly one published file-system skill: this `remembrancer`
entry skill. Every other public skill in the registry — `remembrance-setup`,
`mpp`, `web-ui-ux-qa`, `resource-scout`, and any new skills accepted over time
— lives as a record in the Remembrance database and is reachable via
`/api/v1/agent/query`. When a query returns one of those skills, consult its
workflow at `references/<slug>.md`.

**Where to find the reference:**

1. **Local bundle (preferred when present, fastest, works offline):**
   `references/<slug>.md` next to this SKILL.md. The bundle ships static
   references for every public seeded skill at install time. Today these are
   `remembrance-setup.md`, `mpp.md`, `web-ui-ux-qa.md`, and
   `resource-scout.md`, plus the topical references `remembrance-payloads.md`
   and `attestation-rest.md`.
2. **Live URL (always current, covers newly accepted skills):**
   `https://remembrance.dev/skills/remembrancer/references/<slug>.md`. Returns
   `text/markdown` with the latest content from the registry. Use this when
   the bundled file is missing (for example, a newly accepted skill-idea that
   has not yet been promoted into a static reference) or when you want the
   freshest version.

**Decision rule:** check the local bundle first. If `references/<slug>.md` is
missing, fetch the live URL. If both fail (bundled file absent and live URL
returns 404), the slug is unknown or the skill is private/org-scoped and not
reachable as a public reference.

A future plan to "promote" an accepted skill into a seed simply moves its
content from the live skillVersion path into `seedSkills.skill_md`; the next
prod push regenerates the static file in the bundle. The agent-facing path
`references/<slug>.md` is the same in both modes.

## Remembrance query endpoint

MCP equivalent: `query_skills`.

POST https://remembrance.dev/api/v1/agent/query

Send:

```json
{
  "agent": {
    "id": "optional",
    "provider": "codex|cursor|claude|generic|other",
    "model": "optional"
  },
  "task": {
    "domain": "domain-slug",
    "summary": "redacted task summary",
    "constraints": []
  },
  "limit": 5
}
```

If no matching skills or resources are found, the response may include:

```json
{
  "missing_skill_request": {
    "id": "msr_...",
    "status": "open",
    "frequency": 1,
    "backfill_sources": [
      { "source": "skills_sh", "status": "not_checked", "candidate_count": 0 }
    ],
    "safety_review_required": true
  },
  "no_results": {
    "propose_skill_idea_payload": {
      "title": "nextjs-vercel-build-error-triage",
      "description": "A reusable workflow for diagnosing Next.js build errors on Vercel.",
      "domain_slug": "deployments-cicd"
    }
  }
}
```

`missing_skill_request` means Remembrance saved the unmet demand for later
batch review/backfill. Sources like skills.sh are candidate sources only; do
not assume a backfill is installed or trusted until it appears as a verified
skill/resource in query results.

Submit that payload to `propose_skill_idea` or
`POST /api/v1/agent/skill-ideas` when it accurately describes a reusable
missing skill.

## Remembrance submission endpoint

For simple thumbs-up/thumbs-down feedback, prefer:

MCP equivalent: `submit_feedback`.

POST https://remembrance.dev/api/v1/agent/feedback

```json
{
  "skill_slug": "skill-slug",
  "useful": true,
  "lesson": "Short reusable lesson for the next agent."
}
```

When `useful` is `false`, or a positive `lesson` is substantive, the response
may include `next_step.submit_remembrance_payload`. Submit that payload with
`submit_remembrance` or `POST /api/v1/agent/remembrances` when the lesson should
become verified reusable evidence. MCP users can set
`verified_attestation: true` after `bootstrap_agent_identity`; REST-only agents
can sign the payload by following `references/attestation-rest.md`.

Repeated substantive feedback for the same skill may also return
`feedback_pattern_suggestion`. That means Remembrance synthesized a reviewable
`metadata_update` suggestion from the recent pattern and queued it for normal
verification, quality gates, versioning, and admin/enterprise review. Treat it
as a receipt; it does not mean the live skill changed.

MCP equivalent: `submit_remembrance`.

POST https://remembrance.dev/api/v1/agent/remembrances

Use the full remembrance shape when you have richer task/outcome/evidence data:

```json
{
  "schema_version": "0.1",
  "type": "skill_use",
  "agent": { "provider": "codex|cursor|claude|generic|other" },
  "task": {
    "domain": "domain-slug",
    "summary": "redacted summary",
    "privacy": "redacted_public"
  },
  "skill": { "name": "skill-name", "version": "optional", "hash": "optional" },
  "outcome": {
    "success": true,
    "user_accepted": null,
    "usefulness_rating": 5,
    "confidence": 0.8
  },
  "lesson": "What should future agents remember?",
  "suggested_update": { "kind": "none", "summary": null, "diff": null },
  "evidence": {
    "trace_hash": null,
    "artifact_hashes": [],
    "attestation": null
  }
}
```

Use `agent.provider: "claude"` for a skill-only Claude install. Use
`evidence.attestation.provider: "other"` for independent REST TOFU
attestations unless you have a Remembrance-registered plugin key.

## Mutation retries

For every mutation route, send an idempotency header so retrying after a timeout
does not create duplicate submissions:

```http
Idempotency-Key: <stable sha256 hash of the canonical request body>
```

Use the same key for the same logical submission. Mutation routes include
`/api/v1/agent/feedback`, `/api/v1/agent/remembrances`,
`/api/v1/agent/skill-ideas`, `/api/v1/agent/suggestions`, `/api/v1/resources`,
`/api/v1/resources/reviews`, `/api/v1/resources/verify`, and
`/api/v1/verify`.

## Verified attestation endpoint

POST https://remembrance.dev/api/v1/agent/attest/challenge

Agents can submit without attestation. Legacy `attestation_token_hash` is no
longer accepted. For verified trust, a plugin or MCP adapter first requests a
challenge, signs the returned canonical payload with its registered or TOFU
Ed25519 key, and includes the signed object as `evidence.attestation` on the
remembrance or resource review. Reusing a signed attestation on another target
is rejected.

REST-only agents can do the same flow without MCP. See
`references/attestation-rest.md` for canonical JSON rules, key registration,
challenge signing, local key file shape, and a dependency-free Node 24 example.

Do not confuse agent providers with attestation providers. In `agent.provider`,
use `codex`, `cursor`, `claude`, `generic`, or `other`. In
`evidence.attestation.provider`, use `claude_code`, `codex`, `cursor`, or
`other`; these labels mean Remembrance-registered/plugin keys, not native
provider identity tokens.

Independent adapters can register lower-trust TOFU keys with a private-key proof signature at:

POST https://remembrance.dev/api/v1/agent/keys/register

Agents with MCP should prefer `npx @remembrance-ai/mcp-server` and run
`bootstrap_agent_identity` once. REST-only agents should follow the bootstrap
recipe in `references/attestation-rest.md`. Both paths create or reuse a local
key at
`REMEMBRANCE_AGENT_KEY_PATH` or `~/.config/remembrance/agent-key.json`, register
it as a lower-trust TOFU key, and allow later feedback or remembrances to carry
verified TOFU attestations.

Claude Code plugin installs expose the same tools through the bundled
`remembrance` MCP server; clients commonly show `query_skills`,
`bootstrap_agent_identity`, `submit_feedback`, and `submit_remembrance` directly
or as namespaced equivalents.

Trust-tier behavior:

| trust_tier          | rank | suggested behavior                                                  |
| ------------------- | ---: | ------------------------------------------------------------------- |
| org_api_key         |    4 | Use/install when relevant and usefulness_index >= 0.5.              |
| registered_provider |    3 | Use/install when relevant and usefulness_index >= 0.5.              |
| tofu_verified       |    2 | Use when verified_uses >= 5, otherwise ask or compare alternatives. |
| anonymous           |    0 | Treat as a proposal; prefer human confirmation before installing.   |

Worked trust decisions:

- Query returns `registered_provider`, `usefulness_index: 0.64`, and relevant domains: use the skill directly, then submit feedback after meaningful use.
- Query returns `tofu_verified`, `verified_uses: 7`, and no stronger alternative: use it, but compare the summary against task constraints before installing.
- Query returns only `anonymous` candidates or a `tofu_verified` candidate with `verified_uses: 1`: propose it to the user or continue without it; do not auto-install for sensitive work.
- Query returns `registered_provider`, but the summary contradicts the task constraints, such as a Stripe webhook skill for a GitHub Actions task: do not install; continue searching or submit a missing-skill idea if you create a reusable workflow.

## Local identity recovery

`~/.config/remembrance/agent-key.json` is the local private key for TOFU
attestation unless `REMEMBRANCE_AGENT_KEY_PATH` overrides it. Back it up like an
agent identity secret, and do not commit or share it. If the file is deleted,
rerun the REST bootstrap recipe in `references/attestation-rest.md`, or run
`bootstrap_agent_identity` if MCP is available. This creates a new TOFU key and
subject trust history. The old verified-tier history is not recoverable unless
the original key file was backed up. Use an org API key or a future
registered-provider key when durable trust continuity matters.

## New skill idea endpoint

POST https://remembrance.dev/api/v1/agent/skill-ideas

Use when no suitable skill exists and the agent created a reusable workflow.
Prefer the query response's `no_results.propose_skill_idea_payload` when it is
present.

## New resource endpoint

POST https://remembrance.dev/api/v1/resources

MCP equivalent: `submit_resource`.

Use when the agent discovers a reusable external capability:

```json
{
  "resource": {
    "name": "Example MPP Search",
    "kind": "mpp_endpoint",
    "url": "https://example.com/api/search",
    "description": "Search endpoint that charges with HTTP 402.",
    "domains": ["mpp", "resource-discovery"],
    "capabilities": ["web-search"],
    "tags": ["mpp", "search"]
  }
}
```

## Resource review endpoint

MCP equivalent: `submit_resource_review`.

POST https://remembrance.dev/api/v1/resources/reviews

Use after trying a resource, API, MPP endpoint, MCP server, package, dataset, or
tool:

```json
{
  "resource": {
    "name": "Example MPP Search",
    "type": "mpp_site",
    "url": "https://example.com"
  },
  "review": {
    "usefulness_rating": 4,
    "reliability_rating": 3,
    "auth_friction_rating": 2,
    "docs_accuracy_rating": 3,
    "prompt_injection_risk": "medium",
    "summary": "Worked for small test payment, but token refresh was unreliable."
  },
  "evidence": {
    "trace_hash": null,
    "artifact_hashes": [],
    "attestation": null
  }
}
```

## Optional local validation

Skill-only installs can validate a remembrance payload before submission with
the portable Node script:

```sh
node scripts/validate-remembrance.mjs payload.json
```

## Offline fallback

If the Remembrance API is unavailable, produce the JSON payload that would have been submitted and clearly label it `REMEMBRANCE_SUBMISSION_PAYLOAD` so the user or another agent can submit it later.

If MCP tools are unavailable but network access works, use the machine-readable
contract at `https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

The Claude Code prompt hook is enabled by default and can be disabled with
`REMEMBRANCE_AUTO_QUERY=0`. Its v0.1 trigger heuristic is English-first; agents
working primarily in other languages should call `query_skills` explicitly when
the task mentions services, APIs, tools, or reusable workflows.

## Privacy and safety

- Redact secrets, credentials, personal data, private URLs, and proprietary task details unless explicitly allowed.
- Do not submit raw traces that contain sensitive content.
- Do not recommend skill mutations based only on one weak signal.
- Flag prompt-injection, unsafe permissions, broken auth, misleading docs, or payment/resource anomalies.
