import { PRIVATE_SUBMISSION_APPROVAL_SNIPPETS } from "@remembrance/core";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PRIVATE_EGRESS_TOOL_LANES } from "../src/private-egress-lanes.mjs";
import {
  persistPrivateLearningSubmitApproval,
  privateLearningSubmitApprovals,
} from "../src/private-lesson-approval.mjs";

const { configSchema } = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

// OpenClaw validates plugin config against the manifest's configSchema and
// refuses an undeclared key, so every key the runtime writes must be declared.
// This checks the JSON Schema subset the manifest uses.
function schemaErrors(schema, value, path = "config") {
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  }
  if (schema.type !== "object") return [`${path} has an unsupported type`];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${path} must be an object`];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const childSchema = schema.properties?.[key] ?? schema.additionalProperties;
    return childSchema
      ? schemaErrors(childSchema, child, `${path}.${key}`)
      : [`${path}.${key} is not declared`];
  });
}

describe("OpenClaw plugin config schema", () => {
  it("declares every egress lane the runtime can persist", () => {
    expect(
      Object.keys(
        configSchema.properties.privateLearningEgressApprovals.properties,
      ).sort(),
    ).toEqual([...new Set(Object.values(PRIVATE_EGRESS_TOOL_LANES))].sort());
  });

  it("keeps every saved allow-always decision valid and readable after restart", async () => {
    const file = {
      plugins: {
        entries: {
          remembrance: {
            enabled: true,
            hooks: { allowConversationAccess: true },
            config: {},
          },
        },
      },
    };
    const mutateConfigFile = vi.fn(async ({ mutate }) => mutate(file));
    for (const tool of Object.keys(PRIVATE_EGRESS_TOOL_LANES)) {
      await persistPrivateLearningSubmitApproval(
        { runtime: { config: { mutateConfigFile } } },
        tool,
      );
    }
    const saved = file.plugins.entries.remembrance.config;

    expect(schemaErrors(configSchema, saved)).toEqual([]);
    expect(privateLearningSubmitApprovals({ pluginConfig: saved })).toEqual(
      new Set(Object.values(PRIVATE_EGRESS_TOOL_LANES)),
    );
    expect(file.plugins.entries.remembrance.hooks).toEqual({
      allowConversationAccess: true,
    });
  });

  it("accepts the documented pre-set lanes and the legacy shapes, and rejects undeclared keys", () => {
    const documented = JSON.parse(PRIVATE_SUBMISSION_APPROVAL_SNIPPETS.openClaw)
      .plugins.entries.remembrance.config;
    expect(documented).toEqual({
      privateLearningEgressApprovals: {
        private_lesson: true,
        private_skill: true,
      },
    });
    for (const config of [
      documented,
      {
        privateLearningSubmitApprovals: {
          retry_private_skill_candidate: true,
        },
      },
      { privateLessonSubmitApproval: true },
    ]) {
      expect(schemaErrors(configSchema, config)).toEqual([]);
    }
    expect(
      privateLearningSubmitApprovals({ pluginConfig: documented }),
    ).toEqual(new Set(["private_lesson", "private_skill"]));

    expect(
      schemaErrors(configSchema, {
        privateLearningEgressApprovals: { every_lane: true },
      }),
    ).toEqual([
      "config.privateLearningEgressApprovals.every_lane is not declared",
    ]);
    expect(
      schemaErrors(configSchema, {
        privateLearningEgressApprovals: { private_skill: "yes" },
      }),
    ).toEqual([
      "config.privateLearningEgressApprovals.private_skill must be a boolean",
    ]);
    expect(schemaErrors(configSchema, { approveAllTools: true })).toEqual([
      "config.approveAllTools is not declared",
    ]);
  });
});
