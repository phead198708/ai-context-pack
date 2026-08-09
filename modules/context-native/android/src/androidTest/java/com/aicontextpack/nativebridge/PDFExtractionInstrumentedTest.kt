package com.aicontextpack.nativebridge

import android.os.Debug
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PDFExtractionInstrumentedTest {
  private val firstTaskId = "123e4567-e89b-42d3-a456-426614174000"
  private val secondTaskId = "223e4567-e89b-42d3-a456-426614174000"

  @Test
  fun extractsTextScannedAndMixedFixturesThroughProductionPaths() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val text = copyFixture("text-one-page.pdf")
    val info = processor.inspect(context, text.toURI().toString())
    assertEquals(1, info["schemaVersion"])
    assertEquals(1, info["pageCount"])
    assertEquals("pdf-renderer", info["engine"])
    assertEquals(sha256(text), info["sha256"])

    val textPage = processor.extractPage(
      context,
      firstTaskId,
      text.toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", textPage["status"])
    assertEquals(
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
        "embedded-text"
      } else {
        "rendered-ocr"
      },
      textPage["method"],
    )

    val scannedPage = processor.extractPage(
      context,
      secondTaskId,
      copyFixture("scanned-one-page.pdf").toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", scannedPage["status"])
    assertEquals("rendered-ocr", scannedPage["method"])
    assertTrue((scannedPage["warnings"] as List<*>).contains("PDF_PAGE_OCR_FALLBACK"))

    val mixed = copyFixture("mixed-two-page.pdf").toURI().toString()
    val first = processor.extractPage(context, firstTaskId, mixed, 0, "latin")
    val second = processor.extractPage(context, secondTaskId, mixed, 1, "latin")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertEquals("embedded-text", first["method"])
    } else {
      assertEquals("rendered-ocr", first["method"])
    }
    assertEquals("rendered-ocr", second["method"])
  }

  @Test
  fun corruptAndOutOfRangeFilesHaveStableErrors() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val corrupt = assertThrows(NativeException::class.java) {
      processor.inspect(context, copyFixture("corrupt-truncated.pdf").toURI().toString())
    }
    assertEquals("PDF_CORRUPT", corrupt.code)
    val outOfRange = assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        firstTaskId,
        copyFixture("text-one-page.pdf").toURI().toString(),
        1,
        "latin",
      )
    }
    assertEquals("PDF_PAGE_OUT_OF_RANGE", outOfRange.code)
  }

  @Test
  fun validRendererRemainsReusableAfterOutOfRangeRequest() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        firstTaskId,
        copyFixture("text-one-page.pdf").toURI().toString(),
        1,
        "latin",
      )
    }
    val blank = processor.extractPage(
      context,
      secondTaskId,
      copyFixture("empty-one-page.pdf").toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", blank["status"])
  }

  @Test
  fun validRendererRemainsReusableAfterCorruptDocument() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    assertThrows(NativeException::class.java) {
      processor.inspect(context, copyFixture("corrupt-truncated.pdf").toURI().toString())
    }
    val blank = processor.extractPage(
      context,
      firstTaskId,
      copyFixture("empty-one-page.pdf").toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", blank["status"])
  }

  @Test
  fun encryptedFixtureHasStableErrorWithoutOpeningPdfRenderer() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val encrypted = assertThrows(NativeException::class.java) {
      processor.inspect(
        context,
        copyFixture("encrypted-one-page.pdf").toURI().toString(),
      )
    }
    assertEquals("PDF_ENCRYPTED", encrypted.code)
  }

  @Test
  fun validUnencryptedPdfWithEncryptContentIsNotMisclassified() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "unencrypted-encrypt-content.pdf")
    file.writeBytes(unencryptedEncryptTextPDF())
    try {
      assertEquals(false, hasPDFEncryptionMarker(file))
      val info = AndroidPDFProcessor().inspect(context, file.toURI().toString())
      assertEquals(1, info["pageCount"])
      assertEquals(sha256(file), info["sha256"])
    } finally {
      file.delete()
    }
  }

  @Test
  fun validXrefStreamPdfWithTrailerEncryptContentIsNotMisclassified() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "unencrypted-xref-stream-content.pdf")
    file.writeBytes(unencryptedXrefStreamEncryptTextPDF())
    try {
      assertEquals(false, hasPDFEncryptionMarker(file))
      val info = AndroidPDFProcessor().inspect(context, file.toURI().toString())
      assertEquals(1, info["pageCount"])
      assertEquals(sha256(file), info["sha256"])
    } finally {
      file.delete()
    }
  }

  @Test
  fun overLimitFixtureHasStableError() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val overLimit = assertThrows(NativeException::class.java) {
      processor.inspect(
        context,
        copyFixture("over-limit-26-pages.pdf").toURI().toString(),
      )
    }
    assertEquals("PDF_TOO_MANY_PAGES", overLimit.code)
  }

  @Test
  fun blankAndSparseFixturesHaveVisibleFallbackOutcomes() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val blank = processor.extractPage(
      context,
      firstTaskId,
      copyFixture("empty-one-page.pdf").toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", blank["status"])
    assertEquals("rendered-ocr", blank["method"])
    assertTrue((blank["warnings"] as List<*>).contains("PDF_PAGE_EMPTY"))

    val sparse = processor.extractPage(
      context,
      secondTaskId,
      copyFixture("sparse-one-page.pdf").toURI().toString(),
      0,
      "latin",
    )
    assertEquals("complete", sparse["status"])
    assertEquals("rendered-ocr", sparse["method"])
    assertTrue((sparse["warnings"] as List<*>).contains("PDF_PAGE_OCR_FALLBACK"))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertTrue((sparse["warnings"] as List<*>).contains("PDF_EMBEDDED_TEXT_SPARSE"))
    }
  }

  @Test
  fun oversizedFixtureHasStableErrorWithoutReadingItsPayload() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val oversized = File(context.cacheDir, "oversized-synthetic.pdf")
    RandomAccessFile(oversized, "rw").use {
      it.setLength(AndroidPDFResourcePolicy.maximumFileBytes + 1)
    }
    try {
      val tooLarge = assertThrows(NativeException::class.java) {
        processor.inspect(context, oversized.toURI().toString())
      }
      assertEquals("PDF_TOO_LARGE", tooLarge.code)
    } finally {
      oversized.delete()
    }
  }

  @Test
  fun mixedTwentyPageBenchmarkRecordsSampledMemoryAndCancellation() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val mixed = copyFixture("mixed-twenty-page.pdf").toURI().toString()
    assertEquals(20, processor.inspect(context, mixed)["pageCount"])

    val started = SystemClock.elapsedRealtimeNanos()
    var sampledPeakPssKb = Debug.getPss()
    var embeddedPages = 0
    var renderedPages = 0
    repeat(20) { pageIndex ->
      val result = processor.extractPage(
        context,
        UUID.randomUUID().toString(),
        mixed,
        pageIndex,
        "latin",
      )
      assertEquals("complete", result["status"])
      when (result["method"]) {
        "embedded-text" -> embeddedPages += 1
        "rendered-ocr" -> renderedPages += 1
      }
      sampledPeakPssKb = maxOf(sampledPeakPssKb, Debug.getPss())
    }
    val durationMs = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertEquals(10, embeddedPages)
      assertEquals(10, renderedPages)
    } else {
      assertEquals(0, embeddedPages)
      assertEquals(20, renderedPages)
    }
    assertTrue(durationMs > 0)
    assertTrue(sampledPeakPssKb > 0)

    val cancellationId = UUID.randomUUID().toString()
    processor.reserve(cancellationId)
    assertTrue(processor.cancel(cancellationId))
    val cancelled = assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        cancellationId,
        mixed,
        0,
        "latin",
        reserved = true,
      )
    }
    assertEquals("PDF_CANCELLED", cancelled.code)

    println(
      "PDF_BENCHMARK_ANDROID api=${Build.VERSION.SDK_INT} pages=20 " +
        "durationMs=$durationMs sampledPeakPssKb=$sampledPeakPssKb " +
        "cancellation=PDF_CANCELLED",
    )
  }

  private fun unencryptedEncryptTextPDF(): ByteArray {
    val output = ByteArrayOutputStream()
    val offsets = mutableListOf<Int>()
    fun append(value: String) = output.write(value.toByteArray(Charsets.US_ASCII))
    append("%PDF-1.4\n")
    val objects = listOf(
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length 40 >>\nstream\nBT /F1 18 Tf 72 720 Td (/Encrypt) Tj ET\nendstream",
    )
    objects.forEachIndexed { index, body ->
      offsets += output.size()
      append("${index + 1} 0 obj\n$body\nendobj\n")
    }
    val xref = output.size()
    append("xref\n0 6\n0000000000 65535 f \n")
    offsets.forEach { offset ->
      append(String.format(Locale.US, "%010d 00000 n \n", offset))
    }
    append("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
    return output.toByteArray()
  }

  private fun unencryptedXrefStreamEncryptTextPDF(): ByteArray {
    val output = ByteArrayOutputStream()
    val offsets = mutableListOf<Int>()
    fun append(value: String) = output.write(value.toByteArray(Charsets.US_ASCII))
    append("%PDF-1.5\n")
    val content = "BT /F1 18 Tf 72 720 Td (trailer /Encrypt) Tj ET"
    val objects = listOf(
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Length ${content.toByteArray(Charsets.US_ASCII).size} >>\n" +
        "stream\n$content\nendstream",
    )
    objects.forEachIndexed { index, body ->
      offsets += output.size()
      append("${index + 1} 0 obj\n$body\nendobj\n")
    }

    val xrefOffset = output.size()
    val xrefOffsets = listOf(0) + offsets + xrefOffset
    append(
      "6 0 obj\n<< /Type /XRef /Size 7 /Root 1 0 R " +
        "/W [1 4 2] /Index [0 7] /Length 49 >>\nstream\n",
    )
    xrefOffsets.forEachIndexed { index, offset ->
      output.write(if (index == 0) 0 else 1)
      output.write(offset ushr 24 and 0xff)
      output.write(offset ushr 16 and 0xff)
      output.write(offset ushr 8 and 0xff)
      output.write(offset and 0xff)
      val generation = if (index == 0) 65_535 else 0
      output.write(generation ushr 8 and 0xff)
      output.write(generation and 0xff)
    }
    append("\nendstream\nendobj\nstartxref\n$xrefOffset\n%%EOF\n")
    return output.toByteArray()
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { input ->
      val buffer = ByteArray(8_192)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  @Test
  fun plainTextReaderIsStrictBoundedAndPreservesOriginalBytes() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val valid = File(context.cacheDir, "plain-valid.txt")
    val source = "中文 👩🏽‍💻\r\n    code"
    valid.writeText(source, Charsets.UTF_8)
    val result = AndroidPlainTextFileReader.read(context, valid.toURI().toString())
    assertEquals(source, result["text"])
    assertEquals(source.toByteArray(Charsets.UTF_8).size, result["byteCount"])

    val invalid = File(context.cacheDir, "plain-invalid.txt")
    invalid.writeBytes(byteArrayOf(0xC3.toByte(), 0x28))
    val invalidError = assertThrows(NativeException::class.java) {
      AndroidPlainTextFileReader.read(context, invalid.toURI().toString())
    }
    assertEquals("TEXT_INVALID_UTF8", invalidError.code)

    val oversized = File(context.cacheDir, "plain-oversized.txt")
    oversized.outputStream().use { output ->
      val chunk = ByteArray(64 * 1024) { 0x61 }
      repeat(17) { output.write(chunk) }
    }
    val oversizedError = assertThrows(NativeException::class.java) {
      AndroidPlainTextFileReader.read(context, oversized.toURI().toString())
    }
    assertEquals("TEXT_TOO_LARGE", oversizedError.code)
  }

  private fun copyFixture(name: String): File {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val file = File(instrumentation.targetContext.cacheDir, name)
    instrumentation.context.assets.open(name).use { input ->
      file.outputStream().use { output -> input.copyTo(output) }
    }
    return file
  }
}
