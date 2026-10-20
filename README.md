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
- `packages/codex-plugin/` — the native Codex plugin (skill + lifecycle hooks + bundled local MCP)
- `packages/claude-code-plugin/` — the native Claude Code plugin
- `packages/cursor-plugin/` — the native Cursor plugin package (skill + rules + MCP config + contribution hooks)
- `packages/openclaw-plugin/` — the native OpenClaw plugin package (conversation hooks + MCP server)
- `packages/vscode-plugin/` — the native VS Code agent plugin (skill + lifecycle hooks + bundled local MCP)
- `packages/opencode-plugin/` — the npm-distributed OpenCode plugin and version-matched MCP setup
- `.claude-plugin/marketplace.json` — the plugin marketplace manifest
- `.claude-plugin/plugin.json` — the root VS Code install-from-source manifest
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

## Private lesson autopilot for organizations

Organization installs capture routine failures, corrections, reusable workflow
lessons, and complete private skills through a narrow two-stage path. The local
`capture_learning` tool canonicalizes and redacts a lesson in memory, or
safety-screens a complete skill, and stores only an encrypted draft. The
separately host-visible `submit_private_lesson_candidate` and
`submit_private_skill_candidate` actions, and their retry actions, send that
draft only to the authenticated organization's private verifier queue. They
cannot create or automatically propagate public content.

Unresolved and terminal drafts never expire or auto-delete. Retryable failures
resume during later lifecycle events; authentication, validation, policy, and
host-denial states stay held. After a signed submission receipt is verified,
the encrypted lesson content is removed immediately; its content-free
completion marker is automatically deleted after 14 days. Admins enable or
pause the lane under **Dashboard > Settings > Private lesson automation**.
Persist host approval only for the four exact submit and retry actions, as in
the Highly Recommended step below, not every Remembrance write tool.
`run_connection_doctor` reports policy, signing, encryption, outbox, and action
readiness without exposing lesson content or local paths.

## Install

Pick whichever matches your agent. Native plugins are best because they install
the skill, register tools, query relevant work (including short contextual
follow-ups), and recover missed queries or contributions at completion. MCP,
REST, and skill-only paths use the same full-conversation contract but rely on
the agent to self-check because they have no native completion hook.

### Highly Recommended: approve private submissions

For organizations that use Remembrance with a private organization key, this
step is required for Remembrance to do its job fully. Without it, on hosts that
ask before these tools, every private lesson or skill submission stops for a
manual approval, and unattended or headless runs deny it. Public-only use,
without an organization key, does not need it; skill-only and REST installs
have no MCP tools to approve.

An agent asks you (for managed settings, your administrator) before applying
this step: it never edits host permission or settings files without your
consent, and never answers the host's approval prompt for its own pending
action.

After installing below, persist your host's approval for exactly
`submit_private_lesson_candidate`, `retry_private_lesson_candidate`,
`submit_private_skill_candidate`, and `retry_private_skill_candidate` (hosted
MCP exposes only `submit_private_lesson_candidate`). Hosts that also ask before
`capture_learning`, where every local private submission starts, need it
approved too, as a local-only entry: it stays on this machine and sends
nothing. Under managed Codex `writes` that is an optional administrator
decision, because Auto-review then never sees the lesson content.
Never pre-approve the `delete_private_*` tools, a whole server,
`bypassPermissions`, Gemini CLI `trust: true` or `mcp.allowed`, or any global
auto-approve.

- **Claude Code plugin:** add the four tools and `capture_learning` to
  `permissions.allow` in `~/.claude/settings.json` as
  `mcp__plugin_remembrance_remembrance__<tool>`, or `mcp__remembrance__<tool>`
  for a local server registered as `remembrance` (including `capture_learning`),
  and only `mcp__remembrance__submit_private_lesson_candidate` on hosted MCP.
- **Codex plugin:** one
  `[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.<tool>]`
  table per tool with `approval_mode = "approve"` in `~/.codex/config.toml`;
  `approve` also skips Auto-review, so in a managed organization add them only
  with your administrator.
- **Cursor:** `remembrance:<tool>` entries, including `capture_learning`,
  merged into the `mcpAllowlist` of `~/.cursor/permissions.json` without
  dropping its other entries or keys.
- **VS Code:** **Chat: Manage Tool Approval**, tick only the four tools and
  `capture_learning`, and turn off **Configure for this workspace only**.
- **OpenCode:** `"remembrance_<tool>": "allow"` entries in `permission`,
  including `capture_learning`, placed after any broader `"*"` or
  `"remembrance_*"` rule because the last matching rule wins.
- **OpenClaw:** choose allow-always once for the lesson lane and once for the
  skill lane.
- **Gemini CLI:** one allow `[[rule]]` per tool, including `capture_learning`,
  then one ask rule per tool under its full Gemini CLI name, both delete tools
  included, in `~/.gemini/policies/remembrance.toml`.

The exact snippets are in
[`remembrance-setup.md`](skills/remembrancer/references/remembrance-setup.md#highly-recommended-approve-private-submissions)
and each plugin README. Check the step by behavior: neither the capture nor
its private submission prompts (where the organization leaves the capture to
Auto-review or a person, only the capture is reviewed); `run_connection_doctor`
cannot see a persisted approval.

### Claude Code — plugin (skill + tools + auto-query hook)

```bash
claude plugin marketplace add dreamarkinc/remembrance-skills
claude plugin install remembrance@remembrance
```

(The `claude plugin …` CLI works in every environment; the interactive
`/plugin` slash command is equivalent but only inside a `claude` session.)

**Node.js runtime.** The hooks and the bundled MCP server need Node.js 18.17.0
or newer that the host can find. A host started from the Dock, Finder or an IDE
may not have your shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf,
nodenv or mise can be missing from it; the symptom is `spawn node ENOENT` or "No
such file or directory". The plugin starts its hooks and bundled MCP server
through `scripts/node-launcher`, which uses `REMEMBRANCE_NODE` when it is set,
else `node` on PATH, else Node.js 18.17.0+ from nvm, volta, fnm, n, asdf,
nodenv, mise, Homebrew, `/usr/local` or `/usr/bin`. In Claude Code, set
`REMEMBRANCE_NODE=/absolute/path/to/node` (from `command -v node` in a terminal)
in the `env` map of `~/.claude/settings.json`; it reaches the hooks and the
bundled MCP server. Then fully quit and restart Claude Code; a failed server
shows "Failed to connect" in `/mcp` and `claude mcp list`.
`packages/claude-code-plugin/README.md` covers the desktop app, the VS Code
extension and Windows.

The prompt hook queries explicit reusable work and any other task-shaped prompt
of at least 40 characters, and reminds short follow-ups such as "fix these
issues" to query from the full conversation. A task-shaped search that finds
nothing adds nothing of its own to the context. The Stop hook closes the
contribution loop or recovers a missed query once per task.

For **org-scoped (enterprise) access**, write the org key once to the shared
mode-0600 config that both plugin hooks and bundled local MCP read, then fully
restart Claude Code and call `run_connection_doctor`:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
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

For local development before marketplace approval, copy the plugin package
into its own folder (Cursor skips a symbolic link to a plugin elsewhere on
disk), then restart Cursor or run **Developer: Reload Window**:

```bash
mkdir -p ~/.cursor/plugins/local/remembrance
cp -R /abs/path/to/remembrance/packages/cursor-plugin/. ~/.cursor/plugins/local/remembrance/
```

The plugin registers the Remembrance MCP server, installs the Remembrancer skill,
adds an always-apply Cursor rule that tells the agent when to call
`query_skills`, records explicit and contextual reusable prompts, and uses the
Stop hook to recover a missed query or prompt one redacted contribution.

**Node.js runtime.** The hooks need Node.js 18.17.0 or newer that Cursor can
find, and the plugin's MCP entry runs `npx -y @remembrance-ai/mcp-server`, which
also needs npm. A host started from the Dock, Finder or an IDE may not have your
shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf, nodenv or mise
can be missing from it; the symptom is `spawn node ENOENT` or "No such file or
directory". The hooks start through `scripts/node-launcher`, which uses
`REMEMBRANCE_NODE` when it is set, else `node` on PATH, else Node.js 18.17.0+
from nvm, volta, fnm, n, asdf, nodenv, mise, Homebrew, `/usr/local` or
`/usr/bin`. `npx` starts `node` through PATH, so if the MCP server does not
start, start Cursor from a terminal where `npx` works. On Windows, Cursor runs
hooks in PowerShell, where they need `sh` (Git for Windows `usr\bin`) on PATH.

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

### VS Code — agent plugin (Preview)

Run **Chat: Install Plugin From Source** from the Command Palette and enter:

```text
https://github.com/dreamarkinc/remembrance-skills
```

The plugin installs the Remembrancer skill, prompt/completion hooks, and bundled
local MCP server. An administrator must enable agent plugins and hooks in
managed VS Code deployments. For organization access, write the shared
mode-0600 config once:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

Restart VS Code, call `run_connection_doctor`, and confirm `local_stdio_mcp`,
active plugin health, and the expected organization scope.

**Node.js runtime.** The hooks and the bundled MCP server need Node.js 18.17.0
or newer that VS Code can find. A host started from the Dock, Finder or an IDE
may not have your shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf,
nodenv or mise can be missing from it; the symptom is `spawn node ENOENT` or "No
such file or directory". The plugin starts its hooks and bundled MCP server
through `scripts/node-launcher`, which uses `REMEMBRANCE_NODE` when it is set,
else `node` on PATH, else Node.js 18.17.0+ from nvm, volta, fnm, n, asdf,
nodenv, mise, Homebrew, `/usr/local` or `/usr/bin`. In VS Code only PATH and
that search apply: start VS Code with `code .` from a terminal where `node`
works, or install Node.js 18.17.0+ in one of those locations, then restart VS
Code. On Windows, VS Code runs each hook's `windows` form, which calls `node`
directly and needs no `sh`, but skips the launcher: the first `node` on the PATH
VS Code sees runs the hooks without the Node.js 18.17.0 floor check, so keep
Node.js 18.17.0+ first on that PATH. The MCP entry still starts the launcher
with `sh`, so it needs `sh` (Git for Windows `usr\bin`) on the PATH VS Code
sees.

### Gemini CLI

Use the hosted MCP endpoint in Gemini's MCP settings, or run the local stdio
server below if your Gemini setup launches command-based MCP servers:

```json
{
  "mcpServers": {
    "remembrance": {
      "url": "https://remembrance.dev/api/mcp",
      "headers": { "Authorization": "Bearer ${REMEMBRANCE_API_KEY}" }
    }
  }
}
```

### Codex — plugin (skill + tools + auto-query hook)

**Codex CLI.** The Codex plugin needs a Codex CLI: `codex` on your PATH or, on
macOS, the CLI bundled in the ChatGPT desktop app. The setup, update and
hook-review commands run the newest one they find, so an older `codex` on PATH
cannot shadow the app's newer CLI; set `CODEX_CLI` to a CLI's full path to
choose one yourself. No other host needs the Codex CLI.

```bash
(
set +eu; unalias codex 2>/dev/null || :; unset -f codex 2>/dev/null || :
if [ -n "$CODEX_CLI" ]; then
  [ -x "$CODEX_CLI" ] || { printf 'CODEX_CLI is set but is not an executable file: %s\n' "$CODEX_CLI" >&2; exit 1; }
else
  best=-1
  for c in "$(command -v codex 2>/dev/null)" \
    /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
    /Applications/ChatGPT.app/Contents/Resources/codex \
    /Applications/Codex.app/Contents/Resources/codex; do
    case "$c" in /*) [ -x "$c" ] || continue ;; *) continue ;; esac
    out=$("$c" --version </dev/null 2>/dev/null) || continue
    v=$(printf '%s\n' "$out" | awk 'match($0, /[0-9]+[.][0-9]+[.][0-9]+/) { split(substr($0, RSTART, RLENGTH), n, "."); v = n[1] * 1000000 + n[2] * 1000 + n[3]; exit } END { print v + 0 }')
    [ "$v" -gt "$best" ] && best=$v && CODEX_CLI=$c
  done
  [ -n "$CODEX_CLI" ] || { printf '%s\n' "Codex CLI not found. Install the Codex CLI, or install or update the ChatGPT desktop app on macOS, or set CODEX_CLI to a Codex CLI path, then try again." >&2; exit 1; }
fi
printf 'Using Codex CLI: %s\n' "$CODEX_CLI" >&2
"$CODEX_CLI" plugin marketplace add dreamarkinc/remembrance-skills &&
  "$CODEX_CLI" plugin marketplace upgrade remembrance &&
  "$CODEX_CLI" plugin add remembrance@remembrance &&
  "$CODEX_CLI"
)
```

The block runs in a subshell, so a failure prints a message and leaves your
terminal open. It uses `CODEX_CLI` when set; otherwise it runs the newest of
`codex` on PATH, the ChatGPT desktop app's bundled CLI
(`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`) and the
older bundle paths, and stops at the first failed step.

The final command opens Codex CLI for its secure hook review when Codex
requires it.

The prompt hook queries explicit reusable work and injects a full-conversation
reminder for contextual follow-ups. The Stop hook recovers any eligible task
whose query was missed, or prompts evidence after a completed use.

For Codex Desktop org-scoped access, write the shared config once. Both the
native hooks and bundled local MCP server read it, so GUI process environment
setup is unnecessary:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

Fully quit and reopen Codex, then call `run_connection_doctor`. Confirm
`local_stdio_mcp`, the expected organization scope, and active plugin health.
Visible skills without native hooks or MCP tools is a degraded partial install,
not a successful setup.

**Node.js runtime.** The hooks and the bundled MCP server need Node.js 18.17.0
or newer that Codex can find. A host started from the Dock, Finder or an IDE may
not have your shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf,
nodenv or mise can be missing from it; the symptom is `spawn node ENOENT` or "No
such file or directory". The plugin starts its hooks and bundled MCP server
through `scripts/node-launcher`, which uses `REMEMBRANCE_NODE` when it is set,
else `node` on PATH, else Node.js 18.17.0+ from nvm, volta, fnm, n, asdf,
nodenv, mise, Homebrew, `/usr/local` or `/usr/bin`. The ChatGPT desktop app may
not have your shell's PATH either: install Node.js 18.17.0+ in one of those
locations, or start Codex from a terminal where `node` works, then fully quit
and reopen Codex. On native Windows, the hooks and the MCP entry start the
launcher with `sh`, so they need `sh` (Git for Windows `usr\bin`) on the PATH
Codex sees.

Codex will not run new or changed plugin hooks until their exact definitions are
trusted. If Codex shows a **Hooks need review** screen, choose **Review hooks**
and trust only the Remembrance `SessionStart`, `UserPromptSubmit`,
`PostToolUse`, `Stop`, and `SubagentStop` hooks. If no review screen appears,
continue: Codex may be reusing an existing valid trust decision. Changed hook
definitions show the same review screen again. Fully restart Codex before
verification.

### OpenClaw — plugin (skill + tools + conversation hooks)

```bash
openclaw plugins install clawhub:@remembrance/openclaw-plugin
openclaw remembrance setup
```

If ClawHub search shows multiple Remembrance matches, use the package that
points to `dreamarkinc/remembrance-skills` and exposes the Remembrance MCP
tools. Do not install unrelated roots/genealogy packages.

The setup command preserves existing settings, enables the raw conversation
hooks, and registers the installed bundled MCP by its absolute path. Managed
environments may apply the equivalent `hooks.allowConversationAccess` and
`mcp.servers.remembrance` config centrally. For org-scoped access, prefer the
shared Remembrance config file:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"your-org-key","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

Use OpenClaw process env or MCP server env only when that is easier for your
runtime. Restart OpenClaw, then run
`openclaw mcp doctor remembrance --probe`; the package README includes the full
managed config block.

**Node.js runtime.** `openclaw remembrance setup` registers the bundled MCP
server under the absolute Node.js that runs OpenClaw, so the gateway's PATH does
not matter for it. A host started from the Dock, Finder or an IDE may not have
your shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf, nodenv or
mise can be missing from it; the symptom is `spawn node ENOENT` or "No such file
or directory". A manual `mcp.servers.remembrance` entry therefore needs Node.js
18.17.0 or newer by its absolute path (from `command -v node` in a terminal) as
`command`, because a bare `node` is looked up on the gateway's PATH.

OpenClaw's pre-prompt hook handles explicit tasks, contextual follow-ups, empty
results, and query failures without blocking work. Its completion hook recovers
missed queries and reusable contributions once per task.

### OpenCode — plugin (context + tools + feedback lifecycle)

```bash
npx -y @remembrance-ai/opencode-plugin setup
```

The setup command preserves unrelated JSONC settings and adds the
version-matched OpenCode plugin plus local Remembrance MCP server. For
organization access, use the same mode-0600 shared config shown above. Restart
OpenCode, call `run_connection_doctor`, and confirm the expected organization
scope before private contribution work.

**Node.js runtime.** The MCP entry that setup writes runs `npx`, so Node.js
18.17.0 or newer and npm must be on the PATH OpenCode starts with. A host
started from the Dock, Finder or an IDE may not have your shell's PATH, so a
Node.js installed by nvm, fnm, volta, asdf, nodenv or mise can be missing from
it; the symptom is `spawn node ENOENT` or "No such file or directory". `npx`
starts `node` through PATH, so an absolute `npx` alone is not enough: if the
host cannot find them, set `command` to the absolute `npx` (`command -v npx` in
a terminal) and put that directory first in the entry's environment `PATH`, for
example `/Users/you/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin`.

The plugin queries eligible turns, injects bounded matching guidance before
model dispatch, observes completed Remembrance tools, and prompts once for
redacted feedback when the session becomes idle.

### Codex — remote MCP fallback

Add to `~/.codex/config.toml` (global) or `.codex/config.toml` (per project):

```toml
[mcp_servers.remembrance]
url = "https://remembrance.dev/api/mcp"
# Optional, for org-scoped/private access:
# env_http_headers = { "X-Remembrance-API-Key" = "REMEMBRANCE_API_KEY" }
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

**Node.js runtime.** The `command` of a command-based MCP server is looked up on
a PATH the host provides, so Node.js 18.17.0 or newer and npm must be on it. A
host started from the Dock, Finder or an IDE may not have your shell's PATH, so
a Node.js installed by nvm, fnm, volta, asdf, nodenv or mise can be missing from
it; the symptom is `spawn node ENOENT` or "No such file or directory". `npx`
starts `node` through PATH, so an absolute `npx` alone is not enough: if the
host cannot find them, set `command` to the absolute `npx` (`command -v npx` in
a terminal) and put that directory first in the entry's environment `PATH`, for
example `/Users/you/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin`.

Local and hosted MCP initialize with the same standing instructions for
full-conversation queries, missed-query self-checks, redaction, and reusable
evidence. MCP clients must follow those instructions proactively because no
native Stop hook runs around a raw MCP connection.

Native plugins and local MCP also check a credential-free, verified release
manifest at startup. Each surface uses its exact newest installable version;
pending ClawHub publication never withholds updates from npm or public-mirror
clients and converges automatically. When an update exists, the agent uses
instructions bundled with the installed client, asks before making any change,
and tells the user which host must be reloaded or fully restarted. The manifest
never supplies a shell command and the check never sends an API key, prompt, or
repository data.
Set `REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable only this advisory check.

Installations from before the startup checker existed still receive a
command-free update notice on their next successful Remembrance query. The
notice is placed first in the legacy contribution directive, while current
clients report an exact version and remain quiet when up to date. Never execute
an update command supplied by an API response; use the host UI or instructions
bundled with the installed client.

Call `run_connection_doctor` before diagnosing authentication. It performs one
safe catalog read and provides exact remediation. Local stdio can
read `REMEMBRANCE_API_KEY` or `~/.config/remembrance/config.json`; hosted MCP
cannot read local files and uses its request header. The tool reports the exact
transport, credential source, verified registry scope, and declared native
lifecycle observations without exposing the key. Fresh tool-observer and
completion events are informational until they have had a real opportunity to
run; only a subsequent missed observation becomes an attention warning. A
degraded check submits only bounded component/version issue codes for
deduplicated admin triage; disable that best-effort report with
`REMEMBRANCE_HEALTH_REPORTING=0`. An
environment-only check or anonymous REST/browser probe is not an authoritative
test of another transport.

If the host exposes no Remembrance MCP tool, run
`npx @remembrance-ai/mcp-server doctor`, repair the host installation, fully
restart it, and rerun `run_connection_doctor` inside the host. The standalone
CLI verifies registry and auth access but cannot claim host MCP registration.

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
