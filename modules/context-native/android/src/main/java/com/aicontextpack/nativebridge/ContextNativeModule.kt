package com.aicontextpack.nativebridge

import android.graphics.pdf.PdfRenderer
import android.net.Uri
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
      (inbox.walkTopDown().filter { it.isFile && it.name == "manifest.json" }.mapNotNull { file ->
        runCatching { jsonObjectToMap(JSONObject(file.readText())) }.getOrNull()
      }.toList())
    }

    AsyncFunction("recognizeText") { fileUri: String, script: String, promise: Promise ->
      val context = appContext.reactContext ?: return@AsyncFunction promise.reject(NativeException("CONTEXT_UNAVAILABLE"))
      val uri = controlledFileUri(fileUri)
      val started = System.nanoTime()
      val image = try { InputImage.fromFilePath(context, uri) } catch (_: Exception) { return@AsyncFunction promise.reject(NativeException("OCR_IMAGE_DECODE_FAILED")) }
      val recognizer = if (script == "chinese") TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build()) else TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      recognizer.process(image)
        .addOnSuccessListener { result -> promise.resolve(ocrResult(result, script, started)) }
        .addOnFailureListener { promise.reject(NativeException("OCR_RECOGNITION_FAILED")) }
        .addOnCompleteListener { recognizer.close() }
    }

    AsyncFunction("probePdf") { fileUri: String ->
      val file = File(controlledFileUri(fileUri).path ?: throw NativeException("INVALID_LOCAL_FILE_URI"))
      if (!file.isFile || file.length() > 52_428_800) throw NativeException("PDF_INVALID_OR_TOO_LARGE")
      val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
      PdfRenderer(descriptor).use { renderer ->
        if (renderer.pageCount > 25) throw NativeException("PDF_TOO_MANY_PAGES")
        mapOf("pageCount" to renderer.pageCount, "embeddedTextPages" to 0,
          "renderedFallbackPages" to renderer.pageCount, "engine" to "pdf-renderer",
          "limit" to mapOf("pages" to 25, "bytes" to 52_428_800))
      }
    }
  }

  private fun controlledFileUri(value: String): Uri {
    val uri = Uri.parse(value)
    if (uri.scheme != "file") throw NativeException("INVALID_LOCAL_FILE_URI")
    return uri
  }

  private fun ocrResult(result: Text, script: String, started: Long): Map<String, Any> {
    val width = result.textBlocks.flatMap { it.lines }.flatMap { it.elements }.maxOfOrNull { it.boundingBox?.right ?: 1 }?.coerceAtLeast(1) ?: 1
    val height = result.textBlocks.flatMap { it.lines }.flatMap { it.elements }.maxOfOrNull { it.boundingBox?.bottom ?: 1 }?.coerceAtLeast(1) ?: 1
    val blocks = result.textBlocks.mapNotNull { block -> block.boundingBox?.let { box -> mapOf("text" to block.text, "bounds" to mapOf("x" to box.left.toDouble() / width, "y" to box.top.toDouble() / height, "width" to box.width().toDouble() / width, "height" to box.height().toDouble() / height)) } }
    return mapOf("schemaVersion" to 1, "text" to result.text, "blocks" to blocks,
      "durationMs" to (System.nanoTime() - started) / 1_000_000.0,
      "engine" to if (script == "chinese") "ml-kit-chinese" else "ml-kit-latin", "revision" to "16.0.1")
  }

  private fun jsonObjectToMap(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { key ->
    when (val item = value.get(key)) { is JSONObject -> jsonObjectToMap(item); is org.json.JSONArray -> (0 until item.length()).map { index -> val child = item.get(index); if (child is JSONObject) jsonObjectToMap(child) else child }; JSONObject.NULL -> null; else -> item }
  }
}

private class NativeException(code: String) : CodedException(code)
