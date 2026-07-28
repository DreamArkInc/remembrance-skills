# Remembrance VS Code Plugin

Installs the Remembrancer skill, the Remembrance MCP server, and the four
lifecycle hooks that let VS Code agent mode find reviewed guidance during work
and hand back what it learned when the task is done.

That loop runs both ways: VS Code reuses skills other agents already proved out,
and contributes what it learns so the next agent starts further ahead.

## Requirements

VS Code **agent plugins** (Preview). VS Code auto-detects the Claude plugin
format, so this package's `.claude-plugin/plugin.json`, `hooks/hooks.json`,
`.mcp.json`, and `skills/` load directly, and `${CLAUDE_PLUGIN_ROOT}` resolves to
this package's directory.

## Install

Run **Chat: Install Plugin From Source** from the Command Palette and provide:

```
https://github.com/dreamarkinc/remembrance-skills
```

For local development against this repo, register the package directory with the
`chat.pluginLocations` setting:

```json
{
  "chat.pluginLocations": {
    "/abs/path/to/remembrance/packages/vscode-plugin": true
  }
}
```

Reload VS Code, then confirm the plugin's tools appear in agent mode's Tools
picker.

## Organization key

The plugin-managed MCP server reads the same Remembrance config as the other
native plugins, so one file authenticates both the hooks and the bundled local
MCP server:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

`REMEMBRANCE_API_KEY` in the environment works too. Because the hooks and the
bundled MCP server both read `~/.config/remembrance/config.json`, an unset
`REMEMBRANCE_API_KEY` does **not** prove this install is anonymous.

After reloading, call MCP `get_connection_status`. It should report
`local_stdio_mcp`, the resolved credential source, and the expected organization
scope. Never infer this plugin's scope from `REMEMBRANCE_API_KEY` alone, from an
environment variable, or from an anonymous REST/browser probe — the diagnostic
verifies the process that will actually serve VS Code's tools, without exposing
the key.

A **hosted MCP** registration is a different transport: it cannot read a file on
your machine, so it needs its own request credential and reports its own scope.
Raw REST does not load plugin config automatically either.

For dev or self-hosted registries, add `apiUrl` to the same file:

```sh
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://dev.remembrance.dev"}\n' \
  > ~/.config/remembrance/config.json
```

## What the hooks do

| Hook                             | Event              | Behavior                                                                                                |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `scripts/session-start.mjs`      | `SessionStart`     | Records activation health and states how to verify setup.                                               |
| `scripts/query-on-prompt.mjs`    | `UserPromptSubmit` | Queries Remembrance before non-trivial reusable work and injects matching skills as context. Fail-open. |
| `scripts/record-detail-open.mjs` | `PostToolUse`      | Correlates Remembrance tool calls with the active directive.                                            |
| `scripts/contribute-on-stop.mjs` | `Stop`             | Asks for redacted feedback once per engagement when Remembrance was used.                               |

Set `REMEMBRANCE_AUTO_QUERY=0` to disable the prompt hook, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable the completion nudge.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration. This mirrors the Codex
behavior: a Codex tenant/privacy-policy denial occurs before Remembrance is
reached and must not be reported as a Remembrance setup failure.

## Generated files

`servers/remembrance-mcp.mjs` and `skills/remembrancer/` are generated. Run
`npm run refresh:generated` from the repo root after changing the MCP server or
the canonical skill; `npm run check:generated` guards every copy.
