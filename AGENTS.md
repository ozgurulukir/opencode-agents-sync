# AGENTS.md

## Project Overview

Plugin that updates project-level AGENTS.md after auto-compaction in OpenCode and MiMo Code. After compaction succeeds, the plugin sends a dedicated prompt through the normal agent loop (with full tool access), instructing the LLM to read the current AGENTS.md and edit it with new discoveries.

- Server-side plugin (not TUI) for OpenCode and MiMo Code
- Uses `experimental.compaction.autocontinue` hook from `@opencode-ai/plugin`
- Single-file ES module, symlinked as flat `.js` file, no build step
- Node.js 18+ (ES modules)

## Architecture

### Hooks Used

- **`experimental.compaction.autocontinue`** (primary): Fires after auto-compaction succeeds. Plugin sends an AGENTS.md update prompt via `client.session.prompt()`. By default replaces the "Continue..." message; configurable via `continue` option.
- **`experimental.session.compacting`** (optional): Only registered when `template` option is provided. Replaces the compaction prompt entirely.

### Data Flow

```
Auto-compaction triggered (context overflow)
  → Compaction LLM summarizes conversation (tools: {}, no file access)
  → experimental.compaction.autocontinue fires
  → Plugin tracks session in activeSessions Set (prevent cascade)
  → If continue=false: output.enabled = false (skip default continue)
  → setTimeout(500ms) defers prompt to avoid deadlock
  → client.session.prompt() sends update through normal agent loop (with tools)
  → LLM reads AGENTS.md, identifies new info, uses Edit tool to update
  → activeSessions flag cleared after update completes (allows re-trigger)
```

> **Note**: On overflow compaction (`overflow: true`) with a replayable prior user message, OpenCode replays that message instead of firing `experimental.compaction.autocontinue`, so the steps below "autocontinue fires" are skipped for that turn.

### Key Design Decisions

**Why `client.session.prompt()` instead of injecting into compaction prompt?**

Compaction LLM runs with `tools: {}` — it cannot read or write files. Injecting instructions into the compaction prompt (`output.context`) would only produce text descriptions of updates, never actual file edits. By using `client.session.prompt()` after compaction, the update goes through the normal agent loop with full tool access.

**Why `setTimeout` deferral?**

Calling `client.session.prompt()` inside the autocontinue hook creates a deadlock — the compaction process holds the session lock, and the prompt waits for the session to be free. Deferring with `setTimeout(500ms)` lets the hook return first, releasing the lock.

**Why track `activeSessions`?**

Without tracking, a cascade can occur: the update prompt adds to context → triggers another compaction → sends another update prompt → infinite loop. The `activeSessions` Set blocks concurrent triggers during an active update. The flag is cleared after the update completes (success or error), allowing subsequent compactions to trigger new updates within the same session.

**Why only auto-compaction (not manual `/compact`)?**

OpenCode gates the trigger in the caller (`packages/opencode/src/session/compaction.ts`: `if (result === "continue" && input.auto)`), not in the hook. The hook input is `{ sessionID, agent, model, provider, message, overflow }` — it has **no `auto` field**. Manual `/compact` runs with `auto: false`, so the caller skips the trigger entirely and the hook never fires. This is an OpenCode SDK limitation.

**Overflow with replay skips the hook**

When compaction is triggered by context overflow (`overflow: true`) and a replayable prior user message exists, OpenCode replays that message instead of calling `experimental.compaction.autocontinue`. In that case this plugin's hook never fires, so no AGENTS.md update happens for that compaction turn. The update resumes on the next regular auto-compaction. This is expected OpenCode behavior, not a plugin bug.

**Scope: project-level only**

The prompt instructs the LLM to:

- Only modify the project-level AGENTS.md (`<projectRoot>/AGENTS.md`)
- Never touch `~/.config/opencode/AGENTS.md` (global/user-level)
- Exclude skill definitions (belong in `.opencode/skills/`)
- Exclude content already in global AGENTS.md

### Custom Prompt Template

Prompt is resolved in order:

1. `promptFile` config option (absolute path)
2. `<project>/.opencode/agents-sync-prompt.md`
3. `~/.config/opencode/agents-sync-prompt.md`
4. Built-in template

Read on each hook invocation — hot reload without restart.

Variables: `{{project_agents_md}}`, `{{global_agents_md}}`

## Configuration

```jsonc
{
  "plugin": [
    [
      "./plugins/opencode-agents-sync.js",
      {
        "enabled": true,
        "continue": false,
        "sections": ["About", "Setup", "Rules", "Known Issues"],
        "promptFile": "/path/to/custom-template.md",
      },
    ],
  ],
}
```

| Option       | Type     | Default | Description                                  |
| ------------ | -------- | ------- | -------------------------------------------- |
| `enabled`    | boolean  | `true`  | Enable/disable the plugin                    |
| `continue`   | boolean  | `false` | Also send default "Continue..." after update |
| `sections`   | string[] | all 8   | Which sections to target                     |
| `promptFile` | string   | `null`  | Absolute path to custom prompt template      |
| `template`   | string   | `null`  | Raw compaction prompt replacement (advanced) |

## Essential Commands

```bash
# Run all tests (37 tests)
node --test 'test/*.test.js'

# Install (symlink + SDK deps)
./install.sh

# Debug log
tail -f ~/.local/share/opencode/agents-sync-debug.log   # OpenCode
tail -f ~/.local/share/mimocode/agents-sync-debug.log   # MiMo Code
```

## Code Conventions

- **Indentation**: 2 spaces, no semicolons, double quotes, backticks for templates
- **Exports**: `export default plugin` + `export { plugin as server }`
- **Hook pattern**: async function, guard clause for `enabled`, debug logging

## Dependencies

Optional peer dependencies (auto-discovered at runtime):

- `@opencode-ai/plugin` for OpenCode
- `@mimo-ai/plugin` for MiMo Code

## Common Gotchas

1. **No manual compaction support**: `/compact` runs `auto: false`, so the caller never triggers the autocontinue hook
2. **Cascade prevention**: `activeSessions` Set blocks concurrent triggers during active update, cleared after completion
3. **Deadlock avoidance**: `setTimeout(500ms)` required before `client.session.prompt()`
4. **Plugin must be auto-discovered**: Place symlink in `~/.config/opencode/plugins/`, no config entry needed
5. **Debug log location**: `~/.local/share/opencode/agents-sync-debug.log` for OpenCode, `~/.local/share/mimocode/agents-sync-debug.log` for MiMo Code
6. **Overflow + replay skips update**: on overflow compaction (`overflow: true`) with a replayable prior user message, OpenCode replays instead of firing autocontinue, so the plugin doesn't run that turn

## Project Structure

```
opencode-agents-sync/
├── index.js          # Plugin entry (single file, ~210 lines)
├── package.json      # NPM package configuration
├── README.md         # User documentation
├── AGENTS.md         # This file
├── install.sh        # Symlink + SDK install script
├── test/
│   └── plugin.test.js # 37 tests (compacting, autocontinue, cascade, prompt file, multi-session)
└── LICENSE           # MIT License
```
