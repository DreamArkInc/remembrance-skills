# Remembrance opencode Plugin

Connects Remembrance to [opencode](https://opencode.ai): the MCP server that
exposes the Remembrance tools, plus a plugin that records activation health,
observes Remembrance tool use, and records unfinished feedback/capture work
silently when a session goes idle so the next prompt can recover it.

## Install

Run one command:

```sh
npx -y @remembrance-ai/opencode-plugin setup
```

The setup command adds the version-matched plugin and local Remembrance MCP
server to `~/.config/opencode/opencode.json`. It preserves comments and unrelated
settings and creates a new config with mode `0600` when none exists.

Restart opencode. Remembrance then appears in its tools list, adds bounded
matching guidance to eligible model turns, observes completed use, and silently
queues any missing feedback or capture action for the next real prompt. With an
organization key, finish with
[Highly Recommended: approve private submissions](#highly-recommended-approve-private-submissions).

**Node.js runtime.** The MCP entry that setup writes runs `npx`, so Node.js
18.17.0 or newer and npm must be on the PATH opencode starts with. A host
started from the Dock, Finder or an IDE may not have your shell's PATH, so a
Node.js installed by nvm, fnm, volta, asdf, nodenv or mise can be missing from
it; the symptom is `spawn node ENOENT` or "No such file or directory". `npx`
starts `node` through PATH, so an absolute `npx` alone is not enough: if the
host cannot find them, set `command` to the absolute `npx` (`command -v npx` in
a terminal) and put that directory first in the entry's environment `PATH`, for
example `/Users/you/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin`.

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
observes successful tool calls and records pending feedback after meaningful
use for bounded recovery on the next prompt.

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

### Highly Recommended: approve private submissions

For organizations that use Remembrance with a private organization key, this
step is required for Remembrance to do its job fully: private lesson and skill
submissions must run without a manual approval. OpenCode runs MCP tools without
asking by default, so they already do. The entries below keep it that way
under a broader ask rule that comes before them, which would otherwise stop
every private lesson or skill submission for a manual approval. Public-only
use, without an organization key, does not need it.

Add the four private submit and retry tools and the local-only
`capture_learning` to the `permission` map in
`~/.config/opencode/opencode.json`. `capture_learning` stays on this machine
and sends nothing; every local private submission starts with it:

```json
{
  "permission": {
    "remembrance_submit_private_lesson_candidate": "allow",
    "remembrance_retry_private_lesson_candidate": "allow",
    "remembrance_submit_private_skill_candidate": "allow",
    "remembrance_retry_private_skill_candidate": "allow",
    "remembrance_capture_learning": "allow"
  }
}
```

Put them after any broader `"*"` or `"remembrance_*"` rule in the same
`permission` map, because OpenCode applies the last matching rule. A broader ask
rule set elsewhere, such as in an agent's own `permission` map or, depending on
the OpenCode version, in another configuration file, can still take precedence;
if the capture or its submission still prompts, find that rule and make sure the
same entries come after it. Never allow the `delete_private_*` tools this way.
In OpenCode 2.x, answering "always" at a prompt saves an allow rule for the
current project across sessions (1.x keeps it until OpenCode restarts), so never
answer "always" on a `delete_private_*` prompt; the
`~/.config/opencode/opencode.json` entries are the form that applies to every
project. Check the step by behavior: capture one disposable private lesson and
confirm that neither the capture nor its submission prompts.
`run_connection_doctor` cannot see a persisted approval.

## What the plugin does

| Event                                | Behavior                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| `session.created`                    | Reports activation health and how to verify organization scope. |
| `chat.message`                       | Runs the fail-open query helper for the current user turn.      |
| `experimental.chat.system.transform` | Adds bounded Remembrance guidance before model dispatch.        |
| `tool.execute.after`                 | Correlates query, invocation, detail, and contribution calls.   |
| `session.idle`                       | Records bounded pending contribution work for the next prompt.  |

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
Set `REMEMBRANCE_AUTO_QUERY_STRIP_INJECTED_CONTEXT=1` to search only the text
after a leading `<compartment_examples_from_other_projects>` block (off by
default).
Set `REMEMBRANCE_AUTO_QUERY=0` to disable the query, or
`REMEMBRANCE_AUTO_CONTRIBUTE=0` to disable silent completion recovery. The
idle event does not emit routine contribution text as a toast or structured log;
the next real user prompt receives only the exact bounded recovery actions.

## Host policy

A tenant or privacy-policy denial in the host happens before Remembrance is
called, so it is not a Remembrance misconfiguration — the same boundary as a
Codex tenant/privacy-policy denial, which occurs before Remembrance is reached
and must not be reported as a Remembrance setup failure. The plugin reports one
local, content-free alert: **The host blocked this Remembrance action. Do not
treat it as submitted. Earlier successful actions are unaffected; querying remains available.** It does
not retry or automatically create a handoff.

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
through OpenCode to the authenticated organization's pipeline and never falls
back to anonymous or public submission. Accepted content reuses the existing verifier,
topology, review, versioning, audit, and admin-controlled propagation pipeline;
the submitting agent never chooses visibility. After the private outcome is accepted,
a separate server-owned process may create a freshly redacted public candidate
only when the organization admin enabled **Contribution propagation**; the
submitting agent neither chooses nor sees that process, and the derivative must
pass the complete public pipeline. Unresolved and terminal drafts never expire
or auto-delete. Verified submissions discard encrypted lesson content
immediately; their content-free completion markers are automatically deleted
after 14 days.

The lesson client offers a bounded `private-lesson-redaction-v2` supported
redactor-profile set and the
server signs policy for the newest mutual profile. Retained drafts require
their exact bound profile. Temporary incompatibility remains encrypted as
`awaiting_compatible_profile` with precise update, restart, or server-rollout
guidance; it is not mislabeled as safety or host denial. A profile becomes
terminal only when the installed client no longer supports it; that state is
`superseded_redactor`. Terminal drafts stay encrypted and are never retried, re-redacted, or automatically deleted.
When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

OpenCode permission keys are `remembrance_<tool>`, and OpenCode allows tools
that no rule covers. The setup command writes no `permission` entries, so every
visible Remembrance tool, including other writes, runs without asking until you
add rules. Allow the submit and retry tools for the `private_lesson` and
`private_skill` lanes as in the Highly Recommended step, and set broader
Remembrance write tools to `ask` or `deny` when they should stay reviewable.
Remembrance maps an existing submit approval to its lane. Local capture, inspection, and confirmed deletion remain
zero-network; a fresh-draft retry stops before network access. Broad `submit_remembrance` and
`propose_private_skill` are legacy/hosted/raw compatibility routes and are
unavailable by default locally. `submit_query_feedback` remains independently
available for one complete good/partial/poor query-fit verdict set;
`submit_feedback` is categorical post-use feedback. A host denial is held and
is never retried through another transport: the denied call's own arguments
park only that draft, as a decline does. A parked draft returns as a user
decision 1, 7 and 30 days later (each wait counted from the park or the last
showing), whether or not the host allows its lane. A client update, and for a
host-denied draft the host letting that lane through again, makes the next
return come right away instead (or adds one more, if all three were shown). It
is sent only through its exact submit or retry action after the user agrees.
Drafts no active session is handling are offered as a user decision too, until
the user delivers, keeps or deletes them; a kept draft is parked. These
decisions go to the next main-session prompt on the machine, at most once a
day, including unattended runs such as `opencode run`; the drafts stay listed
by `inspect_private_learning_outbox`, and none is sent or deleted without the
user.

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
`npm run refresh:generated` from the repo root; `npm run check:generated` guards
every copy.
