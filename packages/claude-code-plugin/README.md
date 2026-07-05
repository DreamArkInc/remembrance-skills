# Remembrance Native Agent Plugin

Installs the Remembrancer skill, starts a bundled Remembrance MCP server, and
adds two hooks that keep the registry loop symmetric: a `UserPromptSubmit` hook
that queries Remembrance before Claude Code or Codex reasons about tasks likely to involve
reusable skills/resources, and a `Stop` hook that — when a session actually used
Remembrance — prompts the agent once to contribute what it learned (a
remembrance, feedback, or skill idea) instead of silently moving on.

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
workflows, MCP/resource selection, or unfamiliar third-party integrations.
It is enabled by default after install; set `REMEMBRANCE_AUTO_QUERY=0` to disable
network auto-query. The v0.1 heuristic is English-first, so multilingual
workflows should call `query_skills` explicitly when useful.

The `Stop` (completion) hook is the contribution mirror of the query hook. When a
session's transcript or Codex usage marker shows Remembrance was used, it blocks
the stop exactly once and asks the agent to submit a redacted remembrance /
feedback / skill idea — so contribution is prompted by default instead of
relying on the agent to remember.
It is loop-safe (it never re-blocks a stop that a hook already continued), fires
on the agent's final response each turn but only prompts when registry
CONSUMPTION (a query / skill use, not the agent's own submissions) has increased
since the last prompt — so a long session with several distinct skill uses gets
several nudges, while it never nags when nothing new was used, and fails open. The agent can satisfy it by contributing or by briefly declining. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable it.

The native Claude/OpenClaw plugin packages run the bundled MCP server from the
plugin directory and ship the canonical Remembrancer skill references/scripts.
The Codex plugin uses the hosted MCP endpoint for tool calls while keeping the
native hooks local. None of these require separate
`npx @remembrance-ai/mcp-server` setup. The standalone npm MCP package remains
available for clients without native plugin support or for Codex users who need
the local-only `bootstrap_agent_identity` tool.
After install, the `remembrance` MCP server or endpoint should expose tools such
as `query_skills`, `submit_feedback`, `submit_remembrance`, `get_skill`, and
`get_resource`; some clients display those tools with a `remembrance.`
namespace. The local bundled server also exposes `bootstrap_agent_identity`.

If MCP tools are unavailable, use the REST contract from
`https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

Environment:

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the prompt hook.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook query timeout, default `2000`.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

The hook fails open on API errors, malformed responses, no heuristic match, or
timeout. It redacts common secrets and private-network URLs before sending a
query. Its file-backed prompt cache is best-effort and uses atomic file
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
