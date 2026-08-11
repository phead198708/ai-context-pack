package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
    registry.cancel(taskId)
    assertThrows(NativeException::class.java) { token!!.throwIfCancelled() }
    registry.finish("owner-b", taskId, token!!)
    assertNull(registry.reserve("owner-b", taskId))
    registry.finish("owner-a", taskId, token)
    assertNotNull(registry.reserve("owner-b", taskId))
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
}
