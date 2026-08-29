import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  _setPromptTimers,
  _resetLogSizes,
  _resetLogMaxBytesCache,
} from "../index.js";
import pluginObj from "../index.js";

function makeMockClient() {
  const calls = [];
  return {
    calls,
    session: {
      prompt: async (opts) => calls.push(opts),
    },
  };
}

describe("TOCTOU vulnerability", () => {
  beforeEach(async () => {
    _setPromptTimers(0, 0, 3);
  });
  afterEach(() => {
    _setPromptTimers(500, 500, 3);
    _resetLogSizes();
    _resetLogMaxBytesCache();
  });

  it("should not allow symlink replacement after caching", async () => {
    const tmpDir = join(tmpdir(), `toctou-${Date.now()}`);
    const outsideDir = join(tmpdir(), `toctou-outside-${Date.now()}`);
    mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    const promptPath = join(tmpDir, ".opencode", "agents-sync-prompt.md");
    const secretPath = join(outsideDir, "secret.txt");

    writeFileSync(promptPath, "Safe prompt");
    writeFileSync(secretPath, "SECRET_DATA");

    const mockClient = makeMockClient();
    const hooks = await pluginObj.server(
      { client: mockClient, directory: tmpDir },
      { allowProjectPrompt: true, debug: false },
    );

    // First run caches the path
    await hooks["experimental.compaction.autocontinue"](
      { sessionID: "1" },
      { enabled: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mockClient.calls[0].body.parts[0].text, "Safe prompt");

    // Attacker replaces the file with a symlink to outside
    rmSync(promptPath);
    symlinkSync(secretPath, promptPath);

    // Second run uses the cached path, does it read the secret?
    await hooks["experimental.compaction.autocontinue"](
      { sessionID: "2" },
      { enabled: true },
    );
    await new Promise((r) => setTimeout(r, 10));

    // If vulnerable, the text will be SECRET_DATA
    assert.notEqual(
      mockClient.calls[1].body.parts[0].text,
      "SECRET_DATA",
      "TOCTOU vulnerability detected! Able to read outside file via symlink replacement.",
    );
  });

  it("should reject intermediate directory symlink swap (TOCTOU)", async () => {
    const testDir = join(tmpdir(), `toctou-intermediate-${Date.now()}`);
    const outsideDir = join(
      tmpdir(),
      `toctou-intermediate-outside-${Date.now()}`,
    );
    const safeDir = join(testDir, "safe-dir", "subdir");
    mkdirSync(safeDir, { recursive: true });
    mkdirSync(join(outsideDir, "evil"), { recursive: true });

    const promptPath = join(safeDir, "prompt.md");
    const evilPromptPath = join(outsideDir, "evil", "prompt.md");

    writeFileSync(promptPath, "Safe prompt content");
    writeFileSync(evilPromptPath, "EVIL_PROMPT");

    const mockClient = makeMockClient();
    const hooks = await pluginObj.server(
      { client: mockClient, directory: testDir },
      { promptFile: promptPath, debug: false },
    );

    // First load — baseline: prompt file resolves normally
    await hooks["experimental.compaction.autocontinue"](
      { sessionID: "1" },
      { enabled: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mockClient.calls[0].body.parts[0].text, "Safe prompt content");

    // Attacker swaps the intermediate directory to a symlink pointing outside
    rmSync(join(testDir, "safe-dir", "subdir"), { recursive: true });
    try {
      symlinkSync(
        join(outsideDir, "evil"),
        join(testDir, "safe-dir", "subdir"),
      );
    } catch (err) {
      // Symlink creation may fail on Windows without admin; clean up and skip
      rmSync(testDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    // Second load — should detect intermediate swap and reject
    await hooks["experimental.compaction.autocontinue"](
      { sessionID: "2" },
      { enabled: true },
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.notEqual(
      mockClient.calls[1].body.parts[0].text,
      "EVIL_PROMPT",
      "TOCTOU: intermediate directory symlink swap allowed reading outside file",
    );
    assert.ok(
      mockClient.calls[1].body.parts[0].text.includes("PROJECT-LEVEL"),
      "Expected fallback to built-in prompt after TOCTOU rejection",
    );

    rmSync(testDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});