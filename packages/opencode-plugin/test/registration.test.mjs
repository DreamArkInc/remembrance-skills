import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Remembrance, pluginVersion } from "../src/index.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(resolve(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const expectedMcpTools = [
  "query_skills",
  "get_skill",
  "get_resource",
  "get_connection_status",
];

describe("opencode plugin registration", () => {
  it("registers through the documented plugin entrypoint", () => {
    const pkg = readJson("package.json");
    // opencode loads an in-process ES module and calls the exported plugin
    // function; a CommonJS main or a missing export makes the plugin invisible.
    expect(pkg.type).toBe("module");
    expect(typeof Remembrance).toBe("function");
    expect(pkg.name).toBe("@remembrance/opencode-plugin");
  });

  it("declares the version-matched published MCP server in opencode.json", () => {
    const config = readJson("opencode.json");
    const server = config.mcp?.remembrance ?? config.mcpServers?.remembrance;
    expect(
      server,
      "opencode.json must declare the remembrance MCP server",
    ).toBeTruthy();
    const version = readJson("package.json").version;
    expect(server.command).toContain(`@remembrance-ai/mcp-server@${version}`);
    expect(config.plugin).toContain(`@remembrance/opencode-plugin@${version}`);
  });

  it("reports its own plugin host so client-health does not merge surfaces", () => {
    const config = readJson("opencode.json");
    expect(JSON.stringify(config)).toContain("opencode");
    // The adapter's own surface constant is what lands in client-health.
    const source = read("src/index.mjs");
    expect(source).toContain('const SURFACE = "opencode"');
  });

  it("keeps the plugin version readable and in step with the package", () => {
    expect(pluginVersion()).toBe(readJson("package.json").version);
  });

  it("returns 'unknown' instead of throwing when the manifest is unreadable", () => {
    expect(
      pluginVersion(() => {
        throw new Error("no manifest");
      }),
    ).toBe("unknown");
  });

  it("exposes only event keys the host documents", async () => {
    const hooks = await Remembrance({});
    expect(Object.keys(hooks).sort()).toEqual([
      "chat.message",
      "event",
      "experimental.chat.system.transform",
      "tool.execute.after",
    ]);
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["chat.message"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe(
      "function",
    );
  });

  it("documents automatic pre-model context injection in the README", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/chat\.message/i);
    expect(readme).toMatch(/system context|before model dispatch/i);
  });

  it("serves the expected tools over a real MCP handshake", async () => {
    const server = resolve(root, "servers/remembrance-mcp.mjs");
    const tools = await listMcpTools(server);
    for (const tool of expectedMcpTools) {
      expect(tools, `bundled MCP server must expose ${tool}`).toContain(tool);
    }
  }, 30_000);
});

function frame(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readFrames(buffer) {
  const responses = [];
  let remaining = buffer;
  while (remaining.byteLength > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = remaining.subarray(0, headerEnd).toString("utf8");
    const length = Number.parseInt(
      header.match(/content-length:\s*(\d+)/i)?.[1] ?? "",
      10,
    );
    if (!Number.isFinite(length)) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.byteLength < bodyEnd) break;
    responses.push(
      JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString("utf8")),
    );
    remaining = remaining.subarray(bodyEnd);
  }
  return responses;
}

function listMcpTools(serverPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, REMEMBRANCE_API_KEY: "" },
    });
    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      fn(value);
    };
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      const frames = readFrames(Buffer.concat(chunks));
      const listed = frames.find((f) => f.id === 2 && f.result?.tools);
      if (listed) {
        finish(
          resolvePromise,
          listed.result.tools.map((t) => t.name),
        );
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", () => {
      if (!settled) {
        const frames = readFrames(Buffer.concat(chunks));
        finish(
          reject,
          new Error(
            `server exited before tools/list; frames: ${JSON.stringify(frames)}`,
          ),
        );
      }
    });
    child.stdin.write(
      frame({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "opencode-test", version: "0.0.0" },
        },
      }),
    );
    child.stdin.write(
      frame({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    child.stdin.write(
      frame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
  });
}
