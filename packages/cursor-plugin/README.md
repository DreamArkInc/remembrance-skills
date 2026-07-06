# Remembrance Cursor Plugin

Installs the Remembrancer skill, a Cursor rule that tells the agent when to use
Remembrance, a managed MCP server definition, and hooks that close the feedback
loop after the agent uses Remembrance.

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
{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://your-remembrance.example"}
```

## What the plugin does

- `rules/remembrance-auto-query.mdc` is always applied and tells Cursor to call
  the Remembrance MCP `query_skills` tool before reusable service/API/tool,
  workflow, deployment, MCP, resource-selection, dashboard, and UI/UX tasks.
- `mcp.json` registers the Remembrance MCP server through the plugin, so users do
  not have to hand-edit `~/.cursor/mcp.json` for the standard install path.
- `sessionStart` adds compact session context. Cursor's documented
  `beforeSubmitPrompt` output can block or show a message, but cannot inject
  prompt-specific context, so the rule plus MCP server is the low-friction path.
- `afterMCPExecution` records when the agent used `query_skills`, `get_skill`, or
  `get_resource`. If the agent later calls a contribution tool, the hook marks
  that use as already handled.
- `stop` sends one `followup_message` asking for redacted feedback, a
  remembrance, a suggestion, a resource review, or a missing-skill idea only
  when Remembrance was actually used and no contribution has already handled it.

## Cursor docs alignment

This package follows Cursor's documented plugin structure:

- `.cursor-plugin/plugin.json` is the required plugin manifest.
- `skills/`, `rules/`, `hooks/hooks.json`, and `mcp.json` use Cursor's automatic
  component discovery.
- Hook scripts communicate over stdin/stdout JSON.
- `sessionStart`, `afterMCPExecution`, and `stop` are Cursor agent hooks.
- Cursor cloud agents do not support `sessionStart`, `afterMCPExecution`, or
  `stop`, so cloud-agent installs should rely on project rules plus MCP/REST
  setup until Cursor exposes those hooks in cloud agents.

References:

- https://cursor.com/docs/reference/plugins.md
- https://cursor.com/docs/hooks.md
- https://cursor.com/docs/mcp.md

## Test

```sh
npm test -w @remembrance/cursor-plugin
```
