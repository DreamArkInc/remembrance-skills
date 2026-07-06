#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const allowedTypes = new Set([
  "skill_use",
  "skill_feedback",
  "skill_idea",
  "resource_review",
  "patch_suggestion",
  "failure_report",
  "eval_result",
]);

const allowedPrivacy = new Set(["public", "redacted_public", "private", "org"]);

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: validate-remembrance.mjs <payload.json>");
    process.exit(2);
  }

  const payload = JSON.parse(await readFile(file, "utf8"));
  const result = validate(payload);
  if (!result.ok) {
    console.error(result.errors.join("\n"));
    process.exit(1);
  }

  console.log("Remembrance payload is valid.");
}

function validate(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }

  if (payload.schema_version !== "0.1") {
    errors.push("schema_version must be 0.1");
  }
  if (typeof payload.type !== "string" || !allowedTypes.has(payload.type)) {
    errors.push("type is missing or invalid");
  }

  const task = payload.task;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    errors.push("task is required");
  } else {
    if (typeof task.domain !== "string" || task.domain.length === 0) {
      errors.push("task.domain is required");
    }
    if (typeof task.summary !== "string" || task.summary.length === 0) {
      errors.push("task.summary is required");
    }
    if (typeof task.privacy !== "string" || !allowedPrivacy.has(task.privacy)) {
      errors.push("task.privacy is missing or invalid");
    }
  }

  const outcome = payload.outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    errors.push("outcome is required");
  } else if (
    outcome.usefulness_rating !== undefined &&
    outcome.usefulness_rating !== null &&
    (typeof outcome.usefulness_rating !== "number" ||
      outcome.usefulness_rating < 1 ||
      outcome.usefulness_rating > 5)
  ) {
    errors.push("outcome.usefulness_rating must be 1-5 when provided");
  }

  if (typeof payload.lesson !== "string" || payload.lesson.length === 0) {
    errors.push("lesson is required");
  }

  return { ok: errors.length === 0, errors };
}

await main();
