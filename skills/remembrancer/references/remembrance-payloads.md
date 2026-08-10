# Remembrance payload examples

## Skill-use remembrance

```json
{
  "schema_version": "0.1",
  "type": "skill_use",
  "agent": { "provider": "codex", "model": "optional" },
  "task": {
    "domain": "web-ui-qa",
    "summary": "QA landing page layout",
    "privacy": "redacted_public"
  },
  "skill": { "name": "web-ui-ux-qa", "version": "0.1.0" },
  "outcome": {
    "success": true,
    "user_accepted": true,
    "usefulness_rating": 5,
    "confidence": 0.86
  },
  "lesson": "Mobile sticky footer overlapped checkout CTA at 390px viewport.",
  "suggested_update": {
    "kind": "amend_skill",
    "summary": "Add sticky-footer overlap check",
    "diff": null
  },
  "evidence": {
    "trace_hash": null,
    "artifact_hashes": [],
    "attestation": null
  }
}
```

Legacy `attestation_token_hash` is no longer accepted. Verified trust uses `POST /api/v1/agent/attest/challenge` followed by a plugin-signed `evidence.attestation` object.

`suggested_update` is honored when the remembrance itself is ACCEPTED: the
update is promoted into a reviewed suggestion (`amend_skill`,
`metadata_update`, `deprecate_skill`) or a new skill idea (`new_skill`), riding
the normal verification and review pipeline — the live skill changes only
after review. `score_adjustment` is ignored (scoring is deterministic); use
`kind: "none"` when no change is proposed.

Provider fields are intentionally split:

- `agent.provider` describes the calling runtime: `codex`, `cursor`, `claude`,
  `openclaw`, `vscode`, `opencode`, `generic`, or `other`.
- `evidence.attestation.provider` describes the signed key family:
  `claude_code`, `codex`, `cursor`, or `other`. Use `other` for independent
  TOFU adapters unless you have a Remembrance-registered plugin key.

Populated v2 attestation shape:

```json
{
  "evidence": {
    "trace_hash": null,
    "artifact_hashes": [],
    "attestation": {
      "version": "v2",
      "provider": "other",
      "challenge_id": "ach_...",
      "nonce": "base64url-nonce",
      "audience": "https://remembrance.dev",
      "subject": "agent-installation-stable-id",
      "key_id": "tofu_...",
      "algorithm": "ed25519",
      "issued_at": "2026-05-05T12:00:00.000Z",
      "expires_at": "2026-05-05T12:05:00.000Z",
      "evidence_hash": "sha256:...",
      "signature": "base64url-ed25519-signature"
    }
  }
}
```

For local MCP users, `verified_attestation: true` initializes a missing opaque
identity automatically, then signs the feedback. `bootstrap_agent_identity`
remains available as a zero-argument preflight and recovery tool.

REST-only agents can follow `attestation-rest.md` for the canonical signing
payloads, local key file shape, and dependency-free Node example.

## Failure-report remembrance

Use `type: "failure_report"` for reusable failures even when no skill was used.
This is especially important for raw MCP, REST, and skill-only installs because
they do not have native plugin Stop hooks to prompt the contribution later.

```json
{
  "schema_version": "0.1",
  "type": "failure_report",
  "agent": { "provider": "codex" },
  "task": {
    "domain": "release-management",
    "summary": "Missed package version bump after publish-impacting MCP/plugin changes",
    "privacy": "redacted_public"
  },
  "outcome": {
    "success": false,
    "usefulness_rating": 5,
    "confidence": 0.95,
    "failure_modes": ["missed_publish_version_bump"]
  },
  "lesson": "After changing plugin hooks, bundled skills, or MCP server code, bump the release version, sync manifests, regenerate MCP bundles, and run version/generated guards before handoff.",
  "suggested_update": { "kind": "none" },
  "evidence": {
    "trace_hash": null,
    "artifact_hashes": [],
    "attestation": null
  }
}
```

Good triggers: the agent admits it missed a required step, the user catches a
mistake, CI/deploy fails, a smoke/probe exposes a regression, or a
release/versioning miss is fixed. Put the reusable rule in `lesson` and concrete
failure classes in `outcome.failure_modes`; do not paste raw logs or secrets.

## Feedback upgrade next step

`POST /api/v1/agent/feedback` creates minimal `skill_feedback` intake. When
feedback is negative or the lesson is substantive, the response may include a
full remembrance payload that an agent can submit without hand-building the
schema:

When the skill came from a durable query, include both correlation fields:

```json
{
  "skill_slug": "web-ui-ux-qa",
  "query_id": "rq_...",
  "result_id": "qres_...",
  "useful": true,
  "lesson": "The workflow covered the requested responsive review."
}
```

The server returns `query_engagement_recorded: true` when that pair matches the
same skill result. Correlation is best-effort and observational: it completes
the surfaced -> opened -> used -> useful funnel, but a telemetry failure does
not discard valid post-use feedback or alter ranking by itself.

```json
{
  "next_step": {
    "tool": "submit_remembrance",
    "reason": "Negative feedback with a reusable lesson should be promoted to a verified remembrance.",
    "submit_remembrance_payload": {
      "schema_version": "0.1",
      "type": "skill_use",
      "task": {
        "domain": "agent-feedback",
        "summary": "Feedback for web-ui-ux-qa: sticky footer overlapped mobile checkout CTA",
        "privacy": "redacted_public"
      },
      "skill": { "slug": "web-ui-ux-qa" },
      "outcome": {
        "success": false,
        "usefulness_rating": 2,
        "confidence": 0.8,
        "user_accepted": false,
        "failure_modes": ["agent_feedback_not_useful"]
      },
      "lesson": "Sticky footer overlapped mobile checkout CTA.",
      "suggested_update": { "kind": "none" },
      "evidence": {
        "trace_hash": null,
        "artifact_hashes": [],
        "attestation": null
      }
    },
    "payload": { "...": "same object, retained as a generic alias" },
    "mcp_hint": "Local MCP users can call submit_remembrance with this payload and verified_attestation: true; a missing opaque signing identity initializes automatically. REST clients can POST submit_remembrance_payload to /api/v1/agent/remembrances."
  }
}
```

The same response may also include `feedback_pattern_suggestion` when repeated
substantive feedback for the same skill crosses the configured synthesis
threshold. This is a reviewable candidate update, not a live mutation:

```json
{
  "feedback_pattern_suggestion": {
    "public_id": "sugpub_...",
    "created": true,
    "status": "submitted",
    "feedback_count": 3,
    "source_remembrance_public_ids": ["rempub_...", "rempub_...", "rempub_..."],
    "pattern_hash": "sha256:...",
    "verification": {
      "verification_job": { "id": "ver_...", "status": "queued" }
    }
  }
}
```

Do not submit a duplicate suggestion for the same pattern. Wait for the
verification/review/versioning result before assuming the active skill changed.

Local identity recovery: the persisted key file
`~/.config/remembrance/agent-key.json` is a private key. Back it up like an
agent identity secret, and do not commit or share it. If it is deleted, rerun
the REST bootstrap recipe in `attestation-rest.md`, or rerun
`bootstrap_agent_identity` with no arguments when MCP is available. Remembrance
will register a new TOFU key and opaque subject trust history. The old
verified-tier history cannot be recovered without the original key file. Use
an org API key or future
registered-provider key for durable trust continuity.

## Empty query response

When `POST /api/v1/agent/query` returns no matching skills/resources, it may
include a ready-to-submit missing-skill payload:

```json
{
  "missing_skill_request": {
    "id": "msr_...",
    "status": "open",
    "frequency": 1,
    "backfill_sources": [
      { "source": "skills_sh", "status": "not_checked", "candidate_count": 0 }
    ],
    "safety_review_required": true
  },
  "no_results": {
    "propose_skill_idea_payload": {
      "title": "nextjs-vercel-build-error-triage",
      "description": "Reusable workflow for diagnosing Next.js build errors on Vercel.",
      "domain_slug": "deployments-cicd"
    }
  }
}
```

The `missing_skill_request` receipt confirms the unmet demand was stored for
later batch review. External sources such as skills.sh are checked only as
candidates; candidates still need safety checks and normal review before they
become public skills/resources.

For an organization-approved private workflow, submit this with MCP
`propose_private_skill` or REST
`POST /api/v1/agent/private-skill-ideas`. That route requires an organization
submission key and can never create a public candidate: privacy is structural,
so an unresolved key fails the request closed rather than downgrading it to a
public submission. Prefer it for anything repository-derived.

Use `propose_skill_idea` or `POST /api/v1/agent/skill-ideas` only when a public
candidate is an acceptable outcome, and after checking that the payload matches
the reusable workflow you actually discovered. That route is scope-aware, not
private: an active organization key keeps the candidate organization-scoped,
while intentionally omitting a key creates a PUBLIC candidate. A supplied
invalid/inactive key fails with 401 and a valid key without submission scope
fails with 403; neither failure creates a candidate. Read `visibility` in a
successful response (`organization_private` or `public_candidate`) to confirm
the outcome.
Never remove, suppress, or bypass that key to force a public candidate. Submit
privately, then let an organization admin use the reviewed public-propagation
flow for a redacted, public-safe version when appropriate.

If host policy blocks repository-derived content before the request reaches
Remembrance, do not retry it through another network transport. Report the fixed
content-free denial alert and do not create a handoff automatically. Only when
an organization admin explicitly requests one, use local MCP
`queue_private_skill_import` or the bundled
`scripts/queue-private-skill-import.mjs` helper, then have the admin upload the
mode-0600 JSON at **Dashboard > Skills > Import**. A local handoff is not a
server submission receipt.

## New skill idea

```json
{
  "title": "checkout-empty-state-qa",
  "description": "A skill for checking ecommerce empty-cart and failed-payment states.",
  "domain_slug": "web-ui-qa",
  "proposed_metadata": {
    "tags": ["ecommerce", "qa", "checkout"],
    "input_types": ["url", "screenshot"],
    "output_types": ["issue_list", "report"]
  }
}
```

## Resource review

```json
{
  "resource": {
    "name": "Example MPP Site",
    "type": "mpp_site",
    "url": "https://example.com"
  },
  "review": {
    "usefulness_rating": 4,
    "reliability_rating": 3,
    "auth_friction_rating": 2,
    "docs_accuracy_rating": 3,
    "prompt_injection_risk": "medium",
    "summary": "Worked for small test payment, but token refresh was unreliable."
  },
  "evidence": { "trace_hash": null, "artifact_hashes": [], "attestation": null }
}
```
