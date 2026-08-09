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
  private val thirdTaskId = "323e4567-e89b-42d3-a456-426614174000"

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

    val textHash = beginSession(processor, context, firstTaskId, text)
    val textPage = processor.extractPage(
      context,
      firstTaskId,
      text.toURI().toString(),
      textHash,
      0,
      "latin",
      reserved = true,
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
    processor.finish(firstTaskId)

    val scanned = copyFixture("scanned-one-page.pdf")
    val scannedHash = beginSession(processor, context, secondTaskId, scanned)
    val scannedPage = processor.extractPage(
      context,
      secondTaskId,
      scanned.toURI().toString(),
      scannedHash,
      0,
      "latin",
      reserved = true,
    )
    assertEquals("complete", scannedPage["status"])
    assertEquals("rendered-ocr", scannedPage["method"])
    assertTrue((scannedPage["warnings"] as List<*>).contains("PDF_PAGE_OCR_FALLBACK"))
    processor.finish(secondTaskId)

    val mixedFile = copyFixture("mixed-two-page.pdf")
    val mixed = mixedFile.toURI().toString()
    val mixedSha256 = beginSession(processor, context, firstTaskId, mixedFile)
    val first = processor.extractPage(
      context, firstTaskId, mixed, mixedSha256, 0, "latin", reserved = true,
    )
    val second = processor.extractPage(
      context, firstTaskId, mixed, mixedSha256, 1, "latin", reserved = true,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertEquals("embedded-text", first["method"])
    } else {
      assertEquals("rendered-ocr", first["method"])
    }
    assertEquals("rendered-ocr", second["method"])
    processor.finish(firstTaskId)
  }

  @Test
  fun corruptAndOutOfRangeFilesHaveStableErrors() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val corrupt = assertThrows(NativeException::class.java) {
      processor.inspect(context, copyFixture("corrupt-truncated.pdf").toURI().toString())
    }
    assertEquals("PDF_CORRUPT", corrupt.code)
    val text = copyFixture("text-one-page.pdf")
    val sourceSha256 = beginSession(processor, context, firstTaskId, text)
    val outOfRange = assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        firstTaskId,
        text.toURI().toString(),
        sourceSha256,
        1,
        "latin",
        reserved = true,
      )
    }
    assertEquals("PDF_PAGE_OUT_OF_RANGE", outOfRange.code)
    processor.finish(firstTaskId)
  }

  @Test
  fun cancelledInspectionStopsBeforeHashingAndReleasesTheSourceSession() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val text = copyFixture("text-one-page.pdf")
    processor.reserve(firstTaskId)
    assertTrue(processor.cancel(firstTaskId))

    val cancelled = assertThrows(NativeException::class.java) {
      processor.inspect(
        context = context,
        taskId = firstTaskId,
        fileUri = text.toURI().toString(),
        expectedSourceSha256 = sha256(text),
        reserved = true,
      )
    }
    assertEquals("PDF_CANCELLED", cancelled.code)

    val replacementHash = beginSession(processor, context, secondTaskId, text)
    assertEquals(sha256(text), replacementHash)
    processor.finish(secondTaskId)
  }

  @Test
  fun destroyReleasesTheRetainedOwnerWhenTheActivePageTaskDiffers() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val registry = OcrTaskRegistry()
    val processor = AndroidPDFProcessor(registry)
    val replacement = AndroidPDFProcessor(registry)
    val lifecycle = OcrModuleLifecycle()
    val text = copyFixture("text-one-page.pdf")
    val sourceSha256 = beginSession(processor, context, firstTaskId, text)
    processor.validatePageRequest(firstTaskId, text.toURI().toString(), sourceSha256)
    val earlyBindingError = assertThrows(NativeException::class.java) {
      processor.validatePageRequest(secondTaskId, text.toURI().toString(), sourceSha256)
    }
    assertEquals("PDF_RESULT_INVALID", earlyBindingError.code)
    assertTrue(
      lifecycle.register(
        OcrLifecycleRegistration(
          taskId = secondTaskId,
          close = {},
          rejectOnDestroy = {},
        ),
      ),
    )

    val bindingError = assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        secondTaskId,
        text.toURI().toString(),
        sourceSha256,
        0,
        "latin",
        reserved = true,
      )
    }
    assertEquals("PDF_RESULT_INVALID", bindingError.code)

    val destruction = lifecycle.destroy()!!
    processor.destroy(
      activeTaskId = destruction.taskId,
      deferRegistryRelease = destruction.deferProcessorRelease,
    )
    assertEquals(
      false,
      deliverPDFOperationCompletion(
        lifecycle = lifecycle,
        taskId = secondTaskId,
        finishProcessor = processor::finish,
      ) {},
    )
    lifecycle.finish(secondTaskId)

    replacement.reserve(thirdTaskId)
    replacement.finish(thirdTaskId)
  }

  @Test
  fun validRendererRemainsReusableAfterOutOfRangeRequest() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    val text = copyFixture("text-one-page.pdf")
    val textHash = beginSession(processor, context, firstTaskId, text)
    assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        firstTaskId,
        text.toURI().toString(),
        textHash,
        1,
        "latin",
        reserved = true,
      )
    }
    processor.finish(firstTaskId)
    val blankFile = copyFixture("empty-one-page.pdf")
    val blankHash = beginSession(processor, context, secondTaskId, blankFile)
    val blank = processor.extractPage(
      context,
      secondTaskId,
      blankFile.toURI().toString(),
      blankHash,
      0,
      "latin",
      reserved = true,
    )
    assertEquals("complete", blank["status"])
    processor.finish(secondTaskId)
  }

  @Test
  fun validRendererRemainsReusableAfterCorruptDocument() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val processor = AndroidPDFProcessor()
    assertThrows(NativeException::class.java) {
      processor.inspect(context, copyFixture("corrupt-truncated.pdf").toURI().toString())
    }
    val blankFile = copyFixture("empty-one-page.pdf")
    val blankHash = beginSession(processor, context, firstTaskId, blankFile)
    val blank = processor.extractPage(
      context,
      firstTaskId,
      blankFile.toURI().toString(),
      blankHash,
      0,
      "latin",
      reserved = true,
    )
    assertEquals("complete", blank["status"])
    processor.finish(firstTaskId)
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
  fun pageExtractionUsesTheImmutableInspectedDescriptorAfterPathReplacement() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = copyFixture("text-one-page.pdf")
    val processor = AndroidPDFProcessor()
    val sourceSha256 = beginSession(processor, context, firstTaskId, file)
    val replacement = copyFixture("scanned-one-page.pdf")
    val displaced = File(file.parentFile, "${UUID.randomUUID()}.pdf")
    assertTrue(file.renameTo(displaced))
    assertTrue(replacement.renameTo(file))

    val result = processor.extractPage(
      context,
      firstTaskId,
      file.toURI().toString(),
      sourceSha256,
      0,
      "latin",
      reserved = true,
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertEquals("embedded-text", result["method"])
      assertTrue((result["text"] as String).contains("Synthetic PDF fixture"))
    } else {
      assertEquals("rendered-ocr", result["method"])
    }
    processor.finish(firstTaskId)
    displaced.delete()
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
    val blankFile = copyFixture("empty-one-page.pdf")
    val blankHash = beginSession(processor, context, firstTaskId, blankFile)
    val blank = processor.extractPage(
      context,
      firstTaskId,
      blankFile.toURI().toString(),
      blankHash,
      0,
      "latin",
      reserved = true,
    )
    assertEquals("complete", blank["status"])
    assertEquals("rendered-ocr", blank["method"])
    assertTrue((blank["warnings"] as List<*>).contains("PDF_PAGE_EMPTY"))
    processor.finish(firstTaskId)

    val sparseFile = copyFixture("sparse-one-page.pdf")
    val sparseHash = beginSession(processor, context, secondTaskId, sparseFile)
    val sparse = processor.extractPage(
      context,
      secondTaskId,
      sparseFile.toURI().toString(),
      sparseHash,
      0,
      "latin",
      reserved = true,
    )
    assertEquals("complete", sparse["status"])
    assertEquals("rendered-ocr", sparse["method"])
    assertTrue((sparse["warnings"] as List<*>).contains("PDF_PAGE_OCR_FALLBACK"))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      assertTrue((sparse["warnings"] as List<*>).contains("PDF_EMBEDDED_TEXT_SPARSE"))
      assertEquals(false, (sparse["warnings"] as List<*>).contains("PDF_PAGE_EMPTY"))
      assertTrue((sparse["text"] as String).contains("A"))
      assertEquals("A", sparse["embeddedText"])
    }
    processor.finish(secondTaskId)
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
    val mixedFile = copyFixture("mixed-twenty-page.pdf")
    val mixed = mixedFile.toURI().toString()
    val taskId = UUID.randomUUID().toString()
    val mixedSha256 = beginSession(processor, context, taskId, mixedFile)
    assertEquals(20, processor.inspect(context, mixed)["pageCount"])

    val started = SystemClock.elapsedRealtimeNanos()
    var sampledPeakPssKb = Debug.getPss()
    var embeddedPages = 0
    var renderedPages = 0
    repeat(20) { pageIndex ->
      val result = processor.extractPage(
        context,
        taskId,
        mixed,
        mixedSha256,
        pageIndex,
        "latin",
        reserved = true,
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
    processor.finish(taskId)

    val cancellationId = UUID.randomUUID().toString()
    val cancellationHash = beginSession(processor, context, cancellationId, mixedFile)
    assertTrue(processor.cancel(cancellationId))
    val cancelled = assertThrows(NativeException::class.java) {
      processor.extractPage(
        context,
        cancellationId,
        mixed,
        cancellationHash,
        0,
        "latin",
        reserved = true,
      )
    }
    assertEquals("PDF_CANCELLED", cancelled.code)
    processor.finish(cancellationId)

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
        "/W [1 4 2] /Index [0 7] /Length 49 " +
        "/DecodeParms << /Columns 1 /Encrypt false >> >>\nstream\n",
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

  private fun beginSession(
    processor: AndroidPDFProcessor,
    context: android.content.Context,
    taskId: String,
    file: File,
  ): String {
    val sourceSha256 = sha256(file)
    processor.inspect(
      context = context,
      taskId = taskId,
      fileUri = file.toURI().toString(),
      expectedSourceSha256 = sourceSha256,
    )
    return sourceSha256
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
