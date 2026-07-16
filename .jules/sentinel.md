## 2025-05-18 - [Path Traversal & DoS (OOM) via Prompt File]

**Vulnerability:** The plugin loads an external prompt file `agents-sync-prompt.md`. Without a file size limit check and without resolving symlinks and validating the path against the project root, a malicious repo can place a giant file or a symlink to outside directories (like `/etc/passwd`), causing the plugin to crash with an Out of Memory error or expose local files.
**Learning:** External or local file references need strict validation of size limitations to avoid memory/buffer issues and path verification to prevent LFI (Local File Inclusion)/path traversal.
**Prevention:** Use `statSync(filePath).size` to enforce an acceptable upper bound on memory consumption when loading files asynchronously or synchronously, and use `realpathSync()` to check the resolved file path against a trusted base directory prefix.

## 2024-07-15 - [CRITICAL] Untrusted Workspace / Prompt Injection via Project-Level Prompt File

**Vulnerability:** The plugin implicitly trusted and executed instructions from a project-level `.opencode/agents-sync-prompt.md` file. By fetching and running untrusted projects, an attacker could achieve prompt injection, executing potentially malicious commands against the host system within the context of the agent with full tool access (e.g. data exfiltration).
**Learning:** Plugins executing inside the agent loop with tool access must not blindly trust files provided by the workspace without explicit user consent.
**Prevention:** Treat any project-level configurations that dictate agent execution paths or system instructions as untrusted by default. Introduce opt-in flags (like `allowProjectPrompt`) so users must explicitly enable potentially risky project-level execution hooks.
## 2025-07-16 - [Path Traversal bypass, Replacement String Injection, & DoS via FIFOs]
**Vulnerability:** Found TOCTOU bypass in `allowProjectPrompt` path traversal check, DoS by hanging on named pipes, and replacement string injection via paths containing `$&`.
**Learning:** `realpathSync` checks are bypassable via TOCTOU if the original path is returned instead of the resolved path. Reading user files can hang if they are FIFOs unless opened with `O_NONBLOCK`. `replaceAll` with user input can inject replacements if not using a function callback.
**Prevention:** Always return the resolved path from `realpathSync` checks. Open untrusted files with `fs.constants.O_NONBLOCK`. Always use a function for the second argument of `replaceAll` when interpolating untrusted variables.
