package com.aicontextpack.nativebridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.CRC32

@RunWith(AndroidJUnit4::class)
class ImagePerceptualHasherInstrumentedTest {
  @Test
  fun syntheticMediaHashesMatchTheCrossPlatformGolden() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    for (name in listOf("ocr-english.png", "ocr-rotated.jpg")) {
      val file = File(context.cacheDir, "image-hash-$name")
      InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
      }
      val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
        .joinToString("") { "%02x".format(it) }
      val value = ImagePerceptualHasher.hash(
        context,
        file.toURI().toString(),
        file.length(),
        digest,
      )
      val hash = value.getValue("hash") as String
      assertEquals("000000a810000000", hash)
    }
  }

  @Test
  fun immutableSnapshotSurvivesAtomicPathSwapBack() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "image-hash-swap.png")
    val original = InstrumentationRegistry.getInstrumentation().context.assets
      .open("ocr-english.png").use { it.readBytes() }
    file.writeBytes(original)
    val digest = MessageDigest.getInstance("SHA-256").digest(original)
      .joinToString("") { "%02x".format(it) }
    val value = ImagePerceptualHasher.hash(
      context,
      file.toURI().toString(),
      original.size.toLong(),
      digest,
      sourceMutationHook = { phase ->
        if (phase == "snapshot-ready") {
          val replacement = File(context.cacheDir, "image-hash-replacement")
          replacement.writeText("replacement")
          android.system.Os.rename(replacement.path, file.path)
        } else if (phase == "decode-complete") {
          val restored = File(context.cacheDir, "image-hash-restored")
          restored.writeBytes(original)
          android.system.Os.rename(restored.path, file.path)
        }
      },
    )
    assertEquals("000000a810000000", value["hash"] as String)
    assertEquals(true, file.readBytes().contentEquals(original))
  }

  @Test
  fun fullBitmapDecodeObservesStreamCancellation() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "image-hash-cancel.png")
    val original = InstrumentationRegistry.getInstrumentation().context.assets
      .open("ocr-english.png").use { it.readBytes() }
    val bytes = insertStaticPngPadding(original, 512 * 1_024)
    file.writeBytes(bytes)
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it) }
    val cancellation = ImageHashCancellationToken()
    var observedDecodeBytes = 0L

    val error = org.junit.Assert.assertThrows(NativeException::class.java) {
      ImagePerceptualHasher.hash(
        context,
        file.toURI().toString(),
        bytes.size.toLong(),
        digest,
        cancellation,
        fullDecodeReadHook = { count ->
          observedDecodeBytes += count
        },
        regionDecodedHook = { cancellation.cancel() },
        maximumRegionPixels = 1_024,
      )
    }

    assertEquals("PIPELINE_STAGE_FAILED", error.code)
    org.junit.Assert.assertTrue(observedDecodeBytes > 0)
  }

  @Test
  fun forcedRegionBoundariesPreserveTheCrossPlatformGolden() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    for (name in listOf("ocr-english.png", "ocr-rotated.jpg")) {
      val file = File(context.cacheDir, "image-hash-region-$name")
      val bytes = InstrumentationRegistry.getInstrumentation().context.assets
        .open(name).use { it.readBytes() }
      file.writeBytes(bytes)
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
      var decodedRegions = 0

      val value = ImagePerceptualHasher.hash(
        context,
        file.toURI().toString(),
        bytes.size.toLong(),
        digest,
        regionDecodedHook = { decodedRegions += 1 },
        maximumRegionPixels = 1_024,
      )

      assertEquals("000000a810000000", value["hash"] as String)
      org.junit.Assert.assertTrue(decodedRegions > 1)
    }
  }

  @Test
  fun sharedAnimatedFixturesFailTheSameSingleFramePolicy() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val lines = InstrumentationRegistry.getInstrumentation().context.assets
      .open("image-animation-policy-v1.tsv").bufferedReader().readLines()
    for (line in lines) {
      val (name, encoded) = line.split('\t', limit = 2)
      val bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
      val file = File(context.cacheDir, "$name.bin")
      file.writeBytes(bytes)
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
      val error = org.junit.Assert.assertThrows(NativeException::class.java) {
        ImagePerceptualHasher.hash(context, file.toURI().toString(), file.length(), digest)
      }
      assertEquals("PROCESSOR_OUTPUT_INVALID", error.code)
    }
  }

  @Test
  fun structurallyPaddedApngAndGifFailClosedOnDevice() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val fixtures = InstrumentationRegistry.getInstrumentation().context.assets
      .open("image-animation-policy-v1.tsv").bufferedReader().readLines()
      .associate { line ->
        val (name, encoded) = line.split('\t', limit = 2)
        name to android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
      }
    val padded = listOf(
      "padded-apng" to insertPrivatePngChunks(
        fixtures.getValue("animated-apng"),
        2_048,
      ),
      "padded-gif" to insertGifCommentExtensions(
        fixtures.getValue("animated-gif"),
        65_536,
      ),
      "suffixed-apng" to (fixtures.getValue("animated-apng") + byteArrayOf(0)),
      "suffixed-gif" to (fixtures.getValue("animated-gif") + byteArrayOf(0)),
      "mismatched-apng" to replacePngAnimationFrameCount(
        fixtures.getValue("animated-apng"),
        3,
      ),
    )
    for ((name, bytes) in padded) {
      val file = File(context.cacheDir, "$name.bin")
      file.writeBytes(bytes)
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
      val error = org.junit.Assert.assertThrows(NativeException::class.java) {
        ImagePerceptualHasher.hash(context, file.toURI().toString(), file.length(), digest)
      }
      assertEquals("PROCESSOR_OUTPUT_INVALID", error.code)
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

  private fun insertStaticPngPadding(bytes: ByteArray, paddingBytes: Int): ByteArray {
    val imageDataOffset = findPngChunk(bytes, "IDAT")
    val padding = pngChunk("vpAg", ByteArray(paddingBytes))
    val output = ByteArrayOutputStream(bytes.size + padding.size)
    output.write(bytes, 0, imageDataOffset)
    output.write(padding)
    output.write(bytes, imageDataOffset, bytes.size - imageDataOffset)
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

  private fun pngChunk(typeName: String, payload: ByteArray = ByteArray(0)): ByteArray {
    val type = typeName.toByteArray(Charsets.US_ASCII)
    val crc = CRC32().apply {
      update(type)
      update(payload)
    }.value
    val length = payload.size
    return byteArrayOf(
      (length ushr 24).toByte(),
      (length ushr 16).toByte(),
      (length ushr 8).toByte(),
      length.toByte(),
    ) + type + payload + byteArrayOf(
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
    val packed = bytes[10].toInt() and 0xff
    val globalColorTableBytes = if ((packed and 0x80) == 0) {
      0
    } else {
      3 * (1 shl ((packed and 0x07) + 1))
    }
    val insertionOffset = 13 + globalColorTableBytes
    val output = ByteArrayOutputStream(bytes.size + count * 3)
    output.write(bytes, 0, insertionOffset)
    repeat(count) { output.write(byteArrayOf(0x21, 0xfe.toByte(), 0x00)) }
    output.write(bytes, insertionOffset, bytes.size - insertionOffset)
    return output.toByteArray()
  }

  private fun readUnsignedInt(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset].toLong() and 0xffL) shl 24) or
      ((bytes[offset + 1].toLong() and 0xffL) shl 16) or
      ((bytes[offset + 2].toLong() and 0xffL) shl 8) or
      (bytes[offset + 3].toLong() and 0xffL)
}
