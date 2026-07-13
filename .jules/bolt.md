## 2024-07-12 - Optimizing writeDebugLog with Set caching

**Learning:** Calling `mkdirSync(logDir, { recursive: true })` repeatedly, even when the directory already exists, is significantly slower than checking a cache. Caching successful log directory creations using a `Set` avoids expensive filesystem operations.
**Action:** Used a module-level `Set` to track directories that have already been created within the plugin's lifetime, reducing the overhead of `mkdirSync`.
