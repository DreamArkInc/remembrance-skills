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
`POST /api/v1/agent/preferences/effective` to resolve the preferences of one
context. MCP query and invocation results carry them as the text snapshot
described under [Preference delivery](#preference-delivery); REST query and
invocation responses also include `preference_definition_version`,
`effective_preferences`, and, for a selected skill, `preference_application`.
Extensible settings use a stable dotted key,
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

The call does not promise activation. Read `activated` and
`normalized_activation_state` in the response instead of assuming the setting is
live: a custom setting stays `pending_validation` until automatic normalization
and validation approve it, and an inferred observation activates only after the
consistency and confidence gates are met.

Organizations using customer-held encryption are currently deferred. Their only
lane kept settings, fingerprints and private-derived evidence hashes in clear
text in general collections, so every substantive preference write and every
preference-compatibility feedback call is refused **before persistence** with
HTTP 422 and code `customer_held_preference_processing_deferred`. Existing
records are unchanged, reads and the content-free withdrawal lane keep working,
and responses withhold the `preference_compatibility_feedback` offer there. That
refusal is permanent for now, so do not retry it and do not invite the feedback
lane. Built-in settings are refused along with custom ones because they shared
that same clear-text lane.

An empty `effective_preferences` list is not by itself a claim that the profile
is empty. Read the `personalization` block that accompanies it, and in a REST
response the `completeness` block too; a snapshot states the same in its
header. `available: true`
with `reason_code: "resolved"` means every scope that applies to this caller was
read, and `resolved_scopes` names them. `available: false` names what was not:

- `organization_scope_only` — an organization key with no principal session.
  Organization-scope storage was read; `omitted_scopes` lists `installation`,
  `member` and `member_runtime`, which were never queried. A stored personal
  preference can exist and simply not be in this list, so do not report the
  profile as empty and do not report the preference as lost. Organization-level
  use, public retrieval, discovery and invocation all stay available; link a
  principal session only if personal preferences should apply. Not retryable:
  repeating the identical call changes nothing.
- `not_applicable` — an anonymous call. Stored preferences are
  organization-scoped, so none applies and none was read. Anything listed came
  from the request's own `task_preferences`. This is not a request to
  authenticate.
- `preference_storage_unavailable` — storage could not be read (retryable).
- `preferences_disabled` — the deployment has agent preferences off (not
  retryable).

Retrieval, discovery and invocation stay available in every one of these cases,
and none of them adds a prompt or withholds a result.

Relevance and preference influence remain separate. The normal ranker first
establishes applicability and the stable `high`, `possible`, or `exploratory`
tier. Organization-private compatibility records for the exact skill and
preference versions can then reorder candidates only inside that same tier.
The response reports qualitative matched/conflicted relationships plus
`relevance_rank` and `personalized_rank`; it never exposes the internal bounded
adjustment. A single selected skill still receives a surgical preference
sidecar for discretionary behavior. A skill sets an ordinary preference aside
only for a locked conflict confirmed by the organization, declared in the
skill's reviewed metadata, or corroborated by verified members of the
organization, and only while that skill is followed; the preference keeps
applying to all other work. A conflict that only a model check suggests is a
note, not a block, so the preference still applies. Required organization
settings are never set aside: a confirmed locked conflict with one makes the
skill ineligible, so queries exclude it and direct invocation answers HTTP 409.
No preference weakens a hard constraint.

Compatibility is classified asynchronously. Query and invocation do not add a
generative preference call or a second embedding request. Missing, stale, or
unavailable coverage is neutral. Preference and policy changes use leased
catalog sweeps, while an exact skill-version change queues only that skill for
affected organizations. An ineligible organization is visibly blocked and
resumes automatically instead of retrying classification work continuously.
After actual use, submit compatibility
feedback only with the exact `query_id`, `result_id`, skill/version, evidence
source, and either the server-issued preference fingerprint from that result's
feedback offer or the `preference_key` of a preference that was active for that
skill use, offered or not. A key that matches none, or more than one, of that
use's preferences is refused with HTTP 422, and a key sent with a fingerprint
must name the same preference. The server derives the evidence identity and
rejects expired, unfetched, cross-principal, stale-version, or unauthorized
claims.

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

## Preference delivery

Agents receive preferences as a text snapshot, not as JSON entries. Its first
line is a header such as:

```text
Remembrance preferences (profile pd1_3f9c2a7d1e5b8c04, context 7c1e94a2; complete)
```

The header names a short, content-free profile digest, a context id and the
status. An incomplete status names the reason, what is missing and the exact
recovery call, for example `incomplete: page 1 of 2, entries 1-6 of 18 shown;
the remaining entries are on later pages; call get_effective_preferences with
page_token <t>`; each further reason follows on its own `Also:` line. A
rule line follows, then "Required by your organization:" and "Your
preferences:" with one line per entry: the stored label, `(avoid)` for an
avoid preference, the scope it applies to (`this task`, `this project`,
`skill <slug>`, `domain <name>` or `runtime`) and the stored behavior, never
paraphrased or cut. Apply the entries silently, without asking the user to
reconfirm them. Two snapshots with equal digests describe the same profile
only when their context ids are equal too.

- **Where it arrives.** An MCP `query_skills` result carries the snapshot of
  its context (project, task domain and task preferences) in `preferences`; an
  `invoke_skill` result carries the snapshot of the skill's context. Each
  result adds `skill_notes`: preferences set aside only while that skill is
  followed, preferences scoped to that skill, which take precedence over the
  snapshot, notes that are not blocks, and replaced skill defaults.
  `get_effective_preferences` returns `{preferences, keys}`, and `fingerprints`
  with `include_fingerprints: true`. Native hooks inject the project's snapshot
  themselves, as listed below.
- **Paging.** A profile larger than the space for it arrives in pages. Page 1
  holds the required settings first and opens with "Before any other action,
  call get_effective_preferences with page_token <t> until complete." (or
  "... for the remaining pages." when the header says no recovery call exists;
  the last page then stays incomplete and needs no further call). Call
  `get_effective_preferences` with that token, plus the same `keys` and
  `task_preferences` when the status asks for them, until the header says
  complete; only the last page does. A restart page means that the profile
  changed or the token expired, so earlier pages are outdated. A damaged token,
  or one issued to another caller, is refused with HTTP 422 and a message that
  names the call that starts over.
- **Truthful status.** Missing personal scopes (`organization_scope_only`),
  unavailable storage, disabled preferences, more stored settings than one read
  returns, a hook's redaction of an entry, or a cached copy each make a
  snapshot incomplete, and the header says what to do. When such a state lasts
  the whole conversation, its recovery asks for one notice to the user, never
  one per prompt.
- **Freshness.** A snapshot is current as of each prompt on a host that injects
  it on every prompt, and as of each request start everywhere else. A change
  made while a request runs applies from the next request. Without per-prompt
  injection, hold a fresh, complete snapshot before governed work in each new
  request: the snapshot in that request's own `query_skills` or `invoke_skill`
  response counts, and so does one whose header says no recovery call exists;
  otherwise call `get_effective_preferences`, without a skill search. A
  background refresh only picks changes up earlier and never counts as
  verified current delivery.
- **Cached copy.** When a hook's live read fails, it may show its saved copy for
  the same identity and project context, at most 7 days old, marked incomplete
  with its age. A cached copy never qualifies for `known_digest`.
- **`known_digest`.** Send `known_digest` to `get_effective_preferences` or
  `query_skills` only when this conversation already holds the complete
  snapshot for that exact context with that digest, every page included, with
  no summary or context reset since; never for an incomplete, stale or cached
  copy. The server answers `unchanged` only for a successful, complete, fully
  personalized resolution with the same digest, and the MCP view is then one
  short line. Any other resolution returns its real status. Hooks never send
  `known_digest`.

Native hooks inject the snapshot of the project context, never a parent
session's task entries, at these points; each budget covers the whole hook
field:

- Claude Code: `SessionStart` (startup, resume, clear, compaction and fork),
  every `UserPromptSubmit`, and `SubagentStart` for each subagent; 9,000
  characters.
- Codex: `SessionStart`, every `UserPromptSubmit`, and `SubagentStart`; 7,000
  characters and 2,000 estimated tokens.
- VS Code: `SessionStart` and every `UserPromptSubmit`; a subagent's task
  prompt gets the project snapshot; 9,000 characters. Delivery to the VS Code
  model is not yet proven, so VS Code agents also follow the request-start
  rule.
- Cursor: `sessionStart`, which Cursor does not wait for, so the first
  `postToolUse` delivers the snapshot again; then `postToolUse` after a
  compaction or when a background read, every 5 minutes by default, finds a
  changed profile. The always-apply rule adds the request-start rule.
- OpenCode: once in every model request of a turn; 9,000 characters.
- OpenClaw: every run, appended to the system context; 9,000 characters. A
  gateway serves several workspaces, so project preferences need
  `REMEMBRANCE_PROJECT_PATH` or `REMEMBRANCE_PROJECT_KEY`. Without either, the
  snapshot says that the gateway does not know the agent's project, and a "for
  this project" preference is not saved; the agent is told why.
- Raw MCP, hosted MCP and REST clients follow the request-start rule.

REST callers read the same contract as fields. The effective route returns
`effective_preferences`, `personalization`, `profile_digest`, `completeness`
(`complete`, `total`, `delivered`, `omitted`, `reason`), `preference_page_token`,
`page` and `unchanged`. `POST /api/v1/agent/query` adds the same top-level
fields except `page`. Each query candidate's `effective_preferences` holds only
the entries that differ from the top-level list (preferences scoped to that
skill and its declared defaults), with `preference_differences` and its own
`preference_page_token`. An `applied_preferences` item is a `{key, authority}`
reference only when that key occurs exactly once across the top-level list and
the candidate's differences; otherwise it is the full entry. Bodies stay within
3.5 MiB: above that, a route cuts whole entries, reports the cut through
`completeness` (`response_size_limited`) or `preference_differences.withheld`,
and its page token recovers the entries. A cut sequence ends when `page.start`
plus `completeness.delivered` equals `completeness.total`; do not follow the
token then.

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
