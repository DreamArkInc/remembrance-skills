# Remembrance Codex Plugin

Ports the [Remembrance Claude Code plugin](../claude-code-plugin) to the OpenAI
Codex CLI. It installs the Remembrancer skill, a bundled local Remembrance MCP
server, and lifecycle hooks that keep the registry loop symmetric: a
`UserPromptSubmit` hook that queries Remembrance before Codex reasons about tasks
likely to involve reusable skills/resources, and a `Stop` hook that — when a
session used Remembrance or a reusable task missed its query — records the
pending loop silently so the next user prompt can carry the exact bounded
recovery actions without obscuring the current final answer.

Both halves compound: each query reuses work another agent already finished, and
each contribution back sharpens the registry the next Codex session will query.
Your agent keeps getting smarter, and so does the network behind it.

## Install (marketplace)

```bash
CODEX_CLI="${CODEX_CLI:-$(command -v codex || true)}"
[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/ChatGPT.app/Contents/Resources/codex"
[ -x "$CODEX_CLI" ] || CODEX_CLI="/Applications/Codex.app/Contents/Resources/codex"
[ -x "$CODEX_CLI" ] || { printf '%s\n' "Codex CLI not found. Install the Codex CLI, or install or update the ChatGPT desktop app on macOS, then try again." >&2; exit 1; }
"$CODEX_CLI" plugin marketplace add dreamarkinc/remembrance-skills &&
  "$CODEX_CLI" plugin marketplace upgrade remembrance &&
  "$CODEX_CLI" plugin add remembrance@remembrance &&
  "$CODEX_CLI"
```

This one setup works for both first install and update. If your shell prints
`codex: command not found`, it automatically checks the current
`ChatGPT.app` bundle and then the legacy `Codex.app` compatibility path. The
final command opens Codex CLI so its secure hook review can be completed when
Codex requires it.

Codex will not execute plugin hooks until their exact definitions are trusted.
In the Codex window opened by the installer, if Codex shows a **Hooks need
review** screen, choose **Review hooks** and trust only the Remembrance
`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SubagentStop`
hooks (press `t` on each). If no review screen appears, continue: Codex may be
reusing an existing valid trust decision. Changed hook definitions show the
same review screen again; this is a Codex security boundary and the installer
does not bypass it. Fully restart Codex before verification.

**After an update.** Codex trusts a hook by the hash of its definition, so an
update that changes a hook holds it until you approve it again. Updating from
0.1.x to 0.2.0 changes all five: Codex holds `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, and `Stop` as modified and the new
`SubagentStop` as new, and runs no Remembrance hook until you approve them in
the review above; the MCP tools keep working. While Codex holds any of them,
the bundled MCP server says so where the agent sees it:

- Its initialize instructions carry one line after the core rules:
  "Remembrance hooks await Codex approval: run codex, choose Review hooks,
  press t." When an update notice applies too, the notice comes first, so
  its headline stays within the 2,048 characters that truncating clients
  show, and the line follows it. Codex 0.145 passes the whole instructions
  to the model.
- `get_connection_status` and `run_connection_doctor` report
  `hooks_pending_approval` with the held hooks and the exact review step and
  command, and the doctor's plugin lifecycle check warns with the same step.

The server reads this without running Codex: the hash Codex recorded when each
Remembrance hook was approved (`[hooks.state]` in the `config.toml` of the Codex
home the plugin is installed in) against the hash of the installed
`hooks/hooks.json`. It reports hook event names only, never paths, hashes or
other plugins' entries. Off Codex, and once Codex trusts every hook, it adds
nothing. When it cannot read that state (a `config.toml` or `hooks.json` form
it was not checked against, a file over its bound, or a held reading of a
`SessionStart` that already ran in this version), it says "Could not read Codex
hook trust state" instead of guessing either way.
`scripts/native-host-checks/codex.mjs` checks the reading against the pinned
Codex 0.145.0.

Under an administrator policy with `allow_managed_hooks_only = true`, Codex runs
managed hooks only and skips the plugin's, trusted or not, so there is nothing
to approve. What the hooks did comes first: a fully trusted install adds nothing
whatever the policy says, and once this version's `SessionStart` ran, Codex
evidently runs the plugin's hooks and a held one keeps its review step. The
server reads the policy only when a hook is held and no `SessionStart` of this
version ran, and then says so instead of giving a review step: the initialize
line reads "Remembrance plugin hooks are off: Codex policy runs only managed
hooks. Tools work.", `hooks_pending_approval` reports `managed_hooks_disabled`,
and the doctor's lifecycle check and the plugin health issues say that an
administrator must allow plugin hooks or deploy equivalent managed hooks.

It reads the setting without running Codex and reports nothing from these
sources: `/etc/codex/requirements.toml` (not read on Windows); on macOS the
`requirements_toml_base64` preference of `com.openai.codex`, first found in the
managed preferences for the user, then for the device, then the user's and the
machine's own preferences (the ByHost and global domains are not read); and the
workspace bundle Codex caches as `cloud-config-bundle-cache.json` in its home,
ignored once expired as Codex ignores it, with fields it does not read ignored
so that a field a later Codex adds changes nothing. A source that is present but
unreadable, oversized or in a form it does not know around the setting, or
sources that disagree, give the "Could not read Codex hook trust state" line; a
policy that leaves the setting unset or false changes nothing. The reader checks
the forms around the setting, not the whole document: a requirements document
that is not valid TOML elsewhere is read for the setting it names. Codex refuses
such a document when it loads its configuration ("failed to parse requirements
layer"), so the case left is a file edited while a session runs. The cache's
form was read from the pinned Codex binary, not from a delivered bundle, and
none of these sources was staged for Codex itself. The cache's signature and the
account it was fetched for are not checked (that would take Codex's credentials
file), so right after a switch of ChatGPT account the reading can follow the
previous account's cached policy.

Codex 0.145 has no install or update message a plugin controls: the plugin
and marketplace manifests have no such field, and the installation interstitial
of Codex's plugin directory is set by the directory. Its terminal UI shows its
own **Hooks need review** screen at startup; whether the ChatGPT desktop app
shows one was not verified.

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

On a fresh Codex session, Remembrance checks a credential-free public release
manifest. When a newer verified plugin exists, Codex receives the trusted local
update command, asks for permission before running it, and tells the user to
fully quit and reopen Codex afterward. It never updates silently or treats the
new version as active before restart. Codex follows its exact public-mirror
release and does not wait for unrelated npm or ClawHub surfaces. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable this advisory check.

Codex installations from before this startup check existed still learn about a
verified update on their next successful Remembrance query. The API places a
command-free notice first in the legacy contribution directive; only this
installed plugin supplies the trusted local update command.

With an organization key, a Codex session that starts, resumes, or is cleared
also reads the organization's session skills (at most five slugs and version
ids, never skill text) and asks Codex to load each one with `invoke_skill`
before its first reply. After a compaction the hook repeats that request from a
private per-session cache without a network call, and a resume uses the cache
when the registry is unreachable. Each request carries the same idempotency
key, derived from the Codex `session_id`, so a repeat returns the first
invocation. A pinned version that is no longer available is reported and
skipped, never replaced. Anonymous sessions skip this step; set
`REMEMBRANCE_SESSION_SKILLS=0` to turn it off.

After install, fully restart Codex and verify the loop before assuming the
plugin is active:

1. Complete the hook review above if Codex requests it and trust only the
   listed Remembrance hooks.
2. Ask Codex: "Before solving, call Remembrance query_skills for Codex plugin
   setup."
3. Ask it to run `run_connection_doctor`. Require `safe_to_query: true`; follow
   its one remediation if attention is required. Do not accept an environment-
   variable check or an anonymous curl/browser probe as a substitute.
4. Confirm it reports a concrete Remembrance receipt such as a query id,
   returned skill slug, MCP tool result, or REST status.
5. After it evaluates returned results, confirm it calls
   `submit_query_feedback` for explicit good/partial/poor matches. After it
   actually uses a skill/resource, confirm it calls categorical
   `submit_feedback`. For reusable learning, confirm it separately calls
   `capture_learning` with exactly one compact lesson, complete private skill,
   or durable preference and invokes only the returned exact action.
6. With an organization key, complete
   [Highly Recommended: approve private submissions](#highly-recommended-approve-private-submissions)
   below, then confirm one private submission completes without a prompt.

If Codex can see the plugin skill but not the MCP tools, or the CLI review shows
any Remembrance hook as **Needs review**, treat the installation as degraded
until hook trust, restart, and MCP registration are fixed.
`run_connection_doctor` reads Codex's own hook trust status and names the exact
Remembrance hook that needs review. The health marker stores only bounded event
names and trust states, never hook commands, local paths, or hashes. On a fresh
process, unexercised tool-observer and completion events are informational; a
warning appears only after a later lifecycle opportunity is actually missed.

### Highly Recommended: approve private submissions

For organizations that use Remembrance with a private organization key, this
step is required for Remembrance to do its job fully. Current Codex source does
not ask before these tools under the default `auto` tool approval mode, so
there the tables are a safeguard. Under the managed `writes` mode, the `prompt`
mode, or older releases, every private lesson or skill submission otherwise
stops for approval, and a run that cannot ask denies it. Public-only use,
without an organization key, does not need it.

Merge one table per private submit and retry tool into the user-level
`~/.codex/config.toml` (do not duplicate an existing table). Keep them separate
from the optional routine-feedback opt-in below:

```toml
[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.submit_private_lesson_candidate]
approval_mode = "approve"

[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.retry_private_lesson_candidate]
approval_mode = "approve"

[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.submit_private_skill_candidate]
approval_mode = "approve"

[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.retry_private_skill_candidate]
approval_mode = "approve"
```

- Under the managed `default_tools_approval_mode = "writes"`, Codex asks
  before every call, from a person or from Auto-review where it is the
  reviewer, and cannot remember the answer, so a per-tool `approve` entry is
  the only way to persist approval.
- `approve` also skips Auto-review for that tool, so the organization's
  guardian policy no longer evaluates it. In a managed organization, add these
  tables only with your administrator.
- That mode also asks before `capture_learning`, which every local private
  submission starts with. It is local only: it stays on this machine and sends
  nothing. Approving it lets runs that cannot ask capture, but then Auto-review
  never sees the lesson content; the managed Codex recipe in
  `skills/remembrancer/references/remembrance-setup.md` gives that optional
  table.
- Never approve `delete_private_lesson_candidate`,
  `delete_private_skill_candidate`, or the whole server.
- A manually registered server uses `mcp_servers.remembrance` tables instead;
  see [Manual install](#manual-install-configtoml).

Check the step by behavior: capture one disposable private lesson and confirm
that neither the capture nor its submission prompts. Where the organization
leaves the capture to Auto-review or a person under `writes`, only the capture
is reviewed; its submission still must not prompt. `run_connection_doctor`
cannot see a persisted approval.

### Optional unattended routine feedback

After the user explicitly opts in, merge these two tool overrides into
`~/.codex/config.toml` (do not duplicate an existing table):

```toml
[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.submit_query_feedback]
approval_mode = "approve"

[plugins."remembrance@remembrance".mcp_servers.remembrance.tools.submit_feedback]
approval_mode = "approve"
```

This user-level approval persists across future sessions on this installation
until removed. Installing the plugin does not grant it. Use it only with an
organization-authenticated local plugin whose `submit_feedback` schema is
categorical and rejects `lesson`. Keep routine ratings minimal: Remembrance-
issued query/result IDs, categorical fit or usefulness/rating, required reasons
for query-fit verdicts, the skill slug where required, and stable idempotency.
Do not automatically attach internal receipt hashes, task prose, source
content, raw logs, or private URLs. Public
substantive reports keep their separate evidence requirements; reusable private
lessons use `capture_learning` and its exact returned action.

Both tools make real writes. Post-use feedback can enter verification and incur
processing cost under the existing organization policy. This opt-in does not
approve private lesson/skill submission (the Highly Recommended step above
covers that), publishing, deletion, reset, preference changes, or other tools.
It does not widen `enabled_tools` or override managed policy, network
restrictions, or organization processing grants. It does skip the Codex
approval prompt and its Auto-review (guardian) evaluation for these two tools.
Do not set the whole server's approval default to `approve`.

Tool overrides persist when authentication or schemas change. Remove or
re-review both approvals before switching to anonymous or hosted transport,
enabling legacy broad writes, or changing the organization or destination.

To revoke, remove only these two tool-level approval entries; the inherited
approval policy applies again. Reconnect the plugin or start a fresh Codex
session if config is not reloaded, then verify with a minimal eligible rating.
`run_connection_doctor` verifies connection health, not host feedback permission.
If a rating is denied, acknowledge it locally and do not retry through another
transport. See [OpenAI's installed-server policy guide](https://developers.openai.com/plugins/build/plugins#configure-installed-server-policy).

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
and feedback remain private to the organization. An explicit instruction
governs the current task immediately. Known built-ins activate durably at once for a
managed-encryption organization.
Custom preferences remain pending until automatic normalization and validation
approves them; unsafe, malformed, or uncertain custom behavior stays inactive
and is never replayed to an agent.
An organization using customer-held encryption is currently deferred: every substantive preference write and every compatibility-feedback call is refused before persistence with HTTP 422 and code `customer_held_preference_processing_deferred`. Existing records are unchanged, reads and the content-free withdrawal lane keep working, and responses withhold the compatibility-feedback offer there. Read `activated` and
`normalized_activation_state` in the response instead of assuming a setting is
live. Classification runs
asynchronously against exact skill versions; query and invocation add no
generative preference call or second embedding request. Material compatibility
may reorder only already-relevant skills inside one match tier or apply a
surgical sidecar. Missing or stale coverage is neutral, and no preference can
weaken safety, authorization, privacy, applicability, required skill steps,
validation, review, or organization policy. Exact skill-version changes queue
only that skill for affected organizations; blocked classification resumes
automatically when the organization becomes eligible.

After actual use of an exact skill version, native hooks silently instruct the
agent to call `submit_preference_compatibility_feedback` only when observed
behavior clearly supports or conflicts with a normalized preference. The call
uses the exact correlation IDs and server-issued preference fingerprint from
that result's feedback offer, which the server verifies against the recorded
fetch and active preference. Hooks do not ask the user to confirm routine
telemetry or replay an existing classifier label as new evidence. The operation
requires a verified principal session, remains private to the organization,
and never edits the skill.

## Manual install (config.toml)

If you prefer not to use the marketplace, wire the hooks into
`~/.codex/config.toml` directly. Replace `/abs/path/to/codex-plugin` with the
absolute path to this package. The bundled `hooks/hooks.json` uses
`${PLUGIN_ROOT}` (the plugin-root variable Codex sets for
marketplace-installed plugins), so a manual hook install must use a literal
absolute path instead. Every command runs through the bundled
`scripts/node-launcher`, which finds Node.js 18.17.0 or newer when Codex's PATH
lacks it; to skip the launcher, replace `sh "…/node-launcher"` with the
absolute path from `command -v node` in a terminal.

```toml
[[hooks.SessionStart]]
matcher = "startup|resume|clear|compact"
[[hooks.SessionStart.hooks]]
type = "command"
command = 'sh "/abs/path/to/codex-plugin/scripts/node-launcher" "/abs/path/to/codex-plugin/scripts/session-start.mjs"'

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'sh "/abs/path/to/codex-plugin/scripts/node-launcher" "/abs/path/to/codex-plugin/scripts/query-on-prompt.mjs"'

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = 'sh "/abs/path/to/codex-plugin/scripts/node-launcher" "/abs/path/to/codex-plugin/scripts/contribute-on-stop.mjs"'

[mcp_servers.remembrance]
command = "sh"
args = [
  "/abs/path/to/codex-plugin/scripts/node-launcher",
  "/abs/path/to/codex-plugin/servers/remembrance-mcp.mjs",
]
env = { REMEMBRANCE_PLUGIN_HOST = "codex" }

```

With an organization key, this manually registered server named `remembrance`
takes the Highly Recommended approval as `mcp_servers.remembrance` tables:

```toml
[mcp_servers.remembrance.tools.submit_private_lesson_candidate]
approval_mode = "approve"

[mcp_servers.remembrance.tools.retry_private_lesson_candidate]
approval_mode = "approve"

[mcp_servers.remembrance.tools.submit_private_skill_candidate]
approval_mode = "approve"

[mcp_servers.remembrance.tools.retry_private_skill_candidate]
approval_mode = "approve"
```

The bundled local MCP server and native hooks both resolve
`REMEMBRANCE_API_KEY` first, then `~/.config/remembrance/config.json`. This
removes the Codex Desktop environment split: one mode-0600 config file covers
both. After restart, run `run_connection_doctor`; it verifies a safe catalog
read, registry scope, destination consistency, and observed native lifecycle
without exposing the key. Use `get_connection_status` only for underlying
fields. A manually configured hosted
MCP URL remains supported, but it cannot read a caller file and must receive a
request credential. A Codex tenant/privacy-policy denial occurs before the
Remembrance request and must not be reported as a Remembrance authentication or
authorization rejection.

For private repository-derived skills, a current local client uses
`capture_learning.private_skill` followed by the exact
`submit_private_skill_candidate` action. It requires an organization key and
can only create a candidate in that organization's private review queue. Broad
`propose_private_skill` and `submit_remembrance` tools are legacy/hosted/raw
compatibility routes and are unavailable by default locally. Codex workspace admins
must still approve `remembrance.dev` as a trusted destination in managed MCP,
network (when command networking is used), and Auto-review guardian policy. The
narrow policy example is in the bundled
`skills/remembrancer/references/remembrance-setup.md`; merge it into the
existing tenant policy instead of replacing credential and source-code deny
rules.

For managed Codex, configure both policy layers before rollout:

- in `requirements.toml`, restrict the marketplace source to the Remembrance
  repository. Never give the bundled local server the hosted URL as its
  identity: Codex matches a stdio server by its command (`sh`) and disables a
  server whose identity does not match an approved entry;
- in managed config, set `enabled_tools` to the bounded organization tool set
  in the bundled setup reference and use
  `default_tools_approval_mode = "writes"`. That mode asks before every call of
  every tool not marked read-only, including `query_skills`, `get_skill`,
  `invoke_skill`, `capture_learning`, and feedback, from a person or from
  Auto-review where it is the reviewer, and Codex cannot remember those
  answers. The four private submit and retry `approve` tables of the Highly
  Recommended step, shipped in the same managed config, let those calls run
  without that review. The trade-off: Auto-review never evaluates a tool set
  to `approve`, so the guardian policy no longer covers those four calls (they
  normally carry only a draft ID, so the content passes through
  `capture_learning`, which is still reviewed, but the lesson submit also
  accepts a lesson candidate written into the call, which then skips
  Auto-review). Leave them out if every private submission must pass
  Auto-review. The setup reference also gives an optional `capture_learning`
  table, local only, for runs that cannot ask; with it Auto-review never sees
  the lesson content;
- merge the Remembrance destination clause into `guardian_policy_config` and
  allow `remembrance.dev` for command networking only when stdio/REST fallback
  needs it; and
- do not set `allow_managed_hooks_only = true` unless equivalent managed query
  and completion hooks are deployed, because Codex otherwise skips plugin
  hooks.

With an organization key, generic `propose_skill_idea` calls also stay in the
organization review queue. Never remove or bypass the key to force a public
candidate; submit privately, then use the reviewed public-propagation flow.
The exact TOML, approved tool inventory, and official documentation links are
in `skills/remembrancer/references/remembrance-setup.md`. The same current,
host-by-host administrator guide is published at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>.

### Routing metadata on complete skill proposals

In 0.2.0 a complete skill sent with `propose_skill_idea` or
`propose_private_skill` (or their REST routes) carries routing metadata
(contract v1, published at `/schemas/skill-routing-metadata.v1.json`): when
an agent should pick the skill (`applicability`) and what it does and needs
(`routing`). Ask for a platform draft first, show it to the author, and send
the confirmed or edited fields back with the draft's token. The draft call
stores nothing:

```json
{
  "title": "Deploy a prepared app to Azure",
  "description": "Deploy an already-prepared app to Azure with azd.",
  "proposed_skill_md": "# Deploy a prepared app to Azure\n\nRun azd up ...",
  "prefill_routing_metadata": true
}
```

Its answer holds `example.proposed_metadata` and `routing_draft.token`. The
submission then sends the confirmed fields:

```json
{
  "title": "Deploy a prepared app to Azure",
  "description": "Deploy an already-prepared app to Azure with azd.",
  "proposed_skill_md": "# Deploy a prepared app to Azure\n\nRun azd up ...",
  "proposed_metadata": {
    "applicability": {
      "scope": "specialized",
      "use_when": [
        "The user wants to deploy an already-prepared app to Azure",
        "A deployment plan and infrastructure files already exist",
        "The user asks to run azd up or azd deploy"
      ],
      "avoid_when": [
        "The app has no Azure deployment files yet (prepare it first)",
        "The user only wants a readiness check without deploying"
      ],
      "task_examples": [
        "Deploy this prepared app to Azure Container Apps",
        "Run azd up for my project",
        "Push the validated Bicep deployment to production"
      ],
      "not_for": []
    },
    "routing": {
      "capabilities": ["deploy-to-cloud"],
      "domains": ["deployments-cicd", "cloud-platforms"],
      "runtime_requirements": ["repo-checkout", "shell", "cloud-account", "provider-azure"],
      "risk": "cloud-changes"
    }
  },
  "routing_draft_token": "rd1.<token from the draft>"
}
```

A complete skill without these fields is refused with 422
`skill_routing_metadata_incomplete` (`delivery: not_delivered`; nothing is
stored). The refusal lists every issue and carries the same draft, so fix
the listed fields and send the request again. Fields taken unchanged are
recorded as author-confirmed draft values; edits that widen the draft (a
broader scope, added `use_when` items or capabilities, a lower risk) are
flagged for review. An organization's text is drafted only through its
approved semantic-enrichment processing grant; without one the draft is held
and nothing is sent. A private capture (`capture_learning` with
`private_skill`) may ask for automatic completion: the skill becomes
available after acceptance once its routing metadata is complete.

If the host denies the export, do not retry through curl, browser tools, or a
different MCP transport. Remembrance reports one local, content-free alert:
**The host blocked this Remembrance action. Do not treat it as submitted.
Earlier successful actions are unaffected; querying remains available.** It does not automatically create a
handoff. Only when an organization admin explicitly requests one, use the
local-only `queue_private_skill_import` tool. Hosted-only Codex can run the bundled
`skills/remembrancer/scripts/queue-private-skill-import.mjs` helper against a
local request JSON. It writes a mode-0600 file under
`.remembrance/outbox/`, creates a protective `.gitignore`, and makes no network
request. An organization admin then uploads that file at Dashboard > Skills >
Import. The handoff is not a submission until the dashboard returns a batch
receipt.

### Private learning autopilot

Current organization-capable local clients expose `capture_learning` as the
only routine reusable-learning entry point. Supply exactly one compact
`lesson`, complete `private_skill`, or structured durable `preference`. The
router accepts no organization, destination, visibility, credential, or public
fallback. Lessons are canonicalized and redacted in memory; complete skills
retain bounded markdown, public citations, snippets, metadata, and actionable
instructions. Lesson and skill drafts are encrypted in separate local outboxes,
while a preference returns the existing `record_preference` action.
`capture_learning` is local and makes no network request. Never
compress a complete skill into a lesson.

Invoke only the returned exact action: `submit_private_lesson_candidate`,
`submit_private_skill_candidate`, or `record_preference`.
These actions always submit privately. Lesson and skill submit actions carry only a local draft ID
through Codex to the authenticated organization's pipeline and never fall
back to anonymous or public submission. Accepted content reuses the existing verifier,
topology, review, versioning, audit, and admin-controlled propagation pipeline;
the submitting agent never chooses visibility.
After the private outcome is accepted, a separate server-owned process may
create a freshly redacted public candidate only when the organization admin
enabled **Contribution propagation**; the submitting agent neither chooses nor
sees that process, and the derivative must pass the complete public pipeline.
Unresolved and terminal drafts never expire or auto-delete; retryable failures
resume later, while authentication, validation, policy, and host-denial states
remain held. Verified submissions discard encrypted lesson content immediately;
their content-free completion markers are automatically deleted after 14 days.

The lesson client offers a bounded `private-lesson-redaction-v2` supported
redactor-profile set and the
server signs policy for the newest mutual profile. Retained drafts require
their exact bound profile. Temporary incompatibility remains encrypted as
`awaiting_compatible_profile` with a precise client update, full restart, or
server-rollout action; it is not mislabeled as a safety rejection or host
denial. A profile is terminal only when the installed client no longer supports
it; that state is `superseded_redactor`. Terminal drafts remain encrypted and counted toward the outbox ceiling and
are never retried, re-redacted, or automatically deleted. A held draft may
send only category/version counts and signed protocol digests through the same
approved action when health reporting is enabled; this content-free telemetry
cannot enter verification, review, topology, or skill materialization. Disable
it with `REMEMBRANCE_HEALTH_REPORTING=0`.

Codex approves tools, not Remembrance lanes, and a prompt answer under
`writes` is never remembered, so persist approval with one `approve` table per
tool as in the Highly Recommended step. The `private_lesson` lane covers
`submit_private_lesson_candidate` and `retry_private_lesson_candidate`; the
`private_skill` lane covers `submit_private_skill_candidate` and
`retry_private_skill_candidate`. Existing submit approvals upgrade lazily to
their lane. A fresh-draft retry stops before network access. Capture,
inspection, and confirmed deletion remain local. `submit_query_feedback`
remains an independent bounded query-fit action. No `/hooks` command is
required.
`run_connection_doctor`
reports policy, signing, encryption, outbox, and action visibility without
showing lesson content or local paths. A hosted Remembrance app dependency will
be added only after the production connector has a real stable ID, so this
release ships no placeholder `.app.json`.

Note the underscore: Codex configures MCP servers under `[mcp_servers.<id>]`,
not `mcpServers`.

## Behavior

The `UserPromptSubmit` hook runs on every user prompt but only calls Remembrance
when the prompt mentions named services, APIs, CLIs, frameworks,
deployment/CI/payment/migration workflows, MCP/resource selection, UI/review
work, or unfamiliar third-party integrations. For context-only follow-ups such
as "fix these issues", "continue", or "try again", it injects an instruction to
infer the task from the full thread and call `query_skills`; prior conversation
text is not persisted or sent automatically. On a query hit it prints the
wrapped hook output
`{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}`
(the same shape Claude Code requires) so Codex injects the matching
skills/resources. It is enabled by default; set
`REMEMBRANCE_AUTO_QUERY=0` to disable network auto-query. The v0.1 heuristic is
English-first, so multilingual workflows should call `query_skills` explicitly
when useful.

The `Stop` (completion) hook is a silent recovery checkpoint. When the session
used Remembrance or an eligible task missed a query, it records bounded pending
obligations and allows the current answer to finish. On the next real user
prompt, the prompt hook injects only the exact outstanding actions: one complete
`submit_query_feedback` verdict set, categorical `submit_feedback` only for an
actually used result, and/or one `capture_learning` route. It never emits a
routine Stop-block prompt, tool receipt, or correlation ID that can hide the
user-facing final answer. Host-policy denials and required user action remain
visible. An explicit diagnostic mode may expose Stop recovery for testing, but
it is not the default. Set `REMEMBRANCE_AUTO_CONTRIBUTE=0` only when automatic
contribution closure is not wanted.

### How usage is detected without a transcript

The Claude plugin decides whether to prompt for a contribution by scanning the
session transcript for registry-consumption markers. Codex's `Stop` payload has
**no transcript path**, so this plugin uses a marker mechanism instead
(`scripts/hook-core.mjs`):

- The query adapter calls `recordRegistryUse(sessionId)` whenever a registry
  query completes, incrementing a per-session counter file under
  `os.tmpdir()/remembrance-usage/<hash>.use`.
- Relevant and contextual prompts call `recordTaskEligibility(sessionId)`,
  incrementing a `<hash>.eligible` counter even when the query is missed or
  unavailable. Later tasks in the same session therefore remain recoverable.
- The stop adapter reads that count via `readRegistryUseCount(sessionId)`,
  combines it with eligibility, records any still-pending obligations, and
  allows completion. The next real prompt consumes the bounded recovery state.

Both hooks **fail open**: they never block the user's work on API errors. A
timeout, HTTP error, or malformed response injects compact recovery guidance
instead of pretending Remembrance was used; unrelated prompts still inject
nothing. Prompt text is redacted for common secrets and private-network URLs
before any query is sent.

## MCP tools

The plugin is self-contained for Codex behavior: it installs the local hooks
that make Remembrance proactive and registers its bundled local MCP server. It
does not require separate `npx @remembrance-ai/mcp-server` setup or a GUI
process environment variable. After install, the `remembrance` MCP server
exposes tools such as `query_skills`, independent `submit_query_feedback`,
categorical `submit_feedback`, `capture_learning`,
`submit_private_lesson_candidate`, `submit_private_skill_candidate`,
`inspect_private_learning_outbox`, `get_skill`, `get_resource`, `list_skills`,
`invoke_skill`, `report_task_outcome`, `get_value_proof`,
`run_connection_doctor`, and `get_connection_status`. Broad
`submit_remembrance` and `propose_private_skill` tools are hidden by default for
an organization-capable local client; they remain explicit legacy/hosted/raw
compatibility routes.

Credential and lifecycle boundaries are observable. `run_connection_doctor`
performs a non-mutating read and interprets transport, scope, destination,
permissions, and lifecycle health. `get_connection_status` exposes the lower-
level transport and whether SessionStart,
prompt, tool-observer, and completion hooks have actually run. A missing native
marker is reported as degraded instead of allowing visible filesystem skills
to imply a healthy install. Degraded checks send only bounded component and
version issue codes for deduplicated admin triage; disable this best-effort
report with `REMEMBRANCE_HEALTH_REPORTING=0`. Never infer plugin scope from
`REMEMBRANCE_API_KEY` alone, and never use an anonymous REST/browser probe to
characterize another transport.

When the user explicitly names a Remembrance skill or supplies a
`remembrance://skills/{slug}` URI, Codex resolves ambiguous names with
the indexed, normalized slug-prefix filter in `list_skills`, then calls
`invoke_skill` with an exact returned slug instead of running a relevance query
to rediscover the selection. Use `query_skills` for discovery. Invocation
rechecks current organization policy,
loads the active reviewed version, and starts the post-use feedback/outcome
loop. Catalog and resource-handle reads never contain the full private body and
do not count as use. Direct selections use post-use feedback, never query-fit
feedback.

Every successful `query_skills` response includes a contribution directive. The
prompt hook injects that directive with the returned skills/resources so Codex is
shown a high/possible/exploratory tier, concise match reason, bounded
`why_matched` terms/capabilities/constraint evidence, conservative
`applicability` scope and use/exclusion conditions, metadata digests,
approximate context tokens, verified-use evidence, risk, and correlation IDs.
Codex first rules out an unlikely or irrelevant corner-case result and reports
query fit `poor`. A remaining high match is a required next step: Codex opens it with `get_skill` or `get_resource` and its
`query_id`/`result_id` before custom work; possible and exploratory matches remain
optional. Codex is then reminded in-band to report query fit with
one complete `submit_query_feedback` verdict set, close categorical post-use
feedback only for results it actually used, and route reusable content
separately through `capture_learning`. The Stop hook records missed obligations
silently; the next prompt carries the bounded recovery. A `PostToolUse` hook clears the marker
only after the same slug and `query_id`/`result_id` open successfully.
Without an organization key, the server's relevance judge chooses what a search
is shown from the top 20 public candidates: Jev (TypeSafe, through Vercel AI
Gateway) rates each candidate first, and a language model decides the ones Jev
leaves undecided while there is time. It receives the search's task text and
public skill cards only. Every request asks for zero retention and no prompt
training; for Jev, zero retention rests on Remembrance's account-specific
agreement with TypeSafe through Vercel, which the Gateway does not confirm.
With an organization key, a search is judged only under the organization's
managed processing grant for semantic search, and Jev rates it first only when
that grant also approves TypeSafe, under the owner-attested zero-retention
agreement with TypeSafe (owner decisions 36 and 64), which covers this judge
stage and no other purpose: its task text and skill cards, the organization's
own included, go only to the hosts that grant approves, each asked for zero
retention and no prompt training. Without that grant nothing is sent and the
search keeps the rule's list.
A card shows a skill's use and exclusion conditions only where the
platform generated them or a person reviewed them. A use condition only
promotes a result, and only an exclusion its author stated or a person
reviewed makes it `unlikely`; `applicability.provenance` says who stated
them.
For contextual continuation prompts, the hook also records an opaque directive
as shown. The next `query_skills` call carries that ID or is correlated by the
same `PostToolUse` observer, producing a real shown-to-followed compliance rate
without storing prompt text or affecting ranking.
Post-use feedback carries the same `query_id`/`result_id`,
and delegated agents receive the selected slug and IDs or run their own query.
Query-fit feedback is one complete verdict set of good/partial/poor labels per
query and must use the same organization scope or anonymous scope. Any active
key for that organization is valid. Identical retries are safe; changed later
judgments conflict, so uncertain results should remain unrated instead of being
appended later.
Anonymous verdicts remain low weight and never train a shared model. No learned
reranker is trained or served; changing `agent_id` does not create another
feedback actor.

When an exact, current, non-high-risk match has fresh grade A/B evidence for the
observed model revision, reasoning effort, and bounded task cohort, the result
may include one compact
token-only `potential_savings` estimate. The hook displays it without adding
money or commerce language. Codex then reports a bounded completion outcome
automatically when its runtime exposes lifecycle data; otherwise the MCP
`report_task_outcome` tool can close the episode using only IDs listed in
`task_outcome.eligible_result_ids`; every result and bundle also carries
`task_outcome_eligible`. No prompt, transcript, output,
source path, or private URL is included. `get_value_proof` cryptographically
verifies the signed receipt behind a qualified estimate and returns
`signature_verified: true` plus `verification_key_id`; its signed cohort fields
include task domain, stage, complexity, and bounded scope counts.
Private-skill receipts
require an active query-capable API key from the same organization; it need not
be the key used for the original query. They remain workspace-only and never
enter public cohorts. When Codex uses Vercel AI Gateway, include
every task generation ID in `metering_reference`; Remembrance encrypts those
references and trusts token totals only after Vercel independently returns and
single-claims all of them.

The bundled local server can mint a TOFU key with
`bootstrap_agent_identity`. A manual hosted-MCP override cannot write a key on
your machine; use the bundled server for that operation.

When `REMEMBRANCE_API_URL` points hooks at a non-default registry, the hook reads
`[mcp_servers.remembrance].url` from Codex config and compares it with the hook
API URL. It only shows a registry-split notice when the two resolved URLs differ.
If your Codex MCP URL is configured somewhere the hook cannot read, set
`REMEMBRANCE_CODEX_MCP_URL` to that MCP endpoint so the comparison is explicit.

If MCP tools are unavailable, use the REST contract from
`https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

## Environment

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_API_KEY_ORIGIN`: bind an environment key to an exact custom API
  URL. It is unnecessary for the default cloud URL or when `apiKey` and
  `apiUrl` are stored together in the shared config.
- `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`: explicit opt-in for a trusted
  private/link-local HTTPS self-host. Remote HTTP is rejected except on loopback.
- `REMEMBRANCE_CODEX_MCP_URL`: optional manual Codex hosted-MCP endpoint used
  only to verify hook/MCP registry alignment when the hook cannot read Codex
  config. The packaged plugin does not need it.
- `REMEMBRANCE_HEALTH_REPORTING=0`: disables bounded degraded-activation
  reporting. Local health status remains available.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the prompt hook's network query.
- `REMEMBRANCE_AUTO_QUERY_LIMIT`: result limit, default `3`, max `10`.
- `REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS`: hook request timeout. The search waits
  `3000` by default, so the server's relevance judge can take its longer
  2,000 ms hook deadline when Jev leaves candidates undecided; the hook's
  other requests wait `2000`. A value applies to every hook request, and one
  under `3000` tells the server not to wait that long. A stopped search whose
  preference read and search both hang delays the prompt about 5 s.
- `REMEMBRANCE_AUTO_QUERY_HYGIENE=0`: also searches host-generated text a
  trigger word matches (a Codex commit or pull-request generation prompt, a
  subagent hand-back, pasted `git status` output, an explicit local skill
  invocation). By default only its skill search is skipped: the organization
  policy, required settings and preferences a search would carry still arrive.
- `REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=0`: searches only prompts a keyword
  trigger matches. By default the hook also searches any other task-shaped
  prompt of at least 40 characters (trigger reason `task_shape`); one-off fact
  questions, status acknowledgments, explicit skill references, host text and
  short follow-ups are decided as before. A task-shape search that finds
  nothing adds no no-match block, completion recovery or query-feedback request
  of its own; the organization policy, required settings, preferences and
  capture lines still arrive, and the server still records the missing-skill
  demand.
- `REMEMBRANCE_DIRECTIVE_EVENT_TIMEOUT_MS`: fail-open shown/followed event
  timeout, default `750`, bounded to `100`-`2000` milliseconds.
- `REMEMBRANCE_AUTO_CONTRIBUTE=0`: disables silent completion recovery and its
  next-prompt contribution guidance.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.

With an organization key, every query returns `skill_access`. If its policy is
`org_only`, Codex uses only returned organization skills and never substitutes
bundled or live public skill references. Query failures still do not block the
user's work, but they fail closed for public-skill fallback until the
organization policy can be confirmed.

## Generated / copied files

`servers/remembrance-mcp.mjs` and the entire `skills/remembrancer/` tree are
**copied verbatim from the canonical source** — the same bundled artifacts the
Claude Code plugin ships (see `packages/claude-code-plugin/scripts/refresh-mcp-bundle.mjs`,
which builds `packages/mcp-server` and copies `skills/remembrancer/` from the
repo root). Do not edit them here; refresh the Claude plugin's bundle and re-copy
these files whenever `packages/mcp-server` or `skills/remembrancer` changes.
