# Remembrance for OpenClaw

Give [OpenClaw](https://docs.openclaw.ai) shared operational memory.
Remembrance helps your agent reuse reviewed skills, trusted resources, and
team-specific lessons before it spends tokens solving a workflow from scratch
again.

Every reuse saves your agent from re-solving a problem it — or another agent —
already worked out; every lesson it contributes back sharpens the shared
registry for the next one. Your agent gets smarter and smarter, and the network
gets smarter and smarter with it.

Install the plugin once, then OpenClaw can:

- find relevant Remembrance skills before service, API, CI/CD, migration,
  payment, deployment, MCP, or unfamiliar integration work;
- use public registry knowledge, plus private organization knowledge when you
  provide an enterprise key;
- expose Remembrance MCP tools for direct lookup, feedback, and skill
  submission; and
- ask once at the end of a useful session whether the agent should contribute
  what it learned back to the registry.

The hooks are quiet by default. They query prompts that look reusable, inject a
full-thread query reminder for context-only follow-ups, redact common secrets
before sending text, and fail open with recovery guidance if Remembrance is
unavailable.

## Install from ClawHub

```bash
openclaw plugins install clawhub:@remembrance/openclaw-plugin
openclaw remembrance setup
```

The setup command preserves existing OpenClaw settings, enables the required
conversation-hook permission, and registers this installed package's bundled
local MCP server by its absolute path. It does not copy your organization key
into OpenClaw config.

If you only want public registry results, the plugin can run without a key. For
private team memory, create an enterprise key in the Remembrance dashboard and
make it available to OpenClaw:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

In a centrally managed environment, the setup command's equivalent
conversation-access setting in `~/.openclaw/openclaw.json` is:

```json5
{
  plugins: {
    entries: {
      remembrance: {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {},
      },
    },
  },
}
```

Restart OpenClaw after setup or key changes, then verify both surfaces:

```bash
openclaw plugins inspect remembrance --runtime --json
openclaw mcp doctor remembrance --probe
```

Then run Remembrance MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step without exposing the key. Use `get_connection_status` only for lower-
level fields. Do not conclude that OpenClaw is
anonymous from an unset `REMEMBRANCE_API_KEY` or an anonymous curl/browser
probe; those do not test the bundled plugin process.

When the plugin runtime starts, it performs a bounded, credential-free release
check. If a newer verified version exists, the agent asks before running
`openclaw plugins update remembrance` and `openclaw remembrance setup`, then
tells the user to restart the Gateway unless the managed reload already did so
and to begin a new session. Remembrance never updates silently. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the advisory check.

OpenClaw installations from before this startup check existed still learn about
a verified update on their next successful Remembrance query. The API places a
command-free notice first in the legacy contribution directive; only this
installed plugin supplies the trusted local update commands.

### Private repository contributions

After the organization approves Remembrance as a destination, use
`propose_private_skill` for repository-derived instructions. It requires the
organization key and can only create a private review candidate. OpenClaw's
conversation access setting lets the plugin observe prompts; it does not
override a gateway, sandbox, or enterprise egress denial. Never retry denied
private content through a different network transport. On a classified denial,
the plugin reports one local, content-free alert: **Remembrance was blocked by
host policy before reaching Remembrance. Nothing was sent. Querying remains
available.**

For a managed Gateway, add `remembrance` to `plugins.allow`, keep it out of
`plugins.deny`, enable `plugins.entries.remembrance`, and retain
`hooks.allowConversationAccess: true`. Use a normal `coding` or `messaging`
tool profile: `minimal` hides MCP tools, while
`tools.deny: ["bundle-mcp"]` disables them. Filter the saved
`mcp.servers.remembrance` entry with `toolFilter.include` using the bounded
organization tool list in
`skills/remembrancer/references/remembrance-setup.md` or the live guide at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>, then
verify both the live plugin and MCP connection:

```bash
openclaw plugins inspect remembrance --runtime --json
openclaw mcp status --verbose
openclaw mcp doctor remembrance --probe
```

The standalone OpenClaw policy file can require the `remembrance` server as a
conformance check, but runtime availability still depends on plugin enablement,
the active tool profile, `tools.deny`, and `toolFilter`. With an organization
key, generic `propose_skill_idea` stays in the private review queue. Never
remove or bypass the key to force a public candidate; use reviewed public
propagation after private review.

The plugin does not automatically create a handoff. Only when an organization
admin explicitly requests one, the bundled local MCP server exposes
`queue_private_skill_import`. It contacts no network and writes a mode-0600 JSON
handoff under the user's fixed Remembrance state directory. The admin can upload
the file at **Dashboard > Skills > Import**, where each skill enters the normal
private verification queue. If only the skill bundle is available, run
`skills/remembrancer/scripts/queue-private-skill-import.mjs` instead. The agent
must not report a successful submission until the dashboard returns an import
receipt.

If `openclaw plugins search remembrance` returns unrelated packages, such as a
genealogy/roots package, do not install them. The official package is
`clawhub:@remembrance/openclaw-plugin`, points to
`https://github.com/dreamarkinc/remembrance-skills`, and describes the
Remembrance agent skill/resource service.

To pin a specific published version, see the version selector on the plugin's
ClawHub release page. The normal install path should use the latest official
`clawhub:@remembrance/openclaw-plugin` package unless a rollout explicitly
requires a pinned version.

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

## What it does

Remembrance uses two conversation hooks plus one tool observation hook:

- **Before a prompt:** the plugin checks whether the work looks like something
  that could benefit from reusable guidance. If it finds matching skills or
  resources, it injects a compact context block before OpenClaw reasons. A short
  follow-up such as "fix these issues" instead receives an instruction to infer
  the concrete task from the full conversation and query directly.
- **Before final answer:** if the session used Remembrance or a reusable task
  missed its query, the plugin asks OpenClaw once to close the loop with a query,
  redacted feedback, a reusable lesson, or a missing skill idea.
- **After a detail tool:** a successful correlated `get_skill` or `get_resource`
  clears that high-match reminder. A successful `invoke_skill` records the
  explicit selection, marks its outcome selected, and starts one post-use
  feedback prompt. Catalog browsing and resource-handle reads do not count.

This creates the loop you want from an agent memory system: use reviewed
knowledge when it exists, and improve the registry when the agent learns
something worth reusing. Every agent that contributes raises the floor for the
next agent that queries — the more the network is used, the smarter it gets.

## Conversation access

This is a **non-bundled plugin**. OpenClaw requires explicit opt-in before
non-bundled plugins can receive raw conversation content. Remembrance needs that
access because `before_prompt_build` reads the prompt and
`before_agent_finalize` inspects the final answer.

Without `allowConversationAccess: true`, OpenClaw will not deliver prompt or
answer text to these hooks. The plugin will no-op instead of breaking the run.

> "Non-bundled plugins that need raw conversation hooks (`before_model_resolve`,
> `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
> `agent_end`, or `before_agent_run`) must set … `allowConversationAccess`."
> — [Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
> [Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference).

## MCP tools

The plugin ships a self-contained Remembrance MCP server
(`servers/remembrance-mcp.mjs`). The hooks provide automatic behavior; the MCP
server gives OpenClaw direct tools such as `run_connection_doctor`, `get_connection_status`,
`query_skills`, `bootstrap_agent_identity`, `submit_query_feedback`, `submit_feedback`,
`submit_remembrance`, `get_skill`, `get_resource`, `report_task_outcome`, and
`get_value_proof`, plus `list_skills`, `invoke_skill`, and the
organization-only `propose_private_skill`. Local MCP also includes
`queue_private_skill_import`, which never contacts Remembrance.

When a person explicitly names a Remembrance skill or supplies a
`remembrance://skills/{slug}` URI, OpenClaw resolves ambiguous names with
the indexed, normalized slug-prefix filter in `list_skills`, then calls
`invoke_skill` with an exact returned slug. It uses `query_skills` for
discovery, but never merely to rediscover that explicit selection. Invocation
rechecks current policy and loads the active reviewed version; direct
selections use post-use feedback and never query-fit feedback.

For query fit, OpenClaw should send one complete verdict set of good/partial/poor labels
per query from the same organization scope or anonymous scope. Any active key
for that organization is valid. Identical retries are safe; changed later
judgments conflict, so uncertain results stay unrated instead of being appended
later. Post-use quality belongs on `submit_feedback`.
Query results also carry a high/possible/exploratory tier, concise reason,
bounded `why_matched` terms/capabilities/constraint evidence, conservative
`applicability` scope and use/exclusion conditions, metadata digests,
approximate context tokens, verified-use evidence, risk, and correlation IDs.
OpenClaw should rule out an unlikely or irrelevant corner-case result and
report query fit `poor`, then open a remaining high match with `get_skill`/`get_resource` and its
`query_id`/`result_id`
before custom work; lower tiers remain optional. Pass those IDs to
`submit_feedback` after use and to delegated agents. At completion, the hook
asks once about an unopened high match so OpenClaw can fetch it or report
explicit poor-fit feedback.
Anonymous verdicts remain low weight and never train the shared reranker.
Shared training uses only public-result comparisons from multiple authenticated
organization keys across multiple organizations; changing `agent_id` does not
create another feedback actor.

An exact, current, non-high-risk match may include one compact token-only
`potential_savings` estimate when fresh grade A/B proof exists for the observed
model revision, reasoning effort, and bounded task cohort. `get_value_proof`
cryptographically verifies its signed receipt, including the task domain,
stage, complexity, and bounded scope counts. OpenClaw reports a bounded
completion outcome through its lifecycle
hook when host data permits; raw MCP callers can use `report_task_outcome` with
only IDs from `task_outcome.eligible_result_ids`. Every result and bundle also
carries `task_outcome_eligible`.
Neither path sends prompts, transcripts, outputs, source paths, or private URLs,
and collection mode exposes no money or payment fields. Private-skill receipts
require an active query-capable API key from the same organization; it need not
be the key used for the original query. They remain workspace-only and never
enter public cohorts. Successful proof retrieval returns
`signature_verified: true` plus `verification_key_id`. For Vercel AI Gateway
work, pass every task generation ID in `metering_reference`; Remembrance
encrypts the references and trusts token totals only after every generation is
independently reconciled and single-claimed.

OpenClaw configures MCP servers under **`mcp.servers.<id>`** (not `mcpServers`
like Claude, nor `mcp_servers` like Codex) in `~/.openclaw/openclaw.json`
([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference),
[MCP CLI](https://docs.openclaw.ai/cli/mcp)). `openclaw.mcp.json` in this package
is an **illustrative** merge fragment. OpenClaw only expands real uppercase
`${VAR}` values and does **not** define an `${OPENCLAW_PLUGIN_ROOT}` variable, so
the `args` path must be an **absolute path** — replace
`/abs/path/to/openclaw-plugin` with the real absolute path to this package before
merging into `~/.openclaw/openclaw.json`. Normal installs should run
`openclaw remembrance setup` instead:

```json5
{
  mcp: {
    servers: {
      remembrance: {
        command: "node",
        // Absolute path — OpenClaw does not expand a plugin-root variable here.
        args: ["/abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs"],
        env: {
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_API_KEY: "YOUR_ORG_KEY",
        },
      },
    },
  },
}
```

Or add it via the CLI (`--command` for the executable, one `--arg` per argument;
`--env` / `--cwd` are optional):

```bash
openclaw mcp add remembrance \
  --command node \
  --arg /abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs
```

If MCP tools are unavailable, the plugin hooks can still run. For raw REST usage,
use `https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

## Maintainers: publish to ClawHub

Everything above is for installing and using the plugin. This section is for
maintainers publishing a new ClawHub release.

Code plugins publish through the ClawHub CLI with the `code-plugin` family
([ClawHub quickstart](https://github.com/openclaw/clawhub/blob/main/docs/quickstart.md)):

```bash
clawhub login              # or: clawhub login --token clh_...
clawhub package publish . --family code-plugin --dry-run   # preview metadata
clawhub package publish . --family code-plugin             # publish
```

Code plugins must carry OpenClaw compatibility metadata in `package.json`
(`openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`) — present in
this package's `package.json`.

If the ClawHub web flow asks for a `plugins/` folder instead of a package
directory, generate the upload shape from the repo root:

```bash
npm run prepare:openclaw-clawhub
```

Upload:

```text
dist/openclaw-clawhub/plugins
```

That folder contains:

```text
plugins/remembrance
```

The generated package strips repo-only fields such as `private`, `scripts`, and
`devDependencies`, keeps the manifest and package versions synced, and points
the package metadata at `https://github.com/dreamarkinc/remembrance-skills`.
Regenerate it for every ClawHub update; never hand-edit the dist folder.

Production CI publishes future versions automatically when `CLAWHUB_TOKEN` is
configured in CircleCI:

```bash
npm run publish:openclaw-clawhub
```

The publish script validates and packs the generated package, resolves the
already-published `master` commit from
`dreamarkinc/remembrance-skills`, verifies that
`packages/openclaw-plugin/package.json` at that commit has the exact release
version, and attaches that public commit as source provenance. It dry-runs the
ClawHub publish, waits through staged security checks until the exact version
is publicly inspectable, and skips cleanly when the package version already
exists. The release-channel status marker separately retains the originating
CircleCI build SHA so the final fan-in gate cannot reuse another deployment's
success.

## Behavior

The pre-prompt hook runs before every model turn but only calls Remembrance when
the prompt mentions named services, APIs, CLIs, frameworks,
deployment/CI/payment/migration workflows, MCP/resource selection, or unfamiliar
third-party integrations. It also recognizes common context-only continuation
phrases. On a hit or continuation it returns
`{ appendSystemContext: "..." }` so OpenClaw injects matching results or a query
reminder into system context. It is enabled by default; set
`REMEMBRANCE_AUTO_QUERY=0` to disable network auto-query. The v0.1 heuristic is
English-first, so multilingual workflows should call `query_skills` explicitly
when useful.

The completion hook is the contribution mirror and recovery path. When the
session used Remembrance, or a reusable prompt was eligible but no query
completed, and it has not been nudged for that task yet, it returns
`{ action: "revise", reason, retry: { instruction, maxAttempts: 1 } }` exactly
once and asks the agent to submit a redacted remembrance / feedback / skill
idea. Otherwise it returns `{ action: "finalize" }`. It is loop-safe: a
per-session prompted-count sentinel means the agent is asked at most once per
distinct use or eligible task, so a revise never re-triggers itself. The compact
retry instruction keeps routine hook narration, tool receipts, and correlation
IDs out of the final response; only a failure, host-policy block, or required
user action is surfaced. Set `REMEMBRANCE_AUTO_CONTRIBUTE=0` only when automatic
contribution closure is not wanted.

### How usage is detected

The Claude plugin decides whether to prompt for a contribution by scanning the
session transcript for registry-consumption markers. OpenClaw's
`before_agent_finalize` event does not carry a transcript, so this plugin reuses
the Codex plugin's marker mechanism (`src/hook-core.mjs`, generated from the
shared core with OpenClaw-specific security hardening):

- The pre-prompt hook calls `recordRegistryUse(sessionId)` whenever a registry
  query completes, incrementing a per-session counter file under
  `os.tmpdir()/remembrance-usage/<hash>.use` (`REMEMBRANCE_USAGE_DIR` overrides
  the directory).
- The `after_tool_call` hook clears `<hash>.high-match.json` only when the
  completed detail call matches the stored slug, `query_id`, and `result_id`.
- Contextual continuation reminders persist an opaque `<hash>.directive.json`
  marker and a fail-open shown event. The next successful `query_skills` call
  reports it followed, then consumes the marker so a later query cannot claim
  the earlier instruction. No prompt text is stored and the telemetry never
  affects ranking.
- Relevant and contextual prompts call `recordTaskEligibility(sessionId)`,
  incrementing a `<hash>.eligible` counter even when the query is missed or
  unavailable. Later tasks in the same session therefore remain recoverable.
- The completion hook reads that count via `readRegistryUseCount(sessionId)` and
  combines it with eligibility before comparing the result to a last-prompted
  sentinel (`<hash>.prompt`). It revises once for either a new use or an
  unclosed eligible task, then records the handled count.

Both hooks **fail open**: query errors never block the user's work. Timeout,
HTTP, and malformed-response failures inject compact recovery guidance;
unrelated prompts still inject nothing and completion errors finalize normally.
Prompt text is redacted for common secrets and private-network URLs before any
query is sent.

## Environment

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_API_KEY_ORIGIN`: bind an environment key to an exact custom API
  URL. It is unnecessary for the default cloud URL or when `apiKey` and
  `apiUrl` are stored together in the shared config.
- `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`: explicit opt-in for a trusted
  private/link-local HTTPS self-host. Remote HTTP is rejected except on loopback.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the pre-prompt hook's network query.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook query timeout, default `2000`.
- `REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS`: fail-open shown/followed event
  timeout, default `750`, bounded to `100`-`2000` milliseconds.
- `REMEMBRANCE_AUTO_CONTRIBUTE=0`: disables the completion contribution prompt.
- `REMEMBRANCE_USAGE_DIR`: overrides the per-session usage-marker directory.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

With an organization key, every query returns `skill_access`. If its policy is
`org_only`, OpenClaw uses only returned organization skills and never
substitutes bundled or live public skill references. Query failures still do
not block the user's work, but they fail closed for public-skill fallback until
the organization policy can be confirmed.

## Generated / copied files

`servers/remembrance-mcp.mjs`, the entire `skills/remembrancer/` tree, and
`src/hook-core.mjs` are generated from the same canonical sources used by the
other Remembrance plugins, then OpenClaw applies a narrow ClawHub security
hardening transform that removes generic environment-controlled credential-path
lookups from the packaged artifact. The fixed `~/.config/remembrance/...`
fallback, `REMEMBRANCE_API_KEY`, `REMEMBRANCE_API_URL`, destination-binding
settings, and the explicit
`REMEMBRANCE_AGENT_KEY_PATH` override remain supported. Do not edit these files
by hand; change the canonical source or the OpenClaw hardening transform and run
`npm run sync:hook-core` / `npm run refresh:generated`.

## Verified vs. unverified against OpenClaw docs

**Confirmed by the OpenClaw docs** (cited above):

- `openclaw.plugin.json` is metadata-only (id / configSchema required; an empty
  `configSchema` object is acceptable) and does **not** declare entrypoints or
  hooks — those live in `package.json#openclaw` and runtime code.
  ([Plugin manifest](https://docs.openclaw.ai/plugins/manifest))
- Native entrypoints are declared in `package.json` under
  `openclaw.extensions` / `openclaw.runtimeExtensions`.
  ([Plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints))
- Plugins register hooks in code via `register(api)` + `api.on(name, handler,
opts?)` (with `priority` / `timeoutMs` options); handlers are `async (event)
=> ...`, and `event.context` carries `sessionId` / `runId` / `pluginConfig`.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
  [Plugin internals](https://docs.openclaw.ai/plugins/architecture))
- Conversation hook names — `before_model_resolve`, `before_prompt_build`,
  `llm_input`, `before_agent_reply`, `llm_output`, `before_agent_finalize`,
  `agent_end` — and that `llm_output` / `agent_end` are observation-only.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
  [Agent loop](https://docs.openclaw.ai/concepts/agent-loop))
- `after_tool_call` is the observation-only hook for successful/error tool
  outcomes. ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- Pre-prompt context-injection fields: `prependContext`, `appendContext`,
  `systemPrompt`, `prependSystemContext`, `appendSystemContext`.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- `before_agent_finalize` returns `{ action: "revise", reason }` /
  `{ action: "finalize" }` (or omitted), with an optional
  `retry: { instruction, idempotencyKey?, maxAttempts? }`.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- `allowConversationAccess` gating and the `plugins.entries.<id>` config shape.
  ([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference))
- MCP servers configured under `mcp.servers.<id>` with `command` / `args` /
  `env`. ([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference),
  [MCP CLI](https://docs.openclaw.ai/cli/mcp))
- ClawHub install/publish commands.
  ([Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins),
  [ClawHub quickstart](https://github.com/openclaw/clawhub/blob/main/docs/quickstart.md))

**Unverified / best-effort (thin docs — flagged):**

- **Which pre-prompt event to bind for context injection.** The docs list both
  `before_model_resolve` (returns provider/model overrides) and
  `before_prompt_build` (returns the context-injection fields), but do not show a
  full worked example of a context-injection hook. We bind
  **`before_prompt_build`** because that is the hook the docs associate with
  `appendContext`/`appendSystemContext`. If a given OpenClaw build only exposes
  `before_model_resolve` for injection, switch the `api.on(...)` name in
  `src/index.mjs` (the handler and return shape are otherwise the same).
- **The exact event field carrying the user's prompt.** The docs say
  `before_prompt_build` receives "the current prompt" but do not pin the field
  name. `src/index.mjs#promptFromEvent` probes `event.prompt` /
  `event.userPrompt` / `event.input.prompt` and falls back to scanning
  `event.messages` for the latest user turn; if none match, the core no-ops
  (fail-open).
- **`definePluginEntry` import.** The documented import is
  `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"`. To keep
  this package Node-builtins-only (so `node --check` and the unit tests run
  without the OpenClaw SDK installed), `src/index.mjs` uses an inline
  identity-style `definePluginEntry` fallback. It is behaviorally equivalent — a
  loaded plugin's default export is the same definition object either way. When
  publishing/running under OpenClaw, this can be swapped for the real SDK import
  with no other change.
- **No plugin-root variable for `openclaw.mcp.json`.** OpenClaw only expands real
  uppercase `${VAR}` values and does **not** define an `${OPENCLAW_PLUGIN_ROOT}`
  (nor a documented plugin-root variable) for MCP configs, so the shipped
  fragment is illustrative only. The plugin-owned `openclaw remembrance setup`
  command writes the installed absolute path through OpenClaw's supported
  config-mutation API; managed installations may use an absolute `args` path or
  `openclaw mcp add remembrance --command node --arg /abs/path/...`.
- **`openclaw.compat.pluginApi` / `openclaw.build.openclawVersion` values.**
  ClawHub requires date-versioned compatibility metadata. The package is pinned
  to the oldest OpenClaw host exercised by the release gate; update the pin and
  rerun that host gate before publishing a release that needs newer host APIs.
