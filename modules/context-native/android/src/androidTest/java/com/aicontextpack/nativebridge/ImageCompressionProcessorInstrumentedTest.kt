package com.aicontextpack.nativebridge

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Debug
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

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
    assertFalse(directory.listFiles().orEmpty().any { it.name.contains(taskId) })
  }

  @Test
  fun startupMaintenancePurgesInheritedFilesButPreservesCurrentTasks() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val taskId = UUID.randomUUID().toString()
    val paths = ImageCompressionTemporaryStore.prepare(context, taskId)
    paths.partial.writeBytes(byteArrayOf(1))
    paths.complete.writeBytes(byteArrayOf(2))
    ImageCompressionTemporaryStore.register(taskId, paths.complete)
    val inherited = File(paths.partial.parentFile, "inherited-${UUID.randomUUID()}.tmp")
    inherited.writeBytes(byteArrayOf(3))

    ImageCompressionTemporaryStore.startupMaintenance(context)

    assertTrue(paths.partial.exists())
    assertTrue(paths.complete.exists())
    assertFalse(inherited.exists())
    ImageCompressionTemporaryStore.removeUnregistered(listOf(paths.partial))
    assertTrue(ImageCompressionTemporaryStore.finish(taskId))
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
      var outputBytes = 0L
      val sampler = ProcessPeakMemorySampler(::processPssBytes)
      sampler.start()
      var peakBytes = 0L
      try {
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
          assertTrue(ImageCompressionTemporaryStore.finish(taskId))
        }
      } finally {
        peakBytes = sampler.stop()
      }
      val durationMs = (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000
      assertTrue(durationMs >= 0)
      assertTrue(peakBytes > 0)
      assertTrue(outputBytes > 0)
      println(
        "IMAGE_COMPRESSION_BENCHMARK platform=android images=$count " +
          "inputBytes=${source.length() * count} outputBytes=$outputBytes " +
          "durationMs=$durationMs sampledPeakPssBytes=$peakBytes",
      )
    }
  }

  @Test
  fun peakMemorySamplerCapturesAnInFlightHighWaterMark() {
    val current = AtomicLong(100)
    val highSampled = CountDownLatch(1)
    val sampler = ProcessPeakMemorySampler(
      readBytes = {
        current.get().also { if (it == 900L) highSampled.countDown() }
      },
      intervalMillis = 1,
    )
    sampler.start()
    current.set(900)
    assertTrue(highSampled.await(2, TimeUnit.SECONDS))
    current.set(200)

    assertEquals(900L, sampler.stop())
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

  private fun processPssBytes(): Long {
    val memory = Debug.MemoryInfo()
    Debug.getMemoryInfo(memory)
    return memory.totalPss.toLong() * 1_024
  }

  private class ProcessPeakMemorySampler(
    private val readBytes: () -> Long,
    private val intervalMillis: Long = 2,
  ) {
    private val running = AtomicBoolean(false)
    private val peak = AtomicLong(0)
    private lateinit var worker: Thread

    fun start() {
      check(running.compareAndSet(false, true))
      sample()
      worker = Thread(
        {
          while (running.get()) {
            sample()
            try {
              Thread.sleep(intervalMillis)
            } catch (_: InterruptedException) {
              Thread.currentThread().interrupt()
              break
            }
          }
        },
        "image-compression-memory-sampler",
      ).apply {
        isDaemon = true
        start()
      }
    }

    fun stop(): Long {
      if (!running.getAndSet(false)) return peak.get()
      worker.join(5_000)
      sample()
      return peak.get()
    }

    private fun sample() {
      val value = readBytes()
      peak.getAndUpdate { current -> maxOf(current, value) }
    }
  }
}
