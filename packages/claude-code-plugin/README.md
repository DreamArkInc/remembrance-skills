# Remembrance Native Agent Plugin

Installs the Remembrancer skill, starts a bundled Remembrance MCP server, and
adds two hooks that keep the registry loop symmetric: a `UserPromptSubmit` hook
that queries Remembrance before Claude Code or Codex reasons about tasks likely
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

For Codex:

```bash
codex plugin marketplace add dreamarkinc/remembrance-skills
codex plugin add remembrance@remembrance
```

If `codex` is not on your shell `PATH`, the macOS desktop app usually bundles
the CLI at `/Applications/Codex.app/Contents/Resources/codex`.

Codex installs the same native prompt/completion hooks, but its MCP registration
uses the hosted `https://remembrance.dev/api/mcp` endpoint instead of a local
`${PLUGIN_ROOT}` stdio path. That keeps auto-query and contribution prompts
first-class while avoiding client-specific plugin-root expansion failures.

The hook runs on every user prompt, but it only calls Remembrance when the prompt
mentions named services, APIs, CLIs, frameworks, deployment/CI/payment/migration
workflows, MCP/resource selection, UI/review work, or unfamiliar third-party
integrations. Short follow-ups such as "fix these issues" or "continue" inject
a full-thread query reminder without persisting or sending prior conversation.
It is enabled by default after install; set `REMEMBRANCE_AUTO_QUERY=0` to disable
network auto-query. The v0.1 heuristic is English-first, so multilingual
workflows should call `query_skills` explicitly when useful.

The `Stop` (completion) hook is the contribution mirror of the query hook. When a
session's transcript or runtime markers show Remembrance was used, or show that
a reusable task missed its query, it blocks the stop exactly once and asks the
agent to query/close the loop with redacted feedback or evidence.
It is loop-safe (it never re-blocks a stop that a hook already continued), fires
on the agent's final response each turn, and compares completed queries with
eligible reusable prompts. A long session can therefore recover each later
missed task without re-prompting the Stop retry itself. It never nags when
nothing new qualified, and it fails open. The agent can satisfy it by
contributing or by briefly declining. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable it.

The native Claude/OpenClaw plugin packages run the bundled MCP server from the
plugin directory and ship the canonical Remembrancer skill references/scripts.
The Codex plugin uses the hosted MCP endpoint for tool calls while keeping the
native hooks local. The Cursor plugin registers the MCP server through Cursor's
plugin `mcp.json`, ships an always-apply Cursor rule, and records both reusable
prompts and actual MCP use before recovering or contributing at Stop. None of
these require separate hand-edited `npx @remembrance-ai/mcp-server` setup. The
standalone npm MCP package remains available for clients without native plugin
support or for users who need the local-only `bootstrap_agent_identity` tool.
After install, the `remembrance` MCP server or endpoint should expose tools such
as `query_skills`, `submit_query_feedback`, `submit_feedback`,
`submit_remembrance`, `get_skill`, `get_resource`, `report_task_outcome`, and
`get_value_proof`, plus `list_skills` and `invoke_skill`; some clients display
those tools with a `remembrance.`
namespace. The local bundled server also exposes `bootstrap_agent_identity`.
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
For Codex, when `REMEMBRANCE_API_URL` points hooks at a non-default registry,
the hook reads `[mcp_servers.remembrance].url` from Codex config and only shows a
registry-split notice when the hosted MCP URL actually differs. If Codex MCP is
configured somewhere the hook cannot read, set `REMEMBRANCE_CODEX_MCP_URL` to
that MCP endpoint so the comparison is explicit.

If MCP tools are unavailable, use the REST contract from
`https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

Environment:

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_CODEX_MCP_URL`: Codex-only hosted MCP endpoint used only to
  verify hook/MCP registry alignment when the hook cannot read Codex config.
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
exports. Put org keys in `~/.claude/settings.json` (not
`~/.claude/settings.local.json`) and fully quit/relaunch:

```json
{
  "env": {
    "REMEMBRANCE_API_URL": "https://remembrance.dev",
    "REMEMBRANCE_API_KEY": "YOUR_ORG_KEY"
  }
}
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
