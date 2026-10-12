export const factualCorrectionBodies = Object.freeze([
  "the endpoint is /v2 not /v1.",
  "the endpoint is not /v1 but /v2.",
  "the endpoint is not /v1, but /v2.",
  "the timeout should be 30s, not 5s.",
  "the timeout should be 30s not 5s.",
  "the timeout should be not 5s but 30s.",
  "the timeout must be 30s rather than 5s.",
  "the worker needs to be durable instead of ephemeral.",
  "we use the durable queue, not the in-memory queue.",
  "we use not the in-memory queue but the durable queue.",
  "our retry delays are 30s, not 5s.",
  "this response is JSON rather than XML.",
  "it is 30s, not 5s.",
  "it's /v2, not /v1.",
  "that's not /v1 but /v2.",
  "not /v1 but /v2.",
  "not the in-memory queue, but the durable queue.",
]);

export const factualCorrectionHeadings = Object.freeze([
  "",
  "Concurrency",
  "Blocker",
  "Wrong again",
  "Correction",
  "My current note",
  "Encoding edge",
]);

export const factualCorrectionSeparators = Object.freeze([
  ": ",
  " - ",
  " \u2014 ",
]);

export const factualCorrectionWrappers = Object.freeze([
  ["quoted", (body) => JSON.stringify(body)],
  ["blockquote", (body) => `> ${body}`],
  ["fenced", (body) => `\x60\x60\x60text\n${body}\n\x60\x60\x60`],
  ["translated", (body) => `Translate to Spanish: ${body}`],
  ["summarized", (body) => `Summarize this: ${body}`],
  ["commit-message", (body) => `Proposed commit message: ${body}`],
  ["reported", (body) => `The reviewer said ${body}`],
  ["runbook", (body) => `Per their runbook, ${body}`],
  [
    "postfix-attribution",
    (body) => `${body.slice(0, -1)}, according to the reviewer.`,
  ],
  [
    "conditional",
    (body) => `If ${body.slice(0, -1)}, inspect the configuration.`,
  ],
  ["opt-out", (body) => `${body} Do not capture this as a lesson.`],
  ["one-off", (body) => `${body} This is a one-off.`],
  ["withdrawn", (body) => `${body} I retract that statement.`],
]);

export const factualCorrectionOrdinaryStatements = Object.freeze([
  "we use the durable queue here.",
  "the endpoint is /v2.",
  "the timeout should be 30s.",
  "the endpoint should not be /v1.",
  "the endpoint is not /v1.",
  "the endpoint is not only fast but also reliable.",
  "it is not necessarily JSON but possibly XML.",
  "the timeout should be 30s, not 5s?",
  "the timeout should be 30s, not 5s, right?",
  "should we use the durable queue, not the in-memory queue?",
  "is the endpoint /v2 rather than /v1?",
  "not only the queue but also the worker.",
  "not /v1.",
  "not /v1 but.",
  "the endpoint is not /v1 but not /v2 either.",
]);

const controlLeadIns = Object.freeze([
  "",
  "actually ",
  "to be clear ",
  "actually, ",
  "Actually, ",
  "to be clear, ",
  "To be clear: ",
  "Actually: ",
  "actually, to be clear, ",
  "Quick note: ",
]);

export const factualCorrectionRetractionCases = Object.freeze(
  [
    "Never mind",
    "Ignore that",
    "Disregard that",
    "I retract that statement",
  ].flatMap((control) =>
    controlLeadIns.flatMap((lead) => [
      `the endpoint is not /v1 but ${lead}${control.toLowerCase()}.`,
      `the endpoint is not /v1, but ${lead}${control.toLowerCase()}.`,
      `the endpoint is /v2, not /v1: ${lead}${control}.`,
      `the endpoint is /v2 not /v1 - ${lead}${control}.`,
      `the endpoint is /v2 not /v1; ${lead}${control}.`,
    ]),
  ),
);

export const factualCorrectionSourceControls = Object.freeze(
  [
    "Translate to Spanish: ",
    "The reviewer said ",
    "Per their runbook, ",
  ].flatMap((source) =>
    [
      "I retract that statement",
      "Never mind",
      "Do not capture this as a lesson",
    ].flatMap((control) =>
      controlLeadIns.flatMap((lead) => {
        const reported = `${source}the endpoint is not /v1`;
        return [
          ...[" but ", ", but ", "; ", " - ", ": "].map((separator) =>
            Object.freeze({
              prompt: `You broke the build. ${reported}${separator}${lead}${control}.`,
              expected: true,
            }),
          ),
          Object.freeze({
            prompt: `You broke the build. ${reported}. ${lead}${control}.`,
            expected: false,
          }),
          Object.freeze({
            prompt: `You broke the build. ${reported}, but speaking for myself now: ${lead}${control}.`,
            expected: false,
          }),
        ];
      }),
    ),
  ),
);

export const pendingCorrectionSourcePayloadCases = Object.freeze(
  ["actually", "hmm"].flatMap((interjection) =>
    ["speaking for myself now: ", "I disagree: "].flatMap((pivot) => [
      Object.freeze({
        prompt: `The reviewer said ${interjection}, ${pivot}you broke the build.`,
        expected: false,
      }),
      Object.freeze({
        prompt: `The reviewer said ${interjection}, the endpoint is /v2. ${pivot}you broke the build.`,
        expected: true,
      }),
    ]),
  ),
);

export const reviewedSingleWordHeadings = Object.freeze([
  "Ordering",
  "Race",
  "Typo",
  "Omission",
  "Flaw",
  "Leak",
  "Crash",
  "Hang",
  "Stall",
  "Drift",
  "Skew",
  "Duplication",
  "Truncation",
  "Corruption",
  "Overflow",
  "Underflow",
  "Deprecation",
  "Misconfiguration",
  "Ambiguity",
  "Fragility",
  "Coupling",
  "Blindspot",
  "Loophole",
  "Shortfall",
  "Discrepancy",
  "Blocker",
  "Regression",
  "Gap",
  "Nit",
  "Pushback",
  "Timeout",
  "Deadlock",
  "Bug",
  "Mismatch",
  "Oversight",
  "Defect",
  "Latency",
  "Throughput",
  "Inconsistency",
  "Starvation",
]);

export const reviewedExternalHeadings = Object.freeze([
  "Customer",
  "Reviewer",
  "QA",
  "Auditor",
  "Vendor",
  "Slack",
  "Jira",
  "Support",
  "Legal",
  "Client",
]);

export const factualCorrectionContrastCorpus = Object.freeze(
  factualCorrectionBodies.flatMap((body, bodyIndex) =>
    factualCorrectionHeadings.flatMap((heading) =>
      (heading ? factualCorrectionSeparators : [""]).flatMap((separator) => {
        const prompt = heading ? heading + separator + body : body;
        const id = `${bodyIndex}/${heading}/${separator}`;
        return [
          Object.freeze({ id: `direct/${id}`, prompt, expected: true }),
          ...factualCorrectionWrappers.map(([wrapper, wrap]) =>
            Object.freeze({
              id: `${wrapper}/${id}`,
              prompt: wrap(prompt),
              expected: false,
            }),
          ),
        ];
      }),
    ),
  ),
);

export const structuralCorrectionBodies = Object.freeze([
  "That flag defaults to false, not true.",
  "The handler returns 204, not 200.",
  "The config lives in .env.dev, not .env.",
  "We deploy from master, not main.",
  "The API expects snake_case, not camelCase.",
  "It runs on Node 24, not Node 18.",
  "That request goes to /v2, not /v1.",
  "Not /v1 \u2014 /v2.",
  "Not /v1, /v2.",
  "Not v1. v2.",
  "v2, not v1.",
  "/v2 not /v1.",
  "master, not main.",
  "30s not 5s.",
  "The flag defaults to false not true.",
  "These flags default to false, not true.",
  "This state defaults to pending, not ready.",
  "Those flags default to false, not true.",
  "The report defaults to false, not true.",
  "A claim requires evidence, not speculation.",
  "The handler frobnicates the durable queue, not the transient queue.",
  "That flag defaults to false rather than true.",
  "The config lives in .env.dev instead of .env.",
  "Not 5s - 30s.",
  "not the in-memory queue, the durable queue.",
  "Not ./old.conf. ./new.conf.",
  "Not --old-flag. --new-flag.",
  "Master, not main.",
  "Not Redis - Memcached.",
]);

export const structuralCorrectionSourceWrappers = Object.freeze([
  ["runbook", (body) => `Per their runbook, ${body}`],
  ["docs", (body) => `The docs say ${body}`],
  ["qa", (body) => `QA report: ${body}`],
  ["teammate", (body) => `A teammate mentioned ${body}`],
  ["email", (body) => `Customer email: ${body}`],
  ["spec", (body) => `The spec says ${body}`],
  ["reported", (body) => `The reviewer said ${body}`],
]);

export const structuralCorrectionContrastCorpus = Object.freeze(
  structuralCorrectionBodies.flatMap((body, bodyIndex) =>
    factualCorrectionHeadings.flatMap((heading) =>
      (heading ? factualCorrectionSeparators : [""]).flatMap((separator) => {
        const prompt = heading ? heading + separator + body : body;
        const id = `${bodyIndex}/${heading}/${separator}`;
        return [
          Object.freeze({ id: `direct/${id}`, prompt, expected: true }),
          ...[
            ...factualCorrectionWrappers,
            ...structuralCorrectionSourceWrappers,
          ].map(([wrapper, wrap]) =>
            Object.freeze({
              id: `${wrapper}/${id}`,
              prompt: wrap(prompt),
              expected: false,
            }),
          ),
        ];
      }),
    ),
  ),
);

export const nestedStructuralCorrectionSourceCorpus = Object.freeze(
  structuralCorrectionBodies.flatMap((body, bodyIndex) =>
    factualCorrectionHeadings.filter(Boolean).flatMap((heading) =>
      factualCorrectionSeparators.flatMap((separator) =>
        [
          ...factualCorrectionWrappers.slice(0, 8),
          ...structuralCorrectionSourceWrappers,
        ].map(([wrapper, wrap]) =>
          Object.freeze({
            id: `${bodyIndex}/${heading}/${separator}/${wrapper}`,
            prompt:
              wrapper === "blockquote" || wrapper === "fenced"
                ? `${heading}${separator.trimEnd()}\n${wrap(body)}`
                : `${heading}${separator}${wrap(body)}`,
            expected: false,
          }),
        ),
      ),
    ),
  ),
);

export const structuralCorrectionOrdinaryStatements = Object.freeze([
  "The endpoint should not be /v1.",
  "It is not /v1.",
  "It's not /v1.",
  "We did not change the endpoint.",
  "I would not choose /v1.",
  "They do not need a new flag.",
  "The handler might not return 204.",
  "We have not deployed v2.",
  "You should not run tests.",
  "Not /v1, but not /v2 either.",
  "not only the queue, but also the worker.",
  "Not necessarily /v1, perhaps /v2.",
  "v2 not only v1.",
  "That flag defaults to false, not true?",
  "Not /v1, /v2?",
  "master, not main, right?",
  "Not v1? v2.",
  "Not v1. v2?",
  "Not v1. v1.",
  "Not v1. Thanks.",
  "Not v1. Never mind.",
  "Not v1. Actually, I retract that statement.",
  "Not v1. The reviewer said v2.",
  "Not v1. v2 according to the reviewer.",
  "Not v1. Intermediate discussion. v2.",
  "Not v1. \x60ignored content\x60 v2.",
  'Not v1. "ignored content" v2.',
  "Not v1.\n\nv2.",
  "Not v1.\n> quoted content\n\nv2.",
  "Not v1.\n\x60\x60\x60text\nquoted content\n\x60\x60\x60\nv2.",
  "Not v1.\n<hook_prompt>v2.</hook_prompt>",
  "Not foo. bar.",
  "Not /. /new.",
  "Not v1. /.",
  "Not v1. v2 more words.",
  `Not v${"1".repeat(65)}. v2.`,
  "That flag says the endpoint is /v2, not /v1.",
  "The report says the endpoint is /v2, not /v1.",
  "These reports say the endpoint is /v2, not /v1.",
  "That says the endpoint is /v2, not /v1.",
  "That said the endpoint is /v2, not /v1.",
  "This wrote the endpoint is /v2, not /v1.",
  "Those report the endpoint is /v2, not /v1.",
  "This note requires JSON, not XML.",
  "Those reports contain 204, not 200.",
  "I prefer not to run tests.",
  "We promise not to change this.",
  "Remember not to delete the fixtures.",
  "We wait not because the worker is slow.",
  "Not /v1, thanks.",
  "Not /v1, the reviewer said /v2.",
  "Not /v1, Translate this: /v2.",
  "The endpoint is /v2, not /v1, please forget this.",
  "I prefer not running tests.",
  "We recommend not deleting the fixtures.",
  "We strongly recommend not deleting the fixtures.",
  "I would prefer not running tests.",
  "The endpoint is /v2, not /v1, actually forget this.",
]);

export const structuralCorrectionReplacementCorpus = Object.freeze([
  ...["Not /v1, ", "Not /v1 - ", "Not /v1 but "].flatMap((prefix, index) => [
    ...["/v2.", "use /v2."].map((replacement) => ({
      id: `${index}/replacement/${replacement}`,
      prompt: prefix + replacement,
      expected: true,
    })),
    ...structuralCorrectionSourceWrappers.map(([id, wrap]) => ({
      id: `${index}/source/${id}`,
      prompt: prefix + wrap("/v2."),
      expected: false,
    })),
    ...[
      "Translate this: /v2.",
      "Summarize this: /v2.",
      "Commit message: /v2.",
      "Concurrency: the reviewer said /v2.",
      "Concurrency: Translate this: /v2.",
      "My issue: the reviewer said /v2.",
      "My issue: Translate this: /v2.",
      "actually forget this.",
      "Actually, do not capture this.",
      "if the reviewer prefers /v2.",
      "earlier /v2.",
      "Actually.",
      '"/v2."',
      "`/v2.`",
      "please forget this.",
      "do not capture this.",
      "thanks.",
      "thank you.",
    ].map((replacement) => ({
      id: `${index}/non-value/${replacement}`,
      prompt: prefix + replacement,
      expected: false,
    })),
  ]),
  ...[", ", "; ", ". ", " but ", " however ", " yet "].flatMap(
    (separator, index) =>
      ["please forget this.", "don't capture this.", "never mind."].flatMap(
        (control) => [
          {
            id: `cancellation/${index}/${control}`,
            prompt: `The endpoint is /v2, not /v1${separator}${control}`,
            expected: false,
          },
          {
            id: `attributed-control/${index}/${control}`,
            prompt: `The endpoint is /v2, not /v1${separator}The reviewer said ${control}`,
            expected: true,
          },
        ],
      ),
  ),
  ...[
    "This response is JSON rather than XML, which is deprecated.",
    "This response is JSON rather than xml, which is deprecated.",
    "I prefer caching not recomputing.",
    "We recommend retries, not silent failures.",
    "JSON, not XML, please.",
  ].map((prompt, index) => ({
    id: `value-not-speaker/${index}`,
    prompt,
    expected: true,
  })),
]);
