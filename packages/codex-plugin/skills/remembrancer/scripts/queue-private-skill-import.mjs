#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const KIND = "remembrance.organization_skill_import";
const MAX_SKILLS = 10;
const MAX_BUNDLE_BYTES = 700 * 1024;
const ALLOWED_RUNTIME = new Set([
  "codex",
  "claude_code",
  "cursor",
  "openclaw",
  "vs_code",
  "opencode",
  "mcp",
  "other",
]);
const ALLOWED_REASON = new Set([
  "host_policy_blocked",
  "network_unavailable",
  "manual_offline",
]);
const ALLOWED_RISK = new Set(["low", "medium", "high", "unknown"]);
const REQUEST_KEYS = new Set([
  "skills",
  "source_runtime",
  "handoff_reason",
  "idempotency_key",
]);
const SKILL_KEYS = new Set([
  "slug",
  "name",
  "description",
  "summary",
  "skill_md",
  "domains",
  "tags",
  "risk_level",
  "known_failure_modes",
  "suggested_patches",
]);

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  fail(
    "Usage: node queue-private-skill-import.mjs --input <request.json> [--outbox <directory>]",
  );
}

const request = validateRequest(
  JSON.parse(await readFile(resolve(args.input), "utf8")),
);
const fingerprint = sha256(
  canonicalJson({
    kind: KIND,
    idempotency_key: request.idempotency_key ?? null,
    source_runtime: request.source_runtime,
    handoff_reason: request.handoff_reason,
    skills: request.skills,
  }),
);
const bundle = {
  schema_version: "1",
  kind: KIND,
  bundle_id: `handoff_${fingerprint.slice(0, 24)}`,
  created_at: new Date().toISOString(),
  destination: "active_organization_private_review",
  source_runtime: request.source_runtime,
  handoff_reason: request.handoff_reason,
  skills: request.skills,
};
const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_BYTES) {
  fail(`The handoff bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller.`);
}

const outbox = resolve(
  args.outbox ?? join(process.cwd(), ".remembrance", "outbox"),
);
await mkdir(outbox, { recursive: true, mode: 0o700 });
await chmod(outbox, 0o700);
const ignorePath = join(outbox, ".gitignore");
await writeFile(ignorePath, "*\n!.gitignore\n", {
  encoding: "utf8",
  flag: "w",
  mode: 0o600,
});
await chmod(ignorePath, 0o600);

const outputPath = join(outbox, `${bundle.bundle_id}.json`);
let alreadyPresent = false;
try {
  await writeFile(outputPath, serialized, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if (!(error instanceof Error) || error.code !== "EEXIST") {
    throw error;
  }
  const existing = JSON.parse(await readFile(outputPath, "utf8"));
  if (
    existing.bundle_id !== bundle.bundle_id ||
    existing.schema_version !== bundle.schema_version ||
    existing.kind !== KIND ||
    existing.destination !== bundle.destination ||
    existing.source_runtime !== bundle.source_runtime ||
    existing.handoff_reason !== bundle.handoff_reason ||
    canonicalJson(existing.skills) !== canonicalJson(bundle.skills)
  ) {
    fail("The existing handoff file does not match this request.");
  }
  alreadyPresent = true;
}
await chmod(outputPath, 0o600);

process.stdout.write(
  `${JSON.stringify({
    queued: true,
    already_present: alreadyPresent,
    network_contacted: false,
    bundle_id: bundle.bundle_id,
    path: outputPath,
    file_mode: "0600",
    next_step:
      "An organization admin must upload this file at Dashboard > Skills > Import. Do not claim the skills were submitted before the dashboard returns an import batch receipt.",
  })}\n`,
);

function validateRequest(value) {
  assertRecord(value, "request");
  rejectUnknownKeys(value, REQUEST_KEYS, "request");
  if (!Array.isArray(value.skills) || value.skills.length < 1) {
    fail("skills must contain at least one skill.");
  }
  if (value.skills.length > MAX_SKILLS) {
    fail(`A handoff bundle can contain at most ${MAX_SKILLS} skills.`);
  }
  const sourceRuntime = value.source_runtime ?? "other";
  const handoffReason = value.handoff_reason ?? "host_policy_blocked";
  if (!ALLOWED_RUNTIME.has(sourceRuntime)) {
    fail("source_runtime is invalid.");
  }
  if (!ALLOWED_REASON.has(handoffReason)) {
    fail("handoff_reason is invalid.");
  }
  return {
    skills: value.skills.map((skill, index) => validateSkill(skill, index)),
    source_runtime: sourceRuntime,
    handoff_reason: handoffReason,
    ...(value.idempotency_key === undefined
      ? {}
      : {
          idempotency_key: boundedString(
            value.idempotency_key,
            512,
            "idempotency_key",
          ),
        }),
  };
}

function validateSkill(value, index) {
  const label = `skills[${index}]`;
  assertRecord(value, label);
  rejectUnknownKeys(value, SKILL_KEYS, label);
  const result = {
    name: boundedString(value.name, 160, `${label}.name`),
    skill_md: boundedString(value.skill_md, 56_000, `${label}.skill_md`),
  };
  if (value.slug !== undefined) {
    const slug = boundedString(value.slug, 160, `${label}.slug`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      fail(`${label}.slug must be a lowercase hyphenated slug.`);
    }
    result.slug = slug;
  }
  for (const key of ["description", "summary"]) {
    if (value[key] !== undefined) {
      result[key] = boundedString(value[key], 2_000, `${label}.${key}`);
    }
  }
  for (const [key, maximumItems, maximumLength] of [
    ["domains", 8, 120],
    ["tags", 16, 120],
    ["known_failure_modes", 12, 500],
    ["suggested_patches", 12, 500],
  ]) {
    if (value[key] !== undefined) {
      result[key] = boundedStringArray(
        value[key],
        maximumItems,
        maximumLength,
        `${label}.${key}`,
      );
    }
  }
  if (value.risk_level !== undefined) {
    if (!ALLOWED_RISK.has(value.risk_level)) {
      fail(`${label}.risk_level is invalid.`);
    }
    result.risk_level = value.risk_level;
  }
  return result;
}

function boundedString(value, maximum, label) {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    fail(`${label} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function boundedStringArray(value, maximumItems, maximumLength, label) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    fail(`${label} must contain at most ${maximumItems} strings.`);
  }
  return value.map((item, index) =>
    boundedString(item, maximumLength, `${label}[${index}]`),
  );
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag !== "--input" && flag !== "--outbox") {
      fail(`Unknown argument: ${flag}`);
    }
    const value = values[index + 1];
    if (!value) {
      fail(`${flag} requires a value.`);
    }
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
