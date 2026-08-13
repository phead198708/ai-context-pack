package com.aicontextpack.nativebridge

import java.io.ByteArrayOutputStream
import java.util.zip.CRC32
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class ImagePerceptualHasherTest {
  @Test
  fun snapshotCloseReportsDeletionFailure() {
    val directory = kotlin.io.path.createTempDirectory("image-hash-close-test").toFile()
    val snapshotFile = java.io.File(directory, "snapshot.tmp").apply {
      writeText("synthetic")
    }
    try {
      val error = assertThrows(NativeException::class.java) {
        ImmutableImageSnapshot(snapshotFile) { false }.close()
      }
      assertEquals("RESOURCE_MEMORY_PRESSURE", error.code)
      assertTrue(snapshotFile.exists())
    } finally {
      directory.deleteRecursively()
    }
  }

  @Test
  fun differenceHashUsesCanonicalRowMajorBitOrder() {
    val descending = IntArray(9 * 8) { index -> 9 - index % 9 }
    assertEquals("ffffffffffffffff", ImagePerceptualHasher.differenceHash(descending))
    assertEquals(
      "0000000000000000",
      ImagePerceptualHasher.differenceHash(IntArray(9 * 8) { 7 }),
    )
  }

  @Test
  fun orientationMappingAvoidsASecondFullBitmap() {
    assertEquals(Pair(2, 0), ImagePerceptualHasher.orientedCoordinate(0, 0, 4, 3, 6))
    assertEquals(Pair(0, 3), ImagePerceptualHasher.orientedCoordinate(3, 2, 4, 3, 6))
    assertEquals(Pair(0, 0), ImagePerceptualHasher.orientedCoordinate(0, 0, 4, 3, 5))
  }

  @Test
  fun taskRegistrySerializesIdentityAndCancelsCooperatively() {
    val registry = ImageHashTaskRegistry()
    val taskId = "123e4567-e89b-42d3-a456-426614174000"
    val token = registry.reserve("owner-a", taskId)
    assertNotNull(token)
    assertNull(registry.reserve("owner-b", taskId))
    assertFalse(registry.cancel("owner-b", taskId))
    token!!.throwIfCancelled()
    assertTrue(registry.cancel("owner-a", taskId))
    assertThrows(NativeException::class.java) { token!!.throwIfCancelled() }
    registry.finish("owner-b", taskId, token!!)
    assertNull(registry.reserve("owner-b", taskId))
    registry.finish("owner-a", taskId, token)
    assertNotNull(registry.reserve("owner-b", taskId))
    assertFalse(registry.cancel("owner-a", taskId))
    registry.destroyOwner("owner-b")
    val replacement = registry.reserve("owner-c", taskId)
    assertNotNull(replacement)
    assertFalse(registry.cancel("owner-b", taskId))
    replacement!!.throwIfCancelled()
  }

  @Test
  fun cancellationBeforeWorkAttachmentStillCancelsAndJoins() {
    val registry = ImageHashTaskRegistry()
    val taskId = "223e4567-e89b-42d3-a456-426614174000"
    val token = checkNotNull(registry.reserve("owner-a", taskId))
    assertTrue(registry.cancel("owner-a", taskId))
    var cancelledAndWaited = 0
    registry.attach("owner-a", taskId, token) {
      cancelledAndWaited += 1
      true
    }
    assertEquals(1, cancelledAndWaited)
    assertThrows(NativeException::class.java) { token.throwIfCancelled() }
  }

  @Test
  fun lateAttachmentCannotTakeOverSameOwnerReplacementGeneration() {
    val registry = ImageHashTaskRegistry()
    val taskId = "323e4567-e89b-42d3-a456-426614174000"
    val staleToken = checkNotNull(registry.reserve("owner-a", taskId))
    registry.finish("owner-a", taskId, staleToken)
    val replacement = checkNotNull(registry.reserve("owner-a", taskId))
    var cancelledAndWaited = 0

    registry.attach("owner-a", taskId, staleToken) {
      cancelledAndWaited += 1
      true
    }

    assertEquals(1, cancelledAndWaited)
    replacement.throwIfCancelled()
    assertTrue(registry.cancel("owner-a", taskId))
    assertThrows(NativeException::class.java) { replacement.throwIfCancelled() }
  }

  @Test
  fun animatedWebPHeaderIsRejectedConsistentlyWithIos() {
    val header = ByteArray(32)
    "RIFF".toByteArray().copyInto(header, 0)
    "WEBP".toByteArray().copyInto(header, 8)
    "VP8X".toByteArray().copyInto(header, 12)
    header[20] = 0x02
    assertEquals(true, ImagePerceptualHasher.isAnimatedWebPHeader(header))
    header[20] = 0
    assertEquals(false, ImagePerceptualHasher.isAnimatedWebPHeader(header))
  }

  @Test
  fun animatedPngControlChunkIsRejectedOnLegacyAndroid() {
    val bytes = animationFixtures().getValue("animated-apng")
    assertTrue(ImagePerceptualHasher.isAnimatedPng(bytes))
    val corrupted = bytes.copyOf()
    val animationControlOffset = findPngChunk(corrupted, "acTL")
    corrupted[animationControlOffset + 19] =
      (corrupted[animationControlOffset + 19].toInt() xor 0x01).toByte()
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectPngFrames(corrupted),
    )
  }

  @Test
  fun sharedAnimatedFixturesAreRejectedWithoutApi28ImageDecoder() {
    val values = animationFixtures()
    assertTrue(ImagePerceptualHasher.isAnimatedPng(values.getValue("animated-apng")))
    assertTrue(ImagePerceptualHasher.isAnimatedGif(values.getValue("animated-gif")))
    assertTrue(
      ImagePerceptualHasher.isAnimatedWebPHeader(values.getValue("animated-webp")),
    )
    assertEquals(
      ContainerFrameInspection.ANIMATED,
      ImagePerceptualHasher.inspectWebPFrames(values.getValue("animated-webp")),
    )
  }

  @Test
  fun boundedWebPInspectionIsCooperativelyCancellable() {
    val fixture = paddedStaticWebP(128 * 1_024)
    val token = ImageHashCancellationToken()
    val input = object : java.io.ByteArrayInputStream(fixture) {
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = super.read(buffer, offset, minOf(length, 1_024))
        if (pos > 8 * 1_024) token.cancel()
        return count
      }
    }
    assertThrows(NativeException::class.java) {
      ImagePerceptualHasher.inspectWebPFrames(input, fixture.size.toLong(), token)
    }
  }

  @Test
  fun staticWebPRequiresOneImagePayloadAndExactEof() {
    val fixture = paddedStaticWebP(128)
    assertEquals(
      ContainerFrameInspection.SINGLE,
      ImagePerceptualHasher.inspectWebPFrames(fixture),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectWebPFrames(fixture + byteArrayOf(0)),
    )
  }

  @Test
  fun bmffCollectionsAndSequencesCannotHideBehindTheDecodedPrimaryFrame() {
    assertEquals(
      ContainerFrameInspection.SINGLE,
      ImagePerceptualHasher.inspectBmffFrames(bmffImage(primary = 1, imageItems = listOf(1))),
    )
    assertEquals(
      ContainerFrameInspection.ANIMATED,
      ImagePerceptualHasher.inspectBmffFrames(bmffImage(primary = 1, imageItems = listOf(1, 2))),
    )
    assertEquals(
      ContainerFrameInspection.ANIMATED,
      ImagePerceptualHasher.inspectBmffFrames(bmffFileType("avis")),
    )
  }

  @Test
  fun bmffThumbnailAndGridInputsDoNotBecomeIndependentFrames() {
    assertEquals(
      ContainerFrameInspection.SINGLE,
      ImagePerceptualHasher.inspectBmffFrames(
        bmffImage(
          primary = 1,
          imageItems = listOf(1, 2),
          references = listOf(Triple("thmb", 2, listOf(1))),
        ),
      ),
    )
    assertEquals(
      ContainerFrameInspection.SINGLE,
      ImagePerceptualHasher.inspectBmffFrames(
        bmffImage(
          primary = 1,
          imageItems = listOf(1, 2, 3),
          itemTypes = mapOf(1 to "grid"),
          references = listOf(Triple("dimg", 1, listOf(2, 3))),
        ),
      ),
    )
  }

  @Test
  fun bmffInspectionAllowsBoundedPreludeBoxesButRejectsAmbiguousMetadata() {
    val still = bmffImage(primary = 1, imageItems = listOf(1))
    assertEquals(
      ContainerFrameInspection.SINGLE,
      ImagePerceptualHasher.inspectBmffFrames(bmffBox("free", ByteArray(64)) + still),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectBmffFrames(bmffImage(primary = 1, imageItems = listOf(1, 1))),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectBmffFrames(
        byteArrayOf(0, 0, 0, 4) + "ftyp".toByteArray(Charsets.US_ASCII) + ByteArray(8),
      ),
    )
  }

  @Test
  fun bmffInspectionIsBoundedExactAndCooperativelyCancellable() {
    val fixture = bmffImage(primary = 1, imageItems = listOf(1)) +
      bmffBox("free", ByteArray(128 * 1_024))
    val token = ImageHashCancellationToken()
    val input = object : java.io.ByteArrayInputStream(fixture) {
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val count = super.read(buffer, offset, minOf(length, 1_024))
        if (pos > 8 * 1_024) token.cancel()
        return count
      }
    }
    assertThrows(NativeException::class.java) {
      ImagePerceptualHasher.inspectBmffFrames(input, fixture.size.toLong(), token)
    }
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectBmffFrames(
        bmffImage(primary = 1, imageItems = listOf(1)) + byteArrayOf(0),
      ),
    )
  }

  @Test
  fun structurallyPaddedAnimationContainersCannotBypassLegacyLimits() {
    val values = animationFixtures()
    val paddedPng = insertPrivatePngChunks(
      values.getValue("animated-apng"),
      2_048,
    )
    val paddedGif = insertGifCommentExtensions(
      values.getValue("animated-gif"),
      65_536,
    )

    assertEquals(
      ContainerFrameInspection.ANIMATED,
      ImagePerceptualHasher.inspectPngFrames(paddedPng),
    )
    assertEquals(
      ContainerFrameInspection.ANIMATED,
      ImagePerceptualHasher.inspectGifFrames(paddedGif),
    )
    val corruptedGif = paddedGif.copyOf()
    corruptedGif[gifDataOffset(corruptedGif)] = 0
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectGifFrames(corruptedGif),
    )
  }

  @Test
  fun recognizedContainersRequireExactEofAndCompleteApngControls() {
    val values = animationFixtures()
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectPngFrames(
        values.getValue("animated-apng") + byteArrayOf(0),
      ),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectGifFrames(
        values.getValue("animated-gif") + byteArrayOf(0),
      ),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectWebPFrames(
        values.getValue("animated-webp") + byteArrayOf(0),
      ),
    )
    assertEquals(
      ContainerFrameInspection.INVALID,
      ImagePerceptualHasher.inspectPngFrames(
        replacePngAnimationFrameCount(values.getValue("animated-apng"), 3),
      ),
    )
  }

  @Test
  fun scheduledWorkRemovesQueuedCancellationAndJoinsActiveCancellation() {
    val executor = java.util.concurrent.ThreadPoolExecutor(
      1,
      1,
      0,
      java.util.concurrent.TimeUnit.MILLISECONDS,
      java.util.concurrent.ArrayBlockingQueue(2),
    )
    val activeToken = ImageHashCancellationToken()
    val activeStarted = java.util.concurrent.CountDownLatch(1)
    val first = ImageHashScheduledWork(
      executor,
      activeToken,
      action = {
        activeStarted.countDown()
        while (true) {
          activeToken.throwIfCancelled()
          Thread.sleep(5)
        }
      },
      cancelBeforeStart = {},
      afterFinish = {},
    )
    var queuedCancelled = false
    val queued = ImageHashScheduledWork(
      executor,
      ImageHashCancellationToken(),
      action = { throw AssertionError("cancelled queued work ran") },
      cancelBeforeStart = { queuedCancelled = true },
      afterFinish = {},
    )
    first.schedule()
    assertTrue(activeStarted.await(2, java.util.concurrent.TimeUnit.SECONDS))
    queued.schedule()
    assertTrue(queued.cancelAndWait())
    assertTrue(queuedCancelled)
    assertTrue(first.cancelAndWait())
    executor.shutdown()
    assertTrue(executor.awaitTermination(2, java.util.concurrent.TimeUnit.SECONDS))
  }

  @Test
  fun startupMaintenancePurgesEveryInheritedSnapshotAndPreservesCurrentProcessFiles() {
    val directory = java.io.File(
      System.getProperty("java.io.tmpdir"),
      "image-hash-snapshot-test-${java.util.UUID.randomUUID()}",
    )
    assertTrue(directory.mkdirs())
    try {
      val inherited = java.io.File(directory, "snapshot-inherited.tmp").apply {
        writeText("private synthetic bytes")
      }
      val currentPrefix = "snapshot-currentprocess-"
      val current = java.io.File(directory, "${currentPrefix}active.tmp").apply {
        writeText("active synthetic bytes")
      }
      val unrelated = java.io.File(directory, "unrelated.tmp").apply {
        writeText("unrelated")
      }
      val outside = java.io.File(directory.parentFile, "snapshot-outside-${java.util.UUID.randomUUID()}.tmp").apply {
        writeText("outside synthetic bytes")
      }
      val symlink = java.io.File(directory, "snapshot-inherited-link.tmp")
      java.nio.file.Files.createSymbolicLink(symlink.toPath(), outside.toPath())
      assertEquals(
        1,
        ImageHashSnapshotStore.purgeInherited(directory, currentPrefix),
      )
      assertFalse(inherited.exists())
      assertTrue(current.exists())
      assertTrue(unrelated.exists())
      assertTrue(java.nio.file.Files.isSymbolicLink(symlink.toPath()))
      assertTrue(outside.exists())
      symlink.delete()
      outside.delete()
    } finally {
      directory.deleteRecursively()
    }
  }


  private fun animationFixtures(): Map<String, ByteArray> {
    val lines = checkNotNull(
      javaClass.classLoader?.getResourceAsStream("image-animation-policy-v1.tsv"),
    ).bufferedReader().readLines()
    return lines.associate { line ->
      val (name, encoded) = line.split('\t', limit = 2)
      name to java.util.Base64.getDecoder().decode(encoded)
    }
  }

  private fun paddedStaticWebP(paddingBytes: Int): ByteArray {
    fun littleEndian(value: Int) = byteArrayOf(
      value.toByte(),
      (value ushr 8).toByte(),
      (value ushr 16).toByte(),
      (value ushr 24).toByte(),
    )
    val junk = "JUNK".toByteArray() + littleEndian(paddingBytes) + ByteArray(paddingBytes)
    val image = "VP8 ".toByteArray() + littleEndian(2) + byteArrayOf(0, 0)
    val body = "WEBP".toByteArray() + junk + image
    return "RIFF".toByteArray() + littleEndian(body.size) + body
  }

  private fun bmffImage(
    primary: Int,
    imageItems: List<Int>,
    itemTypes: Map<Int, String> = emptyMap(),
    references: List<Triple<String, Int, List<Int>>> = emptyList(),
  ): ByteArray {
    val primaryItem = bmffBox("pitm", byteArrayOf(0, 0, 0, 0) + unsignedShort(primary))
    val itemEntries = imageItems.map { itemId ->
      bmffBox(
        "infe",
        byteArrayOf(2, 0, 0, 0) + unsignedShort(itemId) + unsignedShort(0) +
          (itemTypes[itemId] ?: "hvc1").toByteArray(Charsets.US_ASCII) + byteArrayOf(0),
      )
    }
    val itemInfo = bmffBox(
      "iinf",
      byteArrayOf(0, 0, 0, 0) + unsignedShort(itemEntries.size) +
        itemEntries.fold(ByteArray(0)) { result, entry -> result + entry },
    )
    val itemReferences = if (references.isEmpty()) {
      ByteArray(0)
    } else {
      bmffBox(
        "iref",
        byteArrayOf(0, 0, 0, 0) + references.map { (type, from, targets) ->
          bmffBox(
            type,
            unsignedShort(from) + unsignedShort(targets.size) +
              targets.fold(ByteArray(0)) { result, target -> result + unsignedShort(target) },
          )
        }.fold(ByteArray(0)) { result, reference -> result + reference },
      )
    }
    return bmffFileType("heic") + bmffBox(
      "meta",
      byteArrayOf(0, 0, 0, 0) + primaryItem + itemInfo + itemReferences,
    )
  }

  private fun bmffFileType(brand: String): ByteArray = bmffBox(
    "ftyp",
    brand.toByteArray(Charsets.US_ASCII) + byteArrayOf(0, 0, 0, 0) +
      "mif1".toByteArray(Charsets.US_ASCII) + brand.toByteArray(Charsets.US_ASCII),
  )

  private fun bmffBox(type: String, payload: ByteArray): ByteArray {
    require(type.length == 4)
    val size = payload.size + 8
    return byteArrayOf(
      (size ushr 24).toByte(),
      (size ushr 16).toByte(),
      (size ushr 8).toByte(),
      size.toByte(),
    ) + type.toByteArray(Charsets.US_ASCII) + payload
  }

  private fun unsignedShort(value: Int): ByteArray = byteArrayOf(
    (value ushr 8).toByte(),
    value.toByte(),
  )

  private fun insertPrivatePngChunks(bytes: ByteArray, count: Int): ByteArray {
    val animationControlOffset = findPngChunk(bytes, "acTL")
    val output = ByteArrayOutputStream(bytes.size + count * 12)
    output.write(bytes, 0, animationControlOffset)
    repeat(count) { output.write(pngChunk("vpAg")) }
    output.write(bytes, animationControlOffset, bytes.size - animationControlOffset)
    return output.toByteArray()
  }

  private fun findPngChunk(bytes: ByteArray, expectedType: String): Int {
    var offset = 8
    while (offset + 12 <= bytes.size) {
      val length = readUnsignedInt(bytes, offset).toInt()
      val type = String(bytes, offset + 4, 4, Charsets.US_ASCII)
      if (type == expectedType) return offset
      offset += 12 + length
    }
    throw AssertionError("missing PNG chunk")
  }

  private fun pngChunk(typeName: String): ByteArray {
    val type = typeName.toByteArray(Charsets.US_ASCII)
    val crc = CRC32().apply { update(type) }.value
    return byteArrayOf(0, 0, 0, 0) + type + byteArrayOf(
      (crc ushr 24).toByte(),
      (crc ushr 16).toByte(),
      (crc ushr 8).toByte(),
      crc.toByte(),
    )
  }

  private fun replacePngAnimationFrameCount(bytes: ByteArray, frameCount: Int): ByteArray {
    val result = bytes.copyOf()
    val offset = findPngChunk(result, "acTL")
    result[offset + 8] = (frameCount ushr 24).toByte()
    result[offset + 9] = (frameCount ushr 16).toByte()
    result[offset + 10] = (frameCount ushr 8).toByte()
    result[offset + 11] = frameCount.toByte()
    val crc = CRC32().apply { update(result, offset + 4, 12) }.value
    result[offset + 16] = (crc ushr 24).toByte()
    result[offset + 17] = (crc ushr 16).toByte()
    result[offset + 18] = (crc ushr 8).toByte()
    result[offset + 19] = crc.toByte()
    return result
  }

  private fun insertGifCommentExtensions(bytes: ByteArray, count: Int): ByteArray {
    val insertionOffset = gifDataOffset(bytes)
    val output = ByteArrayOutputStream(bytes.size + count * 3)
    output.write(bytes, 0, insertionOffset)
    repeat(count) { output.write(byteArrayOf(0x21, 0xfe.toByte(), 0x00)) }
    output.write(bytes, insertionOffset, bytes.size - insertionOffset)
    return output.toByteArray()
  }

  private fun gifDataOffset(bytes: ByteArray): Int {
    val packed = bytes[10].toInt() and 0xff
    val globalColorTableBytes = if ((packed and 0x80) == 0) {
      0
    } else {
      3 * (1 shl ((packed and 0x07) + 1))
    }
    return 13 + globalColorTableBytes
  }

  private fun readUnsignedInt(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset].toLong() and 0xffL) shl 24) or
      ((bytes[offset + 1].toLong() and 0xffL) shl 16) or
      ((bytes[offset + 2].toLong() and 0xffL) shl 8) or
      (bytes[offset + 3].toLong() and 0xffL)
}
