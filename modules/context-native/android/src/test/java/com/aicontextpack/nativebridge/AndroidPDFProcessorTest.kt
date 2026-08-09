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
    val encrypted = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /Encrypt 1 0 R >>",
    )
    val metadataOnly = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /EncryptMetadata true >>",
    )
    val harmlessContent = classicXrefPDF(
      prefix = "%PDF-1.7\n1 0 obj << /Length 20 >> stream\nBT (/Encrypt) Tj ET\n" +
        "endstream\nendobj\n",
      trailerDictionary = "<< /Size 2 >>",
    )
    val harmlessXrefStream = xrefStreamPDF(
      prefix = "%PDF-1.7\n1 0 obj << /Length 16 >> stream\ntrailer /Encrypt\n" +
        "endstream\nendobj\n",
      xrefDictionary = "<< /Type /XRef /Size 3 /W [1 1 1] /Length 0 >>",
    )
    val encryptedXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length 0 /Encrypt 1 0 R >>",
    )
    try {
      assertTrue(hasPDFEncryptionMarker(encrypted))
      assertEquals(false, hasPDFEncryptionMarker(metadataOnly))
      assertEquals(false, hasPDFEncryptionMarker(harmlessContent))
      assertEquals(false, hasPDFEncryptionMarker(harmlessXrefStream))
      assertTrue(hasPDFEncryptionMarker(encryptedXrefStream))
    } finally {
      encrypted.delete()
      metadataOnly.delete()
      harmlessContent.delete()
      harmlessXrefStream.delete()
      encryptedXrefStream.delete()
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

  private fun classicXrefPDF(
    prefix: String = "%PDF-1.7\n",
    trailerDictionary: String,
  ): File {
    val xrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n$trailerDictionary\nstartxref\n$xrefOffset\n%%EOF",
    )
  }

  private fun xrefStreamPDF(
    prefix: String = "%PDF-1.7\n",
    xrefDictionary: String,
  ): File {
    val xrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix +
        "2 0 obj\n$xrefDictionary\nstream\n\nendstream\nendobj\n" +
        "startxref\n$xrefOffset\n%%EOF",
    )
  }
}
