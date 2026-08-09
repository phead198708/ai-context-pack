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

  private fun assertCode(expected: String, action: () -> Unit) {
    try {
      action()
      fail("expected stable OCR error")
    } catch (error: NativeException) {
      assertEquals(expected, error.code)
    }
  }
}
