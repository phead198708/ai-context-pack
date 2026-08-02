package com.aicontextpack

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

  @Test fun restoredQueuedTransactionIsRetriedWhenNoNativeArtifactExists() {
    val accepted = store.acceptNew()
    assertEquals(ShareIntentTransactionStore.State.ACCEPTED, store.restored()?.state)
    assertEquals(accepted.id, store.restored()?.id)
  }

  @Test fun publishedTransactionBecomesTerminalDeliveryWithoutReimport() {
    val accepted = store.acceptNew()
    File(filesDir, "Inbox/${accepted.id}/manifest.json").apply {
      parentFile?.mkdirs(); writeText("fixture")
    }
    assertEquals(
      ShareIntentTransactionStore.State.PUBLISHED_NEEDS_EVENT,
      store.restored()?.state,
    )
    store.transition(accepted.id, ShareIntentTransactionStore.State.COMPLETE)
    assertEquals(ShareIntentTransactionStore.State.COMPLETE, store.restored()?.state)
  }

  @Test fun interruptedStagingRequiresRecoveryInsteadOfDuplicateImport() {
    val accepted = store.acceptNew()
    File(filesDir, "InboxStaging/${accepted.id}").mkdirs()
    assertEquals(
      ShareIntentTransactionStore.State.RECOVERY_REQUIRED,
      store.restored()?.state,
    )
  }

  @Test fun genuineNewIntentGetsANewPrivacySafeTransactionId() {
    val first = store.acceptNew()
    val second = store.acceptNew()
    assertNotEquals(first.id, second.id)
  }

  @Test fun persistenceFailureStillProducesAVisibleFailedEvent() {
    val id = "00000000-0000-4000-8000-000000000002"
    val event = ShareResultEventPublisher.persistOrFallback(id, "complete") { error("disk full") }
    assertEquals(id, event["id"])
    assertTrue(event["result"] == "failed")
    assertFalse(event["durable"] as Boolean)
    assertEquals("SHARE_RESULT_PERSIST_FAILED", event["code"])
  }
}
