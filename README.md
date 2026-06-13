# opencode-agents-sync

OpenCode/MiMo Code plugin that updates AGENTS.md after session compaction.

## How it works

When auto-compaction completes, the plugin:

1. Disables the default "Continue..." auto-continue message
2. Sends a dedicated prompt through the normal agent loop (with full tool access)
3. The LLM reads the current AGENTS.md, identifies new discoveries from the session, and edits the file

Only project-level AGENTS.md is updated. Global/user-level AGENTS.md (`~/.config/opencode/AGENTS.md`) is never touched. Skill definitions and non-project-specific information are excluded.

## Installation

Plugins are loaded as flat `.js` files from the `plugins/` directory. Subdirectories are not resolved.

### Quick install

```bash
./install.sh
```

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

The plugin is auto-loaded from the plugins directory. No config entry is required.

To pass options, add to your config:

```json
{
  "plugin": [
    [
      "opencode-agents-sync",
      {
        "enabled": true,
        "sections": ["About", "Setup", "Rules", "Known Issues"]
      }
    ]
  ]
}
```

### Options

| Option       | Type       | Default        | Description                                  |
| ------------ | ---------- | -------------- | -------------------------------------------- |
| `enabled`    | `boolean`  | `true`         | Enable/disable the plugin                    |
| `sections`   | `string[]` | All 8 sections | Which sections to include in AGENTS.md       |
| `promptFile` | `string`   | `null`         | Absolute path to custom prompt template file |

### Custom Prompt Template

You can override the built-in update prompt by placing a `agents-sync-prompt.md` file in one of these locations (checked in order):

1. **Project level**: `<project>/.opencode/agents-sync-prompt.md`
2. **Global level**: `~/.config/opencode/agents-sync-prompt.md`
3. **Config option**: `"promptFile": "/absolute/path/to/template.md"`

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
