#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_DIR="$HOME/.config/opencode"
MIMOCODE_DIR="$HOME/.config/mimocode"

install_for() {
  local name="$1"
  local config_dir="$2"
  local sdk_package="${3:-}"

  echo "Installing for $name..."

  mkdir -p "$config_dir/plugins"
  ln -sf "$PLUGIN_DIR/index.js" "$config_dir/plugins/opencode-agents-sync.js"

  if [ -n "$sdk_package" ] && [ ! -d "$config_dir/node_modules/$sdk_package" ]; then
    echo "  Installing SDK dependency: $sdk_package"
    if [ ! -f "$config_dir/package.json" ]; then
      echo '{"dependencies":{}}' > "$config_dir/package.json"
    fi
    (cd "$config_dir" && npm install "$sdk_package" --save)
  fi

  echo "✓ $name installed (symlink: $config_dir/plugins/opencode-agents-sync.js → $PLUGIN_DIR/index.js)"
}

if [ -d "$OPENCODE_DIR" ]; then
  install_for "OpenCode" "$OPENCODE_DIR" "@opencode-ai/plugin"
fi

if [ -d "$MIMOCODE_DIR" ]; then
  install_for "MiMo Code" "$MIMOCODE_DIR" "@mimo-ai/plugin"
fi

if [ ! -d "$OPENCODE_DIR" ] && [ ! -d "$MIMOCODE_DIR" ]; then
  echo "No OpenCode or MiMo Code config found."
  echo "Run opencode or mimocode at least once, then re-run this script."
  exit 1
fi

echo "Done. Restart your editor to load the plugin."
