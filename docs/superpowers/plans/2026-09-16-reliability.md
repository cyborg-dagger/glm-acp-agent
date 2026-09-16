# Session Reliability Implementation Plan

> For agentic workers: use subagent-driven-development and test-first fixes. Parent coordinates all commits and review.

Goal: Implement the five improvements approved in conversation after PR #110.
Architecture: Preserve ACP public behavior and existing storage versions while refreshing restored context, validating and atomically saving sessions, bounding command resources, covering the full prompt lifecycle, and testing supported platforms.
Tech stack: TypeScript, Node.js, ACP SDK, node:test, GitHub Actions.
Spec: The five-item proposal approved by the user in this task is the specification.

## Global constraints
- Work only in this isolated worktree, based on 60d645d. No live provider requests or real credentials.
- Five GPT-5.6 Luna implementers. Three concurrent workers maximum; task 4 follows task 1 because both edit agent.ts.
- Tests must expose each old defect before production changes. Parent owns git commits and full final suite.
- Preserve permission modes, slash-command replay, background daemon survival on normal command exit, and v1-v4 persisted sessions.
- Do not weaken tests or skip Windows tests wholesale. Platform exclusions require a specific unsupported behavior.

### Task 1: Refresh restored project context
Files: src/protocol/agent.ts; new src/tests/session-context.test.ts.
- Reproduce sessions created in A and loaded/resumed/forked in B retaining A's cwd, project rules, and tools.
- Rebuild the leading system prompt using new cwd, loadProjectContext(newCwd), and currently connected tools at all three restore entry points.
- Keep original conversation text/display mappings; do not mutate parent messages when forking.
- Test A/B instructions and all restore variants, and verify model/mode/thought level/history preservation.
- Run focused tests and report the exact commands and results.

### Task 2: Safe session persistence
Files: src/protocol/session-store.ts; new src/tests/session-store.test.ts.
- Test JSON null/primitives, invalid metadata/messages, mismatched ids, old versions, and valid current sessions.
- Validate at the disk boundary; malformed records must not crash load or listMetadata. Preserve valid v1-v4 migrations.
- Save JSON to an exclusively created temporary file in the same directory with 0600 permissions; close/flush before atomic rename, clean up temporary artifacts on failure, and preserve the last good file until replacement succeeds.
- Test permissions on existing broad-mode records and valid save/load replacement, plus practical failure paths.

### Task 3: Bounded shell commands
Files: src/tools/executor.ts; src/tools/command-limits.ts if useful; src/tests/command-limits.test.ts; README.md; src/index.ts.
- Add configurable positive-integer env limits ACP_GLM_COMMAND_TIMEOUT_MS (default 120000) and ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES (default 65536, combined stdout/stderr). Invalid values fall back with a stderr warning.
- Timeout must terminate the same process tree as explicit cancellation, clear timers/listeners, and produce an explicit failed tool result indicating timeout.
- Capture at most the configured total bytes while continuing to drain pipes; include an explicit truncation notice when data was dropped. Preserve correct exit status and bounded UTF-8 handling.
- Preserve explicit cancellation and normal background-service behavior.
- Test finite noisy commands, infinite output with deadline, pre-aborted/normal commands, env overrides and invalid config. Use short test limits and deterministic readiness when necessary.
- Document new env vars in README/help. Do not edit unrelated tests owned by task 5.

### Task 4: Prompt preprocessing lifecycle
Files: src/protocol/agent.ts prompt/close only (after task 1); src/protocol/image-preprocessor.ts; new src/tests/prompt-lifecycle.test.ts.
- Register prompt lifecycle tracking before any asynchronous image processing. Put preprocessing, model loop, persistence/error handling, and temporary cleanup under one lifecycle.
- Make cancelled image preprocessing settle, avoid starting a model call after abort, and clean up all created temporary files even when preprocessing fails.
- closeSession must abort and await active lifecycle before persistence/disposal/removal; avoid shared-state writes after close or leaks from overlapping prompts.
- Test cancellation during delayed vision preprocessing, preprocessing failure, close during preprocessing, and a follow-up prompt. Use controllable stubs and temp directories, no real vision calls.

### Task 5: Platform CI and package smoke test
Files: .github/workflows/ci.yml; package.json engines if needed; dedicated src/tests/package-smoke.test.ts or platform-safe test adjustments after other owners finish.
- Add Ubuntu/macOS/Windows matrix covering supported Node versions. Use Node 20.19+ as the existing dependency floor if verified locally, plus Node 22 and 24 (runner-installed versions).
- Ensure checks and packaged CLI smoke commands work under each runner shell, and Windows command tests find sh or explicitly configure the supported Git Bash executable.
- Keep registry check and existing Bun packed-package smoke coverage; avoid duplicating Bun release behavior.
- Inspect existing tests for POSIX assumptions, coordinate any shared-test edits with parent, and add packaged CLI startup/help verification without live providers.
- Validate locally; remote OS execution must be reported as pending until observed.
