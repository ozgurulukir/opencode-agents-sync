## 2024-07-12 - Optimizing writeDebugLog with Set caching

**Learning:** Calling `mkdirSync(logDir, { recursive: true })` repeatedly, even when the directory already exists, is significantly slower than checking a cache. Caching successful log directory creations using a `Set` avoids expensive filesystem operations.
**Action:** Used a module-level `Set` to track directories that have already been created within the plugin's lifetime, reducing the overhead of `mkdirSync`.

## $(date +%Y-%m-%d) - Optimizing file presence checks with statSync throwIfNoEntry

**Learning:** When checking if a file exists before retrieving its stats, using `existsSync` followed by `statSync` performs two synchronous disk operations. Alternatively, using `statSync` inside a `try/catch ENOENT` block introduces significant overhead from the Javascript engine creating and handling Error objects. `statSync(path, { throwIfNoEntry: false })` is much faster as it performs a single disk operation and returns `undefined` instead of throwing an error when the file is not found.
**Action:** Replaced `existsSync` + `statSync` and `try/catch ENOENT` constructs with `statSync(path, { throwIfNoEntry: false })` for performance optimization in synchronous disk checks.

## 2024-07-15 - [Optimize logMaxBytes env parsing]
**Learning:** `process.env` lookups cross the JS-C++ boundary in Node.js and have noticeable overhead in tight loops. Parsing `process.env` and calling `path.join` repeatedly can be slow.
**Action:** Cache `process.env` lookups and `path.join` operations during plugin initialization to avoid redundant computation in high-frequency execution paths.
