// Owner decision 2 (Task 13): a remembrance follow-up's payload is kept on
// this machine only sealed with the private-learning outbox key, by the rules
// the bundled MCP server's outbox follows (private-lesson-keychain.ts and
// resolvePrivateLessonOutboxEncryption): the login Keychain item first, then
// an existing mode-0600 key file; a new key only where the outbox would make
// one and only while nothing retained could need another; never a replaced
// key. The Keychain is a stand-in command here; no test reaches the real one.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideStop,
  markCompletionObligationsPrompted,
  observeSuccessfulCompletionTool,
  pendingCompletionRecoveryInstruction,
  readCompletionObligations,
  useKeychainExecutorForTests,
} from "../scripts/hook-core.mjs";
import {
  resupplyPayloadDigest,
  sealResupplyPayload,
} from "../scripts/pending-action-payload.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-retained-key-"));
let counter = 0;
const SESSION = "retained-key-session";
const ACCOUNT = `uid-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
const LESSON = "Pin the toolchain before bisecting a flaky build.";

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function testEnv() {
  counter += 1;
  const root = join(tempRoot, `env-${counter}`);
  return {
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    REMEMBRANCE_USAGE_DIR: join(root, "usage"),
    REMEMBRANCE_VISIBLE_COMPLETION_RECOVERY: "1",
  };
}

const keyPath = (env) =>
  join(env.XDG_CONFIG_HOME, "remembrance", "private-lesson-outbox.key");

function payloadFor(id) {
  return {
    schema_version: "0.1",
    type: "skill_use",
    lesson: `${LESSON} (${id})`,
    interaction: { query_id: `rq_${id}`, result_id: `qres_${id}` },
  };
}

function feedback(env, id) {
  const payload = payloadFor(id);
  observeSuccessfulCompletionTool(
    SESSION,
    "submit_feedback",
    payload.interaction,
    { body: { next_step: { submit_remembrance_payload: payload } } },
    env,
  );
  return {
    payload,
    obligation: readCompletionObligations(SESSION, env).find(
      (item) => item.query_id === `rq_${id}`,
    ),
  };
}

const BEHAVIOR = "Write the changelog entry before changing the code.";

function preferenceFor(id) {
  return {
    setting: {
      key: "workflow.changelog_first",
      value: `before_code_${id.replace(/[^a-z0-9]/gu, "_")}`,
      label: "Changelog first",
      behavior: BEHAVIOR,
      effect: "workflow",
    },
    scope: "member",
  };
}

// A capture_learning preference route the hook observes.
function preference(env, id) {
  const preferenceArguments = preferenceFor(id);
  observeSuccessfulCompletionTool(
    SESSION,
    "capture_learning",
    { preference: preferenceArguments },
    {
      capture_route: "preference",
      persisted_locally: false,
      next_action: {
        tool: "record_preference",
        arguments: preferenceArguments,
      },
    },
    env,
  );
  return {
    preference: preferenceArguments,
    obligation: readCompletionObligations(SESSION, env).find(
      (item) => item.kind === "capture_next_action",
    ),
  };
}

const shownPayloads = (text) =>
  text
    .split("\n")
    .filter((line) => line.includes('"lesson"'))
    .map((line) => JSON.parse(line));

const stopPayloads = (env) =>
  shownPayloads(
    decideStop(
      { session_id: SESSION, hook_event_name: "Stop" },
      { env, visibleCompletionRecovery: true },
    ).reason,
  );

// Every ledger file of the session, as text, in both of its homes: the
// durable one that keeps sealed payloads, and the temporary usage directory.
function ledgerText(env) {
  const ledger = `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.obligations`;
  return [
    join(
      env.XDG_STATE_HOME,
      "remembrance",
      "private-learning-lifecycle",
      "retained",
      ledger,
    ),
    join(env.REMEMBRANCE_USAGE_DIR, ledger),
  ]
    .flatMap((directory) =>
      existsSync(directory)
        ? readdirSync(directory).map((name) =>
            readFileSync(join(directory, name), "utf8"),
          )
        : [],
    )
    .join("\n");
}

// A follow-up another session left sealed with a key this machine no longer
// has, in `directory` (a ledger in the durable or the temporary home).
function sealedElsewhere(directory) {
  const payload = payloadFor("elsewhere");
  const digest = resupplyPayloadDigest(payload);
  const id = `remembrance_followup:${digest}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(
      directory,
      `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`,
    ),
    `${JSON.stringify({
      version: "completion-obligation-v1",
      id,
      kind: "remembrance_followup",
      payload_digest: digest,
      created_at: new Date().toISOString(),
      local_resupply_envelope: sealResupplyPayload(
        { id, payload_digest: digest },
        payload,
        { key: randomBytes(32), source: "mode_0600_file" },
      ),
    })}\n`,
    { mode: 0o600 },
  );
}
const durableLedger = (env, name) =>
  join(
    env.XDG_STATE_HOME,
    "remembrance",
    "private-learning-lifecycle",
    "retained",
    `${name.repeat(16)}.obligations`,
  );

// The `security` tool as the outbox calls it: `find-generic-password ... -w`
// prints the item or exits 44 when there is none; `-i` reads an add command
// from stdin.
function keychain(initial, key = randomBytes(32)) {
  const state = { status: initial, key };
  const calls = [];
  const executor = (file, args, options) => {
    calls.push({ file, args, input: options?.input ?? null });
    if (file !== "/usr/bin/security") throw new Error("unexpected command");
    if (args[0] === "find-generic-password") {
      if (state.status === "ready")
        return `${state.key.toString("base64url")}\n`;
      if (state.status === "invalid") return "not-a-key\n";
      throw Object.assign(new Error("security failed"), {
        status: state.status === "confirmed_missing" ? 44 : 51,
      });
    }
    const added =
      /^add-generic-password -s dev\.remembrance\.private-lessons -a (\S+) -w ([A-Za-z0-9_-]{43})\n$/u.exec(
        options?.input ?? "",
      );
    if (args.length !== 1 || args[0] !== "-i" || !added) {
      throw new Error("unexpected security command");
    }
    if (state.status === "confirmed_missing") {
      state.status = "ready";
      state.key = Buffer.from(added[2], "base64url");
    }
    return "";
  };
  return { state, calls, executor };
}

describe("a retained payload's local key", () => {
  let optOut;
  beforeEach(() => {
    // The package setup opts every test out of the Keychain; these tests put
    // a stand-in in its place instead.
    optOut = process.env.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN;
    delete process.env.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN;
  });
  afterEach(() => {
    process.env.REMEMBRANCE_PRIVATE_LESSON_KEYCHAIN = optOut;
    useKeychainExecutorForTests();
  });

  it("seals with the login Keychain item when it exists, and writes no key file", () => {
    const env = testEnv();
    const stand = keychain("ready");
    useKeychainExecutorForTests(stand.executor);
    const { payload, obligation } = feedback(env, "keychain");

    expect(obligation).toMatchObject({
      local_resupply_payload: null,
      local_resupply_payload_omitted: null,
      local_resupply_envelope: expect.objectContaining({
        key_source: "os_keychain",
      }),
    });
    expect(existsSync(keyPath(env))).toBe(false);
    expect(ledgerText(env)).not.toContain(LESSON);
    expect(stopPayloads(env)).toEqual([payload]);
    expect(stand.calls.map((call) => call.args)).toContainEqual([
      "find-generic-password",
      "-s",
      "dev.remembrance.private-lessons",
      "-a",
      ACCOUNT,
      "-w",
    ]);
    expect(stand.calls.some((call) => call.args[0] === "-i")).toBe(false);
  });

  it("adds the Keychain item where the outbox would, with the key only on stdin", () => {
    const env = testEnv();
    const stand = keychain("confirmed_missing");
    useKeychainExecutorForTests(stand.executor);
    const { payload, obligation } = feedback(env, "added");

    const adds = stand.calls.filter((call) => call.args[0] === "-i");
    expect(adds).toHaveLength(1);
    expect(adds[0].args).toEqual(["-i"]);
    expect(adds[0].input).toContain(`-a ${ACCOUNT} -w `);
    expect(stand.state.status).toBe("ready");
    expect(obligation.local_resupply_envelope.key_source).toBe("os_keychain");
    expect(existsSync(keyPath(env))).toBe(false);
    expect(stopPayloads(env)).toEqual([payload]);
    // A second payload reuses the item: no second add.
    feedback(env, "added-again");
    expect(stand.calls.filter((call) => call.args[0] === "-i")).toHaveLength(1);
  });

  it("falls back to a new mode-0600 key file while the Keychain is unavailable, and never switches an envelope's key", () => {
    const env = testEnv();
    const stand = keychain("unavailable");
    useKeychainExecutorForTests(stand.executor);
    const first = feedback(env, "outage");
    expect(first.obligation.local_resupply_envelope.key_source).toBe(
      "mode_0600_file",
    );
    const fileKey = readFileSync(keyPath(env), "utf8");
    expect(Buffer.from(fileKey.trim(), "base64url")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(statSync(keyPath(env)).mode & 0o777).toBe(0o600);
    }
    // No Keychain add from an unknown state.
    expect(stand.calls.some((call) => call.args[0] === "-i")).toBe(false);

    // Once the Keychain answers, it takes precedence for new payloads, as in
    // the outbox; the first payload still opens with the file it names.
    stand.state.status = "ready";
    const second = feedback(env, "restored");
    expect(second.obligation.local_resupply_envelope.key_source).toBe(
      "os_keychain",
    );
    expect(stopPayloads(env)).toEqual([first.payload, second.payload]);
    expect(readFileSync(keyPath(env), "utf8")).toBe(fileKey);
  });

  // Review R3 (Task 14): another first use may make the key and seal with it
  // between this hook's lookup and its count of retained items; the hook
  // looks once more and seals with that key, making none of its own.
  it("seals with the key a concurrent first use made while it counted retained items, and makes none", () => {
    const env = testEnv();
    sealedElsewhere(durableLedger(env, "e"));
    const stand = keychain("confirmed_missing");
    let finds = 0;
    useKeychainExecutorForTests((file, args, options) => {
      if (args[0] === "find-generic-password" && ++finds === 2) {
        stand.state.status = "ready";
      }
      return stand.executor(file, args, options);
    });
    const { payload, obligation } = feedback(env, "concurrent");
    expect(obligation.local_resupply_envelope.key_source).toBe("os_keychain");
    expect(finds).toBe(2);
    expect(stand.calls.some((call) => call.args[0] === "-i")).toBe(false);
    expect(existsSync(keyPath(env))).toBe(false);
    expect(stopPayloads(env)).toEqual([payload]);
  });

  it("reuses an existing key file and never replaces it", () => {
    const env = testEnv();
    useKeychainExecutorForTests(keychain("confirmed_missing").executor);
    mkdirSync(join(env.XDG_CONFIG_HOME, "remembrance"), {
      recursive: true,
      mode: 0o700,
    });
    const existing = `${randomBytes(32).toString("base64url")}\n`;
    writeFileSync(keyPath(env), existing, { mode: 0o600 });

    const { payload, obligation } = feedback(env, "existing-file");
    expect(obligation.local_resupply_envelope.key_source).toBe(
      "mode_0600_file",
    );
    expect(readFileSync(keyPath(env), "utf8")).toBe(existing);
    expect(stopPayloads(env)).toEqual([payload]);
  });

  it("reads the Keychain at most once per demand, and not for a payload too large to show", () => {
    const env = testEnv();
    const stand = keychain("ready");
    useKeychainExecutorForTests(stand.executor);
    const small = [feedback(env, "small-1"), feedback(env, "small-2")];
    const large = payloadFor("large");
    large.lesson = `${large.lesson} ${"w".repeat(2500)}`;
    observeSuccessfulCompletionTool(
      SESSION,
      "submit_feedback",
      large.interaction,
      { body: { next_step: { submit_remembrance_payload: large } } },
      env,
    );
    const reads = () =>
      stand.calls.filter((call) => call.args[0] === "find-generic-password")
        .length;

    let before = reads();
    const demand = pendingCompletionRecoveryInstruction(SESSION, env);
    expect(shownPayloads(demand)).toEqual([small[0].payload]);
    expect(reads() - before).toBe(1);
    // A stop shows all three and still reads the key once.
    before = reads();
    expect(stopPayloads(env)).toEqual([
      small[0].payload,
      small[1].payload,
      large,
    ]);
    expect(reads() - before).toBe(1);

    // Only the large payload is left to show: its key is never read.
    for (const { payload } of small) {
      observeSuccessfulCompletionTool(
        SESSION,
        "submit_remembrance",
        payload,
        { accepted: true },
        env,
      );
    }
    before = reads();
    expect(pendingCompletionRecoveryInstruction(SESSION, env)).toContain(
      "- Reusable evidence for query_id rq_large and result_id qres_large: payload kept on this machine (",
    );
    expect(reads() - before).toBe(0);
  });

  for (const [label, prepare] of [
    ["an unusable Keychain item", () => keychain("invalid")],
    [
      "a retained private-learning draft and no key",
      (env) => {
        const lane = join(env.XDG_STATE_HOME, "remembrance", "private-lessons");
        mkdirSync(lane, { recursive: true, mode: 0o700 });
        writeFileSync(join(lane, "pld_retained.json"), "{}\n", { mode: 0o600 });
        return keychain("confirmed_missing");
      },
    ],
    // Review R3 (Task 14): every retained consumer of the key counts, and
    // what the inventory cannot account for holds as well.
    [
      "a sealed payload in a durable hook ledger and the Keychain item gone",
      (env) => {
        sealedElsewhere(durableLedger(env, "a"));
        return keychain("confirmed_missing");
      },
    ],
    [
      "a sealed payload an earlier build left in a temporary ledger and no key",
      (env) => {
        sealedElsewhere(join(env.REMEMBRANCE_USAGE_DIR, `${"b".repeat(16)}.obligations`));
        return keychain("confirmed_missing");
      },
    ],
    [
      "a sealed payload and a Keychain that cannot answer",
      (env) => {
        sealedElsewhere(durableLedger(env, "c"));
        return keychain("unavailable");
      },
    ],
    [
      "a hook ledger reached through a symlink",
      (env) => {
        const outside = join(env.XDG_STATE_HOME, "..", "outside-ledger");
        mkdirSync(outside, { recursive: true, mode: 0o700 });
        mkdirSync(env.REMEMBRANCE_USAGE_DIR, { recursive: true, mode: 0o700 });
        symlinkSync(
          outside,
          join(env.REMEMBRANCE_USAGE_DIR, `${"d".repeat(16)}.obligations`),
        );
        return keychain("confirmed_missing");
      },
    ],
  ]) {
    it(`keeps the debt but not the payload with ${label}`, () => {
      const env = testEnv();
      const stand = prepare(env);
      useKeychainExecutorForTests(stand.executor);
      const { obligation } = feedback(env, "no-key");

      expect(obligation).toMatchObject({
        kind: "remembrance_followup",
        local_resupply_payload: null,
        local_resupply_envelope: null,
        local_resupply_payload_omitted: "key_unavailable",
      });
      // No key was made or switched, and no prose is on disk.
      expect(existsSync(keyPath(env))).toBe(false);
      expect(stand.calls.some((call) => call.args[0] === "-i")).toBe(false);
      expect(ledgerText(env)).not.toContain(LESSON);
      expect(pendingCompletionRecoveryInstruction(SESSION, env)).toContain(
        "- Reusable evidence for query_id rq_no-key and result_id qres_no-key: payload not retained because the local encryption key was unavailable; call submit_remembrance with the payload submit_feedback returned only if you still hold it verbatim.",
      );
    });

    // Review F5 (Task 14): a durable preference's arguments follow the same
    // key rules as a follow-up's payload.
    it(`keeps a durable preference's debt but not its arguments with ${label}`, () => {
      const env = testEnv();
      const stand = prepare(env);
      useKeychainExecutorForTests(stand.executor);
      const { obligation } = preference(env, "no-key");

      expect(obligation).toMatchObject({
        kind: "capture_next_action",
        action_tool: "record_preference",
        local_resupply_payload: null,
        local_resupply_envelope: null,
        local_resupply_payload_omitted: "key_unavailable",
      });
      expect(existsSync(keyPath(env))).toBe(false);
      expect(stand.calls.some((call) => call.args[0] === "-i")).toBe(false);
      expect(ledgerText(env)).not.toContain(BEHAVIOR);
      expect(
        pendingCompletionRecoveryInstruction(SESSION, env).split("\n"),
      ).toContain(
        "- Durable preference: arguments not retained because the local encryption key was unavailable; call record_preference with the arguments capture_learning returned only if you still hold them verbatim.",
      );
    });
  }

  it("seals a durable preference's arguments with the login Keychain item, and never reads it to show a demand", () => {
    const env = testEnv();
    const stand = keychain("ready");
    useKeychainExecutorForTests(stand.executor);
    const { obligation } = preference(env, "keychain");

    expect(obligation).toMatchObject({
      local_resupply_payload: null,
      local_resupply_payload_omitted: null,
      local_resupply_envelope: expect.objectContaining({
        key_source: "os_keychain",
      }),
    });
    expect(existsSync(keyPath(env))).toBe(false);
    expect(ledgerText(env)).not.toContain(BEHAVIOR);
    const reads = () =>
      stand.calls.filter((call) => call.args[0] === "find-generic-password")
        .length;
    // Its demand names the handle only: no key read, at a prompt or a stop.
    const before = reads();
    const demand = pendingCompletionRecoveryInstruction(SESSION, env);
    expect(demand).toContain(
      `- Durable preference: arguments kept on this machine (${Buffer.byteLength(JSON.stringify(preferenceFor("keychain")))} bytes, ${obligation.payload_digest}); call local get_pending_action_payload with action_id `,
    );
    expect(demand).not.toContain(BEHAVIOR);
    expect(
      decideStop(
        { session_id: SESSION, hook_event_name: "Stop" },
        { env, visibleCompletionRecovery: true },
      ).reason,
    ).not.toContain(BEHAVIOR);
    expect(reads() - before).toBe(0);
  });
});

describe("a retained payload in file-key mode", () => {
  it("shows the handle, not a guess, when its key cannot be read at demand time", () => {
    const env = testEnv();
    const { payload, obligation } = feedback(env, "lost-key");
    expect(obligation.local_resupply_envelope.key_source).toBe(
      "mode_0600_file",
    );
    rmSync(keyPath(env));

    const demand = pendingCompletionRecoveryInstruction(SESSION, env);
    expect(shownPayloads(demand)).toEqual([]);
    expect(demand).toContain(
      `- Reusable evidence for query_id rq_lost-key and result_id qres_lost-key: payload kept on this machine (${Buffer.byteLength(JSON.stringify(payload))} bytes, ${obligation.payload_digest}); call local get_pending_action_payload`,
    );
    expect(stopPayloads(env)).toEqual([]);
    expect(readCompletionObligations(SESSION, env)).toHaveLength(1);
    // No new key is made while the first payload may need the lost one, so
    // restoring that key recovers it; the next payload is not kept.
    const next = feedback(env, "after-loss");
    expect(next.obligation).toMatchObject({
      local_resupply_envelope: null,
      local_resupply_payload_omitted: "key_unavailable",
    });
    expect(existsSync(keyPath(env))).toBe(false);
  });

  it("reads a plaintext record an earlier version kept, and carries it unconverted", () => {
    const env = testEnv();
    const payload = payloadFor("legacy");
    const sorted = (value) =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, sorted(value[key])]),
            )
          : value;
    const digest = `sha256:${createHash("sha256")
      .update(JSON.stringify(sorted(payload)))
      .digest("hex")}`;
    const id = `remembrance_followup:${digest}`;
    const directory = join(
      env.REMEMBRANCE_USAGE_DIR,
      `${createHash("sha256").update(SESSION).digest("hex").slice(0, 16)}.obligations`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // As the 0.2.0-candidate hook (master d29e49ed) wrote it.
    writeFileSync(
      join(
        directory,
        `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`,
      ),
      `${JSON.stringify({
        version: "completion-obligation-v1",
        id,
        kind: "remembrance_followup",
        engagement_count: 1,
        query_id: "rq_legacy",
        result_id: "qres_legacy",
        draft_id: null,
        skill_slug: null,
        payload_digest: digest,
        local_resupply_payload: payload,
        local_resupply_payload_omitted: null,
        agent_keyed: true,
        transferred_from: null,
        action_tool: null,
        next_retry_at: null,
        failed_credential_digest: null,
        delivery_blocked: false,
        created_at: new Date().toISOString(),
        prompted_at: null,
      })}\n`,
      { mode: 0o600 },
    );

    expect(
      shownPayloads(pendingCompletionRecoveryInstruction(SESSION, env)),
    ).toEqual([payload]);
    // A lifecycle rewrite keeps it exactly as it was; no key is made for it.
    expect(markCompletionObligationsPrompted(SESSION, null, env)).toBe(1);
    const [kept] = readCompletionObligations(SESSION, env);
    expect(kept).toMatchObject({
      local_resupply_payload: payload,
      local_resupply_envelope: null,
    });
    expect(kept.prompted_at).not.toBeNull();
    expect(existsSync(keyPath(env))).toBe(false);
    // Submitting it closes it.
    observeSuccessfulCompletionTool(
      SESSION,
      "submit_remembrance",
      payload,
      { accepted: true },
      env,
    );
    expect(readCompletionObligations(SESSION, env)).toEqual([]);
  });
});
