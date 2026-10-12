import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isReuseRequest,
  REUSE_REQUEST_PATTERNS,
  searchHygieneReason,
  shouldQueryPrompt,
} from "../scripts/hook-core.mjs";
import { KEYWORDS_ONLY } from "./fixtures/task-shape.mjs";

// These cases pin the keyword triggers, so they switch the task-shape default
// off (owner decision 34C); task-shape.test.mjs covers the default.

// Every synthetic benchmark v2 query with master's decision (7ce72d8d);
// provenance and hashes are in the fixture header.
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/trigger-gap-benchmark.json", import.meta.url),
    "utf8",
  ),
);
const queries = fixture.queries;
const gold = queries.filter((query) => query.gold);

// The benchmark queries master does not search that the two closed fixes do.
const WORD_FORM_RESCUES = {
  "para-azure-validate-1": "workflow_shape", // deploying
  "para-azure-deploy-4": "workflow_shape", // provisioning
  "legacy-remotion-video": "ui_or_dashboard_work", // components
};
const MPP_NAME_RESCUES = { "distractor-mpp-1": "external_service" };
const REUSE_RESCUES = [
  "para-find-skills-1",
  "para-find-skills-3",
  "para-find-skills-4",
  "para-remembrancer-1",
  "para-remembrancer-3",
  "legacy-skills-discovery",
];

describe("trigger gap fixes on the synthetic benchmark", () => {
  it("keeps every decision master made and searches exactly the ten fixed misses", () => {
    const newlySearched = {};
    for (const query of queries) {
      const decision = shouldQueryPrompt(query.summary, KEYWORDS_ONLY);
      if (query.master_reason !== "no_trigger_match") {
        expect(decision.reason, query.id).toBe(query.master_reason);
      } else if (decision.reason !== "no_trigger_match") {
        newlySearched[query.id] = decision.reason;
      }
    }
    expect(newlySearched).toEqual({
      ...WORD_FORM_RESCUES,
      ...MPP_NAME_RESCUES,
      ...Object.fromEntries(REUSE_RESCUES.map((id) => [id, "reuse_request"])),
    });
  });

  it("searches 82 of the 122 gold queries where master searched 72", () => {
    const searched = (list) =>
      list.filter((query) => shouldQueryPrompt(query.summary, KEYWORDS_ONLY).likely_match)
        .length;
    expect(gold).toHaveLength(122);
    expect(
      gold.filter((query) => query.master_reason !== "no_trigger_match"),
    ).toHaveLength(72);
    expect(searched(gold)).toBe(82);
    const misses = gold.filter((query) => query.master_reason === "no_trigger_match");
    expect(misses).toHaveLength(50);
    // 4 of the 50 by the word forms and the MPP name, 6 by reuse; 40 remain.
    expect(searched(misses)).toBe(10);
  });

  it("searches no no-answer query and stops no benchmark query by hygiene", () => {
    const noAnswer = queries.filter((query) => query.kind === "no_answer");
    expect(noAnswer).toHaveLength(5);
    for (const query of noAnswer) {
      expect(shouldQueryPrompt(query.summary, KEYWORDS_ONLY), query.id).toEqual({
        likely_match: false,
        reason: "no_trigger_match",
      });
    }
    for (const query of queries) {
      expect(searchHygieneReason(query.summary), query.id).toBeNull();
    }
  });
});

describe("word forms of master's own trigger entries", () => {
  // A neutral carrier: master searches none of these forms in it.
  const carrier = (words) => `Please look at the ${words} for this project today`;

  it.each([
    ["deploys", "workflow_shape"],
    ["deployed", "workflow_shape"],
    ["deploying", "workflow_shape"],
    ["deployments", "workflow_shape"],
    ["migrates", "workflow_shape"],
    ["migrated", "workflow_shape"],
    ["migrating", "workflow_shape"],
    ["migrations", "workflow_shape"],
    ["pipelines", "workflow_shape"],
    ["payment integrations", "workflow_shape"],
    ["schema upgrades", "workflow_shape"],
    ["build errors", "workflow_shape"],
    ["releases", "workflow_shape"],
    ["released", "workflow_shape"],
    ["releasing", "workflow_shape"],
    ["rollbacks", "workflow_shape"],
    ["provisions", "workflow_shape"],
    ["provisioned", "workflow_shape"],
    ["provisioning", "workflow_shape"],
    ["backfills", "workflow_shape"],
    ["backfilled", "workflow_shape"],
    ["backfilling", "workflow_shape"],
    ["frontends", "ui_or_dashboard_work"],
    ["dashboards", "ui_or_dashboard_work"],
    ["admin panels", "ui_or_dashboard_work"],
    ["review cards", "ui_or_dashboard_work"],
    ["settings layouts", "ui_or_dashboard_work"],
    ["layouts", "ui_or_dashboard_work"],
    ["nav bars", "ui_or_dashboard_work"],
    ["sidebars", "ui_or_dashboard_work"],
    ["modals", "ui_or_dashboard_work"],
    ["tooltips", "ui_or_dashboard_work"],
    ["popovers", "ui_or_dashboard_work"],
    ["components", "ui_or_dashboard_work"],
    ["buttons", "ui_or_dashboard_work"],
    ["form designs", "ui_or_dashboard_work"],
    ["redesigned pages", "ui_or_dashboard_work"],
    ["decluttered cards", "ui_or_dashboard_work"],
    ["design systems", "ui_or_dashboard_work"],
    ["OpenAI models", "external_service"],
    ["Anthropic APIs", "external_service"],
    ["embeddings from Voyage", "external_service"],
    ["Claude endpoints", "external_service"],
    ["integrated webhooks", "third_party_integration"],
    ["integrations", "third_party_integration"],
    ["configured webhooks", "third_party_integration"],
    ["webhook we are setting up", "third_party_integration"],
  ])("searches %s as %s", (words, reason) => {
    expect(shouldQueryPrompt(carrier(words), KEYWORDS_ONLY)).toEqual({
      likely_match: true,
      reason,
    });
  });

  it.each(["deployer", "releaser", "provisioner", "componentry", "CIS checks"])(
    "adds no other word: %s",
    (words) => {
      expect(shouldQueryPrompt(carrier(words), KEYWORDS_ONLY)).toEqual({
        likely_match: false,
        reason: "no_trigger_match",
      });
    },
  );

  it("names MPP the Machine Payments Protocol and keeps the old phrase", () => {
    for (const name of [
      "machine payments protocol",
      "Machine Payment Protocol",
      "model payment protocol",
    ]) {
      expect(
        shouldQueryPrompt(`Pay for this call with the ${name} today`, KEYWORDS_ONLY),
      ).toEqual({ likely_match: true, reason: "external_service" });
    }
  });
});

describe("the reuse-request class", () => {
  it("is closed: requests for existing reusable skills, resources, workflows or registries only", () => {
    // Pinned. No vendor, product or topic word may be added to this class:
    // widening the trigger to topics is the owner's open decision.
    expect(REUSE_REQUEST_PATTERNS.map(String)).toEqual([
      String.raw`/\bskills?\b.{0,60}\b(?:registry|registries|marketplace|installable|published)\b/i`,
      String.raw`/\b(?:find|search|look up|install)\b.{0,40}\bskills?\b/i`,
      String.raw`/\b(?:ready[- ]made|reusable|proven|off[- ]the[- ]shelf|already (?:published|built))\b.{0,40}\b(?:packages?|skills?|resources?|workflows?|approach(?:es)?|instructions?|capabilit(?:y|ies)|solutions?|recipes?|playbooks?)\b/i`,
      String.raw`/\b(?:someone|anyone)\s+(?:already|has)\s+(?:published|built|written|shared)\b/i`,
      String.raw`/\b(?:before|instead of|rather than)\s+(?:building|writing|creating|starting|prompting|rolling)\b.{0,40}\b(?:our own|custom|from scratch|ourselves)\b/i`,
      String.raw`/\bshared\s+(?:registry|operational memory)\b/i`,
    ]);
    expect(Object.isFrozen(REUSE_REQUEST_PATTERNS)).toBe(true);
  });

  it("matches the six reuse queries and no distractor or no-answer query", () => {
    for (const id of REUSE_RESCUES) {
      const query = queries.find((item) => item.id === id);
      expect(isReuseRequest(query.summary), id).toBe(true);
    }
    const others = queries.filter(
      (query) => query.kind === "distractor" || query.kind === "no_answer",
    );
    expect(others).toHaveLength(15);
    for (const query of others) {
      expect(isReuseRequest(query.summary), query.id).toBe(false);
    }
  });

  it("is consulted only after every stop rule and topic rule found nothing", () => {
    const reuse = "a proven workflow for PDF tables before building our own";
    expect(shouldQueryPrompt(`Find ${reuse}`, KEYWORDS_ONLY)).toEqual({
      likely_match: true,
      reason: "reuse_request",
    });
    expect(shouldQueryPrompt(`What is ${reuse}?`, KEYWORDS_ONLY)).toEqual({
      likely_match: false,
      reason: "skip_pattern",
    });
    expect(
      shouldQueryPrompt(`Use the Remembrance skill named find-skills: ${reuse}`, KEYWORDS_ONLY),
    ).toEqual({ likely_match: false, reason: "explicit_skill_reference" });
    expect(
      shouldQueryPrompt(`<task-notification>Find ${reuse}</task-notification>`, KEYWORDS_ONLY),
    ).toEqual({ likely_match: false, reason: "host_notification" });
    expect(
      shouldQueryPrompt(`Find ${reuse} and deploy it on Vercel`, KEYWORDS_ONLY),
    ).toEqual({ likely_match: true, reason: "external_service" });
  });

  it("leaves hygiene in charge of host text", () => {
    const handback = `<agent-message from="worker">\n[Subagent hand-back]\nChecked a shared registry for a proven workflow before building our own.\n</agent-message>`;
    expect(shouldQueryPrompt(handback, KEYWORDS_ONLY)).toEqual({
      likely_match: false,
      reason: "hygiene_subagent_handback",
      hygiene: "subagent_handback",
      trigger: "reuse_request",
    });
    expect(
      shouldQueryPrompt(handback, {
        ...KEYWORDS_ONLY,
        REMEMBRANCE_AUTO_QUERY_HYGIENE: "0",
      }),
    ).toEqual({ likely_match: true, reason: "reuse_request" });
    expect(
      shouldQueryPrompt("/find-skills a proven workflow before building our own", KEYWORDS_ONLY),
    ).toEqual({
      likely_match: false,
      reason: "hygiene_local_skill_reference",
      hygiene: "local_skill_reference",
      trigger: "reuse_request",
    });
  });
});
