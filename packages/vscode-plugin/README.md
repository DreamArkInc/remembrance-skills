# Remembrance VS Code Plugin

Installs the Remembrancer skill, the Remembrance MCP server, and the lifecycle
hooks that let VS Code agent mode find reviewed guidance during work and hand
back what it learned when the task is done.

That loop runs both ways: VS Code reuses skills other agents already proved out,
and contributes what it learns so the next agent starts further ahead.

## Requirements

VS Code **agent plugins** (Preview). VS Code auto-detects the Claude plugin
format, so this package's `.claude-plugin/plugin.json`, `hooks/hooks.json`,
`.mcp.json`, and `skills/` load directly, and `${CLAUDE_PLUGIN_ROOT}` resolves to
this package's directory.

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
picker. With an organization key, finish with
[Highly Recommended: approve private submissions](#highly-recommended-approve-private-submissions).

At session start, Remembrance checks a credential-free public release manifest.
If a newer verified plugin exists, the agent tells the user to refresh the
plugin's marketplace or managed source, update Remembrance, and reload the VS
Code window. Remembrance never updates itself silently. VS Code follows its
exact public-mirror release and does not wait for unrelated npm or ClawHub
surfaces. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the advisory check.

VS Code installations from before this startup check existed still receive a
command-free update notice on their next successful Remembrance query. The
notice points to the normal managed plugin source and never invents a command.

With an organization key, a session that starts with a session id also reads
the organization's session skills (at most five slugs and version ids, never
skill text) and asks the agent to load each one with `invoke_skill` before its
first reply. VS Code documents neither a start source nor a guaranteed session
id for `SessionStart`, so a session without an id gets no request, and resume
or compaction re-delivery depends on VS Code sending the Claude-format
`source` field; a `compact` source repeats the request from a private
per-session cache without a network call. Each request carries the same
idempotency key, so a repeat returns the first invocation. A pinned version
that is no longer available is reported and skipped, never replaced. Set
`REMEMBRANCE_SESSION_SKILLS=0` to turn this off.

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

After actually using an exact skill version, the agent may call
`submit_preference_compatibility_feedback` only with the exact correlation IDs
and server-issued preference fingerprint in that result's feedback offer. The
server verifies the fetch and active preference. The operation requires a
verified principal session, remains private to the organization, and never
edits the skill.

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

After reloading, run MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step if attention is required. Use `get_connection_status` only for lower-
level fields. Fresh tool-observer and completion events are informational until
a later lifecycle opportunity is actually missed. Never infer this plugin's
scope from `REMEMBRANCE_API_KEY` alone, from an
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

This paired file binds the key to that destination. If environment variables
are used instead, set `REMEMBRANCE_API_KEY_ORIGIN` equal to the exact custom
`REMEMBRANCE_API_URL`. Remote registries require HTTPS; a trusted private or
link-local self-host also requires `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`.

### Highly Recommended: approve private submissions

For organizations that use Remembrance with a private organization key, this
step is required for Remembrance to do its job fully. Without it, every private
lesson or skill submission stops for a manual approval in VS Code. Public-only
use, without an organization key, does not need it.

VS Code has no settings key or policy that pre-approves a single tool, so use
its interface:

1. Run **Chat: Manage Tool Approval** and expand the Remembrance server.
2. Tick only `submit_private_lesson_candidate`,
   `retry_private_lesson_candidate`, `submit_private_skill_candidate`,
   `retry_private_skill_candidate`, and the local-only `capture_learning`. It
   stays on this machine and sends nothing, but VS Code asks before it too,
   and every local private submission starts with it.
3. Turn off **Configure for this workspace only** so the approval applies in
   every workspace.

Do not tick the server's own box or choose **Always Allow Tools from** the
server: both approve the whole server. Never approve the `delete_private_*`
tools. Alternatively, choose **Always Allow** in the prompt's Allow menu the
first time each of those five tools asks.

Check the step by behavior: capture one disposable private lesson and confirm
that neither the capture nor its submission prompts. `run_connection_doctor`
cannot see a persisted approval.

## What the hooks do

| Hook                             | Event                           | Behavior                                                                                                                  |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `scripts/session-start.mjs`      | `SessionStart`                  | Records activation health and states how to verify setup.                                                                 |
| `scripts/query-on-prompt.mjs`    | `UserPromptSubmit`              | Queries Remembrance before non-trivial reusable work and injects matching skills as context. Fail-open.                   |
| `scripts/record-detail-open.mjs` | `PostToolUse`                   | Correlates Remembrance tool calls with the active directive.                                                              |
| `scripts/contribute-on-stop.mjs` | `Stop`                          | Silently records bounded pending work for exact recovery on the next prompt.                                              |
| `scripts/contribute-on-stop.mjs` | `SubagentStart`, `SubagentStop` | Marks a subagent's start so its task prompt is not taken for yours, and leaves a subagent's unpaid actions to its parent. |

Host-generated text a trigger word matches (a Codex commit or pull-request
generation prompt, a subagent hand-back, pasted `git status` output, an explicit
local skill invocation) skips only the skill search: the organization policy,
required settings and preferences a search would carry still arrive; set
`REMEMBRANCE_AUTO_QUERY_HYGIENE=0` to search it anyway.
Besides prompts a keyword trigger matches, the hook searches any other
task-shaped prompt of at least 40 characters (trigger reason `task_shape`).
A task-shape search that finds nothing adds nothing of its own: no no-match
block, no completion recovery and no query-feedback request. Its organization
policy, required settings, preferences and capture lines still arrive, and the
server still records the missing-skill demand.
Set `REMEMBRANCE_AUTO_QUERY_TASK_SHAPE=0` to search keyword-triggered prompts
only.
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
Set `REMEMBRANCE_AUTO_QUERY=0` to disable the prompt hook, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable automatic contribution closure. The
Stop hook allows the current final answer and defers routine recovery to the
next real user prompt. That prompt receives only the exact pending query,
`submit_query_feedback`, categorical `submit_feedback`, or `capture_learning`
actions. Hook narration, tool receipts, and correlation IDs stay out of the
final answer; only a failure, host-policy block, or required user action is
surfaced.

VS Code names a subagent only in `SubagentStart` and `SubagentStop`, and sends
the subagent's task through `UserPromptSubmit` under your session right after
its start. The prompt hook skips a prompt VS Code stamped within 10 seconds
after a recorded subagent start as that subagent's task. If a request is
cancelled between those two hooks, a prompt of yours stamped within those 10
seconds is skipped the same way: it gets no query and no pending-action
reminder, and your next prompt does.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration. This mirrors the Codex
behavior: a Codex tenant/privacy-policy denial occurs before Remembrance is
reached and must not be reported as a Remembrance setup failure. When the host
reports such a denial to the agent, the agent must say: **The host blocked this
Remembrance action. Do not treat it as submitted. Earlier successful actions
are unaffected; querying remains available.** It must not retry or automatically create a handoff.

### Private learning autopilot

Current organization-capable local clients expose `capture_learning` as the
only routine reusable-learning entry point. Supply exactly one compact
`lesson`, complete `private_skill`, or structured durable `preference`. It
accepts no organization, destination, visibility, credential, or public
fallback. Lessons are canonicalized and redacted in memory; complete skills
retain bounded markdown, public citations, snippets, metadata, and actionable
instructions. Lesson and skill drafts are encrypted in separate outboxes; a
preference returns the exact existing `record_preference` action.
`capture_learning` is local and makes no network request.

Invoke only the returned `submit_private_lesson_candidate`,
`submit_private_skill_candidate`, or `record_preference` action.
These actions always submit privately. Lesson and skill actions carry only a local draft ID
through VS Code to the private organization pipeline and never fall back to
anonymous or public submission. Accepted content reuses the existing verifier, topology, review,
versioning, audit, and admin-controlled propagation pipeline; the submitting
agent never chooses visibility. After the private outcome is accepted, a separate server-owned process may create a
freshly redacted public candidate only when the organization admin enabled
**Contribution propagation**; the submitting agent neither chooses nor sees
that process, and the derivative must pass the complete public pipeline.
Unresolved and terminal drafts never expire or auto-delete. Verified
submissions discard encrypted lesson content immediately; their content-free
completion markers are automatically deleted after 14 days.

The lesson client offers a bounded `private-lesson-redaction-v2` supported
redactor-profile set and the
server signs policy for the newest mutual profile. Retained drafts require
their exact bound profile. Temporary incompatibility remains encrypted as
`awaiting_compatible_profile` with precise update, full-restart, or
server-rollout guidance; it is not mislabeled as safety or host denial. A
profile becomes terminal only when the installed client no longer supports it;
that state is `superseded_redactor`. Terminal drafts stay encrypted and are never retried, re-redacted, or
automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

In **Chat: Manage Tool Approval**, approve the Remembrance submit and retry
tools for both the `private_lesson` and `private_skill` lanes for future
invocations, with **Configure for this workspace only** turned off, as in the
Highly Recommended step. Remembrance maps an existing submit approval to its
lane. Keep broad global auto-approval off. Local capture, inspection, and confirmed
deletion remain zero-network; a fresh-draft retry stops before network access.
`submit_query_feedback` remains an independent bounded query-fit action;
hosted MCP alone reports
`auto_capture_supported: false`.

Broad `submit_remembrance` and `propose_private_skill` are legacy/hosted/raw
compatibility routes and are unavailable by default locally.
`submit_query_feedback` remains independent and accepts one complete
good/partial/poor query-fit verdict set; `submit_feedback` remains categorical
post-use feedback.

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

## Generated files

`servers/remembrance-mcp.mjs` and `skills/remembrancer/` are generated. Run
`npm run refresh:generated` from the repo root after changing the MCP server or
the canonical skill; `npm run check:generated` guards every copy.
