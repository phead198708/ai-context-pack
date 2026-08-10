package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException

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
    assertEquals(16, pdfEmbeddedTextNonWhitespaceUTF16Count("😀😀😀😀😀😀😀😀"))
    assertEquals(
      14,
      pdfEmbeddedTextNonWhitespaceUTF16Count(" \n\u0085\u00A0\u3000😀😀😀😀😀😀😀"),
    )
    assertEquals("A\n4", reconcilePDFSparseEmbeddedText("A", "4"))
    assertEquals("A\nOCR A result", reconcilePDFSparseEmbeddedText("A", "OCR A result"))
    assertEquals("A\nCAT", reconcilePDFSparseEmbeddedText("A", "CAT"))
    assertEquals("A", reconcilePDFSparseEmbeddedText("A", "A"))
    assertEquals("é\ne\u0301", reconcilePDFSparseEmbeddedText("é", "e\u0301"))
    assertEquals(
      "Recovered by OCR",
      reconcilePDFSparseEmbeddedText(" \n\u0085\u00A0\u3000", "Recovered by OCR"),
    )
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
  fun destroyDefersSharedRegistryReleaseUntilActivePageWorkUnwinds() {
    val registry = OcrTaskRegistry()
    val first = AndroidPDFProcessor(registry)
    val replacement = AndroidPDFProcessor(registry)
    first.reserve(firstTaskId)

    first.destroy(activeTaskId = firstTaskId)
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
    val binaryStreamDelimiters = classicXrefPDF(
      prefix = "%PDF-1.7\n1 0 obj << /Length 4 >> stream\n<<[[\nendstream\nendobj\n",
      trailerDictionary = "<< /Size 2 >>",
    )
    val harmlessXrefStream = xrefStreamPDF(
      prefix = "%PDF-1.7\n1 0 obj << /Length 16 >> stream\ntrailer /Encrypt\n" +
        "endstream\nendobj\n",
      xrefDictionary = "<< /Type /XRef /Size 3 /W [1 1 1] /Length 0 >>",
    )
    val harmlessIndirectLengthXrefStream = xrefStreamPDFWithIndirectLength()
    val harmlessNoEolIndirectLengthXrefStream = xrefStreamPDFWithIndirectLength(
      streamPayload = "abc",
      includeEndstreamLineEnding = false,
    )
    val harmlessZeroLengthNoEolXrefStream = xrefStreamPDFWithIndirectLength(
      includeEndstreamLineEnding = false,
    )
    val harmlessForwardIndirectLengthXrefStream = xrefStreamPDFWithIndirectLength(
      streamPayload = "abc",
      forwardLengthObject = true,
    )
    val mismatchedForwardIndirectLengthXrefStream = xrefStreamPDFWithIndirectLength(
      streamPayload = "abc",
      forwardLengthObject = true,
      declaredLengthOverride = 2,
    )
    val harmlessPositiveLengthXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length +0 >>",
    )
    val negativeLengthXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length -1 >>",
    )
    val encryptedXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length 0 /Encrypt 1 0 R >>",
    )
    val nestedClassic = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /Info << /Encrypt false >> >>",
    )
    val nestedXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length 0 " +
        "/DecodeParms << /Columns 1 /Encrypt false >> >>",
    )
    val escapedEncrypted = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /En#63rypt 1 0 R >>",
    )
    val escapedEncryptedXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Ty#70e /XR#65f /Size 2 /W [1 1 1] /Length 0 " +
        "/En#63rypt 1 0 R >>",
    )
    val lateEncryptedXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length 0 /Custom (" +
        "a".repeat(70_000) + ") /Encrypt 1 0 R >>",
    )
    val oversizedIncompleteXrefStream = xrefStreamPDF(
      xrefDictionary = "<< /Type /XRef /Custom (" +
        "a".repeat(AndroidPDFResourcePolicy.maximumXrefDictionaryBytes + 1),
    )
    val malformedStartXref = temporaryPDF(
      "%PDF-1.7\nstartxref\n999999\n%%EOF",
    )
    val incompleteClassicTrailer = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /Custom (" +
        "a".repeat(AndroidPDFResourcePolicy.maximumXrefDictionaryBytes + 1),
    )
    val harmlessTrailerString = classicXrefPDF(
      trailerDictionary = "<< /Size 2 /ID [(trailer) (second-id)] >>",
    )
    val harmlessTrailerComment = classicXrefPDF(
      trailerDictionary = "<< /Size 2 % trailer\n/Root 1 0 R >>",
    )
    val incrementallyEncrypted = incrementalClassicXrefPDF(
      previousTrailerDictionary = "<< /Size 2 /Encrypt 1 0 R >>",
      latestTrailerEntries = "/Size 3 /Root 2 0 R",
    )
    val incrementallyEncryptedXrefStream = incrementalXrefStreamPDF(
      previousDictionary = "<< /Type /XRef /Size 2 /W [1 1 1] /Length 0 /En#63rypt 1 0 R >>",
      latestDictionaryEntries = "/Type /XRef /Size 3 /W [1 1 1] /Length 0",
    )
    val incrementallyUnencrypted = incrementalClassicXrefPDF(
      previousTrailerDictionary = "<< /Size 2 /Root 1 0 R >>",
      latestTrailerEntries = "/Size 3 /Root 2 0 R",
    )
    val largeIncrementallyEncrypted = largeIncrementalEncryptedPDF()
    val cyclicPreviousRevision = cyclicPreviousRevisionPDF()
    val spoofedPreviousStartXref = incrementalClassicXrefWithStreamMarkerPDF()
    val indirectPreviousRevision = incrementalClassicXrefWithRawPrevPDF { previousOffset ->
      "/Size 3 /Prev $previousOffset 0 R"
    }
    val duplicatePreviousRevision = incrementalClassicXrefWithRawPrevPDF { previousOffset ->
      "/Size 3 /Prev $previousOffset /Prev $previousOffset"
    }
    val positivePreviousRevision = incrementalClassicXrefWithRawPrevPDF { previousOffset ->
      "/Size 3 /Prev +$previousOffset"
    }
    val positiveStartXrefRevision = incrementalClassicXrefWithRawPrevPDF(
      signedLatestStartXref = true,
    ) { previousOffset ->
      "/Size 3 /Prev +$previousOffset"
    }
    val negativePreviousRevision = incrementalClassicXrefWithRawPrevPDF { previousOffset ->
      "/Size 3 /Prev -$previousOffset"
    }
    try {
      assertTrue(hasPDFEncryptionMarker(encrypted))
      assertEquals(false, hasPDFEncryptionMarker(metadataOnly))
      assertEquals(false, hasPDFEncryptionMarker(harmlessContent))
      assertEquals(false, hasPDFEncryptionMarker(binaryStreamDelimiters))
      assertEquals(false, hasPDFEncryptionMarker(harmlessXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessIndirectLengthXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessNoEolIndirectLengthXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessZeroLengthNoEolXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessForwardIndirectLengthXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessPositiveLengthXrefStream))
      assertTrue(hasPDFEncryptionMarker(encryptedXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(nestedClassic))
      assertEquals(false, hasPDFEncryptionMarker(nestedXrefStream))
      assertTrue(hasPDFEncryptionMarker(escapedEncrypted))
      assertTrue(hasPDFEncryptionMarker(escapedEncryptedXrefStream))
      assertTrue(hasPDFEncryptionMarker(lateEncryptedXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(harmlessTrailerString))
      assertEquals(false, hasPDFEncryptionMarker(harmlessTrailerComment))
      assertTrue(hasPDFEncryptionMarker(incrementallyEncrypted))
      assertTrue(hasPDFEncryptionMarker(incrementallyEncryptedXrefStream))
      assertEquals(false, hasPDFEncryptionMarker(incrementallyUnencrypted))
      assertEquals(false, hasPDFEncryptionMarker(spoofedPreviousStartXref))
      assertEquals(false, hasPDFEncryptionMarker(positivePreviousRevision))
      assertEquals(false, hasPDFEncryptionMarker(positiveStartXrefRevision))
      assertTrue(hasPDFEncryptionMarker(largeIncrementallyEncrypted))
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(cyclicPreviousRevision)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(oversizedIncompleteXrefStream)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(malformedStartXref)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(incompleteClassicTrailer)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(indirectPreviousRevision)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(duplicatePreviousRevision)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(negativeLengthXrefStream)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(mismatchedForwardIndirectLengthXrefStream)
      }
      assertThrows(IOException::class.java) {
        hasPDFEncryptionMarker(negativePreviousRevision)
      }
    } finally {
      encrypted.delete()
      metadataOnly.delete()
      harmlessContent.delete()
      binaryStreamDelimiters.delete()
      harmlessXrefStream.delete()
      harmlessIndirectLengthXrefStream.delete()
      harmlessNoEolIndirectLengthXrefStream.delete()
      harmlessZeroLengthNoEolXrefStream.delete()
      harmlessForwardIndirectLengthXrefStream.delete()
      mismatchedForwardIndirectLengthXrefStream.delete()
      harmlessPositiveLengthXrefStream.delete()
      negativeLengthXrefStream.delete()
      encryptedXrefStream.delete()
      nestedClassic.delete()
      nestedXrefStream.delete()
      escapedEncrypted.delete()
      escapedEncryptedXrefStream.delete()
      lateEncryptedXrefStream.delete()
      oversizedIncompleteXrefStream.delete()
      malformedStartXref.delete()
      incompleteClassicTrailer.delete()
      harmlessTrailerString.delete()
      harmlessTrailerComment.delete()
      incrementallyEncrypted.delete()
      incrementallyEncryptedXrefStream.delete()
      incrementallyUnencrypted.delete()
      largeIncrementallyEncrypted.delete()
      cyclicPreviousRevision.delete()
      spoofedPreviousStartXref.delete()
      indirectPreviousRevision.delete()
      duplicatePreviousRevision.delete()
      positivePreviousRevision.delete()
      positiveStartXrefRevision.delete()
      negativePreviousRevision.delete()
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

  private fun xrefStreamPDFWithIndirectLength(
    streamPayload: String = "",
    includeEndstreamLineEnding: Boolean = true,
    forwardLengthObject: Boolean = false,
    declaredLengthOverride: Int? = null,
  ): File {
    val streamLength = streamPayload.toByteArray(Charsets.US_ASCII).size
    val declaredLength = declaredLengthOverride ?: streamLength
    val prefix = if (forwardLengthObject) {
      "%PDF-1.7\n"
    } else {
      "%PDF-1.7\n1 0 obj\n$declaredLength\nendobj\n"
    }
    val xrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    val beforeEndstream = if (includeEndstreamLineEnding) "\n" else ""
    val forwardObject = if (forwardLengthObject) {
      "1 0 obj\n$declaredLength\nendobj\n"
    } else {
      ""
    }
    return temporaryPDF(
      prefix +
        "2 0 obj\n<< /Type /XRef /Size 3 /W [1 1 1] /Length 1 0 R >>\n" +
        "stream\n$streamPayload${beforeEndstream}endstream\nendobj\n" +
        forwardObject +
        "startxref\n$xrefOffset\n%%EOF",
    )
  }

  private fun incrementalClassicXrefPDF(
    previousTrailerDictionary: String,
    latestTrailerEntries: String,
  ): File {
    val prefix = "%PDF-1.7\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    val previousRevision =
      "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n$previousTrailerDictionary\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val latestXrefOffset = previousXrefOffset + previousRevision.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix + previousRevision +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< $latestTrailerEntries /Prev $previousXrefOffset >>\n" +
        "startxref\n$latestXrefOffset\n%%EOF",
    )
  }

  private fun incrementalXrefStreamPDF(
    previousDictionary: String,
    latestDictionaryEntries: String,
  ): File {
    val prefix = "%PDF-1.7\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    val previousRevision =
      "2 0 obj\n$previousDictionary\nstream\n\nendstream\nendobj\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val latestXrefOffset = previousXrefOffset + previousRevision.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix + previousRevision +
        "3 0 obj\n<< $latestDictionaryEntries /Prev $previousXrefOffset >>\n" +
        "stream\n\nendstream\nendobj\n" +
        "startxref\n$latestXrefOffset\n%%EOF",
    )
  }

  private fun cyclicPreviousRevisionPDF(): File {
    val prefix = "%PDF-1.7\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    val previousRevision =
      "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size 2 /Prev $previousXrefOffset >>\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val latestXrefOffset = previousXrefOffset + previousRevision.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix + previousRevision +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size 3 /Prev $previousXrefOffset >>\n" +
        "startxref\n$latestXrefOffset\n%%EOF",
    )
  }

  private fun incrementalClassicXrefWithStreamMarkerPDF(): File {
    val prefix = "%PDF-1.7\n%" + "a".repeat(240) + "\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    check(previousXrefOffset == 251)
    val previousRevision =
      "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size 2 /Root 1 0 R >>\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val streamPayload = "startxref\n$previousXrefOffset\n"
    val appendedObject =
      "2 0 obj\n<< /Length ${streamPayload.toByteArray(Charsets.US_ASCII).size} >>\n" +
        "stream\n$streamPayload" +
        "endstream\nendobj\n"
    val latestXrefOffset = previousXrefOffset +
      previousRevision.toByteArray(Charsets.US_ASCII).size +
      appendedObject.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix + previousRevision + appendedObject +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size 3 /Prev $previousXrefOffset >>\n" +
        "startxref\n$latestXrefOffset\n%%EOF",
    )
  }

  private fun incrementalClassicXrefWithRawPrevPDF(
    signedLatestStartXref: Boolean = false,
    latestTrailerEntries: (previousOffset: Int) -> String,
  ): File {
    val prefix = "%PDF-1.7\n%" + "a".repeat(240) + "\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    check(previousXrefOffset == 251)
    val previousRevision =
      "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size 2 /Root 1 0 R >>\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val latestXrefOffset = previousXrefOffset + previousRevision.toByteArray(Charsets.US_ASCII).size
    val latestStartXref = if (signedLatestStartXref) "+$latestXrefOffset" else "$latestXrefOffset"
    return temporaryPDF(
      prefix + previousRevision +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< ${latestTrailerEntries(previousXrefOffset)} >>\n" +
        "startxref\n$latestStartXref\n%%EOF",
    )
  }

  private fun largeIncrementalEncryptedPDF(): File {
    val prefix = "%PDF-1.7\n"
    val previousXrefOffset = prefix.toByteArray(Charsets.US_ASCII).size
    val entry = "0000000000 00000 n \n"
    val entryCount = AndroidPDFResourcePolicy.maximumXrefDictionaryBytes / entry.length + 64
    val previousRevision =
      "xref\n0 $entryCount\n" + entry.repeat(entryCount) +
        "trailer\n<< /Size $entryCount /Encrypt 1 0 R >>\n" +
        "startxref\n$previousXrefOffset\n%%EOF\n"
    val latestXrefOffset = previousXrefOffset + previousRevision.toByteArray(Charsets.US_ASCII).size
    return temporaryPDF(
      prefix + previousRevision +
        "xref\n0 1\n0000000000 65535 f \n" +
        "trailer\n<< /Size ${entryCount + 1} /Prev $previousXrefOffset >>\n" +
        "startxref\n$latestXrefOffset\n%%EOF",
    )
  }
}
