package com.aicontextpack.nativebridge

import android.content.ComponentCallbacks2
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AndroidOCRProcessorTest {
  private val firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private val secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  @Test
  fun resourcePolicyRejectsCorruptAndOversizeMetadata() {
    assertCode("OCR_IMAGE_DECODE_FAILED") {
      AndroidOCRResourcePolicy.validate(0, 600, 1, 40_000_000)
    }
    assertCode("OCR_IMAGE_TOO_LARGE") {
      AndroidOCRResourcePolicy.validate(12_001, 1, 1, 40_000_000)
    }
    assertCode("OCR_IMAGE_TOO_LARGE") {
      AndroidOCRResourcePolicy.validate(6_000, 6_000, 1, 20_000_000)
    }
  }

  @Test
  fun registryBoundsConcurrencyCancellationAndMemoryPressure() {
    val registry = OcrTaskRegistry()
    registry.begin(firstTaskId)
    assertCode("OCR_RESOURCE_BUSY") { registry.begin(secondTaskId) }
    assertTrue(registry.cancel(firstTaskId))
    assertEquals("OCR_CANCELLED", registry.failureCode(firstTaskId))
    registry.finish(firstTaskId)
    assertNull(registry.failureCode(firstTaskId))

    registry.setMemoryPressure(true)
    assertCode("RESOURCE_MEMORY_PRESSURE") { registry.begin(secondTaskId) }
    registry.begin(secondTaskId)
    registry.setMemoryPressure(true)
    assertEquals("RESOURCE_MEMORY_PRESSURE", registry.failureCode(secondTaskId))
    registry.finish(secondTaskId)
  }

  @Test
  fun trimPolicyDoesNotTreatNormalBackgroundingAsMemoryPressure() {
    assertTrue(isMemoryPressureTrimLevel(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW))
    assertTrue(isMemoryPressureTrimLevel(ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL))
    assertTrue(isMemoryPressureTrimLevel(ComponentCallbacks2.TRIM_MEMORY_MODERATE))
    assertEquals(false, isMemoryPressureTrimLevel(ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN))
    assertEquals(false, isMemoryPressureTrimLevel(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND))
  }

  @Test
  fun nonemptyBlockWithoutBoundsFailsClosed() {
    assertCode("OCR_RESULT_INVALID") {
      buildOCRBlocks(
        inputs = listOf(
          OCRRecognizedBlockInput(
            text = "recognized-content",
            bounds = null,
            confidences = listOf(0.9),
            language = "en",
          ),
        ),
        outputWidth = 1_000,
        outputHeight = 1_000,
      )
    }
  }

  @Test
  fun denseReadingOrderIsDeterministicAcrossInputPermutations() {
    val blocks = listOf(
      block("A", left = 100, top = 18),
      block("B", left = 200, top = 9),
      block("C", left = 300, top = 0),
    )
    val orders = listOf(
      blocks,
      blocks.reversed(),
      listOf(blocks[1], blocks[2], blocks[0]),
      listOf(blocks[2], blocks[0], blocks[1]),
    ).map { permutation ->
      buildOCRBlocks(permutation, outputWidth = 1_000, outputHeight = 1_000)
        .map { it.getValue("text") as String }
    }
    assertTrue(orders.all { it == listOf("B", "C", "A") })
  }

  @Test
  fun readingOrderUsesUtf16CodeUnitsForCanonicalUnicodeParity() {
    val composed = block("\u00e9", left = 100, top = 100)
    val decomposed = block("e\u0301", left = 100, top = 100)
    val orders = listOf(
      listOf(composed, decomposed),
      listOf(decomposed, composed),
    ).map { permutation ->
      buildOCRBlocks(permutation, outputWidth = 1_000, outputHeight = 1_000)
        .map { it.getValue("text") as String }
    }
    assertTrue(orders.all { it == listOf("e\u0301", "\u00e9") })
  }

  @Test
  fun aggregateTextLimitFailsBeforeJoiningBlocks() {
    assertEquals(
      AndroidOCRResourcePolicy.maximumTextLength,
      advanceOCRAggregateTextLength(
        currentLength = AndroidOCRResourcePolicy.maximumTextLength - 1,
        nextTextLength = 1,
        hasPreviousBlock = false,
      ),
    )
    assertCode("OCR_RESULT_INVALID") {
      advanceOCRAggregateTextLength(
        currentLength = AndroidOCRResourcePolicy.maximumTextLength,
        nextTextLength = 1,
        hasPreviousBlock = true,
      )
    }
  }

  @Test
  fun destroySuppressesDeliveryAndSharedRegistryBlocksReplacementUntilCompletion() {
    val registry = OcrTaskRegistry()
    registry.begin(firstTaskId)
    var closed = 0
    var rejected = 0
    var delivered = 0
    val lifecycle = OcrModuleLifecycle()
    assertTrue(
      lifecycle.register(
        OcrLifecycleRegistration(
          taskId = firstTaskId,
          close = { closed += 1 },
          rejectOnDestroy = { rejected += 1 },
        ),
      ),
    )

    val destruction = lifecycle.destroy()!!
    registry.cancel(destruction.taskId)
    destruction.close()
    destruction.reject?.invoke()
    assertEquals(1, closed)
    assertEquals(1, rejected)
    assertEquals(false, lifecycle.deliver(firstTaskId) { delivered += 1 })
    assertEquals(0, delivered)
    assertCode("OCR_RESOURCE_BUSY") { registry.begin(secondTaskId) }

    lifecycle.finish(firstTaskId)
    registry.finish(firstTaskId)
    registry.begin(secondTaskId)
    registry.finish(secondTaskId)
  }

  @Test
  fun resultTransformationExecutorIsSingleThreadedAndBounded() {
    assertEquals(1, AndroidOCRProcessScope.resultExecutor.corePoolSize)
    assertEquals(1, AndroidOCRProcessScope.resultExecutor.maximumPoolSize)
    assertEquals(4, AndroidOCRProcessScope.resultExecutor.queue.remainingCapacity())
  }

  @Test
  fun recognitionStartOomClosesAndReleasesTheTaskForRetry() {
    val registry = OcrTaskRegistry()
    val lifecycle = OcrModuleLifecycle()
    var closed = 0
    var rejection: String? = null
    registry.begin(firstTaskId)
    assertTrue(
      lifecycle.register(
        OcrLifecycleRegistration(
          taskId = firstTaskId,
          close = { closed += 1 },
          rejectOnDestroy = { rejection = "OCR_CANCELLED" },
        ),
      ),
    )

    settleOCRRecognitionStartFailure(
      OutOfMemoryError("synthetic"),
      firstTaskId,
      closeRecognizer = { closed += 1 },
      lifecycle = lifecycle,
      finishProcessor = registry::finish,
      reject = { rejection = it.code },
    )

    assertEquals(1, closed)
    assertEquals("RESOURCE_MEMORY_PRESSURE", rejection)
    assertTrue(
      lifecycle.register(
        OcrLifecycleRegistration(
          taskId = secondTaskId,
          close = {},
          rejectOnDestroy = {},
        ),
      ),
    )
    registry.begin(secondTaskId)
    registry.finish(secondTaskId)
  }

  private fun block(text: String, left: Int, top: Int): OCRRecognizedBlockInput =
    OCRRecognizedBlockInput(
      text = text,
      bounds = OCRPixelBounds(left = left, top = top, width = 50, height = 20),
      confidences = emptyList(),
      language = null,
    )

  private fun assertCode(expected: String, action: () -> Unit) {
    try {
      action()
      fail("expected stable OCR error")
    } catch (error: NativeException) {
      assertEquals(expected, error.code)
    }
  }
}
