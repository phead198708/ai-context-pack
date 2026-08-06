package com.aicontextpack.nativebridge

import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OwnedArtifactStoreInstrumentedTest {
  private lateinit var root: File
  private lateinit var source: File
  private val packId = "123e4567-e89b-42d3-a456-426614174000"
  private val artifactId = "223e4567-e89b-42d3-a456-426614174000"

  @Before
  fun setUp() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    root = File(context.cacheDir, "artifact-store-${UUID.randomUUID()}")
    assertTrue(root.mkdir())
    source = File(root, "synthetic-source.bin").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
  }

  @After
  fun tearDown() {
    root.deleteRecursively()
  }

  @Test
  fun atomicPublishIsIdempotentAndImmutable() {
    val path = "Packs/$packId/originals/$artifactId.bin"
    val hash = sha256(byteArrayOf(1, 2, 3, 4))
    assertEquals(true, OwnedArtifactStore.publish(root, source, path, 4, hash)["created"])
    assertEquals(false, OwnedArtifactStore.publish(root, source, path, 4, hash)["created"])

    val replacement = File(root, "replacement.bin").apply { writeBytes(byteArrayOf(9, 9, 9, 9)) }
    val error = assertThrows(OwnedArtifactStoreException::class.java) {
      OwnedArtifactStore.publish(root, replacement, path, 4, sha256(replacement.readBytes()))
    }
    assertEquals("STORAGE_ARTIFACT_IMMUTABLE", error.stableCode)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), File(root, path).readBytes())
  }

  @Test
  fun abandonedPartialIsReplacedAndMetadataUsageIsDeterministic() {
    val path = "Packs/$packId/derived/$artifactId.txt"
    val destination = File(root, path)
    assertTrue(requireNotNull(destination.parentFile).mkdirs())
    File(destination.parentFile, "${destination.name}.partial").writeBytes(byteArrayOf(8, 8))

    assertEquals(
      true,
      OwnedArtifactStore.publish(root, source, path, 4, sha256(source.readBytes()))["created"],
    )
    assertFalse(File(destination.parentFile, "${destination.name}.partial").exists())
    assertEquals("verified", OwnedArtifactStore.verify(root, path, 4, sha256(source.readBytes()))["status"])
    assertEquals(1, OwnedArtifactStore.list(root).size)
    assertEquals(4L, OwnedArtifactStore.usage(root)["artifactBytes"])

    val quarantined = OwnedArtifactStore.quarantine(root, path)
    assertEquals(true, quarantined["quarantined"])
    assertEquals(artifactId, quarantined["anonymousId"])
    assertEquals(4L, quarantined["byteCount"])
    assertEquals(0, OwnedArtifactStore.usage(root)["artifactCount"])
    assertEquals(1, OwnedArtifactStore.usage(root)["quarantineCount"])
    assertTrue(OwnedArtifactStore.remove(root, path))
    val purge = OwnedArtifactStore.purgeQuarantine(root, System.currentTimeMillis() + 1_000)
    assertEquals(1, purge["purgedCount"])
    assertEquals(4L, purge["purgedBytes"])
    assertEquals(0, OwnedArtifactStore.usage(root)["quarantineCount"])
  }

  @Test
  fun abandonedPartialIsListedCountedQuarantinedAndPurged() {
    val path = "Packs/$packId/derived/$artifactId.txt"
    val partialPath = "$path.partial"
    val partial = File(root, partialPath)
    assertTrue(requireNotNull(partial.parentFile).mkdirs())
    partial.writeBytes(byteArrayOf(8, 8))

    assertEquals(
      listOf(mapOf("relativePath" to partialPath, "byteCount" to 2L)),
      OwnedArtifactStore.list(root),
    )
    assertEquals(1, OwnedArtifactStore.usage(root)["artifactCount"])
    assertEquals(2L, OwnedArtifactStore.usage(root)["artifactBytes"])

    val quarantined = OwnedArtifactStore.quarantine(root, partialPath)
    assertEquals(true, quarantined["quarantined"])
    assertEquals(artifactId, quarantined["anonymousId"])
    assertEquals(2L, quarantined["byteCount"])
    assertFalse(partial.exists())
    assertEquals(0, OwnedArtifactStore.usage(root)["artifactCount"])
    assertEquals(1, OwnedArtifactStore.usage(root)["quarantineCount"])

    val purge = OwnedArtifactStore.purgeQuarantine(root, System.currentTimeMillis() + 1_000)
    assertEquals(1, purge["purgedCount"])
    assertEquals(2L, purge["purgedBytes"])
  }

  @Test
  fun twoStoreCallersSerializeTheSameImmutableDestination() {
    val path = "Packs/$packId/exports/$artifactId.zip"
    val first = File(root, "first.bin").apply { writeBytes(ByteArray(128 * 1024) { 1 }) }
    val second = File(root, "second.bin").apply { writeBytes(ByteArray(128 * 1024) { 2 }) }
    val start = CountDownLatch(1)
    val done = CountDownLatch(2)
    val outcomes = java.util.Collections.synchronizedList(mutableListOf<String>())
    val executor = Executors.newFixedThreadPool(2)
    listOf(first, second).forEach { input ->
      executor.execute {
        start.await()
        try {
          OwnedArtifactStore.publish(root, input, path, input.length(), sha256(input.readBytes()))
          outcomes += "created"
        } catch (error: OwnedArtifactStoreException) {
          outcomes += error.stableCode
        } finally {
          done.countDown()
        }
      }
    }
    start.countDown()
    assertTrue(done.await(10, TimeUnit.SECONDS))
    executor.shutdownNow()
    assertEquals(
      listOf("STORAGE_ARTIFACT_IMMUTABLE", "created"),
      outcomes.sorted(),
    )
  }

  @Test
  fun rejectsTraversalProviderNamesAndSymlinkSources() {
    listOf(
      "/Packs/$packId/originals/$artifactId.bin",
      "Packs/$packId/originals/../$artifactId.bin",
      "Packs/$packId/originals/private-name.png",
      "Packs/$packId/originals/%2e%2e.bin",
    ).forEach { path ->
      assertThrows(OwnedArtifactStoreException::class.java) {
        OwnedArtifactStore.publish(root, source, path, null, null)
      }
    }
    val symlink = File(root, "source-link.bin")
    Os.symlink(source.path, symlink.path)
    val error = assertThrows(OwnedArtifactStoreException::class.java) {
      OwnedArtifactStore.publish(
        root,
        symlink,
        "Packs/$packId/previews/$artifactId.png",
        null,
        null,
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", error.stableCode)

    val pack = File(root, "Packs/$packId").apply { assertTrue(mkdirs()) }
    val escape = File(root, "escape").apply { assertTrue(mkdir()) }
    File(escape, "$artifactId.bin").writeBytes(byteArrayOf(1, 2, 3, 4))
    Os.symlink(escape.path, File(pack, "originals").path)
    val destinationError = assertThrows(OwnedArtifactStoreException::class.java) {
      OwnedArtifactStore.verify(
        root,
        "Packs/$packId/originals/$artifactId.bin",
        4,
        sha256(byteArrayOf(1, 2, 3, 4)),
      )
    }
    assertEquals("ARTIFACT_INTEGRITY_FAILED", destinationError.stableCode)
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
