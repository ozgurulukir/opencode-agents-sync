# opencode-agents-sync

OpenCode/MiMo Code plugin that updates AGENTS.md after session compaction.

Tested with OpenCode v1.14.48 and MiMo Code v0.1.0.

## How it works

When auto-compaction completes, the plugin:

1. Sends a dedicated prompt through the normal agent loop (with full tool access)
2. The LLM reads the current AGENTS.md, identifies new discoveries from the session, and edits the file

By default, the plugin replaces the default "Continue..." auto-continue message with the AGENTS.md update. If you want the agent to also continue its original task after the update, enable the `continue` option:

```jsonc
{
  "plugin": [
    [
      "./plugins/opencode-agents-sync.js",
      {
        "continue": true,
      },
    ],
  ],
}
```

With `continue: true`, two turns run sequentially: first the AGENTS.md update, then the default "Continue..." resuming the original task. This uses more context but preserves workflow continuity.

Only project-level AGENTS.md is updated. Global/user-level AGENTS.md (`~/.config/opencode/AGENTS.md`) is never touched. Skill definitions and non-project-specific information are excluded.

> **Disclaimer — API costs**: Each auto-compaction triggers an extra LLM turn (read AGENTS.md + edit). With `continue: true`, that's two extra turns. On pay-per-token providers, this adds to your API costs. On long sessions with frequent compactions, the cumulative cost may be noticeable. If cost is a concern, consider disabling the plugin for less important projects or using it only with flat-rate providers.

> **Tip**: The plugin modifies your project AGENTS.md automatically after each auto-compaction. Use `git` to track changes so you can review or revert updates.

> **Warning**: The AGENTS.md update turn adds messages to the conversation history (user prompt + assistant response with file edits). This increases context usage. Cascade prevention stops infinite loops, but the update messages remain. With smaller context models, consider the extra token cost.

> **Note**: The quality of AGENTS.md updates depends on the model you use. Stronger models produce better consolidations. The update prompt appears as a visible user message in the conversation — this is expected behavior.

> **Note**: The plugin runs only on auto-compaction, never on manual `/compact`. Additionally, when a compaction is triggered by context overflow and a prior message can be replayed, OpenCode replays it instead of firing the hook, so no update happens for that turn — the next regular auto-compaction resumes updates.

> **Troubleshooting**: If the plugin doesn't seem to work, check the debug log. For OpenCode: `~/.local/share/opencode/agents-sync-debug.log`. For MiMo Code: `~/.local/share/mimocode/agents-sync-debug.log`. Look for "Autocontinue fired" entries. The log rotates to a `.1` backup once it exceeds 1 MiB (tunable via the `AGENTS_SYNC_LOG_MAX_BYTES` env var). Set `"debug": false` to silence logging entirely. If the host app isn't detected correctly (both apps serve on `localhost`), force the log directory with the `AGENTS_SYNC_LOG_DIR` env var (absolute path).

## Installation

Plugins are loaded as flat `.js` files from the `plugins/` directory. Subdirectories are not resolved.

### Quick install

#### Linux / macOS / Git Bash / WSL

```bash
./install.sh
```

#### Windows (PowerShell 7+)

```powershell
.\install.ps1
```

> **Note:** The PowerShell script attempts to create a symbolic link. If that fails (requires admin or Developer Mode), it falls back to copying the file. To enable symlinks without admin: **Settings > For Developers > Developer Mode > ON**, or run PowerShell as Administrator.

### Manual install

#### OpenCode

```bash
# Symlink as flat file
ln -sf /path/to/opencode-agents-sync/index.js ~/.config/opencode/plugins/opencode-agents-sync.js

# Add SDK dependency to config root
cd ~/.config/opencode && npm install @opencode-ai/plugin
```

#### MiMo Code

```bash
# Symlink as flat file
ln -sf /path/to/opencode-agents-sync/index.js ~/.config/mimocode/plugins/opencode-agents-sync.js

# Add SDK dependency to config root
cd ~/.config/mimocode && npm install @mimo-ai/plugin
```

## Configuration

The plugin is auto-loaded from the plugins directory. No config entry is required unless you want to pass options.

> **Note:** The plugin is discovered locally from the plugins directory. Do NOT add `"opencode-agents-sync"` as a plain string in the `plugin` array — OpenCode will try to resolve it from npm.

To pass options, reference the local file path relative to the config directory:

```jsonc
{
  "plugin": [
    [
      "./plugins/opencode-agents-sync.js",
      {
        "enabled": true,
        "sections": ["About", "Setup", "Rules", "Known Issues"],
      },
    ],
  ],
}
```

### Options

| Option               | Type       | Default        | Description                                     |
| -------------------- | ---------- | -------------- | ----------------------------------------------- |
| `enabled`            | `boolean`  | `true`         | Enable/disable the plugin                       |
| `continue`           | `boolean`  | `false`        | Also send default "Continue..." after update    |
| `debug`              | `boolean`  | `true`         | Write the debug log (set `false` to silence)    |
| `sections`           | `string[]` | All 8 sections | Which sections to target                        |
| `promptFile`         | `string`   | `null`         | Absolute path to custom prompt template file    |
| `allowProjectPrompt` | `boolean`  | `false`        | Load project-level template (see security note) |
| `template`           | `string`   | `null`         | Raw compaction prompt replacement (advanced)    |

### Custom Prompt Template

You can override the built-in update prompt by placing a `agents-sync-prompt.md` file in one of these locations (checked in order):

1. **Config option**: `"promptFile": "/absolute/path/to/template.md"` — highest priority
2. **Project level**: `<project>/.opencode/agents-sync-prompt.md` (Requires `"allowProjectPrompt": true`)
3. **Global level**: `$XDG_CONFIG_HOME/opencode/agents-sync-prompt.md` (or `~/.config/opencode/agents-sync-prompt.md` if `XDG_CONFIG_HOME` is unset)

> **Security Note:** Loading a project-level prompt file executes untrusted text in the agent loop. If a downloaded repository contains a malicious `.opencode/agents-sync-prompt.md`, it could result in a prompt injection vulnerability. For this reason, project-level prompts are disabled by default and require the `allowProjectPrompt` configuration flag to be set explicitly.

The file is read on each compaction — no plugin restart needed. Changes take effect on the next auto-compaction.

Variables available in the template:

| Variable                | Replaced with                      |
| ----------------------- | ---------------------------------- |
| `{{project_agents_md}}` | Absolute path to project AGENTS.md |
| `{{global_agents_md}}`  | Absolute path to global AGENTS.md  |

Example `agents-sync-prompt.md`:

```markdown
Update {{project_agents_md}} with new discoveries from this session.
Skip anything already in {{global_agents_md}}.
```

## Default Sections

- **About** — Project description
- **Setup** — Setup and install commands
- **Development** — Dev server, hot-reload info
- **Testing** — Test commands and strategy
- **Technologies** — Frameworks, libraries, tools
- **Rules** — Code style, conventions
- **Known Issues** — Gotchas, workarounds
- **Notes** — Other important info

## Testing

```bash
node --test 'test/*.test.js'
```

## License

MIT
