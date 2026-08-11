package com.aicontextpack.nativebridge

import android.content.Context
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal object AndroidPlainTextFileReader {
  const val maximumBytes = 1_048_576
  const val maximumDerivedBytes = 16_777_216

  fun read(
    context: Context,
    fileUri: String,
    allowedMaximumBytes: Int = maximumBytes,
    expectedByteCount: Int? = null,
    expectedSha256: String? = null,
  ): Map<String, Any> {
    if (allowedMaximumBytes !in 1..maximumDerivedBytes) {
      throw NativeException("TEXT_RESULT_INVALID")
    }
    if (
      (expectedByteCount == null) != (expectedSha256 == null) ||
      (expectedByteCount != null &&
        (expectedByteCount !in 0..allowedMaximumBytes ||
          !Regex("^[0-9a-f]{64}$").matches(expectedSha256!!)))
    ) throw NativeException("TEXT_RESULT_INVALID")
    val file = controlledSandboxFile(context, fileUri)
    val fileByteCount = file.length()
    if (fileByteCount > allowedMaximumBytes) throw NativeException("TEXT_TOO_LARGE")
    if (expectedByteCount != null && expectedByteCount.toLong() != fileByteCount) {
      throw NativeException("ARTIFACT_INTEGRITY_FAILED")
    }
    val bytes = try {
      file.inputStream().buffered().use { input ->
        val output = ByteArrayOutputStream(
          minOf(fileByteCount.toInt(), allowedMaximumBytes),
        )
        val buffer = ByteArray(16 * 1_024)
        var total = 0
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (read == 0) continue
          if (total > allowedMaximumBytes - read) throw NativeException("TEXT_TOO_LARGE")
          output.write(buffer, 0, read)
          total += read
        }
        output.toByteArray()
      }
    }
    catch (_: OutOfMemoryError) { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    catch (error: NativeException) { throw error }
    catch (_: Exception) { throw NativeException("INVALID_LOCAL_FILE_URI") }
    if (bytes.size.toLong() != fileByteCount || file.length() != fileByteCount) {
      throw NativeException("TEXT_RESULT_INVALID")
    }
    if (
      expectedSha256 != null &&
      MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) } != expectedSha256
    ) throw NativeException("ARTIFACT_INTEGRITY_FAILED")
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
