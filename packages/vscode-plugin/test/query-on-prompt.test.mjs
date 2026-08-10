import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildQueryPayload,
  handleHookInput,
  redactPrompt,
  shouldQueryPrompt,
} from "../scripts/query-on-prompt.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = mkdtempSync(join(tmpdir(), "remembrance-vscode-prompt-"));
let cacheCounter = 0;

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function testEnv(env = {}) {
  cacheCounter += 1;
  return {
    REMEMBRANCE_HOOK_CACHE_PATH: resolve(
      tempRoot,
      `cache-${cacheCounter}.json`,
    ),
    REMEMBRANCE_USAGE_DIR: resolve(tempRoot, `usage-${cacheCounter}`),
    ...env,
  };
}

function skillsResponse(fetchCalls) {
  return vi.fn(async (url, init) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({
      skills: [
        {
          slug: "vercel-build-debug",
          description: "Debug Vercel build failures.",
          trust_tier: "tofu_verified",
          verified_uses: 7,
          total_uses: 9,
        },
      ],
      resources: [],
    });
  });
}

describe("VS Code prompt hook", () => {
  it("queries Remembrance and injects the guidance as additionalContext", async () => {
    const calls = [];
    const recordHealth = vi.fn();
    const output = await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
      },
      {
        env: testEnv({
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_AUTO_QUERY_LIMIT: "2",
        }),
        fetchImpl: skillsResponse(calls),
        recordHealth,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://remembrance.dev/api/v1/agent/query");
    expect(output?.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output?.hookSpecificOutput.additionalContext).toContain(
      "vercel-build-debug",
    );
    expect(recordHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "vs_code",
        component: "prompt_hook",
      }),
      expect.any(Object),
    );
  });

  it("attributes the query to VS Code, not to Claude Code or Codex", async () => {
    // This is the whole reason the adapter overrides buildQueryPayload: the
    // scripts are copied from the Claude plugin, so an un-overridden payload
    // would report this host as claude_code (or the codex core default) and
    // silently merge two surfaces in registry analytics.
    const calls = [];
    await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel deployment error in GitHub Actions.",
      },
      {
        env: testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" }),
        fetchImpl: skillsResponse(calls),
        recordHealth: vi.fn(),
      },
    );

    expect(calls[0].body).toMatchObject({
      agent: { provider: "vscode", model: "vs-code-agent" },
      client_context: {
        surface: "plugin_hook",
        runtime: "vs_code",
        trigger_reason: "external_service",
      },
    });
    expect(JSON.stringify(calls[0].body)).not.toContain("claude_code");
    expect(JSON.stringify(calls[0].body)).not.toContain("codex");
  });

  it("stamps the VS Code identity even on the direct payload builder", () => {
    const payload = buildQueryPayload(
      "Fix this Vercel deploy",
      testEnv(),
      "external_service",
    );
    expect(payload.agent).toEqual({
      provider: "vscode",
      model: "vs-code-agent",
    });
    expect(payload.client_context).toMatchObject({
      surface: "plugin_hook",
      runtime: "vs_code",
      trigger_reason: "external_service",
    });
  });

  it("sends the VS Code user agent so server-side attribution matches", async () => {
    const headers = [];
    await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel deployment error in GitHub Actions.",
      },
      {
        env: testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" }),
        fetchImpl: vi.fn(async (_url, init) => {
          headers.push(init.headers);
          return Response.json({ skills: [], resources: [] });
        }),
        recordHealth: vi.fn(),
      },
    );
    expect(headers[0]).toMatchObject({
      "user-agent": expect.stringMatching(
        /^@remembrance\/vscode-plugin\/\d+\.\d+\.\d+$/,
      ),
    });
  });

  it("uses a VS Code specific cache file so hosts cannot cross-read each other", () => {
    // The cache filename is the actual isolation guarantee between the copied
    // Claude scripts and this host, so pin it.
    const source = readFileSync(
      resolve(root, "scripts/query-on-prompt.mjs"),
      "utf8",
    );
    expect(source).toContain("vscode-hook-cache.json");
    expect(source).not.toContain("claude-code-hook-cache.json");
  });

  it("does not query for generic one-off fact prompts", async () => {
    const fetchImpl = vi.fn();
    const output = await handleHookInput(
      { hook_event_name: "UserPromptSubmit", prompt: "What time is it?" },
      { env: testEnv(), fetchImpl, recordHealth: vi.fn() },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toBeNull();
  });

  it("honours the disable switch without touching the network", async () => {
    const fetchImpl = vi.fn();
    const output = await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
      },
      {
        env: testEnv({ REMEMBRANCE_AUTO_QUERY: "0" }),
        fetchImpl,
        recordHealth: vi.fn(),
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toBeNull();
  });

  it("redacts secrets and private URLs before sending query text", async () => {
    const calls = [];
    await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt:
          "Deploy to Vercel with token sk-ABCDEF1234567890ABCDEF and host https://internal.corp.example/secret",
      },
      {
        env: testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" }),
        fetchImpl: skillsResponse(calls),
        recordHealth: vi.fn(),
      },
    );
    // Guard against a vacuous pass: the redaction claim only means something if
    // a request actually went out.
    expect(calls).toHaveLength(1);
    const wire = JSON.stringify(calls[0].body);
    expect(wire).not.toContain("sk-ABCDEF1234567890ABCDEF");
    expect(wire).not.toContain("internal.corp.example");
    expect(redactPrompt("token sk-ABCDEF1234567890ABCDEF")).not.toContain(
      "sk-ABCDEF1234567890ABCDEF",
    );
  });

  it("uses the shared bounded timeout override", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await handleHookInput(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "Fix this Vercel deployment timeout.",
        },
        {
          env: testEnv({ REMEMBRANCE_AUTO_QUERY_TIMEOUT_MS: "30000" }),
          fetchImpl: vi.fn(async () =>
            Response.json({ skills: [], resources: [] }),
          ),
          recordHealth: vi.fn(),
        },
      );
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("caches empty responses without counting them as registry consumption", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ skills: [], resources: [] }),
    );
    const recordUse = vi.fn();
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    const input = {
      prompt: "Review this Vercel deployment workflow.",
      session_id: "vscode-empty",
    };

    const first = await handleHookInput(input, {
      env,
      fetchImpl,
      recordUse,
      recordHealth: vi.fn(),
    });
    const second = await handleHookInput(input, {
      env,
      fetchImpl,
      recordUse,
      recordHealth: vi.fn(),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(recordUse).not.toHaveBeenCalled();
    expect(first?.hookSpecificOutput.additionalContext).toContain(
      "returned no matching skill",
    );
    expect(second).toEqual(first);
  });

  it("fails open when the query errors, and never leaks the credential", async () => {
    const output = await handleHookInput(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
      },
      {
        env: testEnv({
          REMEMBRANCE_API_URL: "https://remembrance.dev",
          REMEMBRANCE_API_KEY: "rk_never_print",
        }),
        fetchImpl: vi.fn(async () => {
          throw new Error("network down");
        }),
        recordHealth: vi.fn(),
      },
    );
    // Fail open: either no output or recovery guidance, never a thrown error.
    expect(JSON.stringify(output ?? {})).not.toContain("rk_never_print");
  });

  it("caches a repeated matching prompt instead of re-querying", async () => {
    const env = testEnv({ REMEMBRANCE_API_URL: "https://remembrance.dev" });
    const calls = [];
    const fetchImpl = skillsResponse(calls);
    const input = {
      hook_event_name: "UserPromptSubmit",
      prompt: "Fix this Vercel Next.js build error in GitHub Actions.",
    };
    await handleHookInput(input, { env, fetchImpl, recordHealth: vi.fn() });
    await handleHookInput(input, { env, fetchImpl, recordHealth: vi.fn() });
    expect(calls.length).toBe(1);
    // The cache must not persist the raw prompt text.
    const cache = readFileSync(env.REMEMBRANCE_HOOK_CACHE_PATH, "utf8");
    expect(cache).not.toContain("Vercel Next.js build error");
    expect(() => JSON.parse(cache)).not.toThrow();
  });

  it("keeps the shared trigger and redaction helpers deterministic", () => {
    expect(
      shouldQueryPrompt("Fix this Vercel deploy failure").likely_match,
    ).toBe(true);
    expect(shouldQueryPrompt("What time is it?").likely_match).toBe(false);
    expect(redactPrompt("a".repeat(10))).toBe("a".repeat(10));
  });
});
