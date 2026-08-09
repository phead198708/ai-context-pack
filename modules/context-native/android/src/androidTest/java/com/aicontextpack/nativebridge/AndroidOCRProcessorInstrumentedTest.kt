package com.aicontextpack.nativebridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class AndroidOCRProcessorInstrumentedTest {
  private val firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private val secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  @Test
  fun bundledRecognizersMeetEnglishChineseAndBoundsAcceptance() {
    val processor = AndroidOCRProcessor()
    val english = recognize(processor, firstTaskId, "ocr-english.png", "latin")
    val compactEnglish = text(english).filterNot(Char::isWhitespace)
    assertTrue(compactEnglish.contains("TypeError", ignoreCase = true))
    assertTrue(compactEnglish.contains("E42", ignoreCase = true))
    assertTrue(text(english).contains("retry import", ignoreCase = true))
    assertValidBounds(english)
    assertFixtureTextRegionMapsToPreview(english)

    val chinese = recognize(processor, secondTaskId, "ocr-chinese.png", "chinese")
    val compactChinese = text(chinese).filterNot(Char::isWhitespace)
    assertTrue(compactChinese.contains("合成测试"))
    assertTrue(compactChinese.contains("重新导入"))
    assertValidBounds(chinese)
    assertFixtureTextRegionMapsToPreview(chinese)

    val capabilities = processor.capabilities(targetContext())
    @Suppress("UNCHECKED_CAST")
    val engines = capabilities.getValue("engines") as List<Map<String, Any>>
    assertEquals(setOf("ml-kit-latin", "ml-kit-chinese"), engines.map { it["engine"] }.toSet())
    assertTrue(engines.all { it["ready"] == true && it["offline"] == true })
  }

  @Test
  fun honorsEXIFRotationAndCancellationWithoutLeakingRecognitionResult() {
    val processor = AndroidOCRProcessor()
    val rotated = recognize(processor, firstTaskId, "ocr-rotated.jpg", "latin")
    assertTrue(
      text(rotated).filterNot(Char::isWhitespace).contains("TypeError", ignoreCase = true),
    )
    assertValidBounds(rotated)
    assertFixtureTextRegionMapsToPreview(rotated)

    val task = processor.prepare(
      targetContext(),
      secondTaskId,
      fixtureFile("ocr-english.png").toURI().toString(),
      "latin",
      "accurate",
    )
    try {
      assertTrue(processor.cancel(secondTaskId))
      val recognized = Tasks.await(task.recognizer.process(task.image), 30, TimeUnit.SECONDS)
      assertCode("OCR_CANCELLED") { processor.result(task, recognized) }
    } finally {
      task.recognizer.close()
      processor.finish(secondTaskId)
    }
  }

  @Test
  fun corruptFixtureFailsWithStableDecodeCode() {
    assertCode("OCR_IMAGE_DECODE_FAILED") {
      AndroidOCRProcessor().prepare(
        targetContext(),
        firstTaskId,
        fixtureFile("ocr-corrupt.png").toURI().toString(),
        "latin",
        "accurate",
      )
    }
  }

  private fun recognize(
    processor: AndroidOCRProcessor,
    taskId: String,
    fixture: String,
    script: String,
  ): Map<String, Any> {
    val task = processor.prepare(
      targetContext(), taskId, fixtureFile(fixture).toURI().toString(), script, "accurate",
    )
    return try {
      val recognized = Tasks.await(task.recognizer.process(task.image), 30, TimeUnit.SECONDS)
      processor.result(task, recognized)
    } finally {
      task.recognizer.close()
      processor.finish(taskId)
    }
  }

  private fun fixtureFile(name: String): File {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val file = File(instrumentation.targetContext.cacheDir, "ocr-fixture-$name")
    instrumentation.context.assets.open(name).use { input ->
      file.outputStream().use { output -> input.copyTo(output) }
    }
    return file
  }

  private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun text(result: Map<String, Any>): String = result.getValue("text") as String

  private fun assertValidBounds(result: Map<String, Any>) {
    @Suppress("UNCHECKED_CAST")
    val blocks = result.getValue("blocks") as List<Map<String, Any>>
    assertFalse(blocks.isEmpty())
    var previousY = -1.0
    var previousX = -1.0
    blocks.forEach { block ->
      @Suppress("UNCHECKED_CAST")
      val bounds = block.getValue("bounds") as Map<String, Double>
      val x = bounds.getValue("x")
      val y = bounds.getValue("y")
      val width = bounds.getValue("width")
      val height = bounds.getValue("height")
      assertTrue(x >= 0 && y >= 0 && x + width <= 1.000_001 && y + height <= 1.000_001)
      if (kotlin.math.abs(y - previousY) > 0.01) assertTrue(y >= previousY)
      else assertTrue(x >= previousX)
      previousY = y
      previousX = x
      assertNotNull(block["text"])
    }
  }

  private fun assertFixtureTextRegionMapsToPreview(result: Map<String, Any>) {
    @Suppress("UNCHECKED_CAST")
    val blocks = result.getValue("blocks") as List<Map<String, Any>>
    @Suppress("UNCHECKED_CAST")
    val bounds = blocks.first().getValue("bounds") as Map<String, Double>
    assertTrue(bounds.getValue("x") < 0.2)
    assertTrue(bounds.getValue("y") < 0.7)
    assertTrue(bounds.getValue("width") > 0.2)
    assertTrue(bounds.getValue("height") > 0.05)
  }

  private fun assertCode(expected: String, action: () -> Unit) {
    try {
      action()
      fail("expected stable OCR error")
    } catch (error: NativeException) {
      assertEquals(expected, error.code)
    }
  }
}
