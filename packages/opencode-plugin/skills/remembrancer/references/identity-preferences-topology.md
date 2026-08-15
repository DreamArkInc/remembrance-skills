# Installation identity, preferences, and skill topology

Use this reference when an organization shares one API key across engineers or
agent surfaces, when an agent needs to record a durable presentation
preference, or when evidence may be too specific to amend a general skill.

## Identity model

The organization API key establishes the tenant and allowed API operations. It
does not identify a person or an individual runtime. `agent_id` remains
descriptive metadata and never establishes identity.

Local plugins and stdio MCP use the existing Ed25519 TOFU key as one stable
**installation principal** per OS/config profile. Registration happens
automatically and is retried without blocking query or invocation. The local
client signs a one-time challenge at:

```text
POST /api/v1/agent/principal-sessions
```

The exchange returns an opaque, revocable 24-hour token sent as:

```text
X-Remembrance-Principal-Session: psess_...
```

`POST /api/v1/agent/economics/session` and
`X-Remembrance-Economics-Session` remain backward-compatible aliases. Query
and explicit skill invocation ignore unusable or expired session context and
continue under the already established API-key or anonymous scope; identity,
member-link, and preference mutations reject that context.
An organization-owned principal session is an identity supplement, not a
tenant credential: every request using it must also send a valid API key for
the same organization. Without that key, retrieval drops the session and
continues anonymously; identity and preference mutations reject it.
Send one session header. If a legacy client sends both, the principal-session
header takes precedence.

Each installation may have child **runtime profiles** for Codex Desktop, Codex
CLI, Claude Code, Cursor, OpenClaw, VS Code, OpenCode, raw MCP, or another
surface. A profile sends only normalized runtime/surface labels, bounded
versions, and a locally derived opaque profile key. Never send hostnames,
usernames, config paths, repository paths, or project names. Runtime profiles
and ephemeral subagents inherit the installation billing principal and do not
consume additional agent slots.

## Optional member link

An unlinked installation is fully functional and may keep installation-local
preferences. To let preferences follow an engineer across machines and
runtimes, use **Dashboard > Agents > Instances > Install on this device**. That
flow creates a single-use token that expires after ten minutes. The token may be
included in the principal-session challenge or consumed with the MCP tool
`link_current_installation` / REST endpoint:

```text
POST /api/v1/agent/member-links
```

Reusable organization-key distribution commands must never include a member
token. Linking does not rotate the organization key or create another billed
agent. Members can rename their linked installations; organization admins can
assign, reassign, activate, or deactivate installations and label child runtime
profiles independently. Automatic runtime check-ins preserve custom profile
labels. Agent responses never contain member email addresses, Clerk IDs, or
internal organization IDs.

## Preference contract

Preferences are bounded organization-local working choices, not edits to
canonical skill instructions. These built-in controls are convenient presets,
not a closed vocabulary:

- `comment_density`: `sparse`, `balanced`, `detailed`
- `comment_focus`: `intent_only`, `tricky_logic`, `api_contracts`,
  `comprehensive`
- `explanation_depth`: `concise`, `balanced`, `detailed`
- `output_organization`: `compact`, `structured`, `step_by_step`

Use `get_effective_preferences` or
`POST /api/v1/agent/preferences/effective` to resolve task-relevant values.
Normal query and invocation responses also include
`preference_definition_version`, `effective_preferences`, and, for a selected
skill, `preference_application`. Extensible settings use a stable dotted key,
stable value, short label, concise normalized behavior, effect
(`presentation`, `workflow`, or `strategy_selection`), direction (`prefer` or
`avoid`), and definition version. Native hooks record recognized built-ins
silently. For another explicit durable preference, the hook asks the agent to
call `record_preference` with opaque hashes and `scope: "auto"`; the server binds
it to the linked member when present and otherwise to the installation.

Resolution order is:

1. universal safety, authorization, privacy, applicability, required skill
   steps, validation, and review requirements (hard constraints, not
   preferences);
2. required organization guidance;
3. the current explicit task instruction;
4. an explicit project-context preference;
5. explicit member + runtime profile;
6. explicit member;
7. learned member + runtime profile;
8. learned member;
9. explicit installation fallback;
10. learned installation;
11. recommended organization guidance;
12. declared skill default.

Organization admins choose Required or Recommended under **Dashboard > Agents >
Preferences**. Required applies to every organization agent. Recommended is a
default that a clear task or personal preference may replace. The API field
`project_key` is an opaque local project-context hash, not an administrator
policy scope.

Use `record_preference` or `POST /api/v1/agent/preferences` only for an
built-in or complete bounded extensible setting. Submit an `evidence_hash`,
`task_hash`, scope, and confidence. Never upload the raw prompt, feedback text,
source path, or private task content.

Relevance and preference influence remain separate. The normal ranker first
establishes applicability and the stable `high`, `possible`, or `exploratory`
tier. Organization-private compatibility records for the exact skill and
preference versions can then reorder candidates only inside that same tier.
The response reports qualitative matched/conflicted relationships plus
`relevance_rank` and `personalized_rank`; it never exposes the internal bounded
adjustment. A single selected skill still receives a surgical preference
sidecar for discretionary behavior. A locked skill requirement blocks an
incompatible personal preference. A locked conflict with Required organization
guidance makes the skill ineligible. No preference weakens a hard constraint.

Compatibility is classified asynchronously. Query and invocation do not add a
generative preference call or a second embedding request. Missing, stale, or
unavailable coverage is neutral. Preference and policy changes use leased
catalog sweeps, while an exact skill-version change queues only that skill for
affected organizations. An ineligible organization is visibly blocked and
resumes automatically instead of retrying classification work continuously.
After actual use, submit compatibility
feedback only with the exact `query_id`, `result_id`, skill/version, evidence
source, and server-issued preference fingerprint from that result's feedback
offer. The server derives the evidence identity and rejects expired,
unfetched, cross-principal, stale-version, or unoffered claims.

- An explicit instruction applies to the current task immediately. Known
  built-ins activate durably without background work. A custom setting remains
  pending until automatic normalization and validation approves it; unsafe,
  malformed, or uncertain custom behavior stays inactive and is never replayed.
- Inferred member or installation values require at least three consistent
  observations across two tasks and two days with confidence at least `0.85`.
- A learned member + runtime residual requires four observations across three
  tasks with confidence at least `0.85`.
- Learned values stop applying after 180 inactive days.
- Explicit values persist until changed.
- Each activation creates a reversible profile revision; the dashboard supports
  undo and reset.

## Evidence topology

The agent's job is to submit accurate, privacy-safe evidence. It does not need
to decide the final skill graph operation. `routing_hint` is optional and
non-authoritative:

```json
{
  "routing_hint": {
    "suggested_action": "specialize",
    "conditions": [
      {
        "dimension": "runtime_version",
        "operator": "at_least",
        "value": "2.0"
      }
    ]
  }
}
```

Remembrance runs static safety, duplicate search, target existence, risk,
verifier, and review-policy guards before selecting one route:

- `amend`: a universal correction or reusable detail for an existing skill;
- `specialize`: guidance that is valid under stable environment/task
  conditions;
- `strategy_fork`: a genuinely different approach to the same job;
- `independent_skill`: a distinct reusable job;
- `preference`: a subjective but reusable presentation, workflow, or strategy
  choice represented by a typed preference;
- `evidence_only`: a one-off incident or pattern that is not ready to shape a
  skill; or
- `hold`: uncertainty, missing target, low confidence, or a safety/review gate.

Missing or malformed model topology output falls back to evidence-only or human
review. It never authorizes an automatic mutation. Organization evidence can
route only to private organization artifacts; public evidence follows the
public review pipeline. The public classifier learns only from global-admin
corrections, while each organization's adapter learns only from that
organization's admins.

## Specialization lineage and rebase

A specialization is not a patch fragment. It is a complete reviewed version
with:

- `specialized_from` lineage;
- the exact parent version used during review;
- structured scope predicates;
- readable `use_when` and `avoid_when` guidance; and
- normal safety, quality, version, and rollback records.

When the parent advances, Remembrance creates a reviewed compatibility/rebase
candidate. It does not silently rewrite the child. Review cards state the
proposed operation, exact target or parent, stable conditions, consequence, and
either the complete new/specialized skill or the exact existing-skill diff.

Operators may temporarily disable preference recording/application with
`AGENT_PREFERENCES_ENABLED=false` or learned topology routing with
`SKILL_TOPOLOGY_AUTOMATION_ENABLED=false`. Query and invocation continue; the
latter control leaves the existing verified review/materialization path in
place.

## Dashboard and APIs

- **Dashboard > Agents > Instances** lists privacy-safe installation/runtime
  inventory and member assignments.
- **Dashboard > Agents > Preferences** lists effective values, confidence,
  provenance, revisions, undo, and reset.
- **Dashboard > Verification > Topology** shows proposed routes, targets,
  stable conditions, classifier versions, and reviewer overrides.
- `GET/PATCH /api/v1/enterprise/agent-instances` manages visible instances.
- `POST /api/v1/enterprise/agent-member-link` creates a one-time member token.
- `GET/PATCH /api/v1/enterprise/agent-preferences` manages dashboard preference
  revisions.

Hosted MCP cannot read a local TOFU key or invent a human identity. Without a
client-held principal session it remains organization-level, while normal
query/invocation behavior continues.
