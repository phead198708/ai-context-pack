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


  private fun animationFixtures(): Map<String, ByteArray> {
    val lines = checkNotNull(
      javaClass.classLoader?.getResourceAsStream("image-animation-policy-v1.tsv"),
    ).bufferedReader().readLines()
    return lines.associate { line ->
      val (name, encoded) = line.split('\t', limit = 2)
      name to java.util.Base64.getDecoder().decode(encoded)
    }
  }

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
