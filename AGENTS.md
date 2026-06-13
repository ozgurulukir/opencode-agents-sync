# AGENTS.md

## Project Overview

Plugin that updates project-level AGENTS.md after auto-compaction in OpenCode and MiMo Code. After compaction succeeds, the plugin sends a dedicated prompt through the normal agent loop (with full tool access), instructing the LLM to read the current AGENTS.md and edit it with new discoveries.

- Server-side plugin (not TUI) for OpenCode and MiMo Code
- Uses `experimental.compaction.autocontinue` hook from `@opencode-ai/plugin`
- Single-file ES module, symlinked as flat `.js` file, no build step
- Node.js 18+ (ES modules)

## Architecture

### Hooks Used

- **`experimental.compaction.autocontinue`** (primary): Fires after auto-compaction succeeds. Plugin disables the default "Continue..." message and sends an AGENTS.md update prompt via `client.session.prompt()`.
- **`experimental.session.compacting`** (optional): Only registered when `template` option is provided. Replaces the compaction prompt entirely.

### Data Flow

```
Auto-compaction triggered (context overflow)
  → Compaction LLM summarizes conversation (tools: {}, no file access)
  → experimental.compaction.autocontinue fires
  → Plugin sets output.enabled = false (skip default continue)
  → Plugin tracks session in activeSessions Set (prevent cascade)
  → setTimeout(500ms) defers prompt to avoid deadlock
  → client.session.prompt() sends update through normal agent loop (with tools)
  → LLM reads AGENTS.md, identifies new info, uses Edit tool to update
```

### Key Design Decisions

**Why `client.session.prompt()` instead of injecting into compaction prompt?**

Compaction LLM runs with `tools: {}` — it cannot read or write files. Injecting instructions into the compaction prompt (`output.context`) would only produce text descriptions of updates, never actual file edits. By using `client.session.prompt()` after compaction, the update goes through the normal agent loop with full tool access.

**Why `setTimeout` deferral?**

Calling `client.session.prompt()` inside the autocontinue hook creates a deadlock — the compaction process holds the session lock, and the prompt waits for the session to be free. Deferring with `setTimeout(500ms)` lets the hook return first, releasing the lock.

**Why track `activeSessions`?**

Without tracking, a cascade can occur: the update prompt adds to context → triggers another compaction → sends another update prompt → infinite loop. The `activeSessions` Set ensures only one prompt per session; subsequent autocontinue calls are skipped.

**Why only auto-compaction (not manual `/compact`)?**

`experimental.compaction.autocontinue` only fires when `input.auto === true`. Manual `/compact` sends `auto: false`, so the hook is never triggered. This is an OpenCode SDK limitation.

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

```json
{
  "plugin": [
    [
      "opencode-agents-sync",
      {
        "enabled": true,
        "sections": ["About", "Setup", "Rules", "Known Issues"],
        "promptFile": "/path/to/custom-template.md"
      }
    ]
  ]
}
```

| Option       | Type     | Default | Description                                  |
| ------------ | -------- | ------- | -------------------------------------------- |
| `enabled`    | boolean  | `true`  | Enable/disable the plugin                    |
| `sections`   | string[] | all 8   | Which sections to target                     |
| `promptFile` | string   | `null`  | Absolute path to custom prompt template      |
| `template`   | string   | `null`  | Raw compaction prompt replacement (advanced) |

## Essential Commands

```bash
# Run all tests (16 tests)
node --test 'test/*.test.js'

# Install (symlink + SDK deps)
./install.sh

# Debug log
tail -f ~/.local/share/mimocode/agents-sync-debug.log
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

1. **No manual compaction support**: `/compact` sends `auto: false`, hook never fires
2. **Cascade prevention**: `activeSessions` Set limits to one prompt per session
3. **Deadlock avoidance**: `setTimeout(500ms)` required before `client.session.prompt()`
4. **Plugin must be auto-discovered**: Place symlink in `~/.config/opencode/plugins/`, no config entry needed
5. **Debug log location**: `~/.local/share/mimocode/agents-sync-debug.log` (even for OpenCode)

## Project Structure

```
opencode-agents-sync/
├── index.js          # Plugin entry (single file, ~160 lines)
├── package.json      # NPM package configuration
├── README.md         # User documentation
├── AGENTS.md         # This file
├── install.sh        # Symlink + SDK install script
├── test/
│   └── plugin.test.js # 16 tests (compacting, autocontinue, cascade, prompt file)
└── LICENSE           # MIT License
```
