package com.aicontextpack.nativebridge

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.annotation.RequiresApi
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.sqrt

internal object AndroidPDFResourcePolicy {
  const val maximumPages = 25
  const val maximumFileBytes = 52_428_800L
  const val maximumRenderedDimension = 2_200
  const val maximumRenderedPixels = 8_000_000
  const val lowRamMaximumRenderedPixels = 4_000_000
  const val minimumEmbeddedTextCharacters = 16
  const val maximumPageTextLength = 1_000_000
}

private val CANONICAL_PDF_SHA256 = Regex("^[0-9a-f]{64}$")

private sealed class PreparedPDFPage {
  data class Complete(val result: Map<String, Any>) : PreparedPDFPage()

  data class Rendered(
    val bitmap: Bitmap,
    val width: Int,
    val height: Int,
    val embeddedText: String,
    val warnings: List<String>,
    val started: Long,
  ) : PreparedPDFPage()

  data class Failed(val result: Map<String, Any>) : PreparedPDFPage()
}

internal class AndroidPDFProcessor(
  private val registry: OcrTaskRegistry = OcrTaskRegistry(),
) {
  fun inspect(context: Context, fileUri: String): Map<String, Any> {
    val file = validatedFile(context, fileUri)
    val sourceSha256 = try {
      sha256(file)
    } catch (_: IOException) {
      throw NativeException("PDF_CORRUPT")
    }
    return withRenderer(file) { renderer ->
      validatePageCount(renderer.pageCount)
      mapOf(
        "schemaVersion" to 1,
        "pageCount" to renderer.pageCount,
        "byteCount" to file.length(),
        "sha256" to sourceSha256,
        "engine" to "pdf-renderer",
        "revision" to Build.VERSION.SDK_INT.toString(),
        "limit" to mapOf(
          "pages" to AndroidPDFResourcePolicy.maximumPages,
          "bytes" to AndroidPDFResourcePolicy.maximumFileBytes,
        ),
      )
    }
  }

  fun reserve(taskId: String) {
    if (!isCanonicalPDFTaskId(taskId)) throw NativeException("PDF_RESULT_INVALID")
    registry.begin(taskId, "PDF_RESOURCE_BUSY")
  }

  fun extractPage(
    context: Context,
    taskId: String,
    fileUri: String,
    expectedSourceSha256: String,
    pageIndex: Int,
    script: String,
    reserved: Boolean = false,
  ): Map<String, Any> {
    var registered = reserved
    try {
      if (
        !isCanonicalPDFTaskId(taskId) ||
        pageIndex !in 0 until AndroidPDFResourcePolicy.maximumPages ||
        (script != "latin" && script != "chinese")
      ) throw NativeException("PDF_RESULT_INVALID")
      if (!reserved) {
        reserve(taskId)
        registered = true
      }
      val file = validatedFile(context, fileUri)
      validateExpectedSource(file, expectedSourceSha256)
      val started = System.nanoTime()
      val prepared = withRenderer(file) { renderer ->
        validatePageCount(renderer.pageCount)
        if (pageIndex >= renderer.pageCount) throw NativeException("PDF_PAGE_OUT_OF_RANGE")
        renderer.openPage(pageIndex).use { page ->
          checkCancellation(taskId)
          prepareOpenPage(context, taskId, pageIndex, page, started)
        }
      }
      val result = finishPreparedPage(taskId, pageIndex, script, prepared)
      validateExpectedSource(file, expectedSourceSha256)
      return result
    } finally {
      if (registered) registry.finish(taskId)
    }
  }

  fun cancel(taskId: String): Boolean {
    if (!isCanonicalPDFTaskId(taskId)) throw NativeException("PDF_RESULT_INVALID")
    return registry.cancel(taskId, "PDF_CANCELLED")
  }

  fun finish(taskId: String) = registry.finish(taskId)

  private fun prepareOpenPage(
    context: Context,
    taskId: String,
    pageIndex: Int,
    page: PdfRenderer.Page,
    started: Long,
  ): PreparedPDFPage {
    val embedded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      try {
        readEmbeddedText(page)
      } catch (_: OutOfMemoryError) {
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      } catch (error: NativeException) {
        if (error.code != "PDF_PAGE_EXTRACTION_FAILED") throw error
        return PreparedPDFPage.Failed(
          failedResult(
            pageIndex,
            listOf("PDF_PAGE_EXTRACTION_FAILED"),
            started,
          ),
        )
      } catch (_: Throwable) {
        ""
      }
    } else {
      ""
    }
    val nonWhitespace = pdfEmbeddedTextNonWhitespaceUTF16Count(embedded)
    if (nonWhitespace >= AndroidPDFResourcePolicy.minimumEmbeddedTextCharacters) {
      return PreparedPDFPage.Complete(
        completeResult(
          pageIndex = pageIndex,
          method = "embedded-text",
          engine = "pdf-renderer",
          revision = Build.VERSION.SDK_INT.toString(),
          text = embedded,
          blocks = emptyList(),
          warnings = emptyList(),
          started = started,
        ),
      )
    }

    val warnings = mutableListOf<String>()
    if (nonWhitespace > 0) warnings += "PDF_EMBEDDED_TEXT_SPARSE"
    warnings += "PDF_PAGE_OCR_FALLBACK"
    return try {
      renderPage(context, taskId, page, embedded, warnings, started)
    } catch (error: NativeException) {
      if (
        error.code == "PDF_CANCELLED" ||
        error.code == "RESOURCE_MEMORY_PRESSURE" ||
        error.code == "PDF_RESOURCE_BUSY"
      ) throw error
      warnings += "PDF_PAGE_EXTRACTION_FAILED"
      PreparedPDFPage.Failed(failedResult(pageIndex, warnings, started))
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } catch (_: Throwable) {
      warnings += "PDF_PAGE_EXTRACTION_FAILED"
      PreparedPDFPage.Failed(failedResult(pageIndex, warnings, started))
    }
  }

  private fun finishPreparedPage(
    taskId: String,
    pageIndex: Int,
    script: String,
    prepared: PreparedPDFPage,
  ): Map<String, Any> {
    when (prepared) {
      is PreparedPDFPage.Complete -> {
        checkCancellation(taskId)
        return prepared.result
      }
      is PreparedPDFPage.Failed -> {
        checkCancellation(taskId)
        return prepared.result
      }
      is PreparedPDFPage.Rendered -> {
        val warnings = prepared.warnings.toMutableList()
        try {
          // The bitmap is already detached from PdfRenderer at this point. Keep
          // the cancellation check inside the recycling boundary so a cancel
          // arriving between render completion and OCR cannot retain pixels.
          checkCancellation(taskId)
          val recognized = recognizeRenderedBitmap(
            taskId,
            prepared.bitmap,
            prepared.width,
            prepared.height,
            script,
          )
          val reconciledText = reconcilePDFSparseEmbeddedText(
            embedded = prepared.embeddedText,
            recognized = recognized.first,
          )
          if (reconciledText.isEmpty()) warnings += "PDF_PAGE_EMPTY"
          return completeResult(
            pageIndex = pageIndex,
            method = "rendered-ocr",
            engine = "ml-kit",
            revision = "16.0.1",
            text = reconciledText,
            blocks = recognized.second,
            warnings = warnings,
            started = prepared.started,
          )
        } catch (error: NativeException) {
          if (
            error.code == "PDF_CANCELLED" ||
            error.code == "RESOURCE_MEMORY_PRESSURE" ||
            error.code == "PDF_RESOURCE_BUSY"
          ) throw error
          warnings += "PDF_PAGE_EXTRACTION_FAILED"
          return failedResult(pageIndex, warnings, prepared.started)
        } catch (_: OutOfMemoryError) {
          throw NativeException("RESOURCE_MEMORY_PRESSURE")
        } catch (_: Throwable) {
          warnings += "PDF_PAGE_EXTRACTION_FAILED"
          return failedResult(pageIndex, warnings, prepared.started)
        } finally {
          prepared.bitmap.recycle()
        }
      }
    }
  }

  private fun renderPage(
    context: Context,
    taskId: String,
    page: PdfRenderer.Page,
    embeddedText: String,
    warnings: List<String>,
    started: Long,
  ): PreparedPDFPage.Rendered {
    val pixelLimit = if (
      context.getSystemService(ActivityManager::class.java)?.isLowRamDevice == true
    ) AndroidPDFResourcePolicy.lowRamMaximumRenderedPixels
    else AndroidPDFResourcePolicy.maximumRenderedPixels
    if (page.width <= 0 || page.height <= 0) {
      throw NativeException("PDF_PAGE_EXTRACTION_FAILED")
    }
    val scale = minOf(
      2.0,
      AndroidPDFResourcePolicy.maximumRenderedDimension.toDouble() /
        maxOf(page.width, page.height),
      sqrt(pixelLimit.toDouble() / (page.width.toDouble() * page.height.toDouble())),
    )
    val width = maxOf(1, ceil(page.width * scale).toInt())
    val height = maxOf(1, ceil(page.height * scale).toInt())
    if (
      width > AndroidPDFResourcePolicy.maximumRenderedDimension ||
      height > AndroidPDFResourcePolicy.maximumRenderedDimension ||
      width > pixelLimit / height
    ) throw NativeException("PDF_PAGE_EXTRACTION_FAILED")

    val bitmap = try {
      Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    var handedOff = false
    try {
      bitmap.eraseColor(Color.WHITE)
      page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
      checkCancellation(taskId)
      handedOff = true
      return PreparedPDFPage.Rendered(
        bitmap,
        width,
        height,
        embeddedText,
        warnings.toList(),
        started,
      )
    } finally {
      if (!handedOff) bitmap.recycle()
    }
  }

  private fun recognizeRenderedBitmap(
    taskId: String,
    bitmap: Bitmap,
    width: Int,
    height: Int,
    script: String,
  ): Pair<String, List<Map<String, Any>>> {
    val recognizer = if (script == "chinese") {
      TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    } else {
      TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }
    try {
      val result = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)))
      checkCancellation(taskId)
      val blocks = buildOCRBlocks(
        inputs = result.textBlocks.map { block ->
          OCRRecognizedBlockInput(
            text = normalizePDFText(block.text),
            bounds = block.boundingBox?.let { box ->
              OCRPixelBounds(box.left, box.top, box.width(), box.height())
            },
            confidences = block.lines.map { it.confidence.toDouble() },
            language = block.recognizedLanguage,
          )
        },
        outputWidth = width,
        outputHeight = height,
      )
      return blocks.joinToString("\n") { it.getValue("text") as String } to blocks
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
      throw NativeException(registry.failureCode(taskId) ?: "PDF_CANCELLED")
    } finally {
      recognizer.close()
    }
  }

  @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
  private fun readEmbeddedText(page: PdfRenderer.Page): String {
    val output = StringBuilder()
    for (content in page.textContents) {
      val text = normalizePDFText(content.text)
      val separator = if (output.isEmpty()) 0 else 1
      if (output.length > AndroidPDFResourcePolicy.maximumPageTextLength - separator - text.length) {
        throw NativeException("PDF_PAGE_EXTRACTION_FAILED")
      }
      if (separator == 1) output.append('\n')
      output.append(text)
    }
    return output.toString()
  }

  private fun checkCancellation(taskId: String) {
    registry.failureCode(taskId)?.let { throw NativeException(it) }
  }

  private fun validatedFile(context: Context, fileUri: String): File {
    val file = controlledSandboxFile(context, fileUri)
    if (file.length() > AndroidPDFResourcePolicy.maximumFileBytes) {
      throw NativeException("PDF_TOO_LARGE")
    }
    val preflight = try {
      hasValidPDFEnvelope(file) to hasPDFEncryptionMarker(file)
    } catch (_: IOException) {
      throw NativeException("PDF_CORRUPT")
    }
    if (!preflight.first) throw NativeException("PDF_CORRUPT")
    if (preflight.second) throw NativeException("PDF_ENCRYPTED")
    return file
  }

  private fun validateExpectedSource(file: File, expectedSourceSha256: String) {
    val actual = try {
      if (
        !CANONICAL_PDF_SHA256.matches(expectedSourceSha256) ||
        !file.isFile ||
        file.length() > AndroidPDFResourcePolicy.maximumFileBytes ||
        file.canonicalPath != file.absolutePath
      ) throw NativeException("PDF_RESULT_INVALID")
      sha256(file)
    } catch (error: NativeException) {
      throw error
    } catch (_: IOException) {
      throw NativeException("PDF_RESULT_INVALID")
    }
    if (actual != expectedSourceSha256) throw NativeException("PDF_RESULT_INVALID")
  }

  private fun validatePageCount(pageCount: Int) {
    if (pageCount <= 0) throw NativeException("PDF_EMPTY")
    if (pageCount > AndroidPDFResourcePolicy.maximumPages) {
      throw NativeException("PDF_TOO_MANY_PAGES")
    }
  }

  private inline fun <T> withRenderer(file: File, action: (PdfRenderer) -> T): T {
    val descriptor = try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (_: Exception) {
      throw NativeException("PDF_CORRUPT")
    }
    descriptor.use {
      val renderer = try {
        PdfRenderer(descriptor)
      } catch (_: SecurityException) {
        throw NativeException("PDF_ENCRYPTED")
      } catch (_: IOException) {
        throw NativeException("PDF_CORRUPT")
      } catch (_: IllegalArgumentException) {
        throw NativeException("PDF_CORRUPT")
      }
      renderer.use { return action(it) }
    }
  }

  private fun completeResult(
    pageIndex: Int,
    method: String,
    engine: String,
    revision: String,
    text: String,
    blocks: List<Map<String, Any>>,
    warnings: List<String>,
    started: Long,
  ): Map<String, Any> = mapOf(
    "schemaVersion" to 1,
    "pageIndex" to pageIndex,
    "method" to method,
    "engine" to engine,
    "revision" to revision,
    "durationMs" to (System.nanoTime() - started) / 1_000_000.0,
    "characterCount" to text.length,
    "warnings" to warnings,
    "status" to "complete",
    "text" to text,
    "blocks" to blocks,
  )

  private fun failedResult(
    pageIndex: Int,
    warnings: List<String>,
    started: Long,
  ): Map<String, Any> = mapOf(
    "schemaVersion" to 1,
    "pageIndex" to pageIndex,
    "method" to "rendered-ocr",
    "engine" to "ml-kit",
    "revision" to "16.0.1",
    "durationMs" to (System.nanoTime() - started) / 1_000_000.0,
    "characterCount" to 0,
    "warnings" to warnings.take(4),
    "status" to "failed",
    "errorCode" to "PDF_PAGE_EXTRACTION_FAILED",
  )
}

internal fun normalizePDFText(input: String): String {
  val normalizedLines = input.replace("\r\n", "\n").replace('\r', '\n')
  val output = StringBuilder(normalizedLines.length)
  var index = 0
  while (index < normalizedLines.length) {
    val current = normalizedLines[index]
    if (current.isHighSurrogate()) {
      if (
        index + 1 < normalizedLines.length &&
        normalizedLines[index + 1].isLowSurrogate()
      ) {
        output.append(current).append(normalizedLines[index + 1])
        index += 2
        continue
      }
      output.append('\uFFFD')
    } else if (current.isLowSurrogate() || isUnsafePDFControl(current.code)) {
      output.append('\uFFFD')
    } else {
      output.append(current)
    }
    index += 1
  }
  return output.toString()
}

internal fun pdfEmbeddedTextNonWhitespaceUTF16Count(input: String): Int {
  var count = 0
  var index = 0
  while (index < input.length) {
    val codePoint = input.codePointAt(index)
    val codeUnits = Character.charCount(codePoint)
    if (!isPDFDensityWhitespace(codePoint)) count += codeUnits
    index += codeUnits
  }
  return count
}

private fun isPDFDensityWhitespace(value: Int): Boolean =
  value == 0x0020 || value == 0x0085 || value == 0x00A0 || value == 0x1680 ||
    value in 0x0009..0x000D || value in 0x2000..0x200A ||
    value == 0x2028 || value == 0x2029 || value == 0x202F || value == 0x205F ||
    value == 0x3000

internal fun reconcilePDFSparseEmbeddedText(
  embedded: String,
  recognized: String,
): String {
  if (embedded.isEmpty()) return recognized
  if (recognized.isEmpty()) return embedded
  if (recognized.contains(embedded)) return recognized
  if (embedded.contains(recognized)) return embedded
  return "$embedded\n$recognized"
}

private fun isUnsafePDFControl(value: Int): Boolean =
  value <= 0x0008 || value == 0x000B || value == 0x000C ||
    value in 0x000E..0x001F || value in 0x007F..0x009F ||
    value in 0x202A..0x202E || value in 0x2066..0x2069

internal fun hasPDFEncryptionMarker(file: File): Boolean {
  RandomAccessFile(file, "r").use { input ->
    val tailLength = minOf(1_048_576L, input.length()).toInt()
    if (tailLength == 0) return false
    val tail = ByteArray(tailLength)
    input.seek(input.length() - tailLength)
    input.readFully(tail)
    val startXref = lastPDFKeyword(tail, "startxref", tail.size)
    if (startXref < 0) return false
    val xrefOffset = parseStartXrefOffset(tail, startXref) ?: return false
    if (xrefOffset < 0 || xrefOffset >= input.length()) return false
    val dictionaryLength = minOf(65_536L, input.length() - xrefOffset).toInt()
    val dictionary = ByteArray(dictionaryLength)
    input.seek(xrefOffset)
    input.readFully(dictionary)
    val dictionaryStart = skipPDFWhitespace(dictionary, 0, dictionary.size)
    if (isPDFKeywordAt(dictionary, dictionaryStart, "xref")) {
      val tailStartOffset = input.length() - tailLength
      val xrefStartInTail = if (xrefOffset <= tailStartOffset) {
        0
      } else {
        (xrefOffset - tailStartOffset).toInt()
      }
      val trailer = lastPDFKeyword(tail, "trailer", startXref)
      if (trailer < xrefStartInTail) return false
      return parseTopLevelPDFDictionary(
        tail,
        trailer + "trailer".length,
        startXref,
      )?.keys?.contains("Encrypt") == true
    }

    val xrefDictionary = parseTopLevelPDFDictionary(
      dictionary,
      0,
      dictionary.size,
    ) ?: return false
    return xrefDictionary.nameValues["Type"] == "XRef" &&
      xrefDictionary.keys.contains("Encrypt")
  }
}

private fun sha256(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().buffered().use { input ->
    val buffer = ByteArray(64 * 1_024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      digest.update(buffer, 0, count)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}

private fun parseStartXrefOffset(bytes: ByteArray, keyword: Int): Long? {
  var index = keyword + "startxref".length
  while (index < bytes.size && isPDFWhitespace(bytes[index].toInt() and 0xff)) index += 1
  val start = index
  while (index < bytes.size && bytes[index].toInt().toChar() in '0'..'9') index += 1
  if (index == start) return null
  return bytes.copyOfRange(start, index).toString(Charsets.US_ASCII).toLongOrNull()
}

private fun skipPDFWhitespace(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  val limit = minOf(end, bytes.size)
  while (index < limit && isPDFWhitespace(bytes[index].toInt() and 0xff)) index += 1
  return index
}

private fun isPDFKeywordAt(bytes: ByteArray, index: Int, keyword: String): Boolean {
  val token = keyword.toByteArray(Charsets.US_ASCII)
  return bytes.regionMatches(index, token) &&
    isPDFTokenBoundary(bytes, index - 1) &&
    isPDFTokenBoundary(bytes, index + token.size)
}

private fun lastPDFKeyword(bytes: ByteArray, keyword: String, before: Int): Int {
  val token = keyword.toByteArray(Charsets.US_ASCII)
  for (index in before - token.size downTo 0) {
    if (
      bytes.regionMatches(index, token) &&
      isPDFTokenBoundary(bytes, index - 1) &&
      isPDFTokenBoundary(bytes, index + token.size)
    ) return index
  }
  return -1
}

private fun ByteArray.regionMatches(start: Int, token: ByteArray): Boolean {
  if (start < 0 || start > size - token.size) return false
  for (index in token.indices) if (this[start + index] != token[index]) return false
  return true
}

private fun isPDFTokenBoundary(bytes: ByteArray, index: Int): Boolean =
  index !in bytes.indices || isPDFDelimiter(bytes[index].toInt() and 0xff)

private fun isPDFWhitespace(value: Int): Boolean =
  value == 0 || value == 9 || value == 10 || value == 12 || value == 13 || value == 32

private data class TopLevelPDFDictionary(
  val keys: Set<String>,
  val nameValues: Map<String, String>,
)

private data class ParsedPDFName(val value: String, val end: Int)

private data class ParsedPDFValue(val name: String?, val end: Int)

private fun parseTopLevelPDFDictionary(
  bytes: ByteArray,
  start: Int,
  end: Int,
): TopLevelPDFDictionary? {
  val limit = minOf(end, bytes.size)
  var index = firstPDFDictionaryStart(bytes, maxOf(0, start), limit)
  if (index < 0) return null
  index += 2
  val keys = linkedSetOf<String>()
  val nameValues = linkedMapOf<String, String>()
  while (index < limit) {
    index = skipPDFWhitespaceAndComments(bytes, index, limit)
    if (index + 1 < limit && bytes[index] == '>'.code.toByte() &&
      bytes[index + 1] == '>'.code.toByte()
    ) return TopLevelPDFDictionary(keys, nameValues)
    if (index >= limit) break
    if (bytes[index] != '/'.code.toByte()) {
      index = skipPDFValue(bytes, index, limit).end
      continue
    }
    val key = parsePDFName(bytes, index, limit) ?: return null
    keys += key.value
    index = skipPDFWhitespaceAndComments(bytes, key.end, limit)
    if (index + 1 < limit && bytes[index] == '>'.code.toByte() &&
      bytes[index + 1] == '>'.code.toByte()
    ) return TopLevelPDFDictionary(keys, nameValues)
    if (index >= limit) return TopLevelPDFDictionary(keys, nameValues)
    val value = skipPDFValue(bytes, index, limit)
    value.name?.let { nameValues[key.value] = it }
    index = value.end
  }
  return TopLevelPDFDictionary(keys, nameValues)
}

private fun firstPDFDictionaryStart(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  while (index + 1 < end) {
    when (bytes[index].toInt() and 0xff) {
      '%'.code -> index = skipPDFComment(bytes, index + 1, end)
      '('.code -> index = skipPDFLiteralString(bytes, index + 1, end)
      '<'.code -> {
        if (bytes[index + 1] == '<'.code.toByte()) return index
        index = skipPDFHexString(bytes, index + 1, end)
      }
      else -> index += 1
    }
  }
  return -1
}

private fun skipPDFWhitespaceAndComments(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  while (index < end) {
    while (index < end && isPDFWhitespace(bytes[index].toInt() and 0xff)) index += 1
    if (index >= end || bytes[index] != '%'.code.toByte()) return index
    index = skipPDFComment(bytes, index + 1, end)
  }
  return index
}

private fun skipPDFComment(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  while (index < end && bytes[index] != '\n'.code.toByte() && bytes[index] != '\r'.code.toByte()) {
    index += 1
  }
  return index
}

private fun skipPDFHexString(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  while (index < end && bytes[index] != '>'.code.toByte()) index += 1
  return minOf(index + 1, end)
}

private fun parsePDFName(bytes: ByteArray, start: Int, end: Int): ParsedPDFName? {
  if (start >= end || bytes[start] != '/'.code.toByte()) return null
  val decoded = ArrayList<Byte>()
  var index = start + 1
  while (index < end && !isPDFDelimiter(bytes[index].toInt() and 0xff)) {
    if (bytes[index] == '#'.code.toByte() && index + 2 < end) {
      val high = pdfHexValue(bytes[index + 1].toInt() and 0xff)
      val low = pdfHexValue(bytes[index + 2].toInt() and 0xff)
      if (high >= 0 && low >= 0) {
        decoded += ((high shl 4) or low).toByte()
        index += 3
        continue
      }
    }
    decoded += bytes[index]
    index += 1
  }
  return ParsedPDFName(decoded.toByteArray().toString(Charsets.ISO_8859_1), index)
}

private fun pdfHexValue(value: Int): Int = when (value) {
  in '0'.code..'9'.code -> value - '0'.code
  in 'A'.code..'F'.code -> value - 'A'.code + 10
  in 'a'.code..'f'.code -> value - 'a'.code + 10
  else -> -1
}

private fun skipPDFValue(bytes: ByteArray, start: Int, end: Int): ParsedPDFValue {
  if (start >= end) return ParsedPDFValue(null, end)
  return when (bytes[start].toInt() and 0xff) {
    '/'.code -> {
      val name = parsePDFName(bytes, start, end)
      if (name == null) ParsedPDFValue(null, minOf(start + 1, end))
      else ParsedPDFValue(name.value, name.end)
    }
    '('.code -> ParsedPDFValue(null, skipPDFLiteralString(bytes, start + 1, end))
    '<'.code -> {
      if (start + 1 < end && bytes[start + 1] == '<'.code.toByte()) {
        ParsedPDFValue(null, skipPDFComposite(bytes, start, end))
      } else {
        ParsedPDFValue(null, skipPDFHexString(bytes, start + 1, end))
      }
    }
    '['.code -> ParsedPDFValue(null, skipPDFComposite(bytes, start, end))
    else -> {
      var index = start
      while (index < end && !isPDFDelimiter(bytes[index].toInt() and 0xff)) index += 1
      ParsedPDFValue(null, if (index == start) minOf(index + 1, end) else index)
    }
  }
}

private fun skipPDFComposite(bytes: ByteArray, start: Int, end: Int): Int {
  val stack = ArrayDeque<Int>()
  var index = start
  if (bytes[index] == '['.code.toByte()) {
    stack.addLast(']'.code)
    index += 1
  } else {
    stack.addLast('>'.code)
    index += 2
  }
  while (index < end && stack.isNotEmpty()) {
    when (bytes[index].toInt() and 0xff) {
      '%'.code -> index = skipPDFComment(bytes, index + 1, end)
      '('.code -> index = skipPDFLiteralString(bytes, index + 1, end)
      '<'.code -> {
        if (index + 1 < end && bytes[index + 1] == '<'.code.toByte()) {
          stack.addLast('>'.code)
          index += 2
        } else {
          index = skipPDFHexString(bytes, index + 1, end)
        }
      }
      '['.code -> {
        stack.addLast(']'.code)
        index += 1
      }
      ']'.code -> {
        if (stack.lastOrNull() == ']'.code) stack.removeLast()
        index += 1
      }
      '>'.code -> {
        if (
          stack.lastOrNull() == '>'.code &&
          index + 1 < end && bytes[index + 1] == '>'.code.toByte()
        ) {
          stack.removeLast()
          index += 2
        } else index += 1
      }
      else -> index += 1
    }
  }
  return index
}

private fun skipPDFLiteralString(bytes: ByteArray, start: Int, end: Int): Int {
  var index = start
  var depth = 1
  while (index < end && depth > 0) {
    when (bytes[index].toInt() and 0xff) {
      '\\'.code -> index += 2
      '('.code -> {
        depth += 1
        index += 1
      }
      ')'.code -> {
        depth -= 1
        index += 1
      }
      else -> index += 1
    }
  }
  return index
}

internal fun hasValidPDFEnvelope(file: File): Boolean {
  if (file.length() < 8) return false
  RandomAccessFile(file, "r").use { input ->
    val headerLength = minOf(1_024L, input.length()).toInt()
    val header = ByteArray(headerLength)
    input.readFully(header)
    if (!header.toString(Charsets.ISO_8859_1).contains("%PDF-")) return false

    val tailLength = minOf(4_096L, input.length()).toInt()
    val tail = ByteArray(tailLength)
    input.seek(input.length() - tailLength)
    input.readFully(tail)
    val trailer = tail.toString(Charsets.ISO_8859_1)
    val startXref = trailer.lastIndexOf("startxref")
    val endOfFile = trailer.lastIndexOf("%%EOF")
    return startXref >= 0 && endOfFile > startXref
  }
}

private fun isPDFDelimiter(value: Int): Boolean =
  value == 0 || value == 9 || value == 10 || value == 12 || value == 13 || value == 32 ||
    value == '('.code || value == ')'.code || value == '<'.code || value == '>'.code ||
    value == '['.code || value == ']'.code || value == '{'.code || value == '}'.code ||
    value == '/'.code || value == '%'.code

private fun isCanonicalPDFTaskId(value: String): Boolean {
  if (value != value.lowercase()) return false
  val parsed = try { UUID.fromString(value) } catch (_: Exception) { return false }
  if (parsed.toString() != value) return false
  return value[14] in '1'..'5' && value[19] in setOf('8', '9', 'a', 'b')
}
