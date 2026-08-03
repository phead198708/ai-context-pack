package com.aicontextpack

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ShareIntentLifecycleCoordinatorTest {
  private lateinit var filesDir: File
  private lateinit var store: ShareIntentTransactionStore
  private val terminalEvents = linkedMapOf<String, ShareIntentTransactionStore.Transaction>()
  private val issueEvents = linkedMapOf<String, ShareLifecycleIssue>()

  @Before fun setUp() {
    filesDir = Files.createTempDirectory("share-lifecycle").toFile()
    store = ShareIntentTransactionStore(filesDir)
  }

  @After fun tearDown() { filesDir.deleteRecursively() }

  @Test fun actionMainClosesAcceptedTransactionWithoutArtifacts() {
    val transaction = store.acceptNew()

    coordinator().reconcile()

    assertTerminal(transaction.id, "SHARE_IMPORT_INTERRUPTED")
    assertTrue(store.snapshot().transactions.isEmpty())
  }

  @Test fun actionMainClosesInProgressTransactionWithoutArtifacts() {
    val transaction = store.acceptNew()
    store.markInProgress(transaction.id)

    coordinator().reconcile()

    assertTerminal(transaction.id, "SHARE_IMPORT_INTERRUPTED")
  }

  @Test fun actionMainMovesStagingTransactionThroughRecovery() {
    val transaction = store.acceptNew()
    store.markInProgress(transaction.id)
    File(filesDir, "InboxStaging/${transaction.id}").mkdirs()

    coordinator().reconcile()

    assertTerminal(transaction.id, "SHARE_IMPORT_RECOVERY_REQUIRED")
  }

  @Test fun actionMainPublishesCompleteForExistingManifest() {
    val transaction = store.acceptNew()
    val directory = File(filesDir, "Inbox/${transaction.id}").apply { mkdirs() }
    File(directory, "manifest.json").writeText("{}")

    coordinator().reconcile()

    val event = requireNotNull(terminalEvents[transaction.id])
    assertEquals(ShareIntentTransactionStore.TerminalResult.COMPLETE, event.terminalResult)
    assertNull(event.terminalCode)
  }

  @Test fun actionMainPublishesPreparedTerminalWithoutReimporting() {
    val transaction = store.acceptNew()
    store.prepareTerminal(
      transaction.id,
      ShareIntentTransactionStore.TerminalResult.FAILED,
      "SHARE_IMPORT_FAILED",
    )

    coordinator(artifact = { error("terminal journal must not inspect artifacts") }).reconcile()

    assertTerminal(transaction.id, "SHARE_IMPORT_FAILED")
  }

  @Test fun repeatedActionMainDoesNotDuplicateTerminalEvents() {
    val transaction = store.acceptNew()
    val lifecycle = coordinator()

    lifecycle.reconcile()
    lifecycle.reconcile()

    assertEquals(setOf(transaction.id), terminalEvents.keys)
    assertTrue(store.snapshot().transactions.isEmpty())
  }

  @Test fun actionMainReconcilesEveryPartialTransactionInQueueOrder() {
    val published = store.acceptNew()
    val staging = store.acceptNew()
    store.markInProgress(staging.id)
    val missing = store.acceptNew()
    File(filesDir, "Inbox/${published.id}").apply { mkdirs() }
      .resolve("manifest.json").writeText("{}")
    File(filesDir, "InboxStaging/${staging.id}").mkdirs()

    coordinator().reconcile()

    assertEquals(listOf(published.id, staging.id, missing.id), terminalEvents.keys.toList())
    assertEquals(ShareIntentTransactionStore.TerminalResult.COMPLETE, terminalEvents[published.id]?.terminalResult)
    assertEquals("SHARE_IMPORT_RECOVERY_REQUIRED", terminalEvents[staging.id]?.terminalCode)
    assertEquals("SHARE_IMPORT_INTERRUPTED", terminalEvents[missing.id]?.terminalCode)
  }

  @Test fun activeWorkerIsNotMisclassifiedByAnotherActivityIntent() {
    val transaction = store.acceptNew()
    store.markInProgress(transaction.id)

    coordinator().reconcile(setOf(transaction.id))

    assertTrue(terminalEvents.isEmpty())
    assertEquals(transaction.id, store.snapshot().transactions.single().id)
  }

  @Test fun corruptMetadataIsReportedAndOtherTransactionsStillClose() {
    val valid = store.acceptNew()
    val corruptId = "323e4567-e89b-42d3-a456-426614174000"
    File(filesDir, "ShareIntentTransactions/$corruptId.state").writeText("truncated")

    coordinator().reconcile()

    assertTerminal(valid.id, "SHARE_IMPORT_INTERRUPTED")
    assertTrue(issueEvents.values.any {
      it.transactionId == corruptId && it.code == "SHARE_TRANSACTION_SCHEMA_INVALID"
    })
  }

  @Test fun failedTerminalTransitionIsReportedAndRemainsReplayable() {
    var failTerminalWrite = false
    store = ShareIntentTransactionStore(filesDir) { point, destination, payload ->
      if (failTerminalWrite &&
        point == ShareIntentTransactionStore.WritePoint.BEFORE_ATOMIC_RENAME &&
        destination.name.endsWith(".state") && payload.contains("state=COMPLETE\n")) {
        error("terminal transition failed")
      }
    }
    val transaction = store.acceptNew()
    File(filesDir, "Inbox/${transaction.id}").apply { mkdirs() }
      .resolve("manifest.json").writeText("{}")
    failTerminalWrite = true

    coordinator().reconcile()

    assertEquals(
      ShareIntentTransactionStore.State.COMPLETE_NEEDS_EVENT,
      ShareIntentTransactionStore(filesDir).snapshot().transactions.single().state,
    )
    assertTrue(issueEvents.values.any {
      it.transactionId == transaction.id && it.code == "SHARE_TRANSACTION_TRANSITION_FAILED"
    })

    failTerminalWrite = false
    coordinator().reconcile()
    assertTrue(store.snapshot().transactions.isEmpty())
    assertEquals(setOf(transaction.id), terminalEvents.keys)
  }

  @Test fun transactionDirectoryWriteFailureDoesNotEscapeAcceptance() {
    File(filesDir, "ShareIntentTransactions").writeText("not a directory")

    val accepted = coordinator().acceptNew("123e4567-e89b-42d3-a456-426614174000")

    assertNull(accepted)
    assertTrue(issueEvents.values.any { it.code == "SHARE_TRANSACTION_STORE_WRITE_FAILED" })
  }

  @Test fun issuePublisherFailureCannotEscapeLifecycle() {
    File(filesDir, "ShareIntentTransactions").writeText("not a directory")
    val lifecycle = ShareIntentLifecycleCoordinator(
      store,
      artifactState = { ShareArtifactState.MISSING },
      publishTerminal = { true },
      publishIssue = { error("React host unavailable") },
    )

    lifecycle.reconcile()
  }

  private fun coordinator(
    artifact: (String) -> ShareArtifactState = {
      ShareIntentLifecycleCoordinator.inspectArtifacts(filesDir, it)
    },
  ) = ShareIntentLifecycleCoordinator(
    store,
    artifact,
    publishTerminal = { transaction ->
      terminalEvents[transaction.id] = transaction
      true
    },
    publishIssue = { issue -> issueEvents[issue.eventId] = issue },
  )

  private fun assertTerminal(id: String, code: String) {
    val event = requireNotNull(terminalEvents[id])
    assertEquals(ShareIntentTransactionStore.TerminalResult.FAILED, event.terminalResult)
    assertEquals(code, event.terminalCode)
  }
}
