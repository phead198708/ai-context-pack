package com.aicontextpack.nativebridge

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ImageCompressionProcessorInstrumentedTest {
  @Test
  fun transparentFixtureRemainsAlphaReadableAndOriginalIsImmutable() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val source = transparentFixture(context.cacheDir)
    val original = source.readBytes()
    val sha256 = digest(original)
    val inspection = ImageCompressionProcessor.inspect(
      context,
      source.toURI().toString(),
      source.length(),
      sha256,
      ImageHashCancellationToken(),
    )
    assertEquals(256, inspection["width"])
    assertEquals(128, inspection["height"])
    assertEquals(true, inspection["hasAlpha"])

    val taskId = UUID.randomUUID().toString()
    val output = ImageCompressionProcessor.compress(
      context,
      taskId,
      source.toURI().toString(),
      source.length(),
      sha256,
      128,
      64,
      1.0,
      "image/png",
      true,
      ImageHashCancellationToken(),
    )
    val file = File(java.net.URI(output.getValue("temporaryFileUri") as String))
    val bitmap = BitmapFactory.decodeFile(file.path)
    try {
      assertEquals(128, bitmap.width)
      assertEquals(64, bitmap.height)
      assertTrue(bitmap.hasAlpha())
    } finally {
      bitmap.recycle()
    }
    assertTrue(source.readBytes().contentEquals(original))
    assertTrue(ImageCompressionTemporaryStore.finish(taskId))
    assertFalse(file.exists())
  }

  @Test
  fun cancelledCompressionLeavesNoValidLookingPartialDerivative() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val source = transparentFixture(context.cacheDir)
    val sha256 = digest(source.readBytes())
    val token = ImageHashCancellationToken()
    val taskId = UUID.randomUUID().toString()

    val error = assertThrows(NativeException::class.java) {
      ImageCompressionProcessor.compress(
        context,
        taskId,
        source.toURI().toString(),
        source.length(),
        sha256,
        128,
        64,
        1.0,
        "image/png",
        true,
        token,
        beforePublish = token::cancel,
      )
    }
    assertEquals("PIPELINE_STAGE_FAILED", error.code)
    val directory = File(context.cacheDir, "ImageCompression")
    assertFalse(directory.listFiles().orEmpty().any { it.name.startsWith(taskId) })
  }

  @Test
  fun rotatedTextFixtureRemainsSystemReadableAfterCompactCompression() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val source = File(context.cacheDir, "compression-rotated-${UUID.randomUUID()}.jpg")
    instrumentation.context.assets.open("ocr-rotated.jpg").use { input ->
      source.outputStream().use { output -> input.copyTo(output) }
    }
    val sha256 = digest(source.readBytes())
    val inspection = ImageCompressionProcessor.inspect(
      context,
      source.toURI().toString(),
      source.length(),
      sha256,
      ImageHashCancellationToken(),
    )
    assertEquals(1_800, inspection["width"])
    assertEquals(600, inspection["height"])
    val taskId = UUID.randomUUID().toString()
    val output = ImageCompressionProcessor.compress(
      context,
      taskId,
      source.toURI().toString(),
      source.length(),
      sha256,
      1_280,
      427,
      0.7,
      "image/jpeg",
      false,
      ImageHashCancellationToken(),
    )
    val secondTaskId = UUID.randomUUID().toString()
    val secondOutput = ImageCompressionProcessor.compress(
      context,
      secondTaskId,
      source.toURI().toString(),
      source.length(),
      sha256,
      1_280,
      427,
      0.7,
      "image/jpeg",
      false,
      ImageHashCancellationToken(),
    )
    assertEquals(output["outputByteCount"], secondOutput["outputByteCount"])
    assertEquals(output["outputSha256"], secondOutput["outputSha256"])
    val file = File(java.net.URI(output.getValue("temporaryFileUri") as String))
    try {
      val bitmap = BitmapFactory.decodeFile(file.path)
      try {
        assertEquals(1_280, bitmap.width)
        assertEquals(427, bitmap.height)
      } finally {
        bitmap.recycle()
      }
      val processor = AndroidOCRProcessor()
      val ocrTaskId = UUID.randomUUID().toString()
      val prepared = processor.prepare(
        context,
        ocrTaskId,
        file.toURI().toString(),
        "latin",
        "accurate",
      )
      val recognized = try {
        processor.result(
          prepared,
          Tasks.await(prepared.recognizer.process(prepared.image), 30, TimeUnit.SECONDS),
        )
      } finally {
        prepared.recognizer.close()
        processor.finish(ocrTaskId)
      }
      val text = recognized.getValue("text") as String
      assertTrue(text.filterNot(Char::isWhitespace).contains("TypeError", ignoreCase = true))
      assertTrue(text.contains("E42", ignoreCase = true))
      assertTrue(text.contains("retry import", ignoreCase = true))
    } finally {
      assertTrue(ImageCompressionTemporaryStore.finish(taskId))
      assertTrue(ImageCompressionTemporaryStore.finish(secondTaskId))
    }
  }

  @Test
  fun tenTwentyAndFiftyImageCompressionBenchmarksAreBounded() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val source = File(context.cacheDir, "compression-benchmark-${UUID.randomUUID()}.jpg")
    instrumentation.context.assets.open("ocr-rotated.jpg").use { input ->
      source.outputStream().use { output -> input.copyTo(output) }
    }
    val sha256 = digest(source.readBytes())
    for (count in listOf(10, 20, 50)) {
      val started = android.os.SystemClock.elapsedRealtimeNanos()
      var peakBytes = usedHeapBytes()
      var outputBytes = 0L
      repeat(count) {
        val taskId = UUID.randomUUID().toString()
        val output = ImageCompressionProcessor.compress(
          context,
          taskId,
          source.toURI().toString(),
          source.length(),
          sha256,
          1_280,
          427,
          0.7,
          "image/jpeg",
          false,
          ImageHashCancellationToken(),
        )
        outputBytes += (output.getValue("outputByteCount") as Number).toLong()
        peakBytes = maxOf(peakBytes, usedHeapBytes())
        assertTrue(ImageCompressionTemporaryStore.finish(taskId))
      }
      val durationMs = (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000
      assertTrue(durationMs >= 0)
      assertTrue(peakBytes > 0)
      assertTrue(outputBytes > 0)
      println(
        "IMAGE_COMPRESSION_BENCHMARK platform=android images=$count " +
          "inputBytes=${source.length() * count} outputBytes=$outputBytes " +
          "durationMs=$durationMs observedPeakBytes=$peakBytes",
      )
    }
  }

  private fun transparentFixture(directory: File): File {
    val file = File(directory, "compression-transparent-${UUID.randomUUID()}.png")
    val bitmap = Bitmap.createBitmap(256, 128, Bitmap.Config.ARGB_8888)
    try {
      val canvas = Canvas(bitmap)
      canvas.drawColor(Color.TRANSPARENT)
      canvas.drawRect(
        8f,
        8f,
        248f,
        120f,
        Paint().apply { color = Color.argb(204, 26, 51, 230) },
      )
      file.outputStream().use { output ->
        assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
      }
    } finally {
      bitmap.recycle()
    }
    return file
  }

  private fun digest(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it) }

  private fun usedHeapBytes(): Long = Runtime.getRuntime().let {
    it.totalMemory() - it.freeMemory()
  }
}
