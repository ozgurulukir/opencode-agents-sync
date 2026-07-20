import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  lstatSync,
  openSync,
  fstatSync,
  closeSync,
  constants,
} from "node:fs";
import { isAbsolute, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PLUGIN_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "package.json"), "utf-8"))
      .version;
  } catch {
    return "unknown";
  }
})();

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

// Debug log size cap. When the current log exceeds this, it is rotated to
// `<log>.1` (one backup kept) so the file cannot grow unbounded. Tunable via
// the AGENTS_SYNC_LOG_MAX_BYTES env var (read per write, so it is hot-reloadable
// and easy to exercise in tests).
const DEBUG_LOG_DEFAULT_MAX_BYTES = 1024 * 1024;

// Deferred prompt send tuning. The autocontinue hook runs while the compaction
// process still holds the session lock, so the prompt must be deferred to avoid
// a deadlock. If the send still fails (e.g. transient lock contention), retry a
// few times with backoff instead of dropping the update silently.
let PROMPT_DEFER_MS = 500;
let PROMPT_MAX_ATTEMPTS = 3;
let PROMPT_RETRY_DELAY_MS = 500;

// Module-level mutable state for log rotation tracking. Cleared by
// _resetLogSizes() between tests to avoid cross-test pollution.
const logSizes = new Map();

// Test-only override to speed up execution (skip delays by setting all to 0).
// Tests should call _setPromptTimers(0, 0, 0) to bypass all waits and run instantly.
export function _setPromptTimers(
  deferMs = null,
  retryDelayMs = null,
  maxAttempts = null,
) {
  if (deferMs !== null) PROMPT_DEFER_MS = deferMs;
  if (retryDelayMs !== null) PROMPT_RETRY_DELAY_MS = retryDelayMs;
  if (maxAttempts !== null) PROMPT_MAX_ATTEMPTS = maxAttempts;
}

// Test-only helper to reset log rotation tracking between tests.
export function _resetLogSizes() {
  logSizes.clear();
}

// Test-only helper to reset the logMaxBytes cache between tests.
export function _resetLogMaxBytesCache() {
  cachedLogMaxBytesEnv = undefined;
  cachedLogMaxBytesNum = DEBUG_LOG_DEFAULT_MAX_BYTES;
}

function buildSectionList(sections) {
  return sections.map((s) => `- ${s}`).join("\n");
}

// Mirrors OpenCode's config dir resolution (xdg-basedir): $XDG_CONFIG_HOME/opencode,
// falling back to ~/.config/opencode. Used for the global user-level AGENTS.md
// and the global prompt template lookup.
function resolveGlobalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, "opencode");
  }
  return join(process.env.HOME || homedir() || "/tmp", ".config", "opencode");
}

function buildUpdatePrompt(options, projectRoot) {
  const sections = options.sections || DEFAULT_SECTIONS;
  const sectionList = buildSectionList(sections);
  const agentsMdPath = projectRoot
    ? join(projectRoot, "AGENTS.md")
    : "AGENTS.md (in the project root directory)";
  return `Update and consolidate the PROJECT-LEVEL AGENTS.md file with durable knowledge from this session.

Target file: ${agentsMdPath}

Steps:
1. Read the project-level AGENTS.md using the Read tool
2. Identify genuinely new discoveries, architecture decisions, rules, or gotchas from this session
3. Consolidate: merge new information into existing sections, remove outdated or redundant entries, and keep the file clean and organized
4. Use the Edit tool to apply changes

Target sections to update:
${sectionList}

Format for each new entry:
- **[Section Name]** discovered detail

Exclusions — do NOT add:
- Skill definitions, skill instructions, or skill-related content (these belong in .opencode/skills/)
- Anything already present in ~/.config/opencode/AGENTS.md (global user-level instructions)
- Generic coding advice, tool descriptions, or non-project-specific information

Rules:
- Only modify the PROJECT-LEVEL AGENTS.md, never touch ~/.config/opencode/AGENTS.md
- Use the Edit tool to make changes — do not just describe what should change
- When adding new entries, also consolidate: remove duplicates, update stale information, and merge related entries
- If nothing new was discovered, respond with "No new AGENTS.md updates needed." and do not modify the file.`;
}

function parseOptions(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      enabled: true,
      continue: false,
      debug: true,
      template: null,
      sections: DEFAULT_SECTIONS,
      promptFile: null,
      allowProjectPrompt: false,
    };
  }
  return {
    enabled: raw.enabled !== false,
    continue: raw.continue === true,
    debug: raw.debug !== false,
    template: raw.template || null,
    sections:
      Array.isArray(raw.sections) && raw.sections.length > 0
        ? raw.sections
        : DEFAULT_SECTIONS,
    promptFile: raw.promptFile || null,
    allowProjectPrompt: raw.allowProjectPrompt === true,
  };
}

function loadPromptFile(promptFile, log, projectAgentsMd, globalAgentsMd) {
  if (!promptFile) return null;
  try {
    let fd;
    try {
      // O_NONBLOCK prevents the open/read from hanging on blocking special files
      // (FIFOs, named pipes, devices). Harmless on regular files.
      fd = openSync(promptFile, constants.O_RDONLY | constants.O_NONBLOCK);
      // Security: Cheap guard first — reject non-regular files (directories, devices, etc.)
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        log(`Prompt file is not a regular file, ignoring: ${promptFile}`);
        return null;
      }

      // Security: Check file size to prevent OOM / DoS (max 1MB)
      if (stats.size > 1024 * 1024) {
        log(
          `Prompt file too large (${stats.size} bytes), ignoring: ${promptFile}`,
        );
        return null;
      }

      let content = readFileSync(fd, "utf-8").trim();
      content = content.replaceAll(
        "{{project_agents_md}}",
        () => projectAgentsMd,
      );
      content = content.replaceAll(
        "{{global_agents_md}}",
        () => globalAgentsMd,
      );
      log(`Loaded prompt file: ${promptFile} (${content.length} chars)`);
      return content;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  } catch (err) {
    log(`Failed to load prompt file ${promptFile}: ${err.code || err.message}`);
    return null;
  }
}

function resolvePromptFile(
  options,
  realProjectRoot,
  log,
  projectPrompt,
  globalPrompt,
) {
  if (options.promptFile) {
    log(`Using promptFile from config: ${options.promptFile}`);
    return options.promptFile;
  }
  if (
    options.allowProjectPrompt &&
    projectPrompt &&
    existsSync(projectPrompt)
  ) {
    if (realProjectRoot) {
      try {
        // Security: Ensure project prompt doesn't escape project root via symlink
        const realPromptPath = realpathSync(projectPrompt);
        if (
          !realPromptPath.startsWith(realProjectRoot + sep) &&
          realPromptPath !== realProjectRoot
        ) {
          log(
            `Security warning: project prompt file escapes project directory, ignoring: ${projectPrompt}`,
          );
        } else {
          log(`Found project-level prompt: ${projectPrompt}`);
          return realPromptPath;
        }
      } catch (err) {
        // Ignore if realpath fails
      }
    } else {
      log(
        `Could not resolve project root, ignoring project prompt: ${projectPrompt}`,
      );
    }
  }
  if (existsSync(globalPrompt)) {
    log(`Found global-level prompt: ${globalPrompt}`);
    return globalPrompt;
  }
  log("No custom prompt file found, using built-in");
  return null;
}

let cachedLogMaxBytesEnv;
let cachedLogMaxBytesNum = DEBUG_LOG_DEFAULT_MAX_BYTES;

function logMaxBytes() {
  const envVar = process.env.AGENTS_SYNC_LOG_MAX_BYTES;
  if (envVar !== cachedLogMaxBytesEnv) {
    cachedLogMaxBytesEnv = envVar;
    const n = Number(envVar);
    cachedLogMaxBytesNum =
      Number.isFinite(n) && n > 0 ? n : DEBUG_LOG_DEFAULT_MAX_BYTES;
  }
  return cachedLogMaxBytesNum;
}

function rotateDebugLogIfNeeded(logPath, lineLength) {
  let size = logSizes.get(logPath);
  if (size === undefined) {
    // Performance: Avoid try/catch overhead for ENOENT when the file doesn't exist yet.
    // statSync with throwIfNoEntry is significantly faster.
    const stats = lstatSync(logPath, { throwIfNoEntry: false });
    size = stats ? stats.size : 0;
  }
  if (size > logMaxBytes()) {
    // Keep one backup so recent history survives an overflow instead of being
    // truncated. renameSync overwrites any previous `.1`.
    renameSync(logPath, `${logPath}.1`);
    logSizes.set(logPath, lineLength);
  } else {
    logSizes.set(logPath, size + lineLength);
  }
}

const ensuredLogDirs = new Set();

function writeDebugLog(logDir, logPath, msg) {
  // Security: Sanitize newlines to prevent CRLF log injection
  const sanitizedMsg =
    typeof msg === "string" ? msg.replace(/[\r\n]+/g, " ") : msg;
  const line = `[${new Date().toISOString()}] ${sanitizedMsg}\n`;
  try {
    if (!ensuredLogDirs.has(logDir)) {
      // Security: Create log directory with restricted permissions
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      ensuredLogDirs.add(logDir);
    }
    // Performance: pass byte length to avoid statSync inside rotate
    rotateDebugLogIfNeeded(logPath, Buffer.byteLength(line, "utf8"));
    // Security: Create log file with restricted permissions to avoid exposing sensitive data
    appendFileSync(logPath, line, {
      mode: 0o600,
      flag:
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
    });
  } catch (err) {
    console.error(
      `[opencode-agents-sync] Failed to write debug log: ${err.code || err.message}`,
    );
    console.error(`[opencode-agents-sync] Original message: ${msg}`);
  }
}

function resolveLogDir(input) {
  // Deterministic override: both opencode and mimocode typically serve on
  // "localhost", so the hostname heuristic below is unreliable. Set
  // AGENTS_SYNC_LOG_DIR to an absolute path to force the log directory
  // regardless of which host app loaded the plugin.
  const envDir = process.env.AGENTS_SYNC_LOG_DIR;
  if (envDir && isAbsolute(envDir)) {
    return envDir;
  }
  const home = process.env.HOME || homedir() || "/tmp";
  // Best-effort: detect mimocode by its server URL hostname.
  if (input.serverUrl?.hostname.includes("mimocode")) {
    return join(home, ".local", "share", "mimocode");
  }
  return join(home, ".local", "share", "opencode");
}

const plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const { client, directory: projectRoot } = input;

  let logDir, logPath;
  if (options.debug) {
    logDir = resolveLogDir(input);
    logPath = join(logDir, "agents-sync-debug.log");
  }

  const log = options.debug
    ? (msg) => writeDebugLog(logDir, logPath, msg)
    : () => {};
  log(
    `Plugin v${PLUGIN_VERSION} loaded, enabled=${options.enabled}, continue=${options.continue}, debug=${options.debug}, projectRoot=${projectRoot}, logDir=${logDir}`,
  );

  const hooks = {};
  const activeSessions = new Set();

  // Performance: Cache the generated built-in prompt text and paths to avoid rebuilding
  // them on every compaction event.
  let cachedDefaultPrompt = null;
  let cachedPaths = null;
  let cachedPromptFile = null;

  if (options.template) {
    hooks["experimental.session.compacting"] = async (hookInput, output) => {
      const sessionID = hookInput.sessionID;
      if (!options.enabled) {
        log(`compacting hook skipped (disabled), session=${sessionID}`);
        return;
      }
      log(
        `Using custom template as prompt (${options.template.length} chars), session=${sessionID}`,
      );
      output.prompt = options.template;
    };
  }

  hooks["experimental.compaction.autocontinue"] = async (hookInput, output) => {
    const sessionID = hookInput.sessionID;
    if (!options.enabled) {
      log(`autocontinue hook skipped (disabled), session=${sessionID}`);
      return;
    }
    log(
      `Autocontinue fired, session=${sessionID}, active=${activeSessions.has(sessionID)}`,
    );

    if (activeSessions.has(sessionID)) {
      log(`Skipping — already sent update for session=${sessionID}`);
      return;
    }

    activeSessions.add(sessionID);
    if (!options.continue) {
      output.enabled = false;
    }

    if (!cachedPaths) {
      const globalConfigDir = resolveGlobalConfigDir();
      let realProjectRoot = null;
      if (projectRoot) {
        try {
          realProjectRoot = realpathSync(projectRoot);
        } catch (err) {
          // Ignore if realpath fails
        }
      }
      cachedPaths = {
        globalAgentsMd: join(globalConfigDir, "AGENTS.md"),
        globalPromptPath: join(globalConfigDir, "agents-sync-prompt.md"),
        projectAgentsMd: projectRoot
          ? join(projectRoot, "AGENTS.md")
          : "AGENTS.md",
        projectPromptPath: projectRoot
          ? join(projectRoot, ".opencode", "agents-sync-prompt.md")
          : null,
        realProjectRoot,
      };
    }

    if (cachedPromptFile === null) {
      // Performance: Cache resolved prompt file path to avoid redundant synchronous filesystem operations (existsSync)
      cachedPromptFile = resolvePromptFile(
        options,
        cachedPaths.realProjectRoot,
        log,
        cachedPaths.projectPromptPath,
        cachedPaths.globalPromptPath,
      );
      // If it resolved to null, use false so we don't keep resolving it on subsequent hits.
      if (cachedPromptFile === null) {
        cachedPromptFile = false;
      }
    }

    // We only want to load it if it's truthy (a string path)
    const filePrompt = loadPromptFile(
      cachedPromptFile === false ? null : cachedPromptFile,
      log,
      cachedPaths.projectAgentsMd,
      cachedPaths.globalAgentsMd,
    );

    if (!filePrompt && !cachedDefaultPrompt) {
      cachedDefaultPrompt = buildUpdatePrompt(options, projectRoot);
    }

    const promptText = filePrompt || cachedDefaultPrompt;
    log(
      `Deferring AGENTS.md update prompt (${promptText.length} chars, source=${(cachedPromptFile === false ? null : cachedPromptFile) || "built-in"})`,
    );

    const scheduleUpdate = (fn) => {
      if (PROMPT_DEFER_MS > 0) {
        setTimeout(fn, PROMPT_DEFER_MS);
      } else {
        setImmediate(fn);
      }
    };

    scheduleUpdate(async () => {
      const startTime = Date.now();
      for (let attempt = 1; attempt <= PROMPT_MAX_ATTEMPTS; attempt++) {
        try {
          log(
            `Sending deferred AGENTS.md update prompt (attempt ${attempt}/${PROMPT_MAX_ATTEMPTS})`,
          );
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: promptText }],
            },
          });
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log(
            `AGENTS.md update completed in ${elapsed}s after attempt ${attempt}, clearing active flag`,
          );
          activeSessions.delete(sessionID);
          return;
        } catch (err) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log(
            `Attempt ${attempt}/${PROMPT_MAX_ATTEMPTS} failed after ${elapsed}s: ${err.code || err.message}`,
          );
          if (attempt < PROMPT_MAX_ATTEMPTS) {
            if (PROMPT_RETRY_DELAY_MS > 0) {
              log(`Retrying in ${PROMPT_RETRY_DELAY_MS}ms...`);
              await new Promise((resolve) =>
                setTimeout(resolve, PROMPT_RETRY_DELAY_MS),
              );
            }
          } else {
            log(
              `All ${PROMPT_MAX_ATTEMPTS} attempts failed. Stack: ${err.stack || "n/a"}`,
            );
            activeSessions.delete(sessionID);
          }
        }
      }
    });
  };

  return hooks;
};

export default { id: "opencode-agents-sync", server: plugin };
