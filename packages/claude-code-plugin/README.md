# Remembrance Claude Code Plugin

Installs the Remembrancer skill, starts a bundled Remembrance MCP server, and
adds lifecycle hooks that keep the registry loop symmetric: a `UserPromptSubmit` hook
that queries Remembrance before Claude Code reasons about tasks likely
to involve reusable skills/resources, and a `Stop` hook that silently records a
missed query or contribution obligation so the next user prompt can carry the
exact bounded recovery actions without obscuring the current final answer.

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

**Requirements: Node.js 18.17.0 or newer that the host can find.** A host
started from the Dock, Finder or an IDE may not have your shell's PATH, so a
Node.js installed by nvm, fnm, volta, asdf, nodenv or mise can be missing from
it; the symptom is `spawn node ENOENT` or "No such file or directory". The
plugin therefore starts every hook and the bundled MCP server through
`scripts/node-launcher`, which uses `REMEMBRANCE_NODE` when it is set, else
`node` on PATH, else Node.js 18.17.0+ from nvm, volta, fnm, n, asdf, nodenv,
mise, Homebrew, `/usr/local` or `/usr/bin`; for nvm it follows the default
alias, through nested and `lts/` aliases, to the version it names, skips nvm
when that alias is `system`, and otherwise takes the newest installed version.
It never installs Node.js or changes PATH.

- The Claude Code CLI takes the PATH of the terminal it is started from.
- The Claude desktop app reads PATH from your shell profile (`~/.zshrc`,
  `~/.bashrc`), so fixing the profile and restarting the app is the first
  remedy there.
- The VS Code extension may not inherit your shell environment: start VS Code
  with `code .` from a terminal, or set `claudeCode.environmentVariables`.
- In Claude Code, set `REMEMBRANCE_NODE=/absolute/path/to/node` (from
  `command -v node` in a terminal) in the `env` map of
  `~/.claude/settings.json`; it reaches the hooks and the bundled MCP server.

Plugin MCP servers connect once at session start with no automatic retry, and in
the desktop app and `-p` sessions `/reload-plugins` does not reconnect a failed
one, so fully quit and restart Claude Code after a fix. A failed server shows
"Failed to connect" in `/mcp` and `claude mcp list`; the spawn error itself
(with this launcher, one `Remembrance: cannot find Node.js 18.17.0 or newer`
line) is only in the debug log (`claude --debug=mcp`, then
`~/.claude/debug/<session-id>.txt`). `"REMEMBRANCE_NODE_LAUNCHER_DEBUG": "1"` in
the same `env` map adds the launcher's choice to that log. On macOS and Linux,
hooks run in a non-interactive `sh -c`, which never reads `~/.zshrc`.

On Windows, Claude Code runs hooks in Git Bash, which it requires there, and
they start the launcher with `sh`. The MCP entry names the launcher without an
extension, so Claude Code runs its twin `scripts/node-launcher.cmd` through
`cmd.exe` and needs no `sh` on PATH; the twin uses `REMEMBRANCE_NODE` (the full
path of a `node.exe`) when it is set, else the first `node.exe` on PATH, else
`%ProgramFiles%\nodejs\node.exe`. If Claude Code runs hooks in PowerShell
because Git Bash is absent, the hooks do not start; the MCP server still does.

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

With an organization key, a session that starts, resumes, or is cleared also
reads the organization's session skills (at most five slugs and version ids,
never skill text) and asks Claude Code to load each one with `invoke_skill`
before its first reply. After a compaction the hook repeats that request from a
private per-session cache without a network call, and a resume uses the cache
when the registry is unreachable. Each request carries the same idempotency
key, so a repeat returns the first invocation. A pinned version that is no
longer available is reported and skipped, never replaced. Anonymous sessions
skip this step; set `REMEMBRANCE_SESSION_SKILLS=0` to turn it off.

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
only the Remembrance `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`,
and `SubagentStop` hooks. If no review screen appears, continue: Codex may be
reusing an existing valid trust decision. Codex skips untrusted hooks, and
changed hook definitions show the same review screen again. Fully restart Codex
before verification.

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
governs the current task immediately. Known built-ins activate durably at once for a
managed-encryption organization.
Custom preferences remain pending until automatic normalization and validation
approves them; unsafe, malformed, or uncertain custom behavior stays inactive
and is never replayed to an agent.
An organization using customer-held encryption is currently deferred: every substantive preference write and every compatibility-feedback call is refused before persistence with HTTP 422 and code `customer_held_preference_processing_deferred`. Existing records are unchanged, reads and the content-free withdrawal lane keep working, and responses withhold the compatibility-feedback offer there. Read `activated` and
`normalized_activation_state` in the response instead of assuming a setting is
live. Classification runs
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
Text Claude Code generates where a prompt goes is not taken for the user's. A
prompt that starts with a task notification or the `[SYSTEM NOTIFICATION - NOT
USER INPUT]` header, or with a system reminder holding either, is not queried,
captured, or counted, whatever follows. After leading system reminders and
local-command, bash-mode or hook output, only the text that follows counts, and
only when each block closes once: a block left open, or whose closing tag
appears again later (a command's output can hold one), leaves no user text. A
no-result context does not offer a skill idea whose title or description is the
prompt or part of it.
It is enabled by default after install; set `REMEMBRANCE_AUTO_QUERY=0` to disable
network auto-query. The v0.1 heuristic is English-first, so multilingual
workflows should call `query_skills` explicitly when useful.

Claude Code's successful local-memory writes are observed without reading the
memory body. A write under Claude's default auto-memory directory injects one
routing decision: keep human/repository/machine facts local, and mirror only a
generalized organization-reusable lesson through `capture_learning`. The
observer never sends memory content, and a local-memory write does not by itself
satisfy shared capture. Custom memory locations still follow the
same rule from the bundled Remembrancer instructions.

The `Stop` (completion) hook is a silent recovery checkpoint. When a session's
transcript or runtime markers show Remembrance was used, or show that a reusable
task missed its query, it records bounded pending obligations and allows the
current answer to finish. From the transcript it counts only actual Remembrance
query, get, and invoke tool calls and the prompt hook's injected context, not
tool names in host tool listings or saved hook messages, and it checks only the
turn's final assistant message for a reported host-policy block or a lesson. A
skill invoked for the whole session (`scope: "session"`) does not count as the
turn's Remembrance use and owes no post-use feedback or task outcome when a turn
ends. A task-scoped skill version invoked again while in use, for example
reloaded after a compaction while its feedback is pending or after paying it
but before the user's next prompt, is the same use: it owes that feedback once,
payable under any of its receipts, and still counts as the current task's skill
use. Invoked after the user's next prompt, even one that only names the skill,
it is a new use. The next real user prompt receives only the exact outstanding query-fit,
categorical post-use, or `capture_learning` actions.
The prompt hook also recognizes explicit rejection of an approach, repeated
instructions, and user-caught omissions as lesson-forming events in that turn;
an earlier low-value submission does not discharge the later correction.
It is loop-safe, fires on the agent's final response each turn, and asks
about a reusable task only when, since its prompt, no query of the agent's
completed (one that found nothing counts) and no matched result or skill was
used, whatever an earlier task did; a long session's early calls need not be in
the transcript it reads. A long session can therefore recover each later missed
task without a visible Stop retry. It never nags when nothing new qualified,
and it fails open. Routine hook narration, tool receipts,
and correlation IDs stay out of final answers; only Remembrance failures,
host-policy blocks, or required user action are surfaced. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` only when automatic contribution closure is not
wanted.

The native Claude Code, Codex, and OpenClaw plugin packages run a local MCP server and ship
the canonical Remembrancer skill references/scripts. The Cursor plugin registers the MCP server through Cursor's
plugin `mcp.json`, ships an always-apply Cursor rule, and records both reusable
prompts and actual MCP use before recovering or contributing at Stop. None of
these require separate hand-edited `npx @remembrance-ai/mcp-server` setup. The
standalone npm MCP package remains available for clients without native plugin
support.
After install, the local `remembrance` MCP server should expose tools such as
`run_connection_doctor`, `get_connection_status`, `query_skills`, independent
`submit_query_feedback`, categorical `submit_feedback`, `capture_learning`,
`submit_private_lesson_candidate`, `submit_private_skill_candidate`,
`inspect_private_learning_outbox`, `get_skill`, `get_resource`,
`report_task_outcome`, `get_value_proof`, `list_skills`, and `invoke_skill`;
some clients display
those tools with a `remembrance.`
namespace. The local bundled server also exposes `bootstrap_agent_identity`.
It also exposes local-only `queue_private_skill_import`. Broad
`submit_remembrance` and `propose_private_skill` tools are unavailable by
default to organization-capable local clients; hosted/raw and older clients may
retain those explicit compatibility routes.
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

Use `capture_learning.private_skill` followed by the exact
`submit_private_skill_candidate` action when repository-derived instructions
are approved for the authenticated organization's private review queue. The
endpoint rejects anonymous callers and can never create a public candidate.
Broad `propose_private_skill` is a legacy/hosted/raw compatibility route and is
not exposed by default in a current local client. The exact action still
performs a network write, so the host's own privacy
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

### Routing metadata on complete skill proposals

In 0.2.0 a complete skill sent with `propose_skill_idea` or
`propose_private_skill` (or their REST routes) carries routing metadata
(contract v1, published at `/schemas/skill-routing-metadata.v1.json`): when
an agent should pick the skill (`applicability`) and what it does and needs
(`routing`). Ask for a platform draft first, show it to the author, and send
the confirmed or edited fields back with the draft's token. The draft call
stores nothing:

```json
{
  "title": "Deploy a prepared app to Azure",
  "description": "Deploy an already-prepared app to Azure with azd.",
  "proposed_skill_md": "# Deploy a prepared app to Azure\n\nRun azd up ...",
  "prefill_routing_metadata": true
}
```

Its answer holds `example.proposed_metadata` and `routing_draft.token`. The
submission then sends the confirmed fields:

```json
{
  "title": "Deploy a prepared app to Azure",
  "description": "Deploy an already-prepared app to Azure with azd.",
  "proposed_skill_md": "# Deploy a prepared app to Azure\n\nRun azd up ...",
  "proposed_metadata": {
    "applicability": {
      "scope": "specialized",
      "use_when": [
        "The user wants to deploy an already-prepared app to Azure",
        "A deployment plan and infrastructure files already exist",
        "The user asks to run azd up or azd deploy"
      ],
      "avoid_when": [
        "The app has no Azure deployment files yet (prepare it first)",
        "The user only wants a readiness check without deploying"
      ],
      "task_examples": [
        "Deploy this prepared app to Azure Container Apps",
        "Run azd up for my project",
        "Push the validated Bicep deployment to production"
      ],
      "not_for": []
    },
    "routing": {
      "capabilities": ["deploy-to-cloud"],
      "domains": ["deployments-cicd", "cloud-platforms"],
      "runtime_requirements": ["repo-checkout", "shell", "cloud-account", "provider-azure"],
      "risk": "cloud-changes"
    }
  },
  "routing_draft_token": "rd1.<token from the draft>"
}
```

A complete skill without these fields is refused with 422
`skill_routing_metadata_incomplete` (`delivery: not_delivered`; nothing is
stored). The refusal lists every issue and carries the same draft, so fix
the listed fields and send the request again. Fields taken unchanged are
recorded as author-confirmed draft values; edits that widen the draft (a
broader scope, added `use_when` items or capabilities, a lower risk) are
flagged for review. An organization's text is drafted only through its
approved semantic-enrichment processing grant; without one the draft is held
and nothing is sent. A private capture (`capture_learning` with
`private_skill`) may ask for automatic completion: the skill becomes
available after acceptance once its routing metadata is complete.

If the host denies the export, do not retry the same content through `curl`, a
browser, or another MCP transport. The plugin reports one local, content-free
alert: **The host blocked this Remembrance action. Do not treat it as submitted.
Earlier successful actions are unaffected; querying remains available.** It does not automatically
create a handoff. Only when an organization admin explicitly requests one,
local stdio MCP exposes `queue_private_skill_import`, which writes an inert
mode-0600 JSON handoff and does not contact a network. Hosted-only clients can run the bundled
`skills/remembrancer/scripts/queue-private-skill-import.mjs` script. An
organization admin uploads the resulting file at **Dashboard > Skills >
Import**; the skills then enter the normal private review pipeline. Until that
page returns an import receipt, the agent must describe the skills as queued
locally, not submitted.

### Private learning autopilot

Current organization-capable local clients expose `capture_learning` as the
only routine reusable-learning entry point. Supply exactly one compact
`lesson`, complete `private_skill`, or structured durable `preference`. The
router accepts no destination, visibility, credential, or public fallback.
Lessons are canonicalized and redacted in memory; complete skills retain
bounded markdown, public citations, snippets, metadata, and actionable
instructions. Lesson and skill drafts are encrypted in separate outboxes,
while a preference returns the existing `record_preference` action.
`capture_learning` is local and makes no network request. Never
compress a complete skill into a lesson.

Invoke only the returned `submit_private_lesson_candidate`,
`submit_private_skill_candidate`, or `record_preference` action.
These actions always submit privately. Lesson and skill actions carry only a local draft ID
through Claude Code to the organization's pipeline and never fall back to
anonymous or public submission. Accepted content reuses the existing verifier, topology, review,
versioning, audit, and admin-controlled propagation pipeline; the submitting
agent never chooses visibility. After the private outcome
is accepted, a separate server-owned process may create a freshly redacted
public candidate only when the organization admin enabled the
**Contribution propagation** setting; the submitting agent neither chooses nor
sees that process, and
the derivative must pass the complete public pipeline. Unresolved and terminal
drafts never expire or auto-delete. Verified submissions discard encrypted
lesson content immediately; their content-free completion markers are
automatically deleted after 14 days.

The lesson client offers a bounded `private-lesson-redaction-v2` supported
redactor-profile set and the
server signs policy for the newest mutual profile. Retained drafts require
their exact bound profile. Temporary incompatibility remains encrypted as
`awaiting_compatible_profile` with a precise update, full-restart, or
server-rollout action; it is not mislabeled as a safety rejection or host
denial. A profile becomes terminal only when the installed client no longer
supports it; that state is `superseded_redactor`. Terminal drafts stay encrypted and are never retried, re-redacted,
or automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

Persist approval for the four exact network-capable tools in Claude Code's
managed permission rules: the submit and retry actions for both private lesson
and private skill. Remembrance treats each submit/retry pair as one semantic
approval lane and lazily upgrades an existing submit approval. Do not use
`bypassPermissions` or a server-wide wildcard. Local preparation, inspection,
and confirmed deletion stay zero-network; a fresh-draft retry also stops before
network access. Retryable failures resume only when due; a host denial remains
held and is never retried through another transport. `submit_query_feedback`
remains independently available for bounded query-fit judgments.

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
exploratory matches remain optional. The completion hook records an unopened
high match silently so the next user prompt can ask Claude to fetch it or report
explicit poor-fit feedback; a `PostToolUse` hook clears that marker only after the same slug and
`query_id`/`result_id` open successfully.
Without an organization key, the server's relevance judge chooses what a search
is shown from the top 20 public candidates: Jev (TypeSafe, through Vercel AI
Gateway) rates each candidate first, and a language model decides the ones Jev
leaves undecided while there is time. It receives the search's task text and
public skill cards only. Every request asks for zero retention and no prompt
training; for Jev, zero retention rests on Remembrance's account-specific
agreement with TypeSafe through Vercel, which the Gateway does not confirm.
With an organization key, a search is judged only under the organization's
managed processing grant for semantic search, and Jev rates it first only when
that grant also approves TypeSafe, under the owner-attested zero-retention
agreement with TypeSafe (owner decisions 36 and 64), which covers this judge
stage and no other purpose: its task text and skill cards, the organization's
own included, go only to the hosts that grant approves, each asked for zero
retention and no prompt training. Without that grant nothing is sent and the
search keeps the rule's list.
A card shows a skill's use and exclusion conditions only where the
platform generated them or a person reviewed them. A use condition only
promotes a result, and only an exclusion its author stated or a person
reviewed makes it `unlikely`; `applicability.provenance` says who stated
them.
Contextual continuation reminders also receive an opaque directive ID. Claude
preserves it in `client_context`, while `PostToolUse` provides a fallback
correlation after `query_skills`; the TTL-bound event contains no prompt text
and never affects trust or ranking.
For query fit, submit one complete verdict set of good/partial/poor labels per query from
the same organization scope or anonymous scope. Any active key for that
organization is valid. Identical retries are safe;
changed later judgments conflict, so leave uncertain results unrated instead of
submitting incrementally.
After use, pass the same `query_id`/`result_id` to categorical
`submit_feedback` so Remembrance can measure the surfaced-to-use funnel. Route
reusable prose separately through `capture_learning`; it does not belong in
post-use feedback. When delegating, give the selected slug and
IDs to the subagent or have it run its own full-context query.
Anonymous verdicts remain low weight and never train a shared model. No learned
reranker is trained or served; changing `agent_id` does not create another
feedback actor.
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
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook request timeout. The search waits
  `3000` by default, so the server's relevance judge can take its longer
  2,000 ms hook deadline when Jev leaves candidates undecided; the hook's
  other requests wait `2000`. A value applies to every hook request, and one
  under `3000` tells the server not to wait that long. A stopped search whose
  preference read and search both hang delays the prompt about 5 s.
- `REMEMBRANCE_AUTO_QUERY_HYGIENE=0`: also searches host-generated text a
  trigger word matches (a Codex commit or pull-request generation prompt, a
  subagent hand-back, pasted `git status` output, an explicit local skill
  invocation). By default only its skill search is skipped: the organization
  policy, required settings and preferences a search would carry still arrive.
- `REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=0`: searches only prompts a keyword
  trigger matches. By default the hook also searches any other task-shaped
  prompt of at least 40 characters (trigger reason `task_shape`); one-off fact
  questions, status acknowledgments, explicit skill references, host text and
  short follow-ups are decided as before. A task-shape search that finds
  nothing adds no no-match block, completion recovery or query-feedback request
  of its own; the organization policy, required settings, preferences and
  capture lines still arrive, and the server still records the missing-skill
  demand.
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
