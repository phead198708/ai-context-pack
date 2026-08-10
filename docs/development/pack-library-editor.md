# Pack library and editor shell

Issue #12 adds the shared React Native Pack library and editor foundation. It reads the
production Pack graph, artifact metadata, and persisted import outcomes; no file bytes or user
content cross the JS/native boundary for library rendering.

## Library truth

Every Pack appears in exactly one of seven user-facing views: Draft, Processing,
ReviewRequired, Ready, Exported, Failed, or Cancelled. Native `exporting` and `recovering`
states remain visible in Processing rather than creating hidden states. Each view is rendered
even when empty and has a stable `pack-section-<state>` test identifier.

The editor derives ordered rows from `ContextPack.orderedItemIds` and `ContextItem.sortIndex`.
Rows show source type, media type, original byte count, durable stage, stage-level progress,
warnings, and a stable error code. A failed item without a persisted import error displays the
generic `PIPELINE_STAGE_FAILED` code; it is never silently omitted. Duplicate warnings compare
only SHA-256 metadata inside the same Pack. A review-required item is surfaced as low-confidence
review work without exposing content to logs or diagnostics.

## Mutations and recovery

The controller serializes writes and reloads the current optimistic revision for every change.
Rename, instruction edit, reorder, removal, retry, and cancellation therefore either commit one
valid graph or fail with a stable domain code. Reorder rewrites contiguous `sortIndex` values and
`orderedItemIds`, invalidates packaged items back to the reviewed checkpoint, and moves a
Ready/Exporting/Exported Pack back to Processing. Downstream packaging therefore restarts from
the affected stage using the new durable order; immutable originals and extraction artifacts are
not duplicated.

Active item states already identify their durable checkpoint. When work enters
`failed`, `cancelled`, or `recovering`, schema v4 persists the exact next `retryStage`
independently from that terminal state, so a packaging failure cannot erase a completed
privacy review. Legacy v3 terminal rows are conservatively backfilled from immutable
evidence, except retained import failures, which resume at `import`. New terminal writes without
a retry stage fail closed.

The initial/import fallback is:

- no owned original: import (handled by the existing retained-source import retry UI);
- original only: extract;
- extracted text: analyze;
- recorded findings: review;
- reviewed content: package.

The item returns to the state immediately before the persisted stage and clears the terminal-only
retry marker while retaining the same item, original, hash, path, and artifact identities. Schema
v5 inserts a unique `pipeline_runs` token in the same SQLite transaction. The app-start recovery
consumer uses a monotonic compare-and-swap claim so concurrent coordinator instances cannot both
settle the same token, then executes Phase 1 extraction through the native
OCR, PDF, or bounded plain-text adapter. The immutable text derivative is published under the run
identity; artifact registration, item advancement, Pack revision, and token completion then commit
atomically. Restart replays the token rather than copying the original. An import failure without
an owned original is not made to look executable by a state-only retry.

Cancel uses the shared Pack state machine as the durable stop gate and invalidates every active
run token in the same transaction. It then asks the in-flight native task to stop. A late native
success cannot register an artifact or advance state because its token is no longer active. This
preserves both completed immutable artifacts and the exact resume point instead of replacing
progress with a lossy generic cancelled item state. Pack Retry restores failed/recovering items
from their artifact-derived checkpoints and resumes a cancelled Pack without copying originals.
If every item is already packaged, Pack Retry returns the Pack directly to Ready instead of
creating an export-level dead end.

## Removal integrity

Normal **Remove from Pack** creates a `library-item` reference to the immutable original in the
same SQLite transaction before releasing the Pack reference. Derived artifacts are released for
the existing reference-aware retention and quarantine process. This prevents cleanup or restart
from deleting the original.

**Delete local original** is a separate destructive action. React Native requires an explicit
destructive confirmation, then commits `removedItemOriginalDisposition: release`. Schema v5 first
records the import item's `released` tombstone in the same transaction that drops references.
`listImportDetails` can therefore distinguish an intentional release from missing retained data
after cleanup or restart, while unexpected artifact loss still fails closed. The existing
reference-aware cleanup transaction and retention policy remain the sole owner of physical
deletion, so a cleanup/recovery race cannot delete live bytes.
Removing an item also cancels its active durable run in that same graph transaction. Any native
success arriving after removal is rejected by the invalidated claim and cannot recreate the item
or attach a derivative to the Pack.

## Navigation and accessibility

Completing a system-share import continues to open the newest durable Pack. Native navigation
may emit `AIContextPackOpenPack` with `{ packId }`; React Native accepts only a canonical UUID,
does not interrupt an in-progress New Pack selection, and never falls back to a different Pack
when the requested ID is stale. Rapid selections use a latest-request gate so an older SQLite
read cannot replace the newer selection. A controlled selection change invalidates the prior
load token during render, before passive-effect cleanup, closing the native deep-link commit
window. Mutation completion always reloads the current selection; if an earlier Pack mutation
fails after the user moves elsewhere, the newer Pack stays selected and a global accessible
error banner exposes the stable failure code until dismissed or another mutation begins. Rename
and instruction fields keep independent dirty drafts, so a completed reorder or another
background mutation cannot overwrite unrelated unsaved text. All mutation inputs are disabled
while a write is pending, preventing edits that could never be represented by the pending commit.

Pack and item status, stages, progress, warning counts, error codes, drag handles, move actions,
and primary actions have accessibility labels or actions. English and Simplified Chinese use the
same state/action model. Automated interaction tests cover the accessible surface; full
VoiceOver and TalkBack task completion remains named manual Simulator/Emulator evidence under
ADR-0003.
