# Remembrance Codex Plugin

Ports the [Remembrance Claude Code plugin](../claude-code-plugin) to the OpenAI
Codex CLI. It installs the Remembrancer skill, a bundled local Remembrance MCP
server, and lifecycle hooks that keep the registry loop symmetric: a
`UserPromptSubmit` hook that queries Remembrance before Codex reasons about tasks
likely to involve reusable skills/resources, and a `Stop` hook that — when a
session used Remembrance or a reusable task missed its query — prompts Codex
once to close the loop instead of silently moving on.

Both halves compound: each query reuses work another agent already finished, and
each contribution back sharpens the registry the next Codex session will query.
Your agent keeps getting smarter, and so does the network behind it.

## Install (marketplace)

```bash
codex plugin marketplace add dreamarkinc/remembrance-skills
codex plugin add remembrance@remembrance
```

If your shell prints `codex: command not found`, the macOS desktop app may have
the CLI bundled without a shell alias. Use the app-bundled CLI path, then rerun
the same commands:

```bash
CODEX_CLI="/Applications/Codex.app/Contents/Resources/codex"
"$CODEX_CLI" plugin marketplace add dreamarkinc/remembrance-skills
"$CODEX_CLI" plugin add remembrance@remembrance
```

Plugin-bundled hooks require a **one-time trust** the first time you run Codex
after installing: Codex prompts you to approve the plugin's hooks and MCP
endpoint before it will execute them. Approve once and it is remembered.

After install, fully restart Codex and verify the loop before assuming the
plugin is active:

1. Ask Codex: "Before solving, call Remembrance query_skills for Codex plugin
   setup."
2. Ask it to call `get_connection_status`. Confirm the active MCP transport and
   verified registry scope; do not accept an environment-variable check or an
   anonymous curl/browser probe as a substitute.
3. Confirm it reports a concrete Remembrance receipt such as a query id,
   returned skill slug, MCP tool result, or REST status.
4. After it evaluates returned results, confirm it calls
   `submit_query_feedback` for explicit good/partial/poor matches. After it
   actually uses a skill/resource, confirm it calls `submit_feedback` and, when
   the lesson is reusable, `submit_remembrance`.

If Codex can see the plugin skill but not the MCP tools, the hooks can still use
the REST fallback, but that should be treated as degraded until the trust prompt,
restart, and MCP registration are fixed.

## Manual install (config.toml)

If you prefer not to use the marketplace, wire the hooks into
`~/.codex/config.toml` directly. Replace `/abs/path/to/codex-plugin` with the
absolute path to this package. The bundled `hooks/hooks.json` uses
`${CODEX_PLUGIN_ROOT}` (the plugin-root variable Codex sets for
marketplace-installed plugins), so a manual hook install must use a literal
absolute path instead.

```toml
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"
[[hooks.SessionStart.hooks]]
type = "command"
command = 'node "/abs/path/to/codex-plugin/scripts/session-start.mjs"'

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "/abs/path/to/codex-plugin/scripts/query-on-prompt.mjs"'

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = 'node "/abs/path/to/codex-plugin/scripts/contribute-on-stop.mjs"'

[mcp_servers.remembrance]
command = "node"
args = ["/abs/path/to/codex-plugin/servers/remembrance-mcp.mjs"]
env = { REMEMBRANCE_PLUGIN_HOST = "codex" }

```

The bundled local MCP server and native hooks both resolve
`REMEMBRANCE_API_KEY` first, then `~/.config/remembrance/config.json`. This
removes the Codex Desktop environment split: one mode-0600 config file covers
both. After restart, call `get_connection_status`; it reports
`local_stdio_mcp`, registry scope, credential source, and observed native
lifecycle components without exposing the key. A manually configured hosted
MCP URL remains supported, but it cannot read a caller file and must receive a
request credential. A Codex tenant/privacy-policy denial occurs before the
Remembrance request and must not be reported as a Remembrance authentication or
authorization rejection.

For private repository-derived skills, the preferred remote write is
`propose_private_skill`. It requires an organization key and can only create a
candidate in that organization's private review queue. Codex workspace admins
must still approve `remembrance.dev` as a trusted destination in managed MCP,
network (when command networking is used), and Auto-review guardian policy. The
narrow policy example is in the bundled
`skills/remembrancer/references/remembrance-setup.md`; merge it into the
existing tenant policy instead of replacing credential and source-code deny
rules.

For managed Codex, configure both policy layers before rollout:

- in `requirements.toml`, allow the exact plugin MCP identity
  `https://remembrance.dev/api/mcp` under
  `plugins."remembrance@remembrance".mcp_servers.remembrance`;
- in managed config, set `enabled_tools` to the bounded organization tool set
  in the bundled setup reference and use
  `default_tools_approval_mode = "writes"`;
- merge the Remembrance destination clause into `guardian_policy_config` and
  allow `remembrance.dev` for command networking only when stdio/REST fallback
  needs it; and
- do not set `allow_managed_hooks_only = true` unless equivalent managed query
  and completion hooks are deployed, because Codex otherwise skips plugin
  hooks.

With an organization key, generic `propose_skill_idea` calls also stay in the
organization review queue. Never remove or bypass the key to force a public
candidate; submit privately, then use the reviewed public-propagation flow.
The exact TOML, approved tool inventory, and official documentation links are
in `skills/remembrancer/references/remembrance-setup.md`. The same current,
host-by-host administrator guide is published at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>.

If the host keeps denying the export, do not retry through curl, browser tools,
or a different MCP transport. Use the local-only `queue_private_skill_import`
tool when available. Hosted-only Codex can run the bundled
`skills/remembrancer/scripts/queue-private-skill-import.mjs` helper against a
local request JSON. It writes a mode-0600 file under
`.remembrance/outbox/`, creates a protective `.gitignore`, and makes no network
request. An organization admin then uploads that file at Dashboard > Skills >
Import. The handoff is not a submission until the dashboard returns a batch
receipt.

Note the underscore: Codex configures MCP servers under `[mcp_servers.<id>]`,
not `mcpServers`.

## Behavior

The `UserPromptSubmit` hook runs on every user prompt but only calls Remembrance
when the prompt mentions named services, APIs, CLIs, frameworks,
deployment/CI/payment/migration workflows, MCP/resource selection, UI/review
work, or unfamiliar third-party integrations. For context-only follow-ups such
as "fix these issues", "continue", or "try again", it injects an instruction to
infer the task from the full thread and call `query_skills`; prior conversation
text is not persisted or sent automatically. On a query hit it prints the
wrapped hook output
`{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}`
(the same shape Claude Code requires) so Codex injects the matching
skills/resources. It is enabled by default; set
`REMEMBRANCE_AUTO_QUERY=0` to disable network auto-query. The v0.1 heuristic is
English-first, so multilingual workflows should call `query_skills` explicitly
when useful.

The `Stop` (completion) hook is the contribution mirror and recovery path. When
the session used Remembrance, or when the prompt hook marked a reusable task but
no query completed, it returns
`{"decision":"block","reason":"..."}` exactly once and asks Codex to submit a
redacted remembrance / feedback / skill idea — so contribution is prompted by
default instead of relying on the agent to remember. It is loop-safe: Codex sets
`stop_hook_active=true` on the continuation a Stop-block causes, so it never
re-blocks a stop it already continued. Codex can satisfy it by contributing or by
briefly declining. Set `REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable it.

### How usage is detected without a transcript

The Claude plugin decides whether to prompt for a contribution by scanning the
session transcript for registry-consumption markers. Codex's `Stop` payload has
**no transcript path**, so this plugin uses a marker mechanism instead
(`scripts/hook-core.mjs`):

- The query adapter calls `recordRegistryUse(sessionId)` whenever a registry
  query completes, incrementing a per-session counter file under
  `os.tmpdir()/remembrance-usage/<hash>.use`.
- Relevant and contextual prompts call `recordTaskEligibility(sessionId)`,
  incrementing a `<hash>.eligible` counter even when the query is missed or
  unavailable. Later tasks in the same session therefore remain recoverable.
- The stop adapter reads that count via `readRegistryUseCount(sessionId)` and
  combines it with eligibility before comparing the result to the
  last-prompted sentinel (`<hash>.prompt`). It blocks once for either a new use
  or an unclosed eligible task, then records the handled count.

Both hooks **fail open**: they never block the user's work on API errors. A
timeout, HTTP error, or malformed response injects compact recovery guidance
instead of pretending Remembrance was used; unrelated prompts still inject
nothing. Prompt text is redacted for common secrets and private-network URLs
before any query is sent.

## MCP tools

The plugin is self-contained for Codex behavior: it installs the local hooks
that make Remembrance proactive and registers its bundled local MCP server. It
does not require separate `npx @remembrance-ai/mcp-server` setup or a GUI
process environment variable. After install, the `remembrance` MCP server
exposes tools such as `query_skills`, `submit_query_feedback`,
`submit_feedback`, `submit_remembrance`, `get_skill`, `get_resource`,
`list_skills`, `invoke_skill`, `report_task_outcome`, `get_value_proof`, and
`get_connection_status`.

Credential and lifecycle boundaries are observable. `get_connection_status`
identifies transport, scope, credential source, and whether SessionStart,
prompt, tool-observer, and completion hooks have actually run. A missing native
marker is reported as degraded instead of allowing visible filesystem skills
to imply a healthy install. Degraded checks send only bounded component and
version issue codes for deduplicated admin triage; disable this best-effort
report with `REMEMBRANCE_HEALTH_REPORTING=0`. Never infer plugin scope from
`REMEMBRANCE_API_KEY` alone, and never use an anonymous REST/browser probe to
characterize another transport.

When the user explicitly names a Remembrance skill or supplies a
`remembrance://skills/{slug}` URI, Codex resolves ambiguous names with
the indexed, normalized slug-prefix filter in `list_skills`, then calls
`invoke_skill` with an exact returned slug instead of running a relevance query
to rediscover the selection. Use `query_skills` for discovery. Invocation
rechecks current organization policy,
loads the active reviewed version, and starts the post-use feedback/outcome
loop. Catalog and resource-handle reads never contain the full private body and
do not count as use. Direct selections use post-use feedback, never query-fit
feedback.

Every successful `query_skills` response includes a contribution directive. The
prompt hook injects that directive with the returned skills/resources so Codex is
shown a high/possible/exploratory tier, concise match reason, bounded
`why_matched` terms/capabilities/constraint evidence, conservative
`applicability` scope and use/exclusion conditions, metadata digests,
approximate context tokens, verified-use evidence, risk, and correlation IDs.
Codex first rules out an unlikely or irrelevant corner-case result and reports
query fit `poor`. A remaining high match is a required next step: Codex opens it with `get_skill` or `get_resource` and its
`query_id`/`result_id` before custom work; possible and exploratory matches remain
optional. Codex is then reminded in-band to report query fit with
`submit_query_feedback`, then close
the post-use loop with `submit_feedback`, `submit_remembrance`, or
`propose_skill_idea`; the Stop hook is a safety net, not the only contribution
path. At completion it asks once about an unopened high match so Codex can fetch
it or report explicit poor-fit feedback. A `PostToolUse` hook clears the marker
only after the same slug and `query_id`/`result_id` open successfully.
For contextual continuation prompts, the hook also records an opaque directive
as shown. The next `query_skills` call carries that ID or is correlated by the
same `PostToolUse` observer, producing a real shown-to-followed compliance rate
without storing prompt text or affecting ranking.
Post-use feedback carries the same `query_id`/`result_id`,
and delegated agents receive the selected slug and IDs or run their own query.
Query-fit feedback is one complete verdict set of good/partial/poor labels per
query and must use the same organization scope or anonymous scope. Any active
key for that organization is valid. Identical retries are safe; changed later
judgments conflict, so uncertain results should remain unrated instead of being
appended later.
Anonymous verdicts remain low weight and never train the shared reranker.
Shared training uses only public-result comparisons from multiple authenticated
organization keys across multiple organizations; changing `agent_id` does not
create another feedback actor.

When an exact, current, non-high-risk match has fresh grade A/B evidence for the
observed model revision, reasoning effort, and bounded task cohort, the result
may include one compact
token-only `potential_savings` estimate. The hook displays it without adding
money or commerce language. Codex then reports a bounded completion outcome
automatically when its runtime exposes lifecycle data; otherwise the MCP
`report_task_outcome` tool can close the episode using only IDs listed in
`task_outcome.eligible_result_ids`; every result and bundle also carries
`task_outcome_eligible`. No prompt, transcript, output,
source path, or private URL is included. `get_value_proof` cryptographically
verifies the signed receipt behind a qualified estimate and returns
`signature_verified: true` plus `verification_key_id`; its signed cohort fields
include task domain, stage, complexity, and bounded scope counts.
Private-skill receipts
require an active query-capable API key from the same organization; it need not
be the key used for the original query. They remain workspace-only and never
enter public cohorts. When Codex uses Vercel AI Gateway, include
every task generation ID in `metering_reference`; Remembrance encrypts those
references and trusts token totals only after Vercel independently returns and
single-claims all of them.

The bundled local server can mint a TOFU key with
`bootstrap_agent_identity`. A manual hosted-MCP override cannot write a key on
your machine; use the bundled server for that operation.

When `REMEMBRANCE_API_URL` points hooks at a non-default registry, the hook reads
`[mcp_servers.remembrance].url` from Codex config and compares it with the hook
API URL. It only shows a registry-split notice when the two resolved URLs differ.
If your Codex MCP URL is configured somewhere the hook cannot read, set
`REMEMBRANCE_CODEX_MCP_URL` to that MCP endpoint so the comparison is explicit.

If MCP tools are unavailable, use the REST contract from
`https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

## Environment

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_CODEX_MCP_URL`: optional manual Codex hosted-MCP endpoint used
  only to verify hook/MCP registry alignment when the hook cannot read Codex
  config. The packaged plugin does not need it.
- `REMEMBRANCE_HEALTH_REPORTING=0`: disables bounded degraded-activation
  reporting. Local health status remains available.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the prompt hook's network query.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook query timeout, default `2000`.
- `REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS`: fail-open shown/followed event
  timeout, default `750`, bounded to `100`-`2000` milliseconds.
- `REMEMBRANCE_AUTO_CONTRIBUTE=0`: disables the completion contribution prompt.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

With an organization key, every query returns `skill_access`. If its policy is
`org_only`, Codex uses only returned organization skills and never substitutes
bundled or live public skill references. Query failures still do not block the
user's work, but they fail closed for public-skill fallback until the
organization policy can be confirmed.

## Generated / copied files

`servers/remembrance-mcp.mjs` and the entire `skills/remembrancer/` tree are
**copied verbatim from the canonical source** — the same bundled artifacts the
Claude Code plugin ships (see `packages/claude-code-plugin/scripts/refresh-mcp-bundle.mjs`,
which builds `packages/mcp-server` and copies `skills/remembrancer/` from the
repo root). Do not edit them here; refresh the Claude plugin's bundle and re-copy
these files whenever `packages/mcp-server` or `skills/remembrancer` changes.
