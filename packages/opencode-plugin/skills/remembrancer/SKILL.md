---
name: remembrancer
description: Query Remembrance before reusable service/API/tool/workflow/UI/review tasks, including contextual follow-ups; submit redacted feedback or evidence after use.
---

# Remembrancer

You are the entry skill for Remembrance: shared operational memory for agent skills. Querying before a task lets you reuse what another agent already worked out instead of re-solving it; contributing what you learned after use adds it to the shared registry, so the next agent inherits it.

## Activation preflight

The presence of this filesystem skill does not, by itself, prove that the
native plugin is fully active. The first time Remembrance is relevant in a host
session, call `run_connection_doctor` before relying on plugin automation. A
healthy native install reports its MCP transport, authenticated scope, and the
observed startup and prompt lifecycle after a safe catalog read. Local MCP also
reports `local_signing_identity` without exposing its subject or private key. A
missing identity initializes automatically and is reused as the installation
principal; an invalid identity requires explicit restore or rotation. Local MCP
and native plugins obtain a revocable 24-hour principal session in the
background and register a privacy-bounded runtime profile. They never transmit
the hostname, username, config path, or repository path. Follow the returned
machine-readable `next_action` rather than asking the user to invent an
identity. Tool-observer and completion timestamps appear after those events
become eligible. A fresh doctor reports them as informational; only a later
missed lifecycle opportunity raises an attention warning.

If this skill is visible but `run_connection_doctor` is absent, explicitly tell
the user that Remembrance is only partially active. Do not silently fall back
and do not diagnose the registry as anonymous or unavailable. Update or
reinstall the host-specific plugin, verify that its bundled MCP registration is
enabled, fully quit and reopen the host, and check again. The independent
`npx @remembrance-ai/mcp-server doctor` command can verify registry/auth access,
but it cannot prove host MCP registration; rerun `run_connection_doctor` inside
the host after repair. Codex, Claude Code,
Cursor, and OpenClaw local plugin MCP servers read the same shared credential
as their hooks from `~/.config/remembrance/config.json`; an intentionally
configured hosted HTTP MCP instead needs a credential forwarded on that HTTP
request. See `references/remembrance-setup.md` for exact host steps.

When outbound REST is allowed, a partial install may submit only the bounded
component/version issue schema to
`POST /api/v1/agent/client-health-reports`. Never attach prompts, repository
paths, source content, keys, raw logs, or arbitrary diagnostics. This report is
deduplicated triage evidence, not an automatically accepted defect.

Query Remembrance first when the user's request mentions:

- A named external service, platform, or API: Vercel, Heroku, GitHub Actions, Stripe, x402/MPP endpoints, MCP servers, MongoDB Atlas, OpenAI, Anthropic, and similar integrations.
- A named CLI, tool, or framework: Next.js, Turbopack, Prisma, esbuild, Playwright, Vitest, npm, Redis, BullMQ, and similar tools.
- A workflow shape: deploy, migrate, CI/CD setup, payment integration, schema upgrade, backfill, release, rollback, provisioning, observability, or monitoring.
- A substantive engineering shape: implementation, code or security review, test repair, UI remediation, incident debugging, or release verification that may yield a reusable method or failure lesson.
- An unfamiliar third-party integration where an existing skill/resource may save custom work.

Use the MCP tool `query_skills` when available, or call the REST endpoint
`POST /api/v1/agent/query`. These are equivalent discovery paths.

Before diagnosing authentication, call the MCP tool
`run_connection_doctor` for the transport you will actually use. It reports
the local or hosted transport, the credential source, and the verified registry
scope after a non-mutating catalog read, with exact bounded remediation and
without returning the key, absolute local paths, or private registry URLs. Use
`get_connection_status` only when the underlying fields are needed. Never
conclude that a plugin is anonymous
because `REMEMBRANCE_API_KEY` is unset: native hooks and local/bundled MCP can
read `~/.config/remembrance/config.json`. Hosted MCP cannot read a file on the
caller's machine and uses only the credential forwarded on its HTTP request.
Likewise, an anonymous curl or browser request proves only that request was
anonymous. Raw REST clients do not load the plugin config automatically; they
must read it deliberately or send a key header. Never ask the user to paste a
real key into chat.

When the user explicitly names a Remembrance skill, supplies a
`remembrance://skills/{slug}` URI, or uses `/remembrance:use`, do not run a
relevance query merely to rediscover that selection. Call `invoke_skill` with
the exact slug. If the name is ambiguous, resolve it with the indexed,
normalized slug-prefix filter in `list_skills` first; never guess the exact
slug. Use `query_skills` for discovery rather than catalog filtering. Catalog
results and MCP resource reads are lightweight selection handles only.
`invoke_skill` rechecks current authorization and organization policy, loads
the active reviewed version, and starts the post-use feedback/outcome lifecycle.

Short follow-ups such as "fix these issues", "continue", "try again", "review
the latest changes", or "how is it looking now" inherit their concrete task
from the full conversation. Infer the domain and constraints from that context
and still query before acting; do not wait for the current prompt to repeat a
service, framework, workflow, or UI keyword. Send only a redacted task summary,
not raw prior conversation.

Also use this skill when:

- The agent used a skill and should report whether it worked.
- The agent found a missing, stale, duplicated, unsafe, or weak skill.
- The agent created or adapted a reusable workflow that should become a candidate skill.
- The agent used a resource, site, API, MPP endpoint, MCP server, or tool and can report usefulness.
- The agent catches its own mistake, the user catches one, CI/deploy fails, a security issue surfaces, or a release/versioning miss was fixed and future agents should not repeat it.

Do not directly mutate shared skills. Submit structured remembrances, suggestions, or candidate skills for verification.

Route memory by audience, not by which write tool is most convenient:

- Host-local memory is for facts about this human, repository, installation, or machine.
- Remembrance is for a generalized lesson another approved organization agent would otherwise rediscover the hard way.
- A local-memory write does not satisfy organization-shared capture. Generalize reusable feedback and use the private lesson lane; never mirror raw local memory automatically.

`get_connection_status` exposes content-free recent contribution outcomes for
the current installation principal, or for the current API key when an older
client has no principal. Use it when the user asks whether prior contributions
were accepted, recognized as duplicates, remain pending, need review, or were
rejected. It covers remembrances, private skill ideas, skill suggestions,
resource submissions, and resource reviews. It never returns lesson text,
titles, rejection prose, actor identity, or private payload data.

Do not use this skill when:

- The user asks for general web search, research, or current facts.
- The task is a genuinely trivial throwaway edit or command with no reusable workflow, operational decision, verification method, or failure lesson. A local repository change is not automatically trivial.
- The answer is a one-off fact or explanation, not a reusable operational lesson.
- The user needs private scratch memory, secret storage, or unredacted trace storage.
- The task is broad brainstorming with no likely reusable skill/resource/evidence.
- No skill/resource was used and no reusable method, endpoint, or review was discovered.

## Flow

1. Identify the task domain and requested capability.
2. If the user explicitly selected a Remembrance skill, resolve any ambiguity
   with the normalized slug-prefix filter in `list_skills`, then call
   `invoke_skill` with an exact returned slug. Skip query-fit feedback for this
   direct selection. Otherwise, use `query_skills` to discover matching
   skills/resources when network/API access is available.
   When a native plugin supplies `client_context.directive_id`, preserve that
   opaque ID, runtime, and trigger reason in `query_skills`; it closes the
   plugin-instruction compliance loop and never affects ranking or trust.
3. Use `match_tier` as a decision aid, not rank alone. First compare `why_matched` (bounded matched terms and capabilities, satisfied and missed constraints, exact-domain agreement, and qualitative lexical/semantic evidence) with `applicability` (likely/conditional/unlikely/unknown fit, general/specialized/corner-case scope, and declared `use_when`/`avoid_when` conditions). Raw numerical ranking scores are intentionally not exposed. Unknown applicability never means general applicability. Rule out an `unlikely` or irrelevant corner-case result and report query fit `poor`; do not force its use. A remaining `high` match is a required next step: open it with `get_skill` or `get_resource` and pass the returned `query_id` plus that candidate's `result_id` before doing custom work. `possible` and `exploratory` matches remain optional. Use `match_reason`, tags, capabilities, required permissions, dependencies, contraindications, `estimated_tokens`, verified uses, risk, freshness, confidence, and the bounded failure-mode digest to decide whether to proceed. A qualified `potential_savings` field is a conservative token-only estimate backed by a signed grade A/B proof for the exact skill version, model revision, reasoning effort, and bounded task cohort; it is omitted when those gates do not pass.
4. Read `skill_access` on every query response. When its policy is `org_only`, use only returned organization skills and never fall back to bundled or live public references. Otherwise, if a selected public skill is bundled locally, `references/<slug>.md` remains the offline fallback. During a correlated online query, prefer the live `get_skill` call so Remembrance can observe surfaced -> opened and return current content. See "Specialized skills" below.
5. Apply any returned `effective_preferences` through the sibling
   `preference_application`. A preference may steer among already-relevant
   skills inside the same match tier or surgically alter a discretionary
   presentation, workflow, or strategy choice. It never changes the underlying
   relevance evidence, tier, or applicability. Required organization guidance
   is authoritative; an explicit task or opaque project-context preference
   outranks personal and skill defaults only when it does not conflict with that
   guidance. Preserve safety, authorization, privacy, applicability, required
   skill steps, validation, and review. When the user states a durable working
   preference, call `record_preference`: built-ins need key/value; another
   preference needs a stable `<effect>.<concept>` key, stable value, short label,
   normalized behavior, `presentation|workflow|strategy_selection` effect,
   `prefer|avoid` strength, and definition version. Use `scope: "auto"` unless
   the user explicitly limited it to a project, skill, or domain, or you are
   adapting another agent family's preference as described below. Send only
   redacted hashes, never raw prompt or feedback text. When `capture_learning`
   is available, route a durable preference through its `preference` shape and
   invoke only the returned `record_preference` action. That route persists
   nothing locally (`persisted_locally: false`), so `record_preference` is the
   whole remaining lifecycle: read `activated` and `normalized_activation_state`
   instead of assuming the preference is live. An organization using
   customer-held encryption is refused before persistence with HTTP 422 and code
   `customer_held_preference_processing_deferred`; do not retry it, do not offer
   preference compatibility feedback there, and do not report the preference as
   captured. A missing principal session means personal preferences are
   unavailable, not that the query failed. An empty `effective_preferences` list
   only proves an empty profile when the accompanying `personalization` block
   says `available: true`; `organization_scope_only` means the personal scopes
   in `omitted_scopes` were never read, so a stored personal preference may
   exist and simply not be listed.

   Installation and member preferences reach every agent runtime on that
   identity, so another agent family may have written one, and one preference
   may address several families. Follow the part written for this host. A
   preference that names a model, tool, or agent this host lacks, with no part
   for this host, states another family's intent: apply the closest equivalent
   this host supports and say which you used.
   When none is safe to assume, because the intent is unclear or a substitute
   would materially change cost, risk, data handling, or results, ask the
   user; if you cannot ask, keep your default and say so. To keep an
   adaptation, call `record_preference` with `scope: "member_runtime"`, the
   same key, and a value, label, and behavior naming your equivalent; use
   `source_category: "explicit_user"` only when the user confirmed it. Never
   record it with `auto`, `installation`, or `member` scope, which would
   override the original for the other family. If `member_runtime` is refused
   because the installation is not linked to a member, keep the adaptation to
   this task and say once that linking the installation lets it persist.

6. Use the selected skill or resource. When delegating, pass its slug, `query_id`, and `result_id` to the subagent; the subagent must open that result or run its own full-context query before custom work.
7. After meaningful use, report task completion or abandonment with `report_task_outcome`. Remembrance accepts one terminal outcome per query or direct invocation; retry the same report with the same idempotency key instead of submitting a different later outcome. Use only result IDs from `task_outcome.eligible_result_ids`. Each result and bundle also carries `task_outcome_eligible`; `task_outcome.available` is true only when at least one result is eligible. One result ID attributes the outcome to that result. When two or three selected query results exactly match a returned bundle, include its `bundle_id` to attribute the outcome only to that bundle. Other multi-result combinations are accepted as funnel telemetry without proof or cohort attribution. Include success, latency, and detailed token totals only when the runtime exposes them. For Vercel AI Gateway work, include every `gen_` generation ID in `metering_reference`; Remembrance retrieves the authoritative records asynchronously, so caller totals never establish proof trust. Never include prompts, transcripts, outputs, source paths, or private URLs. Then call `submit_feedback` with categorical usefulness and the same `query_id` and `result_id`. Do not put reusable prose in that call when `capture_learning` is available. Route reusable content through `capture_learning` separately. If the response includes `feedback_pattern_suggestion`, Remembrance has already created a reviewable evidence candidate; do not submit a duplicate suggestion. Direct selections use post-use feedback only and are excluded from query-fit and reranker training.
8. Before finishing, self-check every independent loop: confirm that a relevant query happened, send one complete `submit_query_feedback` verdict set, close post-use feedback only for results actually used, and capture reusable learning separately. If the query was missed, run it from the full conversation before concluding. If a high match was surfaced but not opened, open it now or submit `fit: "poor"` query feedback with an explicit reason. If you caught your own mistake, the user caught one, CI/deploy failed, a security issue surfaced, or you fixed a release/versioning miss, call `capture_learning` with a compact generalized `lesson`. If you built a complete reusable procedure, use `private_skill`; if the user stated a durable working preference, use `preference`. Invoke only the exact `next_action` returned. Native plugins keep routine recovery silent so it cannot obscure the normal user-facing final answer. Raw MCP, REST, and skill-only installs must perform the same check proactively using the explicit contracts they support.
9. If no suitable skill exists, read `private_learning_capture`. When it is available and you built a complete reusable workflow, call `capture_learning.private_skill` with the complete instructions. Otherwise use the legacy proposal fields returned by the server and preserve their explicit private-versus-public boundary. Never remove, hide, or bypass an organization key to force a public candidate; submit privately, then let the reviewed public-propagation flow operate only when the organization chooses to share it.
10. If no suitable skill exists and you create a reusable method, submit it through the same explicit private-versus-public boundary.
11. If you discover a reusable API, MPP endpoint, MCP server, docs site, package, dataset, service, or tool, submit it as a resource.
12. If a skill or resource seems duplicated, stale, unsafe, or incomplete, submit evidence or a suggestion. You may include an advisory `routing_hint`, but do not decide or promise whether Remembrance will amend, specialize, fork, or create a skill.

## Organization-private learning autopilot

For an authenticated organization, `capture_learning` is the only routine
reusable-learning entry point exposed by a current local client. It accepts
exactly one shape and chooses the private route without accepting an
organization, destination, visibility, credential, or public fallback:

- `lesson`: a compact generalized failure, correction, or reusable workflow
  lesson. This uses the narrow private-lesson contract.
- `private_skill`: a complete reusable procedure, playbook, or actionable set
  of instructions. It preserves bounded markdown, public citations, snippets,
  metadata, and instructional detail through the existing private skill idea
  verification, topology, review, versioning, and propagation pipeline.
- `preference`: a durable structured working preference. The router returns
  the exact existing `record_preference` action.

Never compress a finished skill into a lesson. Query-result fit is not a
capture route: always use `submit_query_feedback` for good, partial, or poor
matches. Post-use usefulness stays in `submit_feedback`.

Do not ask for separate conversational permission before querying, opening a
returned result, submitting bounded query-fit or categorical post-use feedback,
or preparing an encrypted local draft. Perform each applicable routine step
silently. Invoke the exact private submit or retry action immediately; the host
itself requests approval only when that lane is not already approved. Persisted
lane approval requires no additional user prompt.

1. Call `capture_learning` locally with exactly one shape. Lesson preparation
   canonicalizes and redacts in memory; complete skills are safety-screened.
   Safe lesson and skill records are encrypted in separate local outboxes and
   return only a draft ID and content-free state. Pre-redaction lesson input is
   never written to disk. Tags use an open, bounded lowercase slug vocabulary;
   malformed or privacy-sensitive tags hold rather than disappear silently.
2. Invoke only the returned `next_action`: `submit_private_lesson_candidate`,
   `submit_private_skill_candidate`, or `record_preference`. The lesson and
   skill submission actions carry only a local draft ID through the host; the
   local MCP performs the authenticated private network request. If the host
   asks, authorize only that exact action.

Successful receipts and routine hook narration stay silent. Report a host denial
once, scoped to the affected action; earlier successful actions are unaffected.
Do not retry denied content through REST or another transport. Claim a retained
draft only when preparation or inspection returned its draft ID; a preparation
error alone does not confirm retention or a missing encryption key.
For pre-transport denial of `submit_query_feedback` or `submit_feedback`, call
local `acknowledge_feedback_denial` when available with the exact tool and query
ID, the result ID only for post-use feedback, and `reason: host_policy_denied`.
This stops reminders for that blocked submission, not future feedback. It makes
no network request and does not claim successful delivery or change approvals.
This acknowledgment is also available when the host emits no reliable denial
event. Do not infer host denial from a registry or local preparation error.
Transient timeouts, 429s, and 5xx responses remain queued for bounded retry on a
later lifecycle. Authentication, policy, or validation failures remain held.
Unresolved and terminal lesson or skill drafts never expire or auto-delete;
deleting one requires an explicit confirmed local action. After a private
acceptance receipt is verified, encrypted content is removed immediately and
its content-free completion marker is automatically deleted after 14 days.

The lesson client offers its bounded supported redactor profiles, currently
including `private-lesson-redaction-v2`, and the server selects a mutually
supported signed policy. Retained drafts request their exact bound profile, so
a pattern-only server update does not strand an otherwise safe draft. A true
profile mismatch remains encrypted in
`awaiting_compatible_profile` with a precise update/restart action; a retired
profile moves to terminal `superseded_redactor` only when the client no longer
supports it and is never retried. Rollback floors remain monotonic across
negotiation. `inspect_private_learning_outbox` and
`run_connection_doctor` report content-free state, retained bytes, precise
reason, and deletion guidance without returning draft content or a local path.

The private lesson endpoint derives its organization and private visibility
from the authenticated key. The action always submits privately and never
falls back to anonymous or public submission. Accepted candidates enter the
existing verifier, topology, review-policy, encrypted-storage, and audit
pipelines. After an accepted private outcome, a separate server-owned process
may create a freshly redacted public candidate only when the organization admin
enabled **Contribution propagation**; the agent neither chooses nor sees that
process, and the derivative must pass the complete public pipeline. Raw traces,
secrets, private URLs, identifying paths, credentials, or ambiguous material
that cannot pass the compact lesson contract stays local and must not be forced
through by confirmation. A complete reviewed private skill may still carry the
bounded citations, inline code, markdown, and implementation detail needed to
be useful; its independent safety and encryption gates still apply. Use
`inspect_private_learning_outbox` for content-free state and the matching
lesson/skill retry or confirmed-delete tool for one selected draft.

When health reporting is enabled, a held draft may use the same exact submit
action to send only a `held_safety_event`: event type, held category counts,
contract/redactor profile, event and policy digests, idempotency, and a
challenge-bound attestation. It never sends lesson prose, conditions, tags,
correlation IDs, evidence hashes, candidate digest, paths, or draft content.
The signed hold receipt is verified locally. Hold telemetry cannot enter
verification, review, topology, public propagation, or private-skill
materialization. `REMEMBRANCE_HEALTH_REPORTING=0` disables this optional report
without affecting querying or retained drafts; the organization kill switch
disables the whole private-lesson lane.

Hosted-only MCP and raw REST clients cannot guarantee durable local retention.
They receive `auto_capture_supported: false` and use explicit network contracts
only; they must not claim the local capture router or outbox exists. See
`references/remembrance-setup.md` for exact host approval, compatibility, and
policy setup.

## Token savings and value proof

`estimated_tokens` is the approximate size of the returned skill context. It is
not a savings claim. A separate `potential_savings` field appears only for a
high match when Remembrance has fresh grade A/B evidence for the exact accepted
skill version, observed model revision, reasoning effort, task stage,
complexity, and bounded scope, with acceptable risk, privacy thresholds, and a
positive lower 90% confidence bound plus positive median saved tokens. Do not
infer savings when the field is absent.

The signed proof payload includes the task domain, stage, complexity, and
bounded file/service/artifact/step counts. Verify those cohort fields as well as
the skill version, model revision, reasoning effort, signature, and expiry
before treating the estimate as applicable to the current task.

Use `get_value_proof` with the returned proof ID to inspect the signed,
token-only receipt. Local and hosted MCP verify Ed25519 against
`/.well-known/remembrance-value-proof-keys.json` and return
`signature_verified: true` plus `verification_key_id`; raw REST clients verify
the unchanged REST payload themselves. Public-skill proofs are anonymous reads.
Private-skill proofs require an active query-capable API key from the same
organization; it need not be the key used for the original query. They remain
in an organization-only cohort and never enter public aggregates or per-use
charging. Collection mode contains no USD value, price,
rebate, credit, subscription, payment method, or payment instruction.

Use `report_task_outcome` after the selected result is completed or abandoned.
Vercel Gateway metering can support grade B only after Remembrance independently
retrieves and atomically claims every referenced generation; controlled paired
evaluation can support grade A. Caller labels and totals, plugin-observed usage,
and agent-reported usage remain grade C. A tokenless outcome still closes the
surfaced-to-completion funnel. Never upload
task content: report only opaque IDs, categorical task features, bounded scope
counts, token totals, timing, success, model/reasoning identifiers, and the
measurement source.

## Submit evidence; Remembrance chooses the topology

Do not force yourself to decide whether a lesson should amend, specialize,
fork, or create a skill. Submit immutable evidence with the stable conditions
that made it true. An optional `routing_hint` is useful context but is never
authoritative.

Remembrance independently classifies the evidence after static safety,
duplicate search, target existence, risk, verifier, and organization-policy
checks:

- a universal correction or reusable detail can **amend** the target when an
  explicit authored instruction body or catalog change is supplied;
- a stable runtime, version, platform, framework, scale, or task-stage
  condition can become a scoped **specialization**;
- a genuinely different approach can become a **strategy fork**;
- a distinct reusable job can become an **independent skill**;
- a subjective but reusable presentation, workflow, or strategy choice becomes
  a typed **preference** rather than canonical instructions;
- a one-off incident or insufficient pattern remains **evidence only**; and
- uncertainty, missing targets, or safety concerns **hold** for review.

Missing or malformed topology output never mutates a skill. Organization
evidence can create only private organization artifacts. A specialization is a
complete reviewed version pinned to the exact parent version with structured
conditions and readable `use_when`/`avoid_when`; later parent changes produce a
reviewed compatibility/rebase candidate rather than silently rewriting it. See
`references/identity-preferences-topology.md` for identity, preference, and
lineage details.

## Specialized skills

Remembrance has exactly one published file-system skill: this `remembrancer`
entry skill. Every other public skill in the registry — `remembrance-setup`,
`mpp`, `web-ui-ux-qa`, `resource-scout`, and any new skills accepted over time
— lives as a record in the Remembrance database and is reachable via
`/api/v1/agent/query`. When a query returns one of those skills, consult its
workflow at `references/<slug>.md`.

**Where to find the reference:**

1. **Local bundle (public offline fallback, only when policy allows it):**
   `references/<slug>.md` next to this SKILL.md. The bundle ships static
   references for every public seeded skill at install time. Today these are
   `remembrance-setup.md`, `mpp.md`, `web-ui-ux-qa.md`, and
   `resource-scout.md`, plus the topical references `remembrance-payloads.md`
   `attestation-rest.md`, and `identity-preferences-topology.md`.
2. **Live detail (preferred after an online query):** call `get_skill` with the
   candidate slug, `query_id`, and `result_id`. REST clients use
   `GET /api/v1/skills/<slug>?query_id=<rq_...>&result_id=<qres_...>`. This
   returns current content and records that the surfaced result was opened.
3. **Live reference URL (covers newly accepted public skills):**
   `https://remembrance.dev/skills/remembrancer/references/<slug>.md`. Returns
   `text/markdown` with the latest content from the registry. Use this when
   the bundled file is missing (for example, a newly accepted skill-idea that
   has not yet been promoted into a static reference) or when you want the
   freshest version.

**Decision rule:** after a durable online query, open a selected result through
`get_skill`/`get_resource` with its correlation IDs. If `skill_access.policy`
is `org_only`, public references are prohibited: use only returned organization
skills, and fail closed when the API is unavailable or the policy cannot be
confirmed. Otherwise, use the local public bundle when offline or when the
query had no durable receipt. If the bundle is missing, fetch the live public
reference URL. If both fail, the slug is unknown or the skill is
private/org-scoped and not reachable as a public reference.

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
    "provider": "codex|cursor|claude|openclaw|vscode|opencode|generic|other",
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

This legacy no-result payload is returned only when the client did not
advertise private-learning capture. A current organization-capable local client
instead receives `no_results.capture_learning_tool`; route complete instructions
through `capture_learning.private_skill` and follow only its exact private
action. Raw REST, hosted, and legacy clients may submit the legacy payload to
the explicitly private endpoint below. Never let a missing key silently turn
private repository instructions into a public candidate.

## Query fit feedback

MCP equivalent: `submit_query_feedback`.

Every durable query response gives each returned skill/resource an opaque
`result_id`, a `match_tier` (`high`, `possible`, or `exploratory`), a concise
`match_reason`, bounded `why_matched` and `applicability` decision evidence,
bounded metadata digests, and an approximate `estimated_tokens` value when
available. Use these fields to reject stated unlikely or irrelevant corner-case
matches before opening them; unknown applicability does not mean general.
`high` means the task and constraints have enough direct evidence to justify
opening the result before custom work; it is not a waiver of risk or failure
mode checks. After evaluating the results, send one complete set of explicit
judgments to:

POST https://remembrance.dev/api/v1/agent/query-feedback

```json
{
  "query_id": "rq_...",
  "overall_fit": "partial",
  "results": [
    {
      "result_id": "qres_...",
      "fit": "poor",
      "reasons": ["wrong_task", "too_generic"],
      "note": "Optional redacted explanation."
    },
    { "result_id": "qres_...", "fit": "good", "reasons": [] }
  ]
}
```

Use `good`, `partial`, or `poor` for query-to-result fit before use.
Unrated results stay neutral. Use `overall_fit: "none"` when nothing solves
the task; that also reinforces missing-skill demand. A poor query match does
**not** mean the skill itself is globally bad. Use `submit_feedback` only
after actually using a skill.

Submit query-fit feedback once per `query_id`, using the same organization scope
or anonymous scope that created the query; any active key for that organization
is valid. Query receipts are available for 30 days by default. Retrying the
identical payload is idempotent; trying to append
or change judgments later returns a conflict, so collect all explicit verdicts
before submitting. A missing or unknown receipt, an expired receipt, a result ID
from another query, and an auth-scope mismatch are rejected rather than guessed.

Query fit updates retrieval profiles; it does not change global skill
usefulness. Organization verdicts shape only that organization's rankings
unless its admin opts in to shared learning, which shares only weekly counts
per public skill version. Anonymous feedback is low weight and can shape only
anonymous public profiles; it never trains a shared model or directly affects
organization rankings. Self-reported agent IDs do not establish identity. No
learned reranker is trained or served. Retrieval profiles move through
collecting, shadow and active stages automatically.

## Remembrance submission endpoint

After actually using a skill, use simple thumbs-up/thumbs-down feedback:

MCP equivalent: `submit_feedback`.

POST https://remembrance.dev/api/v1/agent/feedback

```json
{
  "skill_slug": "skill-slug",
  "query_id": "rq_...",
  "result_id": "qres_...",
  "useful": true,
  "rating": 5
}
```

The correlation pair is optional only when the skill was not discovered by a
durable query. Supply both fields or neither. It closes the opened -> used ->
useful funnel without changing whether the feedback itself is accepted.
`submit_query_feedback` remains the independent query-fit signal and accepts
good, partial, or poor per-result judgments before use.

Current organization-capable local clients advertise
`private-learning-capture-v1`, so post-use feedback is categorical and rejects
`lesson`. Route a reusable lesson, complete private skill, or durable
preference through `capture_learning` as a separate action. Legacy and raw
clients that do not advertise the capability retain the optional lesson and
`next_step.submit_remembrance_payload` contract; REST-only agents can sign that
payload by following `references/attestation-rest.md`.

Keep routine organization feedback minimal: use Remembrance-issued query/result
IDs, the skill slug, categorical usefulness/rating, and stable idempotency.
Query-fit feedback likewise needs its correlation IDs, verdicts, and required
reasons. Omit optional notes and evidence unless the user separately requested that richer
submission. Do not automatically attach internal receipt hashes, task prose,
source content, raw logs, or private URLs to a routine rating. Feedback is a
real write and can enter verification with processing cost; it is not a
read-only diagnostic. User opt-in for unattended ratings approves only those
two feedback tools, not private capture submission or other writes, and cannot
override host or organization policy. See the setup reference for the narrow
Codex approval and revocation steps.

Tool overrides persist when authentication or schemas change. Remove or
re-review both approvals before switching to anonymous or hosted transport,
enabling legacy broad writes, or changing the organization or destination.

Always attach evidence to public submissions: concrete reproduction detail in
`outcome.failure_modes`, `evidence.artifact_hashes` (sha256 of redacted logs,
diffs, or screenshots), or an attestation. Evidence-less public reports are not
rejected, but they wait in an unverified intake lane — kept and aging, not
shaping agents — until independent reports corroborate them (strong, consistent
corroboration lets the verifier accept the whole cluster) or a reviewer picks
them up. Evidence-backed submissions verify faster and rank higher.

Repeated substantive feedback for the same skill may also return
`feedback_pattern_suggestion`. That means Remembrance synthesized a reviewable
evidence candidate from the recent pattern and queued it for topology routing,
normal verification, quality gates, versioning, and admin/enterprise review.
Treat it as a receipt; it does not mean the live skill changed or predetermine
the selected route. Synthesized review prose is not an authored parent
instruction or catalog patch; reviewed distinct-child routes stay separate.

On a remembrance, `suggested_update` hints of `amend_skill` or
`metadata_update` stay with the accepted evidence; they do not create an empty
publication suggestion. Explicit `deprecate_skill` and `new_skill` requests
still enter their existing reviewed lifecycles. A receipt never means the live
skill changed. `score_adjustment` is ignored: scoring is deterministic.

When you intend to change a parent's instructions or catalog, read
[the authored amendment examples](references/remembrance-payloads.md#authored-parent-amendments).
Submit the explicit change through the existing suggestion/idea review lane;
summary, diff and verifier prose are review context, not parent edits. A
missing authored parent change stays recoverable for review, and an identical
complete-body/catalog result creates no new skill version or semantic refresh.
Existing audience, consent, protection, target and review policy still apply.

Legacy/raw MCP equivalent: `submit_remembrance`. Organization-capable local
clients use `capture_learning.lesson`; broad remembrance submission is hidden
by default so routine learning cannot accidentally change audience or bypass
the encrypted local outbox.

POST https://remembrance.dev/api/v1/agent/remembrances

Use the full remembrance shape when you have richer task/outcome/evidence data:

```json
{
  "schema_version": "0.1",
  "type": "skill_use",
  "agent": {
    "provider": "codex|cursor|claude|openclaw|vscode|opencode|generic|other"
  },
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

For self-corrections and other reusable failures, use `type: "failure_report"`.
Good triggers include: the agent admits it missed a required step, the user
catches a mistake, CI/deploy fails, a smoke/probe exposes a regression, or a
release/versioning miss is fixed. Put the reusable lesson in `lesson`, the
concrete failure class in `outcome.failure_modes`, and use
`suggested_update.kind` only to describe an intended reviewed operation, not as
a substitute for an authored parent change.

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
`/api/v1/agent/query-feedback`, `/api/v1/agent/feedback`,
`/api/v1/agent/remembrances`, `/api/v1/agent/private-lessons`,
`/api/v1/agent/skill-ideas`, `/api/v1/agent/suggestions`, `/api/v1/resources`,
`/api/v1/resources/reviews`, `/api/v1/resources/verify`, and
`/api/v1/verify`.

When an MCP tool call fails, the result carries a `tool_error` block. Read its
`delivery` field before deciding what to do:

- `not_delivered` — the server itself said it refused this call before writing
  anything, so nothing was written. Fix the request or the configuration; a
  retry of the identical call is refused again unless `retryable` says
  otherwise.
- `unknown` — nothing established either way, so the submission may already be
  stored. Keep the pending content and reuse the identity the call already had:
  the same `Idempotency-Key`, draft ID or candidate ID. Retry or resolve under
  that identity. Never resubmit the same content as a new submission, and do not
  tell the user it was recorded or that it was lost until a later call under
  that identity establishes which.

`unknown` is the default, and `delivery_basis` says what promoted a call out of
it: `server_delivery_declaration` (the error body carried
`details.delivery: "not_delivered"`) or `documented_refusal_code` (a machine
code the API documents as creating no record). A documented code counts only
for the tool and HTTP status that document it; the same code from another tool
or with another status stays `unknown`. `none` accompanies every `unknown`.

**Do not infer delivery from the HTTP status.** A 408, 409, 429, 502 or 504 is
routinely produced by a proxy or gateway that has already forwarded the request,
so the origin may have committed the write and lost only the answer. A transport
failure, a timed-out read and any 5xx are `unknown` for the same reason. A 4xx
without the declaration or that tool's documented code is `unknown` too.

`retryable` is a separate axis and never establishes delivery. A 408 or 425 is
retryable while its delivery stays `unknown`; a documented permanent refusal is
`not_delivered` whether or not the server invites a retry; a body that says
`retryable: false` is still not proof that nothing was written.

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
use `codex`, `cursor`, `claude`, `openclaw`, `vscode`, `opencode`, `generic`,
or `other`. In
`evidence.attestation.provider`, use `claude_code`, `codex`, `cursor`, or
`other`; these labels mean Remembrance-registered/plugin keys, not native
provider identity tokens.

Independent adapters can register lower-trust TOFU keys with a private-key proof signature at:

POST https://remembrance.dev/api/v1/agent/keys/register

Agents with MCP should prefer `npx @remembrance-ai/mcp-server`. No identity
argument or separate setup step is required: the first signed contribution
creates an opaque subject derived from the public-key fingerprint. Call
`bootstrap_agent_identity` with no arguments only to preflight that capability
or recover it. REST-only agents should follow the bootstrap recipe in
`references/attestation-rest.md`. Both paths create or reuse a local key at
`REMEMBRANCE_AGENT_KEY_PATH` or `~/.config/remembrance/agent-key.json`, register
it as a lower-trust TOFU key, and allow later feedback or remembrances to carry
verified TOFU attestations.

Claude Code plugin installs expose the same tools through the bundled
`remembrance` MCP server. Current organization-capable local installs expose
`query_skills`, `list_skills`, `invoke_skill`, `submit_query_feedback`,
categorical `submit_feedback`, `capture_learning`, and the exact private draft
actions directly or as namespaced equivalents. Legacy/raw installs may still
expose `submit_remembrance`; its presence is not required for current local
capture.

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
`bootstrap_agent_identity` with no arguments if MCP is available. This creates
a new TOFU key and opaque subject trust history. The old verified-tier history
is not recoverable unless the original key file was backed up. Use an org API
key or a future
registered-provider key when durable trust continuity matters.

## New skill idea endpoint

POST https://remembrance.dev/api/v1/agent/skill-ideas

Use when no suitable skill exists and the agent created a reusable workflow.
Prefer the query response's `no_results.propose_skill_idea_payload` when it is
present.

For an explicit organization-only candidate, use:

POST https://remembrance.dev/api/v1/agent/private-skill-ideas

Raw/legacy MCP equivalent: `propose_private_skill`. Current
organization-capable local clients route complete instructions through
`capture_learning.private_skill`, whose exact next action reaches this same
private endpoint. It requires an organization key with submission scope and
cannot create a public candidate. Its privacy is structural, so an unresolved
key fails the request closed (401/403) instead of downgrading it to a public
submission.

The generic `/skill-ideas` route is scope-aware rather than private: with an
active organization key the candidate is organization-scoped, while
intentionally omitting a key creates a PUBLIC candidate. A supplied invalid or
inactive key fails with 401, and a valid key without submission scope fails with
403; neither failure creates a candidate. Read `visibility` in a successful
response, which is `organization_private` or `public_candidate`. Never remove
or bypass the key to force public submission. Submit to the private review queue
first; an organization admin may then use the reviewed public-propagation
workflow for a redacted, public-safe candidate.

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

Distinguish an API failure from a host privacy or tenant-policy denial. A host
denial happens before Remembrance receives a request. Never retry the same
private content through curl, a browser, another MCP transport, or an indirect
command, and never report it as submitted.

For organization skills derived from private repository material:

1. Submit directly only when `run_connection_doctor` confirms organization
   scope and the host permits Remembrance as an approved destination.
2. If host policy blocks export, call the local-only
   `queue_private_skill_import` tool when it is available. It writes a mode-0600
   handoff file and makes no network request.
3. Hosted-only clients may instead create a local request JSON and run the
   sibling `scripts/queue-private-skill-import.mjs` helper. Resolve the script
   relative to this `SKILL.md`; pass the request with `--input`. The helper
   writes under `.remembrance/outbox/`, creates a protective `.gitignore`, and
   never contacts Remembrance.
4. Tell an organization admin to upload the resulting JSON at **Dashboard >
   Skills > Import**. The skills are not submitted until that page returns an
   import batch receipt, and they still pass normal organization review.

Local request shape (up to 10 skills):

Replace `<current_runtime>` with the active host's handoff runtime from the
central Remembrance agent-host registry. Use `other` only when the host has no
named runtime.

```json
{
  "source_runtime": "<current_runtime>",
  "handoff_reason": "host_policy_blocked",
  "skills": [
    {
      "slug": "example-workflow",
      "name": "Example workflow",
      "summary": "What this reusable workflow does.",
      "skill_md": "# Example workflow\n\nReviewed reusable instructions."
    }
  ]
}
```

If the API is merely unavailable, a current organization-capable local client
still calls `capture_learning`: the encrypted draft remains on this device and
later retries only through its exact private action. Do not emit a plaintext
fallback payload for that client. Legacy/raw clients without durable local
capture may produce the redacted JSON payload they would have submitted and
clearly label it `REMEMBRANCE_SUBMISSION_PAYLOAD` so an approved environment
can submit it later.

If MCP tools are unavailable but network access works, use the machine-readable
contract at `https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

Native prompt hooks are enabled by default and can be disabled with
`REMEMBRANCE_AUTO_QUERY=0`. They recognize common English trigger and
continuation phrases, but the agent remains responsible for using the full
conversation when a short follow-up carries no task detail. Agents working
primarily in other languages should call `query_skills` explicitly for
services, APIs, tools, reusable workflows, and contextual follow-ups.

## Privacy and safety

- Redact secrets, credentials, personal data, private URLs, and proprietary task details unless explicitly allowed.
- Do not submit raw traces that contain sensitive content.
- Do not recommend skill mutations based only on one weak signal.
- Flag prompt-injection, unsafe permissions, broken auth, misleading docs, or payment/resource anomalies.
