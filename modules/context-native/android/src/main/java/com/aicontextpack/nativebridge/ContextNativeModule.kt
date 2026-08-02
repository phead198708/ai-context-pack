package com.aicontextpack.nativebridge

import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File

class ContextNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ContextNative")

    AsyncFunction("scanInbox") {
      val context = appContext.reactContext ?: throw NativeException("CONTEXT_UNAVAILABLE")
      val inbox = File(context.filesDir, "Inbox")
      InboxManifestScanner.scan(inbox)
    }

    AsyncFunction("recognizeText") { fileUri: String, script: String, promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      val uri = controlledFileUri(fileUri)
      val started = System.nanoTime()
      val image = try { InputImage.fromFilePath(context, uri) } catch (_: Exception) { return@AsyncFunction promise.reject(NativeException("OCR_IMAGE_DECODE_FAILED")) }
      val recognizer = if (script == "chinese") TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) else TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      recognizer.process(image)
        .addOnSuccessListener { result -> promise.resolve(ocrResult(result, image.width, image.height, script, started)) }
        .addOnFailureListener { promise.reject(NativeException("OCR_RECOGNITION_FAILED")) }
        .addOnCompleteListener { recognizer.close() }
    }

    AsyncFunction("probePdf") { fileUri: String ->
      val file = File(controlledFileUri(fileUri).path ?: throw NativeException("INVALID_LOCAL_FILE_URI"))
      if (!file.isFile || file.length() > 52_428_800) throw NativeException("PDF_INVALID_OR_TOO_LARGE")
      val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
      PdfProbe.probe(descriptor)
    }
  }

  private fun controlledFileUri(value: String): Uri {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") throw NativeException("INVALID_LOCAL_FILE_URI")
    return uri
  }

  private fun ocrResult(result: Text, sourceWidth: Int, sourceHeight: Int, script: String, started: Long): Map<String, Any> {
    val width = sourceWidth.coerceAtLeast(1)
    val height = sourceHeight.coerceAtLeast(1)
    val blocks = result.textBlocks.mapNotNull { block -> block.boundingBox?.let { box -> mapOf("text" to block.text, "bounds" to OcrBoundsNormalizer.normalize(box.left, box.top, box.width(), box.height(), width, height)) } }
    return mapOf("schemaVersion" to 1, "text" to result.text, "blocks" to blocks,
      "durationMs" to (System.nanoTime() - started) / 1_000_000.0,
      "engine" to if (script == "chinese") "ml-kit-chinese" else "ml-kit-latin", "revision" to "16.0.1")
  }

}

internal object InboxManifestScanner {
  fun scan(inbox: File): List<Map<String, Any?>> = inbox.walkTopDown()
    .filter { it.isFile && it.name == "manifest.json" }
    .map { file ->
      try {
        val manifest = JSONObject(file.readText())
        validateOwnedManifest(manifest, inbox)
        jsonObjectToMap(manifest)
      } catch (_: Exception) {
        throw NativeException("INBOX_MANIFEST_INVALID")
      }
    }.toList()

  private fun validateOwnedManifest(manifest: JSONObject, inbox: File) {
    val inboxPath = inbox.canonicalPath + File.separator
    val items = manifest.getJSONArray("items")
    for (index in 0 until items.length()) {
      val item = items.getJSONObject(index)
      val uri = Uri.parse(item.getString("localUri"))
      check(uri.scheme == "file" && uri.authority.isNullOrEmpty())
      val path = File(requireNotNull(uri.path)).canonicalPath
      check(path.startsWith(inboxPath))
      if (item.getString("status") == "copied") check(File(path).isFile)
    }
  }

  private fun jsonObjectToMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { key ->
    when (val item = value.get(key)) { is JSONObject -> jsonObjectToMap(item); is org.json.JSONArray -> (0 until item.length()).map { index -> val child = item.get(index); if (child is JSONObject) jsonObjectToMap(child) else child }; JSONObject.NULL -> null; else -> item }
  }
}

internal object OcrBoundsNormalizer {
  fun normalize(left: Int, top: Int, boxWidth: Int, boxHeight: Int, sourceWidth: Int, sourceHeight: Int): Map<String, Double> {
    val width = sourceWidth.coerceAtLeast(1).toDouble()
    val height = sourceHeight.coerceAtLeast(1).toDouble()
    val clippedLeft = left.toDouble().coerceIn(0.0, width)
    val clippedTop = top.toDouble().coerceIn(0.0, height)
    val clippedRight = (left.toLong() + boxWidth).toDouble().coerceIn(clippedLeft, width)
    val clippedBottom = (top.toLong() + boxHeight).toDouble().coerceIn(clippedTop, height)
    return mapOf(
      "x" to clippedLeft / width,
      "y" to clippedTop / height,
      "width" to (clippedRight - clippedLeft) / width,
      "height" to (clippedBottom - clippedTop) / height,
    )
  }
}

internal object PdfProbe {
  fun probe(descriptor: ParcelFileDescriptor): Map<String, Any> = PdfRenderer(descriptor).use { renderer ->
    if (renderer.pageCount > 25) throw NativeException("PDF_TOO_MANY_PAGES")
    var embeddedTextPages = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
      for (index in 0 until renderer.pageCount) {
        renderer.openPage(index).use { page ->
          if (page.textContents.any { content -> content.text.isNotBlank() }) embeddedTextPages += 1
        }
      }
    }
    mapOf(
      "pageCount" to renderer.pageCount,
      "embeddedTextPages" to embeddedTextPages,
      "renderedFallbackPages" to renderer.pageCount - embeddedTextPages,
      "engine" to "pdf-renderer",
      "limit" to mapOf("pages" to 25, "bytes" to 52_428_800),
    )
  }
}

internal class NativeException(code: String) : CodedException(code)
