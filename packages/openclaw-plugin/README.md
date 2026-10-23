# Remembrance for OpenClaw

Give [OpenClaw](https://docs.openclaw.ai) shared operational memory.
Remembrance helps your agent reuse reviewed skills, trusted resources, and
team-specific lessons before it spends tokens solving a workflow from scratch
again.

Every reuse saves your agent from re-solving a problem it — or another agent —
already worked out; every lesson it contributes back sharpens the shared
registry for the next one. Your agent gets smarter and smarter, and the network
gets smarter and smarter with it.

Install the plugin once, then OpenClaw can:

- find relevant Remembrance skills before service, API, CI/CD, migration,
  payment, deployment, MCP, or unfamiliar integration work;
- use public registry knowledge, plus private organization knowledge when you
  provide an enterprise key;
- expose Remembrance MCP tools for direct lookup, independent query-fit
  feedback, categorical post-use feedback, and private reusable-learning
  capture; and
- record unfinished feedback or capture work silently at completion, then
  inject only the exact bounded recovery actions on the next user prompt.

The hooks are quiet by default. They query prompts that look reusable, inject a
full-thread query reminder for context-only follow-ups, redact common secrets
before sending text, and fail open with recovery guidance if Remembrance is
unavailable.

## Install from ClawHub

```bash
openclaw plugins install clawhub:@remembrance/openclaw-plugin
openclaw remembrance setup
```

The setup command preserves existing OpenClaw settings, enables the required
conversation-hook permission, and registers this installed package's bundled
local MCP server by its absolute path. It does not copy your organization key
into OpenClaw config.

**Node.js runtime.** `openclaw remembrance setup` registers the bundled MCP
server under the absolute Node.js that runs OpenClaw, so the gateway's PATH does
not matter for it. A host started from the Dock, Finder or an IDE may not have
your shell's PATH, so a Node.js installed by nvm, fnm, volta, asdf, nodenv or
mise can be missing from it; the symptom is `spawn node ENOENT` or "No such file
or directory". A manual `mcp.servers.remembrance` entry therefore needs Node.js
18.17.0 or newer by its absolute path (from `command -v node` in a terminal) as
`command`, because a bare `node` is looked up on the gateway's PATH.

If you only want public registry results, the plugin can run without a key. For
private team memory, create an enterprise key in the Remembrance dashboard and
make it available to OpenClaw:

```bash
mkdir -p ~/.config/remembrance
printf '{"apiKey":"YOUR_ORG_KEY","apiUrl":"https://remembrance.dev"}\n' > ~/.config/remembrance/config.json
chmod 600 ~/.config/remembrance/config.json
```

In a centrally managed environment, the setup command's equivalent
conversation-access setting in `~/.openclaw/openclaw.json` is:

```json5
{
  plugins: {
    entries: {
      remembrance: {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {},
      },
    },
  },
}
```

Restart OpenClaw after setup or key changes, then verify both surfaces:

```bash
openclaw plugins inspect remembrance --runtime --json
openclaw mcp doctor remembrance --probe
```

Then run Remembrance MCP `run_connection_doctor` and require
`safe_to_query: true`. It verifies the active connection and gives one exact
next step without exposing the key. Use `get_connection_status` only for lower-
level fields. Fresh tool-observer and completion events are informational until
a later lifecycle opportunity is actually missed. Do not conclude that OpenClaw is
anonymous from an unset `REMEMBRANCE_API_KEY` or an anonymous curl/browser
probe; those do not test the bundled plugin process.

When the plugin runtime starts, it performs a bounded, credential-free release
check. If a newer verified version exists, the agent asks before running
`openclaw plugins update remembrance` and `openclaw remembrance setup`, then
tells the user to restart the Gateway unless the managed reload already did so
and to begin a new session. Remembrance never updates silently. OpenClaw is
advertised only after that exact version is publicly installable from ClawHub;
pending publication is reconciled automatically by Remembrance. Set
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` to disable the advisory check.

OpenClaw installations from before this startup check existed still learn about
a verified update on their next successful Remembrance query. The API places a
command-free notice first in the legacy contribution directive; only this
installed plugin supplies the trusted local update commands.

### Highly Recommended: approve private submissions

For organizations that use Remembrance with a private organization key, this
step is required for Remembrance to do its job fully. Without it, every private
lesson or skill submission stops for a manual approval, and unattended or
headless runs deny it. Public-only use, without an organization key, does not
need it.

An agent asks you (for managed settings, your administrator) before applying
this step: it never edits host permission or settings files without your
consent, and never answers the host's approval prompt for its own pending
action.

In native runs OpenClaw documents no prompt of its own for MCP tools; this
plugin asks before each private submission. To persist approval, answer
**allow-always** once for each lane when it asks to "Submit private Remembrance
lesson" or "Submit private Remembrance skill", for example with
`/approve <id> allow-always` in chat or
`openclaw approvals resolve <id> allow-always`. One decision covers that lane's
submit and retry actions (`submit_private_lesson_candidate` with
`retry_private_lesson_candidate`, and `submit_private_skill_candidate` with
`retry_private_skill_candidate`), and the plugin saves it in its config.

To pre-set both lanes instead, Remembrance for OpenClaw 0.2.3 or later accepts
this in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "remembrance": {
        "config": {
          "privateLearningEgressApprovals": {
            "private_lesson": true,
            "private_skill": true
          }
        }
      }
    }
  }
}
```

Check the installed version first, for example with
`openclaw plugins inspect remembrance`. Earlier versions reject the key: the
Gateway then refuses to start until it is removed, and those versions cannot
keep an allow-always decision across a restart either. On older or
mixed-version installs, use allow-always. Never approve the confirmed-delete
tools. Check the step by behavior: capture one disposable private lesson and
confirm that its submission completes without a prompt. `run_connection_doctor`
cannot see a persisted approval.

### Private repository contributions

After the organization approves Remembrance as a destination, a current local
client uses `capture_learning.private_skill` followed by the exact
`submit_private_skill_candidate` action for repository-derived instructions.
It requires the organization key and can only create a private review
candidate. Broad `propose_private_skill` and `submit_remembrance` routes are
legacy/hosted/raw compatibility tools and are unavailable by default locally.
OpenClaw's
conversation access setting lets the plugin's completion hook run (the prompt
and tool hooks run without it; see [Conversation access](#conversation-access));
it does not override a gateway, sandbox, or enterprise egress denial. Never retry denied
private content through a different network transport. On a classified denial,
the plugin reports one local, content-free alert: **The host blocked this
Remembrance action. Do not treat it as submitted. Earlier successful actions
are unaffected; querying remains available.**

For a managed Gateway, add `remembrance` to `plugins.allow`, keep it out of
`plugins.deny`, enable `plugins.entries.remembrance`, and retain
`hooks.allowConversationAccess: true`. Use a normal `coding` or `messaging`
tool profile: `minimal` hides MCP tools, while
`tools.deny: ["bundle-mcp"]` disables them. Filter the saved
`mcp.servers.remembrance` entry with `toolFilter.include` using the bounded
organization tool list in
`skills/remembrancer/references/remembrance-setup.md` or the live guide at
<https://remembrance.dev/docs/remembrancer#private-repository-policy>, then
verify both the live plugin and MCP connection:

```bash
openclaw plugins inspect remembrance --runtime --json
openclaw mcp status --verbose
openclaw mcp doctor remembrance --probe
```

The standalone OpenClaw policy file can require the `remembrance` server as a
conformance check, but runtime availability still depends on plugin enablement,
the active tool profile, `tools.deny`, and `toolFilter`. With an organization
key, generic `propose_skill_idea` stays in the private review queue. Never
remove or bypass the key to force a public candidate; use reviewed public
propagation after private review.

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

The plugin does not automatically create a handoff. Only when an organization
admin explicitly requests one, the bundled local MCP server exposes
`queue_private_skill_import`. It contacts no network and writes a mode-0600 JSON
handoff under the user's fixed Remembrance state directory. The admin can upload
the file at **Dashboard > Skills > Import**, where each skill enters the normal
private verification queue. If only the skill bundle is available, run
`skills/remembrancer/scripts/queue-private-skill-import.mjs` instead. The agent
must not report a successful submission until the dashboard returns an import
receipt.

If `openclaw plugins search remembrance` returns unrelated packages, such as a
genealogy/roots package, do not install them. The official package is
`clawhub:@remembrance/openclaw-plugin`, points to
`https://github.com/dreamarkinc/remembrance-skills`, and describes the
Remembrance agent skill/resource service.

To pin a specific published version, see the version selector on the plugin's
ClawHub release page. The normal install path should use the latest official
`clawhub:@remembrance/openclaw-plugin` package unless a rollout explicitly
requires a pinned version.

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

## What it does

Remembrance uses a prompt hook, a completion hook, an approval hook
(`before_tool_call`), one tool observation hook, the canonical inbound
`reply_dispatch` observer for exact private-skill context selection and, for
subagents, OpenClaw's `subagent_ended` hook:

- **Before a prompt:** the plugin checks whether the work looks like something
  that could benefit from reusable guidance. If it finds matching skills or
  resources, it injects a compact context block before OpenClaw reasons. A short
  follow-up such as "fix these issues" instead receives an instruction to infer
  the concrete task from the full conversation and query directly.
- **Before final answer:** if the session used Remembrance or a reusable task
  missed its query, the plugin records bounded pending obligations silently and
  allows the answer. The next real prompt receives only the exact query,
  feedback, or `capture_learning` recovery actions.
- **When a subagent finishes:** OpenClaw gives a subagent (`sessions_spawn`)
  its own session, which can get later runs, for example when another
  session sends it a message with `sessions_send`. The plugin does not ask
  the subagent to settle what it owes: OpenClaw discards a finalize revision
  once a run has called a tool with possible side effects, and every
  Remembrance tool counts as one. Instead, what it owes moves to the session
  that started it, marked second-hand, when the subagent finalizes, when
  OpenClaw's announce of its result starts a new run in that session (before
  a later run of the subagent starts), or at the latest when OpenClaw
  reports that the subagent's run ended
  (`subagent_ended`), also after an error, a timeout or an abort while that
  session was still running; that session's next prompt offers it. No other
  session sees it. A thread-bound subagent (`mode: "session"`)
  gets later prompts of its own and keeps its debts for them; in visible
  recovery mode its finalize asks it to settle them, as for any session.
- **After a detail tool:** a successful correlated `get_skill` or `get_resource`
  clears that high-match reminder. A successful `invoke_skill` records the
  explicit selection, marks its outcome selected, and starts one post-use
  feedback prompt. Catalog browsing and resource-handle reads do not count.

This creates the loop you want from an agent memory system: use reviewed
knowledge when it exists, and improve the registry when the agent learns
something worth reusing. Every agent that contributes raises the floor for the
next agent that queries — the more the network is used, the smarter it gets.

## Conversation access

This is a **non-bundled plugin**. OpenClaw runs a non-bundled plugin's raw
conversation hooks only after the operator's grant,
`plugins.entries.remembrance.hooks.allowConversationAccess: true`, which
`openclaw remembrance setup` writes. Of this plugin's hooks, only
`before_agent_finalize`, which inspects the final answer, is such a hook.

Before the grant, OpenClaw (2026.7.1-2, the version this plugin is built and
verified against) holds
only `before_agent_finalize`. It loads and runs the plugin's other four hooks,
and three of them receive conversation content: `before_prompt_build` the
prompt (`prompt` and `messages`), `before_tool_call` each tool call, and
`after_tool_call` each tool call's arguments and result. Before the grant,
these hooks do the following:

- `before_prompt_build` reads the prompt, updates the session's local
  Remembrance ledger (task eligibility, query feedback, directives) and adds
  context: matching skills and resources, the recovery actions the session
  owes and, when a newer verified version exists, a client-update notice.
  With auto-query on (the default), a
  prompt that looks reusable is searched. Its redacted text (common secrets
  and private-network URLs removed, at most 1,200 characters) goes as the
  task summary to `POST /api/v1/agent/query` on the configured API
  (`REMEMBRANCE_API_URL` or the shared config's `apiUrl`, default
  `https://remembrance.dev`). The request carries the organization key and
  the project key only when an organization key is configured; without one,
  it carries no key, only the principal session of the plugin's local agent
  key when it has one. The hook can also send a content-free "shown" record
  for a contextual follow-up (`/api/v1/agent/directive-events`). Only with an
  organization key, it reads the organization's effective preferences for
  the prompt's inferred domain when a search-hygiene rule stops a search
  (`/api/v1/agent/preferences/effective`), and it records a built-in
  preference that the prompt states, as the setting, a SHA-256 hash of the
  redacted prompt and an evidence hash, not the prompt text
  (`/api/v1/agent/preferences`). `REMEMBRANCE_AUTO_QUERY=0` stops all of
  these requests. With an organization key, while retained private-skill
  drafts await their original request, it also stores each prompt (or its
  redacted form), encrypted, in every such local draft, from any OpenClaw
  session of this user on the machine and never the same prompt twice;
  `REMEMBRANCE_AUTO_CONTRIBUTE=0` turns this off, and a draft leaves the
  machine only through the approval-held submit or retry tool.
- `before_tool_call` reads each tool call and holds Remembrance's
  content-submission tools (private lesson and skill submit or retry, broad
  submissions and proposals, suggestions, resources, reviews, and feedback
  that carries a lesson) for the operator's approval, unless an earlier
  allow-always decision covers that tool's lane. It sends nothing.
- `after_tool_call` reads each finished tool call's name, arguments and
  result. It updates local state: the session's ledger, host-policy denial
  records, in memory the session that spawned a subagent and, for a private
  skill capture, its local draft. After a
  Remembrance `query_skills` call that follows a contextual follow-up's
  directive, it sends the content-free "followed" record (directive id and
  query id) to `/api/v1/agent/directive-events`. It sends nothing else.
- `subagent_ended` moves an ended subagent's debts between local ledger
  files. It reads no conversation content and makes no request.

When OpenClaw loads the plugin, also before the grant, the plugin writes a
local lifecycle marker and makes two kinds of request without conversation
content: the credential-free release check
(`/.well-known/remembrance-client-release.json`;
`REMEMBRANCE_CLIENT_UPDATE_CHECK=0` turns it off), and the registration of
the plugin's local agent key for a principal session
(`/api/v1/agent/keys/register` and `/api/v1/agent/principal-sessions`, with
the organization key when one is configured). The prompt hook repeats that
registration and exchange when no principal session is cached or the API asks
for a refresh; `REMEMBRANCE_AUTO_QUERY=0` stops that too. Before the grant,
prompt text therefore leaves the machine only in the redacted query above; the
other requests carry identifiers, a hash of the redacted prompt, a built-in
setting, an inferred domain label or nothing from the conversation, and no
tool argument or result content leaves the machine, only the Remembrance query
id. `REMEMBRANCE_AUTO_QUERY=0` keeps the prompt off the network, but not out of
the local draft capture above; `REMEMBRANCE_AUTO_CONTRIBUTE=0` turns that off.

The grant adds two things. First, OpenClaw runs `before_agent_finalize`: it
records what the session owes at completion (in visible recovery mode, it asks
the agent once to settle it), reports content-free task outcomes for the
skills the session used (`/api/v1/agent/task-outcomes`) and hands a
finishing subagent's debts to the session that started it. Second,
`openclaw remembrance setup`, which writes the grant, also registers the
bundled MCP server, so the agent gets the explicit Remembrance tools. Without
the grant, the run is not broken: OpenClaw names the held hook only in a
`warn` diagnostic of `openclaw plugins inspect remembrance --runtime`, and
`openclaw plugins doctor` reports no issue.

> "Non-bundled plugins that need raw conversation hooks (`before_model_resolve`,
> `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
> `agent_end`, or `before_agent_run`) must set … `allowConversationAccess`."
> — [Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
> [Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference).

## MCP tools

The plugin ships a self-contained Remembrance MCP server
(`servers/remembrance-mcp.mjs`). The hooks provide automatic behavior; the MCP
server gives OpenClaw direct tools such as `run_connection_doctor`,
`get_connection_status`, `query_skills`, `bootstrap_agent_identity`, independent
`submit_query_feedback`, categorical `submit_feedback`, `capture_learning`,
`submit_private_lesson_candidate`, `submit_private_skill_candidate`,
`inspect_private_learning_outbox`, `get_skill`, `get_resource`,
`report_task_outcome`, `get_value_proof`, `list_skills`, and `invoke_skill`.
Broad `submit_remembrance` and `propose_private_skill` tools are unavailable by
default to organization-capable local clients; hosted/raw and older clients may
retain those explicit compatibility routes. Local MCP also includes
`queue_private_skill_import`, which never contacts Remembrance.

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
through OpenClaw to the organization's pipeline and never fall back to
anonymous or public submission. Accepted content reuses the existing verifier, topology, review,
versioning, audit, and admin-controlled propagation pipeline; the submitting
agent never chooses visibility. After the private outcome is accepted, a separate server-owned
process may create a freshly redacted public candidate only when the
organization admin enabled **Contribution propagation**; the submitting agent
neither chooses nor sees that process, and the derivative must pass the
complete public pipeline. Unresolved and terminal drafts never expire or
auto-delete; retryable failures resume later and held drafts remain local.
Verified submissions discard encrypted lesson content immediately; their
content-free completion markers are automatically deleted after 14 days.

The lesson client offers a bounded `private-lesson-redaction-v2` supported
redactor-profile set and the
server signs policy for the newest mutual profile. Retained drafts require
their exact bound profile. Temporary incompatibility remains encrypted as
`awaiting_compatible_profile` with precise update, restart, or server-rollout
guidance; it is not mislabeled as a safety rejection or host denial. A profile
becomes terminal only when the installed client no longer supports it; that
state is `superseded_redactor`. Terminal drafts stay encrypted and are never retried, re-redacted, or
automatically deleted. When health reporting is enabled, a held draft may send
only content-free category/version counts and signed protocol digests through
the same approved action; that telemetry cannot enter verification, review,
topology, or skill materialization. Disable it with
`REMEMBRANCE_HEALTH_REPORTING=0`.

The `coding` and `messaging` tool profiles already expose the MCP tools through
`bundle-mcp`, so the submit and retry tools need no `tools.allow` or
`tools.alsoAllow` entry (OpenClaw rejects setting both in one scope); a
sandboxed session needs `bundle-mcp` in `tools.sandbox.tools.alsoAllow`. Then
use the plugin approval flow from the Highly Recommended step above. Choosing
`allow-always` persists one semantic lane decision: lesson submit/retry share
one decision, and skill submit/retry share another. Existing exact-submit
approvals upgrade lazily. It does not trust other Remembrance or host tools.
Capture, inspection, and confirmed deletion remain zero-network; a fresh-draft
retry stops before network access. `submit_query_feedback` remains an
independent bounded query-fit action. A host denial is never retried through
another transport: the denied call's own params park only that draft, as a
decline does. A parked draft returns as a user decision 1, 7 and 30 days later
(each wait counted from the park or the last showing), whether or not the host
allows its lane. A client update, and for a host-denied draft the host letting
that lane through again, makes the next return come right away instead (or
adds one more, if all three were shown). It is sent only through its exact
submit or retry action after the user agrees. Drafts no active session is
handling are offered as a user decision too, until the user delivers, keeps or
deletes them; a kept draft is parked. These decisions go to the next
main-session prompt on the machine, at most once a day, unless the run sets
`REMEMBRANCE_UNATTENDED=1`; set it for unattended runs, which then neither show
nor use up a decision. The drafts stay listed by
`inspect_private_learning_outbox`, and none is sent or deleted without the
user.

### Explicit private-skill recovery context

When inspection reports that an eligible retained private skill needs more
meaning, select that exact draft in an authorized direct Telegram text message:

```text
/remembrance-context psd_0123456789abcdef
Literal context for this draft goes here.
```

Use the actual draft ID returned by inspection. The command must start the
message; the context starts on the next line and must be nonempty. The complete
message is limited to 64 KiB of UTF-8. OpenClaw's canonical inbound text is
inspected locally before safe partial context and its draft relation are retained
in the encrypted outbox. Existing conversation-access permission and the host's
sender authorization are required. This source is currently qualified only for
direct Telegram text; other channels and ordinary prompts preserve the hold.

Retained safe context works across sessions and client restarts. Existing
processing consent and private-skill submission approval still apply. A new
message or session never resets spent reformulation attempts. The original
capture, unrelated drafts, and already spent context remain unchanged.

Withdraw the new context authority with this exact body, using the actual ID:

```text
/remembrance-context-revoke psd_0123456789abcdef
```

Withdrawal uses the same authorized source and conversation-access permission.
It remains available with contribution automation disabled or organization
credentials unavailable. It revokes the protected relation while preserving the
encrypted draft. A fresh selection can regrant an equal safe context without
restoring spent attempts; replaying the old selection cannot regrant it. Capacity
holds preserve the draft and require the bounded recovery instructions returned
by inspection.

When a person explicitly names a Remembrance skill or supplies a
`remembrance://skills/{slug}` URI, OpenClaw resolves ambiguous names with
the indexed, normalized slug-prefix filter in `list_skills`, then calls
`invoke_skill` with an exact returned slug. It uses `query_skills` for
discovery, but never merely to rediscover that explicit selection. Invocation
rechecks current policy and loads the active reviewed version; direct
selections use post-use feedback and never query-fit feedback.

For query fit, OpenClaw should send one complete verdict set of good/partial/poor labels
per query from the same organization scope or anonymous scope. Any active key
for that organization is valid. Identical retries are safe; changed later
judgments conflict, so uncertain results stay unrated instead of being appended
later. Post-use quality belongs categorically on `submit_feedback`; reusable
prose belongs in a separate `capture_learning` call.
Query results also carry a high/possible/exploratory tier, concise reason,
bounded `why_matched` terms/capabilities/constraint evidence, conservative
`applicability` scope and use/exclusion conditions, metadata digests,
approximate context tokens, verified-use evidence, risk, and correlation IDs.
OpenClaw should rule out an unlikely or irrelevant corner-case result and
report query fit `poor`, then open a remaining high match with `get_skill`/`get_resource` and its
`query_id`/`result_id`
before custom work; lower tiers remain optional. Pass those IDs to categorical
`submit_feedback` after use and to delegated agents. At completion, the hook
records an unopened high match silently so the next user prompt can ask
OpenClaw to fetch it or report explicit poor-fit feedback.
Anonymous verdicts remain low weight and never train a shared model. No learned
reranker is trained or served; changing `agent_id` does not create another
feedback actor.
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

An exact, current, non-high-risk match may include one compact token-only
`potential_savings` estimate when fresh grade A/B proof exists for the observed
model revision, reasoning effort, and bounded task cohort. `get_value_proof`
cryptographically verifies its signed receipt, including the task domain,
stage, complexity, and bounded scope counts. OpenClaw reports a bounded
completion outcome through its lifecycle
hook when host data permits; raw MCP callers can use `report_task_outcome` with
only IDs from `task_outcome.eligible_result_ids`. Every result and bundle also
carries `task_outcome_eligible`.
Neither path sends prompts, transcripts, outputs, source paths, or private URLs,
and collection mode exposes no money or payment fields. Private-skill receipts
require an active query-capable API key from the same organization; it need not
be the key used for the original query. They remain workspace-only and never
enter public cohorts. Successful proof retrieval returns
`signature_verified: true` plus `verification_key_id`. For Vercel AI Gateway
work, pass every task generation ID in `metering_reference`; Remembrance
encrypts the references and trusts token totals only after every generation is
independently reconciled and single-claimed.

OpenClaw configures MCP servers under **`mcp.servers.<id>`** (not `mcpServers`
like Claude, nor `mcp_servers` like Codex) in `~/.openclaw/openclaw.json`
([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference),
[MCP CLI](https://docs.openclaw.ai/cli/mcp)). `openclaw.mcp.json` in this package
is an **illustrative** merge fragment. OpenClaw only expands real uppercase
`${VAR}` values and does **not** define an `${OPENCLAW_PLUGIN_ROOT}` variable, so
the `args` path must be an **absolute path** — replace
`/abs/path/to/openclaw-plugin` with the real absolute path to this package, and
`/abs/path/to/node` with the output of `command -v node` in a terminal, before
merging into `~/.openclaw/openclaw.json`. Normal installs should run
`openclaw remembrance setup` instead:

```json5
{
  mcp: {
    servers: {
      remembrance: {
        // Absolute Node.js path: run `command -v node` in a terminal. The
        // gateway may not start with your shell's PATH.
        command: "/abs/path/to/node",
        // Absolute path — OpenClaw does not expand a plugin-root variable here.
        args: ["/abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs"],
        env: {
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_API_KEY: "YOUR_ORG_KEY",
        },
      },
    },
  },
}
```

Or add it via the CLI (`--command` for the executable, one `--arg` per argument;
`--env` / `--cwd` are optional):

```bash
openclaw mcp add remembrance \
  --command "$(command -v node)" \
  --arg /abs/path/to/openclaw-plugin/servers/remembrance-mcp.mjs
```

If MCP tools are unavailable, the plugin hooks can still run. For raw REST usage,
use `https://remembrance.dev/llms.txt` or the API docs at
`https://remembrance.dev/docs/api`.

## Maintainers: publish to ClawHub

Everything above is for installing and using the plugin. This section is for
maintainers publishing a new ClawHub release.

Code plugins publish through the ClawHub CLI with the `code-plugin` family
([ClawHub quickstart](https://github.com/openclaw/clawhub/blob/main/docs/quickstart.md)):

```bash
clawhub login              # or: clawhub login --token clh_...
clawhub package publish . --family code-plugin --dry-run   # preview metadata
clawhub package publish . --family code-plugin             # publish
```

Code plugins must carry OpenClaw compatibility metadata in `package.json`
(`openclaw.compat.pluginApi` and `openclaw.build.openclawVersion`) — present in
this package's `package.json`.

If the ClawHub web flow asks for a `plugins/` folder instead of a package
directory, generate the upload shape from the repo root:

```bash
npm run prepare:openclaw-clawhub
```

Upload:

```text
dist/openclaw-clawhub/plugins
```

That folder contains:

```text
plugins/remembrance
```

The generated package strips repo-only fields such as `private`, `scripts`, and
`devDependencies`, keeps the manifest and package versions synced, and points
the package metadata at `https://github.com/dreamarkinc/remembrance-skills`.
Regenerate it for every ClawHub update; never hand-edit the dist folder.

Production CI publishes future versions automatically when `CLAWHUB_TOKEN` is
configured in CircleCI:

```bash
npm run publish:openclaw-clawhub
```

The publish script validates and packs the generated package, resolves the
already-published `master` commit from
`dreamarkinc/remembrance-skills`, verifies that
`packages/openclaw-plugin/package.json` at that commit has the exact release
version, and attaches that public commit as source provenance. It dry-runs the
ClawHub publish, waits through staged security checks until the exact version
is publicly inspectable, and skips cleanly when the package version already
exists. The release-channel status marker separately retains the originating
CircleCI build SHA so the final fan-in gate cannot reuse another deployment's
success.

From 0.2.0 the hook core (`src/hook-core.mjs`) seals a pending follow-up
payload with the private-learning key. On macOS it reads, or creates, that key
in the login Keychain by running `/usr/bin/security` (absolute path, no shell)
inside the OpenClaw process; `REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN=0` makes it
use the mode-0600 key file instead. How ClawHub's staged security checks treat
that process execution has not been verified: read the scan result of the
first release that ships it before announcing that release.

## Behavior

The pre-prompt hook runs before every model turn but only calls Remembrance when
the prompt mentions named services, APIs, CLIs, frameworks,
deployment/CI/payment/migration workflows, MCP/resource selection, or unfamiliar
third-party integrations. It also recognizes common context-only continuation
phrases. On a hit or continuation it returns
`{ appendSystemContext: "..." }` so OpenClaw injects matching results or a query
reminder into system context. It is enabled by default; set
`REMEMBRANCE_AUTO_QUERY=0` to disable network auto-query. The v0.1 heuristic is
English-first, so multilingual workflows should call `query_skills` explicitly
when useful.

The completion hook is a silent recovery checkpoint. When the session used
Remembrance or a reusable prompt was eligible but no query completed, it records
bounded pending obligations and finalizes the current answer. On the next real
user prompt, the prompt hook injects only the exact outstanding query,
unopened-match, `submit_query_feedback`, categorical `submit_feedback`, or
`capture_learning` actions. Routine hook narration, tool receipts, and
correlation IDs do not obscure the final response; only a failure, host-policy
block, or required user action is surfaced. Set
`REMEMBRANCE_AUTO_CONTRIBUTE=0` only when automatic contribution closure is not
wanted.

### How usage is detected

The Claude plugin decides whether to prompt for a contribution by scanning the
session transcript for registry-consumption markers. OpenClaw's
`before_agent_finalize` event does not carry a transcript, so this plugin reuses
the Codex plugin's marker mechanism (`src/hook-core.mjs`, generated from the
shared core with OpenClaw-specific security hardening). OpenClaw starts a new
run for every turn, so these counters and pending actions belong to the
OpenClaw session (`ctx.sessionId`, else `ctx.sessionKey`), as Codex keeps them
per session; lifecycle markers, directives and value episodes belong to the
run (`ctx.runId`):

- The pre-prompt hook calls `recordRegistryUse(sessionId)` whenever a registry
  query completes, incrementing a per-session counter file under
  `os.tmpdir()/remembrance-usage/<hash>.use` (`REMEMBRANCE_USAGE_DIR` overrides
  the directory).
- The `after_tool_call` hook clears `<hash>.high-match.json` only when the
  completed detail call matches the stored slug, `query_id`, and `result_id`.
- Contextual continuation reminders persist an opaque `<hash>.directive.json`
  marker and a fail-open shown event. The next successful `query_skills` call
  reports it followed, then consumes the marker so a later query cannot claim
  the earlier instruction. No prompt text is stored and the telemetry never
  affects ranking.
- Relevant and contextual prompts call `recordTaskEligibility(sessionId)`,
  incrementing a `<hash>.eligible` counter even when the query is missed or
  unavailable. Later tasks in the same session therefore remain recoverable.
- The completion hook reads that count via `readRegistryUseCount(sessionId)`,
  combines it with eligibility, records any still-pending obligations, and
  finalizes. The next real prompt consumes the bounded recovery state.
- A subagent session (key `agent:<id>:subagent:<uuid>`) keeps its debts in
  its own session's ledger. Its `before_agent_finalize` is decided by the
  same `decideStop` as any session, read before its debts move, with one
  difference: unless it is thread-bound, it is never asked about its debts,
  in silent or visible mode. In visible mode it is still asked, as on master,
  for a contribution, a high-value lesson or an unclosed eligible task.
  Where `decideStop` asks about its debts, the hand-up takes that ask's
  place, and the plugin still records master's accounting of that ask: the
  prompted count it records (`writePromptedCount`). The moved copies reach
  the session that started the subagent unprompted all the same, because
  `transferSubagentObligations` resets their `prompted_at`. A later run of
  the same subagent session (OpenClaw's `sessions_send`, a wake run, or the
  honored revise of a host-policy alert) is then decided as on master, with
  one exception in visible mode. When a finalize revised for a host-policy
  alert while the subagent owed something, those debts went up at that
  finalize, so the next pass that uses the registry without leaving a new
  debt (the honored revise, or a later run if OpenClaw dropped that revise)
  gets master's contribution ask where master gave its debt ask. That pass
  revises on both, with the same prompted count.
  The spawning session's `after_tool_call`
  for an accepted `sessions_spawn` result records, in the plugin's memory (at
  most 512 subagents), which session started the subagent. Each finalize of
  the subagent, whatever it decides, then moves the subagent's debts to that
  session's ledger, marked second-hand (`transferSubagentObligations`, as
  Codex does at `SubagentStop`). A thread-bound subagent (`mode: "session"`
  in that spawn result) keeps them, and its finalize is decided like any
  session's: no ask in silent mode, the usual single ask in visible mode.
- A subagent that finalizes before its spawn result is seen hands its debts up
  when the result arrives. OpenClaw's announce of the subagent's result moves
  them too when it starts a new run in the session that started the
  subagent, whose prompt begins with OpenClaw's `[Inter-session message]`
  line naming the subagent's key and `sourceTool=subagent_announce`. While
  that session still has a run in progress, OpenClaw instead steers the
  announce into that run: that is not a new run, and no prompt hook sees it.
  The announce follows the subagent's run however it ended, also after a
  model error, a timeout or an abort, when OpenClaw calls no
  `before_agent_finalize`; the subagent's own prompt hook recorded its
  ledger. The debts go to the session the spawn result named, else to the
  session that receives the announce, which the announce names also when it
  moves nothing; a later announce never redirects them. The announce names no
  run, so once the plugin has seen a later run of the subagent start, an
  announce moves nothing: the run that is going keeps the debts, and a run's
  finalize or end moves them up. What a later run that ends without
  `before_agent_finalize` leaves therefore reaches the session above with
  OpenClaw's report of that run's end, which comes after the announce, and
  may be asked for in that session's next run rather than in its announce
  run. After a Gateway restart the plugin knows no earlier run and has no
  spawn result: an announce moves the debts as before until the plugin has
  seen two runs of the subagent start, and after that the latest run's end
  hands them up to the session that announce named.
- OpenClaw's `subagent_ended` follows each ended run of a subagent (of a
  thread-bound one only when it was killed), once per run (not for a run
  OpenClaw replaced with a newer one, as at a steer restart: what it left
  goes up with the newer run), after the announce: outcome `ok`, `error`,
  `timeout` or `killed`. It names the
  subagent's key (`ctx.childSessionKey`) and the session OpenClaw reports to
  (`ctx.requesterSessionKey`). For a subagent this plugin saw, it moves the
  debts to the session that started it, also for a run steered into a
  running parent, as at a finalize: a full parent ledger turns a moved debt
  into an overflow count (while that count cannot be written, the debt stays
  with the subagent, where the parent's association reaches it, and a later
  end counts it), but a debt whose exact arguments are sealed moves
  whole only when the parent can take an equal copy and no other ledger
  points to it yet; otherwise it stays where it is kept, and the parent's
  ledger gets a content-free pointer to it, however many there are: the
  parent's reminder names it, second-hand, and never counts it. So does a
  debt the subagent itself got from its own subagent (only possible when
  OpenClaw's `maxSpawnDepth` is above 1), also when the subagent's ledger
  holds nothing but such pointers. When that nested subagent's end comes, or
  comes again, after the end of the subagent that started it, its debts
  still go to the session of the subagent that started it: that session's
  next run (OpenClaw's announce of the nested result, or a later run) is
  asked for them and settles them, and its next end hands up what is left.
  Until that session runs again, the session above it reaches them: a
  subagent's ledgers each leave a content-free forwarding marker when they
  hand up, also when they hold nothing, and the ledger those markers lead to
  (following at most 8) gets a content-free association to that session's
  ledger; the session's next prompt turns its marker into a released one
  (content-free: it says only that the session runs again). One session at a
  time is asked for a kept debt, with the exceptions below. The pointers and
  associations this plugin's hand-ups write say so in one more content-free
  field (`"forwarded": true`), and a read that decides who is asked (a
  prompt's or a finalize's) follows one only when no session that runs again
  owns what it names: the keeping session itself, or the first session whose
  marker is released on the way the keeper's markers lead (looked for through
  at most 8 markers, two per level of nesting; each marker read counts among
  the 256 entries a read examines). Otherwise the read removes the entry (the
  keeping session asks), or moves it unchanged to the owning session (written
  there first; while that write fails, it stays and is not followed): a
  session that runs again is asked for debts kept below it once the session
  above has read. Every other read (one that records a debt or looks one up,
  or ends a tool call) moves nothing, so a run keeps the entry it was asked
  through until its next prompt or finalize, and a completion or a decline
  settles through every entry its session holds, owned or not, and names
  nothing: a debt is settled once, where it is kept. The exceptions: a run
  already asked stays asked until it ends, so when the session that keeps the
  debt, or a session between the two, runs again meanwhile, its prompt asks
  it too, and both may complete it. The debt is settled once, where it is
  kept, and the other completion settles nothing locally, but its call still
  reaches Remembrance: a second identical `record_preference` from the same
  OpenClaw installation, or a second identical `submit_remembrance`, is
  replayed rather than recorded again, except that a remembrance submitted
  with `verified_attestation: true` is recorded and verified a second time,
  and a second `submit_feedback` gives that session a remembrance follow-up
  of its own whenever the service returns a next step. A second
  `submit_query_feedback` for the same query is replayed when its judgments
  are the same (a replayed `overall_fit: "none"` still counts the
  missing-skill demand again) and refused when they differ (the first
  judgment stands). A decline in one session does not withdraw a reminder the
  other already holds, and that session may still complete the debt (its call
  reaches Remembrance; locally it settles nothing). An end that names no run,
  or a run the plugin does not remember (below), hands over at once, also
  while a later run of the subagent goes, and so does the first announce
  after a Gateway restart while a later run goes: the session above and that
  run are then both asked until that run ends. When the session that runs
  again lies more than 8 markers above the one that keeps the debt (only with
  OpenClaw's `maxSpawnDepth` at its maximum of 5), the session above it can
  be asked as well. A released marker lost to a reboot or a
  temporary-directory cleanup, or one a session that runs again cannot write
  (its forwarding marker then goes all the same), lets the session above be
  asked too, until that session's next end. OpenClaw may report a run's end
  after the next run of the same subagent started: that end hands nothing
  over, and the latest run's end hands up. For that the plugin remembers, in
  memory, the ids of a subagent's last four runs (one id however often
  OpenClaw builds a run's prompt, recorded before the prompt hook awaits
  anything), and relies on OpenClaw naming the ended run (`runId` in the
  event and its context; OpenClaw 2026.7.1-2 names it); an end that names no
  run (a session reset or delete), or a run the plugin never saw or no longer
  remembers, hands over at once. OpenClaw 2026.7.1-2 reports the end of each
  run its subagent registry tracks, also after an error, a timeout or an
  abort: a spawned run, and a later run of the subagent's session that the
  Gateway's `agent` method (which `sessions_send` and a wake use) or its
  `sessions.send` method starts once the registry has recorded the previous
  run's end (a yield is not reported as an end). When a later run is one the
  registry does not track (one that the Gateway's `chat.send` method starts
  directly, as the Control UI's chat, the TUI, an ACP client or Talk do; one
  that starts before the registry has recorded the previous run's end; or one
  of a session the registry holds no run for) and it also ends without
  `before_agent_finalize` (OpenClaw skips it, for example, when a run errors,
  times out or is aborted, ends without visible assistant text, with the
  expected silent reply or on a yield, or completes a client tool call), the
  plugin sees no end of it: that session's marker stays released, and what it
  owns, kept debts it handed up before included, waits in its ledger, named
  to nobody until it runs again, or until a reset or delete that OpenClaw
  reports through `subagent_ended` (OpenClaw's own deletion of a subagent
  spawned with `cleanup: "delete"` reports none, so what it left stays named
  to nobody).
  A debt that moves whole is named after the subagent that ended; one that
  stays kept keeps the name of the first subagent it came from. One end hands
  over one page (the subagent's own debts and at most 64 it points to), and
  the parent's ledger first gets one content-free association to the
  subagent's ledger, removed again once that page handed everything over:
  whatever the page leaves stays reachable through it. A reminder names at
  most 12 actions and reads at most 64 pointed or associated debts at a time;
  later ones are named as earlier ones are completed or declined.
  Where no pointer directory accepts the association or the pointer, the
  debt stays with the subagent, neither named nor counted, until a later end
  of that subagent writes them; a pointer or association written to the
  temporary usage directory, while the durable directory under
  $XDG_STATE_HOME is refused, moves there on the first read after it is
  usable, and a reboot or temporary-directory cleanup before then leaves the
  debt unnamed until a later end writes it again, which may never come, as
  does a pointer whose mode, owner or bytes change. The same cleanup removes
  the records kept in the temporary usage directory: debts without a payload,
  and a sealed record whose durable write failed, with its payload. The first
  read that finds such a sealed record there while the durable directory is
  usable moves it to the durable directory, whether that is the keeping
  session's own read or the read of a session asked for it; a cleanup before
  that read takes it. When that cleanup removes a forwarding marker
  before a nested subagent's late end, or a nested subagent's hand-up stops
  mid-way (the Gateway killed) after its debts reached the session of the
  subagent that started it and before the association was written, those
  debts wait in that session, named at its next run and handed up at its
  next end. Such a debt
  still counts as a user of the local private-learning key, so no new key is
  made while it waits.
  When it fires before the spawn result, the spawn
  result moves them, to the session it came from. It moves nothing
  for a thread-bound subagent, and nothing when the spawn result came before
  the end and OpenClaw names another requester than the session it came from
  (it logs one line without keys or content instead); the debts then stay
  with the subagent. A repeated event changes nothing an earlier one handed
  over; it hands over only what that one could not. A later run of the
  subagent's session hands up what that run left, also when OpenClaw gave
  the session key a new session id first (its daily or idle reset): the
  plugin follows the ledger of the subagent's latest prompt, and when a
  prompt brings a new ledger, what the previous one still holds goes up
  first. OpenClaw does not
  hold this hook before the conversation-access grant (it is not a
  conversation hook): it reads and writes only local Remembrance ledger files
  (the usage directory and the private-learning hint directory under
  $XDG_STATE_HOME/remembrance), reads no conversation content and makes no
  request.
- Debts that reach none of these paths stay in the subagent's own ledger,
  and nothing hands them up later: the plugin remembers subagents in memory
  only (at most 512), so a subagent that ran in another process, or whose run
  ended after the plugin was reloaded or the Gateway restarted, or whose
  prompt and spawn result the plugin never saw, keeps them. Its ledger is
  read only at prompts of the subagent's own session, as for any session,
  and a subagent that finished usually gets none.

Both hooks **fail open**: query errors never block the user's work. Timeout,
HTTP, and malformed-response failures inject compact recovery guidance;
unrelated prompts still inject nothing and completion errors finalize normally.
Prompt text is redacted for common secrets and private-network URLs before any
query is sent. A prompt that contains a private key the hook recognizes (a PEM
or PuTTY key file, or base64 key data) is not searched at all, so none of its
text is sent.

## Environment

- `REMEMBRANCE_API_URL`: API origin. Defaults to `https://remembrance.dev`.
- `REMEMBRANCE_API_KEY`: optional org API key.
- `REMEMBRANCE_API_KEY_ORIGIN`: bind an environment key to an exact custom API
  URL. It is unnecessary for the default cloud URL or when `apiKey` and
  `apiUrl` are stored together in the shared config.
- `REMEMBRANCE_ALLOW_PRIVATE_REGISTRY=true`: explicit opt-in for a trusted
  private/link-local HTTPS self-host. Remote HTTP is rejected except on loopback.
- `REMEMBRANCE_AUTO_QUERY=0`: disables the pre-prompt hook's network query.
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
- `REMEMBRANCE_AUTO_CONTRIBUTE=0`: disables silent completion recovery, its
  next-prompt contribution guidance, and new native context selection.
  Content-free authority withdrawal remains available under existing source
  authorization.
- `REMEMBRANCE_USAGE_DIR`: overrides the per-session usage-marker directory.
- `REMEMBRANCE_AGENT_KEY_PATH`: optional local TOFU key path for MCP identity.
- `REMEMBRANCE_UNATTENDED=1`: marks runs no person attends. Their hooks show
  none of the user decisions about retained private drafts, so none is used
  up, and the next prompt a person makes on the machine gets them; the runs
  still capture and deliver their own lessons. The plugin reads the Gateway's
  environment, so the setting applies to every session that Gateway serves:
  set it only on a Gateway or profile that serves no person.

With an organization key, every query returns `skill_access`. If its policy is
`org_only`, OpenClaw uses only returned organization skills and never
substitutes bundled or live public skill references. Query failures still do
not block the user's work, but they fail closed for public-skill fallback until
the organization policy can be confirmed.

## Generated / copied files

`servers/remembrance-mcp.mjs`, the entire `skills/remembrancer/` tree, and
`src/hook-core.mjs` are generated from the same canonical sources used by the
other Remembrance plugins, then OpenClaw applies a narrow ClawHub security
hardening transform that removes generic environment-controlled credential-path
lookups from the packaged artifact. The fixed `~/.config/remembrance/...`
fallback, `REMEMBRANCE_API_KEY`, `REMEMBRANCE_API_URL`, destination-binding
settings, and the explicit
`REMEMBRANCE_AGENT_KEY_PATH` override remain supported. Do not edit these files
by hand; change the canonical source or the OpenClaw hardening transform and run
`npm run sync:hook-core` / `npm run refresh:generated`.

## Verified vs. unverified against OpenClaw docs

**Confirmed against the OpenClaw 2026.7.1-2 runtime** (its typed hook
declarations, `dist/hook-types-*.d.ts`, and the native host check,
`scripts/native-host-checks/openclaw.mjs`):

- OpenClaw calls a typed hook as `handler(event, ctx)`. The run's identity is
  only in the second argument: `ctx.runId` (new for every run, that is every
  turn), `ctx.sessionId`, `ctx.sessionKey` and `ctx.agentId`. The event has no
  `context`, and a plugin's configuration is `api.pluginConfig`, never part of
  an event. `register()` copies `ctx` onto the event it hands this plugin's
  handlers.
- The plugin keeps lifecycle markers, directives, value episodes, task
  outcomes and host-policy alerts per run (`ctx.runId`), and usage, task
  eligibility, the prompted count and pending actions per session
  (`ctx.sessionId`, else `ctx.sessionKey`), so a debt one run leaves is offered
  at the next prompt of the same session and never in another session.
- `subagent_ended`, verified natively on the pinned 2026.7.1-2 CLI by a
  contract probe through a loopback Gateway before this plugin used the hook
  (the probe's record is kept with the release qualification evidence,
  outside this repository; the native host check drives the error case).
  OpenClaw calls it as `handler(event, ctx)`. The event carries
  `accountId`, `endedAt`, `error`, `outcome`, `reason`, `runId`,
  `sendFarewell`, `targetKind` (`"subagent"`) and `targetSessionKey`; the
  context carries exactly `childSessionKey` (equal to `targetSessionKey`),
  `requesterSessionKey` (the spawning session's key, as the spawn result's
  `after_tool_call` context names it) and `runId`, with no `sessionId` or
  `sessionKey`, so the subagent's ledger comes from the plugin's own record.
  Outcomes observed: `ok`, `error` and `timeout` (`killed`, for reason
  `subagent-killed`, is in OpenClaw's source only). It fires once per ended
  run, after the announce, also when the announce was steered into a run of
  the requester in progress; a later run of the subagent's session
  (`sessions_send`, once the registry has recorded the previous run's end)
  fires it again with a new `runId`. It is not a
  conversation hook: OpenClaw does not hold it before the conversation-access
  grant (a plugin never granted received every event), while it still holds
  `before_agent_finalize`.

**Confirmed by the OpenClaw docs** (cited above):

- `openclaw.plugin.json` is metadata-only (id / configSchema required; an empty
  `configSchema` object is acceptable) and does **not** declare entrypoints or
  hooks — those live in `package.json#openclaw` and runtime code.
  ([Plugin manifest](https://docs.openclaw.ai/plugins/manifest))
- Native entrypoints are declared in `package.json` under
  `openclaw.extensions` / `openclaw.runtimeExtensions`.
  ([Plugin entry points](https://docs.openclaw.ai/plugins/sdk-entrypoints))
- Plugins register hooks in code via `register(api)` + `api.on(name, handler,
opts?)` (with `priority` / `timeoutMs` options).
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
  [Plugin internals](https://docs.openclaw.ai/plugins/architecture))
- Hook names in the agent loop — `before_model_resolve`, `before_prompt_build`,
  `llm_input`, `before_agent_reply`, `llm_output`, `before_agent_finalize`,
  `agent_end` — and that `llm_output` / `agent_end` are observation-only.
  OpenClaw gates only the raw conversation hooks quoted in
  [Conversation access](#conversation-access); `before_prompt_build` is not one
  of them.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks),
  [Agent loop](https://docs.openclaw.ai/concepts/agent-loop))
- `after_tool_call` is the observation-only hook for successful/error tool
  outcomes. ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- Pre-prompt context-injection fields: `prependContext`, `appendContext`,
  `systemPrompt`, `prependSystemContext`, `appendSystemContext`.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- `before_agent_finalize` returns `{ action: "revise", reason }` /
  `{ action: "finalize" }` (or omitted), with an optional
  `retry: { instruction, idempotencyKey?, maxAttempts? }`.
  ([Plugin hooks](https://docs.openclaw.ai/plugins/hooks))
- `allowConversationAccess` gating and the `plugins.entries.<id>` config shape.
  ([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference))
- MCP servers configured under `mcp.servers.<id>` with `command` / `args` /
  `env`. ([Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference),
  [MCP CLI](https://docs.openclaw.ai/cli/mcp))
- ClawHub install/publish commands.
  ([Manage plugins](https://docs.openclaw.ai/plugins/manage-plugins),
  [ClawHub quickstart](https://github.com/openclaw/clawhub/blob/main/docs/quickstart.md))

**Unverified / best-effort (thin docs — flagged):**

- **Which pre-prompt event to bind for context injection.** The docs list both
  `before_model_resolve` (returns provider/model overrides) and
  `before_prompt_build` (returns the context-injection fields), but do not show a
  full worked example of a context-injection hook. We bind
  **`before_prompt_build`** because that is the hook the docs associate with
  `appendContext`/`appendSystemContext`. If a given OpenClaw build only exposes
  `before_model_resolve` for injection, switch the `api.on(...)` name in
  `src/index.mjs` (the handler and return shape are otherwise the same).
- **The exact event field carrying the user's prompt.** The docs say
  `before_prompt_build` receives "the current prompt" but do not pin the field
  name. `src/index.mjs#promptFromEvent` probes `event.prompt` /
  `event.userPrompt` / `event.input.prompt` and falls back to scanning
  `event.messages` for the latest user turn; if none match, the core no-ops
  (fail-open).
- **`definePluginEntry` import.** The documented import is
  `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"`. To keep
  this package Node-builtins-only (so `node --check` and the unit tests run
  without the OpenClaw SDK installed), `src/index.mjs` uses an inline
  identity-style `definePluginEntry` fallback. It is behaviorally equivalent — a
  loaded plugin's default export is the same definition object either way. When
  publishing/running under OpenClaw, this can be swapped for the real SDK import
  with no other change.
- **No plugin-root variable for `openclaw.mcp.json`.** OpenClaw only expands real
  uppercase `${VAR}` values and does **not** define an `${OPENCLAW_PLUGIN_ROOT}`
  (nor a documented plugin-root variable) for MCP configs, so the shipped
  fragment is illustrative only. The plugin-owned `openclaw remembrance setup`
  command writes the installed absolute path through OpenClaw's supported
  config-mutation API; managed installations may use absolute `command` and
  `args` paths or
  `openclaw mcp add remembrance --command "$(command -v node)" --arg /abs/path/...`.
- **`openclaw.compat.pluginApi` / `openclaw.build.openclawVersion` values.**
  ClawHub requires date-versioned compatibility metadata. The package is pinned
  to the oldest OpenClaw host exercised by the release gate; update the pin and
  rerun that host gate before publishing a release that needs newer host APIs.
