# Remembrance for OpenClaw

Give [OpenClaw](https://docs.openclaw.ai) shared operational memory.
Remembrance helps your agent reuse reviewed skills, trusted resources, and
team-specific lessons before it spends tokens solving a workflow from scratch
again.

Install the plugin once, then OpenClaw can:

- find relevant Remembrance skills before service, API, CI/CD, migration,
  payment, deployment, MCP, or unfamiliar integration work;
- use public registry knowledge, plus private organization knowledge when you
  provide an enterprise key;
- expose Remembrance MCP tools for direct lookup, feedback, and skill
  submission; and
- ask once at the end of a useful session whether the agent should contribute
  what it learned back to the registry.

The hooks are quiet by default. They only query on prompts that look reusable,
redact common secrets before sending text, and fail open if Remembrance is
unavailable.

## Install from ClawHub

```bash
openclaw plugins install clawhub:@remembrance/openclaw-plugin
```

If you only want public registry results, the plugin can run without a key. For
private team memory, create an enterprise key in the Remembrance dashboard and
make it available to OpenClaw:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

Then enable conversation access for the Remembrance plugin in
`~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "entries": {
      "remembrance": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {}
      }
    }
  }
}
```

Restart OpenClaw after changing the plugin or key config.

If `openclaw plugins search remembrance` returns unrelated packages, such as a
genealogy/roots package, do not install them. The official package is
`clawhub:@remembrance/openclaw-plugin`, points to
`https://github.com/dreamarkinc/remembrance-skills`, and describes the
Remembrance agent skill/resource service.

To pin a specific published version, see the version selector on the plugin's
ClawHub release page. The normal install path should use the latest official
`clawhub:@remembrance/openclaw-plugin` package unless a rollout explicitly
requires a pinned version.

## What it does

Remembrance uses two OpenClaw conversation hooks:

- **Before a prompt:** the plugin checks whether the work looks like something
  that could benefit from reusable guidance. If it finds matching skills or
  resources, it injects a compact context block before OpenClaw reasons.
- **Before final answer:** if the session actually used Remembrance, the plugin
  asks OpenClaw once to submit redacted feedback, a reusable lesson, or a missing
  skill idea.

This creates the loop you want from an agent memory system: use reviewed
knowledge when it exists, and improve the registry when the agent learns
something worth reusing.

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
server gives OpenClaw direct tools such as `query_skills`,
`bootstrap_agent_identity`, `submit_feedback`, `submit_remembrance`,
`get_skill`, and `get_resource`.

OpenClaw configures MCP servers under **`mcp.servers.<id>`** (not `mcpServers`
like Claude, nor `mcp_servers` like Codex) in `~/.openclaw/openclaw.json`
([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference),
[MCP CLI](https://docs.openclaw.ai/cli/mcp)). `openclaw.mcp.json` in this package
is an **illustrative** merge fragment. OpenClaw only expands real uppercase
`${VAR}` values and does **not** define an `${OPENCLAW_PLUGIN_ROOT}` variable, so
the `args` path must be an **absolute path** — replace
`/abs/path/to/openclaw-plugin` with the real absolute path to this package before
merging into `~/.openclaw/openclaw.json`:

```json5
{
  "mcp": {
    "servers": {
      "remembrance": {
        "command": "node",
        // Absolute path — OpenClaw does not expand a plugin-root variable here.
        "args": ["/abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs"],
        "env": {
          "REMEMBRANCE_API_URL": "https://remembrance.dev",
          "REMEMBRANCE_API_KEY": "YOUR_ORG_KEY"
        }
      }
    }
  }
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

The publish script validates and packs the generated package, attaches source
commit metadata (`dreamarkinc/remembrance-skills`, `packages/openclaw-plugin`,
and the current commit SHA), dry-runs the ClawHub publish, and skips cleanly when
the package version already exists.

## Behavior

The pre-prompt hook runs before every model turn but only calls Remembrance when
the prompt mentions named services, APIs, CLIs, frameworks,
deployment/CI/payment/migration workflows, MCP/resource selection, or unfamiliar
third-party integrations. On a hit it returns `{ appendSystemContext: "..." }` so
OpenClaw injects the matching skills/resources into system context. It is enabled
by default; set `REMEMBRANCE_AUTO_QUERY=0` to disable network auto-query. The
v0.1 heuristic is English-first, so multilingual workflows should call
`query_skills` explicitly when useful.

The completion hook is the contribution mirror of the pre-prompt hook. When the
session actually used Remembrance and hasn't been nudged for that use yet, it
returns `{ action: "revise", reason, retry: { instruction, maxAttempts: 1 } }`
exactly once and asks the agent to submit a redacted remembrance / feedback /
skill idea. Otherwise it returns `{ action: "finalize" }`. It is loop-safe: a
per-session prompted-count sentinel means the agent is asked at most once per
distinct use, so a revise never re-triggers itself. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable it.

### How usage is detected

The Claude plugin decides whether to prompt for a contribution by scanning the
session transcript for registry-consumption markers. OpenClaw's
`before_agent_finalize` event does not carry a transcript, so this plugin reuses
the Codex plugin's marker mechanism (`src/hook-core.mjs`, generated from the
shared core with OpenClaw-specific security hardening):

- The pre-prompt hook calls `recordRegistryUse(sessionId)` whenever it actually
  injects skills, incrementing a per-session counter file under
  `os.tmpdir()/remembrance-usage/<hash>.use` (`REMEMBRANCE_USAGE_DIR` overrides
  the directory).
- The completion hook reads that count via `readRegistryUseCount(sessionId)` and
  compares it to a last-prompted sentinel (`<hash>.prompt`). It revises when the
  use count has increased since the last prompt, then records the new prompted
  count — the same count-sentinel pattern the Claude hook uses, driven by markers
  instead of a transcript scan.

Both hooks **fail open**: any error, no heuristic match, timeout, HTTP error, or
malformed response results in no injection / normal finalization. Prompt text is
redacted for common secrets and private-network URLs before any query is sent.

## Environment

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the pre-prompt hook's network query.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook query timeout, default `2000`.
- `REMEMBRANCE_AUTO_CONTRIBUTE=0`: disables the completion contribution prompt.
- `REMEMBRANCE_USAGE_DIR`: overrides the per-session usage-marker directory.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

## Generated / copied files

`servers/remembrance-mcp.mjs`, the entire `skills/remembrancer/` tree, and
`src/hook-core.mjs` are generated from the same canonical sources used by the
other Remembrance plugins, then OpenClaw applies a narrow ClawHub security
hardening transform that removes generic environment-controlled credential-path
lookups from the packaged artifact. The fixed `~/.config/remembrance/...`
fallback, `REMEMBRANCE_API_KEY`, `REMEMBRANCE_API_URL`, and the explicit
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
  fragment is illustrative only — use an **absolute path** for `args`, or add the
  server via the CLI (`openclaw mcp add remembrance --command node --arg
  /abs/path/...`).
- **`openclaw.compat.pluginApi` / `openclaw.build.openclawVersion` values.**
  ClawHub requires these fields for code plugins but the docs don't pin exact
  version strings; the placeholders (`^1.0.0`, `>=1.0.0`) should be reconciled
  with the target OpenClaw release before publishing.
