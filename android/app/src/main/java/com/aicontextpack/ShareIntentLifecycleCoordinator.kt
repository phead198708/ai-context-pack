package com.aicontextpack

import java.io.File
import java.nio.charset.StandardCharsets
import java.util.UUID

internal enum class ShareArtifactState {
  PUBLISHED,
  STAGING,
  MISSING,
}

internal data class ShareLifecycleIssue(
  val eventId: String,
  val transactionId: String,
  val code: String,
)

/** Reconciles the durable transaction journal without ever letting metadata errors escape. */
internal class ShareIntentLifecycleCoordinator(
  private val store: ShareIntentTransactionStore,
  private val artifactState: (String) -> ShareArtifactState,
  private val publishTerminal: (ShareIntentTransactionStore.Transaction) -> Boolean,
  private val publishIssue: (ShareLifecycleIssue) -> Unit,
) {
  fun acceptNew(id: String): ShareIntentTransactionStore.Transaction? = safely(id) {
    store.acceptNew(id)
  }

  fun markInProgress(id: String) {
    safely(id) { store.markInProgress(id) }
  }

  fun completeWorker(id: String, result: ShareInboxImporter.Result) {
    safely(id) {
      finish(
        id,
        if (result.published)
          ShareIntentTransactionStore.TerminalResult.COMPLETE
        else ShareIntentTransactionStore.TerminalResult.FAILED,
        if (result.published) null else (result.code ?: "SHARE_IMPORT_FAILED"),
      )
    }
  }

  fun reconcile(activeWorkerIds: Set<String> = emptySet()) {
    val snapshot = try {
      store.snapshot()
    } catch (error: Exception) {
      report(error, stableId("snapshot"))
      return
    }
    snapshot.issues.forEach { issue -> report(issue.id, issue.code) }
    snapshot.transactions.forEach { transaction ->
      if (transaction.id in activeWorkerIds) return@forEach
      safely(transaction.id) { reconcile(transaction) }
    }
  }

  private fun reconcile(transaction: ShareIntentTransactionStore.Transaction) {
    when (transaction.state) {
      ShareIntentTransactionStore.State.COMPLETE_NEEDS_EVENT,
      ShareIntentTransactionStore.State.FAILED_NEEDS_EVENT -> publishPrepared(transaction)
      ShareIntentTransactionStore.State.RECOVERY_REQUIRED -> finish(
        transaction.id,
        ShareIntentTransactionStore.TerminalResult.FAILED,
        "SHARE_IMPORT_RECOVERY_REQUIRED",
      )
      ShareIntentTransactionStore.State.ACCEPTED,
      ShareIntentTransactionStore.State.IN_PROGRESS -> when (artifactState(transaction.id)) {
        ShareArtifactState.PUBLISHED -> finish(
          transaction.id,
          ShareIntentTransactionStore.TerminalResult.COMPLETE,
          null,
        )
        ShareArtifactState.STAGING -> {
          store.markRecoveryRequired(transaction.id)
          finish(
            transaction.id,
            ShareIntentTransactionStore.TerminalResult.FAILED,
            "SHARE_IMPORT_RECOVERY_REQUIRED",
          )
        }
        ShareArtifactState.MISSING -> finish(
          transaction.id,
          ShareIntentTransactionStore.TerminalResult.FAILED,
          "SHARE_IMPORT_INTERRUPTED",
        )
      }
      ShareIntentTransactionStore.State.COMPLETE,
      ShareIntentTransactionStore.State.FAILED -> Unit
    }
  }

  private fun finish(
    id: String,
    result: ShareIntentTransactionStore.TerminalResult,
    code: String?,
  ) {
    publishPrepared(store.prepareTerminal(id, result, code))
  }

  private fun publishPrepared(transaction: ShareIntentTransactionStore.Transaction) {
    if (publishTerminal(transaction)) store.markEventPublished(transaction.id)
  }

  private fun <T> safely(id: String, work: () -> T): T? = try {
    work()
  } catch (error: Exception) {
    report(error, id)
    null
  }

  private fun report(error: Exception, fallbackId: String) {
    if (error is ShareTransactionException) report(error.transactionId, error.stableCode)
    else report(fallbackId, "SHARE_TRANSACTION_RECONCILE_FAILED")
  }

  private fun report(transactionId: String, code: String) {
    val eventId = stableId("$transactionId:$code")
    try {
      publishIssue(ShareLifecycleIssue(eventId, transactionId, code))
    } catch (_: Exception) {
      // The Activity publisher has its own bounded fallback. A custom test publisher must not
      // be able to turn a recoverable metadata issue into a lifecycle crash either.
    }
  }

  companion object {
    fun inspectArtifacts(filesDir: File, id: String): ShareArtifactState = when {
      File(filesDir, "Inbox/$id/manifest.json").isFile -> ShareArtifactState.PUBLISHED
      File(filesDir, "InboxStaging/$id").exists() -> ShareArtifactState.STAGING
      else -> ShareArtifactState.MISSING
    }

    private fun stableId(key: String): String = UUID.nameUUIDFromBytes(
      "ai-context-pack:share-lifecycle:$key".toByteArray(StandardCharsets.UTF_8),
    ).toString()
  }
}
