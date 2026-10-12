// Observe real string operations, not scanner-owned accounting or CPU time.
// Runs are synchronous; restoring every method also keeps failed probes isolated.
export function observeStringScanWork(run) {
  const original = {
    slice: String.prototype.slice,
    search: String.prototype.search,
    charCodeAt: String.prototype.charCodeAt,
  };
  const originalTest = RegExp.prototype.test;
  const originalExec = RegExp.prototype.exec;
  const work = {
    copiedCodeUnits: 0,
    searchedCodeUnits: 0,
    characterReads: 0,
    regexTestCodeUnits: 0,
    regexExecCodeUnits: 0,
  };
  String.prototype.slice = function observedSlice(...args) {
    const output = Reflect.apply(original.slice, this, args);
    work.copiedCodeUnits += output.length;
    return output;
  };
  String.prototype.search = function observedSearch(...args) {
    work.searchedCodeUnits += this.length;
    return Reflect.apply(original.search, this, args);
  };
  String.prototype.charCodeAt = function observedCharCodeAt(...args) {
    work.characterReads += 1;
    return Reflect.apply(original.charCodeAt, this, args);
  };
  RegExp.prototype.test = function observedTest(input) {
    const text = String(input);
    work.regexTestCodeUnits += this.global || this.sticky ? 0 : text.length;
    return Reflect.apply(originalTest, this, [text]);
  };
  // Also covers regex execution reached through search/match/replace. Nested
  // API calls are intentionally counted and pinned by the calibration test.
  RegExp.prototype.exec = function observedExec(input) {
    const text = String(input);
    const start =
      this.global || this.sticky
        ? Math.min(
            text.length,
            Math.max(0, Math.trunc(Number(this.lastIndex) || 0)),
          )
        : 0;
    const result = Reflect.apply(originalExec, this, [text]);
    // Global matches reuse the same input but advance lastIndex. Counting that
    // input in full on every match would invent quadratic work for a linear scan.
    // A sticky failure tests only its current position (as used by String.split),
    // not every remaining possible starting position like an unanchored search.
    const scanned = result
      ? Math.max(0, result.index - start) + result[0].length
      : this.sticky
        ? 1
        : text.length - start;
    work.regexExecCodeUnits += Math.max(1, scanned);
    return result;
  };
  try {
    const value = run();
    return {
      value,
      work,
      total:
        work.copiedCodeUnits +
        work.searchedCodeUnits +
        work.characterReads +
        work.regexTestCodeUnits +
        work.regexExecCodeUnits,
    };
  } finally {
    Object.assign(String.prototype, original);
    RegExp.prototype.test = originalTest;
    RegExp.prototype.exec = originalExec;
  }
}

export function observePairedStringWork(operation, inputs, reverse = false) {
  const indexes = reverse ? [1, 0] : [0, 1];
  const observations = [];
  for (const index of indexes) {
    observations[index] = observeStringScanWork(() => operation(inputs[index]));
  }
  const workRatios = Object.fromEntries(
    Object.keys(observations[0].work).map((kind) => {
      const smaller = observations[0].work[kind];
      const larger = observations[1].work[kind];
      return [kind, smaller ? larger / smaller : larger ? Infinity : 1];
    }),
  );
  return {
    observations,
    workRatios,
    totalRatio: observations[1].total / observations[0].total,
    // Linear work in another category cannot hide a quadratic rescan.
    ratio: Math.max(...Object.values(workRatios)),
  };
}

export function observeSelectedRegexExecutions(
  run,
  select,
  { maxExecutions = Infinity } = {},
) {
  if (
    maxExecutions !== Infinity &&
    (!Number.isInteger(maxExecutions) || maxExecutions < 0)
  )
    throw new RangeError("Invalid regex observation limit.");
  const original = RegExp.prototype.exec;
  const stopped = Symbol("selected-regex-execution-limit");
  let executions = 0;
  RegExp.prototype.exec = function observedSelectedExec(input) {
    if (select(this)) {
      executions += 1;
      // The first prohibited invocation is enough evidence; do not run its body.
      if (executions > maxExecutions) throw stopped;
    }
    return Reflect.apply(original, this, [input]);
  };
  try {
    return { value: run(), executions };
  } catch (error) {
    if (error !== stopped) throw error;
    return { value: undefined, executions };
  } finally {
    RegExp.prototype.exec = original;
  }
}
