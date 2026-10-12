const MAX_CONTEXT_CHARS = 4000;
const BOUNDARY_SEARCH_CHARS = 96;

// `scripts/sync-hook-core.mjs` refreshes this from the qualified generated-root
// receipt. Hook code uses the identity only to wake retained drafts after a
// trusted inspector change; it never accepts an identity from hook input.
export const PRIVATE_LEARNING_INSPECTOR_DIGEST =
  "sha256:79f414e69dc023c6682178594136f580d6f22314773445cc1eebe95217c2b7ae";

const USER_CORRECTION_CAPTURE_PREFIX = [
  "Remembrance user-correction capture:",
  "This prompt may contain a first-party correction. Decide from the full conversation whether one really occurred; resolve it now and capture only a generalized lesson reusable beyond this person and repository.",
];
const USER_CORRECTION_CAPTURE_SUFFIX =
  "Never send raw wording, repository content, paths, URLs, identifiers, or secrets; keep person-, repository-, and machine-specific facts in host-local memory.";
const USER_CORRECTION_CAPTURE_PRIVATE_ACTION =
  "Use capture_learning.lesson for a compact lesson or private_skill for a complete workflow, then follow its exact next_action or bounded agent_recovery instructions.";
const USER_CORRECTION_CAPTURE_FALLBACK_ACTION =
  "Use the private lesson lane for a compact lesson or propose a private skill for a complete workflow.";

export function userCorrectionCaptureDirectiveText(privateCapture) {
  return [
    ...USER_CORRECTION_CAPTURE_PREFIX,
    privateCapture
      ? USER_CORRECTION_CAPTURE_PRIVATE_ACTION
      : USER_CORRECTION_CAPTURE_FALLBACK_ACTION,
    USER_CORRECTION_CAPTURE_SUFFIX,
  ].join("\n");
}

const USER_CORRECTION_CAPTURE_MAX_CHARS = Math.max(
  userCorrectionCaptureDirectiveText(true).length,
  userCorrectionCaptureDirectiveText(false).length,
);

const REQUIRED_CONTEXT_ORDER = [
  "authority",
  "consent",
  "retention",
  "credential",
  "completion",
  "query_identity",
  "notice",
];
const OPTIONAL_CONTEXT_ORDER = ["preference", "candidate_additional", "other"];

// The required organization settings line is reserved whole, after the
// authority lines: it is either complete or names every exact key with a
// required fetch, so any cut would drop a key or that instruction. It becomes
// this keyless required fetch when it cannot fit beside the minimum core
// context, or when it would evict a query action the keyless fetch leaves
// room for.
const REQUIRED_SETTINGS_KIND = "required_settings";
const REQUIRED_SETTINGS_FALLBACK =
  "Required organization settings did not fit this context. Required next step before acting: call get_effective_preferences and apply every returned required organization setting in full. If the call is unavailable, say the complete required settings could not be loaded and do not claim they were applied.";
const CONTEXT_OUTPUT_ORDER = [
  ...REQUIRED_CONTEXT_ORDER.flatMap((kind) =>
    kind === "authority" ? [kind, REQUIRED_SETTINGS_KIND] : [kind],
  ),
  "query_action",
  "candidate_primary",
  "correction",
  ...OPTIONAL_CONTEXT_ORDER,
];

const KNOWN_CONTEXT_KINDS = new Set([
  ...REQUIRED_CONTEXT_ORDER,
  ...OPTIONAL_CONTEXT_ORDER,
  "query_action",
  "candidate_primary",
  "correction",
]);

const ATOMIC_REQUIRED_CONTEXT_KINDS = new Set([
  "consent",
  "retention",
  "credential",
  "completion",
  "query_identity",
  "correction",
  "notice",
]);

const WHOLE_REQUIRED_CONTEXT_KINDS = new Set(["correction"]);

const CORE_CONTEXT_BUDGETS = Object.freeze({
  authority: { minimum: 240, preferred: 760 },
  consent: { minimum: 220, preferred: 460 },
  retention: { minimum: 220, preferred: 460 },
  // The longest shipped credential-source notice is below 400 characters.
  // Keep that compact notice whole while leaving room for an exact query action.
  credential: { minimum: 400, preferred: 760 },
  completion: { minimum: 260, preferred: 560 },
  query_identity: { minimum: 220, preferred: 440 },
  notice: { minimum: 160, preferred: 360 },
  correction: {
    minimum: USER_CORRECTION_CAPTURE_MAX_CHARS,
    preferred: USER_CORRECTION_CAPTURE_MAX_CHARS,
  },
  candidate_primary: { minimum: 180, preferred: 420 },
});

const CORE_PREFERRED_EXPANSION_ORDER = [
  "completion",
  "consent",
  "retention",
  "credential",
  "query_identity",
  "notice",
  "authority",
  "candidate_primary",
  "correction",
];

const CORE_FULL_EXPANSION_ORDER = [
  "authority",
  "credential",
  "completion",
  "consent",
  "retention",
  "query_identity",
  "notice",
  "candidate_primary",
  "correction",
];

const OMISSION_NOTICE =
  "[Some lower-priority Remembrance context was omitted to fit the safety budget; query receipts and retained-draft recovery remain available.]";

const ATOMIC_OPTIONAL_KINDS = new Set(["preference"]);
const CONTINUATION_CONTEXT_KINDS = new Set([
  "candidate_primary",
  "candidate_additional",
  "query_action",
  "correction",
  "notice",
  ...ATOMIC_OPTIONAL_KINDS,
]);

const USER_CORRECTION_CAPTURE_REGEX_WINDOW_CHARS = 512;
// The two open-vocabulary replacement matchers have a bounded 512-character
// payload plus a lexical shell well below this allowance. Segment overlap is
// derived from the same contract so a valid match cannot straddle a flush.
const USER_CORRECTION_CAPTURE_REGEX_SHELL_CHARS = 128;

const USER_CORRECTION_CAPTURE_PATTERNS = [
  /\b(?:that|this|it)(?:\s+(?:(?:completed|proposed|current|chosen)\s+)?(?:approach|implementation|design|result))?(?:'s|\s+(?:is|was|looks?|feels?))\s+(?:wrong|incorrect|overkill|too much|overcomplicated|the wrong (?:way|approach|direction))\b/i,
  /\b(?:please\s+)?(?:do (?:this|it) differently|use a different approach)\b/i,
  /\b(?:you|we)\s+(?:missed|forgot|overlooked|ignored|did not address|didn't address|failed to address)\s+(?:the\s+)?(?:actual\s+)?(?:(?:requested|required|expected|agreed(?:-upon)?)\s+)?(?:requirement|constraint|edge case|case|issue|failure(?: mode)?|step|request|point|behavior|regression)\b/i,
  /\b(?:this|that|it)(?:(?:'s|\s+(?:is|was))\s+not|\s+(?:isn't|wasn't))\s+what\s+i\s+(?:asked|requested)\b/i,
  /\byou\s+(?:broke|regressed)\s+(?:this|that|it|the\s+(?:build|flow|feature|behavior))\b/i,
  /\b(?:that|this|the)\s+(?:(?:actual|current|latest|new)\s+)?(?:change|implementation|patch)\s+(?:broke|regressed)\s+(?:this|that|it|the\s+(?:build|flow|feature|behavior))\b/i,
  /\b(?:i already (?:asked (?:you\s+)?(?:to|not to|for)|said (?:that|not to)|told you)|as i (?:said|asked|explained)|you keep (?:(?:missing|forgetting) (?:the )?(?:requirement|constraint|case|issue|step|point)|(?:doing|adding|removing) (?:this|that|the wrong thing)))\b/i,
  /\bi (?:do not|don't) (?:like|agree with|want) (?:this|that|the) (?:approach|direction|implementation|design|result)\b/i,
  /\b(?:i|we)\s+(?:(?:no\s+longer|do\s+not|don't)\s+(?:agree\s+with|accept|endorse|support|want|prefer|believe\s+in)|now\s+disagree\s+with)\s+(?:this|that|the)\s+(?:approach|direction|implementation|design|result|plan)\b/i,
  /\b(?:please\s+)?(?:revert|undo|discard|reject) (?:that|this|the (?:approach|implementation|change|design|result))\b/i,
  /\bi\s+(?:said|asked|told\s+you)(?:\s+you)?(?:\s+to)?\s+(?:use|follow|run|keep|avoid|remove|add|change|switch\s+to)\b/i,
  new RegExp(
    String.raw`\bactually,?\s+(?:please\s+)?(?:use|follow|run|keep|avoid|remove|add|change|switch\s+to)\b[^.!?;]{0,${USER_CORRECTION_CAPTURE_REGEX_WINDOW_CHARS}}\binstead\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:please\s+)?(?:use|follow|run|keep|avoid|remove|add|change|switch\s+to)\b[^.!?;]{0,${USER_CORRECTION_CAPTURE_REGEX_WINDOW_CHARS}}\binstead\b`,
    "i",
  ),
];
const USER_CORRECTION_CAPTURE_MATCHERS = USER_CORRECTION_CAPTURE_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags}g`),
);

export function composeBoundedHookContext(context, additions = []) {
  return composeBoundedHookContextResult(context, additions).context;
}

export function composeBoundedHookContextResult(context, additions = []) {
  const sections = hookContextSections(context, additions);
  if (sections.length === 0) {
    return { context: "", deliveredAdditionIds: [] };
  }
  const ordered = orderedContextSections(sections);
  const full = ordered.map((section) => section.text).join("\n");
  if (full.length <= MAX_CONTEXT_CHARS) {
    return {
      context: full,
      deliveredAdditionIds: deliveredAdditionIds(
        ordered,
        ordered.map((section) => ({ ...section, complete: true })),
      ),
    };
  }

  const contentBudget = MAX_CONTEXT_CHARS - OMISSION_NOTICE.length - 1;
  const queryActions = sections.filter(
    (section) => section.kind === "query_action",
  );
  const coreGroups = [
    ...REQUIRED_CONTEXT_ORDER.map((kind) => mergeContextKind(sections, kind)),
    mergeContextKind(sections, "candidate_primary"),
    mergeContextKind(sections, "correction"),
  ].filter(Boolean);
  const minimumCoreLength = coreGroups.reduce(
    (total, section) =>
      total +
      Math.min(section.text.length, CORE_CONTEXT_BUDGETS[section.kind].minimum),
    0,
  );
  // Exact sections: the required settings first, then query actions. The
  // keyed settings line gives way to the shorter keyless fetch before any
  // query action is evicted for it.
  const reserveQueryActions = (required) => {
    const exact = required ? [required] : [];
    for (const section of queryActions) {
      const candidate = [...exact, section];
      const separators = Math.max(0, coreGroups.length + candidate.length - 1);
      if (
        minimumCoreLength + joinedSectionLength(candidate) + separators <=
        contentBudget
      ) {
        exact.push({ ...section, complete: true });
      }
    }
    return exact;
  };
  const requiredSettings = mergeContextKind(sections, REQUIRED_SETTINGS_KIND);
  const keyedSettingsFit =
    requiredSettings &&
    minimumCoreLength + requiredSettings.text.length + coreGroups.length <=
      contentBudget;
  const requiredOptions = requiredSettings
    ? [
        ...(keyedSettingsFit ? [{ ...requiredSettings, complete: true }] : []),
        {
          ...requiredSettings,
          text: REQUIRED_SETTINGS_FALLBACK,
          complete: false,
        },
      ]
    : [null];
  // The first option keeping the most query actions wins: the keyed line
  // unless the keyless fetch keeps one more.
  const reserved = requiredOptions
    .map(reserveQueryActions)
    .reduce((best, next) => (next.length > best.length ? next : best));
  const exactActionLength = joinedSectionLength(reserved);
  const separatorCount = Math.max(0, coreGroups.length + reserved.length - 1);
  const flexibleBudget = Math.max(
    0,
    contentBudget - exactActionLength - separatorCount,
  );
  const coreBudgets = allocateCoreContextBudgets(coreGroups, flexibleBudget);
  const selectedSections = renderAndExpandCoreContext(
    coreGroups,
    coreBudgets,
    flexibleBudget,
  );
  selectedSections.push(...reserved);

  const optional = OPTIONAL_CONTEXT_ORDER.flatMap((kind) =>
    sections.filter((section) => section.kind === kind),
  );
  for (const section of optional) {
    const remaining =
      contentBudget -
      joinedSectionLength(selectedSections) -
      (selectedSections.length > 0 ? 1 : 0);
    if (remaining <= 0) continue;
    if (section.text.length <= remaining) {
      selectedSections.push({ ...section, complete: true });
      continue;
    }
    if (ATOMIC_OPTIONAL_KINDS.has(section.kind)) continue;
    if (remaining >= 80) {
      selectedSections.push({
        ...section,
        text: boundedContextSection(section.text, remaining),
        complete: false,
      });
    }
  }

  const selected = orderedContextSections(selectedSections);
  const bounded = [...selected.map((section) => section.text), OMISSION_NOTICE]
    .filter(Boolean)
    .join("\n");
  /* c8 ignore next 5 -- allocator arithmetic is fail-closed; source-mutation tests exercise this invariant */
  if (bounded.length > MAX_CONTEXT_CHARS) {
    throw new Error(
      "Remembrance hook context allocator exceeded its hard budget.",
    );
  }
  return {
    context: bounded,
    deliveredAdditionIds: deliveredAdditionIds(sections, selected),
  };
}

function orderedContextSections(sections) {
  return CONTEXT_OUTPUT_ORDER.flatMap((kind) =>
    sections.filter((section) => section.kind === kind),
  );
}

function mergeContextKind(sections, kind) {
  const matches = sections.filter((section) => section.kind === kind);
  if (matches.length === 0) return null;
  return {
    kind,
    text: matches.map((section) => section.text).join("\n"),
    parts: matches.map((section) => section.text),
    sourceIds: [...new Set(matches.flatMap((section) => section.sourceIds))],
    sourceKey: `merged:${kind}`,
  };
}

function allocateCoreContextBudgets(sections, totalBudget) {
  if (sections.length === 0) return [];
  const floors = sections.map((section) =>
    Math.min(section.text.length, CORE_CONTEXT_BUDGETS[section.kind].minimum),
  );
  const essential = sections.map((section) =>
    Math.min(section.text.length, minimumCoreContextBudget(section)),
  );
  const preferred = sections.map((section) =>
    Math.min(section.text.length, CORE_CONTEXT_BUDGETS[section.kind].preferred),
  );
  const budgets = [...floors];
  let remaining = Math.max(0, totalBudget - budgets.reduce((a, b) => a + b, 0));
  remaining = growContextBudgets(budgets, essential, remaining);
  remaining = growContextBudgets(budgets, preferred, remaining);
  growContextBudgets(
    budgets,
    sections.map((section) => section.text.length),
    remaining,
  );
  return budgets;
}

function minimumCoreContextBudget(section) {
  const configured = CORE_CONTEXT_BUDGETS[section.kind].minimum;
  if (WHOLE_REQUIRED_CONTEXT_KINDS.has(section.kind)) {
    return configured;
  }
  if (!ATOMIC_REQUIRED_CONTEXT_KINDS.has(section.kind)) {
    return configured;
  }
  const units = completeDirectiveUnits(section.text).filter(
    (unit) => directivePriority(unit) <= 1,
  );
  if (units.length === 0) return configured;
  const marker = `[Additional ${contextKindLabel(section.kind)} context omitted.]`;
  const essentialLength = joinedLength(units) + marker.length + 1;
  return Math.max(configured, Math.min(section.text.length, essentialLength));
}

function renderAndExpandCoreContext(sections, budgets, totalBudget) {
  const selected = sections.map((section, index) =>
    renderCoreContextSection(section, budgets[index]),
  );
  expandCoreContext(
    sections,
    selected,
    totalBudget,
    CORE_PREFERRED_EXPANSION_ORDER,
    (section) => CORE_CONTEXT_BUDGETS[section.kind].preferred,
  );
  expandCoreContext(
    sections,
    selected,
    totalBudget,
    CORE_FULL_EXPANSION_ORDER,
    (section) => section.text.length,
  );
  return selected.filter((section) => section.text);
}

function renderCoreContextSection(section, budget) {
  const text = boundedRequiredContextSection(
    section.text,
    budget,
    section.kind,
  );
  return {
    ...section,
    text,
    complete: text === section.text,
  };
}

function expandCoreContext(
  sections,
  selected,
  totalBudget,
  kindOrder,
  targetBudget,
) {
  for (const kind of kindOrder) {
    const index = sections.findIndex((section) => section.kind === kind);
    if (index < 0) continue;
    const used = joinedSectionLength(
      selected.filter((section) => section.text),
    );
    const remaining = totalBudget - used;
    if (remaining <= 0) return;
    const current = selected[index];
    const section = sections[index];
    const maximumOutputLength = Math.min(
      targetBudget(section),
      current.text.length + remaining,
    );
    if (maximumOutputLength <= current.text.length) continue;
    const expanded = renderCoreContextSection(section, maximumOutputLength);
    if (expanded.text.length > current.text.length) selected[index] = expanded;
  }
}

function growContextBudgets(budgets, targets, available) {
  let remaining = available;
  const active = new Set(
    budgets
      .map((value, index) => (value < targets[index] ? index : null))
      .filter((index) => index !== null),
  );
  while (remaining > 0 && active.size > 0) {
    const share = Math.max(1, Math.floor(remaining / active.size));
    for (const index of [...active]) {
      const increase = Math.min(share, targets[index] - budgets[index]);
      budgets[index] += increase;
      remaining -= increase;
      if (budgets[index] >= targets[index]) active.delete(index);
      if (remaining <= 0) break;
    }
  }
  return remaining;
}

function boundedRequiredContextSection(value, maxLength, kind) {
  const normalized = String(value).trim();
  if (normalized.length <= maxLength) return normalized;
  if (WHOLE_REQUIRED_CONTEXT_KINDS.has(kind)) {
    const marker = `[${contextKindLabel(kind)} context omitted as one complete directive.]`;
    return marker;
  }
  if (ATOMIC_REQUIRED_CONTEXT_KINDS.has(kind)) {
    return boundedAtomicRequiredContext(normalized, maxLength, kind);
  }
  const marker = `\n[Remaining ${contextKindLabel(kind)} context omitted; do not infer omitted guidance.]`;
  const head = boundedContextHead(normalized, maxLength - marker.length);
  return `${head}${marker}`;
}

function boundedContextHead(value, maxLength) {
  const boundaryFloor = Math.max(0, maxLength - BOUNDARY_SEARCH_CHARS);
  const candidate = Math.max(
    value.lastIndexOf("\n", maxLength),
    value.lastIndexOf(" ", maxLength),
  );
  return value.slice(0, candidate >= boundaryFloor ? candidate : maxLength);
}

function boundedAtomicRequiredContext(value, maxLength, kind) {
  const marker = `[Additional ${contextKindLabel(kind)} context omitted.]`;
  const units = completeDirectiveUnits(value);
  const selected = [];
  const available = maxLength - marker.length - 1;
  const prioritized = units
    .map((text, index) => ({ text, index, priority: directivePriority(text) }))
    .sort(
      (left, right) =>
        left.priority - right.priority || left.index - right.index,
    );
  let used = 0;
  for (const unit of prioritized) {
    const separator = selected.length > 0 ? 1 : 0;
    if (used + separator + unit.text.length > available) continue;
    selected.push(unit);
    used += separator + unit.text.length;
  }
  selected.sort((left, right) => left.index - right.index);
  return [...selected.map((unit) => unit.text), marker].join("\n");
}

function createCompleteDirectiveUnitsScanner(measureWork) {
  return function scanCompleteDirectiveUnits(value) {
    const work = measureWork
      ? {
          boundarySpanCodeUnits: 0,
          cursorAdvances: 0,
          lineCount: 0,
          punctuationChecks: 0,
        }
      : null;
    const units = value
      .split(/\n+/u)
      .flatMap((line) => {
        if (measureWork) work.lineCount += 1;
        return splitDirectiveLine(line, work, measureWork);
      })
      .map((unit) => unit.trim())
      .filter(Boolean);
    if (!measureWork) return units;
    return {
      unitCount: units.length,
      work: {
        ...work,
        total:
          work.boundarySpanCodeUnits +
          work.cursorAdvances +
          work.lineCount +
          work.punctuationChecks,
      },
    };
  };
}

const scanCompleteDirectiveUnits = createCompleteDirectiveUnitsScanner(false);
const scanCompleteDirectiveUnitsWithWork =
  createCompleteDirectiveUnitsScanner(true);

export function completeDirectiveUnits(value) {
  return scanCompleteDirectiveUnits(value);
}

export function measureCompleteDirectiveUnitsWorkForTests(value) {
  return scanCompleteDirectiveUnitsWithWork(value);
}

function splitDirectiveLine(line, work, measureWork) {
  const units = [];
  let start = 0;
  let cursor = 0;
  let tokenStart = 0;
  while (cursor < line.length) {
    if (/\s/u.test(line[cursor])) {
      cursor += 1;
      if (measureWork) work.cursorAdvances += 1;
      tokenStart = cursor;
      continue;
    }
    if (!isDirectivePunctuation(line[cursor])) {
      cursor += 1;
      if (measureWork) work.cursorAdvances += 1;
      continue;
    }
    const punctuationStart = cursor;
    while (cursor < line.length && isDirectivePunctuation(line[cursor])) {
      cursor += 1;
      if (measureWork) work.cursorAdvances += 1;
    }
    if (cursor < line.length && !/\s/u.test(line[cursor])) {
      continue;
    }
    if (
      !isDirectiveSentenceBoundary(
        line,
        tokenStart,
        punctuationStart,
        cursor,
        work,
        measureWork,
      )
    ) {
      continue;
    }
    units.push(line.slice(start, cursor));
    while (cursor < line.length && /\s/u.test(line[cursor])) {
      cursor += 1;
      if (measureWork) work.cursorAdvances += 1;
    }
    start = cursor;
    tokenStart = cursor;
  }
  if (start < line.length) units.push(line.slice(start));
  return units;
}

function isDirectivePunctuation(value) {
  return value === "." || value === "!" || value === "?";
}

function isDirectiveSentenceBoundary(
  line,
  tokenStart,
  punctuationStart,
  punctuationEnd,
  work = null,
  measureWork = false,
) {
  if (measureWork) {
    work.boundarySpanCodeUnits += punctuationEnd - tokenStart;
  }
  if (punctuationEnd >= line.length) return true;
  for (let index = punctuationStart; index < punctuationEnd; index += 1) {
    if (measureWork) work.punctuationChecks += 1;
    if (line[index] === "!" || line[index] === "?") return true;
  }

  const token = line.slice(tokenStart, punctuationEnd);
  // Internal URL, path, version, and dotted-name periods do not reach this
  // branch because they are not followed by whitespace. Only the terminal
  // period of a real abbreviation needs to suppress a sentence split.
  return !/^(?:e\.g\.|i\.e\.|etc\.|vs\.|[A-Z](?:\.[A-Z]){1,}\.)$/u.test(token);
}

function directivePriority(value) {
  if (
    /^(?:do not|never)\b|\b(?:host denial|authorization|policy|validation|safety|terminal holds?)\b.*\b(?:another transport|auto-delete|automatically)\b/iu.test(
      value,
    )
  )
    return 0;
  if (
    /\b(?:inspect_private_learning_outbox|submit_private_lesson_candidate|submit_private_skill_candidate|retry tool|query_id|result_id)\b/u.test(
      value,
    )
  )
    return 1;
  return 2;
}

function contextKindLabel(kind) {
  return String(kind).replaceAll("_", " ");
}

function joinedLength(values) {
  return values.reduce(
    (length, value, index) => length + value.length + (index > 0 ? 1 : 0),
    0,
  );
}

function joinedSectionLength(sections) {
  return joinedLength(sections.map((section) => section.text));
}

function deliveredAdditionIds(allSections, selectedSections) {
  const expected = new Map();
  const delivered = new Map();
  for (const section of allSections) {
    for (const id of section.sourceIds) {
      expected.set(id, (expected.get(id) ?? 0) + 1);
    }
  }
  for (const section of selectedSections) {
    if (section.complete !== true) continue;
    for (const id of section.sourceIds) {
      delivered.set(id, (delivered.get(id) ?? 0) + 1);
    }
  }
  return [...expected.entries()]
    .filter(([id, count]) => delivered.get(id) === count)
    .map(([id]) => id);
}

export function boundedContextSection(value, maxLength) {
  const normalized = String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength < 4) return "";
  const budget = maxLength - 3;
  const boundaryFloor = Math.max(0, budget - BOUNDARY_SEARCH_CHARS);
  const newline = normalized.lastIndexOf("\n", budget);
  const space = normalized.lastIndexOf(" ", budget);
  const candidate = Math.max(newline, space);
  const boundary = candidate >= boundaryFloor ? candidate : budget;
  return `${normalized.slice(0, boundary).trimEnd()}...`;
}

export function promptContainsFirstPartyCorrection(
  prompt,
  { hostNotification = false } = {},
) {
  if (hostNotification) return false;
  return correctionPromptContainsFirstPartyCorrection(String(prompt ?? ""));
}

function hookContextSections(context, additions) {
  let candidateSeen = false;
  const values = [
    { text: context, id: null, kind: null },
    ...additions.map((addition) =>
      addition && typeof addition === "object"
        ? {
            text: addition.text,
            id: String(addition.id ?? "").trim() || null,
            kind: String(addition.kind ?? "").trim() || null,
          }
        : { text: addition, id: null, kind: null },
    ),
  ].filter((value) => value.text);
  const sections = [];
  for (const value of values) {
    if (value.kind) {
      const text = String(value.text).replace(/\r\n?/gu, "\n").trim();
      if (text) {
        sections.push({
          kind: KNOWN_CONTEXT_KINDS.has(value.kind) ? value.kind : "notice",
          text,
          sourceIds: value.id ? [value.id] : [],
          sourceKey: `typed:${sections.length}:${value.id ?? ""}`,
        });
      }
      continue;
    }
    const lines = String(value.text)
      .replace(/\r\n?/gu, "\n")
      .split(/\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    let current = null;
    for (const line of lines) {
      const explicitKind = explicitContextKindForLine(line, candidateSeen);
      const genericKind = genericRequiredContextKindForLine(line);
      if (explicitKind) {
        if (
          current &&
          /^(?:Skills:|Resources:)$/u.test(current.text) &&
          /^- \[(?:HIGH|POSSIBLE|EXPLORATORY) MATCH\]/u.test(line)
        ) {
          current.text += `\n${line}`;
          candidateSeen = true;
          continue;
        }
        if (current) sections.push(current);
        current = { kind: explicitKind, text: line, sourceIds: [] };
        if (/^- \[(?:HIGH|POSSIBLE|EXPLORATORY) MATCH\]/u.test(line)) {
          candidateSeen = true;
        }
      } else if (
        genericKind &&
        current &&
        !CONTINUATION_CONTEXT_KINDS.has(current.kind)
      ) {
        sections.push(current);
        current = { kind: genericKind, text: line, sourceIds: [] };
      } else if (current?.kind === REQUIRED_SETTINGS_KIND) {
        // The reserved settings line stays exactly one line; a following
        // unclassified line keeps its former authority treatment.
        sections.push(current);
        current = { kind: "authority", text: line, sourceIds: [] };
      } else if (current) {
        current.text += `\n${line}`;
      } else {
        current = {
          kind: genericKind ?? "other",
          text: line,
          sourceIds: [],
        };
      }
    }
    if (current) sections.push(current);
  }
  const seen = new Map();
  return sections.filter((section, index) => {
    section.sourceKey ??= `parsed:${index}`;
    const identityKind = section.kind.startsWith("candidate_")
      ? "candidate"
      : section.kind;
    const identity = `${identityKind}\0${section.text}`;
    const previous = seen.get(identity);
    if (previous) {
      previous.sourceIds.push(
        ...section.sourceIds.filter((id) => !previous.sourceIds.includes(id)),
      );
      return false;
    }
    seen.set(identity, section);
    return true;
  });
}

function explicitContextKindForLine(line, candidateSeen) {
  if (line === OMISSION_NOTICE) return "other";
  if (/^Required organization settings\b/iu.test(line)) {
    return REQUIRED_SETTINGS_KIND;
  }
  if (
    /^(?:Organization policy|Remembrance (?:auto-query|query-unavailable|capture routing|task-continuation) context|Trigger:)/iu.test(
      line,
    )
  )
    return "authority";
  if (/^(?:Query receipt:|HIGH MATCH\b(?!\s+—))/u.test(line)) {
    return "query_identity";
  }
  if (/^HIGH MATCH\s+—/u.test(line)) return "query_action";
  if (/^- \[HIGH MATCH\]/u.test(line)) {
    return candidateSeen ? "candidate_additional" : "candidate_primary";
  }
  if (/^Remembrance user-correction capture:/u.test(line)) return "correction";
  if (
    /\b(?:preference capture|Discretionary preferences|Preference compatibility|Private preference evidence)\b/iu.test(
      line,
    )
  )
    return "preference";
  if (
    /^(?:Remembrance credential source:|Remembrance setup needs attention:)/u.test(
      line,
    )
  )
    return "credential";
  if (
    /^(?:After using Remembrance:|Before finishing|Remembrance private-learning recovery|Delegating this task\?)/u.test(
      line,
    )
  )
    return "completion";
  if (/^- \[(?:POSSIBLE|EXPLORATORY) MATCH\]/u.test(line)) {
    return candidateSeen ? "candidate_additional" : "candidate_primary";
  }
  if (/^(?:Skills:|Resources:)/u.test(line)) {
    return candidateSeen ? "candidate_additional" : "candidate_primary";
  }
  return null;
}

function genericRequiredContextKindForLine(line) {
  if (
    /\b(?:authorization|authorize|approval|approved destination|host denial|exact (?:private )?(?:submission )?action|never (?:switch|change) (?:destination|visibility|transport))\b/iu.test(
      line,
    )
  )
    return "consent";
  if (
    /\b(?:draft remains|retained (?:draft|locally)|outbox|never auto-delete|unresolved draft|retry_scheduled|awaiting_authorization)\b/iu.test(
      line,
    )
  )
    return "retention";
  return null;
}
const CORRECTION_WINDOW_CHARS = 8192;
const CORRECTION_WINDOW_OVERLAP_CHARS = 1024;
const CORRECTION_INLINE_BUFFER_CHARS = 8192;

const CORRECTION_DIRECT_PATTERNS = Object.freeze([
  ...USER_CORRECTION_CAPTURE_PATTERNS,
  /\b(?:this|that|the)\s+(?:(?:current|latest|new|actual)\s+)?(?:change|patch|implementation|design|result|approach)\s+(?:broke|regressed)\s+(?:the\s+)?(?:build|flow|feature|behavior)\b/iu,
  /\b(?:please\s+)?(?:revert|undo|discard|reject)\s+(?:this|that|the)\s+(?:change|patch|implementation|design|result|approach)\b/iu,
  /\b(?:please\s+)?use\b.{0,512}?\binstead\b/iu,
  /\b(?:my|our)\s+(?:current|new|latest|actual)\s+correction\b/iu,
  /\b(?:you|we)\s+(?:(?:keep|kept)\s+)?(?:misread|misunderstood|misinterpreted|ignored|ignoring)\s+(?:(?:my|our|the|this|that|actual|stated)\s+){0,2}(?:request|spec(?:ification)?|requirement|constraint|instructions?|intent)\b/iu,
  /\b(?:this|that|the)\s+[\p{L}\p{M}-]{1,48}\s+(?:you|we)\s+(?:wrote|made|produced|changed|implemented)\s+(?:is|was|remains)\s+(?:still\s+)?(?:wrong|incorrect|broken)\b/iu,
  /\b(?:this|that|the)\s+(?:[\p{L}\p{M}-]{1,48}\s+){1,5}(?:is|was|remains)\s+(?:still\s+)?(?:wrong|incorrect)\b/iu,
  /\b(?:this|that|it)(?:'s|\s+(?:is|was))\s+(?:still\s+)?broken\b/iu,
  /\byou\s+(?:deleted|removed|edited|changed|updated|replaced)\s+(?:the|a)\s+wrong\s+[\p{L}\p{M}-]{1,48}\b/iu,
  /\byou(?:'re|\s+are)\s+(?:solving|addressing|fixing|implementing)\s+(?:the|a)\s+wrong\s+(?:problem|issue|requirement|request|feature)\b/iu,
  /\b(?:this|that|the)\s+(?:[\p{L}\p{M}-]{1,48}\s+){1,5}(?:doesn't|does\s+not)\s+(?:match|reflect|follow|address)\s+what\s+i\s+(?:described|requested|asked|specified)\b/iu,
  /\b(?:please\s+)?stop\s+(?:rewriting|repeating|ignoring|replacing|deleting)\s+(?:the|my|our|this|that|these|those)\s+[\p{L}\p{M}-]{1,48}\b/iu,
]);

const CORRECTION_FACTUAL_TOKEN = String.raw`(?!(?:not|never|but|however|yet|rather|instead)\b)(?=[\p{L}\p{M}\p{N}'_+./:=<>%-]{0,63}[\p{L}\p{N}])[\p{L}\p{N}_+./-][\p{L}\p{M}\p{N}'_+./:=<>%-]{0,63}(?<!:)`;
const CORRECTION_FACTUAL_VALUE = String.raw`${CORRECTION_FACTUAL_TOKEN}(?:\s+${CORRECTION_FACTUAL_TOKEN}){0,7}`;
const CORRECTION_FACTUAL_ASSERTION = String.raw`${CORRECTION_FACTUAL_TOKEN}(?:\s+${CORRECTION_FACTUAL_TOKEN}){0,15}`;
const CORRECTION_FACTUAL_LEFT = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}_./:-])(?<assertion>${CORRECTION_FACTUAL_ASSERTION})$`,
  "iu",
);
const CORRECTION_FACTUAL_NEGATIVE_LEFT = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}_./:-])(?:${CORRECTION_FACTUAL_ASSERTION}\s+)?not\s+(?!(?:only|just|merely|necessarily|always)\s)${CORRECTION_FACTUAL_VALUE}$`,
  "iu",
);
const CORRECTION_FACTUAL_RIGHT = new RegExp(
  String.raw`^(?!(?:only|just|merely|necessarily|always|to|because|although|unless|whether|if|when)\s)${CORRECTION_FACTUAL_VALUE}`,
  "iu",
);
const CORRECTION_FACTUAL_CONNECTORS =
  /(?<positiveConnector>(?:\s*,\s*|\s+)(?:not|rather\s+than|instead\s+of)\s+)|(?<negativeConnector>\s*,\s*(?:but\s+)?|\s+(?:but\s+|[\u2014-]\s+))/dgiu;
// Auxiliary negation ("should not be") is not a replacement contrast. The
// assertion vocabulary stays open; this is grammar, not a list of task verbs.
const CORRECTION_FACTUAL_NEGATED_AUXILIARY =
  /\b(?:am|is|are|was|were|be|been|being|do|does|did|have|has|had|can|could|may|might|must|shall|should|will|would|need|dare|ought|it's|that's|this's)$/iu;
const CORRECTION_FACTUAL_UNARY_SUBJECT =
  /^(?:i|we)\s+(?:(?:[\p{L}]+ly|would|could|should|will|can|may|might|do|did)\s+){0,3}[\p{L}]+$/iu;
const CORRECTION_FACTUAL_ATOM = new RegExp(
  String.raw`^${CORRECTION_FACTUAL_TOKEN}$`,
  "iu",
);

const CORRECTION_FIRST_PARTY_LABEL =
  /^(?:feedback\s+from\s+(?:me|us|myself)|the\s+issue|in\s+review|security|reliability|client(?:-side|\s+api)|customer-facing|reviewer\s+mode|implementation\s+detail|from\s+my\s+(?:code\s+|design\s+|security\s+)?review|my\s+(?:feedback|assessment|finding)|our\s+(?:feedback|assessment|finding|internal\s+review|security\s+finding)|(?:my|our)\s+(?:runbook|test\s+plan|implementation\s+notes?|requirements?|plan)\s+(?:says|requires|specifies|states)|per\s+the\s+(?:agreed\s+plan|plan\s+we\s+agreed\s+on)|according\s+to\s+our\s+agreed\s+plan|(?:per|according\s+to|from)\s+(?:my|our)\s+(?:(?:architecture|code|design|security|implementation|internal)\s+)?(?:review|postmortem|requirements?|notes?|findings?)|(?:per|according\s+to|from)\s+the\s+(?:plan|requirements?|review|postmortem|notes?)\s+(?:i|we)\s+(?:wrote|authored|created))\s*(?:[:\u2014-]\s*|,\s*)/iu;

const CORRECTION_FIRST_PARTY_POSSESSIVE_LABEL =
  /^(?:(?:per|according\s+to|from)\s+)?(?:my|our)\s+(?:(?:actual|additional|agreed|current|deployment|earlier|final|implementation|latest|new|operational|own|previous|prior|recent|release|specific|testing|unresolved)\s+){0,3}(?:addendum|aside|caveat|checklist|clarification|comment|concern|constraint|context|correction|detail|discussion|exception|exchange|feedback|finding|follow-up|instruction|issue|message|note|nuance|observation|plan|point|postmortem|question|rationale|reminder|request|requirement|review|runbook|thought|update|warning|wrinkle)\s*(?:[:\u2014-]\s*|,\s*)/iu;

const CORRECTION_REFERENCE_FRAME =
  /^(?:to\s+[\p{L}\p{M}-]{1,48}|[\p{L}\p{M}-]{1,45}ing)(?:\s+(?:on|up|to|about|upon|with)){0,3}\s+/iu;

const CORRECTION_WITHDRAWN_REFERENCE =
  /^(?:retract(?:ing)?|withdraw(?:ing)?)\b/iu;

// A communication has an author; a technical relationship such as
// "grouping by tenant" or "regression from caching" does not imply one.
const CORRECTION_ATTRIBUTED_SOURCE_NOUN = String.raw`(?:alerts?|assessments?|comments?|communications?|complaints?|dms?|drafts?|emails?|escalations?|excerpts?|feedback|findings?|messages?|notes?|postmortems?|quotes?|reports?|requests?|reviews?|summar(?:y|ies)|threads?|transcripts?|forwarded|provided|sent|shared)`;
const CORRECTION_ATTRIBUTED_HEADING = new RegExp(
  String.raw`^(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}\s+){0,5}${CORRECTION_ATTRIBUTED_SOURCE_NOUN}\s+(?:from|by)\s+(?<owner>[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}(?:\s+[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}){0,5})(?:\s*:\s*|\s+[\u2014-]\s*)`,
  "iu",
);

const CORRECTION_REVIEW_TOPIC_NOUN =
  /^(?:block(?:er|age)s?|bugs?|defects?|errors?|failures?|faults?|gaps?|inconsistenc(?:y|ies)|mismatch(?:es)?|nit(?:pick)?s?|objections?|oversights?|pushback|regressions?)$/iu;

// Keep ambiguous names (Mark, May, Trace, Race) out of this bounded vocabulary.
// A role, explicit owner, or multiword personal name still takes precedence.
const CORRECTION_TECHNICAL_TOPIC_NOUN =
  /^(?:deadlocks?|livelocks?|starvation|timeouts?|latenc(?:y|ies)|throughput|concurrency|contention|backpressure|(?:de)?serializations?|(?:en|de)codings?|lifecycles?)$/iu;

const CORRECTION_AUTHORIAL_LABEL =
  /^(?:fyi|important|again|heads\s+up|one\s+(?:additional|final|last|more)\s+thing|(?:(?:a|an|another|one|the)\s+)?(?:(?:additional|current|different|final|further|important|last|latest|new|operational|practical|related|release|separate|small|specific|unresolved|compatibility|deployment|implementation|reliability|security|testing)\s+){0,2}(?:addendum|aside|caveat|clarification|concern|constraint|context|correction|detail|exception|follow-up|issue|note|nuance|observation|point|question|rationale|reminder|requirement|thought|update|warning|wrinkle))\s*[:\u2014-]\s*/iu;

const CORRECTION_FIRST_PARTY_PIVOT =
  /\b(?:i|we)\s+(?:(?:explicitly|formally|personally)\s+)?(?:agree|disagree|concur|adopt|endorse|confirm|hereby\s+accept)\b|\b(?:my|our)\s+(?:(?:current|new|latest|actual)\s+)?correction\b|\bmy\s+assessment\b|\b(?:in\s+my\s+view|this\s+is\s+(?:also\s+)?my\s+view|i\s+own\s+this\s+correction)\b|\bspeaking\s+for\s+(?:myself|ourselves)(?:\s+now)?\b/iu;

// Source heads and reporting grammar determine attribution independently of
// authorial heading vocabulary. Modifiers are bounded but open-ended.
const CORRECTION_SOURCE_MODIFIERS = String.raw`(?!(?:my|our|i|we|you)\b)(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}'.-]{0,47}\s+){0,5}`;
const CORRECTION_SOURCE_LABEL = new RegExp(
  String.raw`^${CORRECTION_SOURCE_MODIFIERS}(?:alerts?|calls?|changelogs?|doc(?:ument)?s?|emails?|logs?|notes|readmes?|spec(?:ification)?s?|threads?|tickets?|transcripts?)\s*[:,\u2014-]\s*`,
  "iu",
);
const CORRECTION_DOCUMENT_REPORT = new RegExp(
  String.raw`^${CORRECTION_SOURCE_MODIFIERS}(?:assertions?|changelogs?|comments?|doc(?:ument)?s?|instructions?|issues?|logs?|notes?|plans?|readmes?|reports?|requirements?|reviews?|runbooks?|spec(?:ification)?s?|tests?|tickets?|transcripts?)\s+(?:claim(?:s|ed)?|contain(?:s|ed)?|describe(?:s|d)?|indicate(?:s|d)?|mention(?:s|ed)?|note(?:s|d)?|read(?:s)?|report(?:s|ed)?|require(?:s|d)?|say(?:s)?|said|show(?:s|ed)?|specif(?:y|ies|ied)|state(?:s|d)?)\b`,
  "iu",
);

const CORRECTION_REPORTING_VERB = String.raw`(?:say|says|said|mention(?:s|ed)?|note(?:s|d)?|point(?:s|ed)?\s+out|flag(?:s|ged)?|report(?:s|ed)?|relay(?:s|ed)?|show(?:s|ed)?|write|writes|wrote|claim(?:s|ed)?|state(?:s|d)?|tell|tells|told|ask(?:s|ed)?|argue(?:s|d)?|warn(?:s|ed)?|think|thinks|thought|believe(?:s|d)?|den(?:y|ies|ied)\s+saying)`;
const CORRECTION_SPEECH_REPORT = new RegExp(
  String.raw`^(?<subject>(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}'.-]{0,47}\s+){1,8}?)(?<verb>${CORRECTION_REPORTING_VERB})\b`,
  "iu",
);
const CORRECTION_SPEECH_NOUN_PHRASE_REPORT = new RegExp(
  String.raw`^(?<subject>(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}'.-]{0,47}\s+){2,8}?)(?<verb>${CORRECTION_REPORTING_VERB})\b`,
  "iu",
);
const CORRECTION_EXTERNAL_ROLE = String.raw`(?:architect|attorney|auditor|boss|client|colleague|compliance|consultant|contractor|coworker|customer|director|engineer|friend|lead|legal|manager|mentor|qa|reviewer|sre|support|teammate|user|vendor)s?`;
const CORRECTION_EXTERNAL_HEADING = new RegExp(
  String.raw`^(?:(?:their|his|her|its)\s+|(?:(?:(?:my|our)\s+)?${CORRECTION_SOURCE_MODIFIERS}${CORRECTION_EXTERNAL_ROLE}(?:'s)?\s+)|(?!(?:my|our)\b)(?:[\p{L}\p{N}][\p{L}\p{M}\p{N}.-]*\s+){0,3}[\p{L}\p{M}\p{N}.-]+'s\s+)[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}(?:\s+[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}){0,7}\s*[:\u2014-]\s*`,
  "iu",
);

const CORRECTION_SOURCE_PREFIXES = Object.freeze([
  CORRECTION_SOURCE_LABEL,
  CORRECTION_DOCUMENT_REPORT,
  CORRECTION_EXTERNAL_HEADING,
  /^(?:my|our)\s+(?:(?:[\p{L}\p{M}-]+\s+){0,2}[\p{L}\p{M}-]+'s)\s+[\p{L}\p{M}-]+(?:\s+[\p{L}\p{M}-]+){0,5}\s*[:\u2014-]\s*/iu,
  /^(?:it|this|that)\s+(?:is|was|has\s+been)\s+(?:said|mentioned|noted|reported|flagged|claimed|stated)\s+by\s+(?!(?:me|us)\b)/iu,
  /^(?:forwarded|provided|sent|shared)\s+by\s+(?!(?:me|us|myself)\b)/iu,
  /^(?:my|our)\s+(?!own\b)(?:[\p{L}\p{M}\p{N}-]+\s+){0,2}[\p{L}\p{M}\p{N}-]+(?:'s|\u2019s)\s+(?:comment|email|feedback|message|note|report|review)\s*[:,\u2014-]\s*/iu,
  /^(?:my|our)\s+(?:boss|client|colleague|customer|friend|lead|manager|reviewer|teammate|user)(?:'s|\u2019s)?(?:\s+(?:comment|email|feedback|message|note|report|review))?\s*[:,\u2014-]\s*/iu,
  /^(?:my|our)\s+(?:architect|attorney|consultant|contractor|director|mentor|vendor)\s*,\s*/iu,
  /^(?:my|our)\s+(?:build|ci|console|linter|terminal|test)\s+(?:log|output|report|transcript)\s*[:,\u2014-]\s*/iu,
  /^(?:auditor|client|customer|external|legal|reviewer|support|third-party|user|vendor)-(?:authored|provided|reported|submitted|written)\s+(?:[\p{L}\p{M}\p{N}'-]+\s+){0,3}[\p{L}\p{M}\p{N}'-]+\s*[:,\u2014-]\s*/iu,
  /^(?:auditor|client|customer|reviewer|support|user)\s+(?:comment|email|feedback|message|note|report|request|review)\s*[:,\u2014-]\s*/iu,
  /^(?:(?:compliance|external|legal|privacy|security)\s+)?audit(?:\s+(?:comment|finding|note|report|review))?\s*[:,\u2014-]\s*/iu,
  /^(?:the\s+following\s+is\s+from|this\s+came\s+from|i\s+am\s+quoting|quoting|according\s+to|per|from)\s+(?!(?:me|us|myself|my|our|the\s+agreed\s+plan|the\s+plan\s+we\s+agreed\s+on)\b)/iu,
  /^(?:per|according\s+to|from)\s+(?:my|our)\s+(?:architects?|auditors?|clients?|colleagues?|customers?|engineers?|leads?|managers?|reviewers?|teammates?|users?|qa|sre|support|legal|compliance)\b/iu,
  /^(?:here\s+(?:is|are)|copied\s+from|summary\s+from)\s+(?!(?:me|us|myself)\b)/iu,
  /^(?:their|his|her|its|(?:claude|reviewer|auditor|qa)(?:'s|\u2019s)?)\s+(?:runbook|test\s+plan|implementation\s+notes?|requirements?|plan)\s+(?:says|requires|specifies|states)\s*[:\u2014-]/iu,
  /^(?:a|the)\s+(?:user|customer|reviewer|auditor|engineer)\s+(?:wrote|writes|said|says|reported|reports|asked|asks)\b/iu,
  /^(?:the\s+)?(?:console\s+transcript|terminal|build\s+transcript|failing\s+assertion)\s+(?:reads|printed|contains|says|reports)\b/iu,
  /^(?:she|he|they)\s+(?:say|says|said|think|thinks|thought|report|reports|reported|write|writes|wrote|claim|claims|claimed)\b/iu,
  /^(?:feedback|message|email|note|comment|report|request|complaint)\s+from\s+(?!(?:me|us|myself)\b)/iu,
  /^(?:review\s+feedback|external\s+review|customer\s+email|support\s+thread|the\s+support\s+thread|the\s+linked\s+issue|in\s+the\s+linked\s+issue|ticket(?:\s+[A-Z][A-Z0-9_-]*)?|claude\s+feedback)\s*(?:[:,\u2014-]\s*|$)/iu,
  /^(?:claude|qa|the\s+(?:reviewer|reviewers|auditor|logs?)|my\s+teammates?|our\s+reviewer|my\s+teammate|compliance|support|legal)\b.{0,96}?\b(?:say|says|said|think|thinks|thought|report|reports|reported|write|writes|wrote|claim|claims|claimed|note|notes|noted|tell|tells|told|mention|mentions|mentioned|argue|argues|argued|ask|asks|asked|read|reads|contain|contains|print|prints|printed)\b/iu,
  /^(?:i|we)\s+(?:heard|read|saw)\b.{0,96}?\b(?:claude|qa|reviewer|auditor|teammate|compliance|support|legal)\b/iu,
  /^(?:i|we)\s+(?:think|believe)\s*,?\s*(?:according\s+to\s+)?(?:claude|qa|the\s+reviewer|my\s+teammate|our\s+reviewer)\b/iu,
]);

const CORRECTION_TRANSFORMATION_PREFIXES = Object.freeze([
  /^(?:(?:[\p{L}\p{M}-]+\s+)?translation|summary|quoted\s+text|(?:(?:proposed|draft|suggested)\s+)?commit\s+message|(?:(?:proposed|draft|suggested)\s+)?(?:issue|pr|review)\s+comment|review\s+feedback|example)\s*(?:[:\u2014-]\s*|$)/iu,
  /^(?:(?:please|could\s+you|would\s+you|can\s+you)\s+)?(?:translate|summari[sz]e|paraphrase|rewrite|quote|attribute|condense)\b/iu,
  /^(?:translating|summari[sz]ing|paraphrasing|rewriting|quoting|attributing|condensing)\b/iu,
  /^(?:i|we)\s+(?:(?:need|want|would\s+like)\s+you\s+to|(?:am|are)\s+asking\s+you\s+to)\s+(?:translate|summari[sz]e|paraphrase|rewrite|quote|attribute|condense)\b/iu,
  /^(?:(?:please|could\s+you|would\s+you|can\s+you)\s+)?(?:write|draft|create|prepare|make|turn|render|formulate|paste)\b.{0,160}?\b(?:commit\s+message|pr\s+comment|review\s+comment|issue\s+comment|report|summary|(?:concise\s+)?note|the\s+review)\b/iu,
  /^(?:give|provide)\s+(?:me|us)\b.{0,96}?\b(?:summary|translation|paraphrase|rewrite)\b/iu,
  /^use\s+(?:this|that|it|the\s+following)\b.{0,160}?\b(?:write|draft|create|prepare|make|turn|render|as|into|for)\b.{0,160}?\b(?:commit\s+message|pr\s+comment|review\s+comment|issue\s+comment|report|summary)\b/iu,
]);

const CORRECTION_MACHINE_PREFIX =
  /^\s*(?:traceback\s+\(most\s+recent\s+call\s+last\):|(?:stderr|stdout|stack\s+trace)\s*[:>-]|ci\s*\/\s*cd\s+(?:error|failure|warning)\s*[:>-]|(?:ci\s+output|the\s+linter)\s+(?:says|warns)\s*[:>-])/iu;
const CORRECTION_HOST_OPEN =
  /<(?<tag>hook_prompt|subagent_notification|system_notification)\b/iu;

const CORRECTION_QUOTE_DEFINITIONS = Object.freeze([
  { open: '"""', closes: ['"""'], symmetric: true },
  { open: "'''", closes: ["'''"], symmetric: true },
  { open: '"', closes: ['"'], symmetric: true },
  { open: "'", closes: ["'"], symmetric: true, apostrophe: true },
  { open: "\uff02", closes: ["\uff02"], symmetric: true },
  { open: "\uff07", closes: ["\uff07"], symmetric: true, apostrophe: true },
  { open: "\u201c", closes: ["\u201d"] },
  { open: "\u201d", closes: ["\u201c"] },
  { open: "\u201e", closes: ["\u201c", "\u201d"] },
  { open: "\u201f", closes: ["\u201d"] },
  { open: "\u2018", closes: ["\u2019"] },
  { open: "\u2019", closes: ["\u2018"], apostrophe: true },
  { open: "\u201a", closes: ["\u2018", "\u2019"] },
  { open: "\u201b", closes: ["\u2019"] },
  { open: "\u00ab", closes: ["\u00bb"] },
  { open: "\u00bb", closes: ["\u00ab"] },
  { open: "\u2039", closes: ["\u203a"] },
  { open: "\u203a", closes: ["\u2039"] },
  { open: "\u3008", closes: ["\u3009"] },
  { open: "\u300a", closes: ["\u300b"] },
  { open: "\u300c", closes: ["\u300d"] },
  { open: "\u300e", closes: ["\u300f"] },
  { open: "\u301d", closes: ["\u301e", "\u301f"] },
  { open: "\ufe41", closes: ["\ufe42"] },
  { open: "\ufe43", closes: ["\ufe44"] },
  { open: "\uff1c", closes: ["\uff1e"] },
]);

function correctionPromptContainsFirstPartyCorrection(
  value,
  measuredWork = null,
) {
  if (!value) return false;
  const decision = {
    candidate: false,
    priorCandidate: false,
    lastCandidate: "",
    lastCandidateStart: -1,
    windowOffset: 0,
    globalOptOut: false,
    sourceSuppressed: false,
    sourcePayloadPending: false,
    localSuppression: false,
    historicalPending: false,
    historicalText: "",
    historicalStart: 0,
    factualPending: null,
  };
  const work = measuredWork ?? {
    inputCodeUnits: 0,
    structuralCodeUnits: 0,
    semanticCodeUnits: 0,
  };
  const collector = correctionStatementCollector(
    (statement, ended, offset) => {
      decision.windowOffset = offset;
      correctionEvaluateStatement(statement, decision, ended, work);
    },
    work,
    () => {
      decision.factualPending = null;
    },
  );

  correctionScanVisibleText(String(value), collector, work);
  collector.finish();
  if (decision.historicalPending) decision.candidate = true;
  return !decision.globalOptOut && decision.candidate;
}

export function measureFirstPartyWrapperScanWorkForTests(value) {
  const work = {
    inputCodeUnits: 0,
    structuralCodeUnits: 0,
    semanticCodeUnits: 0,
  };
  const detected = correctionPromptContainsFirstPartyCorrection(
    String(value ?? ""),
    work,
  );
  return {
    detected,
    work: {
      ...work,
      total:
        work.inputCodeUnits + work.structuralCodeUnits + work.semanticCodeUnits,
    },
  };
}

function correctionStatementCollector(visit, work, interrupt) {
  const buffer = new Uint16Array(CORRECTION_WINDOW_CHARS);
  let length = 0;
  let offset = 0;
  let pendingBoundary = false;

  const flush = (ended) => {
    if (length === 0) return;
    const raw = correctionStringFromCodeUnits(buffer, length);
    const statement = raw.trim();
    if (statement)
      visit(statement, ended, offset + raw.length - raw.trimStart().length);
    if (ended) {
      offset += length;
      length = 0;
      pendingBoundary = false;
      return;
    }
    const retained = Math.min(length, CORRECTION_WINDOW_OVERLAP_CHARS);
    offset += length - retained;
    buffer.copyWithin(0, length - retained, length);
    length = retained;
    pendingBoundary = false;
  };

  const appendCodeUnit = (codeUnit) => {
    if (length === CORRECTION_WINDOW_CHARS) flush(false);
    buffer[length] = codeUnit;
    length += 1;
    work.semanticCodeUnits += 1;
  };

  const append = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index);
      const character = text[index];
      if (pendingBoundary && /\s/u.test(character)) flush(true);
      appendCodeUnit(codeUnit);
      if (/[.!?]/u.test(character)) {
        pendingBoundary = true;
      } else if (!/\s/u.test(character)) {
        pendingBoundary = false;
      }
    }
  };

  return {
    appendRaw(raw) {
      const normalized = raw
        .replace(/\uff1c/gu, "\u2039")
        .replace(/\uff1e/gu, "\u203a")
        .replace(/[\u2018\u2019]/gu, "'")
        .normalize("NFKC");
      append(normalized);
    },
    separator(lineBreak = false) {
      if (pendingBoundary) {
        flush(true);
        interrupt();
        return;
      }
      interrupt();
      if (lineBreak && length > 0 && length <= 512) {
        work.semanticCodeUnits += length;
        // A standalone control must not absorb the next line's heading as
        // its object. Source wrappers still stay joined to their payload.
        const control = correctionRetractionControl(
          correctionStringFromCodeUnits(buffer, length).trim(),
        );
        if (control?.kind === "turn" || control?.kind === "reference") {
          flush(true);
          return;
        }
      }
      if (length > 0 && buffer[length - 1] !== 32) appendCodeUnit(32);
    },
    boundary() {
      flush(true);
      interrupt();
    },
    finish() {
      flush(true);
    },
  };
}

function correctionScanVisibleText(value, collector, work) {
  const state = {
    fence: null,
    lazyBlockquote: false,
    paragraphOpen: false,
    traceContinuation: false,
    hostTag: null,
    quote: null,
    inline: null,
  };

  let lineStart = 0;
  while (lineStart <= value.length) {
    const newline = value.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? value.length : newline;
    const contentEnd =
      lineEnd > lineStart && value[lineEnd - 1] === "\r"
        ? lineEnd - 1
        : lineEnd;
    const prefix = value
      .slice(lineStart, Math.min(contentEnd, lineStart + 256))
      .normalize("NFKC");
    work.inputCodeUnits += lineEnd - lineStart + Number(newline >= 0);
    work.structuralCodeUnits += contentEnd - lineStart;
    const blank = correctionRangeIsBlank(value, lineStart, contentEnd);

    if (state.hostTag) {
      if (
        value
          .slice(lineStart, contentEnd)
          .toLocaleLowerCase("en-US")
          .includes("</" + state.hostTag + ">")
      ) {
        state.hostTag = null;
      }
      collector.separator();
    } else {
      const hostOpen = prefix.match(CORRECTION_HOST_OPEN);
      if (hostOpen?.groups?.tag) {
        const tag = hostOpen.groups.tag.toLocaleLowerCase("en-US");
        if (!prefix.toLocaleLowerCase("en-US").includes("</" + tag + ">")) {
          state.hostTag = tag;
        }
        collector.separator();
      } else {
        correctionScanLine({
          value,
          lineStart,
          lineEnd: contentEnd,
          prefix,
          blank,
          state,
          collector,
        });
      }
    }

    if (newline < 0) break;
    if (blank) {
      correctionFlushUnmatchedInline(state, collector);
      state.quote = null;
      collector.boundary();
    } else {
      collector.separator(true);
    }
    lineStart = newline + 1;
  }

  correctionFlushUnmatchedInline(state, collector);
}

function correctionScanLine({
  value,
  lineStart,
  lineEnd,
  prefix,
  blank,
  state,
  collector,
}) {
  if (state.fence) {
    const fence = correctionFenceLine(prefix, state.fence);
    if (fence?.kind === "close") state.fence = null;
    state.paragraphOpen = false;
    state.traceContinuation = false;
    collector.separator();
    return;
  }

  if (blank) {
    state.lazyBlockquote = false;
    state.paragraphOpen = false;
    state.traceContinuation = false;
    return;
  }

  const fence = correctionFenceLine(prefix, null);
  if (fence) {
    state.fence = { marker: fence.marker, width: fence.width };
    state.lazyBlockquote = false;
    state.paragraphOpen = false;
    state.traceContinuation = false;
    collector.separator();
    return;
  }

  if (correctionLineStartsBlockquote(prefix)) {
    state.lazyBlockquote = !correctionBlockquoteMarkerIsBlank(prefix);
    state.paragraphOpen = state.lazyBlockquote;
    state.traceContinuation = false;
    collector.separator();
    return;
  }

  if (state.lazyBlockquote && !correctionLineInterruptsBlockquote(prefix)) {
    collector.separator();
    return;
  }
  state.lazyBlockquote = false;

  if (correctionLineIsIndented(prefix) && !state.paragraphOpen) {
    state.paragraphOpen = false;
    state.traceContinuation = false;
    collector.separator();
    return;
  }

  const machine =
    CORRECTION_MACHINE_PREFIX.test(prefix) || state.traceContinuation;
  state.traceContinuation = machine;
  if (machine) {
    collector.separator();
    return;
  }

  correctionScanInlineRange(value, lineStart, lineEnd, state, collector);
  state.paragraphOpen = true;
}

function correctionFenceLine(prefix, active) {
  const match = prefix.match(/^( {0,3})(\x60{3,}|~{3,})(.*)$/u);
  if (!match) return null;
  const marker = match[2][0];
  const width = match[2].length;
  if (active) {
    if (
      marker !== active.marker ||
      width < active.width ||
      !/^[\t \r]*$/u.test(match[3])
    ) {
      return null;
    }
    return { kind: "close", marker, width };
  }
  if (marker === "\x60" && match[3].includes("\x60")) return null;
  return { kind: "open", marker, width };
}

function correctionLineStartsBlockquote(prefix) {
  return /^ {0,3}>/u.test(prefix);
}

function correctionBlockquoteMarkerIsBlank(prefix) {
  return /^ {0,3}>[\t \r]*$/u.test(prefix);
}

function correctionLineInterruptsBlockquote(prefix) {
  if (/^ {0,3}#{1,6}(?:[\t ]|$)/u.test(prefix)) return true;
  if (/^ {0,3}(?:\*[\t ]*){3,}$/u.test(prefix)) return true;
  if (/^ {0,3}(?:-[\t ]*){3,}$/u.test(prefix)) return true;
  if (/^ {0,3}(?:_[\t ]*){3,}$/u.test(prefix)) return true;
  if (/^ {0,3}[-+*][\t ]+/u.test(prefix)) return true;
  return /^ {0,3}1[.)][\t ]+/u.test(prefix);
}

function correctionLineIsIndented(prefix) {
  if (prefix.startsWith("\t")) return true;
  let columns = 0;
  for (const character of prefix) {
    if (character === " ") {
      columns += 1;
    } else if (character === "\t") {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    if (columns >= 4) return true;
  }
  return false;
}

function correctionRangeIsBlank(value, start, end) {
  for (let index = start; index < end; index += 1) {
    if (!/[\t \r]/u.test(value[index])) return false;
  }
  return true;
}

function correctionScanInlineRange(value, start, end, state, collector) {
  let cursor = start;
  while (cursor < end) {
    if (state.inline) {
      if (value[cursor] === "\x60") {
        const runEnd = correctionDelimiterRunEnd(value, cursor, end, "\x60");
        if (runEnd - cursor === state.inline.width) {
          state.inline = null;
          collector.separator();
          cursor = runEnd;
          continue;
        }
      }
      correctionBufferInlinePoint(value, cursor, state);
      cursor += String.fromCodePoint(value.codePointAt(cursor)).length;
      continue;
    }

    if (state.quote) {
      if (state.quote.escaped) {
        const close = state.quote.closes.find(
          (candidate) =>
            value[cursor] === "\\" && value.startsWith(candidate, cursor + 1),
        );
        if (close) {
          correctionCloseQuote(state, collector);
          cursor += close.length + 1;
        } else {
          correctionQuotePoint(value[cursor], state.quote);
          cursor += String.fromCodePoint(value.codePointAt(cursor)).length;
        }
        continue;
      }
      const close = state.quote.closes.find((candidate) =>
        value.startsWith(candidate, cursor),
      );
      if (close) {
        if (
          state.quote.apostrophe &&
          correctionQuoteIsApostrophe(value, cursor, close.length, end)
        ) {
          cursor += close.length;
          continue;
        }
        if (
          state.quote.symmetric &&
          state.quote.open.length === 1 &&
          correctionQuoteCanOpen(value, cursor, close.length, end)
        ) {
          state.quote.nestedDepth += 1;
          cursor += close.length;
          continue;
        }
        if (state.quote.nestedDepth > 0) {
          state.quote.nestedDepth -= 1;
        } else {
          correctionCloseQuote(state, collector);
        }
        cursor += close.length;
      } else {
        correctionQuotePoint(value[cursor], state.quote);
        cursor += String.fromCodePoint(value.codePointAt(cursor)).length;
      }
      continue;
    }

    const escapedQuote = correctionEscapedQuoteAt(value, cursor, end);
    if (escapedQuote) {
      state.quote = { ...escapedQuote, nestedDepth: 0, escaped: true };
      collector.separator();
      cursor += escapedQuote.open.length + 1;
      continue;
    }

    if (value[cursor] === "\x60") {
      const runEnd = correctionDelimiterRunEnd(value, cursor, end, "\x60");
      state.inline = correctionInlineState(runEnd - cursor);
      correctionBufferInlineText(value.slice(cursor, runEnd), state);
      cursor = runEnd;
      continue;
    }

    const quote = correctionQuoteAt(value, cursor, end);
    if (quote) {
      state.quote = { ...quote, nestedDepth: 0 };
      collector.separator();
      cursor += quote.open.length;
      continue;
    }

    const point = String.fromCodePoint(value.codePointAt(cursor));
    collector.appendRaw(point);
    cursor += point.length;
  }
  if (state.inline && !state.inline.overflow) {
    correctionBufferInlineText(" ", state);
  }
}

function correctionQuotePoint(character, quote) {
  if (!/\s/u.test(character)) quote.endedSentence = /[.!?]/u.test(character);
}

function correctionCloseQuote(state, collector) {
  if (state.quote.endedSentence) collector.boundary();
  else collector.separator();
  state.quote = null;
}

function correctionEscapedQuoteAt(value, index, end) {
  if (value[index] !== "\\" || correctionEscapedAt(value, index)) return null;
  const definition = CORRECTION_QUOTE_DEFINITIONS.find(
    (candidate) =>
      candidate.symmetric &&
      candidate.open.length === 1 &&
      value.startsWith(candidate.open, index + 1),
  );
  if (!definition) return null;
  const delimiter = "\\" + definition.open;
  const closingIndex = value.indexOf(delimiter, index + delimiter.length);
  return closingIndex >= 0 && closingIndex < end ? definition : null;
}

function correctionDelimiterRunEnd(value, start, end, delimiter) {
  let cursor = start;
  while (cursor < end && value[cursor] === delimiter) cursor += 1;
  return cursor;
}

function correctionInlineState(width) {
  return {
    width,
    buffer: new Uint16Array(CORRECTION_INLINE_BUFFER_CHARS),
    length: 0,
    overflow: false,
  };
}

function correctionBufferInlinePoint(value, index, state) {
  const point = String.fromCodePoint(value.codePointAt(index));
  correctionBufferInlineText(point, state);
}

function correctionBufferInlineText(text, state) {
  if (state.inline.overflow) return;
  for (let index = 0; index < text.length; index += 1) {
    if (state.inline.length === CORRECTION_INLINE_BUFFER_CHARS) {
      state.inline.overflow = true;
      return;
    }
    state.inline.buffer[state.inline.length] = text.charCodeAt(index);
    state.inline.length += 1;
  }
}

function correctionFlushUnmatchedInline(state, collector) {
  if (!state.inline) return;
  if (!state.inline.overflow) {
    collector.appendRaw(
      correctionStringFromCodeUnits(state.inline.buffer, state.inline.length),
    );
  }
  state.inline = null;
}

function correctionQuoteAt(value, index, end) {
  if (correctionEscapedAt(value, index)) return null;
  for (const definition of CORRECTION_QUOTE_DEFINITIONS) {
    if (!value.startsWith(definition.open, index)) continue;
    if (
      definition.apostrophe &&
      correctionQuoteIsApostrophe(value, index, definition.open.length, end)
    ) {
      return null;
    }
    if (
      definition.symmetric &&
      definition.open.length === 1 &&
      !correctionQuoteCanOpen(value, index, definition.open.length, end)
    ) {
      return null;
    }
    return definition;
  }
  return null;
}

function correctionEscapedAt(value, index) {
  let escapes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    escapes += 1;
  }
  return escapes % 2 === 1;
}

function correctionQuoteIsApostrophe(value, index, width, end) {
  const previous = index > 0 ? value[index - 1] : "";
  const next = index + width < end ? value[index + width] : "";
  return /[\p{L}\p{N}_]/u.test(previous) && /[\p{L}\p{N}_]/u.test(next);
}

function correctionQuoteCanOpen(value, index, width, end) {
  const previous = index > 0 ? value[index - 1] : "";
  const next = index + width < end ? value[index + width] : "";
  const openingContext =
    !previous || /\s/u.test(previous) || "([{<:;,\u2014-".includes(previous);
  return openingContext && Boolean(next) && !/\s/u.test(next);
}

function correctionStringFromCodeUnits(buffer, length) {
  let output = "";
  for (let start = 0; start < length; start += 1024) {
    output += String.fromCharCode(
      ...buffer.subarray(start, Math.min(length, start + 1024)),
    );
  }
  return output;
}

function correctionEvaluateStatement(statement, decision, ended, work) {
  const { text, offsets } = correctionNormalizedStatement(statement);
  const question = /\?\s*$/u.test(text);
  const factualPending = decision.factualPending;
  decision.factualPending = null;
  work.semanticCodeUnits += statement.length;
  const pendingBefore = decision.historicalPending;
  let newHistoricalClaim = false;
  let localSuppression = decision.localSuppression;
  let sourcePayloadPending = decision.sourcePayloadPending;
  let statementHasContent = false;
  const clauses = correctionStatementClauses(text);

  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    const provenance = correctionClauseProvenance(clause.text, work);
    const next = clauses[index + 1];
    const postfix =
      correctionPostfixAttribution(clause.text) ||
      (next?.boundary === "comma" &&
        correctionPostfixAttribution(next.text, true));
    if (provenance.source || postfix) {
      statementHasContent = true;
      decision.sourceSuppressed = provenance.source || "reported";
      sourcePayloadPending = Boolean(provenance.sourcePayloadPending);
      continue;
    }
    if (sourcePayloadPending) {
      statementHasContent = true;
      // A reported interjection can end at a comma before its payload begins.
      sourcePayloadPending = !provenance.payload;
      continue;
    }

    const payload = provenance.payload;
    const atStatementStart = !statementHasContent;
    statementHasContent ||= Boolean(
      payload || provenance.adoption || provenance.suppressed,
    );
    // Embedded controls belong to their source. A standalone, unquoted
    // memory refusal still wins over an inherited reporting scope.
    const retraction = provenance.retraction;
    const durableOptOut = correctionHasDurableOptOut(payload);
    if (
      decision.sourceSuppressed &&
      !atStatementStart &&
      !provenance.adoption &&
      (retraction || durableOptOut)
    )
      continue;
    if (retraction?.kind === "turn" || durableOptOut) {
      decision.globalOptOut = true;
      decision.historicalPending = false;
      continue;
    }
    if (retraction) {
      if (retraction.kind === "claim") {
        if (decision.historicalPending) {
          decision.historicalPending = false;
        } else if (
          decision.lastCandidate &&
          (!retraction.target ||
            decision.lastCandidate
              .toLocaleLowerCase("en-US")
              .split(/[^\p{L}\p{N}-]+/u)
              .includes(retraction.target))
        ) {
          decision.candidate = decision.priorCandidate;
          decision.lastCandidate = "";
        }
      }
      continue;
    }

    const independent =
      provenance.adoption ||
      ((Boolean(payload) || atStatementStart) &&
        /^(?:separately|to\s+be\s+clear|speaking\s+for\s+(?:myself|ourselves))\b/iu.test(
          clause.text,
        )) ||
      (clause.boundary === "adversative" &&
        decision.sourceSuppressed !== "transformation" &&
        Boolean(correctionFirstDirectMatch(payload)));
    if (independent) {
      decision.sourceSuppressed = false;
      localSuppression = false;
    }
    if (decision.sourceSuppressed) continue;
    if (provenance.suppressed) localSuppression = true;
    if (localSuppression) continue;

    if (
      decision.historicalPending &&
      correctionIsHistoricalResolution(payload)
    ) {
      decision.historicalPending = false;
      continue;
    }
    const direct = correctionFirstDirectMatch(payload);
    const historicalDirect =
      provenance.historical &&
      /^i\s+(?:said|asked|told\s+you)\b/iu.test(clause.text) &&
      correctionFirstDirectMatch(clause.text);
    const explicitCorrection = provenance.explicitCorrection;
    const negatedValue = correctionNegatedFactualValue(payload);
    const atomicReplacement =
      ended && !question && index === 0 && factualPending
        ? correctionAtomicFactualValue(payload)
        : null;
    const adjacentContrast =
      atomicReplacement && atomicReplacement !== factualPending.value;
    const eligible =
      direct ||
      historicalDirect ||
      adjacentContrast ||
      (ended && !question && correctionFactualContrastAtStart(payload)) ||
      (ended &&
        !negatedValue &&
        explicitCorrection &&
        correctionExplicitCorrectionPayload(payload));
    if (!eligible) {
      // Carry only a complete, first-party technical atom to the immediately
      // adjacent sentence ("Not v1. v2."). Invisible content breaks this link.
      if (
        ended &&
        !question &&
        !provenance.historical &&
        index === clauses.length - 1
      ) {
        if (negatedValue) {
          decision.factualPending = {
            value: negatedValue,
            text: payload,
            start:
              decision.windowOffset +
              offsets[clause.offset + provenance.offset],
          };
        }
      }
      continue;
    }
    const candidateStart =
      decision.windowOffset +
      offsets[clause.offset + provenance.offset + (direct?.index ?? 0)];
    if (provenance.historical) {
      if (correctionIsHistoricalResolution(payload)) continue;
      decision.historicalPending = true;
      decision.historicalText = payload;
      decision.historicalStart = candidateStart;
      newHistoricalClaim = true;
      continue;
    }
    if (decision.historicalPending) {
      correctionRecordCandidate(
        decision.historicalText,
        decision,
        decision.historicalStart,
      );
      decision.historicalPending = false;
    }
    correctionRecordCandidate(
      adjacentContrast ? `${factualPending.text} ${payload}` : payload,
      decision,
      adjacentContrast ? factualPending.start : candidateStart,
    );
  }
  if (pendingBefore && decision.historicalPending && !newHistoricalClaim) {
    correctionRecordCandidate(
      decision.historicalText,
      decision,
      decision.historicalStart,
    );
    decision.historicalPending = false;
  }
  decision.localSuppression = ended ? false : localSuppression;
  decision.sourcePayloadPending = ended ? false : sourcePayloadPending;
}

function correctionNormalizedStatement(statement) {
  const units = [];
  const offsets = [];
  let whitespace = false;
  for (let index = 0; index < statement.length; index += 1) {
    const space = /\s/u.test(statement[index]);
    if (!space || !whitespace) {
      units.push(space ? " " : statement[index]);
      offsets.push(index);
    }
    whitespace = space;
  }
  return { text: units.join(""), offsets };
}

function correctionRecordCandidate(text, decision, start) {
  // Overlapping windows can report the same clause twice. Retractions must
  // not leave a duplicate copy eligible, or resurrect an already withdrawn one.
  if (start <= decision.lastCandidateStart) return;
  decision.priorCandidate = decision.candidate;
  decision.candidate = true;
  decision.lastCandidate = text;
  decision.lastCandidateStart = start;
}

function correctionStatementClauses(text) {
  const clauses = [];
  // A replacement's comma or "but" is part of one factual assertion, not an
  // independent authorial pivot out of a quoted/reported scope.
  const contrasts = correctionFactualMatches(text)
    .map((match) => correctionFactualConnector(match, text))
    .filter(Boolean);
  let contrastIndex = 0;
  // A pivot's optional comma belongs to the pivot, not a new clause boundary.
  const separators =
    /[,;]\s*|\b(?:but|however|yet)\b\s*,?\s*|\band\s+(?=(?:i|we)\s+(?:(?:explicitly|formally|personally)\s+)?(?:agree|disagree|concur|adopt|endorse|confirm)\b)|\s*:\s+|\s+[\u2014-]\s+/giu;
  let start = 0;
  let boundary = "statement";
  for (const match of text.matchAll(separators)) {
    while (
      contrasts[contrastIndex] &&
      match.index >= contrasts[contrastIndex][1]
    )
      contrastIndex += 1;
    const contrast = contrasts[contrastIndex];
    if (contrast && match.index >= contrast[0]) continue;
    const retractionBoundary = /^\s*[:\u2014-]/u.test(match[0]);
    if (
      retractionBoundary &&
      !correctionRetractionAfterLeadIn(
        text.slice(
          match.index + match[0].length,
          match.index + match[0].length + 512,
        ),
      )
    )
      continue;
    const retainedSeparator = retractionBoundary
      ? match[0].length
      : Number(match[0].startsWith(","));
    const raw = text.slice(start, match.index + retainedSeparator);
    const clause = raw.trim();
    if (clause)
      clauses.push({
        text: clause,
        boundary,
        offset: start + raw.length - raw.trimStart().length,
      });
    boundary = retractionBoundary
      ? "retraction"
      : match[0].startsWith(",")
        ? "comma"
        : match[0].startsWith(";")
          ? "semicolon"
          : /^and\b/iu.test(match[0])
            ? "conjunction"
            : "adversative";
    start = match.index + match[0].length;
  }
  const raw = text.slice(start);
  const tail = raw.trim();
  if (tail)
    clauses.push({
      text: tail,
      boundary,
      offset: start + raw.length - raw.trimStart().length,
    });
  return clauses;
}

function correctionFactualContrastAtStart(text) {
  return correctionFactualMatches(text).some(
    (match) =>
      match.index === 0 && Boolean(correctionFactualConnector(match, text)),
  );
}

function correctionFactualMatches(text) {
  const matches = [];
  if (!/\b(?:not|rather\s+than|instead\s+of)\s/iu.test(text)) return matches;
  // Inspect a fixed-size neighborhood of each connector independently. A
  // neutral lead-in or rejected negation cannot swallow a later "not X but Y".
  for (const connector of text.matchAll(CORRECTION_FACTUAL_CONNECTORS)) {
    const positive = Boolean(connector.groups.positiveConnector);
    const leftStart = Math.max(0, connector.index - 2048);
    const left = text
      .slice(leftStart, connector.index)
      .match(
        positive ? CORRECTION_FACTUAL_LEFT : CORRECTION_FACTUAL_NEGATIVE_LEFT,
      );
    const end = connector.index + connector[0].length;
    const right = text.slice(end, end + 512).match(CORRECTION_FACTUAL_RIGHT);
    if (!left || !right) continue;
    const index = leftStart + left.index;
    matches.push({
      0: text.slice(index, end + right[0].length),
      index,
      groups: {
        ...connector.groups,
        assertion: left.groups?.assertion,
        replacement: right[0],
      },
      indices: connector.indices,
    });
  }
  return matches;
}

function correctionFactualConnector(match, text) {
  const connector =
    match.indices.groups.positiveConnector ??
    match.indices.groups.negativeConnector;
  if (
    match.groups.assertion &&
    (!correctionWithoutNeutralLeadIn(`${match.groups.assertion},`).text ||
      (/^\s*,?\s*not\b/iu.test(match.groups.positiveConnector) &&
        (CORRECTION_FACTUAL_NEGATED_AUXILIARY.test(match.groups.assertion) ||
          (!match.groups.positiveConnector.includes(",") &&
            CORRECTION_FACTUAL_UNARY_SUBJECT.test(match.groups.assertion)))))
  )
    return null;
  const replacement = correctionWithoutNeutralLeadIn(
    text.slice(connector[1], connector[1] + 512),
  ).text;
  const valueEnd = connector[1] + match.groups.replacement.length;
  // A following clause delimiter ends a value ("XML, which ..."), not a
  // speaker label or an instruction owned by the preceding value.
  // Colons retain their prefix chain so nested report/transform wrappers use
  // the same provenance rules as a whole statement, without factual recursion.
  const context = /^\s*(?:[,;]|(?:but|however|yet)\b)/iu.test(
    text.slice(valueEnd, valueEnd + 16),
  )
    ? correctionWithoutNeutralLeadIn(match.groups.replacement).text
    : replacement;
  const provenance = correctionClauseProvenance(
    context,
    { semanticCodeUnits: 0 },
    false,
  );
  return provenance.source ||
    provenance.suppressed ||
    provenance.retraction ||
    provenance.adoption ||
    provenance.explicitCorrection ||
    provenance.historical ||
    !CORRECTION_FACTUAL_RIGHT.test(provenance.payload) ||
    correctionHasDurableOptOut(provenance.payload) ||
    /^(?:thanks|thank\s+you|okay|ok|sure|fine)(?:[.!]|$)/iu.test(
      provenance.payload,
    )
    ? null
    : connector;
}

function correctionAtomicFactualValue(text) {
  const value = text.replace(/[.!]$/u, "");
  return CORRECTION_FACTUAL_ATOM.test(value) &&
    /[\p{L}\p{N}]/u.test(value) &&
    /[\p{N}_/=-]|\.[\p{L}\p{N}]/u.test(value)
    ? value
    : null;
}

function correctionNegatedFactualValue(text) {
  const match = text.match(/^not\s+(.{1,65})$/iu);
  return match ? correctionAtomicFactualValue(match[1]) : null;
}

function correctionClauseProvenance(text, work, allowFactualFallback = true) {
  let cursor = 0;
  let adoption = false;
  let historical = false;
  let explicitCorrection = false;
  let surface = true;
  while (cursor < text.length) {
    // Prefix inspection is bounded even for thousands of nested headings.
    const head = text.slice(cursor, cursor + 512);
    work.semanticCodeUnits += head.length;
    const lead = correctionWithoutNeutralLeadIn(head);
    if (lead.offset) {
      cursor += lead.offset;
      continue;
    }
    const retraction = correctionRetractionControl(head);
    if (retraction) {
      if (
        retraction.kind === "reference" &&
        retraction.end &&
        !correctionHasDurableOptOut(head)
      ) {
        cursor += retraction.end;
        surface = false;
        continue;
      }
      return { payload: text.slice(cursor), retraction, adoption };
    }
    const firstPartyLabel = correctionFirstPartyLabelAtStart(head);
    const wrapper = correctionWrapperAtStart(
      head,
      Boolean(firstPartyLabel),
      allowFactualFallback,
    );
    if (wrapper) {
      const remainder = text.slice(cursor + wrapper.end).trim();
      work.semanticCodeUnits += remainder.length;
      return {
        source: wrapper.kind,
        payload: "",
        sourcePayloadPending:
          Boolean(remainder) && !correctionWithoutNeutralLeadIn(remainder).text,
      };
    }
    if (
      /^(?:if|assuming|suppose|supposing|provided|providing)\b|^(?:it\s+is\s+not\s+true\s+that|(?:i|we)\s+(?:never|did\s+not|didn't)\s+(?:say|said|claim|claimed))\b/iu.test(
        head,
      )
    ) {
      return { suppressed: true, payload: "" };
    }
    const pivot = correctionFirstPartyPivot(head);
    if (pivot?.index === 0) {
      adoption ||= surface;
      explicitCorrection ||= pivot.kind === "correction_label";
      cursor += pivot.end;
      const delimiter = text
        .slice(cursor, cursor + 8)
        .match(/^\s*[:\u2014-]?\s*/u);
      cursor += delimiter[0].length;
      surface = false;
      continue;
    }
    if (correctionHasDurableOptOut(head)) {
      return { payload: text.slice(cursor), adoption };
    }
    const historicalPrefix = correctionHistoricalPrefix(head);
    if (historicalPrefix) {
      historical = true;
      cursor += historicalPrefix[0].length;
      surface = false;
      continue;
    }
    const heading =
      firstPartyLabel ||
      head.match(
        /^[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}(?:\s+[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]{0,47}){0,7}(?:\s*:\s*|\s+[\u2014-]\s*)/u,
      );
    if (
      heading &&
      !correctionFirstDirectMatch(heading[0]) &&
      !(
        allowFactualFallback &&
        /^not\s+/iu.test(head) &&
        (correctionFactualContrastAtStart(head) ||
          correctionNegatedFactualValue(head))
      )
    ) {
      explicitCorrection ||= /^correction\s*[:\u2014-]/iu.test(heading[0]);
      cursor += heading[0].length;
      surface = false;
      continue;
    }
    break;
  }
  return {
    payload: text.slice(cursor),
    offset: cursor,
    adoption,
    historical,
    explicitCorrection,
  };
}

function correctionPostfixAttribution(text, atStart = false) {
  const match = atStart
    ? text.match(/^(?:according\s+to|per|as)\s+/iu)
    : text.match(/\s+(?:according\s+to|per)\s+/iu);
  if (!match) return false;
  const suffix = text.slice(match.index).trim();
  return Boolean(
    correctionWrapperAtStart(
      suffix,
      Boolean(correctionFirstPartyLabelAtStart(suffix)),
    ),
  );
}

function correctionFirstDirectMatch(text) {
  let first = null;
  for (const pattern of CORRECTION_DIRECT_PATTERNS) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!first || match.index < first.index) {
      first = { index: match.index, end: match.index + match[0].length };
    }
  }
  return first;
}

function correctionFirstPartyPivot(text, minimumIndex = 0) {
  const sliced = text.slice(minimumIndex);
  const match = sliced.match(CORRECTION_FIRST_PARTY_PIVOT);
  if (!match || match.index === undefined) return null;
  const index = minimumIndex + match.index;
  const value = match[0];
  return {
    index,
    end: index + value.length,
    kind: /\bcorrection\b/iu.test(value) ? "correction_label" : "adoption",
  };
}

function correctionWrapperAtStart(
  text,
  firstPartyLabel,
  allowFactualFallback = true,
) {
  if (firstPartyLabel) return null;
  const lead = correctionWithoutNeutralLeadIn(text);
  if (correctionFirstPartyPivot(lead.text)?.index === 0) return null;
  const reference = correctionReferenceHeadingAtStart(lead.text);
  if (reference) {
    return {
      index: lead.offset,
      end: lead.offset + reference.label[0].length,
      kind: reference.kind,
    };
  }
  for (const pattern of CORRECTION_SOURCE_PREFIXES) {
    const match = lead.text.match(pattern);
    if (!match || match.index !== 0) continue;
    return {
      index: lead.offset,
      end: lead.offset + match[0].length,
      kind: "reported",
    };
  }
  const report = correctionSpeechReport(lead.text);
  const direct = report && correctionFirstDirectMatch(lead.text);
  if (
    report &&
    !correctionReportingSubjectIsFirstParty(report.groups.subject.trim()) &&
    !(
      direct &&
      direct.index < report.groups.subject.length &&
      /\b(?:i|we|you)\b/iu.test(report.groups.subject)
    )
  ) {
    return {
      index: lead.offset,
      end: lead.offset + report[0].length,
      kind: "reported",
    };
  }
  for (const pattern of CORRECTION_TRANSFORMATION_PREFIXES) {
    const match = lead.text.match(pattern);
    if (match) {
      return {
        index: lead.offset,
        end: lead.offset + match[0].length,
        kind: "transformation",
      };
    }
  }
  const attribution = lead.text.match(CORRECTION_ATTRIBUTED_HEADING);
  if (attribution) {
    return {
      index: lead.offset,
      end: lead.offset + attribution[0].length,
      kind: "reported",
    };
  }
  const speaker = correctionNamedThirdPartyLabelAtStart(lead.text);
  if (
    speaker &&
    allowFactualFallback &&
    (correctionNegatedFactualValue(lead.text) ||
      correctionFactualMatches(lead.text).some(
        (match) =>
          match.index === 0 &&
          (match[0].length === lead.text.length ||
            /^\s*[,;]/u.test(lead.text.slice(match[0].length))) &&
          Boolean(correctionFactualConnector(match, lead.text)),
      ))
  )
    return null;
  if (speaker) {
    return {
      index: lead.offset,
      end: lead.offset + speaker[0].length,
      kind: "reported",
    };
  }
  return null;
}

function correctionSpeechReport(text) {
  const report = text.match(CORRECTION_SPEECH_REPORT);
  if (!report) return null;
  const subject = report.groups.subject.trim();
  const verb = report.groups.verb.split(" ")[0];
  const past = /(?:ed)$|^(?:said|wrote|told|thought|read)$/iu.test(verb);
  const singularPresent = /s$/iu.test(verb);
  // "That flag defaults ..." names a flag, not a speaker named "That".
  // Retain a later real report: "That flag says ..." is still attributed.
  const requiresNoun =
    /^(?:the|a|an)$/iu.test(subject) ||
    (!past &&
      ((/^(?:this|that)$/iu.test(subject) && !singularPresent) ||
        (/^(?:these|those)$/iu.test(subject) && singularPresent)));
  return requiresNoun
    ? text.match(CORRECTION_SPEECH_NOUN_PHRASE_REPORT)
    : report;
}

function correctionReportingSubjectIsFirstParty(subject) {
  // A bare possessive before a verb-like topic ("my state-machine mismatch")
  // is ownership, not a third-party speaker. Keep speech punctuation intact.
  return /^(?:my|our)$|^(?:(?:as|like)\s+)?(?:i|we)(?:\s+(?:already|earlier|previously|never|did\s+not|didn't))*$|^(?:my|our)\s+(?:(?:own|agreed|current|latest|implementation|test|internal|security)\s+){0,3}(?:runbook|plan|notes?|requirements?|review|assessment|finding|message|feedback)$|^the\s+(?:plan|requirements?|review|notes?)\s+(?:i|we)\s+(?:wrote|authored|created)$/iu.test(
    subject,
  );
}

function correctionFirstPartyLabelAtStart(text) {
  const pivot = correctionFirstPartyPivot(text);
  if (pivot?.kind === "correction_label" && pivot.index === 0) return null;
  const explicit =
    text.match(CORRECTION_FIRST_PARTY_LABEL) ??
    text.match(CORRECTION_FIRST_PARTY_POSSESSIVE_LABEL);
  if (explicit) return explicit;
  for (const pattern of [
    ...CORRECTION_SOURCE_PREFIXES,
    ...CORRECTION_TRANSFORMATION_PREFIXES,
  ]) {
    const match = text.match(pattern);
    if (match?.index === 0) return null;
  }
  const reference = correctionReferenceHeadingAtStart(text);
  if (reference?.kind === "first_party") return reference.label;
  const attribution = text.match(CORRECTION_ATTRIBUTED_HEADING);
  if (
    attribution &&
    /^(?:me|us|myself|ourselves)$/iu.test(attribution.groups.owner)
  )
    return attribution;
  const authorial = text.match(CORRECTION_AUTHORIAL_LABEL);
  if (authorial) return authorial;
  if (correctionNamedThirdPartyLabelAtStart(text)) return null;
  return null;
}

function correctionReferenceHeadingAtStart(text) {
  const frame = text.match(CORRECTION_REFERENCE_FRAME);
  if (!frame) return null;
  const remainder = text.slice(frame[0].length);
  const owned = remainder.match(CORRECTION_FIRST_PARTY_POSSESSIVE_LABEL);
  const label = owned ?? remainder.match(CORRECTION_EXTERNAL_HEADING);
  if (!label) return null;
  const intent = text.replace(/^to\s+/iu, "");
  // In a reference heading, "note" names the owned message; it is not a
  // reporting verb. Transforming or quoting that message still stays inert.
  // A withdrawn reference is also inert, but a later explicit adoption may
  // establish a new correction; withdrawing it is not a global capture opt-out.
  return {
    label: [frame[0] + label[0]],
    kind: CORRECTION_WITHDRAWN_REFERENCE.test(intent)
      ? "withdrawn"
      : CORRECTION_TRANSFORMATION_PREFIXES.some((pattern) =>
            pattern.test(intent),
          )
        ? "transformation"
        : owned
          ? "first_party"
          : "reported",
  };
}

function correctionNamedThirdPartyLabelAtStart(text) {
  const label = text.match(
    /^(?<label>[\p{Lu}][\p{Ll}\p{M}'-]{1,31}(?:\s+[\p{Lu}][\p{Ll}\p{M}'-]{1,31}){0,2}|[A-Z]{2,12}(?:\s+(?:auditor|lead|manager|reviewer))?|(?:Design|Engineering|Legal|Product|Release|Security|Support|SRE)\s+(?:auditor|lead|manager|reviewer))(?:\s*[:,]\s*|\s+[\u2014-]\s*)/u,
  );
  if (!label) return null;
  const topic = label.groups.label.match(
    /^(?:(?:my|our)\s+)?(?<noun>[\p{L}\p{M}-]+)$/iu,
  );
  // A review-topic noun is not a person merely because its heading is
  // capitalized. Explicit roles/owners are resolved before this fallback;
  // multiword names and unknown labels keep their conservative treatment.
  return topic &&
    (CORRECTION_REVIEW_TOPIC_NOUN.test(topic.groups.noun) ||
      CORRECTION_TECHNICAL_TOPIC_NOUN.test(topic.groups.noun))
    ? null
    : label;
}

function correctionWithoutNeutralLeadIn(text) {
  const match = text.match(
    /^(?:(?:#{1,6}|[-+*]|\d+[.)])\s+)?(?:(?:actually|also|no(?=\s*[:,])|sorry|right|look|hmm|wait|separately|however|yet|but|once\s+more|to\s+be\s+clear|for\s+(?:clarity|context|practical\s+purposes)|quick\s+note)\b\s*[:,]?\s*)*/iu,
  );
  return {
    offset: match[0].length,
    text: text.slice(match[0].length),
  };
}

function correctionRetractionAfterLeadIn(text) {
  return correctionRetractionControl(correctionWithoutNeutralLeadIn(text).text);
}

function correctionHistoricalPrefix(text) {
  return text.match(
    /^(?:(?:earlier|previously|at\s+the\s+time)\b\s*|my\s+earlier\s+view\s+(?:was\s+)?|i\s+(?:(?:previously|earlier)\s+)?(?:thought|believed|said|claimed)\b\s*)/iu,
  );
}

function correctionIsHistoricalResolution(text) {
  return /\b(?:after\s+(?:reviewing|checking|reconsidering)|on\s+review|the\s+result\s+shows|i\s+(?:retract|withdraw)|i\s+(?:take|took)\s+(?:that|it)\s+back|that\s+(?:(?:request|view|statement)\s+(?:no\s+longer\s+applies|was\s+mistaken)|was\s+mistaken)|i\s+(?:was|am)\s+mistaken|it\s+(?:is|was)\s+(?:right|correct)|you\s+did\s+not)\b/iu.test(
    text,
  );
}

function correctionExplicitCorrectionPayload(payload) {
  if (
    !payload ||
    /^(?:if|assuming|suppose|supposing|provided|providing)\b/iu.test(payload)
  ) {
    return false;
  }
  return [...payload.matchAll(/[\p{L}\p{N}_-]+/gu)].length >= 3;
}

function correctionRetractionControl(text) {
  const cancel = text.match(
    /^(?:please\s+)?(?:never[\s-]*mind|nevermind|disregard|ignore|scratch)\b\s*(?<tail>.*)$/iu,
  );
  if (cancel) {
    const target = cancel.groups.tail.trim();
    const current = target.match(
      /^(?:this|that|it|(?:my|our)\s+last\s+(?:note|message|point|comment|correction|feedback))(?=\s|[:,;.!?]|$)\s*/iu,
    );
    const tail = target.slice(current?.[0].length ?? 0);
    if (
      !tail ||
      /^[:,\u2014;.!?-]/u.test(tail) ||
      /^(?:please|let(?:'s|\s+us)\s+move\s+on)\b/iu.test(tail)
    ) {
      return { kind: "turn" };
    }
    const boundary = target.match(/\s*:\s*|\s+[\u2014-]\s*/u);
    if (boundary) {
      return {
        kind: "reference",
        end:
          cancel[0].length -
          cancel.groups.tail.length +
          boundary.index +
          boundary[0].length,
      };
    }
    return { kind: "reference" };
  }
  if (
    /^(?:i|we)\s+(?:(?:retract|withdraw)\s+(?:that|this|(?:my|our|the)\s+(?:last|current))\s+(?:statement|claim|correction|note)|(?:take|took)\s+(?:that|it)\s+back)\b/iu.test(
      text,
    )
  ) {
    return { kind: "claim" };
  }
  const named = text.match(
    /^(?:i|we)\s+(?:retract|withdraw)\s+(?:only\s+)?the\s+(?<target>[\p{L}\p{N}-]{1,48})\s+claim\b/iu,
  );
  if (named)
    return {
      kind: "claim",
      target: named.groups.target.toLocaleLowerCase("en-US"),
    };
  if (
    /^(?:please\s+)?(?:i|we)\s+(?:retract|withdraw)\s+(?:the|my|our)\s+(?:old|earlier|previous|prior)\b/iu.test(
      text,
    )
  ) {
    return { kind: "reference" };
  }
  return null;
}

function correctionHasDurableOptOut(text) {
  if (
    /(?:^|[.!?]\s+)(?:please\s+)?forget\s+(?:all\s+of\s+)?(?:this|that|it|everything|the\s+(?:conversation|prompt|feedback|correction|lesson))\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /(?:^|[.!?]\s+)(?:never[\s-]*mind|nevermind)\s+(?:the\s+)?(?:prior|previous|earlier)\s+(?:test|case|example|scenario)\s+(?:where|in\s+which)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:never[\s-]*mind|nevermind)\s+(?:about\s+)?(?:capture|remembrance|this\s+lesson|the\s+lesson|memory|learning)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:not\s+(?:a\s+)?correction|(?:this\s+is\s+)?(?:a\s+)?one[-\s]off|one\s+time\s+only|(?:just\s+an?|hypothetical|illustrative|contrived)\s+(?:example|scenario)(?:\s+only)?|this\s+is\s+(?:just\s+)?an?\s+example|this\s+is\s+(?:only\s+)?for\s+this\s+task|for\s+this\s+task\s+only)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (/\bthis\s+is\s+not\s+for\s+(?:remembrance|memory)\b/iu.test(text)) {
    return true;
  }
  if (
    /\b(?:i|we)\s+(?:do\s+not|don't|cannot|can't|will\s+not|won't)\s+consent\s+to\b.{0,128}\b(?:being\s+)?(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored|turn(?:ed)?\s+into)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:i|we)\s+(?:do\s+not|don't)\s+(?:want|wish)\b.{0,96}\b(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored|turn(?:ed)?\s+into)\b.{0,64}\b(?:lesson|memory|guidance|remembrance|skill|learning\s+record)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:i|we)\s+(?:do\s+not|don't)\s+(?:want|wish)\s+(?:this|that|it|anything|everything)\s+(?:to\s+be\s+)?(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:nothing|none)\s+(?:here|in\s+this\s+(?:conversation|prompt))?\s*(?:should|must|is\s+to)\s+(?:not\s+)?be\s+(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored)\b/iu.test(
      text,
    ) ||
    /\beverything\s+(?:here|in\s+this\s+(?:conversation|prompt))?\s*(?:should|must|is\s+to)\s+not\s+be\s+(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do\s+not|don't|never|no\s+need\s+to|please\s+do\s+not|please\s+don't)\s+(?:save|remember|record|learn(?:\s+from)?|capture|retain|preserve|derive|store|add)\b.{0,96}\b(?:this|that|it|anything|everything|conversation|prompt|feedback|correction|lesson|memory|guidance|remembrance|skill|learning\s+record)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do\s+not|don't|never|please\s+do\s+not|please\s+don't)\s+(?:turn|make|convert)\b.{0,96}\b(?:this|that|it|conversation|prompt|feedback|correction)\b.{0,96}\b(?:lesson|skill|memory|guidance|remembrance|learning\s+record)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do\s+not|don't|never|please\s+do\s+not|please\s+don't)\s+(?:reuse|include)\b.{0,128}\b(?:conversation|prompt|feedback|correction|lesson|memory|guidance|remembrance|learning\s+record|future|later)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:please\s+)?(?:exclude|omit)\b.{0,96}\b(?:this|that|it|conversation|prompt|feedback|correction|lesson)\b.{0,96}\b(?:future\s+guidance|memory|remembrance|learning\s+record|skill)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do\s+not|don't|never)\s+use\b.{0,96}\b(?:this|that|it|conversation|prompt|feedback|correction)\b.{0,96}\b(?:future|later|guidance|memory|lesson|skill|remembrance)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:i|we)\s+(?:would\s+prefer|would\s+rather|prefer|would\s+like|want)\b.{0,96}\bnot\s+(?:to\s+)?(?:be\s+)?(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored|turn(?:ed)?\s+into)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:i|we)\s+(?:would\s+prefer|would\s+rather|prefer|would\s+like|want)\s+(?:you\s+)?not\s+(?:to\s+)?(?:save|remember|record|learn|capture|retain|preserve|reuse|include|store)\s+(?:this|that|it|anything|everything)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:i|we)(?:'d|\s+would)?\s+(?:prefer|rather)\b.{0,96}\b(?:not\b.{0,48}\b(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored|turn(?:ed)?\b.{0,32}\binto)|stay\s+out\s+of\s+(?:memory|guidance|remembrance))\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:please\s+)?(?:refrain|abstain)\s+from\s+(?:saving|remembering|recording|learning|capturing|retaining|preserving|reusing|including|storing)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:please\s+)?(?:keep|leave)\b.{0,64}\b(?:this|that|it|conversation|prompt|feedback|correction|lesson)\b.{0,64}\b(?:out\s+of|off|outside)\b.{0,64}\b(?:memory|guidance|remembrance|learning\s+record|skill)\b/iu.test(
      text,
    ) ||
    /\b(?:please\s+)?keep\b.{0,64}\bfrom\s+being\s+(?:saved|remembered|recorded|learned|captured|retained|preserved|reused|included|stored)\b/iu.test(
      text,
    ) ||
    /\b(?:please\s+)?(?:keep|leave)\b.{0,64}\b(?:out\s+of|off|outside)\b.{0,64}\b(?:memory|guidance|remembrance|learning\s+record|skill)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:this|that|it|anything|everything)\s+(?:should|must)\s+stay\s+out\s+of\s+(?:shared\s+)?(?:memory|guidance|remembrance|learning\s+record|skill)\b/iu.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(?:this|that|it)\s+(?:should|must)\s+(?:not|never)\s+(?:become|turn\s+into|be\s+used\s+as)\s+(?:a\s+|the\s+)?(?:lesson|skill|memory|guidance|feedback)\b/iu.test(
    text,
  );
}
