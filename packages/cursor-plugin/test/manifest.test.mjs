import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("Cursor plugin hook manifest", () => {
  it("runs every hook through the POSIX launcher that finds Node.js", () => {
    const { hooks } = JSON.parse(
      readFileSync(resolve(root, "hooks/hooks.json"), "utf8"),
    );
    const commands = Object.values(hooks).flatMap((entries) =>
      entries.map((entry) => entry.command),
    );
    expect(commands).toHaveLength(4);
    for (const command of commands) {
      const script = command.match(
        /^sh \.\/scripts\/node-launcher \.\/(scripts\/[a-z-]+\.mjs)$/,
      )?.[1];
      expect(script, command).toBeTruthy();
      expect(existsSync(resolve(root, script)), script).toBe(true);
    }
    expect(existsSync(resolve(root, "scripts/node-launcher"))).toBe(true);
  });
});
