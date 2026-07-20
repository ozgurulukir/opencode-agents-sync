## 2024-07-12 - Optimizing writeDebugLog with Set caching

**Learning:** Calling `mkdirSync(logDir, { recursive: true })` repeatedly, even when the directory already exists, is significantly slower than checking a cache. Caching successful log directory creations using a `Set` avoids expensive filesystem operations.
**Action:** Used a module-level `Set` to track directories that have already been created within the plugin's lifetime, reducing the overhead of `mkdirSync`.

## $(date +%Y-%m-%d) - Optimizing file presence checks with statSync throwIfNoEntry

**Learning:** When checking if a file exists before retrieving its stats, using `existsSync` followed by `statSync` performs two synchronous disk operations. Alternatively, using `statSync` inside a `try/catch ENOENT` block introduces significant overhead from the Javascript engine creating and handling Error objects. `statSync(path, { throwIfNoEntry: false })` is much faster as it performs a single disk operation and returns `undefined` instead of throwing an error when the file is not found.
**Action:** Replaced `existsSync` + `statSync` and `try/catch ENOENT` constructs with `statSync(path, { throwIfNoEntry: false })` for performance optimization in synchronous disk checks.

## 2024-07-15 - [Optimize logMaxBytes env parsing]

**Learning:** `process.env` lookups cross the JS-C++ boundary in Node.js and have noticeable overhead in tight loops. Parsing `process.env` and calling `path.join` repeatedly can be slow.
**Action:** Cache `process.env` lookups and `path.join` operations during plugin initialization to avoid redundant computation in high-frequency execution paths.

## 2024-07-16 - [Redundant string generation in hook]

**Learning:** Found that the plugin generates its default prompt text (including array mapping and string interpolation) on every single compaction event, even though the configuration is static. Additionally, path operations for disabled features were executed unconditionally.
**Action:** Always cache derived configurations (like prompt strings) during plugin initialization if their inputs (`options`, `projectRoot`) are immutable for the instance lifecycle. Defer path building (like `join`) behind feature flags.

## 2024-07-17 - Optimize instance-dependent state resolution with lazy evaluation

**Learning:** Moving path calculations outside of hooks into plugin initialization improves hook performance, but it can unintentionally slow down startup if the features aren't used or enabled (e.g. `options.enabled = false` or when options preclude their use). Also, moving dynamic file reads into initialization creates bugs if those files are expected to be updated _during_ a session.
**Action:** Use lazy evaluation (`if (!cachedPaths) { ... }`) inside the hook itself. This defers the cost of path resolution until it's actually needed (saving initialization time) while still caching the result to avoid redundant calculations across multiple hook invocations. Keep file reads (`fs.readFileSync`) _inside_ the hook if the file contents might change at runtime.

## 2026-07-18 - [Expensive Path Resolution]

**Learning:** Repeated synchronous calls to `realpathSync` inside plugin hooks can cause significant bottlenecks.
**Action:** Always compute deterministic properties (like resolved root paths) lazily once, store them in the hook closure's cache, and reuse them across subsequent triggers.

## 2024-07-21 - [Fast-path String Scanning for Regex Replace]

**Learning:** For frequent string sanitization using global regular expressions (e.g., removing newlines with `/[\r\n]+/g`), executing the regex is consistently slower than a simple fast-path string scan (`msg.includes("\n") || msg.includes("\r")`), particularly when the majority of strings do not match the pattern. In benchmarks for this repository, standard log lines without newlines processed up to 4x faster with an `includes` check before falling back to the `replace` function, minimizing unnecessary Regex engine invocation overhead.
**Action:** When applying regex replacements in hot paths where the target pattern is infrequently present (such as log injection sanitization), check for the existence of key characters with `String.prototype.includes()` before calling `String.prototype.replace()`. Also, remember to extract regular expressions to top-level constants.
