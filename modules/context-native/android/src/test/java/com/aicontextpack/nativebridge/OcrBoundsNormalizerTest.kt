package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Test

class OcrBoundsNormalizerTest {
  @Test
  fun normalizesAgainstSourceImageDimensions() {
    val bounds = OcrBoundsNormalizer.normalize(
      left = 100,
      top = 200,
      boxWidth = 300,
      boxHeight = 100,
      sourceWidth = 1000,
      sourceHeight = 800,
    )

    assertEquals(0.1, bounds.getValue("x"), 0.0001)
    assertEquals(0.25, bounds.getValue("y"), 0.0001)
    assertEquals(0.3, bounds.getValue("width"), 0.0001)
    assertEquals(0.125, bounds.getValue("height"), 0.0001)
  }

  @Test
  fun clipsBoxesToSourceImageEdges() {
    val bounds = OcrBoundsNormalizer.normalize(900, -20, 300, 100, 1000, 800)

    assertEquals(0.9, bounds.getValue("x"), 0.0001)
    assertEquals(0.0, bounds.getValue("y"), 0.0001)
    assertEquals(0.1, bounds.getValue("width"), 0.0001)
    assertEquals(0.1, bounds.getValue("height"), 0.0001)
  }
}
