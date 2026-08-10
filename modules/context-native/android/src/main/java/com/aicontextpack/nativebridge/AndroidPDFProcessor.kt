package com.aicontextpack.nativebridge

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import androidx.annotation.RequiresApi
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
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
  const val maximumXrefDictionaryBytes = 1_048_576
  const val maximumXrefRevisions = 64
  const val maximumXrefTerminatorBytes = 65_536
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

private data class AndroidPDFSourceSession(
  val taskId: String,
  val fileUri: String,
  val sourceSha256: String,
  val byteCount: Long,
  val pageCount: Int,
  val descriptor: ParcelFileDescriptor,
)

private data class ImmutablePDFSnapshot(
  val descriptor: ParcelFileDescriptor,
  val byteCount: Long,
  val sourceSha256: String,
)

internal class AndroidPDFProcessor(
  private val registry: OcrTaskRegistry = OcrTaskRegistry(),
) {
  private val sourceLock = Any()
  private var sourceSession: AndroidPDFSourceSession? = null

  fun inspect(context: Context, fileUri: String): Map<String, Any> {
    val source = openValidatedSource(context, fileUri, taskId = null)
    source.descriptor.use {
      return documentInfo(
        pageCount = source.pageCount,
        byteCount = source.byteCount,
        sourceSha256 = source.sourceSha256,
      )
    }
  }

  fun inspect(
    context: Context,
    taskId: String,
    fileUri: String,
    expectedSourceSha256: String,
    reserved: Boolean = false,
  ): Map<String, Any> {
    var registered = reserved
    var source: AndroidPDFSourceSession? = null
    try {
      if (!isCanonicalPDFTaskId(taskId) || !CANONICAL_PDF_SHA256.matches(expectedSourceSha256)) {
        throw NativeException("PDF_RESULT_INVALID")
      }
      if (!reserved) {
        reserve(taskId)
        registered = true
      }
      source = openValidatedSource(context, fileUri, taskId)
      if (source.sourceSha256 != expectedSourceSha256) {
        throw NativeException("PDF_RESULT_INVALID")
      }
      val retained = source
      synchronized(sourceLock) {
        if (sourceSession != null) throw NativeException("PDF_RESOURCE_BUSY")
        sourceSession = retained
      }
      source = null
      return documentInfo(retained.pageCount, retained.byteCount, retained.sourceSha256)
    } catch (error: Throwable) {
      source?.descriptor?.close()
      if (registered) registry.finish(taskId)
      throw error
    }
  }

  private fun documentInfo(
    pageCount: Int,
    byteCount: Long,
    sourceSha256: String,
  ): Map<String, Any> = mapOf(
    "schemaVersion" to 1,
    "pageCount" to pageCount,
    "byteCount" to byteCount,
    "sha256" to sourceSha256,
    "engine" to "pdf-renderer",
    "revision" to Build.VERSION.SDK_INT.toString(),
    "limit" to mapOf(
      "pages" to AndroidPDFResourcePolicy.maximumPages,
      "bytes" to AndroidPDFResourcePolicy.maximumFileBytes,
    ),
  )

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
    if (
      !isCanonicalPDFTaskId(taskId) ||
      pageIndex !in 0 until AndroidPDFResourcePolicy.maximumPages ||
      (script != "latin" && script != "chinese")
    ) throw NativeException("PDF_RESULT_INVALID")
    if (!reserved) throw NativeException("PDF_RESULT_INVALID")
    val source = sourceForTask(taskId, fileUri, expectedSourceSha256)
    validateSourceDescriptor(source)
    val started = System.nanoTime()
    val prepared = withRenderer(source.descriptor) { renderer ->
      if (renderer.pageCount != source.pageCount) throw NativeException("PDF_RESULT_INVALID")
      if (pageIndex >= source.pageCount) throw NativeException("PDF_PAGE_OUT_OF_RANGE")
      renderer.openPage(pageIndex).use { page ->
        checkCancellation(taskId)
        prepareOpenPage(context, taskId, pageIndex, page, started)
      }
    }
    val result = finishPreparedPage(taskId, pageIndex, script, prepared)
    validateSourceDescriptor(source)
    return result
  }

  fun validatePageRequest(
    taskId: String,
    fileUri: String,
    expectedSourceSha256: String,
  ) {
    sourceForTask(taskId, fileUri, expectedSourceSha256)
  }

  fun cancel(taskId: String): Boolean {
    if (!isCanonicalPDFTaskId(taskId)) throw NativeException("PDF_RESULT_INVALID")
    return registry.cancel(taskId, "PDF_CANCELLED")
  }

  fun finish(taskId: String) {
    closePDFSourceAndReleaseRegistry(
      closeSource = {
        synchronized(sourceLock) {
          val current = sourceSession?.takeIf { it.taskId == taskId }
          current?.descriptor?.close()
          if (sourceSession === current) sourceSession = null
        }
      },
      releaseRegistry = { registry.finish(taskId) },
    )
  }

  fun destroy(
    activeTaskId: String? = null,
    deferRegistryRelease: Boolean = activeTaskId != null,
  ) {
    val current = synchronized(sourceLock) {
      sourceSession.also { sourceSession = null }
    }
    current?.descriptor?.close()
    val registryTaskId = current?.taskId ?: activeTaskId
    if (registryTaskId != null) {
      registry.cancel(registryTaskId, "PDF_CANCELLED")
      // An active native operation owns the shared slot until it has actually
      // unwound. A mismatched request cannot operate on the retained session,
      // so it must never defer release of that session's actual registry owner.
      val activeOwnsRegistry = activeTaskId == registryTaskId
      if (!deferRegistryRelease || !activeOwnsRegistry) {
        registry.finish(registryTaskId)
      }
    }
  }

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
          val reconciledText = reconcilePDFSparseEmbeddedTextWithinLimit(
            embedded = prepared.embeddedText,
            recognized = recognized.first,
            maximumUTF16Length = AndroidPDFResourcePolicy.maximumPageTextLength,
          ) ?: run {
            warnings += "PDF_PAGE_EXTRACTION_FAILED"
            return failedResult(pageIndex, warnings, prepared.started)
          }
          if (reconciledText.isEmpty()) warnings += "PDF_PAGE_EMPTY"
          return completeResult(
            pageIndex = pageIndex,
            method = "rendered-ocr",
            engine = "ml-kit",
            revision = "16.0.1",
            text = reconciledText,
            blocks = recognized.second,
            embeddedText = prepared.embeddedText.takeIf {
              warnings.contains("PDF_EMBEDDED_TEXT_SPARSE")
            },
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

  private fun openValidatedSource(
    context: Context,
    fileUri: String,
    taskId: String?,
  ): AndroidPDFSourceSession {
    val file = controlledSandboxFile(context, fileUri)
    val snapshot = createImmutablePDFSnapshot(context, file, taskId)
    val descriptor = snapshot.descriptor
    try {
      val reader = DescriptorPDFReader(descriptor)
      reader.use {
        if (reader.length != snapshot.byteCount) throw NativeException("PDF_RESULT_INVALID")
        if (reader.length > AndroidPDFResourcePolicy.maximumFileBytes) {
          throw NativeException("PDF_TOO_LARGE")
        }
        val preflight = try {
          hasValidPDFEnvelope(reader) to hasPDFEncryptionMarker(reader) {
            taskId?.let(::checkCancellation)
          }
        } catch (_: IOException) {
          throw NativeException("PDF_CORRUPT")
        }
        if (!preflight.first) throw NativeException("PDF_CORRUPT")
        if (preflight.second) throw NativeException("PDF_ENCRYPTED")
        taskId?.let(::checkCancellation)
        val pageCount = withRenderer(descriptor) { renderer ->
          validatePageCount(renderer.pageCount)
          renderer.pageCount
        }
        val source = AndroidPDFSourceSession(
          taskId = taskId.orEmpty(),
          fileUri = fileUri,
          sourceSha256 = snapshot.sourceSha256,
          byteCount = reader.length,
          pageCount = pageCount,
          descriptor = descriptor,
        )
        validateSourceDescriptor(source)
        return source
      }
    } catch (error: Throwable) {
      descriptor.close()
      throw error
    }
  }

  private fun createImmutablePDFSnapshot(
    context: Context,
    file: File,
    taskId: String?,
  ): ImmutablePDFSnapshot {
    val source = try {
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (_: Exception) {
      throw NativeException("PDF_CORRUPT")
    }
    var snapshotFile: File? = null
    try {
      val initial = try { Os.fstat(source.fileDescriptor) }
      catch (_: Exception) { throw NativeException("PDF_CORRUPT") }
      if (!OsConstants.S_ISREG(initial.st_mode) || initial.st_size < 0) {
        throw NativeException("PDF_CORRUPT")
      }
      if (initial.st_size > AndroidPDFResourcePolicy.maximumFileBytes) {
        throw NativeException("PDF_TOO_LARGE")
      }
      snapshotFile = try {
        File.createTempFile("pdf-source-", ".bin", context.cacheDir)
      } catch (_: IOException) {
        throw NativeException("PDF_CORRUPT")
      }
      val digest = MessageDigest.getInstance("SHA-256")
      var copied = 0L
      try {
        ParcelFileDescriptor.AutoCloseInputStream(
          ParcelFileDescriptor.dup(source.fileDescriptor),
        ).use { input ->
          FileOutputStream(snapshotFile).use { output ->
            val buffer = ByteArray(64 * 1_024)
            while (copied < initial.st_size) {
              taskId?.let(::checkCancellation)
              val requested = minOf(buffer.size.toLong(), initial.st_size - copied).toInt()
              val count = input.read(buffer, 0, requested)
              if (count <= 0) throw IOException("Unexpected PDF EOF")
              output.write(buffer, 0, count)
              digest.update(buffer, 0, count)
              copied += count
            }
            if (input.read() != -1) throw IOException("PDF source grew during snapshot")
            output.fd.sync()
          }
        }
      } catch (error: NativeException) {
        throw error
      } catch (_: IOException) {
        throw NativeException("PDF_CORRUPT")
      }
      taskId?.let(::checkCancellation)
      val finalSource = try { Os.fstat(source.fileDescriptor) }
      catch (_: Exception) { throw NativeException("PDF_CORRUPT") }
      if (
        !OsConstants.S_ISREG(finalSource.st_mode) ||
        finalSource.st_size != initial.st_size ||
        finalSource.st_dev != initial.st_dev ||
        finalSource.st_ino != initial.st_ino
      ) throw NativeException("PDF_RESULT_INVALID")
      if (copied != initial.st_size) throw NativeException("PDF_RESULT_INVALID")

      val snapshotDescriptor = try {
        ParcelFileDescriptor.open(snapshotFile, ParcelFileDescriptor.MODE_READ_ONLY)
      } catch (_: Exception) {
        throw NativeException("PDF_CORRUPT")
      }
      // Unlink immediately so no pathname can mutate the retained descriptor.
      if (!snapshotFile.delete()) {
        snapshotDescriptor.close()
        throw NativeException("PDF_RESULT_INVALID")
      }
      snapshotFile = null
      val snapshotStat = try { Os.fstat(snapshotDescriptor.fileDescriptor) }
      catch (_: Exception) {
        snapshotDescriptor.close()
        throw NativeException("PDF_RESULT_INVALID")
      }
      if (
        !OsConstants.S_ISREG(snapshotStat.st_mode) ||
        snapshotStat.st_size != copied ||
        snapshotStat.st_nlink != 0L
      ) {
        snapshotDescriptor.close()
        throw NativeException("PDF_RESULT_INVALID")
      }
      return ImmutablePDFSnapshot(
        descriptor = snapshotDescriptor,
        byteCount = copied,
        sourceSha256 = digest.digest().joinToString("") { "%02x".format(it) },
      )
    } finally {
      source.close()
      snapshotFile?.delete()
    }
  }

  private fun sourceForTask(
    taskId: String,
    fileUri: String,
    expectedSourceSha256: String,
  ): AndroidPDFSourceSession = synchronized(sourceLock) {
    sourceSession?.takeIf {
      it.taskId == taskId &&
        it.fileUri == fileUri &&
        it.sourceSha256 == expectedSourceSha256
    } ?: throw NativeException("PDF_RESULT_INVALID")
  }

  private fun validateSourceDescriptor(source: AndroidPDFSourceSession) {
    val current = try { Os.fstat(source.descriptor.fileDescriptor) }
    catch (_: Exception) { throw NativeException("PDF_RESULT_INVALID") }
    if (
      !OsConstants.S_ISREG(current.st_mode) ||
      current.st_size != source.byteCount ||
      current.st_size > AndroidPDFResourcePolicy.maximumFileBytes ||
      current.st_nlink != 0L
    ) throw NativeException("PDF_RESULT_INVALID")
  }

  private fun validatePageCount(pageCount: Int) {
    if (pageCount <= 0) throw NativeException("PDF_EMPTY")
    if (pageCount > AndroidPDFResourcePolicy.maximumPages) {
      throw NativeException("PDF_TOO_MANY_PAGES")
    }
  }

  private inline fun <T> withRenderer(
    source: ParcelFileDescriptor,
    action: (PdfRenderer) -> T,
  ): T {
    val descriptor = try {
      ParcelFileDescriptor.dup(source.fileDescriptor)
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
    embeddedText: String? = null,
    warnings: List<String>,
    started: Long,
  ): Map<String, Any> = buildMap {
    put("schemaVersion", 1)
    put("pageIndex", pageIndex)
    put("method", method)
    put("engine", engine)
    put("revision", revision)
    put("durationMs", (System.nanoTime() - started) / 1_000_000.0)
    put("characterCount", text.length)
    put("warnings", warnings)
    put("status", "complete")
    put("text", text)
    put("blocks", blocks)
    if (embeddedText != null) put("embeddedText", embeddedText)
  }

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

internal fun closePDFSourceAndReleaseRegistry(
  closeSource: () -> Unit,
  releaseRegistry: () -> Unit,
) {
  try {
    closeSource()
  } finally {
    releaseRegistry()
  }
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
): String = checkNotNull(
  reconcilePDFSparseEmbeddedTextWithinLimit(
    embedded = embedded,
    recognized = recognized,
    maximumUTF16Length = Int.MAX_VALUE,
  ),
)

internal fun reconcilePDFSparseEmbeddedTextWithinLimit(
  embedded: String,
  recognized: String,
  maximumUTF16Length: Int,
): String? {
  if (maximumUTF16Length < 0) return null
  val densitySafeEmbedded = embedded.takeIf {
    pdfEmbeddedTextNonWhitespaceUTF16Count(it) > 0
  }.orEmpty()
  if (densitySafeEmbedded.isEmpty()) {
    return recognized.takeIf { it.length <= maximumUTF16Length }
  }
  if (recognized.isEmpty()) return embedded.takeIf { it.length <= maximumUTF16Length }
  if (densitySafeEmbedded == recognized) {
    return densitySafeEmbedded.takeIf { it.length <= maximumUTF16Length }
  }
  if (
    densitySafeEmbedded.length > maximumUTF16Length ||
    recognized.length >= maximumUTF16Length ||
    densitySafeEmbedded.length > maximumUTF16Length - recognized.length - 1
  ) return null
  return "$densitySafeEmbedded\n$recognized"
}

private interface PDFRandomAccessReader : Closeable {
  val length: Long
  @Throws(IOException::class)
  fun read(offset: Long, byteCount: Int): ByteArray
}

private class FilePDFReader(file: File) : PDFRandomAccessReader {
  private val input = RandomAccessFile(file, "r")
  override val length: Long get() = input.length()

  override fun read(offset: Long, byteCount: Int): ByteArray {
    if (offset < 0 || byteCount < 0 || offset > length) throw IOException("Invalid PDF range")
    val requested = minOf(byteCount.toLong(), length - offset).toInt()
    val output = ByteArray(requested)
    input.seek(offset)
    input.readFully(output)
    return output
  }

  override fun close() = input.close()
}

private class DescriptorPDFReader(
  descriptor: ParcelFileDescriptor,
) : PDFRandomAccessReader {
  private val input = ParcelFileDescriptor.AutoCloseInputStream(
    ParcelFileDescriptor.dup(descriptor.fileDescriptor),
  )
  private val channel = input.channel
  override val length: Long = channel.size()

  override fun read(offset: Long, byteCount: Int): ByteArray {
    if (offset < 0 || byteCount < 0 || offset > length) throw IOException("Invalid PDF range")
    val requested = minOf(byteCount.toLong(), length - offset).toInt()
    val buffer = ByteBuffer.allocate(requested)
    var consumed = 0
    while (consumed < requested) {
      val count = channel.read(buffer, offset + consumed)
      if (count < 0) throw IOException("Unexpected PDF EOF")
      if (count == 0) throw IOException("PDF read made no progress")
      consumed += count
    }
    return buffer.array()
  }

  override fun close() = input.close()
}

private fun isUnsafePDFControl(value: Int): Boolean =
  value <= 0x0008 || value == 0x000B || value == 0x000C ||
    value in 0x000E..0x001F || value in 0x007F..0x009F ||
    value in 0x202A..0x202E || value in 0x2066..0x2069

internal fun hasPDFEncryptionMarker(
  file: File,
  onWork: () -> Unit = {},
): Boolean = FilePDFReader(file).use { hasPDFEncryptionMarker(it, onWork) }

private fun hasPDFEncryptionMarker(
  input: PDFRandomAccessReader,
  onWork: () -> Unit = {},
): Boolean {
  val trailerWindow = AndroidPDFResourcePolicy.maximumXrefDictionaryBytes + 65_536L
  val tailLength = minOf(trailerWindow, input.length).toInt()
  if (tailLength == 0) throw IOException("Missing PDF trailer")
  val tail = input.read(input.length - tailLength, tailLength)
  val startXref = lastPDFKeyword(tail, "startxref", tail.size)
  if (startXref < 0) throw IOException("Missing PDF startxref")
  val tailStartOffset = input.length - tailLength
  val finalStartXrefOffset = tailStartOffset + startXref
  var revisionUpperBound = input.length
  var expectedStartXrefOffset: Long? = finalStartXrefOffset
  var xrefOffset = parseStartXrefOffset(tail, startXref)
    ?: throw IOException("Invalid PDF startxref")
  val visited = mutableSetOf<Long>()
  repeat(AndroidPDFResourcePolicy.maximumXrefRevisions) {
    onWork()
    if (
      xrefOffset < 0 ||
      xrefOffset >= revisionUpperBound ||
      !visited.add(xrefOffset)
    ) {
      throw IOException("PDF xref chain is invalid")
    }
    val revision = readXrefRevision(input, xrefOffset, revisionUpperBound, onWork)
    if (expectedStartXrefOffset != null && revision.startXrefOffset != expectedStartXrefOffset) {
      throw IOException("PDF final startxref marker is inconsistent")
    }
    val dictionary = revision.dictionary
    if (dictionary.keys.contains("Encrypt")) return true
    if (!dictionary.keys.contains("Prev")) return false
    if (
      dictionary.duplicateKeys.contains("Prev") ||
      dictionary.invalidDirectIntegerKeys.contains("Prev")
    ) {
      throw IOException("PDF Prev offset is invalid")
    }
    val previous = dictionary.integerValues["Prev"]
      ?: throw IOException("PDF Prev offset is invalid")
    if (previous >= xrefOffset) throw IOException("PDF Prev offset does not point backward")
    revisionUpperBound = xrefOffset
    expectedStartXrefOffset = null
    xrefOffset = previous
  }
  throw IOException("PDF xref chain exceeds its bounded parser policy")
}

private data class ParsedXrefDictionary(
  val dictionary: TopLevelPDFDictionary,
  val dictionaryEndOffset: Long,
)

private data class XrefRevision(
  val dictionary: TopLevelPDFDictionary,
  val startXrefOffset: Long,
)

private fun readXrefRevision(
  input: PDFRandomAccessReader,
  xrefOffset: Long,
  revisionUpperBound: Long,
  onWork: () -> Unit,
  structuralDepth: Int = 0,
): XrefRevision {
  onWork()
  if (structuralDepth >= AndroidPDFResourcePolicy.maximumXrefRevisions) {
    throw IOException("PDF xref structure exceeds its bounded parser policy")
  }
  val prefixLength = minOf(256L, input.length - xrefOffset).toInt()
  val prefix = input.read(xrefOffset, prefixLength)
  val dictionaryStart = skipPDFWhitespace(prefix, 0, prefix.size)
  if (isPDFKeywordAt(prefix, dictionaryStart, "xref")) {
    val parsed = readCompleteClassicTrailerDictionary(
      input,
      xrefOffset,
      revisionUpperBound,
      onWork,
    )
    return XrefRevision(
      dictionary = parsed.dictionary,
      startXrefOffset = readClassicRevisionTerminator(
        input = input,
        dictionaryEndOffset = parsed.dictionaryEndOffset,
        revisionUpperBound = revisionUpperBound,
        expectedXrefOffset = xrefOffset,
        onWork = onWork,
      ),
    )
  }

  val parsed = readCompleteXrefStreamDictionary(input, xrefOffset, onWork)
  val xrefDictionary = parsed.dictionary
  if (
    xrefDictionary.nameValues["Type"] != "XRef" ||
    xrefDictionary.duplicateKeys.contains("Type")
  ) {
    throw IOException("Active PDF object is not an xref stream")
  }
  return XrefRevision(
    dictionary = xrefDictionary,
    startXrefOffset = readXrefStreamRevisionTerminator(
      input = input,
      dictionary = xrefDictionary,
      dictionaryEndOffset = parsed.dictionaryEndOffset,
      revisionUpperBound = revisionUpperBound,
      expectedXrefOffset = xrefOffset,
      onWork = onWork,
      structuralDepth = structuralDepth,
    ),
  )
}

private fun readCompleteClassicTrailerDictionary(
  input: PDFRandomAccessReader,
  xrefOffset: Long,
  revisionUpperBound: Long,
  onWork: () -> Unit,
): ParsedXrefDictionary {
  if (revisionUpperBound <= xrefOffset) throw IOException("PDF xref bounds are invalid")
  val trailerOffset = findClassicTrailerOffset(input, xrefOffset, revisionUpperBound, onWork)
  val dictionaryOffset = trailerOffset + "trailer".length
  val windowLength = minOf(
    revisionUpperBound - dictionaryOffset,
    AndroidPDFResourcePolicy.maximumXrefDictionaryBytes.toLong(),
  ).toInt()
  if (windowLength <= 0) throw IOException("Missing PDF trailer dictionary")
  val bytes = input.read(dictionaryOffset, windowLength)
  val parsed = parseTopLevelPDFDictionary(
    bytes,
    0,
    bytes.size,
  ) ?: throw IOException("Missing PDF trailer dictionary")
  if (!parsed.complete) {
    throw IOException("PDF trailer dictionary exceeds its bounded parser policy")
  }
  return ParsedXrefDictionary(parsed, dictionaryOffset + parsed.endOffset)
}

private fun findClassicTrailerOffset(
  input: PDFRandomAccessReader,
  xrefOffset: Long,
  upperBound: Long,
  onWork: () -> Unit,
): Long {
  if (xrefOffset < 0 || upperBound <= xrefOffset || upperBound > input.length) {
    throw IOException("PDF xref revision bounds are invalid")
  }
  val chunkBytes = 65_536
  val keyword = "trailer"
  var cursor = xrefOffset
  var inComment = false
  var tokenStart = xrefOffset
  var tokenLength = 0
  var tokenMatches = true
  while (cursor < upperBound) {
    onWork()
    val requested = minOf(chunkBytes.toLong(), upperBound - cursor).toInt()
    val chunk = input.read(cursor, requested)
    if (chunk.isEmpty()) break
    chunk.forEachIndexed { chunkIndex, byte ->
      val absoluteOffset = cursor + chunkIndex
      val value = byte.toInt() and 0xff
      if (inComment) {
        if (value == '\n'.code || value == '\r'.code) inComment = false
        return@forEachIndexed
      }
      if (value == '%'.code) {
        if (tokenLength == keyword.length && tokenMatches) return tokenStart
        tokenLength = 0
        tokenMatches = true
        inComment = true
        return@forEachIndexed
      }
      if (isPDFDelimiter(value)) {
        if (tokenLength == keyword.length && tokenMatches) return tokenStart
        tokenLength = 0
        tokenMatches = true
        if (!isPDFWhitespace(value)) {
          throw IOException("Classic PDF xref table is malformed")
        }
        return@forEachIndexed
      }
      if (tokenLength == 0) tokenStart = absoluteOffset
      if (tokenLength >= keyword.length || value != keyword[tokenLength].code) tokenMatches = false
      tokenLength += 1
    }
    cursor += chunk.size
  }
  if (tokenLength == keyword.length && tokenMatches) return tokenStart
  throw IOException("Missing PDF trailer dictionary")
}

private fun readCompleteXrefStreamDictionary(
  input: PDFRandomAccessReader,
  xrefOffset: Long,
  onWork: () -> Unit,
): ParsedXrefDictionary {
  val available = input.length - xrefOffset
  val limit = minOf(
    available,
    AndroidPDFResourcePolicy.maximumXrefDictionaryBytes.toLong(),
  )
  val output = ByteArrayOutputStream(minOf(limit, 65_536L).toInt())
  var consumed = 0L
  while (consumed < limit) {
    onWork()
    val requested = minOf(65_536L, limit - consumed).toInt()
    val chunk = input.read(xrefOffset + consumed, requested)
    if (chunk.isEmpty()) break
    output.write(chunk)
    consumed += chunk.size
    val bytes = output.toByteArray()
    val parsed = parseTopLevelPDFDictionary(bytes, 0, bytes.size)
    if (parsed?.complete == true) {
      return ParsedXrefDictionary(parsed, xrefOffset + parsed.endOffset)
    }
  }
  throw IOException("PDF xref-stream dictionary exceeds its bounded parser policy")
}

private fun readClassicRevisionTerminator(
  input: PDFRandomAccessReader,
  dictionaryEndOffset: Long,
  revisionUpperBound: Long,
  expectedXrefOffset: Long,
  onWork: () -> Unit,
): Long {
  onWork()
  val suffix = readBoundedXrefSyntax(input, dictionaryEndOffset, revisionUpperBound)
  val marker = parseStartXrefTerminator(suffix, 0, expectedXrefOffset)
  return dictionaryEndOffset + marker
}

private fun readXrefStreamRevisionTerminator(
  input: PDFRandomAccessReader,
  dictionary: TopLevelPDFDictionary,
  dictionaryEndOffset: Long,
  revisionUpperBound: Long,
  expectedXrefOffset: Long,
  onWork: () -> Unit,
  structuralDepth: Int,
): Long {
  if (
    dictionary.duplicateKeys.contains("Length") ||
    dictionary.invalidDirectIntegerKeys.contains("Length")
  ) {
    throw IOException("PDF xref-stream length is invalid")
  }
  val header = readBoundedXrefSyntax(input, dictionaryEndOffset, revisionUpperBound)
  var index = skipPDFWhitespaceAndComments(header, 0, header.size)
  if (!isPDFKeywordAt(header, index, "stream")) throw IOException("Missing PDF xref stream")
  index += "stream".length
  index = consumeRequiredPDFLineEnding(header, index)
  val streamStartOffset = dictionaryEndOffset + index
  val streamLength = dictionary.integerValues["Length"]
  val previousXrefOffset = dictionary.integerValues["Prev"]?.takeIf { previous ->
    !dictionary.duplicateKeys.contains("Prev") &&
      !dictionary.invalidDirectIntegerKeys.contains("Prev") &&
      previous < expectedXrefOffset
  }
  val backwardIntegers = BackwardPDFIntegerResolver(
    input = input,
    upperBound = expectedXrefOffset,
    previousXrefOffset = previousXrefOffset,
    onWork = onWork,
    structuralDepth = structuralDepth,
  )
  if (streamLength == null) {
    val lengthReference = dictionary.indirectReferences["Length"]
      ?: throw IOException("PDF xref-stream length is invalid")
    val backwardLength = backwardIntegers.resolve(lengthReference.asForwardObjectKey())
    return findIndirectLengthXrefStreamTerminator(
      input = input,
      streamStartOffset = streamStartOffset,
      revisionUpperBound = revisionUpperBound,
      expectedXrefOffset = expectedXrefOffset,
      lengthReference = lengthReference,
      backwardLength = backwardLength,
      resolveBackwardInteger = backwardIntegers::resolve,
      onWork = onWork,
    )
  }
  val streamEndOffset = streamStartOffset + streamLength
  if (streamEndOffset < streamStartOffset || streamEndOffset >= revisionUpperBound) {
    throw IOException("PDF xref-stream bounds are invalid")
  }
  val suffix = readBoundedXrefSyntax(input, streamEndOffset, revisionUpperBound)
  val parsed = parseXrefStreamSuffix(
    suffix = suffix,
    start = 0,
    expectedXrefOffset = expectedXrefOffset,
    resolveBackwardInteger = backwardIntegers::resolve,
    onWork = onWork,
  )
  return streamEndOffset + parsed.marker
}

private data class ParsedXrefStreamSuffix(
  val marker: Int,
  val forwardLength: Long?,
)

private data class ForwardPDFObjectKey(
  val objectNumber: Long,
  val generation: Long,
)

private fun PDFIndirectReference.asForwardObjectKey(): ForwardPDFObjectKey =
  ForwardPDFObjectKey(objectNumber, generation)

private data class PendingForwardPDFStream(
  val lengthReference: ForwardPDFObjectKey,
  val streamStart: Int,
  val endstreamStart: Int,
)

private data class ParsedForwardPDFObjectSequence(
  val directIntegers: Map<ForwardPDFObjectKey, Long>,
  val end: Int,
)

private enum class ForwardPDFObjectSequenceTerminator {
  START_XREF,
  END_OF_INPUT,
}

private class ForwardPDFObjectParseBudget(
  var structuralCandidates: Int = 0,
)

private fun parseXrefStreamSuffix(
  suffix: ByteArray,
  start: Int,
  expectedXrefOffset: Long,
  lengthReference: PDFIndirectReference? = null,
  backwardLength: Long? = null,
  resolveBackwardInteger: (ForwardPDFObjectKey) -> Long? = { null },
  onWork: () -> Unit = {},
): ParsedXrefStreamSuffix {
  onWork()
  var index = consumeOptionalPDFLineEnding(suffix, start)
  if (!isPDFKeywordAt(suffix, index, "endstream")) throw IOException("Missing PDF endstream")
  index += "endstream".length
  index = skipPDFWhitespaceAndComments(suffix, index, suffix.size)
  if (!isPDFKeywordAt(suffix, index, "endobj")) throw IOException("Missing PDF endobj")
  index += "endobj".length
  val afterStreamObject = skipPDFWhitespaceAndComments(suffix, index, suffix.size)
  if (isPDFKeywordAt(suffix, afterStreamObject, "startxref")) {
    if (lengthReference != null && backwardLength == null) {
      throw IOException("Unresolved PDF xref-stream length")
    }
    return ParsedXrefStreamSuffix(
      marker = parseStartXrefTerminator(suffix, afterStreamObject, expectedXrefOffset),
      forwardLength = backwardLength,
    )
  }
  val forwardObjects = parseForwardXrefObjects(
    suffix,
    afterStreamObject,
    lengthReference,
    backwardLength,
    resolveBackwardInteger,
    onWork,
  )
  return ParsedXrefStreamSuffix(
    marker = parseStartXrefTerminator(suffix, forwardObjects.end, expectedXrefOffset),
    forwardLength = forwardObjects.xrefLength,
  )
}

private data class ParsedForwardXrefObjects(
  val xrefLength: Long?,
  val end: Int,
)

private fun parseForwardXrefObjects(
  bytes: ByteArray,
  start: Int,
  reference: PDFIndirectReference?,
  backwardLength: Long?,
  resolveBackwardInteger: (ForwardPDFObjectKey) -> Long?,
  onWork: () -> Unit,
): ParsedForwardXrefObjects {
  val lengthKey = reference?.asForwardObjectKey()
  val initialIntegers = if (backwardLength == null || lengthKey == null) {
    emptyMap()
  } else {
    mapOf(lengthKey to backwardLength)
  }
  val parsed = parseForwardPDFObjectSequence(
    bytes = bytes,
    start = start,
    directIntegers = initialIntegers,
    seenObjects = emptySet(),
    pendingStreams = emptyList(),
    objectCount = 0,
    budget = ForwardPDFObjectParseBudget(),
    terminator = ForwardPDFObjectSequenceTerminator.START_XREF,
    resolveBackwardInteger = resolveBackwardInteger,
    onWork = onWork,
  )
  if (parsed.size != 1) {
    throw IOException("Forward PDF xref-stream object sequence is ambiguous")
  }
  val result = parsed.single()
  val xrefLength = lengthKey?.let { key ->
    result.directIntegers[key]
      ?: resolveBackwardInteger(key)
      ?: throw IOException("Missing forward PDF xref-stream length object")
  }
  return ParsedForwardXrefObjects(
    xrefLength = xrefLength,
    end = result.end,
  )
}

private fun parseForwardPDFObjectSequence(
  bytes: ByteArray,
  start: Int,
  directIntegers: Map<ForwardPDFObjectKey, Long>,
  seenObjects: Set<ForwardPDFObjectKey>,
  pendingStreams: List<PendingForwardPDFStream>,
  objectCount: Int,
  budget: ForwardPDFObjectParseBudget,
  terminator: ForwardPDFObjectSequenceTerminator,
  resolveBackwardInteger: (ForwardPDFObjectKey) -> Long?,
  onWork: () -> Unit,
): List<ParsedForwardPDFObjectSequence> {
  onWork()
  var index = skipPDFWhitespaceAndComments(bytes, start, bytes.size)
  val reachedTerminator = when (terminator) {
    ForwardPDFObjectSequenceTerminator.START_XREF ->
      isPDFKeywordAt(bytes, index, "startxref")
    ForwardPDFObjectSequenceTerminator.END_OF_INPUT -> index == bytes.size
  }
  if (reachedTerminator) {
    val pendingValid = pendingStreams.all { pending ->
      val length = directIntegers[pending.lengthReference]
        ?: resolveBackwardInteger(pending.lengthReference)
        ?: return@all false
      matchesDeclaredForwardPDFStreamLength(
        bytes = bytes,
        streamStart = pending.streamStart,
        endstreamStart = pending.endstreamStart,
        declaredLength = length,
      )
    }
    return if (pendingValid) {
      listOf(ParsedForwardPDFObjectSequence(directIntegers, index))
    } else {
      emptyList()
    }
  }
  if (objectCount >= 256) {
    throw IOException("Too many forward PDF xref-stream objects")
  }
  val objectNumber = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size)
    ?: throw IOException("Invalid forward PDF indirect object number")
  index = skipPDFWhitespaceAndComments(bytes, objectNumber.end, bytes.size)
  val generation = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size)
    ?: throw IOException("Invalid forward PDF indirect object generation")
  index = skipPDFWhitespaceAndComments(bytes, generation.end, bytes.size)
  if (!isPDFKeywordAt(bytes, index, "obj")) {
    throw IOException("Invalid forward PDF indirect object header")
  }
  val objectKey = ForwardPDFObjectKey(objectNumber.value, generation.value)
  if (seenObjects.contains(objectKey)) {
    throw IOException("Duplicate forward PDF indirect object")
  }
  val updatedSeenObjects = seenObjects + objectKey
  index = skipPDFWhitespaceAndComments(bytes, index + "obj".length, bytes.size)
  val directInteger = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size)
  if (directInteger != null) {
    val afterInteger = skipPDFWhitespaceAndComments(bytes, directInteger.end, bytes.size)
    if (isPDFKeywordAt(bytes, afterInteger, "endobj")) {
      val updatedIntegers = directIntegers + (objectKey to directInteger.value)
      return parseForwardPDFObjectSequence(
        bytes = bytes,
        start = afterInteger + "endobj".length,
        directIntegers = updatedIntegers,
        seenObjects = updatedSeenObjects,
        pendingStreams = pendingStreams,
        objectCount = objectCount + 1,
        budget = budget,
        terminator = terminator,
        resolveBackwardInteger = resolveBackwardInteger,
        onWork = onWork,
      )
    }
  }

  val valueStart = index
  val indirectReference = parsePDFIndirectReference(bytes, valueStart, bytes.size)
  val value = skipPDFValue(bytes, valueStart, bytes.size)
  val valueEnd = indirectReference?.end ?: value.end
  if (
    valueEnd <= valueStart ||
    (indirectReference == null && !isCompletePDFIndirectObjectValue(bytes, valueStart, valueEnd))
  ) {
    throw IOException("Invalid forward PDF indirect object value")
  }
  index = skipPDFWhitespaceAndComments(bytes, valueEnd, bytes.size)
  if (isPDFKeywordAt(bytes, index, "stream")) {
    if (
      valueStart + 1 >= bytes.size ||
      bytes[valueStart] != '<'.code.toByte() ||
      bytes[valueStart + 1] != '<'.code.toByte()
    ) {
      throw IOException("Forward PDF stream object is missing a dictionary")
    }
    val dictionary = parseTopLevelPDFDictionary(bytes, valueStart, valueEnd)
      ?: throw IOException("Invalid forward PDF stream dictionary")
    if (
      !dictionary.complete ||
      dictionary.endOffset != valueEnd ||
      dictionary.duplicateKeys.contains("Length") ||
      dictionary.invalidDirectIntegerKeys.contains("Length")
    ) {
      throw IOException("Invalid forward PDF stream dictionary")
    }
    val streamStart = consumeRequiredPDFLineEnding(bytes, index + "stream".length)
    val directLength = dictionary.integerValues["Length"]
    val indirectLength = dictionary.indirectReferences["Length"]?.let {
      ForwardPDFObjectKey(it.objectNumber, it.generation)
    }
    if ((directLength == null) == (indirectLength == null)) {
      throw IOException("Invalid forward PDF stream length")
    }
    if (directLength != null) {
      val objectEnd = parseForwardPDFStreamObjectEnd(
        bytes = bytes,
        streamStart = streamStart,
        streamLength = directLength,
      )
      return parseForwardPDFObjectSequence(
        bytes = bytes,
        start = objectEnd,
        directIntegers = directIntegers,
        seenObjects = updatedSeenObjects,
        pendingStreams = pendingStreams,
        objectCount = objectCount + 1,
        budget = budget,
        terminator = terminator,
        resolveBackwardInteger = resolveBackwardInteger,
        onWork = onWork,
      )
    }
    val reference = checkNotNull(indirectLength)
    val resolvedLength = directIntegers[reference]
    if (resolvedLength != null) {
      val objectEnd = parseForwardPDFStreamObjectEnd(
        bytes = bytes,
        streamStart = streamStart,
        streamLength = resolvedLength,
      )
      return parseForwardPDFObjectSequence(
        bytes = bytes,
        start = objectEnd,
        directIntegers = directIntegers,
        seenObjects = updatedSeenObjects,
        pendingStreams = pendingStreams,
        objectCount = objectCount + 1,
        budget = budget,
        terminator = terminator,
        resolveBackwardInteger = resolveBackwardInteger,
        onWork = onWork,
      )
    }
    val results = mutableListOf<ParsedForwardPDFObjectSequence>()
    val keyword = "endstream".toByteArray(Charsets.US_ASCII)
    for (candidate in streamStart..bytes.size - keyword.size) {
      if ((candidate - streamStart) % 1_024 == 0) onWork()
      if (!isForwardPDFEndstreamAt(bytes, candidate)) continue
      budget.structuralCandidates += 1
      if (budget.structuralCandidates > 128) {
        throw IOException("Too many forward PDF stream candidates")
      }
      val objectEnd = try {
        parseForwardPDFStreamObjectEndAt(bytes, candidate)
      } catch (_: IOException) {
        continue
      }
      val branch = try {
        parseForwardPDFObjectSequence(
          bytes = bytes,
          start = objectEnd,
          directIntegers = directIntegers,
          seenObjects = updatedSeenObjects,
          pendingStreams = pendingStreams + PendingForwardPDFStream(
            lengthReference = reference,
            streamStart = streamStart,
            endstreamStart = candidate,
          ),
          objectCount = objectCount + 1,
          budget = budget,
          terminator = terminator,
          resolveBackwardInteger = resolveBackwardInteger,
          onWork = onWork,
        )
      } catch (_: IOException) {
        emptyList()
      }
      results += branch
      if (results.size > 1) return results.take(2)
    }
    return results
  }
  if (!isPDFKeywordAt(bytes, index, "endobj")) {
    throw IOException("Missing forward PDF endobj")
  }
  return parseForwardPDFObjectSequence(
    bytes = bytes,
    start = index + "endobj".length,
    directIntegers = directIntegers,
    seenObjects = updatedSeenObjects,
    pendingStreams = pendingStreams,
    objectCount = objectCount + 1,
    budget = budget,
    terminator = terminator,
    resolveBackwardInteger = resolveBackwardInteger,
    onWork = onWork,
  )
}

private fun parseForwardPDFStreamObjectEnd(
  bytes: ByteArray,
  streamStart: Int,
  streamLength: Long,
): Int {
  val declaredEnd = streamStart.toLong() + streamLength
  if (
    streamLength < 0 ||
    declaredEnd < streamStart ||
    declaredEnd > bytes.size.toLong()
  ) {
    throw IOException("Forward PDF stream bounds are invalid")
  }
  val endstreamStart = consumeOptionalPDFLineEnding(bytes, declaredEnd.toInt())
  return parseForwardPDFStreamObjectEndAt(bytes, endstreamStart)
}

private fun parseForwardPDFStreamObjectEndAt(bytes: ByteArray, endstreamStart: Int): Int {
  if (!isForwardPDFEndstreamAt(bytes, endstreamStart)) {
    throw IOException("Missing forward PDF endstream")
  }
  val index = skipPDFWhitespaceAndComments(
    bytes,
    endstreamStart + "endstream".length,
    bytes.size,
  )
  if (!isPDFKeywordAt(bytes, index, "endobj")) {
    throw IOException("Missing forward PDF endobj")
  }
  return index + "endobj".length
}

private fun isForwardPDFEndstreamAt(bytes: ByteArray, index: Int): Boolean {
  val keyword = "endstream".toByteArray(Charsets.US_ASCII)
  return bytes.regionMatches(index, keyword) && isPDFTokenBoundary(bytes, index + keyword.size)
}

private fun matchesDeclaredForwardPDFStreamLength(
  bytes: ByteArray,
  streamStart: Int,
  endstreamStart: Int,
  declaredLength: Long,
): Boolean {
  val declaredEnd = streamStart.toLong() + declaredLength
  if (
    declaredLength < 0 ||
    declaredEnd < streamStart ||
    declaredEnd > endstreamStart
  ) return false
  return when (endstreamStart - declaredEnd) {
    0L -> true
    1L -> {
      val separator = bytes[declaredEnd.toInt()].toInt() and 0xff
      separator == '\n'.code || separator == '\r'.code
    }
    2L -> bytes[declaredEnd.toInt()] == '\r'.code.toByte() &&
      bytes[declaredEnd.toInt() + 1] == '\n'.code.toByte()
    else -> false
  }
}

private fun isCompletePDFIndirectObjectValue(
  bytes: ByteArray,
  start: Int,
  end: Int,
): Boolean {
  if (start !in bytes.indices || end <= start || end > bytes.size) return false
  return when (bytes[start].toInt() and 0xff) {
    '/'.code -> parsePDFName(bytes, start, end)?.end == end
    '('.code -> bytes[end - 1] == ')'.code.toByte()
    '<'.code -> if (start + 1 < end && bytes[start + 1] == '<'.code.toByte()) {
      end - start >= 4 && bytes[end - 2] == '>'.code.toByte() &&
        bytes[end - 1] == '>'.code.toByte()
    } else {
      bytes[end - 1] == '>'.code.toByte()
    }
    '['.code -> bytes[end - 1] == ']'.code.toByte()
    else -> isPDFPrimitiveObjectToken(bytes, start, end)
  }
}

private fun isPDFPrimitiveObjectToken(bytes: ByteArray, start: Int, end: Int): Boolean {
  val token = bytes.copyOfRange(start, end).toString(Charsets.US_ASCII)
  if (token == "true" || token == "false" || token == "null") return true
  var index = 0
  if (token.firstOrNull() == '+' || token.firstOrNull() == '-') index += 1
  var digitCount = 0
  var decimalCount = 0
  while (index < token.length) {
    when (token[index]) {
      in '0'..'9' -> digitCount += 1
      '.' -> decimalCount += 1
      else -> return false
    }
    index += 1
  }
  return digitCount > 0 && decimalCount <= 1
}

private class BackwardPDFIntegerResolver(
  private val input: PDFRandomAccessReader,
  private val upperBound: Long,
  private val previousXrefOffset: Long?,
  private val onWork: () -> Unit,
  private val structuralDepth: Int,
) {
  private var scanned = false
  private val values = mutableMapOf<ForwardPDFObjectKey, Long>()

  fun resolve(reference: ForwardPDFObjectKey): Long? {
    onWork()
    scanIfNeeded()
    onWork()
    return values[reference]
  }

  private fun scanIfNeeded() {
    if (scanned) return
    if (upperBound < 0 || upperBound > input.length) {
      throw IOException("Backward PDF object bounds are invalid")
    }
    val maximumObjectBytes = AndroidPDFResourcePolicy.maximumXrefTerminatorBytes
    val windowStart = maxOf(0L, upperBound - maximumObjectBytes)
    val bytes = input.read(windowStart, (upperBound - windowStart).toInt())
    val candidateStarts = findForwardPDFObjectCandidateStarts(bytes, onWork)
    val currentRevisionStart = previousXrefOffset?.let { previous ->
      val previousTerminator = readXrefRevision(
        input = input,
        xrefOffset = previous,
        revisionUpperBound = upperBound,
        onWork = onWork,
        structuralDepth = structuralDepth + 1,
      ).startXrefOffset
      if (previousTerminator <= previous || previousTerminator >= upperBound) {
        throw IOException("Previous PDF revision terminator is invalid")
      }
      (previousTerminator - windowStart)
        .coerceIn(0L, bytes.size.toLong())
        .toInt()
    } ?: 0
    var authoritative: Map<ForwardPDFObjectKey, Long>? = null
    for (start in candidateStarts) {
      onWork()
      val parsed = parseBackwardPDFObjectSequenceCandidate(bytes, start, onWork)
      if (parsed != null) {
        authoritative = parsed
        break
      }
      // An older revision may contain many object headers before its xref syntax. Only the
      // Prev-bound completed-revision marker authorizes trying a later candidate. Once the
      // current revision begins, a malformed leading object fails closed instead of letting a
      // shorter scalar-only suffix hide it.
      if (start >= currentRevisionStart) break
    }
    authoritative?.let(values::putAll)
    scanned = true
  }
}

private fun parseBackwardPDFObjectSequenceCandidate(
  bytes: ByteArray,
  start: Int,
  onWork: () -> Unit,
): Map<ForwardPDFObjectKey, Long>? {
  var workFailure: Throwable? = null
  val guardedWork = {
    try {
      onWork()
    } catch (error: Throwable) {
      workFailure = error
      throw error
    }
  }
  val parsed = try {
    parseForwardPDFObjectSequence(
      bytes = bytes,
      start = start,
      directIntegers = emptyMap(),
      seenObjects = emptySet(),
      pendingStreams = emptyList(),
      objectCount = 0,
      budget = ForwardPDFObjectParseBudget(),
      terminator = ForwardPDFObjectSequenceTerminator.END_OF_INPUT,
      resolveBackwardInteger = { null },
      onWork = guardedWork,
    )
  } catch (_: IOException) {
    workFailure?.let { throw it }
    emptyList()
  }
  workFailure?.let { throw it }
  if (parsed.size > 1) {
    throw IOException("Backward PDF object sequence is ambiguous")
  }
  return parsed.singleOrNull()?.directIntegers
}

private fun findForwardPDFObjectCandidateStarts(
  bytes: ByteArray,
  onWork: () -> Unit,
): List<Int> {
  val starts = mutableListOf<Int>()
  var start = 0
  while (start < bytes.size) {
    if (start % 1_024 == 0) onWork()
    if (
      isForwardPDFObjectHeaderAt(bytes, start) &&
      !isInsidePDFLineComment(bytes, start, onWork)
    ) {
      starts += start
      if (starts.size > 384) throw IOException("Too many backward PDF object headers")
    }
    start += 1
  }
  onWork()
  return starts
}

private fun isInsidePDFLineComment(
  bytes: ByteArray,
  end: Int,
  onWork: () -> Unit,
): Boolean {
  var start = end.coerceIn(0, bytes.size)
  while (start > 0) {
    if ((end - start) % 1_024 == 0) onWork()
    val previous = bytes[start - 1].toInt() and 0xff
    if (previous == '\n'.code || previous == '\r'.code) break
    start -= 1
  }
  var literalDepth = 0
  var inHexString = false
  var escapedLiteralByte = false
  while (start < end) {
    if (start % 1_024 == 0) onWork()
    val value = bytes[start].toInt() and 0xff
    when {
      literalDepth > 0 -> when {
        escapedLiteralByte -> escapedLiteralByte = false
        value == '\\'.code -> escapedLiteralByte = true
        value == '('.code -> literalDepth += 1
        value == ')'.code -> literalDepth -= 1
      }
      inHexString -> if (value == '>'.code) inHexString = false
      value == '%'.code -> return true
      value == '('.code -> literalDepth = 1
      value == '<'.code &&
        bytes.getOrNull(start - 1) != '<'.code.toByte() &&
        bytes.getOrNull(start + 1) != '<'.code.toByte() -> inHexString = true
    }
    start += 1
  }
  return false
}

private fun isForwardPDFObjectHeaderAt(
  bytes: ByteArray,
  start: Int,
): Boolean {
  if (!isPDFTokenBoundary(bytes, start - 1)) return false
  var index = start
  val objectNumber = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size) ?: return false
  index = skipPDFWhitespaceAndComments(bytes, objectNumber.end, bytes.size)
  val generation = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size) ?: return false
  index = skipPDFWhitespaceAndComments(bytes, generation.end, bytes.size)
  return isPDFKeywordAt(bytes, index, "obj")
}

private fun findIndirectLengthXrefStreamTerminator(
  input: PDFRandomAccessReader,
  streamStartOffset: Long,
  revisionUpperBound: Long,
  expectedXrefOffset: Long,
  lengthReference: PDFIndirectReference,
  backwardLength: Long?,
  resolveBackwardInteger: (ForwardPDFObjectKey) -> Long?,
  onWork: () -> Unit,
): Long {
  if (
    streamStartOffset < 0 ||
    streamStartOffset >= revisionUpperBound ||
    revisionUpperBound > input.length
  ) {
    throw IOException("PDF xref-stream bounds are invalid")
  }
  val keyword = "endstream".toByteArray(Charsets.US_ASCII)
  val maximumCandidates = 128
  var candidateCount = 0
  var validMarkerOffset: Long? = null
  var carry = ByteArray(0)
  var cursor = streamStartOffset
  while (cursor < revisionUpperBound) {
    onWork()
    val requested = minOf(65_536L, revisionUpperBound - cursor).toInt()
    val chunk = input.read(cursor, requested)
    if (chunk.isEmpty()) break
    val window = carry + chunk
    val windowOffset = cursor - carry.size
    for (candidateIndex in 0..window.size - keyword.size) {
      if (candidateIndex % 1_024 == 0) onWork()
      if (!window.regionMatches(candidateIndex, keyword)) continue
      val candidateOffset = windowOffset + candidateIndex
      if (candidateOffset < streamStartOffset || candidateOffset >= revisionUpperBound) continue
      candidateCount += 1
      if (candidateCount > maximumCandidates) {
        throw IOException("PDF xref stream has too many structural candidates")
      }
      val suffix = readBoundedXrefSyntax(input, candidateOffset, revisionUpperBound)
      val parsed = try {
        parseXrefStreamSuffix(
          suffix,
          0,
          expectedXrefOffset,
          lengthReference,
          backwardLength,
          resolveBackwardInteger,
          onWork,
        )
      } catch (_: IOException) {
        continue
      }
      if (
        parsed.forwardLength != null &&
        !matchesDeclaredXrefStreamLength(
          input,
          streamStartOffset,
          candidateOffset,
          parsed.forwardLength,
        )
      ) continue
      val absoluteMarker = candidateOffset + parsed.marker
      if (validMarkerOffset != null && validMarkerOffset != absoluteMarker) {
        throw IOException("PDF xref-stream terminator is ambiguous")
      }
      validMarkerOffset = absoluteMarker
    }
    val carrySize = minOf(keyword.size - 1, window.size)
    carry = window.copyOfRange(window.size - carrySize, window.size)
    cursor += chunk.size
  }
  return validMarkerOffset ?: throw IOException("Missing PDF xref-stream terminator")
}

private fun matchesDeclaredXrefStreamLength(
  input: PDFRandomAccessReader,
  streamStartOffset: Long,
  endstreamOffset: Long,
  declaredLength: Long,
): Boolean {
  val declaredEnd = streamStartOffset + declaredLength
  if (declaredLength < 0 || declaredEnd < streamStartOffset || declaredEnd > endstreamOffset) {
    return false
  }
  return when (endstreamOffset - declaredEnd) {
    0L -> true
    1L -> {
      val separator = input.read(declaredEnd, 1).single().toInt() and 0xff
      separator == '\n'.code || separator == '\r'.code
    }
    2L -> input.read(declaredEnd, 2).contentEquals(
      byteArrayOf('\r'.code.toByte(), '\n'.code.toByte()),
    )
    else -> false
  }
}

private fun readBoundedXrefSyntax(
  input: PDFRandomAccessReader,
  offset: Long,
  upperBound: Long,
): ByteArray {
  if (offset < 0 || upperBound <= offset || upperBound > input.length) {
    throw IOException("PDF xref syntax bounds are invalid")
  }
  val length = minOf(
    upperBound - offset,
    AndroidPDFResourcePolicy.maximumXrefTerminatorBytes.toLong(),
  ).toInt()
  return input.read(offset, length)
}

private fun parseStartXrefTerminator(
  bytes: ByteArray,
  start: Int,
  expectedXrefOffset: Long,
): Int {
  var index = skipPDFWhitespaceAndComments(bytes, start, bytes.size)
  val marker = index
  if (!isPDFKeywordAt(bytes, index, "startxref")) throw IOException("Missing PDF startxref")
  index += "startxref".length
  index = skipPDFWhitespace(bytes, index, bytes.size)
  val parsedOffset = parsePDFNonNegativeIntegerToken(bytes, index, bytes.size)
    ?: throw IOException("Invalid PDF startxref")
  if (parsedOffset.value != expectedXrefOffset) {
    throw IOException("PDF startxref target is inconsistent")
  }
  index = skipPDFWhitespace(bytes, parsedOffset.end, bytes.size)
  if (!bytes.regionMatches(index, "%%EOF".toByteArray(Charsets.US_ASCII))) {
    throw IOException("Missing PDF EOF marker")
  }
  return marker
}

private fun consumeRequiredPDFLineEnding(bytes: ByteArray, start: Int): Int {
  if (start >= bytes.size) throw IOException("Missing PDF stream line ending")
  return when (bytes[start].toInt() and 0xff) {
    '\n'.code -> start + 1
    '\r'.code -> if (start + 1 < bytes.size && bytes[start + 1] == '\n'.code.toByte()) start + 2 else start + 1
    else -> throw IOException("Missing PDF stream line ending")
  }
}

private fun consumeOptionalPDFLineEnding(bytes: ByteArray, start: Int): Int {
  if (start >= bytes.size) return start
  return when (bytes[start].toInt() and 0xff) {
    '\n'.code -> start + 1
    '\r'.code -> if (start + 1 < bytes.size && bytes[start + 1] == '\n'.code.toByte()) start + 2 else start + 1
    else -> start
  }
}

private fun parseStartXrefOffset(bytes: ByteArray, keyword: Int): Long? {
  var index = keyword + "startxref".length
  while (index < bytes.size && isPDFWhitespace(bytes[index].toInt() and 0xff)) index += 1
  return parsePDFNonNegativeIntegerToken(bytes, index, bytes.size)?.value
}

private data class ParsedPDFInteger(val value: Long, val end: Int)

private fun parsePDFNonNegativeIntegerToken(
  bytes: ByteArray,
  start: Int,
  end: Int,
): ParsedPDFInteger? {
  val limit = minOf(end, bytes.size)
  if (start >= limit) return null
  var index = start
  if (bytes[index] == '+'.code.toByte()) index += 1
  val digitsStart = index
  while (index < limit && bytes[index].toInt().toChar() in '0'..'9') index += 1
  if (index == digitsStart || !isPDFTokenBoundary(bytes, index)) return null
  val value = bytes.copyOfRange(start, index)
    .toString(Charsets.US_ASCII)
    .toLongOrNull()
    ?: return null
  return ParsedPDFInteger(value, index)
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
  val duplicateKeys: Set<String>,
  val nameValues: Map<String, String>,
  val integerValues: Map<String, Long>,
  val indirectReferences: Map<String, PDFIndirectReference>,
  val invalidDirectIntegerKeys: Set<String>,
  val complete: Boolean,
  val endOffset: Int,
)

private data class ParsedPDFName(val value: String, val end: Int)

private data class PDFIndirectReference(
  val objectNumber: Long,
  val generation: Long,
  val end: Int,
)

private data class ParsedPDFValue(
  val name: String?,
  val integer: Long?,
  val end: Int,
)

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
  val duplicateKeys = linkedSetOf<String>()
  val nameValues = linkedMapOf<String, String>()
  val integerValues = linkedMapOf<String, Long>()
  val indirectReferences = linkedMapOf<String, PDFIndirectReference>()
  val invalidDirectIntegerKeys = linkedSetOf<String>()
  while (index < limit) {
    index = skipPDFWhitespaceAndComments(bytes, index, limit)
    if (index + 1 < limit && bytes[index] == '>'.code.toByte() &&
      bytes[index + 1] == '>'.code.toByte()
    ) return TopLevelPDFDictionary(
      keys,
      duplicateKeys,
      nameValues,
      integerValues,
      indirectReferences,
      invalidDirectIntegerKeys,
      complete = true,
      endOffset = index + 2,
    )
    if (index >= limit) break
    if (bytes[index] != '/'.code.toByte()) {
      index = skipPDFValue(bytes, index, limit).end
      continue
    }
    val key = parsePDFName(bytes, index, limit) ?: return null
    if (!keys.add(key.value)) duplicateKeys += key.value
    index = skipPDFWhitespaceAndComments(bytes, key.end, limit)
    if (index + 1 < limit && bytes[index] == '>'.code.toByte() &&
      bytes[index + 1] == '>'.code.toByte()
    ) {
      if (key.value == "Prev" || key.value == "Length") invalidDirectIntegerKeys += key.value
      return TopLevelPDFDictionary(
        keys,
        duplicateKeys,
        nameValues,
        integerValues,
        indirectReferences,
        invalidDirectIntegerKeys,
        complete = true,
        endOffset = index + 2,
      )
    }
    if (index >= limit) {
      if (key.value == "Prev" || key.value == "Length") invalidDirectIntegerKeys += key.value
      return TopLevelPDFDictionary(
        keys,
        duplicateKeys,
        nameValues,
        integerValues,
        indirectReferences,
        invalidDirectIntegerKeys,
        complete = false,
        endOffset = limit,
      )
    }
    val value = skipPDFValue(bytes, index, limit)
    value.name?.let { nameValues[key.value] = it }
    val indirectReference = value.integer?.let {
      parsePDFIndirectReference(bytes, index, limit)
    }
    val valueEnd = indirectReference?.end ?: value.end
    val next = skipPDFWhitespaceAndComments(bytes, valueEnd, limit)
    val directValueComplete = next >= limit ||
      bytes[next] == '/'.code.toByte() ||
      (next + 1 < limit && bytes[next] == '>'.code.toByte() && bytes[next + 1] == '>'.code.toByte())
    if (key.value == "Length" && indirectReference != null && directValueComplete) {
      indirectReferences[key.value] = indirectReference
    } else if (value.integer != null && indirectReference == null && directValueComplete) {
      integerValues[key.value] = value.integer
    } else if (key.value == "Prev" || key.value == "Length") {
      invalidDirectIntegerKeys += key.value
    }
    index = valueEnd
  }
  return TopLevelPDFDictionary(
    keys,
    duplicateKeys,
    nameValues,
    integerValues,
    indirectReferences,
    invalidDirectIntegerKeys,
    complete = false,
    endOffset = limit,
  )
}

private fun parsePDFIndirectReference(
  bytes: ByteArray,
  start: Int,
  end: Int,
): PDFIndirectReference? {
  val objectNumber = skipPDFValue(bytes, start, end)
  val parsedObjectNumber = objectNumber.integer ?: return null
  var index = skipPDFWhitespaceAndComments(bytes, objectNumber.end, end)
  val generation = skipPDFValue(bytes, index, end)
  val parsedGeneration = generation.integer ?: return null
  index = skipPDFWhitespaceAndComments(bytes, generation.end, end)
  if (!isPDFKeywordAt(bytes, index, "R")) return null
  return PDFIndirectReference(
    objectNumber = parsedObjectNumber,
    generation = parsedGeneration,
    end = index + 1,
  )
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
  if (start >= end) return ParsedPDFValue(null, null, end)
  return when (bytes[start].toInt() and 0xff) {
    '/'.code -> {
      val name = parsePDFName(bytes, start, end)
      if (name == null) ParsedPDFValue(null, null, minOf(start + 1, end))
      else ParsedPDFValue(name.value, null, name.end)
    }
    '('.code -> ParsedPDFValue(null, null, skipPDFLiteralString(bytes, start + 1, end))
    '<'.code -> {
      if (start + 1 < end && bytes[start + 1] == '<'.code.toByte()) {
        ParsedPDFValue(null, null, skipPDFComposite(bytes, start, end))
      } else {
        ParsedPDFValue(null, null, skipPDFHexString(bytes, start + 1, end))
      }
    }
    '['.code -> ParsedPDFValue(null, null, skipPDFComposite(bytes, start, end))
    else -> {
      var index = start
      while (index < end && !isPDFDelimiter(bytes[index].toInt() and 0xff)) index += 1
      val valueEnd = if (index == start) minOf(index + 1, end) else index
      val integer = bytes.copyOfRange(start, valueEnd).toString(Charsets.US_ASCII)
        .takeIf { token ->
          token.isNotEmpty() && (
            token.all { it in '0'..'9' } ||
              (token[0] == '+' && token.length > 1 && token.drop(1).all { it in '0'..'9' })
            )
        }
        ?.toLongOrNull()
      ParsedPDFValue(null, integer, valueEnd)
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

internal fun hasValidPDFEnvelope(file: File): Boolean =
  FilePDFReader(file).use(::hasValidPDFEnvelope)

private fun hasValidPDFEnvelope(input: PDFRandomAccessReader): Boolean {
    if (input.length < 8) return false
    val headerLength = minOf(1_024L, input.length).toInt()
    val header = input.read(0, headerLength)
    if (!header.toString(Charsets.ISO_8859_1).contains("%PDF-")) return false

    val tailLength = minOf(4_096L, input.length).toInt()
    val tail = input.read(input.length - tailLength, tailLength)
    val trailer = tail.toString(Charsets.ISO_8859_1)
    val startXref = trailer.lastIndexOf("startxref")
    val endOfFile = trailer.lastIndexOf("%%EOF")
    return startXref >= 0 && endOfFile > startXref
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
