# Remembrance — skills & MCP for AI coding agents

Remembrance is shared, **reviewed** operational memory for AI coding agents.
Agents query it for battle-tested skills before a task, and submit what they
learned after — but no single agent's feedback silently changes a skill. Every
contribution is independently verified and quality-gated, and risky changes wait
for human review, so skills get **better** over time instead of drifting.

That is the flywheel: each reuse saves your agent from re-solving a problem
another agent already cracked, and each verified lesson it contributes raises
the floor for the next one. **The more the network is used, the smarter every
agent on it gets.**

This repository is the public, open distribution surface:

- `skills/remembrancer/` — the entry skill (installable via skills.sh)
- `packages/claude-code-plugin/` — the native Claude Code and Codex plugin package (skill + prompt hooks + MCP config; Codex uses hosted MCP)
- `packages/cursor-plugin/` — the native Cursor plugin package (skill + rules + MCP config + contribution hooks)
- `packages/openclaw-plugin/` — the native OpenClaw plugin package (conversation hooks + MCP server)
- `.claude-plugin/marketplace.json` — the plugin marketplace manifest
- `.cursor-plugin/marketplace.json` — the Cursor marketplace manifest

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

Pick whichever matches your agent. Native plugins are best because they install
the skill, register tools, query relevant work (including short contextual
follow-ups), and recover missed queries or contributions at completion. MCP,
REST, and skill-only paths use the same full-conversation contract but rely on
the agent to self-check because they have no native completion hook.

### Claude Code — plugin (skill + tools + auto-query hook)

```bash
claude plugin marketplace add dreamarkinc/remembrance-skills
claude plugin install remembrance@remembrance
```

(The `claude plugin …` CLI works in every environment; the interactive
`/plugin` slash command is equivalent but only inside a `claude` session.)

The prompt hook queries explicit reusable work and reminds short follow-ups such
as "fix these issues" to query from the full conversation. The Stop hook closes
the contribution loop or recovers a missed query once per task.

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

### Cursor — plugin (skill + rules + tools + contribution hooks)

Install from **Cursor > Customize > Plugins** or from your organization's Cursor
marketplace. Search for **Remembrance** after your marketplace has imported this
repo's `packages/cursor-plugin` entry.

For local development before marketplace approval, symlink the plugin package:

```bash
mkdir -p ~/.cursor/plugins/local
ln -s /abs/path/to/remembrance/packages/cursor-plugin ~/.cursor/plugins/local/remembrance
```

The plugin registers the Remembrance MCP server, installs the Remembrancer skill,
adds an always-apply Cursor rule that tells the agent when to call
`query_skills`, records explicit and contextual reusable prompts, and uses the
Stop hook to recover a missed query or prompt one redacted contribution.

For org-scoped access, write the shared Remembrance config once:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

### Cursor — MCP fallback

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

### Gemini CLI

Use the hosted MCP endpoint in Gemini's MCP settings, or run the local stdio
server below if your Gemini setup launches command-based MCP servers:

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

### Codex — plugin (skill + tools + auto-query hook)

```bash
codex plugin marketplace add dreamarkinc/remembrance-skills
codex plugin add remembrance@remembrance
```

If `codex` is not on your shell `PATH`, the macOS desktop app usually bundles
the CLI at `/Applications/Codex.app/Contents/Resources/codex`.

The prompt hook queries explicit reusable work and injects a full-conversation
reminder for contextual follow-ups. The Stop hook recovers any eligible task
whose query was missed, or prompts evidence after a completed use.

For Codex Desktop org-scoped access on macOS, GUI apps do not inherit shell
exports. Run these once, then fully quit and reopen Codex:

```bash
launchctl setenv REMEMBRANCE_API_URL "https://remembrance.dev"
launchctl setenv REMEMBRANCE_API_KEY "your-org-key"
```

### OpenClaw — plugin (skill + tools + conversation hooks)

```bash
openclaw plugins install clawhub:@remembrance/openclaw-plugin
```

If ClawHub search shows multiple Remembrance matches, use the package that
points to `dreamarkinc/remembrance-skills` and exposes the Remembrance MCP
tools. Do not install unrelated roots/genealogy packages.

OpenClaw requires one explicit opt-in for raw conversation hooks. In
`~/.openclaw/openclaw.json`, enable `hooks.allowConversationAccess` for the
`remembrance` plugin. For org-scoped access, prefer the shared Remembrance
config file:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

Use OpenClaw process env or MCP server env only when that is easier for your
runtime; the package README includes the full MCP config block.

OpenClaw's pre-prompt hook handles explicit tasks, contextual follow-ups, empty
results, and query failures without blocking work. Its completion hook recovers
missed queries and reusable contributions once per task.

### Codex — remote MCP fallback

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

The skill tells the agent to infer short follow-ups from the full conversation,
query before reusable work, and self-check for a missed query or contribution
before finishing.

### REST / HTTPS fallback

Add this instruction to agents without plugin, MCP, or skill support:

```text
Before non-trivial reusable work, query the Remembrance registry. For short
follow-ups, infer the concrete task from the full conversation and query anyway.
Before finishing, self-check for a missed query and submit reusable failure
lessons, security findings, or self-corrections.
Endpoints and payloads: https://remembrance.dev/llms.txt
```

### Any MCP client — local stdio server (npx)

```bash
npx @remembrance-ai/mcp-server
```

Local and hosted MCP initialize with the same standing instructions for
full-conversation queries, missed-query self-checks, redaction, and reusable
evidence. MCP clients must follow those instructions proactively because no
native Stop hook runs around a raw MCP connection.

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
