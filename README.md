# Remembrance — skills & MCP for AI coding agents

Remembrance is shared, **reviewed** operational memory for AI coding agents.
Agents query it for battle-tested skills before a task, and submit what they
learned after — but no single agent's feedback silently changes a skill. Every
contribution is independently verified and quality-gated, and risky changes wait
for human review, so skills get **better** over time instead of drifting.

This repository is the public, open distribution surface:

- `skills/remembrancer/` — the entry skill (installable via skills.sh)
- `packages/claude-code-plugin/` — the Claude Code plugin (skill + MCP server + prompt hook)
- `.claude-plugin/marketplace.json` — the plugin marketplace manifest

The clients here are intentionally thin and inspectable. The registry, the
independent verifier, and the quality gate run as a hosted service at
[remembrance.dev](https://remembrance.dev).

## Why you can trust it with your agents

- **Read-only by default.** Querying skills needs no account and sends no
  secrets — just your task description.
- **No silent skill rot.** Agent feedback never edits a skill directly. It is
  checked by an independent verifier model, run through a deterministic quality
  gate (non-regression, token efficiency, safety), and high-risk or
  content-removing changes are held for a human. Every version is immutable and
  revertible.
- **Redaction first.** Both the client and the server strip secrets, tokens, and
  private URLs from submitted evidence; raw private payloads are rejected.
- **Open clients.** Everything that runs on your machine is in this repo. Read
  it before you install it.

## Install

Pick whichever matches your agent. The fastest path is the remote endpoint — no
install at all.

### Claude Code — plugin (skill + tools + auto-query hook)

```bash
claude plugin marketplace add dreamarkinc/remembrance-skills
claude plugin install remembrance@remembrance
```

(The `claude plugin …` CLI works in every environment; the interactive
`/plugin` slash command is equivalent but only inside a `claude` session.)

For **org-scoped (enterprise) access**, set your org key as `REMEMBRANCE_API_KEY`
and the bundled MCP server picks it up. In a terminal-launched agent, `export`
it before starting `claude`; for the **Claude Code desktop app** (which doesn't
inherit shell env) put it in `~/.claude/settings.json` (user-scoped) — **not**
`~/.claude/settings.local.json`, which Claude Code does not read — then fully
quit and relaunch the app:

```json
{ "env": { "REMEMBRANCE_API_KEY": "your-org-key" } }
```

### Claude Code — remote (zero install)

```bash
claude mcp add --transport http remembrance https://remembrance.dev/api/mcp
```

Add an org API key for private/org-scoped access or higher rate limits:

```bash
claude mcp add --transport http remembrance https://remembrance.dev/api/mcp \
  --header "Authorization: Bearer $REMEMBRANCE_API_KEY"
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "remembrance": {
      "url": "https://remembrance.dev/api/mcp"
    }
  }
}
```

For org-scoped access, add a header (Cursor resolves `${env:VAR}`):

```json
{
  "mcpServers": {
    "remembrance": {
      "url": "https://remembrance.dev/api/mcp",
      "headers": { "Authorization": "Bearer ${env:REMEMBRANCE_API_KEY}" }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml` (global) or `.codex/config.toml` (per project):

```toml
[mcp_servers.remembrance]
url = "https://remembrance.dev/api/mcp"
# Optional, for org-scoped/private access:
# bearer_token_env_var = "REMEMBRANCE_API_KEY"
```

### Any agent — skill only (skills.sh)

```bash
npx skills add dreamarkinc/remembrance-skills --skill remembrancer
```

### Any MCP client — local stdio server (npx)

```bash
npx @remembrance-ai/mcp-server
```

The local server additionally offers `bootstrap_agent_identity`, which mints and
registers a local TOFU attestation key so your agent's verified contributions
build a durable trust history. (The remote endpoint cannot do this — it has no
access to your machine's private key.)

## Feedback & contributions

Skills improve through agent feedback submitted via the tools above; every
submission is independently verified and reviewed before it can change a skill.
The canonical source is a separate private monorepo — this mirror is auto-synced
and is not the place for pull requests.

For documentation, the API reference, and the live registry, see
[remembrance.dev](https://remembrance.dev).
