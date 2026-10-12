// Keeps a hook test file hermetic. Every test runs with private HOME, XDG, and
// TMPDIR directories, without an inherited Remembrance credential, registry,
// or usage directory, and with a global fetch that rejects every call. A
// request that still reaches Node's own fetch or HTTP client, for example
// through a reference taken before the stub, fails the test that sent it.
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";

const ISOLATED_DIRECTORIES = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TMPDIR",
];
const INHERITED_VARIABLES = [
  "REMEMBRANCE_API_KEY",
  "REMEMBRANCE_API_KEY_ORIGIN",
  "REMEMBRANCE_API_URL",
  "REMEMBRANCE_MEMBER_LINK_TOKEN",
  "REMEMBRANCE_USAGE_DIR",
];

// Pass to a child Node process as `--import` so its fetch rejects as well.
export const OFFLINE_FETCH_IMPORT = `data:text/javascript,${encodeURIComponent(
  'globalThis.fetch = async () => { throw new TypeError("network disabled in tests"); };',
)}`;

export function useIsolatedHookEnvironment() {
  const fetch = vi.fn(async () => {
    throw new TypeError("network disabled in tests");
  });
  const realRequests = [];
  const listeners = {
    "undici:request:create": ({ request }) =>
      realRequests.push(`${request.method} ${request.origin}${request.path}`),
    "http.client.request.created": ({ request }) =>
      realRequests.push(`${request.method} ${request.host}${request.path}`),
  };
  let root;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "remembrance-hook-test-"));
    for (const [channel, listener] of Object.entries(listeners)) {
      subscribe(channel, listener);
    }
  });
  // Reapplied before every test because some suites unstub after each one.
  beforeEach(() => {
    for (const name of ISOLATED_DIRECTORIES) {
      const path = join(root, name.toLowerCase());
      mkdirSync(path, { recursive: true });
      vi.stubEnv(name, path);
    }
    for (const name of INHERITED_VARIABLES) vi.stubEnv(name, undefined);
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => {
    expect(realRequests.splice(0), "requests that bypassed the stub").toEqual(
      [],
    );
  });
  afterAll(() => {
    const late = realRequests.splice(0);
    for (const [channel, listener] of Object.entries(listeners)) {
      unsubscribe(channel, listener);
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    expect(late, "requests that bypassed the stub").toEqual([]);
  });
  return { fetch, realRequests };
}
