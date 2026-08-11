package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
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
}
