package com.aicontextpack.nativebridge

import android.content.Context
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal object AndroidPlainTextFileReader {
  const val maximumBytes = 1_048_576

  fun read(context: Context, fileUri: String): Map<String, Any> {
    val file = controlledSandboxFile(context, fileUri)
    val expectedByteCount = file.length()
    if (expectedByteCount > maximumBytes) throw NativeException("TEXT_TOO_LARGE")
    val bytes = try {
      file.inputStream().buffered().use { input ->
        val output = ByteArrayOutputStream(minOf(expectedByteCount.toInt(), maximumBytes))
        val buffer = ByteArray(16 * 1_024)
        var total = 0
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (read == 0) continue
          if (total > maximumBytes - read) throw NativeException("TEXT_TOO_LARGE")
          output.write(buffer, 0, read)
          total += read
        }
        output.toByteArray()
      }
    }
    catch (_: OutOfMemoryError) { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    catch (error: NativeException) { throw error }
    catch (_: Exception) { throw NativeException("INVALID_LOCAL_FILE_URI") }
    if (bytes.size.toLong() != expectedByteCount || file.length() != expectedByteCount) {
      throw NativeException("TEXT_RESULT_INVALID")
    }
    val text = try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (_: Exception) {
      throw NativeException("TEXT_INVALID_UTF8")
    }
    return mapOf(
      "schemaVersion" to 1,
      "text" to text,
      "byteCount" to bytes.size,
      "encoding" to "utf-8",
      "revision" to "1",
    )
  }
}
