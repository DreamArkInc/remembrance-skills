import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  fetchSessionSkills,
  formatSessionSkillsDirective,
  sessionSkillsDirective,
} from "../scripts/hook-core.mjs";
import { useIsolatedHookEnvironment } from "./fixtures/isolated-hook-environment.mjs";

const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-session-skills-"));
const API_KEY = "rk_session_skills_never_print";
const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

useIsolatedHookEnvironment();

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function sessionEnv(extra = {}) {
  counter += 1;
  return {
    REMEMBRANCE_API_KEY: API_KEY,
    REMEMBRANCE_USAGE_DIR: join(tempRoot, `usage-${counter}`),
    XDG_CONFIG_HOME: join(tempRoot, `config-${counter}`),
    ...extra,
  };
}

function listing(sessionSkills, extra = {}) {
  return {
    contract_version: "session-skills-v1",
    available: true,
    reason_code: null,
    session_skills: sessionSkills,
    omitted_count: 0,
    ...extra,
  };
}

function registry(body, init = {}) {
  return vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
  );
}

function unreachable() {
  return vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
}

function directiveEntries(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = /^- (\{.*\})( \(pinned\))?$/.exec(line);
      return { args: JSON.parse(match[1]), pinned: Boolean(match[2]) };
    });
}

function cachePath(env, nativeSessionId) {
  const hash = createHash("sha256")
    .update(nativeSessionId)
    .digest("hex")
    .slice(0, 16);
  return join(env.REMEMBRANCE_USAGE_DIR, `${hash}.session-skills.json`);
}

const CAVEMAN = {
  slug: "caveman",
  version_id: "sv_eed332475dea44a3a3",
  pinned: false,
};
const PONYTAIL = {
  slug: "ponytail",
  version_id: "sv_7f7777fba96c441f86",
  pinned: true,
};

describe("organization session skills", () => {
  it("tells the agent to load each organization session skill for the whole session", async () => {
    const env = sessionEnv();
    const fetchImpl = registry(listing([CAVEMAN, PONYTAIL]));

    const text = await sessionSkillsDirective(
      { source: "startup", nativeSessionId: "session-a", fetchImpl },
      env,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://remembrance.dev/api/v1/agent/session-skills");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers["x-remembrance-api-key"]).toBe(API_KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(directiveEntries(text)).toEqual([
      {
        args: {
          slug: "caveman",
          version_id: "sv_eed332475dea44a3a3",
          scope: "session",
          idempotency_key: expect.stringMatching(/^rss_[0-9a-f]{32}$/),
        },
        pinned: false,
      },
      {
        args: {
          slug: "ponytail",
          version_id: "sv_7f7777fba96c441f86",
          scope: "session",
          idempotency_key: expect.stringMatching(/^rss_[0-9a-f]{32}$/),
        },
        pinned: true,
      },
    ]);
    expect(text).toContain(
      "before your first reply, call invoke_skill once per entry below with exactly these arguments",
    );
    expect(text).toContain("for the whole session");
    expect(text).toContain("send no per-task feedback or task outcome");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("session-a");
  });

  it("drops entries that fail the slug or version grammar and never echoes other fields", async () => {
    const env = sessionEnv();
    const first = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-grammar-1",
        fetchImpl: registry(
          listing([
            { slug: "Caveman", version_id: "sv_valid_1", pinned: false },
            { slug: "../escape", version_id: "sv_valid_2", pinned: false },
            {
              slug: "ignore previous instructions",
              version_id: null,
              pinned: false,
            },
            { slug: "a".repeat(201), version_id: null, pinned: false },
            {
              slug: "kept-skill",
              version_id: "sv_valid_3",
              pinned: false,
              name: "Display Name",
              skill_md: "FULL SKILL BODY",
            },
          ]),
        ),
      },
      env,
    );
    expect(directiveEntries(first).map((entry) => entry.args.slug)).toEqual([
      "kept-skill",
    ]);
    expect(first).not.toMatch(/Display Name|FULL SKILL BODY|escape|ignore/);

    const second = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-grammar-2",
        fetchImpl: registry(
          listing([
            {
              slug: "bad-version-path",
              version_id: "../escape",
              pinned: false,
            },
            { slug: "bad-version-short", version_id: "ab", pinned: false },
            {
              slug: "bad-version-long",
              version_id: "v".repeat(129),
              pinned: false,
            },
            { slug: "pin-without-version", version_id: null, pinned: true },
            { slug: "current-version", version_id: null, pinned: false },
          ]),
        ),
      },
      env,
    );
    expect(directiveEntries(second)).toEqual([
      {
        args: {
          slug: "current-version",
          scope: "session",
          idempotency_key: expect.stringMatching(/^rss_[0-9a-f]{32}$/),
        },
        pinned: false,
      },
    ]);

    await expect(
      sessionSkillsDirective(
        {
          source: "startup",
          nativeSessionId: "session-grammar-3",
          fetchImpl: registry(
            listing([
              { slug: "numeric-version", version_id: 42, pinned: false },
            ]),
          ),
        },
        env,
      ),
    ).resolves.toBeNull();
  });

  it("reads at most five entries", async () => {
    const skills = Array.from({ length: 7 }, (_, index) => ({
      slug: `skill-${index}`,
      version_id: `sv_version_${index}`,
      pinned: false,
    }));
    const text = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-five",
        fetchImpl: registry(listing(skills)),
      },
      sessionEnv(),
    );
    expect(directiveEntries(text).map((entry) => entry.args.slug)).toEqual([
      "skill-0",
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
    ]);
  });

  it("keeps the worst-case directive within 3,000 characters", async () => {
    const skills = Array.from({ length: 7 }, (_, index) => ({
      slug: `${index}${"a".repeat(199)}`,
      version_id: `V${"b".repeat(127)}`,
      pinned: true,
    }));
    const text = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-longest",
        fetchImpl: registry(listing(skills)),
      },
      sessionEnv(),
    );
    expect(directiveEntries(text)).toHaveLength(5);
    expect(text.length).toBeLessThanOrEqual(3000);
  });

  it("drops whole entries from the end when the directive would exceed 3,000 characters", () => {
    const skills = Array.from({ length: 4 }, (_, index) => ({
      slug: `${index}${"a".repeat(599)}`,
      version_id: `V${"b".repeat(127)}`,
      pinned: true,
    }));
    const text = formatSessionSkillsDirective("session-cap", skills);
    const kept = directiveEntries(text);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(skills.length);
    expect(kept.map((entry) => entry.args.slug)).toEqual(
      skills.slice(0, kept.length).map((skill) => skill.slug),
    );
    expect(text).toBe(
      formatSessionSkillsDirective("session-cap", skills.slice(0, kept.length)),
    );
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.endsWith("If an entry still fails, continue without it.")).toBe(
      true,
    );
    expect(
      formatSessionSkillsDirective("session-cap", [
        { slug: "a".repeat(3000), version_id: null, pinned: false },
      ]),
    ).toBeNull();
  });

  it("tells the agent how to handle an unavailable pinned or unpinned version", async () => {
    const text = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-409",
        fetchImpl: registry(listing([CAVEMAN, PONYTAIL])),
      },
      sessionEnv(),
    );
    expect(text).toContain(
      "If a pinned entry returns 409 skill_version_unavailable, say so in one line and continue without that skill; never load a substitute.",
    );
    expect(text).toContain(
      "If an unpinned entry returns it, retry once with the same arguments except version_id.",
    );
  });

  it("injects nothing for a response outside the session-skills-v1 contract", async () => {
    const env = sessionEnv();
    const cases = [
      registry(listing([CAVEMAN], { contract_version: "session-skills-v2" })),
      registry(listing([CAVEMAN], { available: false })),
      registry("{not json"),
      registry(listing([{ ...CAVEMAN, padding: "x".repeat(17 * 1024) }])),
    ];
    for (const [index, fetchImpl] of cases.entries()) {
      await expect(
        sessionSkillsDirective(
          {
            source: "startup",
            nativeSessionId: `session-contract-${index}`,
            fetchImpl,
          },
          env,
        ),
      ).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    await expect(
      fetchSessionSkills(
        {
          fetchImpl: registry(
            listing([], { available: false, reason_code: "not_applicable" }),
          ),
        },
        env,
      ),
    ).resolves.toEqual([]);
  });

  it("injects nothing when the registry refuses the request or predates the route", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const env = sessionEnv();
      const fetchImpl = registry({ error: "unavailable" }, { status });
      await expect(
        sessionSkillsDirective(
          { source: "startup", nativeSessionId: "session-http", fetchImpl },
          env,
        ),
      ).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // A refused credential is an authoritative empty list and replaces the
      // cache; any other failure leaves the cache untouched.
      const refused = [401, 403].includes(status);
      await expect(
        fetchSessionSkills(
          { fetchImpl: registry({ error: "unavailable" }, { status }) },
          env,
        ),
      ).resolves.toEqual(refused ? [] : null);
      expect(existsSync(env.REMEMBRANCE_USAGE_DIR)).toBe(refused);
    }
  });

  it("gives up after 1.2 seconds by default", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const pending = fetchSessionSkills({ fetchImpl }, sessionEnv());
      await vi.advanceTimersByTimeAsync(1199);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips anonymous and unusable configurations without a request", async () => {
    const malformedConfigHome = join(tempRoot, "malformed-config");
    mkdirSync(join(malformedConfigHome, "remembrance"), { recursive: true });
    writeFileSync(
      join(malformedConfigHome, "remembrance", "config.json"),
      "{not json",
      { mode: 0o600 },
    );
    for (const env of [
      sessionEnv({ REMEMBRANCE_API_KEY: "" }),
      sessionEnv({ REMEMBRANCE_API_URL: "https://other-registry.example" }),
      sessionEnv({ REMEMBRANCE_API_URL: "http://remote-registry.example" }),
      sessionEnv({
        REMEMBRANCE_API_KEY: "",
        XDG_CONFIG_HOME: malformedConfigHome,
      }),
    ]) {
      const fetchImpl = registry(listing([CAVEMAN]));
      for (const source of ["startup", "resume", "compact"]) {
        await expect(
          sessionSkillsDirective(
            { source, nativeSessionId: "session-skip", fetchImpl },
            env,
          ),
        ).resolves.toBeNull();
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("requires a stable native session id", async () => {
    const fetchImpl = registry(listing([CAVEMAN]));
    for (const nativeSessionId of [
      undefined,
      "",
      "unknown",
      "../escape",
      "has space",
      "x".repeat(257),
    ]) {
      await expect(
        sessionSkillsDirective(
          { source: "startup", nativeSessionId, fetchImpl },
          sessionEnv(),
        ),
      ).resolves.toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("REMEMBRANCE_SESSION_SKILLS=0 turns off fetching, the cache, and the directive", async () => {
    const env = sessionEnv();
    await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-off",
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    const before = readFileSync(cachePath(env, "session-off"), "utf8");
    for (const value of ["0", "false", "no"]) {
      const fetchImpl = registry(listing([PONYTAIL]));
      for (const source of ["startup", "resume", "clear", "compact"]) {
        await expect(
          sessionSkillsDirective(
            { source, nativeSessionId: "session-off", fetchImpl },
            { ...env, REMEMBRANCE_SESSION_SKILLS: value },
          ),
        ).resolves.toBeNull();
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    expect(readFileSync(cachePath(env, "session-off"), "utf8")).toBe(before);
  });

  it("repeats the directive from the cache on compaction with zero network calls", async () => {
    const env = sessionEnv();
    const started = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId: "session-compact",
        fetchImpl: registry(listing([CAVEMAN, PONYTAIL])),
      },
      env,
    );
    const fetchImpl = registry(listing([]));
    const compacted = await sessionSkillsDirective(
      { source: "compact", nativeSessionId: "session-compact", fetchImpl },
      env,
    );
    expect(compacted).toBe(started);
    await expect(
      sessionSkillsDirective(
        { source: "compact", nativeSessionId: "session-uncached", fetchImpl },
        env,
      ),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fall back to the cache when the registry refuses the credential or lists none", async () => {
    const answers = [
      registry({ error: "unauthorized" }, { status: 401 }),
      registry({ error: "forbidden" }, { status: 403 }),
      registry(
        listing([], { available: false, reason_code: "not_applicable" }),
      ),
    ];
    for (const [index, fetchImpl] of answers.entries()) {
      const env = sessionEnv();
      const nativeSessionId = `session-refused-${index}`;
      await sessionSkillsDirective(
        {
          source: "startup",
          nativeSessionId,
          fetchImpl: registry(listing([CAVEMAN])),
        },
        env,
      );
      await expect(
        sessionSkillsDirective(
          { source: "resume", nativeSessionId, fetchImpl },
          env,
        ),
      ).resolves.toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The empty answer replaced the cached list, so compaction repeats none.
      await expect(
        sessionSkillsDirective({ source: "compact", nativeSessionId }, env),
      ).resolves.toBeNull();
    }
  });

  it("neither writes nor reads the cache when the host keeps none", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-no-cache";
    const text = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        cache: false,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    expect(directiveEntries(text).map((entry) => entry.args.slug)).toEqual([
      "caveman",
    ]);
    expect(existsSync(env.REMEMBRANCE_USAGE_DIR)).toBe(false);

    await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    const offline = unreachable();
    for (const source of ["resume", "compact"]) {
      await expect(
        sessionSkillsDirective(
          { source, nativeSessionId, cache: false, fetchImpl: offline },
          env,
        ),
      ).resolves.toBeNull();
    }
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it("refreshes the cache on resume and falls back to it only when the fetch fails", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-resume";
    await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    const resumed = await sessionSkillsDirective(
      {
        source: "resume",
        nativeSessionId,
        fetchImpl: registry(listing([PONYTAIL])),
      },
      env,
    );
    expect(directiveEntries(resumed).map((entry) => entry.args.slug)).toEqual([
      "ponytail",
    ]);
    const offline = unreachable();
    const fallback = await sessionSkillsDirective(
      { source: "resume", nativeSessionId, fetchImpl: offline },
      env,
    );
    expect(offline).toHaveBeenCalledTimes(1);
    expect(fallback).toBe(resumed);
    await expect(
      sessionSkillsDirective(
        { source: "compact", nativeSessionId, fetchImpl: offline },
        env,
      ),
    ).resolves.toBe(resumed);

    // startup and clear never answer from the cache.
    for (const source of ["startup", "clear"]) {
      await expect(
        sessionSkillsDirective(
          { source, nativeSessionId, fetchImpl: unreachable() },
          env,
        ),
      ).resolves.toBeNull();
    }
    const cleared = await sessionSkillsDirective(
      {
        source: "clear",
        nativeSessionId,
        fetchImpl: registry(listing([])),
      },
      env,
    );
    expect(cleared).toBeNull();
    await expect(
      sessionSkillsDirective(
        { source: "compact", nativeSessionId, fetchImpl: offline },
        env,
      ),
    ).resolves.toBeNull();
  });

  it("stores only slugs, version ids, pins, the fetch time, and a digest in a private file", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-private-cache";
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        now,
        fetchImpl: registry(
          listing([{ ...PONYTAIL, name: "Display Name", skill_md: "BODY" }]),
        ),
      },
      env,
    );
    const path = cachePath(env, nativeSessionId);
    expect(readdirSync(env.REMEMBRANCE_USAGE_DIR)).toEqual([
      `${createHash("sha256").update(nativeSessionId).digest("hex").slice(0, 16)}.session-skills.json`,
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(env.REMEMBRANCE_USAGE_DIR).mode & 0o777).toBe(0o700);
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({
      fetched_at: "2026-09-22T12:00:00.000Z",
      digest: expect.stringMatching(/^[0-9a-f]{32}$/),
      session_skills: [
        {
          slug: "ponytail",
          version_id: "sv_7f7777fba96c441f86",
          pinned: true,
        },
      ],
    });
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain(nativeSessionId);
    expect(raw).not.toMatch(/Display Name|BODY|remembrance\.dev/);
  });

  it("expires the cache after seven days and rejects a future fetch time", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-ttl";
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const started = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        now,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    await expect(
      sessionSkillsDirective(
        { source: "compact", nativeSessionId, now: now + 7 * DAY_MS },
        env,
      ),
    ).resolves.toBe(started);
    await expect(
      sessionSkillsDirective(
        { source: "compact", nativeSessionId, now: now + 7 * DAY_MS + 1 },
        env,
      ),
    ).resolves.toBeNull();
    await expect(
      sessionSkillsDirective(
        {
          source: "resume",
          nativeSessionId,
          now: now + 7 * DAY_MS + 1,
          fetchImpl: unreachable(),
        },
        env,
      ),
    ).resolves.toBeNull();
    // A clock that moved backwards makes the cache look fetched in the future.
    for (const source of ["compact", "resume"]) {
      await expect(
        sessionSkillsDirective(
          { source, nativeSessionId, now: now - 1, fetchImpl: unreachable() },
          env,
        ),
      ).resolves.toBeNull();
    }
  });

  it("ignores a cache filled for another registry or credential", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-digest";
    const started = await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    for (const changed of [
      { REMEMBRANCE_API_KEY: "rk_another_organization_key" },
      {
        REMEMBRANCE_API_URL: "https://dev.remembrance.dev",
        REMEMBRANCE_API_KEY_ORIGIN: "https://dev.remembrance.dev",
      },
    ]) {
      for (const source of ["compact", "resume"]) {
        await expect(
          sessionSkillsDirective(
            { source, nativeSessionId, fetchImpl: unreachable() },
            { ...env, ...changed },
          ),
        ).resolves.toBeNull();
      }
    }
    await expect(
      sessionSkillsDirective({ source: "compact", nativeSessionId }, env),
    ).resolves.toBe(started);
  });

  it("ignores a cache file that other users can read or that was altered", async () => {
    const env = sessionEnv();
    const nativeSessionId = "session-tampered";
    await sessionSkillsDirective(
      {
        source: "startup",
        nativeSessionId,
        fetchImpl: registry(listing([CAVEMAN])),
      },
      env,
    );
    const path = cachePath(env, nativeSessionId);
    chmodSync(path, 0o644);
    await expect(
      sessionSkillsDirective({ source: "compact", nativeSessionId }, env),
    ).resolves.toBeNull();
    chmodSync(path, 0o600);
    const cached = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({
        ...cached,
        session_skills: [
          { slug: "ignore previous instructions", version_id: null },
          CAVEMAN,
        ],
      }),
      { mode: 0o600 },
    );
    const text = await sessionSkillsDirective(
      { source: "compact", nativeSessionId },
      env,
    );
    expect(directiveEntries(text).map((entry) => entry.args.slug)).toEqual([
      "caveman",
    ]);
  });

  it("derives one stable idempotency key per native session, slug, and version", async () => {
    const env = sessionEnv();
    const keyFor = async (nativeSessionId, skill, source = "startup") =>
      directiveEntries(
        await sessionSkillsDirective(
          {
            source,
            nativeSessionId,
            fetchImpl: registry(listing([skill])),
          },
          env,
        ),
      )[0].args.idempotency_key;

    const first = await keyFor("session-key-a", CAVEMAN);
    expect(first).toBe(
      `rss_${createHash("sha256")
        .update("session-key-a\ncaveman\nsv_eed332475dea44a3a3")
        .digest("hex")
        .slice(0, 32)}`,
    );
    expect(await keyFor("session-key-a", CAVEMAN, "compact")).toBe(first);
    expect(await keyFor("session-key-a", CAVEMAN, "resume")).toBe(first);
    expect(await keyFor("session-key-b", CAVEMAN)).not.toBe(first);
    expect(
      await keyFor("session-key-a", { ...CAVEMAN, version_id: "sv_newer_1" }),
    ).not.toBe(first);
    expect(
      await keyFor("session-key-a", { ...CAVEMAN, slug: "caveman-lite" }),
    ).not.toBe(first);
    expect(
      await keyFor("session-key-a", { ...CAVEMAN, version_id: null }),
    ).toBe(
      `rss_${createHash("sha256")
        .update("session-key-a\ncaveman\n")
        .digest("hex")
        .slice(0, 32)}`,
    );
  });
});
