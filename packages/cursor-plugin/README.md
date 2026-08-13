# Remembrance Cursor Plugin

Installs the Remembrancer skill, a Cursor rule that tells the agent when to use
Remembrance, a managed MCP server definition, and hooks that close the feedback
loop after the agent uses Remembrance.

That loop runs both ways: Cursor reuses skills other agents already proved out,
and hands back what it learns so the next agent starts further ahead. Your agent
gets smarter, and the shared registry gets smarter with it.

## Install

Cursor plugins are installed from **Cursor > Customize > Plugins** or from an
organization/team marketplace. Search for **Remembrance** after the plugin is
published to your Cursor marketplace.

For local development against this repo, copy or symlink the package into
Cursor's local plugin directory:

```sh
mkdir -p ~/.cursor/plugins/local
ln -s /abs/path/to/remembrance/packages/cursor-plugin ~/.cursor/plugins/local/remembrance
```

Restart Cursor, then open **Customize > Plugins** and enable Remembrance.

At session start, Remembrance checks a credential-free public release manifest.
If a newer verified plugin exists, the agent tells the user to refresh the
Remembrance marketplace entry and choose **Update**, then fully quit and reopen
Cursor. Cursor has no documented scriptable plugin-update command, so
Remembrance does not invent or remotely supply one. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the advisory check.

Cursor installations from before this startup check existed still receive a
command-free update notice on their next successful Remembrance query. The
notice points to the normal marketplace flow and never invents a remote command.

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
and feedback remain private to the organization. Classification runs
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

## Organization key

The plugin-managed MCP server runs `npx -y @remembrance-ai/mcp-server`, which
reads the same Remembrance config as the other native plugins:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

After restart, run MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step if attention is required. Use `get_connection_status` only for lower-
level fields. Never
infer Cursor's plugin scope from `REMEMBRANCE_API_KEY` alone or from an
anonymous REST/browser probe; the diagnostic verifies the process that will
actually serve Cursor's tools without exposing the key.

For dev/self-hosted registries, add `apiUrl` to the same file:

```json
{ "apiKey": "YOUR_ORG_KEY", "apiUrl": "https://your-remembrance.example" }
```

This paired file binds the key to that destination. If environment variables
are used instead, set `REMEMBRANCE_API_KEY_ORIGIN` equal to the exact custom
`REMEMBRANCE_API_URL`. Remote registries require HTTPS; a trusted private or
link-local self-host also requires `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`.

Every organization query returns `skill_access`. If its policy is `org_only`,
Cursor uses only returned organization skills and never substitutes bundled or
live public skill references. A query failure does not block the user's work,
but it fails closed for public-skill fallback until the organization policy can
be confirmed.

### Private repository contributions

When the organization has approved Remembrance as a destination, Cursor should
use `propose_private_skill` for repository-derived instructions. That tool
requires organization authentication and can only create a private review
candidate. Cursor or enterprise network policy may still deny the export before
Remembrance receives it; that denial is not an API failure and must not be
worked around with another network transport.

For managed Cursor rollout, publish Remembrance through a team marketplace as
`Required` or `Default On`. Register the same Remembrance MCP endpoint under
**Dashboard > Integrations & MCP** for cloud agents, the Agents window, IDE,
and CLI, and allow `remembrance.dev` in the enterprise sandbox network policy
for command-based fallback paths. Cursor's current public enterprise docs do
not define a managed per-MCP-tool allowlist equivalent to Codex, Claude Code,
Gemini CLI, or OpenClaw, so keep normal tool approvals enabled rather than
claiming a nonexistent control. Verify query, invocation, feedback, and private
contribution receipts separately on local and cloud surfaces.
The shared organization tool inventory and host-by-host policy references are
in `skills/remembrancer/references/remembrance-setup.md` and the live guide at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>.

With an organization key, generic `propose_skill_idea` also stays private.
Never remove or bypass the key to force a public candidate; submit privately,
then use the reviewed public-propagation flow.

If export remains blocked, the plugin reports one local, content-free alert:
**Remembrance was blocked by host policy before reaching Remembrance. Nothing
was sent. Querying remains available.** It does not retry or automatically
create a handoff. Only when an organization admin explicitly requests one, use
local MCP `queue_private_skill_import`. It writes a mode-0600 JSON handoff under
the user's fixed Remembrance state directory and contacts no network. The admin
can upload that file at **Dashboard > Skills > Import**, where each skill
follows the normal private verification flow. Hosted/cloud agents without the
local tool can run the bundled
`skills/remembrancer/scripts/queue-private-skill-import.mjs` script. A local
queue receipt is not a server submission receipt.

## What the plugin does

- `rules/remembrance-auto-query.mdc` is always applied and tells Cursor to call
  the Remembrance MCP `query_skills` tool before reusable service/API/tool,
  workflow, deployment, MCP, resource-selection, dashboard, UI/UX, review,
  test, and security tasks, including short follow-ups interpreted from the full
  conversation.
- `mcp.json` registers the Remembrance MCP server through the plugin, so users do
  not have to hand-edit `~/.cursor/mcp.json` for the standard install path.
- `sessionStart` adds compact session context. Cursor's documented
  `beforeSubmitPrompt` output can block or show a message, but cannot inject
  prompt-specific context, so the rule plus MCP server is the low-friction path.
- `beforeSubmitPrompt` observes relevant/contextual prompts without modifying
  them and records an eligibility marker so the stop hook can recover a missed
  query.
- `afterMCPExecution` records when the agent used `query_skills`, `get_skill`,
  `get_resource`, or successfully loaded an explicit selection through
  `invoke_skill`. `list_skills` and MCP resource-handle reads do not count as
  use. If the agent later calls a contribution tool, the hook marks that use as
  already handled.
- `propose_private_skill` is the explicit organization-only submission path.
  Local MCP also provides the zero-network `queue_private_skill_import` tool
  for an explicitly requested administrator handoff.
- When a person explicitly names a skill or supplies a
  `remembrance://skills/{slug}` URI, Cursor resolves ambiguity with
  the indexed, normalized slug-prefix filter in `list_skills`, then calls
  `invoke_skill` with an exact returned slug. It uses `query_skills` for
  discovery and never runs a relevance query merely to rediscover the
  selection. Direct selections use post-use feedback, not query-fit feedback.
- Returned result IDs let Cursor call `submit_query_feedback` for explicit
  good/partial/poor query matches before using a skill; post-use quality stays
  on `submit_feedback`. Cursor should send one complete verdict set per query
  from the same organization scope or anonymous scope; any active key for that
  organization is valid. Identical retries are safe, while changed later
  judgments conflict.
  Anonymous verdicts remain low weight and never train the shared reranker.
  Shared training uses only public-result comparisons from multiple
  authenticated organization keys across multiple organizations; changing
  `agent_id` does not create another feedback actor.
- Results also carry a high/possible/exploratory tier, concise reason, bounded
  `why_matched` terms/capabilities/constraint evidence, conservative
  `applicability` scope and use/exclusion conditions, metadata digests,
  approximate context tokens, verified-use evidence, and risk. Cursor should
  rule out an unlikely or irrelevant corner-case result and report query fit
  `poor`, then open a remaining high match with `get_skill`/`get_resource` and its `query_id`/`result_id`
  before custom work; lower tiers remain optional. Pass the same IDs to
  `submit_feedback` after use and to delegated agents when applicable. The
  `afterMCPExecution` hook clears the reminder only for that exact successful
  detail open.
- Exact, current, non-high-risk matches may also carry a compact token-only
  `potential_savings` estimate when fresh grade A/B proof exists for the
  observed model revision, reasoning effort, and bounded task cohort.
  `get_value_proof` cryptographically verifies the signed receipt and returns
  `signature_verified: true` plus `verification_key_id`; its signed cohort fields
  include task domain, stage, complexity, and bounded scope counts. Cursor's lifecycle hook
  reports a bounded task outcome when
  the host provides completion data; raw MCP callers can use
  `report_task_outcome` with only IDs from `task_outcome.eligible_result_ids`.
  Every result and bundle also carries `task_outcome_eligible`. Neither path
  sends prompts, transcripts, outputs, source paths, or private URLs, and
  collection mode exposes no money fields.
  Private-skill receipts require an active query-capable API key from the same
  organization; it need not be the key used for the original query. They remain
  workspace-only and never enter public cohorts.
  When Vercel AI Gateway handled the task, include every generation ID in
  `metering_reference`; Remembrance encrypts the references and promotes usage
  only after all generations reconcile through Vercel.
- `beforeSubmitPrompt` records an opaque shown directive for each eligible task
  because Cursor's always-apply rule is the instruction surface.
  `afterMCPExecution` correlates the next successful `query_skills` call. Fresh
  directives remain pending until their bounded follow window closes; the
  telemetry contains no prompt text and never affects ranking.
  `REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS` controls the fail-open request
  timeout (default `750`, bounded to `100`-`2000` milliseconds).
- `stop` sends one `followup_message` asking for a full-context query and
  redacted contribution when Remembrance was used or an eligible task missed
  its query. It also asks once about an unopened high match so Cursor can fetch
  it or report explicit poor-fit feedback, unless an explicit contribution
  already handled the task. The compact follow-up keeps routine hook narration,
  tool receipts, and correlation IDs out of the agent's final answer; only a
  failure, host-policy block, or required user action is surfaced.

## Cursor docs alignment

This package follows Cursor's documented plugin structure:

- `.cursor-plugin/plugin.json` is the required plugin manifest.
- `skills/`, `rules/`, `hooks/hooks.json`, and `mcp.json` use Cursor's automatic
  component discovery.
- Hook scripts communicate over stdin/stdout JSON.
- `sessionStart`, `beforeSubmitPrompt`, `afterMCPExecution`, and `stop` are
  Cursor agent hooks.
- Cursor now documents conversation hooks for cloud agents, but a local plugin
  install does not automatically provision cloud agents. Distribute the plugin
  through a team marketplace, register Remembrance under **Dashboard >
  Integrations & MCP**, and verify query, invocation, feedback, and contribution
  receipts on both local and cloud surfaces.

References:

- https://cursor.com/docs/reference/plugins.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/mcp.md
- https://cursor.com/changelog/team-marketplace-updates
- https://cursor.com/changelog/side-chat

## Test

```sh
npm test -w @remembrance/cursor-plugin
```
