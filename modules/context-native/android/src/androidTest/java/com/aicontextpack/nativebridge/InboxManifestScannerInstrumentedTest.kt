package com.aicontextpack.nativebridge

import androidx.test.platform.app.InstrumentationRegistry
import android.system.Os
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import java.io.File

class InboxManifestScannerInstrumentedTest {
  private lateinit var inbox: File

  @Before
  fun setUp() {
    inbox = File(
      InstrumentationRegistry.getInstrumentation().targetContext.cacheDir,
      "scanner-test/Inbox",
    )
    inbox.deleteRecursively()
    check(inbox.mkdirs())
  }

  @After
  fun tearDown() {
    inbox.parentFile?.deleteRecursively()
  }

  @Test
  fun rejectsMalformedManifestInsteadOfDroppingIt() {
    File(inbox, "broken/manifest.json").apply {
      parentFile?.mkdirs()
      writeText("{truncated")
    }

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsFileUriOutsideOwnedInbox() {
    writeManifest(File(inbox.parentFile, "outside.bin"))

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun returnsValidOwnedManifest() {
    val item = File(inbox, "valid/item.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item)

    assertEquals(1, InboxManifestScanner.scan(inbox).size)
  }

  @Test
  fun rejectsCopiedFileWithMismatchedByteCount() {
    val item = File(inbox, "valid/item.bin").apply {
      parentFile?.mkdirs()
      writeBytes(byteArrayOf(1, 2, 3))
    }
    writeManifest(item, byteCount = 4)

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun removesInterruptedTransactionsWithoutManifests() {
    val partial = File(inbox, "partial").apply { mkdirs() }
    File(partial, "item.partial").writeBytes(byteArrayOf(1, 2))
    val copied = File(inbox, "copied").apply { mkdirs() }
    File(copied, "item.bin").writeBytes(byteArrayOf(3, 4))

    assertEquals(emptyList<Map<String, Any?>>(), InboxManifestScanner.scan(inbox))
    assertEquals(false, partial.exists())
    assertEquals(false, copied.exists())
  }

  @Test
  fun rejectsInboxThatIsNotDirectory() {
    inbox.deleteRecursively()
    inbox.writeText("not a directory")

    assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
  }

  @Test
  fun rejectsTraversalFailure() {
    val blocked = File(inbox, "blocked").apply { mkdirs() }
    val item = File(blocked, "item.bin").apply { writeBytes(byteArrayOf(1)) }
    writeManifest(item, manifestDirectory = blocked)
    Os.chmod(blocked.path, 0)
    try {
      assertThrows(NativeException::class.java) { InboxManifestScanner.scan(inbox) }
    } finally {
      Os.chmod(blocked.path, 448)
    }
  }

  private fun writeManifest(
    item: File,
    byteCount: Long = item.length(),
    manifestDirectory: File = File(inbox, "valid"),
  ) {
    val directory = manifestDirectory.apply { mkdirs() }
    val payload = JSONObject()
      .put("schemaVersion", 1)
      .put("ingestionId", "valid")
      .put("createdAt", "2026-01-01T00:00:00Z")
      .put("source", "android-share-intent")
      .put("status", "complete")
      .put(
        "items",
        JSONArray().put(
          JSONObject()
            .put("id", "item")
            .put("mediaType", "image/png")
            .put("byteCount", byteCount)
            .put("localUri", item.toURI().toString())
            .put("status", "copied"),
        ),
      )
    File(directory, "manifest.json").writeText(payload.toString())
  }
}
