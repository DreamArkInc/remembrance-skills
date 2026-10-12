function correctionSeed(
  id,
  body,
  label = null,
  separator = ": ",
  requiresLabel = false,
) {
  return Object.freeze({
    id,
    body,
    label,
    separator,
    requiresLabel,
    prompt: label ? `${label}${separator}${body}` : body,
  });
}

const recallSeeds = Object.freeze([
  correctionSeed("reminder", "you keep ignoring the constraint.", "Reminder"),
  correctionSeed("follow-up", "the fix you wrote is wrong.", "Follow-up"),
  correctionSeed("endpoint", "the endpoint is /v2 not /v1.", "Correction"),
  correctionSeed("heads-up", "you deleted the wrong file.", "Heads up", " - "),
  correctionSeed("fyi", "that regex doesn't match what I described.", "FYI"),
  correctionSeed("small-thing", "you misread the spec.", "Small thing"),
  correctionSeed("quick-note", "this is still broken.", "Quick note", " - "),
  correctionSeed("important", "you're solving the wrong problem.", "Important"),
  correctionSeed("misunderstood", "You misunderstood my request."),
  correctionSeed("again", "stop rewriting the tests.", "Again"),
]);

export const correctionRecallCases = Object.freeze(
  recallSeeds.map(({ prompt }) => prompt),
);

// These headings deliberately use neither a known authorial label nor a
// proper-name shape. Their corrective clauses must decide the result.
const unlistedHeadingSeeds = Object.freeze([
  correctionSeed(
    "concurrency",
    "you missed the actual requirement.",
    "Concurrency boundary",
  ),
  correctionSeed(
    "retry",
    "you missed the actual requirement.",
    "Retry semantics",
    " - ",
  ),
  correctionSeed(
    "state-machine",
    "you missed the actual requirement.",
    "State-machine mismatch",
  ),
  correctionSeed(
    "encoding",
    "you missed the actual requirement.",
    "Encoding edge",
    " - ",
  ),
  correctionSeed(
    "lifecycle",
    "you missed the actual requirement.",
    "Lifecycle gap",
  ),
  correctionSeed(
    "serialization",
    "you missed the actual requirement.",
    "Serialization behavior",
    " - ",
  ),
]);

export const correctionUnlistedHeadingCases = Object.freeze(
  unlistedHeadingSeeds.map(({ prompt }) => prompt),
);

export const correctionContrastSeeds = Object.freeze([
  ...recallSeeds,
  ...unlistedHeadingSeeds,
]);

export const correctionSourceLabelCases = Object.freeze([
  "Slack thread: that's incorrect.",
  "Jira ticket: that's incorrect.",
  "Zoom call: that's incorrect.",
  "Standup notes: that's incorrect.",
  "Pager alert: that's incorrect.",
  "Design doc: that's incorrect.",
  "Customer portal thread - you misunderstood my request.",
  "Weekly planning call: you deleted the wrong file.",
  "Release handoff notes, this is still broken.",
  "API design doc: Correction: the endpoint is /v2 not /v1.",
]);

export const correctionDocumentReportCases = Object.freeze([
  "The docs say that's not what I asked for.",
  "The doc says that's not what I asked for.",
  "The spec says that's not what I asked for.",
  "The specs say that's not what I asked for.",
  "The README says that's not what I asked for.",
  "The changelog says that's incorrect.",
  "A deployment document mentions you misunderstood my request.",
  "Those API specifications state you deleted the wrong file.",
  "The latest release note describes that approach as incorrect.",
  "This integration README reports this is still broken.",
]);

export const correctionOrdinaryInstructionCases = Object.freeze([
  "Reminder: run the tests before the commit.",
  "Follow-up: add a test for the endpoint.",
  "Heads up - the files are ready for review.",
  "FYI: the regex supports that syntax.",
  "Important: stop the development server.",
  "Again: run the tests.",
  "Correction:",
  "Correction: if the endpoint changed, inspect the documentation.",
]);

export const correctionLegacyContrastCorpus = Object.freeze([
  ...[...correctionRecallCases, ...correctionUnlistedHeadingCases].map(
    (prompt) => Object.freeze({ prompt, expected: true }),
  ),
  ...[
    ...correctionSourceLabelCases,
    ...correctionDocumentReportCases,
    ...correctionOrdinaryInstructionCases,
  ].map((prompt) => Object.freeze({ prompt, expected: false })),
]);

// Verbatim reported regressions. Generated contrasts supplement, not replace,
// these witnesses or the original 16-positive / 28-negative corpus.
export const correctionReportedRegressionCases = Object.freeze([
  "A teammate mentioned you're solving the wrong problem.",
  "A colleague mentioned you're solving the wrong problem.",
  "A coworker mentioned you're solving the wrong problem.",
  "A user mentioned you're solving the wrong problem.",
  "A customer mentioned you're solving the wrong problem.",
  "My manager mentioned you're solving the wrong problem.",
  "Someone mentioned you're solving the wrong problem.",
  "A teammate said you're solving the wrong problem.",
  "A teammate noted you're solving the wrong problem.",
  "A teammate pointed out you're solving the wrong problem.",
  "A teammate flagged that you're solving the wrong problem.",
  "QA reminder: you keep ignoring the constraint.",
  "Customer reminder: you keep ignoring the constraint.",
  "Their reminder: you keep ignoring the constraint.",
  "Reviewer follow-up: the fix you wrote is wrong.",
  "Customer FYI: that regex doesn't match what I described.",
  "Legal FYI: that regex doesn't match what I described.",
  "Client heads up - you deleted the wrong file.",
  "Vendor important: you're solving the wrong problem.",
  "Auditor small thing: you misread the spec.",
  "Never mind: this is still broken.",
  "Never mind - this is still broken.",
  "Disregard that. This is still broken.",
  "Ignore that. This is still broken.",
  "Ignore my last note: this is still broken.",
  "Scratch that: this is still broken.",
]);

export const correctionReportingSubjects = Object.freeze([
  "A teammate",
  "A colleague",
  "A coworker",
  "A user",
  "A customer",
  "My manager",
  "Someone",
  "The reviewer",
  "Alice",
  "They",
]);

export const correctionReportingVerbs = Object.freeze([
  "mentioned",
  "said",
  "noted",
  "pointed out",
  "flagged",
  "reported",
  "wrote",
  "claimed",
]);

export const correctionHeadingOwners = Object.freeze([
  "QA",
  "Customer",
  "Their",
  "Reviewer",
  "Legal",
  "Client",
  "Vendor",
  "Auditor",
  "My manager's",
]);

const correctionWrappers = Object.freeze([
  ["quoted", (text) => JSON.stringify(text)],
  ["blockquote", (text) => `> ${text}`],
  ["fenced", (text) => `\x60\x60\x60text\n${text}\n\x60\x60\x60`],
  ["translation", (text) => `Translate to Spanish: ${text}`],
  ["summary", (text) => `Summarize the following: ${text}`],
  ["commit-message", (text) => `Proposed commit message: ${text}`],
  ["spec", (text) => `The API spec says: ${text}`],
  ["thread", (text) => `Slack thread: ${text}`],
]);

export const correctionRetractionPrefixes = Object.freeze([
  "Never mind",
  "Disregard that",
  "Ignore that",
  "Ignore my last note",
  "Scratch that",
]);

export const correctionRetractionSeparators = Object.freeze([
  ": ",
  " - ",
  ". ",
  "; ",
  "\n",
  "\r\n",
]);

export const correctionNoNeedControls = Object.freeze([
  "No need to learn from this.",
  "No need to remember this.",
  "No need to save this as a lesson.",
  "No need to capture this.",
]);

function crossedCorrectionCases() {
  const cases = [];
  const add = (axis, seed, suffix, prompt, expected = false) => {
    cases.push(
      Object.freeze({
        id: `${axis}/${seed.id}/${suffix}`,
        axis,
        seedId: seed.id,
        prompt,
        expected,
      }),
    );
  };
  for (const seed of correctionContrastSeeds) {
    add("bare-body", seed, "body", seed.body, !seed.requiresLabel);
    for (const subject of correctionReportingSubjects) {
      for (const verb of correctionReportingVerbs) {
        add(
          "reported-body",
          seed,
          `${subject}/${verb}`,
          `${subject} ${verb} that ${seed.body}`,
        );
        add(
          "reported-label",
          seed,
          `${subject}/${verb}`,
          `${subject} ${verb} the following: ${seed.prompt}`,
        );
      }
    }
    if (seed.label) {
      for (const owner of correctionHeadingOwners) {
        for (const label of new Set([seed.label, seed.label.toLowerCase()])) {
          add(
            "external-heading",
            seed,
            `${owner}/${label}`,
            `${owner} ${label}${seed.separator}${seed.body}`,
          );
        }
      }
    }
    for (const [id, wrap] of correctionWrappers) {
      add("wrapped-label", seed, id, wrap(seed.prompt));
      add("wrapped-body", seed, id, wrap(seed.body));
    }
    for (const [id, wrap] of correctionWrappers.slice(3)) {
      for (const label of ["Reminder", "My note", "Concurrency boundary"]) {
        add(
          "nested-wrapper",
          seed,
          `${id}/${label}`,
          `${label}: ${wrap(seed.prompt)}`,
        );
      }
      add("embedded-adoption", seed, id, wrap(`I agree: ${seed.prompt}`));
      add(
        "embedded-current",
        seed,
        id,
        wrap(`My current correction: ${seed.prompt}`),
      );
      add(
        "persistent-source",
        seed,
        id,
        wrap(`One comment follows. ${seed.prompt}`),
      );
      for (const adoption of [
        "My current correction:",
        "Speaking for myself now:",
        "Separately,",
      ]) {
        add(
          "independent-adoption",
          seed,
          `${id}/${adoption}`,
          `${wrap(seed.prompt)} ${adoption} ${seed.prompt}`,
          true,
        );
      }
      add(
        "independent-before-source",
        seed,
        id,
        `${seed.prompt} ${wrap(seed.prompt)}`,
        true,
      );
    }
    for (const retraction of correctionRetractionPrefixes) {
      for (const separator of correctionRetractionSeparators) {
        add(
          "retraction-before",
          seed,
          `${retraction}/${JSON.stringify(separator)}`,
          `${retraction}${separator}${seed.prompt}`,
        );
        const before = separator.includes("\n")
          ? seed.prompt
          : seed.prompt.slice(0, -1);
        add(
          "retraction-after",
          seed,
          `${retraction}/${JSON.stringify(separator)}`,
          `${before}${separator}${retraction}.`,
        );
      }
    }
    for (const reference of [
      "Never mind about the earlier file.",
      "Disregard the old deployment note.",
      "Ignore the previous file.",
      "Scratch the earlier test.",
    ]) {
      add(
        "scoped-reference-before",
        seed,
        reference,
        `${reference} ${seed.prompt}`,
        true,
      );
      add(
        "scoped-reference-after",
        seed,
        reference,
        `${seed.prompt} ${reference}`,
        true,
      );
    }
    for (const retraction of [
      "I retract that statement.",
      "I take that back.",
    ]) {
      add(
        "withdraw-current-claim",
        seed,
        retraction,
        `${seed.prompt} ${retraction}`,
      );
      add(
        "withdraw-then-independent",
        seed,
        retraction,
        `${seed.prompt} ${retraction} Separately, ${seed.prompt}`,
        true,
      );
      add(
        "withdraw-only-latest",
        seed,
        retraction,
        `You broke the build. ${seed.prompt} ${retraction}`,
        true,
      );
    }
    add(
      "reported-opt-out",
      seed,
      "source",
      `The reviewer said do not capture this. Speaking for myself now: ${seed.prompt}`,
      true,
    );
    add(
      "authorial-opt-out",
      seed,
      "source",
      `The reviewer said this was wrong. Speaking for myself now: ${seed.prompt} Do not capture this.`,
    );
    add(
      "quoted-opt-out",
      seed,
      "quoted",
      `"Do not capture this." ${seed.prompt}`,
      true,
    );
    for (const control of correctionNoNeedControls) {
      for (const [leadId, lead] of [
        ["bare", ""],
        ["neutral", "Also, "],
        ["heading", "My note: "],
      ]) {
        const authorial = `${lead}${control}`;
        const reported = `The reviewer said ${authorial}`;
        const quoted = JSON.stringify(authorial);
        for (const position of ["before", "after"]) {
          const suffix = `${control}/${leadId}/${position}`;
          add(
            "no-need-authorial-opt-out",
            seed,
            suffix,
            position === "before"
              ? `${authorial} ${seed.prompt}`
              : `${seed.prompt} ${authorial}`,
          );
          add(
            "no-need-reported-opt-out",
            seed,
            suffix,
            position === "before"
              ? `${reported} Speaking for myself now: ${seed.prompt}`
              : `${seed.prompt} ${reported}`,
            true,
          );
          add(
            "no-need-quoted-opt-out",
            seed,
            suffix,
            position === "before"
              ? `${quoted} ${seed.prompt}`
              : `${seed.prompt} ${quoted}`,
            true,
          );
        }
      }
    }
  }
  return Object.freeze(cases);
}

export const correctionGeneratedContrastCorpus = crossedCorrectionCases();

export const correctionContrastCorpus = Object.freeze([
  ...correctionLegacyContrastCorpus,
  ...correctionReportedRegressionCases.map((prompt, index) =>
    Object.freeze({
      id: `reported-regression/${index + 1}`,
      axis: "reported-regression",
      prompt,
      expected: false,
    }),
  ),
  ...correctionGeneratedContrastCorpus,
]);

// Round-12 contrasts are additive. Keep the original corpus and its 26
// reported witnesses unchanged for exact historical source comparisons.
export const correctionFollowupBodies = Object.freeze([
  "you deleted the wrong file.",
  "you missed the actual requirement.",
  "you broke the build.",
  "the endpoint is wrong.",
  "you misread the spec.",
  "this is still broken.",
]);

export const correctionFollowupReferenceFrames = Object.freeze(
  [
    ["Clarifying", "earlier "],
    ["Clarifying", ""],
    ["To clarify", "earlier "],
    ["Expanding on", "earlier "],
    ["Following up on", ""],
    ["Adding to", "earlier "],
    ["Correcting", "earlier "],
    ["Revisiting", ""],
  ].map(([frame, modifier]) => Object.freeze({ frame, modifier })),
);

export const correctionFollowupReferenceNouns = Object.freeze([
  "note",
  "message",
  "point",
  "comment",
  "feedback",
]);

export const correctionFollowupHeadings = Object.freeze([
  "Blocker",
  "Regression",
  "Gap",
  "Nit",
  "Pushback",
  "Concurrency boundary",
  "Retry semantics",
  "State-machine mismatch",
  "Encoding edge",
  "Lifecycle gap",
  "Serialization behavior",
  "Ordering issue",
  "Timeout window",
  "Cache invalidation",
]);

export const correctionFollowupNamedSpeakers = Object.freeze([
  "Alice",
  "Bob",
  "Nora",
  "Chris",
  "Jane Doe",
  "Dr Smith",
  "Ari Chen",
  "QA",
  "SRE lead",
  "Release manager",
  "Alice Blocker",
  "Alex Gap",
  "Jane Regression",
  "Our Alex Gap",
  "Dr Gap",
  "My Alice Blocker",
]);

export const correctionFollowupReportedPairs = Object.freeze(
  [
    ["The PM relayed that", "I relayed that"],
    ["Escalation from support:", "Escalation from me:"],
    ["Forwarded from legal:", "Forwarded from us:"],
    ["Postmortem draft by SRE:", "Postmortem draft by myself:"],
    ["Slack DM from the lead:", "Slack DM from ourselves:"],
    ["The dashboard shows", "I show that"],
  ].map(([reported, firstParty]) => Object.freeze({ reported, firstParty })),
);

export const correctionFollowupNoteCases = Object.freeze(
  correctionFollowupReferenceFrames.map(
    ({ frame, modifier }) =>
      `${frame} my ${modifier}note: you deleted the wrong file.`,
  ),
);

function followupCorrectionCases() {
  const cases = [];
  const add = (axis, parts, prompt, expected, dimensions = {}) => {
    cases.push(
      Object.freeze({
        id: `followup/${axis}/${parts.join("/")}`,
        axis,
        prompt,
        expected,
        ...dimensions,
      }),
    );
  };
  const separators = [": ", " - "];
  const owners = [
    ["my", true],
    ["our", true],
    ["their", false],
    ["the reviewer's", false],
    ["my manager's", false],
  ];
  for (const [
    frameIndex,
    { frame, modifier },
  ] of correctionFollowupReferenceFrames.entries()) {
    for (const noun of correctionFollowupReferenceNouns) {
      for (const [owner, firstParty] of owners) {
        for (const separator of separators) {
          for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
            const heading = `${frame} ${owner} ${modifier}${noun}`;
            const prompt = heading + separator + body;
            const parts = [frameIndex, noun, owner, separator, bodyIndex];
            add("reference-owner", parts, prompt, firstParty, {
              owner,
              noun,
              separator,
              frameIndex,
              bodyIndex,
            });
            if (!firstParty) continue;
            for (const [wrapper, wrap] of correctionWrappers) {
              add(
                "reference-wrapper",
                [...parts, wrapper],
                wrap(prompt),
                false,
              );
            }
            add(
              "reference-reported",
              parts,
              `The reviewer said ${prompt}`,
              false,
            );
            add(
              "reference-opt-out",
              parts,
              `${prompt} Do not capture this.`,
              false,
            );
          }
        }
      }
    }
  }
  for (const heading of correctionFollowupHeadings) {
    for (const separator of separators) {
      for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
        for (const [owner, prefix, expected] of [
          ["implicit", "", true],
          ["first-party", "My ", true],
          ["reported", "QA ", false],
        ]) {
          add(
            "heading-shape",
            [heading, separator, bodyIndex, owner],
            prefix + heading + separator + body,
            expected,
            {
              heading,
              headingWordCount: heading.split(" ").length,
              separator,
              bodyIndex,
              owner,
            },
          );
        }
      }
    }
  }
  for (const verb of ["Never mind", "Disregard", "Ignore", "Scratch"]) {
    const targets = [
      ["", false],
      ["that", false],
      ["this", false],
      ["it", false],
      ...correctionFollowupReferenceNouns.map((noun) => [
        `my last ${noun}`,
        false,
      ]),
      ["the tests", true],
      ["the linter", true],
      ["the caching layer", true],
      ["my earlier file list", true],
      ["that test", true],
      ["this endpoint", true],
    ];
    for (const [target, expected] of targets) {
      for (const separator of [...correctionRetractionSeparators, ", "]) {
        for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
          const control = `${verb}${target ? ` ${target}` : ""}`;
          for (const position of ["before", "after"]) {
            const prompt =
              position === "before"
                ? control + separator + body
                : (separator.includes("\n") ? body : body.slice(0, -1)) +
                  separator +
                  control +
                  ".";
            add(
              "retraction-target",
              [verb, target, separator, bodyIndex, position],
              prompt,
              expected,
              { verb, target, separator, bodyIndex, position },
            );
          }
        }
      }
    }
  }
  for (const [pairIndex, pair] of correctionFollowupReportedPairs.entries()) {
    for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
      add(
        "reporting-provenance",
        [pairIndex, bodyIndex, "reported"],
        `${pair.reported} ${body}`,
        false,
      );
      add(
        "reporting-provenance",
        [pairIndex, bodyIndex, "first-party"],
        `${pair.firstParty} ${body}`,
        true,
      );
      add(
        "reporting-provenance",
        [pairIndex, bodyIndex, "independent-adoption"],
        `${pair.reported} ${body} Speaking for myself now: ${body}`,
        true,
      );
      add(
        "reporting-provenance",
        [pairIndex, bodyIndex, "prior-first-party"],
        `${body} ${pair.reported} ${body}`,
        true,
      );
    }
  }
  for (const speaker of correctionFollowupNamedSpeakers) {
    for (const separator of [": ", " - ", " \u2014 "]) {
      for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
        const attributed = speaker + separator + body;
        for (const adopted of [false, true]) {
          add(
            "speaker-shape",
            [speaker, separator, bodyIndex, adopted],
            attributed + (adopted ? ` Speaking for myself now: ${body}` : ""),
            adopted,
            { speaker, separator, bodyIndex, adopted },
          );
        }
      }
    }
  }
  for (const [subject, firstParty] of [
    ["Mira", false],
    ["Alex", false],
    ["The PM", false],
    ["My engineer", false],
    ["I", true],
    ["We", true],
  ]) {
    for (const verb of ["said", "noted", "reported", "argued"]) {
      for (const separator of [
        " ",
        ": ",
        " - ",
        "\u2014",
        "-",
        "\u2013",
        "(",
      ]) {
        for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
          const clause = separator === "(" ? `${body.slice(0, -1)}).` : body;
          const reported = `${subject} ${verb}${separator}${clause}`;
          for (const adopted of [false, true]) {
            add(
              "speech-delimiter",
              [subject, verb, separator, bodyIndex, adopted],
              reported + (adopted ? ` Speaking for myself now: ${body}` : ""),
              firstParty || adopted,
              { subject, verb, separator, bodyIndex, adopted },
            );
          }
        }
      }
    }
  }
  return Object.freeze(cases);
}

export const correctionFollowupIntentFrames = Object.freeze(
  [
    ["Retracting", true],
    ["Withdrawing", true],
    ["To retract", true],
    ["To withdraw", true],
    ["Reaffirming", false],
    ["To reaffirm", false],
  ].map(([frame, withdrawn]) => Object.freeze({ frame, withdrawn })),
);

export const correctionFollowupRelationshipHeadings = Object.freeze([
  "Grouping by tenant",
  "Ordering by timestamp",
  "Partitioning by account",
  "Sorting by name",
  "Regression from cache invalidation",
  "Diff from HEAD",
]);

export const correctionFollowupCommunicationHeadings = Object.freeze([
  "Feedback",
  "Postmortem draft",
  "Slack DM",
  "Escalation",
  "Forwarded",
  "Security finding",
]);

export const correctionFollowupTechnicalHeadings = Object.freeze([
  "Deadlock",
  "Livelock",
  "Starvation",
  "Timeout",
  "Latency",
  "Throughput",
  "Concurrency",
  "Contention",
  "Backpressure",
  "Serialization",
  "Deserialization",
  "Encoding",
  "Decoding",
  "Lifecycle",
]);

// These words can be names. Capitalization alone must not reinterpret a
// speaker as a technical topic, even when the word also has a technical use.
export const correctionFollowupAmbiguousNames = Object.freeze([
  "Mark",
  "May",
  "Will",
  "Grant",
  "Chase",
  "Trace",
  "Case",
  "Race",
]);

function followupRegressionCases() {
  const cases = [];
  const add = (axis, parts, prompt, expected, dimensions) => {
    cases.push(
      Object.freeze({
        id: `followup-regression/${axis}/${parts.join("/")}`,
        axis,
        prompt,
        expected,
        ...dimensions,
      }),
    );
  };
  const separators = [": ", " - "];
  for (const { frame, withdrawn } of correctionFollowupIntentFrames) {
    for (const noun of correctionFollowupReferenceNouns) {
      for (const [owner, firstParty] of [
        ["my", true],
        ["our", true],
        ["their", false],
      ]) {
        for (const separator of separators) {
          for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
            for (const resolved of withdrawn ? [false, true] : [false]) {
              for (const adopted of [false, true]) {
                const prompt =
                  `${frame} ${owner} earlier ${noun}${separator}${body}` +
                  (resolved ? " That was mistaken." : "") +
                  (adopted ? ` Speaking for myself now: ${body}` : "");
                add(
                  "owned-reference-intent",
                  [frame, noun, owner, separator, bodyIndex, resolved, adopted],
                  prompt,
                  adopted || (firstParty && !withdrawn),
                  {
                    frame,
                    withdrawn,
                    noun,
                    owner,
                    separator,
                    bodyIndex,
                    resolved,
                    adopted,
                  },
                );
              }
            }
          }
        }
      }
    }
  }
  for (const heading of correctionFollowupRelationshipHeadings) {
    for (const separator of separators) {
      for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
        const prompt = heading + separator + body;
        for (const [wrapper, wrapped, expected] of [
          ["bare", prompt, true],
          ["reported", `The reviewer said ${prompt}`, false],
          ["quoted", JSON.stringify(prompt), false],
          [
            "adopted",
            `The reviewer said ${prompt} Speaking for myself now: ${body}`,
            true,
          ],
        ]) {
          add(
            "relationship-heading",
            [heading, separator, bodyIndex, wrapper],
            wrapped,
            expected,
            { heading, separator, bodyIndex, wrapper },
          );
        }
      }
    }
  }
  for (const heading of correctionFollowupCommunicationHeadings) {
    for (const preposition of ["from", "by"]) {
      for (const [owner, expected] of [
        ["me", true],
        ["us", true],
        ["Alice", false],
        ["SRE", false],
        ["the lead", false],
      ]) {
        for (const separator of separators) {
          for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
            add(
              "communication-source",
              [heading, preposition, owner, separator, bodyIndex],
              `${heading} ${preposition} ${owner}${separator}${body}`,
              expected,
              { heading, preposition, owner, separator, bodyIndex },
            );
          }
        }
      }
    }
  }
  for (const topic of correctionFollowupTechnicalHeadings) {
    for (const heading of [topic, topic.toLowerCase(), topic.toUpperCase()]) {
      for (const separator of separators) {
        for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
          for (const [owner, prefix, expected] of [
            ["implicit", "", true],
            ["first-party", "My ", true],
            ["reported", "QA ", false],
          ]) {
            add(
              "technical-heading",
              [heading, separator, bodyIndex, owner],
              prefix + heading + separator + body,
              expected,
              { topic, heading, separator, bodyIndex, owner },
            );
          }
        }
      }
    }
  }
  for (const speaker of correctionFollowupAmbiguousNames) {
    for (const separator of separators) {
      for (const [bodyIndex, body] of correctionFollowupBodies.entries()) {
        for (const adopted of [false, true]) {
          add(
            "ambiguous-name",
            [speaker, separator, bodyIndex, adopted],
            speaker +
              separator +
              body +
              (adopted ? ` Speaking for myself now: ${body}` : ""),
            adopted,
            { speaker, separator, bodyIndex, adopted },
          );
        }
      }
    }
  }
  return Object.freeze(cases);
}

export const correctionFollowupRegressionCorpus = followupRegressionCases();

// Preserve all 20,280 original follow-up cells in their original order.
export const correctionFollowupContrastCorpus = Object.freeze([
  ...followupCorrectionCases(),
  ...correctionFollowupRegressionCorpus,
]);
