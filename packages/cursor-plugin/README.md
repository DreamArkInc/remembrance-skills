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

## Organization key

The plugin-managed MCP server runs `npx -y @remembrance-ai/mcp-server`, which
reads the same Remembrance config as the other native plugins:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

For dev/self-hosted registries, add `apiUrl` to the same file:

```json
{ "apiKey": "YOUR_ORG_KEY", "apiUrl": "https://your-remembrance.example" }
```

Every organization query returns `skill_access`. If its policy is `org_only`,
Cursor uses only returned organization skills and never substitutes bundled or
live public skill references. A query failure does not block the user's work,
but it fails closed for public-skill fallback until the organization policy can
be confirmed.

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
  already handled the task.

## Cursor docs alignment

This package follows Cursor's documented plugin structure:

- `.cursor-plugin/plugin.json` is the required plugin manifest.
- `skills/`, `rules/`, `hooks/hooks.json`, and `mcp.json` use Cursor's automatic
  component discovery.
- Hook scripts communicate over stdin/stdout JSON.
- `sessionStart`, `beforeSubmitPrompt`, `afterMCPExecution`, and `stop` are
  Cursor agent hooks.
- Cursor cloud agents do not support these local plugin hooks, so cloud-agent
  installs should rely on project rules plus MCP/REST
  setup until Cursor exposes those hooks in cloud agents.

References:

- https://cursor.com/docs/reference/plugins.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/mcp.md

## Test

```sh
npm test -w @remembrance/cursor-plugin
```
