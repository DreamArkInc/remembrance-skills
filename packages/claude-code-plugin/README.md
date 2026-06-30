# Remembrance Claude Code Plugin

Installs the Remembrancer skill, starts a bundled Remembrance MCP server, and
adds a `UserPromptSubmit` hook that queries Remembrance before Claude reasons
about tasks likely to involve reusable skills/resources.

Install from the public mirror marketplace (the `claude plugin` CLI works in
every environment; the interactive `/plugin` slash command is the equivalent but
only inside a `claude` session):

```bash
claude plugin marketplace add dreamarkinc/remembrance-skills
claude plugin install remembrance@remembrance
```

The hook runs on every user prompt, but it only calls Remembrance when the prompt
mentions named services, APIs, CLIs, frameworks, deployment/CI/payment/migration
workflows, MCP/resource selection, or unfamiliar third-party integrations.
It is enabled by default after install; set `REMEMBRANCE_AUTO_QUERY=0` to disable
network auto-query. The v0.1 heuristic is English-first, so multilingual
workflows should call `query_skills` explicitly when useful.

The Claude plugin is self-contained: it runs the bundled MCP server from the
plugin directory and ships the canonical Remembrancer skill references/scripts.
It does not require separate `npx @remembrance-ai/mcp-server` setup. The standalone
npm MCP package remains available for non-Claude clients.
After install, the `remembrance` MCP server should expose tools such as
`query_skills`, `bootstrap_agent_identity`, `submit_feedback`,
`submit_remembrance`, `get_skill`, and `get_resource`; some clients display
those tools with a `remembrance.` namespace.

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
