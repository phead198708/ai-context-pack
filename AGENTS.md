# AGENTS.md

These instructions apply to the entire repository.

## Mission

Develop and ship the complete AI Context Pack v0.1 cross-platform MVP described by `docs/MASTER-GOAL.md` and Epic #2.

A GitHub issue is an execution unit, not the overall objective. Finishing Issue #3 or any later issue does not finish the persistent Goal.

## Source of truth

Use this precedence:

1. `docs/MASTER-GOAL.md`
2. Epic #2
3. ADRs
4. Product Specification, Architecture and Roadmap
5. Current issue acceptance criteria
6. This file and any more-specific nested AGENTS.md

Stop and ask when authoritative sources conflict.

## Architecture boundaries

- React Native/TypeScript owns shared UI, domain behavior and orchestration.
- Swift/Kotlin owns platform entry points and resource-sensitive processing.
- Keep `ios/` and `android/` committed.
- Never rely on Expo Go for verification.
- Never run `expo prebuild --clean` over custom native targets without an approved ADR.
- Pass file URIs and versioned DTOs across native boundaries, not large binary buffers.
- Keep the domain independent of React Native UI, persistence implementations and native modules.

## Issue and PR discipline

- Work on one implementation issue at a time.
- Use branch `codex/issue-<number>-<slug>`.
- Keep one implementation PR open at a time unless explicitly authorized otherwise.
- Do not mix unrelated refactors, dependency upgrades or follow-up features into an issue PR.
- Open a Draft PR and map every acceptance criterion to evidence.
- Never merge a PR.
- Request `@codex review` when enabled.
- At `AWAITING_REVIEW`, stop repository mutation except requested fixes.
- Resume only after explicit review approval and merge confirmation.
- After merge, update Epic #2 and continue the persistent Master Goal.

## Verification

Run all applicable shared, iOS and Android checks before requesting review. Never claim an unrun check passed.

Required categories include:

- Typecheck, lint, format and shared tests.
- Schema and state-machine contract tests.
- React Native component/interaction tests.
- XCTest and iOS app/extension builds.
- Android unit/instrumentation tests and builds.
- Privacy-safe logging, detector and export-security regressions.
- Device, interruption, performance, low-memory and low-disk tests when required by labels.

Use synthetic fixtures only. Record exact commands and results in the PR.

## Privacy and integrity

- No user content in logs, diagnostics, analytics, snapshots, CI artifacts or filenames.
- No cloud/backend/remote AI in the v0.1 core flow.
- No silent item omission or silent data loss.
- Preserve originals and produce immutable derivatives.
- Flatten redacted pixels into a new image.
- Block normal export on unresolved high-risk findings.
- Build exports from a reviewed allowlist.
- Fail closed on unknown breaking schemas and integrity errors.
- Treat external provider URIs as temporary.

## Dependencies

Every added dependency must have documented purpose, version pinning, New Architecture compatibility, maintenance status, license, privacy, size and platform impact. Do not add a dependency to avoid implementing a security-critical native boundary correctly.

## Code quality

- TypeScript strict; avoid `any`, unchecked casts and ignored promises.
- Use stable typed error codes and explicit state transitions.
- Keep heavy work off UI/main threads and out of the iOS Share Extension.
- Bound concurrency and memory.
- Support cancellation, checkpointing and deterministic recovery.
- Keep comments focused on invariants and non-obvious tradeoffs.

## Code Review Rules

Reviewers should prioritize P0/P1 findings involving:

- Privacy leakage or content appearing in logs/network/diagnostics.
- Reversible or overlay-only redaction.
- Data loss, partial-write corruption, stale provider URIs or non-idempotent recovery.
- iOS/Android contract or security-parity divergence.
- Heavy work inside the iOS Share Extension.
- Large binary transfer through the JS/native boundary.
- Missing error visibility, cancellation or recovery.
- Export allowlist/path traversal/hash/manifest defects.
- Unsupported iOS containing-app opening behavior.
- Tests disabled, acceptance evidence fabricated, or required platform checks omitted.

Mechanical formatting belongs in CI rather than review comments.
