package com.aicontextpack.nativebridge

import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ShareIngestionWriterInstrumentedTest {
  private lateinit var filesDir: java.io.File

  @Before fun setUp() {
    val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
    filesDir = java.io.File(cache, "share-ingestion-${UUID.randomUUID()}")
    assertTrue(filesDir.mkdirs())
  }

  @After fun tearDown() {
    filesDir.deleteRecursively()
  }

  @Test fun twentyImagesPreserveOrderAndPassTheProductionManifestReader() {
    val image = fixture("ocr-english.png")
    val ingestionId = UUID.randomUUID().toString()
    val inputs = (0 until 20).map { index -> input(index, "image/png", image) }

    val result = ShareIngestionWriter.publish(filesDir, ingestionId, inputs)

    assertEquals("complete", result.status)
    assertEquals(20, result.copied)
    assertEquals(0, result.rejected)
    val manifest = InboxManifestScanner.readPublished(java.io.File(filesDir, "Inbox"), ingestionId)
    @Suppress("UNCHECKED_CAST")
    val items = manifest["items"] as List<Map<String, Any?>>
    assertEquals((0 until 20).map(Int::toLong), items.map { (it["order"] as Number).toLong() })
    assertTrue(items.all { it["mediaType"] == "image/png" && it["sha256"] != null })
    assertTrue(items.none { it.containsKey("providerUri") || it.containsKey("localUri") })
  }

  @Test fun manifestBoundIsEnforcedBeforeAStagingDirectoryIsCreated() {
    val inputs = (0..ShareIngestionWriter.maximumReportedItemCount).map { index ->
      input(index, "text/plain", "item-$index".toByteArray())
    }

    assertThrows(IllegalArgumentException::class.java) {
      ShareIngestionWriter.publish(filesDir, UUID.randomUUID().toString(), inputs)
    }
    assertFalse(java.io.File(filesDir, "InboxStaging").exists())
    assertFalse(java.io.File(filesDir, "Inbox").exists())
  }

  @Test fun twentyImagesAtFiveMiBEachStreamWithinTheReceiverCopyBudgetWithoutProcessing() {
    val image = ByteArray(5 * 1024 * 1024) { 1 }.apply {
      byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        .copyInto(this)
    }
    val inputs = (0 until 20).map { index -> input(index, "image/png", image) }
    val started = SystemClock.elapsedRealtime()

    val result = ShareIngestionWriter.publish(filesDir, UUID.randomUUID().toString(), inputs)
    val durationMs = SystemClock.elapsedRealtime() - started

    assertEquals(20, result.copied)
    assertTrue("copy took ${durationMs}ms", durationMs < 15_000)
    println(
      "SHARE_INGESTION_BENCHMARK platform=android-avd items=20 itemBytes=5242880 " +
        "totalBytes=104857600 durationMs=$durationMs bufferBytes=65536 ocrRuns=0",
    )
  }

  @Test fun pdfTextUrlAndUnsupportedInputProduceOneOrderedPartialManifest() {
    val inputs = listOf(
      input(0, "application/pdf", fixture("text-one-page.pdf")),
      input(1, "text/plain", "synthetic plain text".toByteArray()),
      input(2, "text/plain", "https://example.invalid/path?token=synthetic".toByteArray()),
      input(3, "application/zip", byteArrayOf(0x50, 0x4b, 0x03, 0x04)),
    )

    val result = ShareIngestionWriter.publish(filesDir, UUID.randomUUID().toString(), inputs)

    assertEquals("partial", result.status)
    assertEquals(3, result.copied)
    assertEquals(1, result.rejected)
    assertEquals(0, result.failed)
    @Suppress("UNCHECKED_CAST")
    val items = result.manifest["items"] as List<Map<String, Any?>>
    assertEquals(
      listOf("application/pdf", "text/plain", "text/uri-list", "application/zip"),
      items.map { it["mediaType"] },
    )
    assertEquals("IMPORT_TYPE_UNSUPPORTED", items.last()["errorCode"])
  }

  @Test fun mixedCaseHttpsSchemeIsDetectedAsAWebUrl() {
    val result = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input(0, "text/plain", "HTTPS://example.invalid/path".toByteArray())),
    )

    @Suppress("UNCHECKED_CAST")
    val item = (result.manifest["items"] as List<Map<String, Any?>>).single()
    assertEquals("text/uri-list", item["mediaType"])
  }

  @Test fun replayAndOwnedHandoffDoNotNeedTheProviderPermissionAgain() {
    val available = AtomicBoolean(true)
    val opens = AtomicInteger(0)
    val input = ShareIngestionInput(
      id = UUID.randomUUID().toString(),
      order = 0,
      declaredMediaType = "image/png",
      openStream = {
        opens.incrementAndGet()
        if (!available.get()) throw SecurityException("permission expired")
        ByteArrayInputStream(fixture("ocr-english.png"))
      },
    )
    val ingestionId = UUID.randomUUID().toString()

    ShareIngestionWriter.publish(filesDir, ingestionId, listOf(input))
    available.set(false)
    val replay = ShareIngestionWriter.publish(filesDir, ingestionId, listOf(input))
    val packId = UUID.randomUUID().toString()
    val handoff = InboxArtifactHandoff.handoff(filesDir, ingestionId, packId, 0)

    assertTrue(replay.replayed)
    assertEquals(1, opens.get())
    @Suppress("UNCHECKED_CAST")
    assertEquals(1, (handoff["artifacts"] as List<Map<String, Any>>).size)
    assertTrue(java.io.File(filesDir, "Packs/$packId/originals/${input.id}.bin").isFile)
  }

  @Test fun concurrentDuplicatePublishReplaysAfterWriterOwnershipTransfers() {
    val ingestionId = UUID.randomUUID().toString()
    val ready = CountDownLatch(2)
    val start = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(2)
    val calls = (0 until 2).map {
      executor.submit(Callable {
        ready.countDown()
        start.await()
        ShareIngestionWriter.publish(
          filesDir,
          ingestionId,
          listOf(input(0, "image/png", fixture("ocr-english.png"))),
        )
      })
    }
    assertTrue(ready.await(2, TimeUnit.SECONDS))
    start.countDown()

    val results = calls.map { it.get(5, TimeUnit.SECONDS) }
    executor.shutdownNow()
    assertEquals(listOf(false, true), results.map { it.replayed }.sorted())
    assertEquals(1, java.io.File(filesDir, "Inbox").listFiles().orEmpty().size)
  }

  @Test fun acknowledgedImportCannotBeRepublishedByAWaitingDuplicateWriter() {
    val ingestionId = UUID.randomUUID().toString()
    val packId = UUID.randomUUID().toString()
    val firstEntered = CountDownLatch(1)
    val allowFirstToFinish = CountDownLatch(1)
    val duplicateObservedConflict = CountDownLatch(1)
    val allowDuplicateRetry = CountDownLatch(1)
    val duplicateProviderOpens = AtomicInteger(0)
    val executor = Executors.newFixedThreadPool(2)
    val first = executor.submit(Callable {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(input(0, "image/png", fixture("ocr-english.png"))),
        operationHook = { point ->
          if (point == ShareIngestionWriter.Point.AFTER_FIRST_CHUNK) {
            firstEntered.countDown()
            check(allowFirstToFinish.await(5, TimeUnit.SECONDS))
          }
        },
      )
    })
    try {
      assertTrue(firstEntered.await(2, TimeUnit.SECONDS))
      val duplicate = executor.submit(Callable {
        ShareIngestionWriter.publish(
          filesDir,
          ingestionId,
          listOf(
            ShareIngestionInput(
              id = UUID.randomUUID().toString(),
              order = 0,
              declaredMediaType = "image/png",
              openStream = {
                duplicateProviderOpens.incrementAndGet()
                ByteArrayInputStream(fixture("ocr-english.png"))
              },
            ),
          ),
          operationHook = { point ->
            if (point == ShareIngestionWriter.Point.AFTER_OWNERSHIP_CONFLICT) {
              duplicateObservedConflict.countDown()
              check(allowDuplicateRetry.await(5, TimeUnit.SECONDS))
            }
          },
        )
      })

      assertTrue(duplicateObservedConflict.await(2, TimeUnit.SECONDS))
      allowFirstToFinish.countDown()
      val published = first.get(3, TimeUnit.SECONDS)
      InboxArtifactHandoff.handoff(filesDir, ingestionId, packId, 0)
      assertTrue(InboxArtifactHandoff.acknowledge(filesDir, ingestionId))
      assertTrue(java.io.File(filesDir, "InboxAcknowledgements/$ingestionId.json").isFile)
      assertFalse(java.io.File(filesDir, "Inbox/$ingestionId").exists())

      allowDuplicateRetry.countDown()
      val replay = duplicate.get(3, TimeUnit.SECONDS)

      assertFalse(published.replayed)
      assertTrue(replay.replayed)
      assertEquals(published.status, replay.status)
      assertEquals(published.copied, replay.copied)
      assertEquals(0, duplicateProviderOpens.get())
      assertFalse(java.io.File(filesDir, "Inbox/$ingestionId").exists())
      assertFalse(java.io.File(filesDir, "InboxStaging/$ingestionId").exists())
    } finally {
      allowFirstToFinish.countDown()
      allowDuplicateRetry.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun tombstoneWithoutReceiptFailsClosedUntilAcknowledgementRecoversIt() {
    val ingestionId = UUID.randomUUID().toString()
    val published = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
    )
    val tombstoneRoot = java.io.File(filesDir, "InboxAckTombstones")
    assertTrue(tombstoneRoot.mkdirs())
    val tombstone = java.io.File(
      tombstoneRoot,
      "$ingestionId-${UUID.randomUUID()}.ack",
    )
    assertTrue(java.io.File(filesDir, "Inbox/$ingestionId").renameTo(tombstone))
    val providerOpened = AtomicBoolean(false)

    val error = assertThrows(InboxAcknowledgementStoreException::class.java) {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(
          ShareIngestionInput(
            id = UUID.randomUUID().toString(),
            order = 0,
            declaredMediaType = "image/png",
            openStream = {
              providerOpened.set(true)
              ByteArrayInputStream(fixture("ocr-english.png"))
            },
          ),
        ),
      )
    }

    assertEquals("PIPELINE_RECOVERY_REQUIRED", error.stableCode)
    assertFalse(providerOpened.get())
    assertTrue(tombstone.isDirectory)
    assertTrue(InboxArtifactHandoff.acknowledge(filesDir, ingestionId))
    assertFalse(tombstone.exists())
    assertTrue(java.io.File(filesDir, "InboxAcknowledgements/$ingestionId.json").isFile)
    val replay = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
    )
    assertTrue(replay.replayed)
    assertEquals(published.copied, replay.copied)
  }

  @Test fun replayOwnershipBlocksAcknowledgementBetweenManifestCheckAndRead() {
    val ingestionId = UUID.randomUUID().toString()
    val itemId = UUID.randomUUID().toString()
    val bytes = fixture("ocr-english.png")
    val providerOpens = AtomicInteger(0)
    val sharedInput = ShareIngestionInput(
      id = itemId,
      order = 0,
      declaredMediaType = "image/png",
      openStream = {
        providerOpens.incrementAndGet()
        ByteArrayInputStream(bytes)
      },
    )
    ShareIngestionWriter.publish(filesDir, ingestionId, listOf(sharedInput))

    val manifestChecked = CountDownLatch(1)
    val allowManifestRead = CountDownLatch(1)
    val executor = Executors.newSingleThreadExecutor()
    val replay = executor.submit(Callable {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(sharedInput),
        operationHook = { point ->
          if (point == ShareIngestionWriter.Point.AFTER_LOCKED_REPLAY_MANIFEST_CHECK) {
            manifestChecked.countDown()
            check(allowManifestRead.await(5, TimeUnit.SECONDS))
          }
        },
      )
    })

    try {
      assertTrue(manifestChecked.await(2, TimeUnit.SECONDS))
      val packId = UUID.randomUUID().toString()
      InboxArtifactHandoff.handoff(filesDir, ingestionId, packId, 0)
      val blocked = assertThrows(InboxArtifactHandoffException::class.java) {
        InboxArtifactHandoff.acknowledge(filesDir, ingestionId)
      }
      assertEquals("PIPELINE_RECOVERY_REQUIRED", blocked.stableCode)

      allowManifestRead.countDown()
      val result = replay.get(5, TimeUnit.SECONDS)
      assertTrue(result.replayed)
      assertEquals(1, providerOpens.get())
      assertTrue(InboxArtifactHandoff.acknowledge(filesDir, ingestionId))
      assertTrue(java.io.File(filesDir, "Packs/$packId/originals/$itemId.bin").isFile)
    } finally {
      allowManifestRead.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun concurrentDifferentIdsPublishFromAnEmptyContainer() {
    val readyToCreateSharedDirectory = CountDownLatch(2)
    val allowCreation = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(2)
    val calls = (0 until 2).map {
      executor.submit(Callable {
        val interceptedFirstCreate = AtomicBoolean(false)
        ShareIngestionWriter.publish(
          filesDir,
          UUID.randomUUID().toString(),
          listOf(input(0, "image/png", fixture("ocr-english.png"))),
          operationHook = { point ->
            if (
              point == ShareIngestionWriter.Point.BEFORE_SHARED_DIRECTORY_CREATE &&
              interceptedFirstCreate.compareAndSet(false, true)
            ) {
              readyToCreateSharedDirectory.countDown()
              check(allowCreation.await(5, TimeUnit.SECONDS))
            }
          },
        )
      })
    }
    try {
      assertTrue(readyToCreateSharedDirectory.await(2, TimeUnit.SECONDS))
      allowCreation.countDown()
      val results = calls.map { it.get(5, TimeUnit.SECONDS) }

      assertTrue(results.all { it.status == "complete" && it.copied == 1 })
      assertEquals(2, java.io.File(filesDir, "Inbox").listFiles().orEmpty().size)
    } finally {
      allowCreation.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun preexistingSharedDirectoriesStillReachParentDurabilityBoundary() {
    val first = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
    )
    val parentSyncs = AtomicInteger(0)

    val second = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
      operationHook = { point ->
        if (point == ShareIngestionWriter.Point.BEFORE_SHARED_DIRECTORY_PARENT_SYNC) {
          parentSyncs.incrementAndGet()
        }
      },
    )

    assertEquals("complete", first.status)
    assertEquals("complete", second.status)
    assertEquals(2, parentSyncs.get())
  }

  @Test fun ownershipTimeoutCannotDeleteAnotherWritersActiveStaging() {
    val ingestionId = UUID.randomUUID().toString()
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(2)
    val first = executor.submit(Callable {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(input(0, "image/png", fixture("ocr-english.png"))),
        operationHook = { point ->
          if (point == ShareIngestionWriter.Point.AFTER_FIRST_CHUNK) {
            entered.countDown()
            check(release.await(10, TimeUnit.SECONDS))
          }
        },
      )
    })
    try {
      assertTrue(entered.await(2, TimeUnit.SECONDS))
      val duplicate = executor.submit(Callable {
        ShareIngestionWriter.publish(
          filesDir,
          ingestionId,
          listOf(input(0, "image/png", fixture("ocr-english.png"))),
        )
      })

      val error = assertThrows(ExecutionException::class.java) {
        duplicate.get(7, TimeUnit.SECONDS)
      }
      assertEquals("INBOX_WRITER_LOCK_ALREADY_EXISTS", error.cause?.message)
      assertTrue(java.io.File(filesDir, "InboxStaging/$ingestionId").isDirectory)

      release.countDown()
      assertEquals(1, first.get(3, TimeUnit.SECONDS).copied)
      assertEquals(1, java.io.File(filesDir, "Inbox").listFiles().orEmpty().size)
    } finally {
      release.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun forcedInterruptionBeforeDirectoryPublishLeavesNoVisibleImportAndCanRetry() {
    val ingestionId = UUID.randomUUID().toString()
    val input = input(0, "image/png", fixture("ocr-english.png"))

    assertThrows(ShareIngestionInterruptionException::class.java) {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(input),
        operationHook = { point ->
          if (point == ShareIngestionWriter.Point.BEFORE_DIRECTORY_PUBLISH) {
            throw ShareIngestionInterruptionException()
          }
        },
      )
    }
    assertFalse(java.io.File(filesDir, "Inbox/$ingestionId").exists())

    val retry = ShareIngestionWriter.publish(filesDir, ingestionId, listOf(input))
    assertEquals(1, retry.copied)
    assertEquals(1, java.io.File(filesDir, "Inbox").listFiles().orEmpty().size)
  }

  @Test fun failureAfterDirectoryRenameReturnsTheAlreadyVisibleCommittedImport() {
    val ingestionId = UUID.randomUUID().toString()

    val result = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
      operationHook = { point ->
        if (point == ShareIngestionWriter.Point.AFTER_DIRECTORY_PUBLISH) {
          throw ShareIngestionInterruptionException()
        }
      },
    )

    assertEquals("complete", result.status)
    assertEquals(1, result.copied)
    assertTrue(java.io.File(filesDir, "Inbox/$ingestionId/manifest.json").isFile)
    assertTrue(
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(input(0, "image/png", fixture("ocr-english.png"))),
      ).replayed,
    )
  }

  @Test fun postCommitManifestReadFailureRequiresLockedRecoveryAndPreservesPublishedInbox() {
    val ingestionId = UUID.randomUUID().toString()
    val sharedInput = input(0, "image/png", fixture("ocr-english.png"))

    val error = assertThrows(ShareIngestionCommittedRecoveryException::class.java) {
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(sharedInput),
        publishedManifestReader = { _, _ ->
          throw ShareIngestionIntegrityException()
        },
      )
    }

    assertEquals("MAIN_APP_IMPORT_COMMITTED_RECOVERY_REQUIRED", error.message)
    assertTrue(java.io.File(filesDir, "Inbox/$ingestionId/manifest.json").isFile)
    val retry = ShareIngestionWriter.publish(filesDir, ingestionId, listOf(sharedInput))
    assertTrue(retry.replayed)
    assertEquals(1, retry.copied)
    assertEquals(1, java.io.File(filesDir, "Inbox").listFiles().orEmpty().size)
  }

  @Test fun ownershipCleanupFailureAfterCommitReturnsTheValidatedPublishedImport() {
    val ingestionId = UUID.randomUUID().toString()
    val lockFile = java.io.File(filesDir, "InboxWriterLocks/$ingestionId.lock")
    val cleanupFailureInjected = AtomicBoolean(false)

    val result = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(input(0, "image/png", fixture("ocr-english.png"))),
      operationHook = { point ->
        if (point == ShareIngestionWriter.Point.AFTER_DIRECTORY_PUBLISH) {
          assertTrue(lockFile.delete())
          assertTrue(lockFile.mkdir())
          assertTrue(java.io.File(lockFile, "prevent-delete").createNewFile())
          cleanupFailureInjected.set(true)
        }
      },
    )

    assertTrue(cleanupFailureInjected.get())
    assertFalse(result.replayed)
    assertEquals("complete", result.status)
    assertEquals(1, result.copied)
    assertTrue(java.io.File(filesDir, "Inbox/$ingestionId/manifest.json").isFile)
    assertTrue(lockFile.deleteRecursively())
    assertTrue(
      ShareIngestionWriter.publish(
        filesDir,
        ingestionId,
        listOf(input(0, "image/png", fixture("ocr-english.png"))),
      ).replayed,
    )
  }

  @Test fun acknowledgementAfterValidationReturnsTheCommittedSnapshot() {
    val ingestionId = UUID.randomUUID().toString()
    val packId = UUID.randomUUID().toString()
    val sharedInput = input(0, "image/png", fixture("ocr-english.png"))

    val result = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(sharedInput),
      operationHook = { point ->
        if (point == ShareIngestionWriter.Point.AFTER_OWNERSHIP_RELEASE) {
          InboxArtifactHandoff.handoff(filesDir, ingestionId, packId, 0)
          assertTrue(InboxArtifactHandoff.acknowledge(filesDir, ingestionId))
        }
      },
    )

    assertFalse(result.replayed)
    assertEquals("complete", result.status)
    assertEquals(1, result.copied)
    assertFalse(java.io.File(filesDir, "Inbox/$ingestionId").exists())
    assertTrue(java.io.File(filesDir, "Packs/$packId/originals/${sharedInput.id}.bin").isFile)
  }

  @Test fun acknowledgementAfterPostCommitFailureReturnsTheInLockValidatedSnapshot() {
    val ingestionId = UUID.randomUUID().toString()
    val packId = UUID.randomUUID().toString()
    val sharedInput = input(0, "image/png", fixture("ocr-english.png"))
    val postCommitFailureInjected = AtomicBoolean(false)

    val result = ShareIngestionWriter.publish(
      filesDir,
      ingestionId,
      listOf(sharedInput),
      operationHook = { point ->
        when (point) {
          ShareIngestionWriter.Point.AFTER_DIRECTORY_PUBLISH -> {
            postCommitFailureInjected.set(true)
            throw ShareIngestionInterruptionException()
          }
          ShareIngestionWriter.Point.AFTER_OWNERSHIP_RELEASE -> {
            InboxArtifactHandoff.handoff(filesDir, ingestionId, packId, 0)
            assertTrue(InboxArtifactHandoff.acknowledge(filesDir, ingestionId))
          }
          else -> Unit
        }
      },
    )

    assertTrue(postCommitFailureInjected.get())
    assertFalse(result.replayed)
    assertEquals("complete", result.status)
    assertEquals(1, result.copied)
    assertFalse(java.io.File(filesDir, "Inbox/$ingestionId").exists())
    assertTrue(java.io.File(filesDir, "Packs/$packId/originals/${sharedInput.id}.bin").isFile)
  }

  @Test fun oversizedDeclaredMimeCannotAmplifyFailedManifestMetadata() {
    val oversized = "application/" + "x".repeat(500_000)
    val inputs = (0 until ShareIngestionWriter.maximumReportedItemCount).map { order ->
      ShareIngestionInput(
        id = UUID.randomUUID().toString(),
        order = order,
        declaredMediaType = oversized,
        preflightError = "IMPORT_COPY_FAILED",
      )
    }

    val result = ShareIngestionWriter.publish(filesDir, UUID.randomUUID().toString(), inputs)
    val manifestFile = java.io.File(
      filesDir,
      "Inbox/${result.ingestionId}/manifest.json",
    )
    @Suppress("UNCHECKED_CAST")
    val items = result.manifest["items"] as List<Map<String, Any?>>

    assertTrue(items.all { it["mediaType"] == "application/octet-stream" })
    assertTrue("manifestBytes=${manifestFile.length()}", manifestFile.length() < 100_000)
  }

  @Test fun oversizedTextIsRejectedWithTheStableSizeCode() {
    val input = ShareIngestionInput(
      id = UUID.randomUUID().toString(),
      order = 0,
      declaredMediaType = "text/plain",
      openStream = { RepeatingInputStream(ShareIngestionWriter.maximumTextBytes + 1) },
    )

    val result = ShareIngestionWriter.publish(filesDir, UUID.randomUUID().toString(), listOf(input))

    assertEquals("failed", result.status)
    assertEquals(1, result.rejected)
    @Suppress("UNCHECKED_CAST")
    val item = (result.manifest["items"] as List<Map<String, Any?>>).single()
    assertEquals("IMPORT_SIZE_LIMIT_EXCEEDED", item["errorCode"])
  }

  @Test fun declaredTypeCannotOverrideDetectedBytes() {
    val result = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input(0, "image/png", fixture("text-one-page.pdf"))),
    )

    assertEquals("failed", result.status)
    assertEquals(1, result.rejected)
    @Suppress("UNCHECKED_CAST")
    val item = (result.manifest["items"] as List<Map<String, Any?>>).single()
    assertEquals("application/pdf", item["mediaType"])
  }

  @Test fun wildcardImageUsesTheDetectedBinaryLimitInsteadOfTheProviderHint() {
    val image = ByteArray(ShareIngestionWriter.maximumTextBytes.toInt() + 1) { 1 }.apply {
      byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        .copyInto(this)
    }

    val result = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input(0, "*/*", image)),
    )

    assertEquals("complete", result.status)
    assertEquals(1, result.copied)
  }

  @Test fun zeroLengthBulkReadStillMakesProgressWithoutDroppingAByte() {
    val image = fixture("ocr-english.png")
    val input = ShareIngestionInput(
      id = UUID.randomUUID().toString(),
      order = 0,
      declaredMediaType = "image/png",
      openStream = { ZeroThenDataInputStream(image) },
    )

    val result = ShareIngestionWriter.publish(
      filesDir,
      UUID.randomUUID().toString(),
      listOf(input),
    )

    assertEquals("complete", result.status)
    @Suppress("UNCHECKED_CAST")
    val item = (result.manifest["items"] as List<Map<String, Any?>>).single()
    assertEquals(image.size.toLong(), (item["byteCount"] as Number).toLong())
  }

  private fun input(order: Int, mediaType: String, bytes: ByteArray) = ShareIngestionInput(
    id = UUID.randomUUID().toString(),
    order = order,
    declaredMediaType = mediaType,
    openStream = { ByteArrayInputStream(bytes) },
  )

  private fun fixture(name: String): ByteArray =
    InstrumentationRegistry.getInstrumentation().context.assets.open(name).use(InputStream::readBytes)
}

private class RepeatingInputStream(private var remaining: Long) : InputStream() {
  override fun read(): Int = if (remaining-- > 0) 'x'.code else -1

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (remaining <= 0) return -1
    val count = minOf(length.toLong(), remaining).toInt()
    buffer.fill('x'.code.toByte(), offset, offset + count)
    remaining -= count
    return count
  }
}

private class ZeroThenDataInputStream(private val bytes: ByteArray) : InputStream() {
  private var offset = 0
  private var returnedZero = false

  override fun read(): Int = if (offset < bytes.size) bytes[offset++].toInt() and 0xff else -1

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (!returnedZero) {
      returnedZero = true
      return 0
    }
    if (this.offset >= bytes.size) return -1
    val count = minOf(length, bytes.size - this.offset)
    bytes.copyInto(buffer, offset, this.offset, this.offset + count)
    this.offset += count
    return count
  }
}
