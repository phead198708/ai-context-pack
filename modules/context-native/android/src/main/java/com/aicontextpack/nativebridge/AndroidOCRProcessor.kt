package com.aicontextpack.nativebridge

import android.app.ActivityManager
import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.util.UUID

internal object AndroidOCRResourcePolicy {
  const val maximumPixelCount = 40_000_000
  const val lowRamMaximumPixelCount = 20_000_000
  const val maximumDimension = 12_000
  const val maximumFileBytes = 52_428_800L
  const val maximumBlocks = 10_000
  const val maximumTextLength = 1_000_000
  const val maximumBlockTextLength = 100_000

  fun validate(width: Int, height: Int, fileBytes: Long, pixelLimit: Int) {
    if (width <= 0 || height <= 0 || fileBytes < 0) {
      throw NativeException("OCR_IMAGE_DECODE_FAILED")
    }
    if (
      width > maximumDimension ||
      height > maximumDimension ||
      width > pixelLimit / height ||
      fileBytes > maximumFileBytes
    ) {
      throw NativeException("OCR_IMAGE_TOO_LARGE")
    }
  }
}

internal class OcrTaskRegistry {
  private var activeTaskId: String? = null
  private var cancelCode: String? = null
  private var memoryPressure = false

  @Synchronized
  fun begin(taskId: String) {
    if (activeTaskId != null) throw NativeException("OCR_RESOURCE_BUSY")
    if (memoryPressure) {
      memoryPressure = false
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    activeTaskId = taskId
    cancelCode = null
  }

  @Synchronized
  fun cancel(taskId: String): Boolean {
    if (activeTaskId == taskId) cancelCode = "OCR_CANCELLED"
    return true
  }

  @Synchronized
  fun failureCode(taskId: String): String? =
    cancelCode.takeIf { activeTaskId == taskId }

  @Synchronized
  fun finish(taskId: String) {
    if (activeTaskId != taskId) return
    activeTaskId = null
    cancelCode = null
  }

  @Synchronized
  fun setMemoryPressure(active: Boolean) {
    memoryPressure = active
    if (activeTaskId != null && active) cancelCode = "RESOURCE_MEMORY_PRESSURE"
  }
}

internal data class PreparedOCRTask(
  val taskId: String,
  val script: String,
  val recognitionLevel: String,
  val image: InputImage,
  val outputWidth: Int,
  val outputHeight: Int,
  val recognizer: TextRecognizer,
  val startedNanos: Long,
)

internal class AndroidOCRProcessor(
  private val registry: OcrTaskRegistry = OcrTaskRegistry(),
) {
  fun capabilities(context: Context): Map<String, Any> {
    val pixelLimit = pixelLimit(context)
    return mapOf(
      "schemaVersion" to 1,
      "engines" to listOf(
        mapOf(
          "engine" to "ml-kit-latin",
          "revision" to "16.0.1",
          "scripts" to listOf("latin"),
          "recognitionLevels" to listOf("accurate"),
          "ready" to true,
          "offline" to true,
        ),
        mapOf(
          "engine" to "ml-kit-chinese",
          "revision" to "16.0.1",
          "scripts" to listOf("chinese"),
          "recognitionLevels" to listOf("accurate"),
          "ready" to true,
          "offline" to true,
        ),
      ),
      "maximumPixelCount" to pixelLimit,
      "maximumDimension" to AndroidOCRResourcePolicy.maximumDimension,
    )
  }

  fun prepare(
    context: Context,
    taskId: String,
    fileUri: String,
    script: String,
    recognitionLevel: String,
  ): PreparedOCRTask {
    if (!isCanonicalTaskId(taskId) ||
      (script != "latin" && script != "chinese") ||
      recognitionLevel != "accurate"
    ) {
      throw NativeException("OCR_RESULT_INVALID")
    }
    registry.begin(taskId)
    try {
      val file = controlledFile(context, fileUri)
      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(file.path, options)
      AndroidOCRResourcePolicy.validate(
        width = options.outWidth,
        height = options.outHeight,
        fileBytes = file.length(),
        pixelLimit = pixelLimit(context),
      )
      val image = try {
        InputImage.fromFilePath(context, Uri.fromFile(file))
      } catch (_: OutOfMemoryError) {
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      } catch (_: Exception) {
        throw NativeException("OCR_IMAGE_DECODE_FAILED")
      }
      val rotated = image.rotationDegrees == 90 || image.rotationDegrees == 270
      val outputWidth = if (rotated) image.height else image.width
      val outputHeight = if (rotated) image.width else image.height
      val recognizer = if (script == "chinese") {
        TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
      } else {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      }
      return PreparedOCRTask(
        taskId = taskId,
        script = script,
        recognitionLevel = recognitionLevel,
        image = image,
        outputWidth = outputWidth,
        outputHeight = outputHeight,
        recognizer = recognizer,
        startedNanos = System.nanoTime(),
      )
    } catch (error: Throwable) {
      registry.finish(taskId)
      when (error) {
        is NativeException -> throw error
        is OutOfMemoryError -> throw NativeException("RESOURCE_MEMORY_PRESSURE")
        else -> throw NativeException("OCR_IMAGE_DECODE_FAILED")
      }
    }
  }

  fun result(task: PreparedOCRTask, value: Text): Map<String, Any> {
    registry.failureCode(task.taskId)?.let { throw NativeException(it) }
    if (value.textBlocks.size > AndroidOCRResourcePolicy.maximumBlocks) {
      throw NativeException("OCR_RESULT_INVALID")
    }
    val blocks = value.textBlocks.mapNotNull { block ->
      val box = block.boundingBox ?: return@mapNotNull null
      if (block.text.isEmpty()) return@mapNotNull null
      if (block.text.length > AndroidOCRResourcePolicy.maximumBlockTextLength) {
        throw NativeException("OCR_RESULT_INVALID")
      }
      val lines = block.lines.map { it.confidence }.filter { it.isFinite() && it >= 0 }
      val confidence = lines.takeIf { it.isNotEmpty() }?.average()
      buildMap<String, Any> {
        put("text", block.text)
        put(
          "bounds",
          OcrBoundsNormalizer.normalize(
            box.left,
            box.top,
            box.width(),
            box.height(),
            task.outputWidth,
            task.outputHeight,
          ),
        )
        confidence?.let { put("confidence", it.coerceIn(0.0, 1.0)) }
        block.recognizedLanguage
          .takeIf { it.isNotBlank() && it != "und" }
          ?.let { put("language", it) }
      }
    }.sortedWith(compareByReadingOrder())
    val text = blocks.joinToString("\n") { it.getValue("text") as String }
    if (text.length > AndroidOCRResourcePolicy.maximumTextLength) {
      throw NativeException("OCR_RESULT_INVALID")
    }
    val lowConfidence = blocks.any { block ->
      (block["confidence"] as? Double)?.let { it < 0.5 } == true
    }
    return mapOf(
      "schemaVersion" to 1,
      "text" to text,
      "blocks" to blocks,
      "durationMs" to (System.nanoTime() - task.startedNanos) / 1_000_000.0,
      "engine" to if (task.script == "chinese") "ml-kit-chinese" else "ml-kit-latin",
      "revision" to "16.0.1",
      "recognitionLevel" to task.recognitionLevel,
      "warnings" to if (lowConfidence) listOf("OCR_LOW_CONFIDENCE") else emptyList<String>(),
    )
  }

  fun cancel(taskId: String): Boolean {
    if (!isCanonicalTaskId(taskId)) throw NativeException("OCR_RESULT_INVALID")
    return registry.cancel(taskId)
  }

  fun failureCode(taskId: String): String? = registry.failureCode(taskId)

  fun finish(taskId: String) = registry.finish(taskId)

  fun setMemoryPressure(active: Boolean) = registry.setMemoryPressure(active)

  private fun controlledFile(context: Context, value: String): File {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") throw NativeException("INVALID_LOCAL_FILE_URI")
    val unresolved = File(uri.path ?: throw NativeException("INVALID_LOCAL_FILE_URI"))
    val mode = try { Os.lstat(unresolved.path).st_mode }
    catch (_: Exception) { throw NativeException("INVALID_LOCAL_FILE_URI") }
    if (OsConstants.S_ISLNK(mode)) throw NativeException("INVALID_LOCAL_FILE_URI")
    val candidate = try { unresolved.canonicalFile }
    catch (_: Exception) { throw NativeException("INVALID_LOCAL_FILE_URI") }
    val roots = listOf(context.filesDir, context.cacheDir).map(File::getCanonicalFile)
    if (!candidate.isFile || roots.none { candidate.path.startsWith(it.path + File.separator) }) {
      throw NativeException("INVALID_LOCAL_FILE_URI")
    }
    return candidate
  }

  private fun pixelLimit(context: Context): Int {
    val manager = context.getSystemService(ActivityManager::class.java)
    return if (manager?.isLowRamDevice == true) {
      AndroidOCRResourcePolicy.lowRamMaximumPixelCount
    } else {
      AndroidOCRResourcePolicy.maximumPixelCount
    }
  }
}

private fun compareByReadingOrder(): Comparator<Map<String, Any>> =
  Comparator { left, right ->
    @Suppress("UNCHECKED_CAST")
    val leftBounds = left.getValue("bounds") as Map<String, Double>
    @Suppress("UNCHECKED_CAST")
    val rightBounds = right.getValue("bounds") as Map<String, Double>
    val yDifference = leftBounds.getValue("y") - rightBounds.getValue("y")
    if (kotlin.math.abs(yDifference) > 0.01) {
      return@Comparator if (yDifference < 0) -1 else 1
    }
    leftBounds.getValue("x").compareTo(rightBounds.getValue("x"))
  }

private fun isCanonicalTaskId(value: String): Boolean {
  if (value != value.lowercase()) return false
  val parsed = try { UUID.fromString(value) } catch (_: Exception) { return false }
  if (parsed.toString() != value) return false
  return value[14] in '1'..'5' && value[19] in setOf('8', '9', 'a', 'b')
}
