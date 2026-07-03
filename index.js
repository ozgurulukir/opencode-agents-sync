import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  return join(process.env.HOME || "/tmp", ".config", "opencode");
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
  };
}

function loadPromptFile(promptFile, projectRoot, log) {
  if (!promptFile) return null;
  try {
    if (!existsSync(promptFile)) {
      log(`Prompt file not found: ${promptFile}`);
      return null;
    }
    let content = readFileSync(promptFile, "utf-8").trim();
    const globalAgentsMd = join(resolveGlobalConfigDir(), "AGENTS.md");
    const projectAgentsMd = projectRoot
      ? join(projectRoot, "AGENTS.md")
      : "AGENTS.md";
    content = content.replaceAll("{{project_agents_md}}", projectAgentsMd);
    content = content.replaceAll("{{global_agents_md}}", globalAgentsMd);
    log(`Loaded prompt file: ${promptFile} (${content.length} chars)`);
    return content;
  } catch (err) {
    log(`Failed to load prompt file ${promptFile}: ${err.code || err.message}`);
    return null;
  }
}

function resolvePromptFile(options, projectRoot, log) {
  if (options.promptFile) {
    log(`Using promptFile from config: ${options.promptFile}`);
    return options.promptFile;
  }
  const projectPrompt = projectRoot
    ? join(projectRoot, ".opencode", "agents-sync-prompt.md")
    : null;
  if (projectPrompt && existsSync(projectPrompt)) {
    log(`Found project-level prompt: ${projectPrompt}`);
    return projectPrompt;
  }
  const globalPrompt = join(resolveGlobalConfigDir(), "agents-sync-prompt.md");
  if (existsSync(globalPrompt)) {
    log(`Found global-level prompt: ${globalPrompt}`);
    return globalPrompt;
  }
  log("No custom prompt file found, using built-in");
  return null;
}

function logMaxBytes() {
  const n = Number(process.env.AGENTS_SYNC_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEBUG_LOG_DEFAULT_MAX_BYTES;
}

function rotateDebugLogIfNeeded(logPath) {
  let size;
  try {
    size = statSync(logPath).size;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return; // No log file yet — nothing to rotate.
  }
  if (size > logMaxBytes()) {
    // Keep one backup so recent history survives an overflow instead of being
    // truncated. renameSync overwrites any previous `.1`.
    renameSync(logPath, `${logPath}.1`);
  }
}

function writeDebugLog(logDir, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  const logPath = join(logDir, "agents-sync-debug.log");
  try {
    mkdirSync(logDir, { recursive: true });
    rotateDebugLogIfNeeded(logPath);
    appendFileSync(logPath, line);
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
  const home = process.env.HOME || "/tmp";
  // Best-effort: detect mimocode by its server URL hostname.
  if (input.serverUrl?.hostname.includes("mimocode")) {
    return join(home, ".local", "share", "mimocode");
  }
  return join(home, ".local", "share", "opencode");
}

const plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const { client, directory: projectRoot } = input;
  const logDir = resolveLogDir(input);
  const log = options.debug ? (msg) => writeDebugLog(logDir, msg) : () => {};
  log(
    `Plugin v${PLUGIN_VERSION} loaded, enabled=${options.enabled}, continue=${options.continue}, debug=${options.debug}, projectRoot=${projectRoot}, logDir=${logDir}`,
  );

  const hooks = {};
  const activeSessions = new Set();

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

    const promptFile = resolvePromptFile(options, projectRoot, log);
    const filePrompt = loadPromptFile(promptFile, projectRoot, log);
    const promptText = filePrompt || buildUpdatePrompt(options, projectRoot);
    log(
      `Deferring AGENTS.md update prompt (${promptText.length} chars, source=${promptFile || "built-in"})`,
    );

    setTimeout(async () => {
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
            log(`Retrying in ${PROMPT_RETRY_DELAY_MS}ms...`);
            await new Promise((resolve) =>
              setTimeout(resolve, PROMPT_RETRY_DELAY_MS),
            );
          } else {
            log(
              `All ${PROMPT_MAX_ATTEMPTS} attempts failed. Stack: ${err.stack || "n/a"}`,
            );
            activeSessions.delete(sessionID);
          }
        }
      }
    }, PROMPT_DEFER_MS);
  };

  return hooks;
};

export default { id: "opencode-agents-sync", server: plugin };

