import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  measureFirstPartyWrapperScanWorkForTests,
  promptContainsFirstPartyCorrection,
} from "../scripts/private-learning-hook-policy.mjs";
import {
  factualCorrectionBodies,
  factualCorrectionContrastCorpus,
  factualCorrectionOrdinaryStatements,
  factualCorrectionRetractionCases,
  factualCorrectionSourceControls,
  pendingCorrectionSourcePayloadCases,
  reviewedExternalHeadings,
  reviewedSingleWordHeadings,
  structuralCorrectionBodies,
  structuralCorrectionContrastCorpus,
  structuralCorrectionOrdinaryStatements,
  structuralCorrectionReplacementCorpus,
  nestedStructuralCorrectionSourceCorpus,
} from "./fixtures/factual-correction-corpus.mjs";
import {
  observePairedStringWork,
  observeSelectedRegexExecutions,
} from "./fixtures/string-scan-work.mjs";
import { correctionContrastCorpus } from "./fixtures/correction-contrast-corpus.mjs";

describe("factual correction capture", () => {
  it("changes only the previously label-dependent bare fact in the frozen round-12 corpus", async () => {
    const source = execFileSync(
      "git",
      [
        "show",
        "d79a4af:packages/codex-plugin/test/fixtures/correction-contrast-corpus.mjs",
      ],
      { encoding: "utf8" },
    );
    const previous = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    const changed = correctionContrastCorpus.flatMap((current, index) => {
      const old = previous.correctionContrastCorpus[index];
      expect(current.prompt).toBe(old.prompt);
      expect(current.id).toBe(old.id);
      return current.expected === old.expected
        ? []
        : [{ id: current.id, before: old.expected, after: current.expected }];
    });
    expect(changed).toEqual([
      { id: "bare-body/endpoint/body", before: false, after: true },
    ]);
  });

  it.each(factualCorrectionBodies)(
    "recognizes a replacement without a label: %s",
    (body) => {
      for (const prompt of [body, `No, ${body}`, `Actually, ${body}`]) {
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(true);
      }
    },
  );

  it.each(factualCorrectionBodies.map((body, index) => ({ body, index })))(
    "keeps every heading, attribution, and control contrast for $body",
    ({ index }) => {
      const cases = factualCorrectionContrastCorpus.filter(
        ({ id }) => id.split("/")[1] === String(index),
      );
      expect(cases).toHaveLength(266);
      for (const { id, prompt, expected } of cases) {
        expect(
          promptContainsFirstPartyCorrection(prompt),
          `${id}: ${prompt}`,
        ).toBe(expected);
      }
    },
  );

  it.each(factualCorrectionOrdinaryStatements)(
    "does not infer correction intent from %s",
    (prompt) => {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    },
  );

  it("keeps the explicit label useful for a fact with no replacement contrast", () => {
    for (const body of [
      "we use the durable queue here.",
      "the timeout should be 30s.",
    ]) {
      expect(promptContainsFirstPartyCorrection(body), body).toBe(false);
      expect(
        promptContainsFirstPartyCorrection(`Correction: ${body}`),
        body,
      ).toBe(true);
    }
  });

  it.each(factualCorrectionRetractionCases)(
    "preserves cancellation instead of treating it as a replacement: %s",
    (prompt) => {
      for (const prefix of ["", "Correction: ", "My current note: "]) {
        expect(
          promptContainsFirstPartyCorrection(prefix + prompt),
          prefix + prompt,
        ).toBe(false);
      }
    },
  );

  it("preserves explicit ownership and source precision for the reviewed heading vocabulary", () => {
    expect(reviewedSingleWordHeadings).toHaveLength(40);
    expect(reviewedExternalHeadings).toHaveLength(10);
    for (const separator of [": ", " - ", " \u2014 "]) {
      for (const heading of reviewedSingleWordHeadings) {
        const own = `My ${heading.toLowerCase()} issue${separator}you broke the build.`;
        expect(promptContainsFirstPartyCorrection(own), own).toBe(true);
        const external = `The reviewer's ${heading}${separator}you broke the build.`;
        expect(promptContainsFirstPartyCorrection(external), external).toBe(
          false,
        );
      }
      for (const heading of [
        ...reviewedExternalHeadings,
        "Race",
        "Alice",
        "Mark",
      ]) {
        const prompt = `${heading}${separator}you broke the build.`;
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
      }
    }
  });

  it("keeps attribution across internal contrast conjunctions and allows explicit adoption", () => {
    for (const body of factualCorrectionBodies) {
      for (const prefix of [
        "The reviewer said ",
        "Per their runbook, ",
        "Translate this: ",
      ]) {
        const reported = prefix + body;
        expect(promptContainsFirstPartyCorrection(reported), reported).toBe(
          false,
        );
        const adopted = `${reported} Speaking for myself now: ${body}`;
        expect(promptContainsFirstPartyCorrection(adopted), adopted).toBe(true);
      }
      const unrelated = `${body} I retract only the build claim.`;
      expect(promptContainsFirstPartyCorrection(unrelated), unrelated).toBe(
        true,
      );
    }
  });

  it("keeps embedded source controls separate from standalone or explicitly adopted user controls", () => {
    expect(factualCorrectionSourceControls).toHaveLength(630);
    for (const { prompt, expected } of factualCorrectionSourceControls) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("keeps a reported interjection attached to its payload before allowing later user adoption", () => {
    expect(pendingCorrectionSourcePayloadCases).toHaveLength(8);
    for (const { prompt, expected } of pendingCorrectionSourcePayloadCases) {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    }
  });

  it("retains linear bounded work for repeated contrast and punctuation candidates", () => {
    const source = (count) =>
      "the timeout should be 30s, not 5s; ".repeat(count);
    for (const count of [16, 64, 256]) {
      const prompt = source(count);
      const measured = measureFirstPartyWrapperScanWorkForTests(prompt);
      expect(measured.detected).toBe(true);
      expect(measured.work.total).toBeLessThan(prompt.length * 64);
    }
    // Include unclamped statements; only testing large windows can hide a rescan.
    for (const count of [32, 64, 128, 256]) {
      const observed = observePairedStringWork(
        promptContainsFirstPartyCorrection,
        [source(count), source(count * 2)],
      );
      expect(observed.ratio, `count=${count}`).toBeLessThan(2.8);
    }
  });
});

describe("structural correction capture", () => {
  it("does not run contrast neighborhood searches on repeated headings without a contrast", () => {
    const select = (pattern) =>
      pattern.source.includes("(?<positiveConnector>");
    for (const count of [128, 512, 4096]) {
      expect(
        observeSelectedRegexExecutions(
          () => promptContainsFirstPartyCorrection("a - ".repeat(count)),
          select,
        ),
      ).toEqual({ value: false, executions: 0 });
    }
    const positive = observeSelectedRegexExecutions(
      () => promptContainsFirstPartyCorrection("v2, not v1."),
      select,
    );
    expect(positive.value).toBe(true);
    expect(positive.executions).toBeGreaterThan(0);
  });
  it.each(structuralCorrectionReplacementCorpus)(
    "resolves replacement-side provenance and controls: $id",
    ({ prompt, expected }) => {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(expected);
    },
  );
  it.each(structuralCorrectionBodies)(
    "captures an open-vocabulary or terse contrast: %s",
    (body) => {
      for (const prefix of ["", "No, ", "Actually, ", "To be clear: "]) {
        expect(
          promptContainsFirstPartyCorrection(prefix + body),
          prefix + body,
        ).toBe(true);
      }
    },
  );

  it.each(structuralCorrectionBodies.map((body, index) => ({ body, index })))(
    "crosses ownership, headings, punctuation, and opt-outs for $body",
    ({ index }) => {
      const cases = structuralCorrectionContrastCorpus.filter(
        ({ id }) => id.split("/")[1] === String(index),
      );
      expect(cases).toHaveLength(399);
      for (const { id, prompt, expected } of cases) {
        expect(
          promptContainsFirstPartyCorrection(prompt),
          `${id}: ${prompt}`,
        ).toBe(expected);
      }
      const nested = nestedStructuralCorrectionSourceCorpus.filter(
        ({ id }) => id.split("/")[0] === String(index),
      );
      expect(nested).toHaveLength(270);
      for (const { id, prompt, expected } of nested) {
        expect(
          promptContainsFirstPartyCorrection(prompt),
          `${id}: ${prompt}`,
        ).toBe(expected);
      }
    },
  );

  it.each(structuralCorrectionOrdinaryStatements)(
    "does not reinterpret ordinary negation or source boundaries: %s",
    (prompt) => {
      expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(false);
    },
  );

  it("preserves existing heading decisions instead of inventing ownership for ambiguous names", async () => {
    const source = execFileSync(
      "git",
      [
        "show",
        "98cad2b:packages/codex-plugin/scripts/private-learning-hook-policy.mjs",
      ],
      { encoding: "utf8" },
    );
    const previous = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    for (const heading of [
      ...reviewedSingleWordHeadings,
      ...reviewedExternalHeadings,
    ]) {
      for (const separator of [": ", " - ", " \u2014 "]) {
        const prompt = `${heading}${separator}you broke the build.`;
        expect(promptContainsFirstPartyCorrection(prompt), prompt).toBe(
          previous.promptContainsFirstPartyCorrection(prompt),
        );
      }
    }
  });

  it("keeps scoped cancellation and source controls intact around adjacent-sentence replacements", () => {
    for (const body of structuralCorrectionBodies) {
      expect(
        promptContainsFirstPartyCorrection(
          `${body} I retract only the build claim.`,
        ),
        body,
      ).toBe(true);
      for (const control of [
        "Never mind",
        "I retract that statement",
        "Do not learn from this",
      ]) {
        expect(
          promptContainsFirstPartyCorrection(`${body} ${control}.`),
          body,
        ).toBe(false);
        expect(
          promptContainsFirstPartyCorrection(
            `You broke the build. The docs say ${body} ${control}.`,
          ),
          body,
        ).toBe(false);
      }
    }
  });
});
