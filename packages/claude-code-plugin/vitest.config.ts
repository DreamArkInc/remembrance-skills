import { defineConfig } from "vitest/config";

// A private HOME, XDG roots and no login Keychain for every test file.
export default defineConfig({
  test: { setupFiles: ["../../scripts/plugin-test-isolation.setup.mjs"] },
});
