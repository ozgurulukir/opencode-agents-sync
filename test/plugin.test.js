import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

const {
  default: pluginObj,
  _setPromptTimers,
  _resetLogSizes,
  _resetLogMaxBytesCache,
} = await import("../index.js");
const plugin = pluginObj.server;

function makeMockClient(errorOnPrompt = false, failTimes = 0) {
  const calls = [];
  let failures = 0;
  return {
    calls,
    session: {
      prompt: async (opts) => {
        if (errorOnPrompt) throw new Error("Session lock error");
        if (failures < failTimes) {
          failures++;
          throw new Error(`Transient failure ${failures}`);
        }
        calls.push(opts);
      },
    },
  };
}

let _flushDelay = 1000;

function flushTimers(ms = _flushDelay) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_SECTIONS = [
  "About",
  "Setup",
  "Development",
  "Testing",
  "Technologies",
  "Rules",
  "Known Issues",
  "Notes",
];

describe("opencode-agents-sync", () => {
  beforeEach(async () => {
    // Fast mode: skip production delays; 50ms flush is enough for event loop
    // to process all pending setTimeout(0) callbacks deterministically
    // (Windows has ~15.6ms minimum timer resolution).
    _setPromptTimers(0, 0, 3);
    _flushDelay = 50;
  });

  afterEach(() => {
    // Restore production timing defaults after each test.
    _setPromptTimers(500, 500, 3);
    _flushDelay = 1000;
    _resetLogSizes();
    _resetLogMaxBytesCache();
  });
  it("should export a valid PluginModule with id and server", () => {
    assert.equal(typeof pluginObj, "object");
    assert.equal(typeof pluginObj.id, "string");
    assert.ok(pluginObj.id.length > 0, "id must be a non-empty string");
    assert.equal(typeof pluginObj.server, "function");
    assert.equal(pluginObj.tui, undefined);
  });

  it("should export a server function", () => {
    assert.equal(typeof plugin, "function");
  });

  describe("parseOptions", () => {
    it("should return defaults when no options provided", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      for (const section of DEFAULT_SECTIONS) {
        assert.ok(
          text.includes(section),
          `Missing default section: ${section}`,
        );
      }
    });

    it("should default enabled to true", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient });
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, false);
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
    });

    it("should accept enabled: false and skip prompt", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, { enabled: false });
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, true);
      assert.equal(mockClient.calls.length, 0);
    });

    it("should accept empty sections array and fall back to defaults", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, { sections: [] });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      for (const section of DEFAULT_SECTIONS) {
        assert.ok(text.includes(section), `Missing section: ${section}`);
      }
    });

    it("should accept single section", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient },
        { sections: ["OnlySection"] },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("OnlySection"));
      assert.ok(!text.includes("- Setup"));
    });

    it("should handle null options gracefully", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, null);
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, false);
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
    });

    it("should handle undefined options gracefully", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, undefined);
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, false);
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
    });
  });

  describe("resolveLogDir", () => {
    it("should use opencode dir by default", async () => {
      await plugin({
        client: makeMockClient(),
        serverUrl: new URL("http://localhost:3000"),
      });
      const logFile = join(
        process.env.HOME || "/tmp",
        ".local",
        "share",
        "opencode",
        "agents-sync-debug.log",
      );
      assert.ok(existsSync(logFile));
    });

    it("should use mimocode dir when hostname contains mimocode", async () => {
      await plugin({
        client: makeMockClient(),
        serverUrl: new URL("http://mimocode.local:3000"),
      });
      const logFile = join(
        process.env.HOME || "/tmp",
        ".local",
        "share",
        "mimocode",
        "agents-sync-debug.log",
      );
      assert.ok(existsSync(logFile));
    });

    it("should use opencode dir when serverUrl is undefined", async () => {
      await plugin({
        client: makeMockClient(),
        serverUrl: undefined,
      });
      const logFile = join(
        process.env.HOME || "/tmp",
        ".local",
        "share",
        "opencode",
        "agents-sync-debug.log",
      );
      assert.ok(existsSync(logFile));
    });

    it("should honor AGENTS_SYNC_LOG_DIR override over the hostname heuristic", async () => {
      const tmpLogDir = join(tmpdir(), `agents-sync-env-${Date.now()}`);
      mkdirSync(tmpLogDir, { recursive: true });
      const oldEnv = process.env.AGENTS_SYNC_LOG_DIR;
      process.env.AGENTS_SYNC_LOG_DIR = tmpLogDir;
      try {
        // A plain localhost URL would normally resolve to the opencode dir.
        await plugin({
          client: makeMockClient(),
          serverUrl: new URL("http://localhost:3000"),
        });
        assert.ok(
          existsSync(join(tmpLogDir, "agents-sync-debug.log")),
          "expected log in AGENTS_SYNC_LOG_DIR override",
        );
      } finally {
        if (oldEnv === undefined) delete process.env.AGENTS_SYNC_LOG_DIR;
        else process.env.AGENTS_SYNC_LOG_DIR = oldEnv;
        rmSync(tmpLogDir, { recursive: true, force: true });
      }
    });
  });

  describe("debug log", () => {
    let tmpHome, oldHome, oldCap;

    beforeEach(() => {
      tmpHome = join(
        tmpdir(),
        `agents-sync-log-${Date.now()}-${Math.random()}`,
      );
      mkdirSync(tmpHome, { recursive: true });
      oldHome = process.env.HOME;
      oldCap = process.env.AGENTS_SYNC_LOG_MAX_BYTES;
      process.env.HOME = tmpHome;
    });

    afterEach(() => {
      process.env.HOME = oldHome;
      if (oldCap === undefined) delete process.env.AGENTS_SYNC_LOG_MAX_BYTES;
      else process.env.AGENTS_SYNC_LOG_MAX_BYTES = oldCap;
      rmSync(tmpHome, { recursive: true, force: true });
    });

    const logFile = () =>
      join(tmpHome, ".local", "share", "opencode", "agents-sync-debug.log");

    it("should rotate to .1 when the log exceeds the size cap", async () => {
      process.env.AGENTS_SYNC_LOG_MAX_BYTES = "10";
      const hooks = await plugin({ client: makeMockClient() });
      // Loading wrote one line; firing the hook writes more, which pushes the
      // current file past the tiny cap and rotates it to a .1 backup.
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "rot1" },
        { enabled: true },
      );
      await flushTimers();
      assert.ok(existsSync(`${logFile()}.1`), "expected rotated .1 backup");
    });

    it("should not write a debug log when debug option is false", async () => {
      await plugin({ client: makeMockClient() }, { debug: false });
      assert.equal(existsSync(logFile()), false);
    });
  });

  describe("buildUpdatePrompt", () => {
    it("should include consolidate instruction", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("consolidate"));
    });

    it("should use fallback path when no projectRoot", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({
        client: mockClient,
        directory: undefined,
      });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("AGENTS.md (in the project root directory)"));
    });
  });

  describe("loadPromptFile", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `load-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should return null for non-existent promptFile option", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: join(tmpDir, "missing.md") },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("PROJECT-LEVEL"));
    });

    it("should return content of existing file", async () => {
      writeFileSync(join(tmpDir, "prompt.md"), "Hello world");
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: join(tmpDir, "prompt.md") },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls[0].body.parts[0].text, "Hello world");
    });

    it("should trim whitespace from file content", async () => {
      writeFileSync(join(tmpDir, "prompt.md"), "  trimmed  \n  ");
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: join(tmpDir, "prompt.md") },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls[0].body.parts[0].text, "trimmed");
    });

    it("should substitute multiple variables", async () => {
      writeFileSync(
        join(tmpDir, "prompt.md"),
        "{{project_agents_md}} and {{global_agents_md}}",
      );
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: join(tmpDir, "prompt.md") },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes(join(tmpDir, "AGENTS.md")));
      assert.ok(text.includes(".config"));
      assert.ok(!text.includes("{{"));
    });

    it("should return null for prompt files larger than 1MB", async () => {
      const mockClient = makeMockClient();

      const largeFile = join(tmpDir, "large-prompt.md");
      const buffer = Buffer.alloc(1024 * 1024 + 1, "a");
      writeFileSync(largeFile, buffer);

      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: largeFile },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      // Should fall back to built-in prompt because the file was rejected
      assert.ok(text.includes("Target sections to update:"));
    });

    it("should return null for non-regular files to prevent DoS", async () => {
      // tmpDir is a directory, not a regular file — isFile() returns false
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: tmpDir },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      // Should fall back to built-in prompt because the directory was rejected
      assert.ok(text.includes("Target sections to update:"));
    });
  });

  describe("resolvePromptFile priority", () => {
    let tmpDir, globalDir;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `priority-test-${Date.now()}`);
      globalDir = join(tmpdir(), `priority-global-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
      mkdirSync(join(globalDir, "opencode"), { recursive: true });
      process.env.XDG_CONFIG_HOME = globalDir;
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(globalDir, { recursive: true, force: true });
      delete process.env.XDG_CONFIG_HOME;
    });

    it("should prefer promptFile config over project file", async () => {
      writeFileSync(
        join(tmpDir, ".opencode", "agents-sync-prompt.md"),
        "Project prompt",
      );
      const configFile = join(tmpDir, "config-prompt.md");
      writeFileSync(configFile, "Config prompt");
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient, directory: tmpDir },
        { promptFile: configFile },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls[0].body.parts[0].text, "Config prompt");
    });

    it("should use global prompt under XDG_CONFIG_HOME", async () => {
      writeFileSync(
        join(globalDir, "opencode", "agents-sync-prompt.md"),
        "XDG global prompt",
      );
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient, directory: tmpDir });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls[0].body.parts[0].text, "XDG global prompt");
    });

    it("should resolve {{global_agents_md}} under XDG_CONFIG_HOME", async () => {
      writeFileSync(
        join(globalDir, "opencode", "agents-sync-prompt.md"),
        "Check {{global_agents_md}}",
      );
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient, directory: tmpDir });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(
        mockClient.calls[0].body.parts[0].text,
        `Check ${join(globalDir, "opencode", "AGENTS.md")}`,
      );
    });
  });

  describe("experimental.session.compacting", () => {
    it("should not register compacting hook when no custom template", async () => {
      const hooks = await plugin({ client: makeMockClient() });
      assert.equal(hooks["experimental.session.compacting"], undefined);
    });

    it("should register compacting hook when template is provided", async () => {
      const hooks = await plugin(
        { client: makeMockClient() },
        { template: "Custom prompt" },
      );
      assert.equal(typeof hooks["experimental.session.compacting"], "function");
    });

    it("should set output.prompt to custom template", async () => {
      const hooks = await plugin(
        { client: makeMockClient() },
        { template: "Custom instruction text" },
      );
      const output = { context: ["ignored"], prompt: undefined };
      await hooks["experimental.session.compacting"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.prompt, "Custom instruction text");
    });

    it("should skip when disabled and template provided", async () => {
      const hooks = await plugin(
        { client: makeMockClient() },
        { template: "Custom", enabled: false },
      );
      const output = { context: ["original"], prompt: undefined };
      await hooks["experimental.session.compacting"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.prompt, undefined);
    });
  });

  describe("experimental.compaction.autocontinue", () => {
    it("should register autocontinue hook", async () => {
      const hooks = await plugin({ client: makeMockClient() });
      assert.equal(
        typeof hooks["experimental.compaction.autocontinue"],
        "function",
      );
    });

    it("should disable default autocontinue", async () => {
      const hooks = await plugin({ client: makeMockClient() });
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, false);
    });

    it("should call client.session.prompt with update instructions", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({
        client: mockClient,
        directory: "/home/user/project",
      });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_abc123" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
      assert.equal(mockClient.calls[0].path.id, "ses_abc123");
      assert.equal(mockClient.calls[0].body.parts.length, 1);
      assert.equal(mockClient.calls[0].body.parts[0].type, "text");
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("AGENTS.md"));
      assert.ok(text.includes("Target sections"));
      assert.ok(text.includes(join("/home/user/project", "AGENTS.md")));
      assert.ok(text.includes("~/.config/opencode/AGENTS.md"));
      assert.ok(text.includes("Exclusions"));
      assert.ok(text.includes("skill"));
      assert.ok(text.includes("PROJECT-LEVEL"));
    });

    it("should include all default sections in update prompt", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient });
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      for (const section of [
        "About",
        "Setup",
        "Development",
        "Testing",
        "Technologies",
        "Rules",
        "Known Issues",
        "Notes",
      ]) {
        assert.ok(text.includes(section), `Missing section: ${section}`);
      }
    });

    it("should respect custom sections", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin(
        { client: mockClient },
        { sections: ["Custom Section"] },
      );
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        { enabled: true },
      );
      await flushTimers();
      const text = mockClient.calls[0].body.parts[0].text;
      assert.ok(text.includes("Custom Section"));
      assert.ok(!text.includes("- Setup"));
    });

    it("should not call client.session.prompt when disabled", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, { enabled: false });
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(mockClient.calls.length, 0);
      assert.equal(output.enabled, true);
    });

    it("should keep default continue enabled when continue option is true", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient }, { continue: true });
      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "test" },
        output,
      );
      assert.equal(output.enabled, true);
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
    });

    it("should only block during update, allow subsequent compaction (prevent cascade)", async () => {
      const mockClient = makeMockClient();
      const hooks = await plugin({ client: mockClient });

      const output1 = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_repeat" },
        output1,
      );
      assert.equal(output1.enabled, false);
      assert.equal(mockClient.calls.length, 0);

      const output2 = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_repeat" },
        output2,
      );
      assert.equal(output2.enabled, true);
      assert.equal(mockClient.calls.length, 0);

      await flushTimers();
      assert.equal(mockClient.calls.length, 1);

      const output3 = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_repeat" },
        output3,
      );
      assert.equal(output3.enabled, false);
      assert.equal(mockClient.calls.length, 1);

      await flushTimers();
      assert.equal(mockClient.calls.length, 2);
    });

    it("should handle prompt send error and clear flag after retries", async () => {
      const mockClient = makeMockClient(true);
      const hooks = await plugin({ client: mockClient });

      const output = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_error" },
        output,
      );
      assert.equal(output.enabled, false);

      // The send retries with backoff; wait for all attempts to be exhausted.
      await flushTimers();
      assert.equal(mockClient.calls.length, 0);

      // Flag is cleared once retries are exhausted, so a fresh trigger proceeds.
      const output2 = { enabled: true };
      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_error" },
        output2,
      );
      assert.equal(output2.enabled, false);
      assert.equal(mockClient.calls.length, 0);

      await flushTimers();
    });

    it("should retry the prompt send and succeed on a later attempt", async () => {
      const mockClient = makeMockClient(false, 2); // fail twice, succeed on 3rd
      const hooks = await plugin({ client: mockClient });

      await hooks["experimental.compaction.autocontinue"](
        { sessionID: "ses_retry" },
        { enabled: true },
      );
      await flushTimers();
      assert.equal(mockClient.calls.length, 1);
    });

    describe("multiple sessions", () => {
      it("should track sessions independently", async () => {
        const mockClient = makeMockClient();
        const hooks = await plugin({ client: mockClient });

        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "ses_A" },
          { enabled: true },
        );
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "ses_B" },
          { enabled: true },
        );

        await flushTimers();
        assert.equal(mockClient.calls.length, 2);
        assert.equal(mockClient.calls[0].path.id, "ses_A");
        assert.equal(mockClient.calls[1].path.id, "ses_B");
      });

      it("should block session A during update while session B proceeds", async () => {
        const mockClient = makeMockClient();
        const hooks = await plugin({ client: mockClient });

        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "ses_X" },
          { enabled: true },
        );
        const outputA2 = { enabled: true };
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "ses_X" },
          outputA2,
        );
        assert.equal(outputA2.enabled, true);

        const outputB = { enabled: true };
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "ses_Y" },
          outputB,
        );
        assert.equal(outputB.enabled, false);

        await flushTimers();
        assert.equal(mockClient.calls.length, 2);
        assert.equal(mockClient.calls[0].path.id, "ses_X");
        assert.equal(mockClient.calls[1].path.id, "ses_Y");
      });
    });

    describe("custom prompt file", () => {
      let tmpDir;

      beforeEach(() => {
        tmpDir = join(tmpdir(), `agents-sync-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        mkdirSync(join(tmpDir, ".opencode"), { recursive: true });
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it("should use project-level prompt file over built-in", async () => {
        writeFileSync(
          join(tmpDir, ".opencode", "agents-sync-prompt.md"),
          "Custom project prompt for {{project_agents_md}}",
        );
        const mockClient = makeMockClient();
        const hooks = await plugin({
          client: mockClient,
          directory: tmpDir,
        });
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "test" },
          { enabled: true },
        );
        await flushTimers();
        const text = mockClient.calls[0].body.parts[0].text;
        assert.equal(
          text,
          `Custom project prompt for ${join(tmpDir, "AGENTS.md")}`,
        );
      });

      it("should substitute {{global_agents_md}} variable", async () => {
        writeFileSync(
          join(tmpDir, ".opencode", "agents-sync-prompt.md"),
          "Check {{project_agents_md}} against {{global_agents_md}}",
        );
        const mockClient = makeMockClient();
        const hooks = await plugin({
          client: mockClient,
          directory: tmpDir,
        });
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "test" },
          { enabled: true },
        );
        await flushTimers();
        const text = mockClient.calls[0].body.parts[0].text;
        assert.ok(text.includes(join(tmpDir, "AGENTS.md")));
        assert.ok(!text.includes("{{"));
      });

      it("should fall back to built-in when no prompt file exists", async () => {
        const mockClient = makeMockClient();
        const hooks = await plugin({
          client: mockClient,
          directory: tmpDir,
        });
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "test" },
          { enabled: true },
        );
        await flushTimers();
        const text = mockClient.calls[0].body.parts[0].text;
        assert.ok(text.includes("PROJECT-LEVEL"));
      });

      it("should use promptFile config option with absolute path", async () => {
        const customFile = join(tmpDir, "my-custom-prompt.md");
        writeFileSync(customFile, "Absolute path prompt");
        const mockClient = makeMockClient();
        const hooks = await plugin(
          {
            client: mockClient,
            directory: tmpDir,
          },
          { promptFile: customFile },
        );
        await hooks["experimental.compaction.autocontinue"](
          { sessionID: "test" },
          { enabled: true },
        );
        await flushTimers();
        const text = mockClient.calls[0].body.parts[0].text;
        assert.equal(text, "Absolute path prompt");
      });
    });
  });
});
