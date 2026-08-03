package com.aicontextpack.nativebridge

import android.util.Log
import java.math.BigDecimal

internal class PrivacySafeLogException(val stableCode: String) : IllegalArgumentException(stableCode)

internal class PrivacySafeLogger(
  private val sink: (String) -> Unit = { serialized ->
    Log.i("AIContextPack", serialized)
  },
) {
  fun log(event: String, fields: Map<String, Any> = emptyMap()) {
    sink(serialize(event, fields))
  }

  companion object {
    private val allowedEvents = setOf(
      "inbox_scan",
      "import_completed",
      "import_failed",
      "ocr_completed",
      "pdf_probe_completed",
    )
    private val allowedCodes = setOf(
      "INBOX_SCAN_FAILED",
      "NATIVE_ADAPTER_UNAVAILABLE",
      "NATIVE_MANIFEST_INVALID",
      "NATIVE_OCR_RESULT_INVALID",
      "NATIVE_PDF_RESULT_INVALID",
      "OCR_IMAGE_DECODE_FAILED",
      "OCR_RECOGNITION_FAILED",
      "SHARE_COPY_FAILED",
      "SHARE_IMPORT_FAILED",
      "SHARE_IMPORT_EVENT_INVALID",
    )
    private val allowedEngines = setOf(
      "apple-vision",
      "ml-kit-latin",
      "ml-kit-chinese",
      "pdfkit",
      "pdf-renderer",
    )
    private val allowedKeys = setOf(
      "code",
      "count",
      "bytes",
      "durationMs",
      "version",
      "engine",
      "anonymousId",
    )
    private val versionPattern = Regex("^[0-9]+(?:\\.[0-9]+){0,3}$")
    private val anonymousIdPattern = Regex(
      "^(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$",
    )

    fun serialize(event: String, fields: Map<String, Any> = emptyMap()): String {
      if (event !in allowedEvents) throw PrivacySafeLogException("UNSAFE_LOG_EVENT")
      if (!allowedKeys.containsAll(fields.keys)) {
        throw PrivacySafeLogException("UNSAFE_LOG_FIELD")
      }

      val record = sortedMapOf("event" to quoted(event))
      fields.forEach { (key, value) ->
        record[key] = when (key) {
          "code" -> approvedString(value, allowedCodes)
          "engine" -> approvedString(value, allowedEngines)
          "version" -> approvedString(value) {
            it.length <= 32 && versionPattern.matches(it)
          }
          "anonymousId" -> approvedString(value, anonymousIdPattern::matches)
          "count", "bytes" -> nonNegativeInteger(value)
          "durationMs" -> nonNegativeNumber(value)
          else -> throw PrivacySafeLogException("UNSAFE_LOG_FIELD")
        }
      }
      return record.entries.joinToString(prefix = "{", postfix = "}") { (key, value) ->
        "${quoted(key)}:$value"
      }
    }

    private fun approvedString(value: Any, allowed: Set<String>): String =
      approvedString(value, allowed::contains)

    private fun approvedString(value: Any, predicate: (String) -> Boolean): String {
      if (value !is String || !predicate(value)) {
        throw PrivacySafeLogException("UNSAFE_LOG_VALUE")
      }
      return quoted(value)
    }

    private fun nonNegativeInteger(value: Any): String {
      val number = when (value) {
        is Byte -> value.toLong()
        is Short -> value.toLong()
        is Int -> value.toLong()
        is Long -> value
        else -> throw PrivacySafeLogException("UNSAFE_LOG_VALUE")
      }
      if (number < 0) throw PrivacySafeLogException("UNSAFE_LOG_VALUE")
      return number.toString()
    }

    private fun nonNegativeNumber(value: Any): String {
      val number = when (value) {
        is Byte -> value.toDouble()
        is Short -> value.toDouble()
        is Int -> value.toDouble()
        is Long -> value.toDouble()
        is Float -> value.toDouble()
        is Double -> value
        else -> throw PrivacySafeLogException("UNSAFE_LOG_VALUE")
      }
      if (!number.isFinite() || number < 0) {
        throw PrivacySafeLogException("UNSAFE_LOG_VALUE")
      }
      return BigDecimal.valueOf(number).stripTrailingZeros().toPlainString()
    }

    private fun quoted(value: String): String = "\"$value\""
  }
}
