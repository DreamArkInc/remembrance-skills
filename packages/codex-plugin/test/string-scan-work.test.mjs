import { describe, expect, it } from "vitest";
import { observeSelectedRegexExecutions } from "./fixtures/string-scan-work.mjs";

describe("selected regex execution observer", () => {
  it("preserves unbounded observation and unrelated regex behavior", () => {
    const original = RegExp.prototype.exec;
    const selected = /selected/u;
    expect(
      observeSelectedRegexExecutions(
        () => [/other/u.test("other"), selected.test("selected")],
        (pattern) => pattern === selected,
      ),
    ).toEqual({ value: [true, true], executions: 1 });
    expect(RegExp.prototype.exec).toBe(original);
  });

  it("stops before executing the first forbidden regex or subsequent work", () => {
    const original = RegExp.prototype.exec;
    const selected = /selected/gu;
    let continued = false;
    expect(
      observeSelectedRegexExecutions(
        () => {
          selected.test("selected");
          continued = true;
        },
        (pattern) => pattern === selected,
        { maxExecutions: 0 },
      ),
    ).toEqual({ value: undefined, executions: 1 });
    expect(selected.lastIndex).toBe(0);
    expect(continued).toBe(false);
    expect(RegExp.prototype.exec).toBe(original);
  });

  it("counts allowed executions before stopping at a finite limit", () => {
    const selected = /a/gu;
    expect(
      observeSelectedRegexExecutions(
        () => {
          selected.test("aaa");
          selected.test("aaa");
          selected.test("aaa");
        },
        (pattern) => pattern === selected,
        { maxExecutions: 2 },
      ),
    ).toEqual({ value: undefined, executions: 3 });
    expect(selected.lastIndex).toBe(2);
  });

  it("propagates unrelated failures and restores the runtime", () => {
    const original = RegExp.prototype.exec;
    const failure = new Error("fixture failed");
    expect(() =>
      observeSelectedRegexExecutions(
        () => {
          throw failure;
        },
        () => false,
        { maxExecutions: 0 },
      ),
    ).toThrow(failure);
    expect(RegExp.prototype.exec).toBe(original);
  });

  it.each([-1, 0.5, NaN, -Infinity])("rejects invalid limit %s", (limit) => {
    const original = RegExp.prototype.exec;
    expect(() =>
      observeSelectedRegexExecutions(
        () => false,
        () => true,
        {
          maxExecutions: limit,
        },
      ),
    ).toThrow(RangeError);
    expect(RegExp.prototype.exec).toBe(original);
  });
});
