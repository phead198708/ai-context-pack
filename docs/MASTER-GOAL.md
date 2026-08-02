# AI Context Pack v0.1 — Master Goal

This document is the canonical persistent Goal for developing the complete AI Context Pack v0.1 application. Individual GitHub issues are execution units and review checkpoints; completing one issue does not complete this Goal.

## Outcome

Deliver a release-ready, local-first AI Context Pack application for iOS/iPadOS and Android.

A user must be able to:

1. Share or import screenshots, images, PDFs, text, and URLs.
2. Preserve order and recover safely from interruption or partial failure.
3. Extract text locally using platform OCR and PDF adapters.
4. Review, reorder, retry, remove, normalize, deduplicate, and compress content.
5. Detect candidate secrets and PII without uploading content.
6. Confirm or irreversibly redact text and image findings.
7. Preview and export deterministic Markdown, PDF, clipboard content, and an attachment bundle.
8. Share the resulting context pack to any compatible AI or application.
9. Complete the core flow in English or Simplified Chinese with required accessibility support.

The Goal is complete only when the full Epic #2 Definition of Done and all Phase 0–3 promotion gates pass. Issue #3 is only the first engineering checkpoint.

## Authoritative sources

Apply the following precedence:

1. This Master Goal.
2. [Epic #2](https://github.com/phead198708/ai-context-pack/issues/2).
3. [ADR-0001](adr/0001-react-native-cross-platform.md).
4. [Product Specification](wiki/Product-Spec.md).
5. [Technical Architecture](wiki/Architecture.md).
6. [Roadmap](wiki/Roadmap.md).
7. The currently selected GitHub issue and its acceptance criteria.
8. Root and nested AGENTS.md instructions.

If two sources conflict, stop before implementation, document the conflict, and request a decision. Do not silently choose the easier interpretation.

## Scope

### Required for v0.1

- Governance issue #1.
- Phase 0: issues #3–#6.
- Phase 1: issues #7–#12.
- Phase 2: issues #13–#19.
- Phase 3: issues #20–#24.
- Epic #2 final acceptance and completion report.

Issue #28 tracks publication of canonical repository documentation to GitHub Wiki. It is non-blocking for code development while the Wiki is not initialized, but all repository documentation must remain current.

### Excluded from v0.1

- #25 screen-recording ingestion.
- #26 App Intents/Android shortcuts.
- #27 macOS, browser, clipboard sync, and MCP.
- Accounts, teams, cloud sync, remote OCR/LLM, direct AI-vendor APIs, analytics containing user content, subscriptions, and background monitoring.

Do not implement an excluded feature because it appears convenient. Create or update a follow-up issue instead.

## Technical constraints

- React Native 0.86, React 19, TypeScript strict, Hermes, New Architecture.
- Expo SDK 57 modules installed in the React Native project.
- `ios/` and `android/` are committed production source.
- Expo Go is not a supported development or verification environment.
- iOS/iPadOS 16.4+.
- Android API 24+, compileSdk/targetSdk 36.
- iOS native code uses Swift; Android native code uses Kotlin.
- iOS share entry is a native Share Extension and App Group Inbox.
- Android share entry uses ACTION_SEND/ACTION_SEND_MULTIPLE and an app-private Inbox.
- iOS OCR/PDF uses Vision/PDFKit.
- Android OCR/PDF uses ML Kit v2/PdfRenderer with the documented API-level fallback.
- Heavy processing runs in the main application, not the iOS Share Extension.
- No unsupported automatic opening of the iOS containing app.
- JS/native boundaries pass controlled file URIs and versioned DTOs, not complete image/PDF byte arrays.
- SQLite stores metadata; application-owned files store binary artifacts.
- No user content leaves the device in the core flow.
- Do not run `expo prebuild --clean` over maintained native targets without an approved migration ADR.

## Persistent execution model

Work toward this Master Goal continuously across issues and PRs. A PR review pause does not clear or redefine the Goal.

Only one implementation issue and one implementation PR may be active at a time unless the user explicitly authorizes parallel work with isolated worktrees and non-overlapping ownership.

### Step 1: select work

- Read Epic #2, Roadmap, current phase gate, dependency graph, and open issue state.
- Select the next unblocked issue in the required order.
- Confirm all dependencies are accepted or explicitly waived.
- Post or maintain a concise execution plan tied to that issue.
- Do not begin a later feature because the current issue is difficult.

### Step 2: implement one issue

- Create a dedicated branch named `codex/issue-<number>-<slug>`.
- Keep changes within the selected issue.
- Build acceptance fixtures before or with implementation.
- Implement the smallest complete design that satisfies the issue.
- Use small, intentional commits.
- Keep generated files, credentials, private signing values, user data, and unrelated edits out of commits.
- Update documentation and ADRs in the same PR when behavior or architecture changes.

### Step 3: verify before PR

Run every applicable local check:

- Dependency/lockfile integrity and Expo Doctor after dependency changes.
- TypeScript typecheck, lint, formatting and tests.
- React Native component/interaction tests.
- Android JUnit/instrumentation checks and debug/release build as applicable.
- iOS XCTest, main-app build, and Share Extension build as applicable.
- Shared schema/contract tests.
- Privacy/logging/security regression tests.
- Performance, low-memory, low-disk, interruption, or physical-device tests required by labels.
- Inspect the diff for scope drift, sensitive data, ignored errors, unchecked casts, `any`, disabled tests, placeholder behavior, or swallowed failures.

A check that cannot be run must be named in the PR with the exact blocker and reproducible manual procedure. Never report an unrun check as passing.

### Step 4: open a Draft PR

The Draft PR must:

- Link the issue and use the approved branch.
- Describe scope, design, architecture/dependency changes, risks, and exclusions.
- Map every acceptance criterion to evidence.
- Include exact test commands and results.
- Include iOS/Android/shared evidence according to labels.
- Include screenshots or recordings for user-visible behavior, using synthetic data.
- Include privacy/security review and rollback notes.
- Identify follow-up work without implementing it.
- Remain Draft until review findings and required CI are resolved.
- Request `@codex review` when repository code review is enabled.

Do not merge the PR. Do not open the next implementation PR.

### Step 5: mandatory human review gate

When the Draft PR is ready:

- Set work status to `AWAITING_REVIEW`.
- Stop all repository mutations except fixes requested on that PR.
- Report the issue number, PR URL, commit SHA, checks, remaining manual tests, and known risks.
- Wait for the user to send the PR to the independent reviewer.
- Address accepted feedback in the same branch/PR.
- Re-run affected tests and update the evidence.
- Wait for explicit approval and merge confirmation.

The persistent Goal remains the complete v0.1 app during this pause. Do not declare the Goal complete and do not reinterpret it as the current issue.

### Step 6: close the execution unit and continue

After approval and merge:

- Confirm the merged commit and required checks.
- Confirm the issue is closed or update its acceptance record.
- Update Epic #2 progress and current phase gate.
- Select the next unblocked issue.
- Continue the same Master Goal.

## Required execution order

Follow dependencies and use this default order unless Epic #2 records an approved change:

1. Governance: #1.
2. Phase 0: #3 → #4 → #5 → #6.
3. Phase 1: #7 → #8 → #9 → #10 → #11 → #12.
4. Phase 2: #13 → #14 → #15 → #16 → #17 → #18 → #19.
5. Phase 3 core: #20 → #21 → #22.
6. Release preparation: #24 creates reproducible release configuration and TestFlight/Play Internal builds, but remains open for its final public-release gate.
7. Product beta: #23 runs real-task validation using those builds.
8. Final release gate: finish #24 and Epic #2 after #23 posts a go decision.

If an issue becomes materially larger than its declared size, stop and propose a split before implementation. Do not hide an oversized change inside one PR.

## Phase promotion gates

At the end of each phase:

- Post a promotion report to Epic #2.
- List merged issues/PRs, tests, platform evidence, accepted risks, open defects, performance results, and documentation status.
- Verify no priority:p0/p1 blocker remains for that phase.
- Pause for explicit promotion approval before starting the next phase.

A phase is not promoted merely because its PRs merged.

## Privacy and security invariants

- Never log or upload imported text, OCR output, full filenames, full URLs/query values, file bytes, screenshots, PDFs, detector matches, or user instructions.
- Use generated synthetic fixtures and fake credentials only.
- Preserve originals; processing produces immutable derivatives.
- No silent data loss or silent omission of failed items.
- Redacted images must be newly rendered and flattened; overlay-only redaction is prohibited.
- Pending high-risk findings block normal export until reviewed.
- Export uses an explicit reviewed-artifact allowlist.
- Sanitize filenames and archive paths; test traversal and Unicode edge cases.
- Provider URIs are temporary inputs, never durable references.
- Cleanup is reference-aware, idempotent, interruption-safe, and tested.
- Fail closed on unknown breaking schema versions or unresolved integrity state.

A privacy/security invariant cannot be waived inside a PR. It requires an explicit user decision recorded in Epic #2 and the relevant ADR/specification.

## Dependency discipline

- Pin dependencies and commit the lockfile.
- Prefer platform SDKs and maintained Expo/RN modules.
- Every dependency requires a documented reason, New Architecture compatibility, maintenance status, license, privacy impact, binary-size impact, and native-platform impact.
- Do not use an unmaintained wrapper for share ingestion, OCR, PDF, storage, redaction, or archive safety.
- Do not add a backend or network dependency to simplify a local requirement.
- Do not upgrade unrelated dependencies inside a feature PR.

## Definition of Done

The Master Goal is complete only when all of the following are true:

### Delivery

- [ ] Issues #3–#24 required by Epic #2 are accepted; #1 governance is complete.
- [ ] Every implementation PR received independent review and was merged only after approval.
- [ ] No required acceptance criterion is marked complete without evidence.
- [ ] Epic #2 contains a final traceability table from requirement → issue → PR → test/evidence.

### Functional

- [ ] Images, PDFs, text, and URLs work through system sharing and main-app import on iOS and Android.
- [ ] Multi-item order, partial failure, retry, cancellation, checkpoint and recovery work.
- [ ] OCR/PDF extraction, normalization, duplicate suggestions, estimation and compression work locally.
- [ ] Secret/PII review and irreversible redaction work.
- [ ] Markdown, PDF, clipboard and attachment-bundle exports match preview and contain only reviewed artifacts.
- [ ] History, storage management, cleanup and migration work across restart/upgrade.

### Platform and quality

- [ ] Clean checkout builds iOS main app, iOS Share Extension and Android app.
- [ ] Required CI is green on the final commit.
- [ ] Supported device/API matrix and physical-device share hosts pass.
- [ ] English/Simplified Chinese and VoiceOver/TalkBack requirements pass.
- [ ] Airplane-mode core flow passes on both platforms.
- [ ] Performance/resource budgets pass or have an explicit accepted release decision.
- [ ] No open priority:p0/p1 defect remains.

### Privacy and release

- [ ] Log, network, dependency, license, permission and privacy audits pass.
- [ ] TestFlight and Play Internal install/upgrade/delete/import/export paths pass.
- [ ] At least 20 real beta tasks cover both platforms with completion rate ≥80%, or the Goal remains blocked.
- [ ] App Store and Google Play metadata/privacy declarations match runtime behavior.
- [ ] Release builds, rollback plan, known issues and support path are complete.
- [ ] Public submission happens only after explicit go approval and available store credentials.

## Blockers and external actions

Goal mode does not grant broader permissions. When credentials, signing, store accounts, physical devices, Wiki initialization, beta testers, policy decisions, or review approval are required:

- Preserve completed work and test evidence.
- Report the exact blocker and smallest required user action.
- Pause rather than bypassing the control.
- Resume the same Goal after the blocker is resolved.

Do not replace a missing external requirement with fabricated evidence.

## Final completion report

Before declaring the Goal complete, post to Epic #2:

- Requirement/issue/PR/evidence traceability.
- Final supported platform and device matrix.
- Test and CI summary.
- Privacy/security/dependency/license audit results.
- Performance results and accepted exceptions.
- Beta metrics and go/no-go decision.
- Store build/version identifiers.
- Known issues, rollback and support plan.
- Explicit confirmation that post-MVP issues #25–#27 were not pulled into v0.1.

Then request final user acceptance. Only after acceptance may the Goal be cleared.
