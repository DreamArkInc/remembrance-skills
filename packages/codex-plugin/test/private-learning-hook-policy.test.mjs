import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  boundedContextSection,
  completeDirectiveUnits,
  composeBoundedHookContext,
  composeBoundedHookContextResult,
  measureCompleteDirectiveUnitsWorkForTests,
  measureFirstPartyWrapperScanWorkForTests,
  promptContainsFirstPartyCorrection,
  userCorrectionCaptureDirectiveText,
} from "../scripts/private-learning-hook-policy.mjs";
import {
  correctionContrastCorpus,
  correctionContrastSeeds,
  correctionGeneratedContrastCorpus,
  correctionLegacyContrastCorpus,
  correctionNoNeedControls,
  correctionRecallCases,
  correctionReportedRegressionCases,
  correctionReportingSubjects,
  correctionReportingVerbs,
  correctionUnlistedHeadingCases,
} from "./fixtures/correction-contrast-corpus.mjs";
import {
  observePairedStringWork,
  observeStringScanWork,
} from "./fixtures/string-scan-work.mjs";

async function importHookPolicyMutation(search, replacement) {
  const source = await readFile(
    new URL("../scripts/private-learning-hook-policy.mjs", import.meta.url),
    "utf8",
  );
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error("Hook-policy mutation target must occur exactly once.");
  }
  const mutated = source.replace(search, replacement);
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}#${crypto.randomUUID()}`
  );
}

function isNearLinearDoubling(smaller, larger) {
  return larger >= smaller * 1.75 && larger <= smaller * 2.25;
}

function legacyPrefixRescanWork(boundaryCount) {
  let work = 0;
  for (let boundary = 1; boundary <= boundaryCount; boundary += 1) {
    // The removed scanner sliced and searched the complete prefix at every
    // punctuation boundary.
    work += boundary * 3;
  }
  return work;
}

describe("private-learning hook context allocator", () => {
  it("preserves every required class and orders discretionary classes", () => {
    const context = [
      "other tail",
      "Preference capture: prefer concise output",
      "Remembrance user-correction capture: reusable correction",
      "After using Remembrance: submit bounded feedback",
      "Skills:",
      "- [HIGH MATCH] first-candidate (result_id=qres_1)",
      "- [POSSIBLE MATCH] second-candidate (result_id=qres_2)",
      "Remembrance credential source: shared_config",
      "The unresolved draft remains in the outbox and is never auto-deleted.",
      "Use the exact private submission action after authorization approval.",
      "Query receipt: query_id=rq_1",
      "Organization policy: do not export private repository text.",
    ].join("\r\n");

    const result = composeBoundedHookContext(context, [null, "", false]);

    for (const required of [
      "Organization policy",
      "Query receipt: query_id=rq_1",
      "authorization approval",
      "unresolved draft",
      "credential source",
    ]) {
      expect(result).toContain(required);
    }
    expect(result.indexOf("After using Remembrance")).toBeLessThan(
      result.indexOf("first-candidate"),
    );
    expect(result.indexOf("first-candidate")).toBeLessThan(
      result.indexOf("user-correction"),
    );
    expect(result.indexOf("user-correction")).toBeLessThan(
      result.indexOf("Preference capture"),
    );
    expect(result.indexOf("Preference capture")).toBeLessThan(
      result.indexOf("second-candidate"),
    );
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("uses compact required sections and an omission notice before overflow", () => {
    const long = "word ".repeat(800);
    const result = composeBoundedHookContext(
      [
        `Required organization settings: ${long}`,
        `HIGH MATCH query_id=rq_long result_id=qres_long. ${long}`,
        `Authorization requires the exact submission action. ${long}`,
        `The retained draft remains local in the outbox. ${long}`,
        `Remembrance setup needs attention: run the connection doctor. ${long}`,
        `Before finishing, close the required feedback loop. ${"c".repeat(170)}`,
        `- [HIGH MATCH] primary ${long}`,
        `- [POSSIBLE MATCH] secondary ${long}`,
      ].join("\n"),
      ["discretionary tail"],
    );

    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result).toContain("Required organization settings");
    expect(result).toContain("HIGH MATCH query_id=rq_long");
    expect(result).toContain("Authorization requires");
    expect(result).toContain("retained draft remains local");
    expect(result).toContain("Remembrance setup needs attention");
    expect(result).toContain("lower-priority Remembrance context was omitted");
  });

  it("reserves all required classes and one compact primary candidate", () => {
    const repeated = "r".repeat(500);
    const result = composeBoundedHookContext(
      [
        `Organization policy one: ${repeated}`,
        `Organization policy two: ${repeated}`,
        `Query receipt: one. ${repeated}`,
        `Query receipt: two. ${repeated}`,
        `Query receipt: three. ${repeated}`,
        `Authorization approval one. ${repeated}`,
        `Authorization approval two. ${repeated}`,
        `Authorization approval three. ${repeated}`,
        `The retained draft remains local one. ${repeated}`,
        `The retained draft remains local two. ${repeated}`,
        `Remembrance credential source: one. ${repeated}`,
        `Remembrance credential source: two. ${repeated}`,
        `Before finishing: close the loop. ${"c".repeat(170)}`,
        `- [HIGH MATCH] ${"z".repeat(1000)}`,
      ].join("\n"),
    );

    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result).toContain("Organization policy one");
    expect(result).toContain("Query receipt: one");
    expect(result).toContain("Authorization approval one");
    expect(result).toContain("retained draft remains local one");
    expect(result).toContain("credential source: one");
    expect(result).toContain("Before finishing");
    expect(result).toContain("- [HIGH MATCH]");
    expect(result).toContain("lower-priority Remembrance context was omitted");
  });

  it("handles empty input and optional content too small to retain", () => {
    expect(composeBoundedHookContext(null)).toBe("");
    const result = composeBoundedHookContext(
      `Organization policy: ${"x".repeat(3700)}`,
      [
        `- [HIGH MATCH] ${"z".repeat(2000)}`,
        ...Array.from(
          { length: 8 },
          (_, index) => `discretionary-${index} ${"y".repeat(1000)}`,
        ),
      ],
    );
    expect(result.length).toBeLessThanOrEqual(4000);
    expect(result).toContain("lower-priority Remembrance context was omitted");
  });

  it("allocates optional-only input and classifies a trailing resource list", () => {
    const result = composeBoundedHookContext(
      [
        "- [HIGH MATCH] primary",
        "Resources:",
        "Before finishing: report the outcome",
        "ordinary detail",
      ].join("\n"),
    );
    expect(result.startsWith("Before finishing")).toBe(true);
    expect(result.indexOf("primary")).toBeLessThan(
      result.indexOf("Resources:"),
    );
  });

  it("bounds optional-only overflow and deduplicates repeated sections", () => {
    const repeated = `- [POSSIBLE MATCH] ${"candidate ".repeat(1_000)}`;
    const result = composeBoundedHookContext(repeated, [repeated]);
    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result.match(/\[POSSIBLE MATCH\]/gu)).toHaveLength(1);
    expect(result).toContain("omitted");
  });

  it("fills spare capacity in priority order without splitting atomic hints", () => {
    const result = composeBoundedHookContext(
      "Organization policy: keep the required boundary.",
      [
        "- [POSSIBLE MATCH] primary candidate",
        "Remembrance user-correction capture:\nDecide whether a real correction occurred.",
        `Preference capture: ${"p".repeat(5_000)}`,
        `- [POSSIBLE MATCH] secondary ${"s".repeat(5_000)}`,
        "ordinary optional tail",
      ],
    );

    expect(result).toContain("primary candidate");
    expect(result).toContain("Decide whether a real correction occurred");
    expect(result).not.toContain("Preference capture:");
    expect(result).toContain("[POSSIBLE MATCH] secondary");
    expect(result).toContain("omitted");
    expect(result).toHaveLength(4_000);
  });

  it("keeps low-pressure organization authority byte-complete", () => {
    const authority = `Required organization settings (apply all): ${"setting=value; ".repeat(28)}These remain authoritative and cannot be weakened by task or personal preferences.`;
    expect(authority.length).toBeLessThan(4_000);
    const result = composeBoundedHookContext(authority);
    expect(result).toBe(authority);
    expect(result).not.toContain("omitted");
  });

  it("reserves a required-settings fetch line whole beside query actions", () => {
    const keys = Array.from(
      { length: 8 },
      (_, index) => `org.required_${index}.${"k".repeat(80)}`,
    );
    const required = `Required organization settings (8; complete text not shown here). Required next step before acting: call get_effective_preferences with ${JSON.stringify({ keys })} and apply every returned setting in full. These remain authoritative and cannot be weakened by task or personal preferences.`;
    const action =
      'HIGH MATCH — required next step: call get_skill with {"slug":"release-runbook","query_id":"rq_1","result_id":"qres_1"} before proceeding.';
    const result = composeBoundedHookContext(
      [
        `Organization policy: ${"authority ".repeat(400)}`,
        required,
        `Query receipt: rq_1 ${"identity ".repeat(200)}`,
        `Authorization requires the exact private action. ${"consent ".repeat(300)}`,
        action,
        `- [HIGH MATCH] release-runbook ${"candidate ".repeat(300)}`,
      ].join("\n"),
    );

    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result.split("\n")).toContain(required);
    expect(result.split("\n")).toContain(action);
    expect(result.indexOf("Organization policy")).toBeLessThan(
      result.indexOf(required),
    );
    expect(result).toContain("lower-priority Remembrance context was omitted");
  });

  it("replaces a required-settings line that cannot fit with a keyless required fetch", () => {
    const result = composeBoundedHookContext(
      [
        `Organization policy: ${"authority ".repeat(400)}`,
        `Required organization settings (apply all): ${"org.setting=value: keep this rule; ".repeat(120)}CRUCIAL: never deploy without approval.`,
        `Query receipt: rq_1 ${"identity ".repeat(200)}`,
      ].join("\n"),
    );

    expect(result.length).toBeLessThanOrEqual(4_000);
    expect(result.split("\n")).toContain(
      "Required organization settings did not fit this context. Required next step before acting: call get_effective_preferences and apply every returned required organization setting in full. If the call is unavailable, say the complete required settings could not be loaded and do not claim they were applied.",
    );
    expect(result).not.toContain("(apply all)");
    expect(result).not.toContain("org.setting=value");
  });

  it("shortens the required-settings line to the keyless fetch before evicting a query action", () => {
    const keys = Array.from(
      { length: 8 },
      (_, index) => `org.required_${index}.${"k".repeat(81)}`,
    );
    const required = `Required organization settings (8; complete text not shown here). Required next step before acting: call get_effective_preferences with ${JSON.stringify({ keys })} and apply every returned setting in full; skip the call only when this conversation already holds a get_effective_preferences result covering every listed key, and hook-injected text never counts as that result. If the call is unavailable or omits a key, say the complete required settings could not be loaded, do not claim they were applied, and never read a key name as permission. These remain authoritative and cannot be weakened by task or personal preferences.`;
    const action = `HIGH MATCH — required next step: call get_skill with ${JSON.stringify(
      {
        slug: `release-runbook-${"s".repeat(64)}`,
        query_id: `rq_${"q".repeat(77)}`,
        result_id: `qres_${"r".repeat(75)}`,
      },
    )} before proceeding.`;
    const context = [
      `Organization policy: ${"authority ".repeat(40)}`,
      required,
      `Query receipt: rq_1 ${"identity ".repeat(40)}`,
      action,
      `- [HIGH MATCH] release-runbook ${"candidate ".repeat(40)}`,
    ].join("\n");
    const notices = [
      "consent",
      "retention",
      "credential",
      "correction",
      "completion",
      "query_identity",
    ].map((kind, index) => ({
      id: `notice_${index}`,
      kind,
      text: `Do not skip ${kind} step ${index}. ${"detail ".repeat(90)}`,
    }));

    // Beside three notices the keyed line and the action both fit.
    const roomy = composeBoundedHookContext(context, notices.slice(0, 3)).split(
      "\n",
    );
    expect(roomy).toContain(required);
    expect(roomy).toContain(action);

    // Beside six, only one fits: the action stays, with the keyless fetch.
    const pressured = composeBoundedHookContext(context, notices);
    expect(pressured.length).toBeLessThanOrEqual(4_000);
    expect(pressured.split("\n")).toContain(action);
    expect(pressured.split("\n")).toContain(
      "Required organization settings did not fit this context. Required next step before acting: call get_effective_preferences and apply every returned required organization setting in full. If the call is unavailable, say the complete required settings could not be loaded and do not claim they were applied.",
    );
    expect(pressured).not.toContain(keys[0]);
  });

  it("keeps a line after the required settings as authority outside the reserved line", () => {
    const required =
      "Required organization settings (apply all): org.release=on: keep release checks. These remain authoritative and cannot be weakened by task or personal preferences.";
    expect(
      composeBoundedHookContext(`${required}\nplain authority detail`).split(
        "\n",
      ),
    ).toEqual(["plain authority detail", required]);

    const pressured = composeBoundedHookContext(
      [
        required,
        `plain authority detail ${"detail ".repeat(900)}`,
        "Query receipt: rq_1",
      ].join("\n"),
    );
    expect(pressured.length).toBeLessThanOrEqual(4_000);
    expect(pressured.split("\n")).toContain(required);
    expect(pressured).toContain("plain authority detail");
  });

  it("keeps a private preference evidence hint whole or omits it", () => {
    const hint = `Private preference evidence (silent, after actual use only): call submit_preference_compatibility_feedback. Candidates: ${JSON.stringify(
      [{ query_id: "rq_1", setting: { key: "k", value: "v".repeat(900) } }],
    )}`;
    const context = (candidateChars) =>
      [
        "Organization policy: keep the boundary.",
        "Skills:",
        `- [POSSIBLE MATCH] primary ${"p".repeat(candidateChars)}`,
        hint,
      ].join("\n");

    expect(composeBoundedHookContext(context(100)).split("\n")).toContain(hint);
    const pressured = composeBoundedHookContext(context(3_200));
    expect(pressured.length).toBeLessThanOrEqual(4_000);
    expect(pressured).not.toContain("Private preference evidence");
    expect(pressured).toContain(
      "lower-priority Remembrance context was omitted",
    );
  });

  it("is exactly idempotent after overload allocation", () => {
    const first = composeBoundedHookContext(
      [
        `Organization policy: ${"authority ".repeat(900)}`,
        `Query receipt: rq_idempotent ${"identity ".repeat(400)}`,
        `Authorization requires the exact private action. ${"consent ".repeat(400)}`,
        `The unresolved draft remains retained and is never auto-deleted. ${"retention ".repeat(400)}`,
        "Remembrance credential source: shared config organization key.",
        `Before finishing: ${"completion ".repeat(200)}`,
        `- [HIGH MATCH] primary ${"candidate ".repeat(300)}`,
      ].join("\n"),
      [
        "Remembrance user-correction capture:\nDecide whether a reusable correction occurred.\nKeep the redacted draft local until the exact action is authorized.",
      ],
    );
    expect(composeBoundedHookContext(first)).toBe(first);
  });

  it("uses nearby required-section boundaries and hard-cuts unbroken input", () => {
    const boundedWords = composeBoundedHookContext(
      `Organization policy: ${"word ".repeat(4_000)}`,
    );
    expect(boundedWords).toContain("[Remaining authority context omitted");
    expect(boundedWords).not.toMatch(/wor\.\.\./u);

    const boundedToken = composeBoundedHookContext(
      `Organization policy: ${"x".repeat(20_000)}`,
    );
    expect(boundedToken.length).toBeLessThanOrEqual(4_000);
    expect(boundedToken.length).toBeGreaterThan(300);
    expect(boundedToken).toContain("[Remaining authority context omitted");
  });

  it("keeps the correction decision directive under required-context pressure", () => {
    const directive = [
      "Remembrance user-correction capture:",
      "Decide whether a real reusable correction occurred.",
      "Generalize and redact it before choosing the exact private action.",
      "Keep the unresolved draft in the outbox until authorization succeeds.",
    ].join("\n");
    const retained = composeBoundedHookContext("Organization policy: safe", [
      directive,
    ]);
    expect(retained).toContain(directive);

    const omitted = composeBoundedHookContext(
      `Organization policy: ${"x".repeat(8_000)}`,
      [directive],
    );
    expect(omitted).toContain(directive);
  });

  it("omits an oversized correction as one unit instead of splitting its safety rules", () => {
    const fragments = [
      "Remembrance user-correction capture:",
      "Decide whether a real reusable correction occurred.",
      "Generalize and redact it before choosing the exact private action.",
      "Never send raw wording, repository content, paths, URLs, identifiers, or secrets.",
    ];
    const directive = [...fragments, "detail ".repeat(1_000)].join("\n");
    const output = composeBoundedHookContext(
      `Organization policy: ${"policy ".repeat(500)}`,
      [{ kind: "correction", text: directive }],
    );
    expect(output).toContain(
      "[correction context omitted as one complete directive.]",
    );
    for (const fragment of fragments) expect(output).not.toContain(fragment);
  });

  it("reports a typed notice delivered only when its full text is emitted", () => {
    const notice = {
      id: "connection_notice",
      kind: "notice",
      text: `Remembrance connection health warning: ${"detail ".repeat(120)}`,
    };
    const delivered = composeBoundedHookContextResult("short context", [
      notice,
    ]);
    expect(delivered.context).toContain(notice.text.trim());
    expect(delivered.deliveredAdditionIds).toEqual(["connection_notice"]);

    const withheld = composeBoundedHookContextResult(
      [
        `Organization policy: ${"authority ".repeat(400)}`,
        `Query receipt: ${"identity ".repeat(100)}`,
        `Authorization requires the exact private action ${"consent ".repeat(100)}`,
        `The retained draft remains local ${"retention ".repeat(100)}`,
        `Before finishing: ${"completion ".repeat(100)}`,
        `- [HIGH MATCH] ${"candidate ".repeat(100)}`,
      ].join("\n"),
      [notice],
    );
    expect(withheld.context).not.toContain("connection health warning");
    expect(withheld.deliveredAdditionIds).toEqual([]);
  });

  it("never separates a candidate list header from its first candidate", () => {
    const result = composeBoundedHookContext(
      [
        `Organization policy: ${"authority ".repeat(450)}`,
        "Skills:",
        `- [HIGH MATCH] first ${"detail ".repeat(300)}`,
      ].join("\n"),
    );
    expect(result).toMatch(/Skills:\n- \[HIGH MATCH\]/u);
    expect(result).not.toMatch(/Skills:\n(?:\[Some|$)/u);
  });

  it("never emits a partial exact action when its complete arguments cannot fit", () => {
    const oversizedAction = `HIGH MATCH — required next step: call get_skill with {"slug":"${"s".repeat(4_000)}"} before proceeding.`;
    const omitted = composeBoundedHookContextResult(
      `Organization policy: ${"authority ".repeat(600)}`,
      [{ id: "exact_action", kind: "query_action", text: oversizedAction }],
    );
    expect(omitted.context).not.toContain("required next step");
    expect(omitted.context).not.toContain('{"slug":');
    expect(omitted.context).toContain("omitted");
    expect(omitted.deliveredAdditionIds).toEqual([]);

    const completeAction =
      'HIGH MATCH — required next step: call get_skill with {"slug":"safe"} before proceeding.';
    const retained = composeBoundedHookContextResult(
      `Organization policy: ${"authority ".repeat(600)}`,
      [{ id: "exact_action", kind: "query_action", text: completeAction }],
    );
    expect(retained.context).toContain(completeAction);
    expect(retained.deliveredAdditionIds).toEqual(["exact_action"]);
  });

  it("classifies untyped exact actions and later high-match candidates", () => {
    const action =
      'HIGH MATCH — required next step: call get_skill with {"slug":"safe"} before proceeding.';
    const result = composeBoundedHookContext(
      [
        action,
        "- [HIGH MATCH] primary candidate",
        "- [HIGH MATCH] supporting candidate",
      ].join("\n"),
    );

    expect(result).toContain(action);
    expect(result.indexOf("primary candidate")).toBeLessThan(
      result.indexOf("supporting candidate"),
    );
  });

  it("reclaims unused atomic reservations without splitting required directives", () => {
    const long = "core ".repeat(500);
    const result = composeBoundedHookContext(
      [
        `Organization policy: ${long}`,
        `Authorization requires the exact private action. ${long}`,
        `The unresolved draft remains retained in the outbox. ${long}`,
        `Remembrance credential source: shared config. ${long}`,
        `Before finishing: close the required loops. ${long}`,
        `Query receipt: query_id=rq_budget. ${long}`,
        `- [HIGH MATCH] primary ${long}`,
        `Remembrance user-correction capture: decide whether a reusable correction occurred. ${long}`,
      ].join("\n"),
    );

    expect(result.length).toBeGreaterThan(3_900);
    expect(result.length).toBeLessThanOrEqual(4_000);
    for (const required of [
      "Organization policy",
      "Authorization requires",
      "unresolved draft remains",
      "credential source",
      "Before finishing",
      "Query receipt",
      "[HIGH MATCH]",
      "correction context omitted as one complete directive",
    ]) {
      expect(result).toContain(required);
    }
    expect(result).not.toContain("user-correction capture");
  });

  it("contracts oversized atomic minima without dropping compact class floors", () => {
    const exactAction = `HIGH MATCH — required next step: call get_skill with {"slug":"${"s".repeat(1_350)}"} before proceeding.`;
    const atomicBody = (label, directive) =>
      `${label}: ${directive}. ${`${directive}. `.repeat(18)}`;
    const result = composeBoundedHookContextResult("", [
      {
        kind: "authority",
        text: `Organization policy: ${"required policy. ".repeat(80)}`,
      },
      {
        kind: "consent",
        text: atomicBody(
          "Private egress authorization",
          "Do not retry a host denial through another transport",
        ),
      },
      {
        kind: "retention",
        text: atomicBody(
          "Private learning retention",
          "Never auto-delete an unresolved draft",
        ),
      },
      {
        kind: "credential",
        text: atomicBody(
          "Remembrance credential source",
          "Never change destination or visibility automatically",
        ),
      },
      {
        kind: "completion",
        text: atomicBody(
          "Before finishing",
          "Call inspect_private_learning_outbox for terminal holds",
        ),
      },
      {
        kind: "query_identity",
        text: atomicBody(
          "Query receipt",
          "Preserve query_id rq_proportional and result_id qres_proportional",
        ),
      },
      {
        kind: "candidate_primary",
        text: `- [HIGH MATCH] primary ${"candidate detail. ".repeat(80)}`,
      },
      {
        kind: "correction",
        text: atomicBody(
          "Remembrance user-correction capture",
          "Decide whether a real reusable correction occurred",
        ),
      },
      { kind: "query_action", text: exactAction },
    ]);

    expect(result.context.length).toBeGreaterThanOrEqual(3_980);
    expect(result.context.length).toBeLessThanOrEqual(4_000);
    expect(result.context).toContain(exactAction);
    expect(result.context).toContain(
      "Do not retry a host denial through another transport.",
    );
    expect(result.context).toContain("Never auto-delete an unresolved draft.");
    expect(result.context).toContain(
      "lower-priority Remembrance context was omitted",
    );
  });

  it("keeps private-learning recovery directives whole across the full pressure sweep", () => {
    const recovery = [
      "Private learning recovery: 1 lesson candidate, 1 complete skill candidate, and 1 content-free hold event are due.",
      "Silently call inspect_private_learning_outbox. Submit ready lessons with submit_private_lesson_candidate and ready complete skills with submit_private_skill_candidate. Use the matching retry tool only for a due retry.",
      "Do not retry authorization, policy, validation, safety, or terminal holds through another transport. Never delete an unresolved draft automatically. Hide routine receipts; surface only a concrete failure or required user action.",
    ].join("\n");
    const required = [
      "inspect_private_learning_outbox",
      "submit_private_lesson_candidate",
      "submit_private_skill_candidate",
      "Do not retry authorization, policy, validation, safety, or terminal holds through another transport.",
      "Never delete an unresolved draft automatically.",
    ];
    for (let pressure = 9; pressure <= 200; pressure += 1) {
      const context = [
        `Organization policy: ${"policy ".repeat(pressure)}`,
        "Query receipt: query_id=rq_pressure result_id=qres_pressure.",
        "Private egress authorization: use only the exact approved action and never switch destination or visibility.",
        "An unresolved draft remains retained locally; never auto-delete it.",
        "Remembrance credential source: shared config organization key.",
        ...Array.from(
          { length: Math.min(10, Math.ceil(pressure / 10)) },
          (_, index) =>
            `- [${index === 0 ? "HIGH" : "POSSIBLE"} MATCH] candidate-${index} ${"detail ".repeat(pressure)}`,
        ),
      ].join("\n");
      const result = composeBoundedHookContext(context, [
        { kind: "completion", text: recovery },
      ]);
      expect(result.length, `pressure=${pressure}`).toBeLessThanOrEqual(4_000);
      for (const directive of required) {
        expect(result, `pressure=${pressure}`).toContain(directive);
      }
      expect(result).not.toMatch(
        /Silently call[^\n]*validation, safety, or terminal holds/iu,
      );
    }
  });

  it("round-trips shipped atomic prose without losing dotted tokens", () => {
    const cases = [
      "Do not submit this lesson to any destination the user has not approved, e.g. a public catalog, a partner workspace, or a second organization.",
      "Never route a hold through a second transport, e.g. a direct HTTP call, or another MCP server.",
      "Do not send customer data outside the U.S. region under any circumstance.",
      "Do not run Node.js scripts from an untrusted source.",
      "Never switch transports! Keep the retained draft local.",
      "Remembrance credential source: ~/.config/remembrance/config.json and https://registry.example.com/api/mcp use v0.1.78. Restart the host.",
    ];
    for (const source of cases) {
      expect(completeDirectiveUnits(source).join(" "), source).toBe(source);
    }
  });

  it("allocates the complete canonical correction directive under every required-class floor", () => {
    const repeated = "required guidance. ".repeat(200);
    for (const privateCapture of [false, true]) {
      const directive = userCorrectionCaptureDirectiveText(privateCapture);
      expect(directive).toContain(
        "Decide from the full conversation whether one really occurred",
      );
      expect(directive).toContain("may contain a first-party correction");
      const result = composeBoundedHookContextResult("", [
        {
          kind: "authority",
          text: `Organization policy: ${repeated}`,
        },
        {
          kind: "consent",
          text: `Authorization requires the exact approved action. ${repeated}`,
        },
        {
          kind: "retention",
          text: `Never auto-delete an unresolved draft. ${repeated}`,
        },
        {
          kind: "credential",
          text: `Remembrance credential source: shared config. ${repeated}`,
        },
        { kind: "completion", text: `Before finishing: ${repeated}` },
        {
          kind: "query_identity",
          text: `Query receipt: query_id=rq_budget result_id=qres_budget. ${repeated}`,
        },
        { kind: "notice", text: `Connection notice. ${repeated}` },
        {
          kind: "candidate_primary",
          text: `- [HIGH MATCH] primary ${repeated}`,
        },
        {
          id: `canonical_correction_${privateCapture}`,
          kind: "correction",
          text: directive,
        },
      ]);
      expect(result.context).toContain(directive);
      expect(result.deliveredAdditionIds).toContain(
        `canonical_correction_${privateCapture}`,
      );
      expect(result.context.length).toBeLessThanOrEqual(4_000);
    }
  });

  it("delivers unknown typed additions instead of silently discarding them", () => {
    const result = composeBoundedHookContextResult("base", [
      {
        id: "future_kind",
        kind: "future_context_kind",
        text: "Future context remains visible.",
      },
    ]);
    expect(result.context).toContain("Future context remains visible.");
    expect(result.deliveredAdditionIds).toEqual(["future_kind"]);
  });

  it("bounds optional-only overflow and accepts typed additions without metadata", () => {
    const optionalOnly = composeBoundedHookContext("", [
      { kind: "other", text: "optional ".repeat(1_000) },
    ]);
    expect(optionalOnly.length).toBeLessThanOrEqual(4_000);
    expect(optionalOnly).toContain("lower-priority Remembrance context");

    const untypedObject = composeBoundedHookContext("base", [
      { id: "descriptive-only", text: "additional context" },
      { kind: "notice", text: "notice without an id" },
    ]);
    expect(untypedObject).toContain("additional context");
    expect(untypedObject).toContain("notice without an id");
  });
});

describe("bounded hook sections", () => {
  it("keeps short text and rejects impossible truncation budgets", () => {
    expect(boundedContextSection("  short\r\ntext  ", 20)).toBe("short\ntext");
    expect(boundedContextSection(null, 20)).toBe("");
    expect(boundedContextSection("long", 3)).toBe("");
  });

  it("uses a nearby newline, a nearby space, or a hard cut", () => {
    expect(boundedContextSection(`abc\n${"x".repeat(20)}`, 12)).toBe("abc...");
    expect(boundedContextSection("alpha beta gamma", 13)).toBe("alpha beta...");
    const unbroken = boundedContextSection("x".repeat(200), 100);
    expect(unbroken).toHaveLength(100);
    expect(unbroken.endsWith("...")).toBe(true);
  });

  it("proves directive splitting is linear and rejects the prefix-rescan mutant", () => {
    const source = `${"x".repeat(20_000)}. One. Two. Three. Four.`;
    const units = completeDirectiveUnits(source);

    expect(units).toEqual([
      `${"x".repeat(20_000)}.`,
      "One.",
      "Two.",
      "Three.",
      "Four.",
    ]);

    const measured = [10_000, 20_000].map((boundaryCount) =>
      measureCompleteDirectiveUnitsWorkForTests(
        Array.from({ length: boundaryCount }, () => "A.").join(" "),
      ),
    );
    expect(measured.map((result) => result.unitCount)).toEqual([
      10_000, 20_000,
    ]);
    expect(
      isNearLinearDoubling(measured[0].work.total, measured[1].work.total),
    ).toBe(true);
    expect(measureCompleteDirectiveUnitsWorkForTests("  A.")).toMatchObject({
      unitCount: 1,
      work: { cursorAdvances: 4 },
    });
    expect(
      isNearLinearDoubling(
        legacyPrefixRescanWork(10_000),
        legacyPrefixRescanWork(20_000),
      ),
    ).toBe(false);

    const observed = [2_500, 5_000, 10_000, 20_000].map((length) =>
      observeStringScanWork(() =>
        completeDirectiveUnits(`${"x".repeat(length)}. One. Two. Three. Four.`),
      ),
    );
    for (let index = 1; index < observed.length; index += 1) {
      expect(
        isNearLinearDoubling(observed[index - 1].total, observed[index].total),
      ).toBe(true);
    }
  });

  it("corroborates directive-split linearity in 40 repeatable trials without production work counters", async () => {
    const inputs = [256, 512].map((count) => "A. ".repeat(count).trimEnd());
    const mutant = await importHookPolicyMutation(
      "  const token = line.slice(tokenStart, punctuationEnd);",
      `  const prefix = line.slice(0, punctuationEnd);
  const token = prefix.slice(prefix.search(/\\S+$/u));`,
    );

    const baselines = new Map();
    for (let trial = 0; trial < 40; trial += 1) {
      const implementations = [
        completeDirectiveUnits,
        mutant.completeDirectiveUnits,
      ];
      if (trial % 2) implementations.reverse();
      for (const implementation of implementations) {
        const measured = observePairedStringWork(
          implementation,
          inputs,
          trial % 2 === 1,
        );
        expect(measured.observations.map(({ value }) => value.length)).toEqual([
          256, 512,
        ]);
        if (implementation === completeDirectiveUnits) {
          expect(measured.ratio, `current trial ${trial}`).toBeLessThan(2.8);
        } else {
          expect(measured.ratio, `mutant trial ${trial}`).toBeGreaterThan(3.2);
          expect(
            measured.observations[0].work.searchedCodeUnits,
          ).toBeGreaterThan(0);
        }
        if (baselines.has(implementation)) {
          expect(measured).toEqual(baselines.get(implementation));
        } else {
          baselines.set(implementation, measured);
        }
      }
    }
  }, 15_000);

  it("calibrates observed operations exactly rather than accepting constant work", () => {
    for (const length of [8, 32]) {
      const input = "x".repeat(length);
      const measured = observeStringScanWork(() => [
        input.slice(1),
        input.search(/z/u),
        input.charCodeAt(0),
        /z/u.test(input),
        /z/u.exec(input),
      ]);
      expect(measured).toEqual({
        value: ["x".repeat(length - 1), -1, 120, false, null],
        work: {
          copiedCodeUnits: length - 1,
          searchedCodeUnits: length,
          characterReads: 1,
          regexTestCodeUnits: length,
          regexExecCodeUnits: length * 3,
        },
        total: length * 6,
      });
    }
  });

  it.each(["test", "exec"])(
    "detects repeated full-input regex %s scans without substring copies",
    async (method) => {
      const inputs = [256, 512].map((count) => "A. ".repeat(count).trimEnd());
      const mutant = await importHookPolicyMutation(
        "  const token = line.slice(tokenStart, punctuationEnd);",
        `  if (/Z/u.${method}(line)) throw new Error("unreachable");
  const token = line.slice(tokenStart, punctuationEnd);`,
      );
      for (let trial = 0; trial < 40; trial += 1) {
        const current = observePairedStringWork(
          completeDirectiveUnits,
          inputs,
          trial % 2 === 1,
        );
        const mutated = observePairedStringWork(
          mutant.completeDirectiveUnits,
          inputs,
          trial % 2 === 1,
        );
        expect(current.observations.map(({ value }) => value)).toEqual(
          mutated.observations.map(({ value }) => value),
        );
        expect(current.ratio).toBeLessThan(2.8);
        expect(mutated.ratio).toBeGreaterThan(3.2);
        expect(mutated.observations[0].work.copiedCodeUnits).toEqual(
          current.observations[0].work.copiedCodeUnits,
        );
        expect(mutated.observations[0].work.regexExecCodeUnits).toBeGreaterThan(
          current.observations[0].work.regexExecCodeUnits +
            inputs[0].length * 200,
        );
      }
    },
  );

  it("restores independent work observers when the measured operation throws", () => {
    const original = [
      String.prototype.slice,
      String.prototype.search,
      String.prototype.charCodeAt,
      RegExp.prototype.test,
      RegExp.prototype.exec,
    ];
    expect(() =>
      observeStringScanWork(() => {
        "example".slice(1);
        "example".search(/x/u);
        "example".charCodeAt(0);
        /z/u.test("example");
        /z/u.exec("example");
        throw new Error("probe failed");
      }),
    ).toThrow("probe failed");
    expect([
      String.prototype.slice,
      String.prototype.search,
      String.prototype.charCodeAt,
      RegExp.prototype.test,
      RegExp.prototype.exec,
    ]).toEqual(original);
  });

  it("counts global regex progress without rescanning its already-consumed prefix", () => {
    for (const length of [64, 128]) {
      const input = "x".repeat(length);
      const match = observeStringScanWork(() => input.match(/x/gu));
      const split = observeStringScanWork(() => input.split(/z/u));
      const test = observeStringScanWork(() => {
        const pattern = /x/gu;
        let count = 0;
        while (pattern.test(input)) count += 1;
        return count;
      });
      expect(match.value).toHaveLength(length);
      expect(split.value).toEqual([input]);
      expect(split.work.regexExecCodeUnits).toBe(length);
      expect(test.value).toBe(length);
      expect(match.work.regexExecCodeUnits).toBe(length + 1);
      expect(test.work.regexExecCodeUnits).toBe(length + 1);
      expect(test.work.regexTestCodeUnits).toBe(0);
    }
  });

  it("does not let unrelated linear work mask a quadratic operation category", () => {
    const measured = observePairedStringWork(
      (input) => {
        for (let index = 0; index < 1_000; index += 1) input.slice(0);
        for (let outer = 0; outer < input.length; outer += 1) {
          for (let inner = 0; inner < input.length; inner += 1)
            input.charCodeAt(inner);
        }
        return input.length;
      },
      ["x".repeat(8), "x".repeat(16)],
    );
    expect(measured.totalRatio).toBeLessThan(2.8);
    expect(measured.workRatios.characterReads).toBe(4);
    expect(measured.ratio).toBeGreaterThan(3.2);
  });
});
describe("first-party correction detection", () => {
  const directCorrections = [
    "That approach is wrong.",
    "No, that's wrong.",
    "No, that’s wrong.",
    "Actually, please do this differently.",
    "You missed the actual requirement.",
    "This is not what I asked.",
    "You broke the build.",
    "I already asked you not to do that.",
    "I do not agree with this direction.",
    "Please revert that implementation.",
    "I said use the org runbook; you used the default.",
    "Actually, use the org runbook instead.",
    "The setup is fine. Wait, you overlooked the edge case.",
    "To be clear, this is not what I asked for.",
    "That change broke the build.",
    "This latest patch regressed the flow.",
    "My latest correction: use the durable queue instead.",
    "My correction: use the durable queue instead.",
    "Our actual correction: the queue should survive restarts.",
  ];

  const frozenPairBodies = [
    "revert that change",
    "you missed the requirement about the response shape",
    "this is the wrong approach",
    "this is not what I asked for",
    "you broke the build",
    "I already asked you not to add that",
    "I do not agree with this direction",
    "please do this differently",
    "As I said, that approach is wrong",
    "I already told you, that approach is wrong",
    "you keep missing the requirement",
    "we overlooked the edge case",
    "please use a different approach",
    "I asked you to avoid that",
    "actually, use the safer path instead",
    "that implementation is overcomplicated",
  ];

  const durableOptOuts = [
    "Do not save a lesson from this.",
    "Please forget all of this.",
    "Do not retain this as a lesson.",
    "This is one time only.",
    "This is just an example.",
    "Don't add this to memory.",
    "Please refrain from learning from this.",
    "Nothing here should be retained.",
    "This is for this task only.",
    "Do not preserve this as a skill.",
    "Do not turn this into a lesson.",
    "This must not become a lesson.",
    "This is not for Remembrance.",
    "Do not derive a lesson from this.",
    "Leave this out of memory.",
    "Please keep this off shared memory.",
    "I would prefer this not be remembered.",
    "I would rather this not be saved.",
    "I prefer not to have this recorded.",
    "I do not consent to this being remembered.",
    "I do not want this saved as a lesson.",
    "I do not want this learned.",
    "I would prefer you not capture this.",
    "This should stay out of shared memory.",
    "I'd prefer this stay out of memory.",
    "We'd rather not turn this into a lesson.",
    "Please keep this from being remembered.",
    "Do not include this conversation in future guidance.",
    "Do not reuse anything from this conversation later.",
    "Please exclude this conversation from future guidance.",
    "Never mind.",
    "Never mind the prior test where you missed the actual requirement.",
    "Not a correction.",
    "This is a one-off.",
    ...correctionNoNeedControls,
  ];

  const attributed = [
    "Claude said you missed the requirement.",
    "The logs say you missed the requirement.",
    "My teammates say you broke the build.",
    "The reviewers think that approach is wrong.",
    "According to the reviewer, you broke the build.",
    "Per the reviewer, that approach is wrong.",
    "Customer email: that approach is wrong.",
    "Feedback from the beta group: you missed the actual requirement.",
    "In the linked issue: you broke the build.",
    "Ticket JIRA-42: that design is overkill.",
    "The support thread - that approach is wrong.",
    "Per compliance, that implementation is overcomplicated.",
    "I heard QA reported you broke the build.",
    "I think Claude says you missed the requirement.",
    "From the reviewer: you missed the requirement.",
    "Claude feedback: you missed the requirement.",
    "External review: you missed the requirement.",
    "Alice: You broke the build.",
    "Bob: You broke the build.",
    "QA: You broke the build.",
    "Dr Smith: You broke the build.",
    "SRE lead: You broke the build.",
    "Release manager: You missed the requirement.",
    "Jane Doe: You broke the build.",
    "CI output says: Use the durable queue instead.",
    "The linter warns: You broke the build.",
    "Their runbook says: Use the durable queue instead.",
    "Her test plan requires: Use the durable queue instead.",
    "Here is Claude feedback: You broke the build.",
    "Copied from the issue: You broke the build.",
    "Summary from Claude: You broke the build.",
    "A user wrote: Use the durable queue instead.",
    "A user writes: Use the durable queue instead.",
    "The plan says: Use the durable queue instead.",
    "She thinks you broke the build.",
    "The console transcript reads: You broke the build.",
    "The terminal printed: You broke the build.",
    "The build transcript contains: You broke the build.",
    "The failing assertion reads: You broke the build.",
  ];

  const firstPartyLabels = [
    "Feedback from me: you missed the actual requirement.",
    "Feedback from us: you missed the actual requirement.",
    "Feedback from myself: you missed the actual requirement.",
    "The issue: you missed the actual requirement.",
    "The issue - you missed the actual requirement.",
    "In review: you missed the actual requirement.",
    "Security: you missed the actual requirement.",
    "Reliability: you missed the actual requirement.",
    "Client-side - you missed the actual requirement.",
    "Client API: you missed the actual requirement.",
    "Implementation detail: you missed the actual requirement.",
    "Per the plan we agreed on, you missed the actual requirement.",
    "Per the agreed plan, you missed the actual requirement.",
    "According to our agreed plan, you missed the actual requirement.",
    "From my review: you missed the actual requirement.",
    "According to our internal review, you missed the actual requirement.",
    "From our security finding: you missed the actual requirement.",
    "Per my implementation notes, use the durable queue instead.",
    "Per the requirements I wrote, you missed the actual requirement.",
    "According to the plan I wrote, use the durable queue instead.",
    "My runbook says: use the durable queue instead.",
    "My test plan requires: use the durable queue instead.",
  ];

  const transformations = [
    "Summary: You missed the requirement. You broke the build.",
    "Translation: This is not what I asked.",
    "Please translate: You missed the requirement.",
    "Summarize this: You broke the build.",
    "Write a commit message: You missed the requirement.",
    "Use this to prepare a PR comment: You broke the build.",
    "Use this for drafting a commit message: You broke the build.",
    "Make this a commit message: You broke the build.",
    "I need you to summarize: You broke the build.",
    "We need you to condense: You missed the requirement.",
    "I am asking you to condense the following feedback: You broke the build.",
    "Turn this into a concise note: You missed the requirement.",
    "Give me a summary of this feedback: You broke the build.",
    "Formulate this as a PR comment: You broke the build.",
    "Paste this in the review: You broke the build.",
    "Suggested commit message: You broke the build.",
    "Please turn this into a commit message: You broke the build.",
  ];

  const openEndedRecallAndPrecisionCorpus = [
    { expected: true, prompt: "My note: you missed the actual requirement." },
    {
      expected: true,
      prompt: "My deployment caveat - you missed the actual requirement.",
    },
    { expected: true, prompt: "One more thing: you broke the build." },
    {
      expected: true,
      prompt: "Another operational wrinkle \u2014 you broke the build.",
    },
    { expected: true, prompt: "Context: this isn't what I asked for." },
    {
      expected: true,
      prompt: "Important compatibility concern - you broke the build.",
    },
    {
      expected: true,
      prompt: "Per my earlier message, that approach is wrong.",
    },
    {
      expected: true,
      prompt: "According to our latest discussion - you missed the constraint.",
    },
    {
      expected: true,
      prompt: "From my deployment checklist: use the durable queue instead.",
    },
    {
      expected: true,
      prompt: "Also, My operational nuance: you missed the requirement.",
    },
    {
      expected: true,
      prompt: "Sorry, but One final requirement - you broke the build.",
    },
    {
      expected: true,
      prompt: "Separately, Context: this is not what I asked for.",
    },
    {
      expected: true,
      prompt: "Build-system caveat: you broke the build.",
    },
    { expected: false, prompt: "Customer email, that design is wrong." },
    {
      expected: false,
      prompt: "In the linked issue, you broke the build.",
    },
    {
      expected: false,
      prompt: "Also, Claude feedback, you missed the requirement.",
    },
    { expected: false, prompt: "Alice, you broke the build." },
    { expected: false, prompt: "Jane Doe, you broke the build." },
    { expected: false, prompt: "Release manager, you broke the build." },
    {
      expected: false,
      prompt: "Per my reviewer, you missed the actual requirement.",
    },
    {
      expected: false,
      prompt: "According to our auditors, you broke the build.",
    },
    {
      expected: false,
      prompt: "The requirements state that you missed the constraint.",
    },
    {
      expected: false,
      prompt: "Requirements say that you missed the requirement.",
    },
    { expected: false, prompt: "The reports claim you broke the build." },
    {
      expected: false,
      prompt: "Runbooks specify that you missed the requirement.",
    },
    { expected: false, prompt: "The logs show you broke the build." },
    {
      expected: false,
      prompt: "Documents indicate that approach is wrong.",
    },
    {
      expected: false,
      prompt: "Tests report that you missed the requirement.",
    },
    {
      expected: false,
      prompt: "Instructions require you to use the durable queue instead.",
    },
    {
      expected: false,
      prompt: "Please summarize: My note: you missed the requirement.",
    },
    {
      expected: false,
      prompt: "Claude feedback, My note: you broke the build.",
    },
    { expected: false, prompt: "My friend, you broke the build." },
    {
      expected: false,
      prompt: "My boss\u2019s note: you missed the requirement.",
    },
    { expected: false, prompt: "My terminal output: you broke the build." },
    { expected: false, prompt: "Customer note: you broke the build." },
    {
      expected: false,
      prompt: "Security audit note: you missed the requirement.",
    },
    {
      expected: false,
      prompt: "Commit message: that approach is overkill.",
    },
    {
      expected: false,
      prompt: "Spanish translation: you missed the actual requirement.",
    },
    {
      expected: false,
      prompt: "Suggested PR comment: use the durable queue instead.",
    },
    {
      expected: false,
      prompt: "Shared by QA: use the durable queue instead.",
    },
    {
      expected: false,
      prompt: "Per my architect\u2019s review, you missed the requirement.",
    },
    {
      expected: false,
      prompt: "Customer-provided note: you broke the build.",
    },
    {
      expected: false,
      prompt: "Reviewer-authored caveat: you missed the requirement.",
    },
    {
      expected: false,
      prompt: "My director\u2019s note: you broke the build.",
    },
    {
      expected: false,
      prompt: "My attorney, you missed the constraint.",
    },
  ];

  it.each(directCorrections)(
    "recognizes a high-precision correction: %s",
    (prompt) => {
      expect(promptContainsFirstPartyCorrection(prompt)).toBe(true);
    },
  );

  it("preserves the frozen 16x16 monotonicity corpus", () => {
    const tails = [
      "Claude said that approach is wrong",
      "the reviewer thinks that approach is wrong",
      "QA reported you broke the build",
    ];
    let asserted = 0;
    for (const first of frozenPairBodies) {
      expect(promptContainsFirstPartyCorrection(first + "."), first).toBe(true);
      asserted += 1;
      for (const second of frozenPairBodies) {
        const prompt = first + ", " + second + ".";
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
        asserted += 1;
      }
      for (const tail of tails) {
        const prompt = first + ", " + tail + ".";
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
        asserted += 1;
      }
    }
    expect(asserted).toBe(320);
  });

  it("keeps neutral lead-ins and first-party labels eligible", () => {
    for (const lead of [
      "Also, ",
      "Sorry, but ",
      "Quick note: ",
      "Hmm, ",
      "To be clear, ",
      "Right, ",
      "Once more: ",
      "For practical purposes, ",
    ]) {
      for (const body of frozenPairBodies.slice(0, 8)) {
        const prompt = lead + body + ".";
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
      }
    }
    for (const prompt of firstPartyLabels) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
      expect(
        promptContainsFirstPartyCorrection("Also, " + prompt),
        "Also, " + prompt,
      ).toBe(true);
    }
  });

  it("holds open-ended correction recall and attribution precision together", () => {
    const observed = { recall: 0, precision: 0 };
    for (const { expected, prompt } of openEndedRecallAndPrecisionCorpus) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
      observed[expected ? "recall" : "precision"] += 1;
    }
    expect(observed).toEqual({ recall: 13, precision: 32 });
  });

  it("pins source attribution and corrective clauses in one contrast corpus", () => {
    const observed = { recall: 0, precision: 0 };
    const failures = [];
    for (const { id, prompt, expected } of correctionContrastCorpus) {
      if (promptContainsFirstPartyCorrection(prompt) !== expected) {
        failures.push({ id, prompt, expected });
      }
    }
    for (const { expected } of correctionLegacyContrastCorpus) {
      observed[expected ? "recall" : "precision"] += 1;
    }
    expect(failures.slice(0, 12)).toEqual([]);
    expect(observed).toEqual({ recall: 16, precision: 28 });
  });

  it("crosses every frozen seed with reporting, wrapper, and control axes", () => {
    expect(correctionReportedRegressionCases).toHaveLength(26);
    expect(Object.isFrozen(correctionReportedRegressionCases)).toBe(true);
    expect(correctionContrastSeeds).toHaveLength(16);
    expect(correctionContrastSeeds.every(Object.isFrozen)).toBe(true);
    expect(correctionGeneratedContrastCorpus.every(Object.isFrozen)).toBe(true);
    const ids = new Set(correctionGeneratedContrastCorpus.map(({ id }) => id));
    expect(ids.size).toBe(correctionGeneratedContrastCorpus.length);
    for (const seed of correctionContrastSeeds) {
      for (const subject of correctionReportingSubjects) {
        for (const verb of correctionReportingVerbs) {
          expect(ids.has(`reported-body/${seed.id}/${subject}/${verb}`)).toBe(
            true,
          );
          expect(ids.has(`reported-label/${seed.id}/${subject}/${verb}`)).toBe(
            true,
          );
        }
      }
      const axes = new Set(
        correctionGeneratedContrastCorpus
          .filter(({ seedId }) => seedId === seed.id)
          .map(({ axis }) => axis),
      );
      for (const axis of [
        "bare-body",
        "wrapped-label",
        "wrapped-body",
        "nested-wrapper",
        "embedded-adoption",
        "embedded-current",
        "persistent-source",
        "independent-adoption",
        "independent-before-source",
        "retraction-before",
        "retraction-after",
        "scoped-reference-before",
        "scoped-reference-after",
        "withdraw-current-claim",
        "withdraw-then-independent",
        "withdraw-only-latest",
        "reported-opt-out",
        "authorial-opt-out",
        "quoted-opt-out",
        "no-need-authorial-opt-out",
        "no-need-reported-opt-out",
        "no-need-quoted-opt-out",
      ])
        expect(axes.has(axis), `${seed.id}/${axis}`).toBe(true);
      expect(axes.has("external-heading")).toBe(Boolean(seed.label));
    }
  });

  it("keeps nested ownership distinct from independent authorial adoption", () => {
    const cases = [
      [
        false,
        "Reminder: The reviewer mentioned you're solving the wrong problem.",
      ],
      [false, "My note: The reviewer said you broke the build."],
      [false, "Correction: The reviewer said you broke the build."],
      [
        false,
        "Reminder: Summarize the following: you keep ignoring the constraint.",
      ],
      [
        false,
        "Summarize this feedback. Reminder: you keep ignoring the constraint.",
      ],
      [false, "Translate this: My current correction: you misread the spec."],
      [false, "Translate this: I agree: you misread the spec."],
      [false, "The reviewer said that I agree: you misread the spec."],
      [
        false,
        'The reviewer said "you broke the build" and you misread the spec.',
      ],
      [
        false,
        "The reviewer said that my assessment is that you misread the spec.",
      ],
      [false, "I agree: the reviewer said you keep ignoring the constraint."],
      [false, "Earlier, the reviewer said you broke the build."],
      [false, "I thought the reviewer said you broke the build."],
      [false, "I said the reviewer mentioned you broke the build."],
      [false, "For context, the reviewer said you broke the build."],
      [
        false,
        "It was mentioned by a teammate that you're solving the wrong problem.",
      ],
      [false, "You're solving the wrong problem, according to the reviewer."],
      [false, "You're solving the wrong problem according to the reviewer."],
      [false, "You're solving the wrong problem, as the reviewer said."],
      [false, "The reviewer denied saying you're solving the wrong problem."],
      [false, "The reviewer said this is still broken: never mind."],
      [false, "Translate this: never mind: this is still broken."],
      [false, "Customer Reminder: you keep ignoring the constraint."],
      [false, "Customer reminder: you keep ignoring the constraint."],
      [false, "## Customer reminder: you keep ignoring the constraint."],
      [false, "- The reviewer mentioned you keep ignoring the constraint."],
      [
        false,
        "Concurrency boundary: if you missed the actual requirement, fix it.",
      ],
      [false, "It is not true that you misread the spec."],
      [false, "I never said you're solving the wrong problem."],
      [
        true,
        "The reviewer said the first result was wrong, but you missed the actual requirement.",
      ],
      [true, "The reviewer said it was wrong; I agree: you misread the spec."],
      [
        true,
        'The reviewer said "you broke the build" and I agree: you misread the spec.',
      ],
      [
        true,
        'The reviewer said "You broke the build." I agree: you missed the requirement.',
      ],
      [
        true,
        'The reviewer said \\"You broke the build.\\" I agree: you missed the requirement.',
      ],
      [
        true,
        "You misread the spec; the reviewer said you deleted the wrong file.",
      ],
      [true, "You broke the build, the reviewer said do not capture this."],
      [
        true,
        "Translate this: you misread the spec. My current correction: use the durable queue instead.",
      ],
      [
        true,
        "It is not true that you misread the spec. Separately, you broke the build.",
      ],
      [
        true,
        "You broke the build. The reviewer said this is still broken: never mind.",
      ],
      [true, "Security: you keep ignoring the constraint."],
      [true, "Client-side - you keep ignoring the constraint."],
      [true, "Customer-facing: you keep ignoring the constraint."],
      [true, "My runbook says: use the durable queue instead."],
      [false, "My manager said: use the durable queue instead."],
    ];
    for (const [expected, prompt] of cases) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("withdraws the identified current claim without erasing unrelated corrections", () => {
    for (const [expected, prompt] of [
      [false, "You broke the build. I retract that statement."],
      [false, "You misunderstood my request. I take that back."],
      [false, "You misread the spec. I retract only the spec claim."],
      [true, "You broke the build. I retract only the spec claim."],
      [
        true,
        "You broke the build. You misread the spec. I retract only the spec claim.",
      ],
      [
        true,
        "You broke the build. I retract that statement. Separately, you misread the spec.",
      ],
      [
        true,
        "Never mind the old feedback. My current correction: use the durable queue instead.",
      ],
      [
        true,
        "Never mind the prior test; however, you missed the actual requirement.",
      ],
      [
        false,
        "Never mind the prior test where you missed the actual requirement.",
      ],
      [
        true,
        "Ignore the earlier file. Reminder: you keep ignoring the constraint.",
      ],
      [true, "Do not disregard that. You broke the build."],
      [true, "Ignore the cache instead. You broke the build."],
      [true, '"Never mind: this is still broken." You misread the spec.'],
      [false, "Scratch that. Speaking for myself now: you misread the spec."],
      [false, "You broke the build: never mind."],
      [false, "You broke the build - ignore that."],
      [false, "I thought you broke the build after reviewing it."],
      [
        true,
        "I believed that approach was wrong; separately, you broke the build.",
      ],
      [true, "I believed that approach was wrong. You broke the build."],
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("keeps novel corrective clauses inert inside source and transformation wrappers", () => {
    const wrappers = [
      (text) => JSON.stringify(text),
      (text) => `> ${text}`,
      (text) => `\x60\x60\x60text\n${text}\n\x60\x60\x60`,
      (text) => `Translate to Spanish: ${text}`,
      (text) => `Summarize the following: ${text}`,
      (text) => `Proposed commit message: ${text}`,
      (text) => `The API spec says: ${text}`,
      (text) => `Slack thread: ${text}`,
      (text) => `${text} Do not capture a lesson from this.`,
    ];
    for (const prompt of [
      ...correctionRecallCases,
      ...correctionUnlistedHeadingCases,
    ]) {
      for (const wrap of wrappers) {
        expect(
          promptContainsFirstPartyCorrection(wrap(prompt)),
          wrap(prompt),
        ).toBe(false);
      }
    }
  });

  it("does not make unlisted heading recall depend on an authorial allowlist", async () => {
    const withoutAuthorialLabels = await importHookPolicyMutation(
      "function correctionFirstPartyLabelAtStart(text) {",
      "function correctionFirstPartyLabelAtStart(text) { return null;",
    );
    for (const prompt of correctionUnlistedHeadingCases) {
      expect(
        withoutAuthorialLabels.promptContainsFirstPartyCorrection(prompt),
        prompt,
      ).toBe(true);
    }
  });

  it("gives every explicit durable opt-out absolute prompt precedence", () => {
    for (const optOut of durableOptOuts) {
      for (const prompt of [
        optOut + " You broke the build.",
        "You broke the build. " + optOut,
        optOut + "\nYou missed the actual requirement.",
        "You missed the actual requirement.\r\n" + optOut,
      ]) {
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      }
    }
  });

  it("keeps durable control ownership across neutral lead-ins and headings", () => {
    const failures = [];
    let checked = 0;
    const leadIns = [
      "",
      "Also, ",
      "Sorry, but ",
      "Quick note: ",
      "No, ",
      "For clarity, ",
    ];
    for (const optOut of durableOptOuts) {
      for (const lead of leadIns) {
        for (const heading of ["", "My note: ", "Reminder: "]) {
          const control = `${lead}${heading}${optOut}`;
          const cases = [
            [false, `${control} You broke the build.`],
            [false, `You broke the build. ${control}`],
            [
              true,
              `The reviewer said ${control} Speaking for myself now: you broke the build.`,
            ],
            [true, `You broke the build. The reviewer said ${control}`],
            [true, `${JSON.stringify(control)} You broke the build.`],
            [true, `You broke the build. ${JSON.stringify(control)}`],
          ];
          for (const [expected, prompt] of cases) {
            checked += 1;
            if (promptContainsFirstPartyCorrection(prompt) !== expected) {
              failures.push({ prompt, expected });
            }
          }
        }
      }
    }
    expect(checked).toBe(4_104);
    expect(failures.slice(0, 12)).toEqual([]);
  });

  it("does not broaden durable opt-outs into ordinary task instructions", () => {
    for (const prompt of [
      "Do not include this test in the next batch. You broke the build.",
      "Do not include this optional dependency. You broke the build.",
      "Please include this conversation in future guidance. You broke the build.",
      "Do not forget this correction. You broke the build.",
      "Please avoid learning algorithms. You broke the build.",
      "Please refrain from changing this. You broke the build.",
      "Keep this off the deployment. You broke the build.",
      "Never mind about the earlier file. You missed the actual requirement.",
      "Never mind the old feedback. My current correction: use the durable queue instead.",
      "Never mind the prior test; however, you missed the actual requirement.",
      "I do not consent to this deployment. You broke the build.",
      "I do not want this file saved to disk. You broke the build.",
      "Please exclude this test from the next batch. You broke the build.",
      "Do not turn this into a commit message. You broke the build.",
      "Please turn this feature back on. You broke the build.",
      "I do not want this deployed. You broke the build.",
      "I would prefer you not change this. You broke the build.",
      "This should stay out of the deployment. You broke the build.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
    }
  });

  it("suppresses explicit attribution and transformation payloads", () => {
    for (const prompt of [...attributed, ...transformations]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
    for (const prompt of [
      "Claude feedback: You missed the requirement. You broke the build.",
      "Review feedback: You missed the requirement.\n\nYou broke the build.",
      "I need you to summarize: You broke the build. You missed the requirement.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
  });

  it("recovers only through an explicit first-party adoption or current pivot", () => {
    for (const prompt of [
      "Claude said that approach is wrong, and I agree: you broke the build.",
      "Claude said the first result was wrong, but you missed the actual requirement.",
      "Review feedback: You missed the requirement. I disagree: you broke the build.",
      "Alice: You broke the build. My assessment: You overlooked the edge case.",
      "I need you to summarize: You broke the build. My current correction: use the durable queue instead.",
      "From the reviewer: You broke the build. Speaking for myself now: you missed the requirement.",
      "Also, Speaking for myself: use the durable queue instead.",
      "The following is from Claude: You broke the build. In my view: you missed the requirement.",
      "Claude said use stale. I explicitly adopt this: Use the durable queue instead.",
      "Claude said use stale. This is also my view: Use the durable queue instead.",
      "Claude said use stale. I own this correction: Use the durable queue instead.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
    }
    expect(
      promptContainsFirstPartyCorrection(
        "Claude feedback: You broke the build. Separately: you missed the actual requirement.",
      ),
    ).toBe(true);
  });

  it("preserves adversative boundaries with trailing commas in legacy recall", () => {
    // The first eight frozen bodies are the release gate's legacy recall cases.
    for (const body of frozenPairBodies.slice(0, 8)) {
      for (const pivot of ["however,", "however ,", "but,", "yet,"]) {
        const prompt = `The earlier note was quoted; ${pivot} ${body}.`;
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
      }
    }
    for (const prompt of [
      "Translate the following: however, you broke the build.",
      "The earlier note was quoted; however, the reviewer said you broke the build.",
      "The earlier note was quoted; however, if you broke the build, fix it.",
      "The earlier note was quoted; however, you broke the build, according to the reviewer.",
      "The earlier note was quoted; however, never mind: you broke the build.",
      "The earlier note was quoted; however, you broke the build. Do not capture a lesson from this.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
  });

  it("suppresses high-confidence hypotheticals while preserving later direct prose", () => {
    const hypothetical = [
      "If you broke the build, fix it.",
      "If\nYou broke the build, fix it.",
      "If\r\nYou broke the build, fix it.",
      "Assuming that change broke the build, roll it back.",
      "Suppose you missed the requirement, what would you do?",
      "Provided this latest patch broke the flow, revert it.",
      "My current correction: if you broke the build, fix it.",
    ];
    for (const prompt of hypothetical) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      const recovered = prompt + " I agree: You overlooked the edge case.";
      expect(promptContainsFirstPartyCorrection(recovered), recovered).toBe(
        true,
      );
    }
    expect(
      promptContainsFirstPartyCorrection(
        "If the cache is cold.\nYou broke the build.",
      ),
    ).toBe(true);
  });

  it("treats bounded historical claims as pending until resolved", () => {
    for (const prompt of [
      "I thought this was not what I asked for; after reviewing it, it is.",
      "I believed that approach was wrong. Looking again, it was right.",
      "Earlier I thought you broke the build, but the result shows you did not.",
      "I said you missed the requirement. I retract that statement.",
      "I previously believed we should use the stale queue instead, but that was mistaken.",
      "I claimed you missed the requirement; I take that back.",
      "My earlier view was that this was wrong, but that view was mistaken.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
    for (const prompt of [
      "I believed that approach was wrong.",
      "I said you missed the requirement.",
      "I believed that approach was wrong. The result remains ambiguous.",
      "I believed that approach was wrong. Looking again is still pending.",
      "I believed that approach was wrong. Looking again, it was right. Separately, you broke the build.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
    }
  });

  it("masks fenced, inline, indented, and quoted content", () => {
    const tick = String.fromCharCode(96);
    const fenced = [
      tick.repeat(3) + "\nYou broke the build.\n" + tick.repeat(3),
      "~~~js\nYou broke the build.\n~~~",
      "   " +
        tick.repeat(4) +
        "lang\r\nYou broke the build.\r\n" +
        tick.repeat(4),
    ];
    for (const prompt of fenced) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      expect(
        promptContainsFirstPartyCorrection(
          prompt + "\nYou missed the requirement.",
        ),
        prompt,
      ).toBe(true);
    }

    for (const width of [1, 2, 5, 33]) {
      const delimiter = tick.repeat(width);
      const prompt = delimiter + "You broke the build." + delimiter;
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      expect(
        promptContainsFirstPartyCorrection(
          prompt + " You missed the actual requirement.",
        ),
        prompt,
      ).toBe(true);
    }

    for (const prompt of [
      "    You broke the build.",
      "\tYou broke the build.",
      '"You broke the build."',
      "\u201cYou broke the build.\u201d",
      "\u00abYou broke the build.\u00bb",
      "\u300cYou broke the build.\u300d",
      "'Outer 'You broke the build.' quote.'",
      "'Don't report: You broke the build.'",
      '\\"You broke the build.\\"',
      "'''You broke the build.'''",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }

    const unmatched = tick + "literal marker You broke the build.";
    expect(promptContainsFirstPartyCorrection(unmatched)).toBe(true);
    expect(
      promptContainsFirstPartyCorrection(
        '"Unclosed quote masks this: You broke the build.\n\nYou missed the actual requirement.',
      ),
    ).toBe(true);
    expect(
      promptContainsFirstPartyCorrection(
        tick + "x".repeat(9_000) + " You broke the build.",
      ),
    ).toBe(false);
  });

  it("keeps structural recovery and explicit opt-outs deterministic", () => {
    const tick = String.fromCharCode(96);
    for (const prompt of [
      tick.repeat(3) + "\nYou broke the build.\n~~~",
      tick.repeat(4) + "\nYou broke the build.\n" + tick.repeat(3),
      tick.repeat(3) +
        "\nYou broke the build.\n" +
        tick.repeat(3) +
        " trailing",
      "    harmless\n    You broke the build.",
      " \tYou broke the build.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }

    for (const prompt of [
      '\\"You broke the build.',
      '\\"You broke the build.\ncontinued\\"',
      "Path C:\\temp; You broke the build.",
      'word"You broke the build.',
      'You broke the build. "',
      "You broke the build.'",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
    }
    expect(promptContainsFirstPartyCorrection("'You broke the build.'")).toBe(
      false,
    );

    for (const prompt of [
      "Never mind about capture. You broke the build.",
      "Do not use this correction in future guidance. You broke the build.",
      "My current correction: Summary: ordinary neutral words.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
    expect(measureFirstPartyWrapperScanWorkForTests().detected).toBe(false);
    expect(
      promptContainsFirstPartyCorrection(
        "Traceback (most recent call last):\n at worker: You broke the build.",
      ),
    ).toBe(false);
  });

  it("masks blockquotes with CommonMark interruption recovery", () => {
    const interrupts = [
      "# Direct correction",
      "---",
      "***",
      "_ _ _",
      "- Item",
      "+ Item",
      "* Item",
      "1. Item",
      "1) Item",
    ];
    for (const newline of ["\n", "\r\n"]) {
      for (const interrupt of interrupts) {
        const prompt = [
          "> Quoted feedback:",
          interrupt,
          "You broke the build.",
        ].join(newline);
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
      }
      for (const continuation of [
        "--",
        "---x",
        "    ---",
        "-Item",
        "1x Item",
        "1.Item",
        "1.",
        "2. Item",
      ]) {
        const prompt = [
          "> Quoted feedback:",
          continuation,
          "You broke the build.",
        ].join(newline);
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      }
    }
    expect(promptContainsFirstPartyCorrection("> You broke the build.")).toBe(
      false,
    );
    expect(
      promptContainsFirstPartyCorrection("  >\n\nYou broke the build."),
    ).toBe(true);
  });

  it("masks machine and host notification content", () => {
    for (const prompt of [
      "stderr: You missed the requirement.",
      "stdout - You broke the build.",
      "CI/CD failure: That approach is wrong.",
      "Traceback (most recent call last):\n    at worker: You broke the build.",
      "Traceback (most recent call last):\nworker says you broke the build.",
      "<hook_prompt>You broke the build.</hook_prompt>",
      "<subagent_notification>\nYou missed the requirement.\n</subagent_notification>",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
    expect(
      promptContainsFirstPartyCorrection(
        "stderr: You missed the requirement.\n\nYou broke the build.",
      ),
    ).toBe(true);
    expect(
      promptContainsFirstPartyCorrection(
        "<hook_prompt>\nYou broke the build.\n</hook_prompt>\nYou missed the actual requirement.",
      ),
    ).toBe(true);
    expect(
      promptContainsFirstPartyCorrection("You broke the build.", {
        hostNotification: true,
      }),
    ).toBe(false);
  });

  it("normalizes compatibility forms and keeps ordinary conversation quiet", () => {
    for (const prompt of [
      "Ｍｙ ｌａｔｅｓｔ ｃｏｒｒｅｃｔｉｏｎ： ｕｓｅ ｔｈｅ ｄｕｒａｂｌｅ ｑｕｅｕｅ ｉｎｓｔｅａｄ．",
      "Ｔｈａｔ ｎｅｗ ｃｈａｎｇｅ ｂｒｏｋｅ ｔｈｅ ｂｕｉｌｄ．",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
    }
    for (const prompt of [
      "",
      "wrong",
      "Please open the next file.",
      "This is what I asked for, thanks.",
      "That was what I requested.",
      "This is not wrong.",
      "That approach is not incorrect.",
      "Never gonna happen.",
      "Never mind, let's move on to the next file.",
      "The tests always fail on CI when the cache is cold.",
    ]) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    }
    expect(promptContainsFirstPartyCorrection()).toBe(false);
  });

  it("retains bounded matching across window boundaries", () => {
    const crossing =
      "x".repeat(7_700) + " use " + "a".repeat(400) + " instead.";
    expect(promptContainsFirstPartyCorrection(crossing)).toBe(true);
    const beyondBound =
      "x".repeat(7_700) + " use " + "a".repeat(700) + " instead.";
    expect(promptContainsFirstPartyCorrection(beyondBound)).toBe(false);
  });

  it("retains provenance and reversible candidate identity across overlapping windows", () => {
    const filler = "ordinary detail ".repeat(650);
    for (const prefix of ["If ", "I never said ", "The reviewer mentioned "]) {
      const suppressed = `${prefix}${filler}you broke the build.`;
      expect(promptContainsFirstPartyCorrection(suppressed), prefix).toBe(
        false,
      );
      expect(
        promptContainsFirstPartyCorrection(
          `${suppressed} My current correction: you misread the spec.`,
        ),
        prefix,
      ).toBe(true);
    }
    for (const space of [" ", "   ", "\t"]) {
      const repeatedWindow = `${"x".repeat(7900)}${space}you${space}broke${space}the${space}build${space}${"neutral ".repeat(90)}.`;
      expect(promptContainsFirstPartyCorrection(repeatedWindow)).toBe(true);
      expect(
        promptContainsFirstPartyCorrection(
          `${repeatedWindow} I retract that statement.`,
        ),
      ).toBe(false);
      expect(
        promptContainsFirstPartyCorrection(
          `You misread the spec. ${repeatedWindow} I retract that statement.`,
        ),
      ).toBe(true);
    }
    expect(
      promptContainsFirstPartyCorrection(
        "You broke the build; you misread the spec; I retract only the spec claim.",
      ),
    ).toBe(true);
  });

  it("keeps work linear with bounded retained state", () => {
    const source = (count) =>
      Array.from({ length: count }, (_, index) =>
        index % 5 === 0
          ? "Claude said you broke the build. "
          : "ordinary implementation detail. ",
      ).join("") + "I agree: You missed the actual requirement.";
    const counts = [128, 256, 512, 1024];
    const measured = counts.map((count) =>
      measureFirstPartyWrapperScanWorkForTests(source(count)),
    );
    for (const result of measured) expect(result.detected).toBe(true);
    for (let index = 1; index < measured.length; index += 1) {
      expect(measured[index].work.total).toBeLessThan(
        measured[index - 1].work.total * 2.25 + 512,
      );
    }

    const observed = counts.map((count) =>
      observeStringScanWork(() =>
        promptContainsFirstPartyCorrection(source(count)),
      ),
    );
    for (const result of observed) expect(result.value).toBe(true);
    for (let index = 1; index < observed.length; index += 1) {
      expect(
        isNearLinearDoubling(observed[index - 1].total, observed[index].total),
      ).toBe(true);
    }
  });

  it("corroborates first-party wrapper linearity in 40 repeatable trials without production work counters", async () => {
    const inputs = [128, 256].map(
      (count) =>
        `${Array.from(
          { length: count },
          () => "Claude said you broke the build.",
        ).join("\n")}\nI agree: You missed the actual requirement.`,
    );

    const mutant = await importHookPolicyMutation(
      `  let lineStart = 0;
  while (lineStart <= value.length) {`,
      `  let lineStart = 0;
  let prefixRescanChecksum = 0;
  while (lineStart <= value.length) {
    for (const character of value.slice(0, lineStart)) {
      prefixRescanChecksum ^= character.charCodeAt(0);
    }
    if (prefixRescanChecksum === -1) collector.separator();`,
    );
    const baselines = new Map();
    for (let trial = 0; trial < 40; trial += 1) {
      const implementations = [
        promptContainsFirstPartyCorrection,
        mutant.promptContainsFirstPartyCorrection,
      ];
      if (trial % 2) implementations.reverse();
      for (const implementation of implementations) {
        const measured = observePairedStringWork(
          implementation,
          inputs,
          trial % 2 === 1,
        );
        expect(measured.observations.map(({ value }) => value)).toEqual([
          true,
          true,
        ]);
        if (implementation === promptContainsFirstPartyCorrection) {
          expect(measured.ratio, `current trial ${trial}`).toBeLessThan(2.8);
        } else {
          expect(measured.ratio, `mutant trial ${trial}`).toBeGreaterThan(3.2);
          expect(measured.observations[0].work.characterReads).toBeGreaterThan(
            inputs[0].length,
          );
        }
        if (baselines.has(implementation)) {
          expect(measured).toEqual(baselines.get(implementation));
        } else {
          baselines.set(implementation, measured);
        }
      }
    }
  }, 15_000);

  it("applies source, transformation, and opt-out metamorphically", () => {
    const wrappers = [
      (body) => "Claude feedback: " + body,
      (body) => "Review feedback: " + body,
      (body) => "Please summarize: " + body,
      (body) => "I need you to condense: " + body,
      (body) => "Alice: " + body,
    ];
    for (const correction of directCorrections.slice(0, 10)) {
      for (const wrap of wrappers) {
        const wrapped = wrap(correction);
        expect(promptContainsFirstPartyCorrection(wrapped), wrapped).toBe(
          false,
        );
        const adopted =
          wrapped + " My assessment: You overlooked the edge case.";
        expect(promptContainsFirstPartyCorrection(adopted), adopted).toBe(true);
      }
      const optedOut =
        correction + " Do not reuse anything from this conversation later.";
      expect(promptContainsFirstPartyCorrection(optedOut), optedOut).toBe(
        false,
      );
    }
  });
});
