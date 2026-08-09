package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AndroidPDFProcessorTest {
  private val firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private val secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  @Test
  fun normalizesLineEndingsControlsAndInvalidSurrogatesDeterministically() {
    assertEquals(
      "中文\n\tcode\uFFFD\uFFFD",
      normalizePDFText("中文\r\n\tcode\u0000\uD800"),
    )
    assertEquals("👩🏽‍💻", normalizePDFText("👩🏽‍💻"))
  }

  @Test
  fun sharedRegistrySerializesOcrAndPdfAndPreservesPdfCancelCode() {
    val registry = OcrTaskRegistry()
    val first = AndroidPDFProcessor(registry)
    val replacement = AndroidPDFProcessor(registry)
    first.reserve(firstTaskId)
    assertTrue(first.cancel(firstTaskId))
    assertEquals("PDF_CANCELLED", registry.failureCode(firstTaskId))
    val busy = assertThrows(NativeException::class.java) {
      replacement.reserve(secondTaskId)
    }
    assertEquals("PDF_RESOURCE_BUSY", busy.code)
    first.finish(firstTaskId)
    replacement.reserve(secondTaskId)
    replacement.finish(secondTaskId)
  }

  @Test
  fun rejectsNonCanonicalTaskIdsBeforeAnyResourceWork() {
    val error = assertThrows(NativeException::class.java) {
      AndroidPDFProcessor().reserve("123E4567-E89B-42D3-A456-426614174000")
    }
    assertEquals("PDF_RESULT_INVALID", error.code)
  }

  @Test
  fun detectsOnlyDelimitedEncryptionDictionaryNamesWithBoundedStreaming() {
    val encrypted = temporaryPDF(
      "%PDF-1.7\ntrailer\n<< /Size 2 /Encrypt 1 0 R >>\nstartxref\n8\n%%EOF",
    )
    val metadataOnly = temporaryPDF(
      "%PDF-1.7\n1 0 obj << /EncryptMetadata true >> endobj\nstartxref\n8\n%%EOF",
    )
    val harmlessContent = temporaryPDF(
      "%PDF-1.7\n1 0 obj << /Length 20 >> stream\nBT (/Encrypt) Tj ET\n" +
        "endstream\nendobj\ntrailer\n<< /Size 2 >>\nstartxref\n8\n%%EOF",
    )
    try {
      assertTrue(hasPDFEncryptionMarker(encrypted))
      assertEquals(false, hasPDFEncryptionMarker(metadataOnly))
      assertEquals(false, hasPDFEncryptionMarker(harmlessContent))
    } finally {
      encrypted.delete()
      metadataOnly.delete()
      harmlessContent.delete()
    }
  }

  @Test
  fun rejectsTruncatedEnvelopeBeforeEnteringPlatformPdfium() {
    val valid = temporaryPDF("%PDF-1.7\nstartxref\n8\n%%EOF\n")
    val truncated = temporaryPDF("%PDF-1.7\n1 0 obj\n<< /Type /Catalog")
    try {
      assertTrue(hasValidPDFEnvelope(valid))
      assertEquals(false, hasValidPDFEnvelope(truncated))
    } finally {
      valid.delete()
      truncated.delete()
    }
  }

  private fun temporaryPDF(contents: String): File =
    File.createTempFile("ai-context-pack-pdf-", ".pdf").apply {
      writeText(contents, Charsets.US_ASCII)
    }
}
