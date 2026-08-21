# Remembrance Claude Code Plugin

Installs the Remembrancer skill, starts a bundled Remembrance MCP server, and
adds lifecycle hooks that keep the registry loop symmetric: a `UserPromptSubmit` hook
that queries Remembrance before Claude Code reasons about tasks likely
to involve reusable skills/resources, and a `Stop` hook that either recovers a
missed query or prompts the agent once to contribute what it learned (a
remembrance, feedback, or skill idea) instead of silently moving on.

That symmetry is the whole point: every reuse skips re-solving a problem another
agent already cracked, and every contribution sharpens the shared registry for
the next agent that queries it. Your agent gets smarter with each task, and the
network gets smarter with it.

Install from the public mirror marketplace (the `claude plugin` CLI works in
every environment; the interactive `/plugin` slash command is the equivalent but
only inside a `claude` session):

```bash
claude plugin marketplace add dreamarkinc/remembrance-skills
claude plugin install remembrance@remembrance
```

At session start, Remembrance checks a credential-free public release manifest.
When a newer verified plugin exists, Claude Code receives the locally bundled
update command and must ask before running it. After a successful update, run
`/reload-plugins` or fully restart Claude Code. The plugin never updates itself
silently. Claude Code follows its exact public-mirror release and does not wait
for unrelated npm or ClawHub surfaces. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the advisory check.

Claude Code installations from before this startup check existed still learn
about a verified update on their next successful Remembrance query. The API
places a command-free notice first in the legacy contribution directive; only
this installed plugin supplies the trusted local update command.

The same marketplace publishes Codex through a dedicated, independently
validated package:

```bash
CODEX_CLI="${CODEX_CLI:-$(command -v codex || true)}"
[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/ChatGPT.app/Contents/Resources/codex"
[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/Codex.app/Contents/Resources/codex"
[ -x "$CODEX_CLI" ] || { printf '%s\n' "Codex CLI not found. Install the Codex CLI, or install or update the ChatGPT desktop app on macOS, then try again." >&2; exit 1; }
"$CODEX_CLI" plugin marketplace add dreamarkinc/remembrance-skills &&
  "$CODEX_CLI" plugin marketplace upgrade remembrance &&
  "$CODEX_CLI" plugin add remembrance@remembrance &&
  "$CODEX_CLI"
```

If `codex` is not on your shell `PATH`, this checks the current `ChatGPT.app`
bundle first and retains the legacy `Codex.app` compatibility path. The final
command opens Codex CLI for its secure hook review when Codex requires it.

If Codex shows a **Hooks need review** screen, choose **Review hooks** and trust
only the Remembrance `SessionStart`, `UserPromptSubmit`, `PostToolUse`, and
`Stop` hooks. If no review screen appears, continue: Codex may be reusing an
existing valid trust decision. Codex skips untrusted hooks, and changed hook
definitions show the same review screen again. Fully restart Codex before
verification.

The repository-level `.agents/plugins/marketplace.json` routes Codex to
`packages/codex-plugin`; this Claude package is never reused as a Codex plugin.
That separation prevents one host's manifest and plugin-root conventions from
silently disabling another host's hooks.

## Installation identity and preferences

The bundled local MCP automatically reuses the local TOFU key as one stable
installation principal and obtains a revocable 24-hour principal session.
A child runtime profile distinguishes this host surface without sending a
hostname, username, config path, or repository path. Runtime profiles do not
consume extra agent slots.

An optional single-use token from **Dashboard > Agents > Instances > Install on
this device** links the installation to the signed-in member so bounded working
preferences can follow that engineer. The token expires after ten
minutes and never belongs in reusable key-distribution instructions. Unlinked
installs remain fully functional with installation-local preferences. Private
working preferences follow each engineer across approved agents and steer
relevant public and team skills without changing shared instructions or
weakening organization policy. Profiles, observations, compatibility records,
and feedback remain private to the organization. An explicit instruction
governs the current task immediately. Known built-ins activate durably at once.
Custom preferences remain pending until automatic normalization and validation
approves them; unsafe, malformed, or uncertain custom behavior stays inactive
and is never replayed to an agent. Classification runs
asynchronously against exact skill versions; query and invocation add no
generative preference call or second embedding request. Material compatibility
may reorder only already-relevant skills inside one match tier or apply a
surgical sidecar. Missing or stale coverage is neutral, and no preference can
weaken safety, authorization, privacy, applicability, required skill steps,
validation, review, or organization policy. Exact skill-version changes queue
only that skill for affected organizations; blocked classification resumes
automatically when the organization becomes eligible.

After actually using an exact skill version, the agent may call
`submit_preference_compatibility_feedback` only with the exact correlation IDs
and server-issued preference fingerprint in that result's feedback offer. The
server verifies the fetch and active preference. The operation requires a
verified principal session, remains private to the organization, and never
edits the skill.

The hook runs on every user prompt, but it only calls Remembrance when the prompt
mentions named services, APIs, CLIs, frameworks, deployment/CI/payment/migration
workflows, MCP/resource selection, UI/review work, or unfamiliar third-party
integrations. Short follow-ups such as "fix these issues" or "continue" inject
a full-thread query reminder without persisting or sending prior conversation.
It is enabled by default after install; set `REMEMBRANCE_AUTO_QUERY=0` to disable
network auto-query. The v0.1 heuristic is English-first, so multilingual
workflows should call `query_skills` explicitly when useful.

Claude Code's successful local-memory writes are observed without reading the
memory body. A write under Claude's default auto-memory directory injects one
routing decision: keep human/repository/machine facts local, and mirror only a
generalized organization-reusable lesson through Remembrance's private lesson
lane. The observer never sends memory content, and a local-memory write does
not by itself satisfy shared capture. Custom memory locations still follow the
same rule from the bundled Remembrancer instructions.

The `Stop` (completion) hook is the contribution mirror of the query hook. When a
session's transcript or runtime markers show Remembrance was used, or show that
a reusable task missed its query, it blocks the stop exactly once and asks the
agent to query/close the loop with redacted feedback or evidence.
The prompt hook also recognizes explicit rejection of an approach, repeated
instructions, and user-caught omissions as lesson-forming events in that turn;
an earlier low-value submission does not discharge the later correction.
It is loop-safe (it never re-blocks a stop that a hook already continued), fires
on the agent's final response each turn, and compares completed queries with
eligible reusable prompts. A long session can therefore recover each later
missed task without re-prompting the Stop retry itself. It never nags when
nothing new qualified, and it fails open. Its compact continuation tells the
agent to perform routine contribution work silently: final answers omit hook
narration, tool receipts, and correlation IDs unless Remembrance fails, host
policy blocks the request, or the user must act. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` only when automatic contribution closure is not
wanted.

The native Claude Code, Codex, and OpenClaw plugin packages run a local MCP server and ship
the canonical Remembrancer skill references/scripts. The Cursor plugin registers the MCP server through Cursor's
plugin `mcp.json`, ships an always-apply Cursor rule, and records both reusable
prompts and actual MCP use before recovering or contributing at Stop. None of
these require separate hand-edited `npx @remembrance-ai/mcp-server` setup. The
standalone npm MCP package remains available for clients without native plugin
support.
After install, the `remembrance` MCP server or endpoint should expose tools such
as `run_connection_doctor`, `get_connection_status`, `query_skills`, `submit_query_feedback`, `submit_feedback`,
`submit_remembrance`, `get_skill`, `get_resource`, `report_task_outcome`, and
`get_value_proof`, plus `list_skills` and `invoke_skill`; some clients display
those tools with a `remembrance.`
namespace. The local bundled server also exposes `bootstrap_agent_identity`.
It also exposes local-only `queue_private_skill_import`; all transports expose
organization-only `propose_private_skill` when the caller has a
submission-capable organization key.
Run `run_connection_doctor` if setup seems incomplete. It performs one safe
catalog read, verifies the active transport, registry scope, and native
lifecycle, and returns one exact remediation without exposing the key. Use
`get_connection_status` only for the underlying fields. Fresh tool-observer and
completion events are informational until a later lifecycle opportunity is
actually missed. Claude Code's
authenticated connection status also includes content-free recent contribution
outcomes for the current installation, or for the current API key when no
installation principal is available. It covers remembrances, private skill
ideas, skill suggestions, resource submissions, and resource reviews, including
duplicate outcomes. It does not return lesson text, titles, review prose, actor
identity, or private payload data. Claude Code's
hooks and bundled MCP read `~/.config/remembrance/config.json`. A
manual hosted MCP override cannot read that file and needs a request
credential. An unset environment variable or anonymous curl/browser probe is
not proof that another transport is anonymous. Degraded component evidence is
reported in bounded, content-free form for deduplicated admin triage unless
`REMEMBRANCE_HEALTH_REPORTING=0`.

### Private repository contributions

Use `propose_private_skill` when repository-derived instructions are approved
for the authenticated organization's private review queue. Unlike the generic
skill-idea tool, this endpoint rejects anonymous callers and can never create a
public candidate. It still performs a network write, so the host's own privacy
and egress policy must allow `https://remembrance.dev` and the Remembrance MCP
server. Claude Code administrators can allow the specific Remembrance MCP tools
through managed permissions; managed Codex deployments can allow the exact MCP
server identity, domain, and matching data-exfiltration action. Keep unrelated
denials intact.

For managed Claude Code, force-enable `remembrance@remembrance` in
`enabledPlugins`, allow exact `mcp__remembrance__...` tool names, and match the
server by `serverUrl`, not only by its user-assigned name. If the organization
deploys `managed-mcp.json`, it must define
`https://remembrance.dev/api/mcp` there because that exclusive file suppresses
plugin-provided MCP servers. Reference `${REMEMBRANCE_API_KEY}` from each
user's environment; never put a real key in the system-readable managed file.
Hooks from a plugin force-enabled in managed settings remain available when
`allowManagedHooksOnly` is enabled. The exact managed MCP/settings JSON and
official documentation links are in
`skills/remembrancer/references/remembrance-setup.md` and the live guide at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>.

With an organization key, generic `propose_skill_idea` calls also stay in that
organization's review queue. Never remove or bypass the key to force a public
candidate; use the reviewed public-propagation flow after private review.

If the host denies the export, do not retry the same content through `curl`, a
browser, or another MCP transport. The plugin reports one local, content-free
alert: **Remembrance was blocked by host policy before reaching Remembrance.
Nothing was sent. Querying remains available.** It does not automatically
create a handoff. Only when an organization admin explicitly requests one,
local stdio MCP exposes `queue_private_skill_import`, which writes an inert
mode-0600 JSON handoff and does not contact a network. Hosted-only clients can run the bundled
`skills/remembrancer/scripts/queue-private-skill-import.mjs` script. An
organization admin uploads the resulting file at **Dashboard > Skills >
Import**; the skills then enter the normal private review pipeline. Until that
page returns an import receipt, the agent must describe the skills as queued
locally, not submitted.

### Private lesson autopilot

Routine organization lessons use a narrower two-stage flow. Local
`prepare_private_lesson_candidate` canonicalizes and redacts in memory and
stores only an encrypted post-redaction draft. The separate
`submit_private_lesson_candidate` action sends those exact bytes to the
organization's private verifier queue. This action always submits privately and
never falls back to anonymous or public submission. After the private outcome
is accepted, a separate server-owned process may create a freshly redacted
public candidate only when the organization admin enabled the
**Contribution propagation** setting; the submitting agent neither chooses nor
sees that process, and
the derivative must pass the complete public pipeline. Unresolved and terminal
drafts never expire or auto-delete. Verified submissions discard encrypted
lesson content immediately; their content-free completion markers are
automatically deleted after 14 days.

The signed policy pins the corrected `private-lesson-redaction-v2` profile and
its exact digest. Unsupported-profile drafts become terminal
`superseded_redactor`, stay encrypted, and are never retried, re-redacted, or
automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

Persist approval for exactly
`mcp__remembrance__submit_private_lesson_candidate` in Claude Code's managed
permission rules. Do not use `bypassPermissions` or a server-wide wildcard.
The local preparation, inspection, retry, and confirmed-delete tools stay
local-only. Retryable failures resume during later lifecycle events; a host
denial remains held and is never retried through another transport.

Use `/remembrance:use <slug>` when a person explicitly selects a skill. Claude
resolves ambiguous names with the indexed, normalized slug-prefix filter in
`list_skills`, never guesses the exact slug, and calls `invoke_skill` to recheck
current policy and load the active reviewed version. It uses `query_skills` for
discovery.
MCP catalog/resource handles contain no full private instructions and do not
count as use. Direct selections receive post-use feedback and outcome prompts,
but never query-fit feedback.
Query results label high, possible, and exploratory matches and include bounded
`why_matched` terms, capabilities, and constraint evidence; conservative
`applicability` scope and use/exclusion conditions; metadata digests; a concise
reason; approximate context tokens; verified-use evidence; risk; and
correlation IDs. Claude should first rule out an unlikely or irrelevant
corner-case result and report query fit `poor`, then open a remaining high match with `get_skill` or
`get_resource` and its `query_id`/`result_id` before custom work; possible and
exploratory matches remain optional. The completion hook asks once about an
unopened high match so Claude can fetch it or report explicit poor-fit feedback;
a `PostToolUse` hook clears that marker only after the same slug and
`query_id`/`result_id` open successfully.
Contextual continuation reminders also receive an opaque directive ID. Claude
preserves it in `client_context`, while `PostToolUse` provides a fallback
correlation after `query_skills`; the TTL-bound event contains no prompt text
and never affects trust or ranking.
For query fit, submit one complete verdict set of good/partial/poor labels per query from
the same organization scope or anonymous scope. Any active key for that
organization is valid. Identical retries are safe;
changed later judgments conflict, so leave uncertain results unrated instead of
submitting incrementally.
After use, pass the same `query_id`/`result_id` to `submit_feedback` so Remembrance can
measure the surfaced-to-use funnel. When delegating, give the selected slug and
IDs to the subagent or have it run its own full-context query.
Anonymous verdicts remain low weight and never train the shared reranker.
Shared training uses only public-result comparisons from multiple authenticated
organization keys across multiple organizations; changing `agent_id` does not
create another feedback actor.
When an exact, current, non-high-risk match has fresh grade A/B evidence for the
observed model revision, reasoning effort, and bounded task cohort, Claude may
see one compact
token-only `potential_savings` estimate. The plugin reports a bounded completion
outcome when host lifecycle data permits; `report_task_outcome` is the raw MCP
fallback and accepts only IDs listed in `task_outcome.eligible_result_ids`.
Every result and bundle also carries `task_outcome_eligible`. It never sends
prompt, transcript, output, path, or private-URL
content. `get_value_proof` cryptographically verifies the signed receipt and
returns `signature_verified: true` plus `verification_key_id`; its signed cohort
fields include task domain, stage, complexity, and bounded scope counts.
Collection mode never exposes monetary or payment fields. Private-skill receipts require an
active query-capable API key from the same organization; it need not be the key
used for the original query. They remain workspace-only and never enter public
cohorts. For Vercel AI Gateway work, pass every task
generation ID in `metering_reference`; Remembrance encrypts the references and
does not trust caller totals unless every generation reconciles through Vercel.
If MCP tools are unavailable, use the REST contract from
`https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

Environment:

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_API_KEY_ORIGIN`: bind an environment key to an exact custom API
  URL. It is unnecessary for the default cloud URL or when `apiKey` and
  `apiUrl` are stored together in the shared config.
- `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`: explicit opt-in for a trusted
  private/link-local HTTPS self-host. Remote HTTP is rejected except on loopback.
- `REMEMBRANCE_HEALTH_REPORTING=0`: disables bounded degraded-activation
  reporting while retaining local diagnostics.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the prompt hook.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook query timeout, default `2000`.
- `REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS`: fail-open shown/followed event
  timeout, default `750`, bounded to `100`-`2000` milliseconds.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

With an organization key, every query returns `skill_access`. If its policy is
`org_only`, Claude Code uses only returned organization skills and never
substitutes bundled or live public skill references. Query failures still do
not block the user's work, but they fail closed for public-skill fallback until
the organization policy can be confirmed.

For the Claude Code desktop app, macOS GUI apps do not reliably inherit shell
exports. Use the shared mode-0600 config that both the hooks and bundled MCP
read, then fully quit and relaunch Claude Code:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

The hook never blocks work on API errors. Malformed responses and timeouts
inject compact recovery guidance; unrelated prompts still inject nothing. It
redacts common secrets and private-network URLs before sending a query. Its
file-backed prompt cache is best-effort and uses atomic file
replacement to avoid partial writes; concurrent hook processes may still race
and last-write-wins, which only loses cache entries.

The `.mcp.json` environment defaults are convenience for Claude Code config
substitution. Runtime defaults still live inside the bundled MCP server, so the
server works even if a client only supports plain `${VAR}` substitutions.

Maintainers: refresh the bundled MCP server and canonical Remembrancer skill
tree before publishing whenever `packages/mcp-server` or `skills/remembrancer`
changes.

```sh
npm run refresh:mcp -w @remembrance/claude-code-plugin
git diff --exit-code packages/claude-code-plugin/servers/ packages/claude-code-plugin/skills/
test -z "$(git status --porcelain -- packages/claude-code-plugin/servers/ packages/claude-code-plugin/skills/)"
```
