package com.aicontextpack

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class ShareIntentTransactionStoreTest {
  private lateinit var filesDir: File
  private lateinit var store: ShareIntentTransactionStore

  @Before fun setUp() {
    filesDir = Files.createTempDirectory("share-transaction").toFile()
    store = ShareIntentTransactionStore(filesDir)
  }

  @After fun tearDown() { filesDir.deleteRecursively() }

  @Test fun acceptedTransactionsRemainQueuedInOrder() {
    val first = store.acceptNew()
    val second = store.acceptNew()

    assertEquals(listOf(first.id, second.id), store.snapshot().transactions.map { it.id })
    assertEquals(listOf(1L, 2L), store.snapshot().transactions.map { it.order })
  }

  @Test fun queuedAndInProgressTransactionsBothSurviveProcessRestart() {
    val first = store.acceptNew()
    store.markInProgress(first.id)
    val second = store.acceptNew()

    val restored = ShareIntentTransactionStore(filesDir).snapshot().transactions
    assertEquals(listOf(first.id, second.id), restored.map { it.id })
    assertEquals(
      listOf(
        ShareIntentTransactionStore.State.IN_PROGRESS,
        ShareIntentTransactionStore.State.ACCEPTED,
      ),
      restored.map { it.state },
    )
  }

  @Test fun terminalTransactionLeavesOnlyPendingWorkInQueue() {
    val first = store.acceptNew()
    val second = store.acceptNew()
    store.prepareTerminal(first.id, ShareIntentTransactionStore.TerminalResult.COMPLETE)
    store.markEventPublished(first.id)

    assertEquals(listOf(second.id), ShareIntentTransactionStore(filesDir).snapshot().transactions.map { it.id })
  }

  @Test fun corruptQueueIndexIsQuarantinedAndRebuiltFromEveryJournalRecord() {
    val first = store.acceptNew()
    val second = store.acceptNew()
    val index = File(filesDir, "ShareIntentTransactions/queue.index")
    index.writeText("schemaVersion=1\nids=${second.id.substring(0, 8)}")

    val snapshot = ShareIntentTransactionStore(filesDir).snapshot()

    assertEquals(listOf(first.id, second.id), snapshot.transactions.map { it.id })
    assertTrue(snapshot.issues.any { it.code == "SHARE_TRANSACTION_SCHEMA_INVALID" })
    assertEquals(
      "schemaVersion=1\nids=${first.id},${second.id}\n",
      index.readText(),
    )
  }

  @Test fun malformedStateIsQuarantinedWithoutHidingOtherTransactions() {
    val first = store.acceptNew()
    val badId = "323e4567-e89b-42d3-a456-426614174000"
    File(filesDir, "ShareIntentTransactions/$badId.state").writeText("truncated")

    val snapshot = ShareIntentTransactionStore(filesDir).snapshot()

    assertEquals(listOf(first.id), snapshot.transactions.map { it.id })
    assertEquals(badId, snapshot.issues.first { it.code == "SHARE_TRANSACTION_SCHEMA_INVALID" }.id)
    assertTrue(File(filesDir, "ShareIntentTransactions").listFiles().orEmpty().any {
      it.name.startsWith("$badId.state.") && it.name.endsWith(".invalid")
    })
  }

  @Test fun transactionDirectoryFileIsIsolatedAndReported() {
    val directory = File(filesDir, "ShareIntentTransactions")
    directory.writeText("not a directory")

    val snapshot = store.snapshot()

    assertEquals(emptyList<ShareIntentTransactionStore.Transaction>(), snapshot.transactions)
    assertEquals("SHARE_TRANSACTION_STORE_READ_FAILED", snapshot.issues.single().code)
    assertFalse(directory.exists())
  }

  @Test fun partialWriteFailureDoesNotChangePersistedState() {
    var fail = false
    val injected = ShareIntentTransactionStore(filesDir) { point, destination, payload ->
      if (fail && point == ShareIntentTransactionStore.WritePoint.BEFORE_PARTIAL_WRITE &&
        destination.name.endsWith(".state") && payload.contains("state=IN_PROGRESS")) {
        error("partial write failed")
      }
    }
    val accepted = injected.acceptNew()
    fail = true

    val error = assertThrows(ShareTransactionException::class.java) {
      injected.markInProgress(accepted.id)
    }

    assertEquals("SHARE_TRANSACTION_TRANSITION_FAILED", error.stableCode)
    assertEquals(
      ShareIntentTransactionStore.State.ACCEPTED,
      ShareIntentTransactionStore(filesDir).snapshot().transactions.single().state,
    )
    assertFalse(File(filesDir, "ShareIntentTransactions/${accepted.id}.partial").exists())
  }

  @Test fun atomicRenameFailureDoesNotChangePersistedTerminalResult() {
    var fail = false
    val injected = ShareIntentTransactionStore(filesDir) { point, destination, payload ->
      if (fail && point == ShareIntentTransactionStore.WritePoint.BEFORE_ATOMIC_RENAME &&
        destination.name.endsWith(".state") && payload.contains("state=FAILED_NEEDS_EVENT")) {
        error("rename failed")
      }
    }
    val accepted = injected.acceptNew()
    injected.markInProgress(accepted.id)
    fail = true

    val error = assertThrows(ShareTransactionException::class.java) {
      injected.prepareTerminal(
        accepted.id,
        ShareIntentTransactionStore.TerminalResult.FAILED,
        "SHARE_IMPORT_FAILED",
      )
    }

    assertEquals("SHARE_TRANSACTION_TRANSITION_FAILED", error.stableCode)
    assertEquals(
      ShareIntentTransactionStore.State.IN_PROGRESS,
      ShareIntentTransactionStore(filesDir).snapshot().transactions.single().state,
    )
  }

  @Test fun queuePublicationFailureStillLeavesAcceptedJournalRecoverable() {
    var fail = true
    val injected = ShareIntentTransactionStore(filesDir) { point, destination, payload ->
      if (fail && point == ShareIntentTransactionStore.WritePoint.BEFORE_ATOMIC_RENAME &&
        destination.name == "queue.index" && !payload.endsWith("ids=\n")) error("index rename failed")
    }

    assertThrows(ShareTransactionException::class.java) { injected.acceptNew() }
    fail = false

    val snapshot = ShareIntentTransactionStore(filesDir).snapshot()
    assertEquals(1, snapshot.transactions.size)
    assertEquals(ShareIntentTransactionStore.State.ACCEPTED, snapshot.transactions.single().state)
  }

  @Test fun terminalJournalReplaysTheSameResultWithoutReimport() {
    val accepted = store.acceptNew()
    store.markInProgress(accepted.id)
    store.prepareTerminal(
      accepted.id,
      ShareIntentTransactionStore.TerminalResult.FAILED,
      "SHARE_IMPORT_FAILED",
    )

    val restored = ShareIntentTransactionStore(filesDir).snapshot().transactions.single()
    assertEquals(ShareIntentTransactionStore.State.FAILED_NEEDS_EVENT, restored.state)
    assertEquals(ShareIntentTransactionStore.TerminalResult.FAILED, restored.terminalResult)
    assertEquals("SHARE_IMPORT_FAILED", restored.terminalCode)
  }

  @Test fun conflictingTerminalResultIsRejected() {
    val accepted = store.acceptNew()
    store.prepareTerminal(
      accepted.id,
      ShareIntentTransactionStore.TerminalResult.FAILED,
      "SHARE_IMPORT_FAILED",
    )

    val error = assertThrows(ShareTransactionException::class.java) {
      store.prepareTerminal(accepted.id, ShareIntentTransactionStore.TerminalResult.COMPLETE)
    }
    assertEquals("SHARE_TRANSACTION_TERMINAL_CONFLICT", error.stableCode)
  }

  @Test fun repeatedRestorationIsIdempotent() {
    val first = store.acceptNew()
    val second = store.acceptNew()
    val once = ShareIntentTransactionStore(filesDir).snapshot()
    val twice = ShareIntentTransactionStore(filesDir).snapshot()

    assertEquals(listOf(first.id, second.id), once.transactions.map { it.id })
    assertEquals(once, twice)
    assertEquals(emptyList<ShareIntentTransactionStore.StoreIssue>(), twice.issues)
  }

  @Test fun persistenceFailureStillProducesAVisibleFailedEventWithDistinctId() {
    val id = "00000000-0000-4000-8000-000000000002"
    val event = ShareResultEventPublisher.persistOrFallback(id, "complete") { _, _ -> error("disk full") }
    assertNotEquals(id, event["id"])
    assertTrue(event["result"] == "failed")
    assertFalse(event["durable"] as Boolean)
    assertEquals("SHARE_RESULT_PERSIST_FAILED", event["code"])
  }
}
