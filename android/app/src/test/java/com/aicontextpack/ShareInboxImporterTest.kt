package com.aicontextpack

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class ShareInboxImporterTest {
  @Test
  fun preservesConcreteProviderMediaType() {
    assertEquals("image/jpeg", ShareInboxImporter.concreteOrFallback("image/jpeg"))
  }

  @Test
  fun normalizesConcreteProviderMediaType() {
    assertEquals("image/png", ShareInboxImporter.concreteOrFallback(" IMAGE/PNG "))
  }

  @Test
  fun wildcardAndParameterizedTypesUsePrivacySafeFallback() {
    assertEquals("application/octet-stream", ShareInboxImporter.concreteOrFallback("image/*"))
    assertEquals("image/jpeg", ShareInboxImporter.concreteOrFallback("image/jpeg; charset=binary"))
    assertEquals("application/octet-stream", ShareInboxImporter.concreteOrFallback(null))
  }

  @Test
  fun copyBoundedCopiesContentWithinLimit() {
    val content = ByteArray(64) { index -> index.toByte() }
    val output = ByteArrayOutputStream()

    assertEquals(64, ShareInboxImporter.copyBounded(ByteArrayInputStream(content), output, 64))
    assertArrayEquals(content, output.toByteArray())
  }

  @Test
  fun copyBoundedRejectsContentOverLimit() {
    assertThrows(IllegalStateException::class.java) {
      ShareInboxImporter.copyBounded(ByteArrayInputStream(ByteArray(65)), ByteArrayOutputStream(), 64)
    }
  }
}
