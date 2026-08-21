# Remembrance opencode Plugin

Connects Remembrance to [opencode](https://opencode.ai): the MCP server that
exposes the Remembrance tools, plus a plugin that records activation health,
observes Remembrance tool use, and asks for redacted feedback when a session goes
idle.

## Install

Run one command:

```sh
npx -y @remembrance-ai/opencode-plugin setup
```

The setup command adds the version-matched plugin and local Remembrance MCP
server to `~/.config/opencode/opencode.json`. It preserves comments and unrelated
settings and creates a new config with mode `0600` when none exists.

Restart opencode. Remembrance then appears in its tools list, adds bounded
matching guidance to eligible model turns, observes completed use, and asks once
for concise, redacted feedback.

At session creation, the plugin performs a bounded, credential-free release
check. If a newer verified version exists, opencode shows a notice and gives the
agent the locally bundled setup command. The agent must ask before running it,
and the user must restart opencode afterward. Remembrance never updates itself
silently. OpenCode follows its exact npm release and does not wait for native
plugin marketplaces. Set `REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the
advisory check.

Older opencode installations that predate this startup check still learn about
a verified update on their next successful Remembrance query. The API places a
command-free notice first in the legacy contribution directive; only this
installed package supplies the trusted local setup command.

Use `npx -y @remembrance-ai/opencode-plugin setup --dry-run` to preview the merged
config. `opencode.json` in this package is a reference config for managed
deployments.

## Automatic context and feedback

The stable plugin API exposes `chat.message` and
`experimental.chat.system.transform`. Remembrance uses them together to run the
fail-open query helper and inject bounded guidance before an eligible model
turn. Empty or unavailable queries never block the task. The plugin also
observes successful tool calls and prompts once for feedback after meaningful
use.

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

The MCP server reads the same Remembrance config as the native plugins, so one
file authenticates both the plugin hooks and the local MCP server:

```sh
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

`REMEMBRANCE_API_KEY` in the environment works too. Because the plugin and the
local MCP server both read `~/.config/remembrance/config.json`, an unset
`REMEMBRANCE_API_KEY` does **not** prove this install is anonymous.

After restarting, run MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step if attention is required. Use `get_connection_status` only for lower-
level fields. Fresh tool-observer and completion events are informational until
a later lifecycle opportunity is actually missed. Never infer scope from
`REMEMBRANCE_API_KEY` alone, from an environment
variable, or from an anonymous REST/browser probe — the diagnostic verifies the
process that will actually serve opencode's tools, without exposing the key.

A **hosted MCP** registration is a different transport: it cannot read a file on
your machine, so it needs its own request credential. Raw REST does not load
plugin config automatically either.

For dev or self-hosted registries, add `apiUrl` to the same file:

```sh
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://dev.remembrance.dev"}\n' \
  > ~/.config/remembrance/config.json
```

This paired file binds the key to that destination. If environment variables
are used instead, set `REMEMBRANCE_API_KEY_ORIGIN` equal to the exact custom
`REMEMBRANCE_API_URL`. Remote registries require HTTPS; a trusted private or
link-local self-host also requires `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`.

## What the plugin does

| Event                                | Behavior                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| `session.created`                    | Reports activation health and how to verify organization scope. |
| `chat.message`                       | Runs the fail-open query helper for the current user turn.      |
| `experimental.chat.system.transform` | Adds bounded Remembrance guidance before model dispatch.        |
| `tool.execute.after`                 | Correlates query, invocation, detail, and contribution calls.   |
| `session.idle`                       | Shows a compact contribution nudge once per engagement.         |

Set `REMEMBRANCE_AUTO_QUERY=0` to disable the query, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable the completion nudge. OpenCode's
current idle event exposes this compact instruction as a toast or structured
log rather than forcing another agent turn.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration — the same boundary as a
Codex tenant/privacy-policy denial, which occurs before Remembrance is reached
and must not be reported as a Remembrance setup failure. The plugin reports one
local, content-free alert: **Remembrance was blocked by host policy before
reaching Remembrance. Nothing was sent. Querying remains available.** It does
not retry or automatically create a handoff.

### Private lesson autopilot

The local `prepare_private_lesson_candidate` tool canonicalizes and redacts a
routine organization lesson in memory and stores only an encrypted
post-redaction draft. `submit_private_lesson_candidate` is the separate network
action; it sends those exact bytes only to the authenticated organization's
private verifier queue. This action always submits privately and never falls
back to anonymous or public submission. After the private outcome is accepted,
a separate server-owned process may create a freshly redacted public candidate
only when the organization admin enabled **Contribution propagation**; the
submitting agent neither chooses nor sees that process, and the derivative must
pass the complete public pipeline. Unresolved and terminal drafts never expire
or auto-delete. Verified submissions discard encrypted lesson content
immediately; their content-free completion markers are automatically deleted
after 14 days.

The signed policy pins the corrected `private-lesson-redaction-v2` profile and
its exact digest. Unsupported-profile drafts become terminal
`superseded_redactor`, stay encrypted, and are never retried, re-redacted, or
automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

OpenCode permission keys match MCP tool names. Set only
`remembrance_submit_private_lesson_candidate` to `allow`; broader Remembrance
write tools can remain `ask` or `deny`. Local preparation, inspection, retry,
and confirmed deletion remain local-only. A host denial is held and is never
retried through another transport.

## Generated files

`servers/remembrance-mcp.mjs` and `skills/remembrancer/` are generated. Run
`npm run refresh:generated` from the repo root; `npm run check:generated` guards
every copy.
