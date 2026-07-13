## 2024-07-12 - Optimizing writeDebugLog with Set caching

**Learning:** Calling `mkdirSync(logDir, { recursive: true })` repeatedly, even when the directory already exists, is significantly slower than checking a cache. Caching successful log directory creations using a `Set` avoids expensive filesystem operations.
**Action:** Used a module-level `Set` to track directories that have already been created within the plugin's lifetime, reducing the overhead of `mkdirSync`.
## 2024-07-13 - [Sync I/O in Logging Bottleneck]
**Learning:** Found that `statSync` was called synchronously on every debug log write to check for log rotation. Synchronous I/O blocks the main thread in Node.js and is a significant performance anti-pattern inside frequently called paths.
**Action:** Always check file logging/rotation functions for unnecessary `statSync` or synchronous filesystem calls. Cache file sizes in memory where appropriate to drastically reduce system call overhead.
