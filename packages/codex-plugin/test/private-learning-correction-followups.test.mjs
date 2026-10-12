import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  measureFirstPartyWrapperScanWorkForTests,
  promptContainsFirstPartyCorrection,
} from "../scripts/private-learning-hook-policy.mjs";
import {
  correctionContrastCorpus,
  correctionFollowupAmbiguousNames,
  correctionFollowupBodies,
  correctionFollowupCommunicationHeadings,
  correctionFollowupContrastCorpus,
  correctionFollowupHeadings,
  correctionFollowupIntentFrames,
  correctionFollowupNamedSpeakers,
  correctionFollowupNoteCases,
  correctionFollowupReferenceFrames,
  correctionFollowupReferenceNouns,
  correctionFollowupRegressionCorpus,
  correctionFollowupRelationshipHeadings,
  correctionFollowupReportedPairs,
  correctionFollowupTechnicalHeadings,
  correctionReportedRegressionCases,
} from "./fixtures/correction-contrast-corpus.mjs";

function failures(cases) {
  return cases.filter(
    ({ prompt, expected }) =>
      promptContainsFirstPartyCorrection(prompt) !== expected,
  );
}

describe("first-party correction follow-up provenance", () => {
  it("preserves every historical case and its 26 frozen reported witnesses", () => {
    expect(correctionContrastCorpus).toHaveLength(6_356);
    expect(correctionReportedRegressionCases).toHaveLength(26);
    expect(failures(correctionContrastCorpus)).toEqual([]);
  });

  it("pins all 26,636 original cells with only the documented bare-fact expectation change", () => {
    const original = [
      ...correctionContrastCorpus,
      ...correctionFollowupContrastCorpus.slice(0, 20_280),
    ];
    expect(original).toHaveLength(26_636);
    expect(original.filter(({ expected }) => expected)).toHaveLength(6_396);
    // Only the bare endpoint contrast now qualifies without an explicit label.
    const historical = original.map((cell) =>
      cell.id === "bare-body/endpoint/body"
        ? { ...cell, expected: false }
        : cell,
    );
    expect(
      createHash("sha256").update(JSON.stringify(historical)).digest("hex"),
    ).toBe("2d5a43014a8a4963f6c79518d93b7f758754d4883a90b78bc48e5adb28c8d9f7");
    expect(correctionFollowupContrastCorpus.slice(20_280)).toEqual(
      correctionFollowupRegressionCorpus,
    );
  });

  it.each(correctionFollowupNoteCases)(
    "captures the owned note reference %s",
    (prompt) => {
      expect(promptContainsFirstPartyCorrection(prompt)).toBe(true);
    },
  );

  it.each([
    "reference-owner",
    "reference-wrapper",
    "reference-reported",
    "reference-opt-out",
    "heading-shape",
    "retraction-target",
    "reporting-provenance",
    "speaker-shape",
    "speech-delimiter",
  ])("keeps every crossed %s cell independently correct", (axis) => {
    const cells = correctionFollowupContrastCorpus.filter(
      (entry) => entry.axis === axis,
    );
    expect(cells.length).toBeGreaterThan(0);
    const wrong = failures(cells);
    expect({ failures: wrong.length, examples: wrong.slice(0, 12) }).toEqual({
      failures: 0,
      examples: [],
    });
  });

  it.each([
    ["owned-reference-intent", 3_600],
    ["relationship-heading", 288],
    ["communication-source", 720],
    ["technical-heading", 1_512],
    ["ambiguous-name", 192],
  ])("keeps all %s regression cells independently correct", (axis, count) => {
    const cells = correctionFollowupRegressionCorpus.filter(
      (entry) => entry.axis === axis,
    );
    expect(cells).toHaveLength(count);
    const wrong = failures(cells);
    expect({ failures: wrong.length, examples: wrong.slice(0, 12) }).toEqual({
      failures: 0,
      examples: [],
    });
  });

  it("crosses the added intents, sources, headings, and ambiguous names without changing the old axes", () => {
    expect(correctionFollowupRegressionCorpus).toHaveLength(6_312);
    expect(correctionFollowupRegressionCorpus.every(Object.isFrozen)).toBe(
      true,
    );
    expect(
      correctionFollowupRegressionCorpus.filter(({ expected }) => expected),
    ).toHaveLength(3_576);
    expect(correctionFollowupContrastCorpus).toHaveLength(26_592);
    for (const { frame, withdrawn } of correctionFollowupIntentFrames) {
      for (const noun of correctionFollowupReferenceNouns) {
        for (const separator of [": ", " - "]) {
          const cells = correctionFollowupRegressionCorpus.filter(
            (cell) =>
              cell.axis === "owned-reference-intent" &&
              cell.frame === frame &&
              cell.noun === noun &&
              cell.separator === separator,
          );
          expect(cells).toHaveLength(
            3 * correctionFollowupBodies.length * 2 * (withdrawn ? 2 : 1),
          );
          expect(new Set(cells.map(({ expected }) => expected)).size).toBe(2);
        }
      }
    }
    for (const heading of correctionFollowupCommunicationHeadings) {
      for (const preposition of ["from", "by"]) {
        const cells = correctionFollowupRegressionCorpus.filter(
          (cell) =>
            cell.axis === "communication-source" &&
            cell.heading === heading &&
            cell.preposition === preposition,
        );
        expect(cells).toHaveLength(5 * 2 * correctionFollowupBodies.length);
        expect(new Set(cells.map(({ expected }) => expected)).size).toBe(2);
      }
    }
  });

  it("crosses owner, noun, heading size, separator, and retraction target rather than OR-ing them", () => {
    const ids = new Set(correctionFollowupContrastCorpus.map(({ id }) => id));
    expect(ids.size).toBe(correctionFollowupContrastCorpus.length);
    expect(correctionFollowupContrastCorpus.every(Object.isFrozen)).toBe(true);
    expect(correctionFollowupReferenceFrames).toHaveLength(8);
    expect(correctionFollowupReferenceNouns).toHaveLength(5);
    expect(correctionFollowupReportedPairs).toHaveLength(6);
    const references = correctionFollowupContrastCorpus.filter(
      ({ axis }) => axis === "reference-owner",
    );
    expect(references).toHaveLength(
      8 * 5 * 5 * 2 * correctionFollowupBodies.length,
    );
    for (const heading of correctionFollowupHeadings) {
      for (const separator of [": ", " - "]) {
        const cells = correctionFollowupContrastCorpus.filter(
          (cell) =>
            cell.axis === "heading-shape" &&
            cell.heading === heading &&
            cell.separator === separator,
        );
        expect(cells).toHaveLength(3 * correctionFollowupBodies.length);
        expect(new Set(cells.map(({ expected }) => expected)).size).toBe(2);
      }
    }
  });

  it("does not mistake transformation intent or foreign ownership for the author's follow-up", () => {
    const cases = [
      [false, "Quoting my earlier note: you broke the build."],
      [false, "Summarizing my earlier note: you broke the build."],
      [false, "Translating my earlier note: you broke the build."],
      [false, "Paraphrasing my earlier comment: you broke the build."],
      [false, "Rewriting my earlier feedback: you broke the build."],
      [false, "Attributing their earlier point: you broke the build."],
      [false, "Condensing my earlier message: you broke the build."],
      [false, "To summarize my note: you broke the build."],
      [
        false,
        "The reviewer is clarifying my earlier note: you broke the build.",
      ],
      [false, "Clarifying my manager's earlier note: you broke the build."],
      [false, "Clarifying their earlier message: you broke the build."],
      [true, "Clarifying our earlier note: you broke the build."],
      [true, "Elaborating on my earlier note: you broke the build."],
      [true, "Reassessing my earlier feedback: you broke the build."],
      [true, "Building on our earlier point: you broke the build."],
      [
        true,
        "The reviewer relayed a claim. My current correction: you broke the build.",
      ],
      [true, "Postmortem draft by me: you broke the build."],
      [true, "Slack DM from myself - you broke the build."],
    ];
    for (const [expected, prompt] of cases) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("keeps cancellation of capture global while named object retractions stay local", () => {
    const cases = [
      [false, "Never mind learning: you broke the build."],
      [false, "Never mind the lesson - you broke the build."],
      [false, "Never mind: you broke the build."],
      [false, "Disregard that: you broke the build."],
      [false, "Ignore my last note: you broke the build."],
      [true, "Never mind the tests: you broke the build."],
      [true, "Ignore the linter for now: you broke the build."],
      [true, "Please disregard the caching layer - you broke the build."],
      [true, "Never mind tests: you broke the build."],
      [true, "Scratch caching: you broke the build."],
      [true, "Ignore this-endpoint: you broke the build."],
      [true, "Ignore my last note-taking design - you broke the build."],
      [true, "I withdraw the earlier file. You broke the build."],
      [true, "We retract our previous plan. You missed the requirement."],
      [
        false,
        "Ignore the linter: the reviewer relayed that you broke the build.",
      ],
      [false, "Ignore the linter: summarize this: you broke the build."],
      [
        false,
        "Ignore the linter for now: do not capture this. You broke the build.",
      ],
      [
        false,
        "Ignore the linter for now: you broke the build. Never remember this.",
      ],
      [
        true,
        "The reviewer said ignore that. Speaking for myself now: you broke the build.",
      ],
      [
        true,
        '"Never mind the tests: you broke the build." You missed the requirement.',
      ],
      [true, "You broke the build. The reviewer said never mind."],
      [false, "You broke the build. Never mind."],
    ];
    for (const [expected, prompt] of cases) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("keeps withdrawn references inert until a fresh explicit adoption, without retracting unrelated corrections", () => {
    const cases = [
      [
        false,
        "Retracting my earlier note: you broke the build. That was mistaken.",
      ],
      [false, "Withdrawing my earlier note: you broke the build. You did not."],
      [
        false,
        "To retract my earlier note: you broke the build. That was mistaken.",
      ],
      [false, "Also, withdrawing my earlier note: you broke the build."],
      [false, "Retracting my earlier note, you broke the build."],
      [
        false,
        "The reviewer said Reaffirming my earlier note: you broke the build.",
      ],
      [
        false,
        "Summarize this: Reaffirming my earlier note: you broke the build.",
      ],
      [
        true,
        "Retracting my earlier note: you broke the build. I adopt this: you missed the actual requirement.",
      ],
      [
        true,
        "Withdrawing my earlier note: you broke the build. My current correction: you missed the actual requirement.",
      ],
      [
        true,
        "You missed the actual requirement. Retracting my earlier note: you broke the build.",
      ],
      [
        false,
        "Retracting my earlier note: you broke the build. The reviewer said I adopt this: you missed the actual requirement.",
      ],
      [
        false,
        "Retracting my earlier note: you broke the build. Do not capture this. I adopt this: you missed the actual requirement.",
      ],
    ];
    for (const [expected, prompt] of cases) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("distinguishes review-topic nouns from ambiguous personal names without making headings corrective", () => {
    for (const separator of [": ", " - ", " \u2014 "]) {
      for (const body of correctionFollowupBodies) {
        for (const speaker of correctionFollowupNamedSpeakers) {
          const prompt = speaker + separator + body;
          expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
            false,
          );
        }
        for (const noun of [
          "Bug",
          "Defect",
          "Fault",
          "Mismatch",
          "Oversight",
          "Objection",
        ]) {
          for (const heading of [
            noun,
            noun.toLowerCase(),
            noun.toUpperCase(),
            `Current ${noun.toLowerCase()}`,
          ]) {
            const prompt = heading + separator + body;
            expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
              true,
            );
            const external = `The reviewer's ${heading}${separator}${body}`;
            expect(promptContainsFirstPartyCorrection(external), external).toBe(
              false,
            );
          }
        }
      }
      for (const heading of correctionFollowupHeadings) {
        for (const body of [
          "run the tests before the commit.",
          "if you missed the requirement, inspect the file.",
          "The reviewer relayed that you broke the build.",
          "Summarize this: you broke the build.",
        ]) {
          const prompt = heading + separator + body;
          expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
            false,
          );
        }
      }
    }
  });

  it("keeps technical headings non-corrective on their own and explicit speakers inert", () => {
    for (const separator of [": ", " - ", " \u2014 "]) {
      for (const heading of [
        ...correctionFollowupTechnicalHeadings,
        ...correctionFollowupRelationshipHeadings,
      ]) {
        for (const body of [
          "run the tests before the commit.",
          "if you missed the requirement, inspect the file.",
          "The reviewer relayed that you broke the build.",
          "Summarize this: you broke the build.",
        ]) {
          const prompt = heading + separator + body;
          expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
            false,
          );
        }
      }
      for (const body of correctionFollowupBodies) {
        for (const heading of [
          "Deadlock",
          "Deadlock issue",
          "Race condition",
        ]) {
          const prompt = heading + separator + body;
          expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
        }
        for (const speaker of [
          ...correctionFollowupAmbiguousNames,
          "Alice Deadlock",
          "Dr Deadlock",
          "Our Alex Gap",
          "My Alice Blocker",
          "QA Deadlock",
          "SRE lead",
        ]) {
          const prompt = speaker + separator + body;
          expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
            false,
          );
        }
      }
    }
  });

  it.each([
    {
      id: "withdrawn-owned-reference",
      needle: "CORRECTION_WITHDRAWN_REFERENCE.test(intent)",
      replacement: "false",
      prompt:
        "Retracting my earlier note: you broke the build. That was mistaken.",
      expected: false,
    },
    {
      id: "technical-relationship-attribution",
      needle: "${CORRECTION_ATTRIBUTED_SOURCE_NOUN}",
      replacement: String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}`,
      prompt: "Grouping by tenant: you deleted the wrong file.",
      expected: true,
    },
    {
      id: "technical-heading-recall",
      needle: "CORRECTION_TECHNICAL_TOPIC_NOUN.test(topic.groups.noun)",
      replacement: "false",
      prompt: "Deadlock - you broke the build.",
      expected: true,
    },
  ])(
    "rejects the executable $id mutation with an additive corpus witness",
    async ({ needle, replacement, prompt, expected }) => {
      const source = await readFile(
        new URL("../scripts/private-learning-hook-policy.mjs", import.meta.url),
        "utf8",
      );
      expect(source.split(needle)).toHaveLength(2);
      const witnesses = correctionFollowupRegressionCorpus.filter(
        (cell) => cell.prompt === prompt,
      );
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0].expected).toBe(expected);
      expect(promptContainsFirstPartyCorrection(prompt)).toBe(expected);
      const mutated = source.replace(needle, replacement);
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
      );
      expect(module.promptContainsFirstPartyCorrection(prompt)).toBe(!expected);
    },
  );

  it("keeps the runtime dependency-free and the existing bounded scanner shape", async () => {
    const source = await readFile(
      new URL("../scripts/private-learning-hook-policy.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/^import\s/mu);
    expect(source).toContain(
      "  let lineStart = 0;\n  while (lineStart <= value.length) {",
    );
    for (const count of [8, 64, 512]) {
      const prompt = `${"Clarifying my earlier note: ".repeat(count)}you broke the build.`;
      const result = measureFirstPartyWrapperScanWorkForTests(prompt);
      expect(result.detected).toBe(true);
      expect(result.work.total).toBeLessThan(prompt.length * 64);
    }
  });
});
