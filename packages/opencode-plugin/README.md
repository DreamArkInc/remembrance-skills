# Remembrance opencode Plugin

Connects Remembrance to [opencode](https://opencode.ai): the MCP server that
exposes the Remembrance tools, plus a plugin that records activation health,
observes Remembrance tool use, and asks for redacted feedback when a session goes
idle.

## Install

Run one command:

```sh
npx -y @remembrance-ai/opencode-plugin setup
```

The setup command adds the version-matched plugin and local Remembrance MCP
server to `~/.config/opencode/opencode.json`. It preserves comments and unrelated
settings and creates a new config with mode `0600` when none exists.

Restart opencode. Remembrance then appears in its tools list, adds bounded
matching guidance to eligible model turns, observes completed use, and asks once
for concise, redacted feedback.

Use `npx -y @remembrance-ai/opencode-plugin setup --dry-run` to preview the merged
config. `opencode.json` in this package is a reference config for managed
deployments.

## Automatic context and feedback

The stable plugin API exposes `chat.message` and
`experimental.chat.system.transform`. Remembrance uses them together to run the
fail-open query helper and inject bounded guidance before an eligible model
turn. Empty or unavailable queries never block the task. The plugin also
observes successful tool calls and prompts once for feedback after meaningful
use.

## Organization key

The MCP server reads the same Remembrance config as the native plugins, so one
file authenticates both the plugin hooks and the local MCP server:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

`REMEMBRANCE_API_KEY` in the environment works too. Because the plugin and the
local MCP server both read `~/.config/remembrance/config.json`, an unset
`REMEMBRANCE_API_KEY` does **not** prove this install is anonymous.

After restarting, run MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step if attention is required. Use `get_connection_status` only for lower-
level fields. Never infer scope from `REMEMBRANCE_API_KEY` alone, from an environment
variable, or from an anonymous REST/browser probe — the diagnostic verifies the
process that will actually serve opencode's tools, without exposing the key.

A **hosted MCP** registration is a different transport: it cannot read a file on
your machine, so it needs its own request credential. Raw REST does not load
plugin config automatically either.

For dev or self-hosted registries, add `apiUrl` to the same file:

```sh
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://dev.remembrance.dev"}\n' \
  > ~/.config/remembrance/config.json
```

This paired file binds the key to that destination. If environment variables
are used instead, set `REMEMBRANCE_API_KEY_ORIGIN` equal to the exact custom
`REMEMBRANCE_API_URL`. Remote registries require HTTPS; a trusted private or
link-local self-host also requires `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`.

## What the plugin does

| Event                                | Behavior                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| `session.created`                    | Reports activation health and how to verify organization scope. |
| `chat.message`                       | Runs the fail-open query helper for the current user turn.     |
| `experimental.chat.system.transform` | Adds bounded Remembrance guidance before model dispatch.       |
| `tool.execute.after`                 | Correlates query, invocation, detail, and contribution calls.  |
| `session.idle`                       | Shows the contribution nudge once per engagement.              |

Set `REMEMBRANCE_AUTO_QUERY=0` to disable the query, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable the completion nudge.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration — the same boundary as a
Codex tenant/privacy-policy denial, which occurs before Remembrance is reached
and must not be reported as a Remembrance setup failure.

## Generated files

`servers/remembrance-mcp.mjs` and `skills/remembrancer/` are generated. Run
`npm run refresh:generated` from the repo root; `npm run check:generated` guards
every copy.
