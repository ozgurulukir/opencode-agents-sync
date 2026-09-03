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

// Deferred scheduling helper. Extracted to module level so the autocontinue
// hook body stays focused on orchestration. Uses setTimeout when a positive
// delay is configured, setImmediate otherwise (for tests that set defer=0).
function scheduleDeferred(fn) {
  if (PROMPT_DEFER_MS > 0) {
    setTimeout(fn, PROMPT_DEFER_MS);
  } else {
    setImmediate(fn);
  }
}

// Retry loop for the deferred AGENTS.md update prompt. Extracted to module
// level to keep the hook body readable. Retries up to PROMPT_MAX_ATTEMPTS
// with PROMPT_RETRY_DELAY_MS backoff, then clears the active session flag
// on success or final failure.
async function sendPromptWithRetry(
  client,
  sessionID,
  promptText,
  log,
  activeSessions,
) {
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
}

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
  // Performance: Avoid intermediate array allocation and mapping overhead.
  // Using prefix + join("\n- ") is ~40-60% faster than map().join().
  return sections.length === 0 ? "" : "- " + sections.join("\n- ");
}

// Mirrors OpenCode's config dir resolution (xdg-basedir): $XDG_CONFIG_HOME/opencode,
// falling back to ~/.config/opencode. Used for the global user-level AGENTS.md
// and the global prompt template lookup.
function resolveGlobalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) {
    return join(xdg, "opencode");
  }
  return join(homedir(), ".config", "opencode");
}

function buildUpdatePrompt(options, projectRoot, globalAgentsMd) {
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
- Anything already present in ${globalAgentsMd} (global user-level instructions)
- Generic coding advice, tool descriptions, or non-project-specific information

Rules:
- Only modify the PROJECT-LEVEL AGENTS.md, never touch ${globalAgentsMd}
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

function loadPromptFile(
  promptFileObj,
  realProjectRoot,
  log,
  projectAgentsMd,
  globalAgentsMd,
) {
  if (!promptFileObj || !promptFileObj.path) return null;
  const promptFile = promptFileObj.path;
  try {
    let currentRealPath;
    try {
      currentRealPath = realpathSync(promptFile);
    } catch (err) {
      log(
        `Failed to verify realpath for ${promptFile}: ${err.code || err.message}`,
      );
      return null;
    }

    let expectedStats;
    try {
      expectedStats = statSync(currentRealPath);
    } catch (err) {
      log(
        `Failed to stat verified realpath for ${promptFile}: ${err.code || err.message}`,
      );
      return null;
    }

    if (promptFileObj.isProject) {
      if (!realProjectRoot) {
        log(
          `Security warning: prompt file is project-bound but project root could not be resolved. Failing closed: ${promptFile}`,
        );
        return null;
      }
      if (
        !currentRealPath.startsWith(realProjectRoot + sep) &&
        currentRealPath !== realProjectRoot
      ) {
        log(
          `Security warning: project prompt file escapes project directory (TOCTOU), ignoring: ${promptFile}`,
        );
        return null;
      }
    }

    let fd;
    try {
      // O_NONBLOCK prevents the open/read from hanging on blocking special files
      // (FIFOs, named pipes, devices). Harmless on regular files.
      // Security: use O_NOFOLLOW uniformly to prevent TOCTOU symlink attacks
      const flags =
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
      // Note: We use promptFile instead of currentRealPath here because O_NOFOLLOW
      // verifies the final component of the path is not a symlink. If we open currentRealPath,
      // O_NOFOLLOW won't protect against symlinks.
      fd = openSync(promptFile, flags);
      // Security: Cheap guard first — reject non-regular files (directories, devices, etc.)
      const stats = fstatSync(fd);
      if (!stats.isFile()) {
        log(`Prompt file is not a regular file, ignoring: ${promptFile}`);
        return null;
      }

      // Security: Verify ino and dev match to perfectly prevent TOCTOU symlink/directory swap attacks
      if (stats.ino !== expectedStats.ino || stats.dev !== expectedStats.dev) {
        log(
          `Security warning: prompt file ino/dev changed after opening (TOCTOU), ignoring: ${promptFile}`,
        );
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
      // Performance: Fast-path string scan before executing multiple replaceAll operations.
      // This is especially beneficial for large prompt files (up to 1MB allowed).
      if (content.includes("{{")) {
        content = content.replaceAll(
          "{{project_agents_md}}",
          () => projectAgentsMd,
        );
        content = content.replaceAll(
          "{{global_agents_md}}",
          () => globalAgentsMd,
        );
      }
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
    // Security: Treat options.promptFile as a project file by default to enforce path
    // boundaries, preventing arbitrary file reads by malicious workspaces.
    let isProject = true;
    try {
      const realPath = realpathSync(options.promptFile);
      const globalDir = realpathSync(resolveGlobalConfigDir());
      if (realPath.startsWith(globalDir + sep) || realPath === globalDir) {
        isProject = false;
      }
    } catch (err) {
      // Ignore resolution errors; fallback to restrictive isProject=true
    }
    return { path: options.promptFile, isProject };
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
          return { path: realPromptPath, isProject: true };
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
    return { path: globalPrompt, isProject: false };
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

const CRLF_REGEX = /[\r\n]+/g;
const ensuredLogDirs = new Set();

let cachedTimestampStr = "";
let cachedTimestampMs = 0;

function getCachedISOTime() {
  const now = Date.now();
  if (now !== cachedTimestampMs) {
    cachedTimestampStr = new Date(now).toISOString();
    cachedTimestampMs = now;
  }
  return cachedTimestampStr;
}

function writeDebugLog(logDir, logPath, msg) {
  // Security: Sanitize newlines to prevent CRLF log injection
  // Performance: Fast path string include check before regex execution
  const strMsg = String(msg);
  const sanitizedMsg =
    strMsg.includes("\n") || strMsg.includes("\r")
      ? strMsg.replace(CRLF_REGEX, " ")
      : strMsg;

  // Performance: Cache timestamp to avoid creating a Date object on every log line
  const line = `[${getCachedISOTime()}] ${sanitizedMsg}\n`;

  // Performance: Encode to Buffer once to avoid dual UTF-8 scans.
  // Buffer.byteLength(string) scans the string once.
  // appendFileSync(..., string) scans it a second time to encode it.
  // By encoding upfront, we get an O(1) length lookup and pass the raw bytes.
  const lineBuf = Buffer.from(line, "utf8");

  try {
    if (!ensuredLogDirs.has(logDir)) {
      // Security: Create log directory with restricted permissions
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      ensuredLogDirs.add(logDir);
    }
    // Performance: pass pre-calculated byte length to avoid statSync inside rotate
    rotateDebugLogIfNeeded(logPath, lineBuf.length);
    // Security: Create log file with restricted permissions to avoid exposing sensitive data
    appendFileSync(logPath, lineBuf, {
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
    console.error(`[opencode-agents-sync] Original message: ${sanitizedMsg}`);
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
  const home = homedir();
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

  // Resolve and cache project/global paths on first call. Uses realpathSync
  // to resolve symlinks for security checks in loadPromptFile. Returns the
  // cached result on subsequent calls (hot path, no I/O).
  function resolveAndCachePaths(projectRoot) {
    if (cachedPaths) return cachedPaths;

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
    return cachedPaths;
  }

  // Resolve and cache the prompt file path on first call. Uses the null→false
  // sentinel so we don't re-resolve on subsequent hits when no custom prompt
  // file exists. Returns the cached result on subsequent calls.
  function resolveAndCachePromptFile(options, log) {
    if (cachedPromptFile !== null) return cachedPromptFile;

    // Resolve on first call; cache result (including null→false sentinel)
    cachedPromptFile = resolvePromptFile(
      options,
      cachedPaths.realProjectRoot,
      log,
      cachedPaths.projectPromptPath,
      cachedPaths.globalPromptPath,
    );
    // null means "no prompt file found" — use false so we don't re-resolve
    if (cachedPromptFile === null) {
      cachedPromptFile = false;
    }
    return cachedPromptFile;
  }

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

    const paths = resolveAndCachePaths(projectRoot);

    const promptFileObj = resolveAndCachePromptFile(options, log);

    const filePrompt = loadPromptFile(
      promptFileObj === false ? null : promptFileObj,
      paths.realProjectRoot,
      log,
      paths.projectAgentsMd,
      paths.globalAgentsMd,
    );

    if (!filePrompt && !cachedDefaultPrompt) {
      cachedDefaultPrompt = buildUpdatePrompt(
        options,
        projectRoot,
        paths.globalAgentsMd,
      );
    }

    const promptText = filePrompt || cachedDefaultPrompt;
    log(
      `Deferring AGENTS.md update prompt (${promptText.length} chars, source=${(promptFileObj === false ? null : promptFileObj?.path) || "built-in"})`,
    );

    scheduleDeferred(() => {
      sendPromptWithRetry(client, sessionID, promptText, log, activeSessions);
    });
  };

  return hooks;
};

export default { id: "opencode-agents-sync", server: plugin };
