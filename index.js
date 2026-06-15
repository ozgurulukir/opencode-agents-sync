import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
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

function buildSectionList(sections) {
  return sections.map((s) => `- ${s}`).join("\n");
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
      template: null,
      sections: DEFAULT_SECTIONS,
      promptFile: null,
    };
  }
  return {
    enabled: raw.enabled !== false,
    continue: raw.continue === true,
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
    const globalAgentsMd = join(
      process.env.HOME || "/tmp",
      ".config",
      "opencode",
      "AGENTS.md",
    );
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
  const globalPrompt = join(
    process.env.HOME || "/tmp",
    ".config",
    "opencode",
    "agents-sync-prompt.md",
  );
  if (existsSync(globalPrompt)) {
    log(`Found global-level prompt: ${globalPrompt}`);
    return globalPrompt;
  }
  log("No custom prompt file found, using built-in");
  return null;
}

function writeDebugLog(logDir, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "agents-sync-debug.log"), line);
  } catch (err) {
    console.error(
      `[opencode-agents-sync] Failed to write debug log: ${err.code || err.message}`,
    );
    console.error(`[opencode-agents-sync] Original message: ${msg}`);
  }
}

function resolveLogDir(input) {
  const home = process.env.HOME || "/tmp";
  const host = input.serverUrl?.hostname || "";
  if (host.includes("mimocode")) {
    return join(home, ".local", "share", "mimocode");
  }
  return join(home, ".local", "share", "opencode");
}

const plugin = async (input, rawOptions) => {
  const options = parseOptions(rawOptions);
  const { client, directory: projectRoot } = input;
  const logDir = resolveLogDir(input);
  const log = (msg) => writeDebugLog(logDir, msg);
  log(
    `Plugin v${PLUGIN_VERSION} loaded, enabled=${options.enabled}, continue=${options.continue}, projectRoot=${projectRoot}, logDir=${logDir}`,
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
      try {
        log(`Sending deferred AGENTS.md update prompt`);
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: promptText }],
          },
        });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`AGENTS.md update completed in ${elapsed}s, clearing active flag`);
        activeSessions.delete(sessionID);
      } catch (err) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(
          `Failed to send AGENTS.md update after ${elapsed}s: ${err.code || err.message}`,
        );
        log(`Stack: ${err.stack || "n/a"}`);
        activeSessions.delete(sessionID);
      }
    }, 500);
  };

  return hooks;
};

export default plugin;
export { plugin as server };
