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
governs the current task immediately. Known built-ins activate durably at once.
Custom preferences remain pending until automatic normalization and validation
approves them; unsafe, malformed, or uncertain custom behavior stays inactive
and is never replayed to an agent. Classification runs
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

## What the hooks do

| Hook                             | Event              | Behavior                                                                                                |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `scripts/session-start.mjs`      | `SessionStart`     | Records activation health and states how to verify setup.                                               |
| `scripts/query-on-prompt.mjs`    | `UserPromptSubmit` | Queries Remembrance before non-trivial reusable work and injects matching skills as context. Fail-open. |
| `scripts/record-detail-open.mjs` | `PostToolUse`      | Correlates Remembrance tool calls with the active directive.                                            |
| `scripts/contribute-on-stop.mjs` | `Stop`             | Silently closes redacted feedback once per engagement when Remembrance was used.                        |

Set `REMEMBRANCE_AUTO_QUERY=0` to disable the prompt hook, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable automatic contribution closure. The
compact continuation keeps routine hook narration, tool receipts, and
correlation IDs out of the final answer; only a failure, host-policy block, or
required user action is surfaced.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration. This mirrors the Codex
behavior: a Codex tenant/privacy-policy denial occurs before Remembrance is
reached and must not be reported as a Remembrance setup failure. When the host
reports such a denial to the agent, the agent must say: **Remembrance was
blocked by host policy before reaching Remembrance. Nothing was sent. Querying
remains available.** It must not retry or automatically create a handoff.

### Private lesson autopilot

The local `prepare_private_lesson_candidate` tool canonicalizes and redacts a
routine organization lesson in memory, then stores only an encrypted
post-redaction draft. The separate `submit_private_lesson_candidate` tool sends
those exact bytes to the private verifier queue. This action always submits
privately and never falls back to anonymous or public submission. After the
private outcome is accepted, a separate server-owned process may create a
freshly redacted public candidate only when the organization admin enabled
**Contribution propagation**; the submitting agent neither chooses nor sees
that process, and the derivative must pass the complete public pipeline.
Unresolved and terminal drafts never expire or auto-delete. Verified
submissions discard encrypted lesson content immediately; their content-free
completion markers are automatically deleted after 14 days.

The signed policy pins the corrected `private-lesson-redaction-v2` profile and
its exact digest. Unsupported-profile drafts become terminal
`superseded_redactor`, stay encrypted, and are never retried, re-redacted, or
automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

In **Chat: Manage Tool Approval**, approve only the Remembrance
`submit_private_lesson_candidate` tool for all future invocations. Keep broad
global auto-approval off. The local preparation, inspection, retry, and
confirmed-delete tools remain local-only; hosted MCP alone reports
`auto_capture_supported: false`.

## Generated files

`servers/remembrance-mcp.mjs` and `skills/remembrancer/` are generated. Run
`npm run refresh:generated` from the repo root after changing the MCP server or
the canonical skill; `npm run check:generated` guards every copy.
