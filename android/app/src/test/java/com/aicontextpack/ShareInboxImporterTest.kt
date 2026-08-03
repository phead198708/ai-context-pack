package com.aicontextpack

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class ShareInboxImporterTest {
  @Test
  fun resolvesWildcardImageMimeFromProvider() {
    assertEquals(
      "image/jpeg",
      ShareInboxImporter.selectConcreteImageMediaType("image/*", "image/jpeg")
    )
  }

  @Test
  fun providerMimeTakesPrecedenceOverConflictingIntentMime() {
    assertEquals(
      "image/png",
      ShareInboxImporter.selectConcreteImageMediaType("image/jpeg", "image/png")
    )
  }

  @Test
  fun rejectsImageMimeWhenNoConcreteTypeExists() {
    assertEquals(null, ShareInboxImporter.selectConcreteImageMediaType("image/*", null))
    assertEquals(null, ShareInboxImporter.selectConcreteImageMediaType("image/jpeg; charset=utf-8", null))
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
