## 2025-05-18 - [Path Traversal & DoS (OOM) via Prompt File]

**Vulnerability:** The plugin loads an external prompt file `agents-sync-prompt.md`. Without a file size limit check and without resolving symlinks and validating the path against the project root, a malicious repo can place a giant file or a symlink to outside directories (like `/etc/passwd`), causing the plugin to crash with an Out of Memory error or expose local files.
**Learning:** External or local file references need strict validation of size limitations to avoid memory/buffer issues and path verification to prevent LFI (Local File Inclusion)/path traversal.
**Prevention:** Use `statSync(filePath).size` to enforce an acceptable upper bound on memory consumption when loading files asynchronously or synchronously, and use `realpathSync()` to check the resolved file path against a trusted base directory prefix.

## 2024-05-24 - [DoS Risk] Reading Device Files as Input
**Vulnerability:** Application accepted special device files (like `/dev/zero`) as input files, which when read can lead to Denial of Service (DoS) or Out of Memory (OOM) by continuously streaming data despite reporting a size of 0.
**Learning:** Checking `stats.size` is insufficient to prevent OOM/DoS when reading arbitrary file paths provided by users or config, because character/block devices have size 0 but infinite streams.
**Prevention:** Always verify `stats.isFile()` before attempting to read a file to ensure it's a regular file and not a device or FIFO stream.
