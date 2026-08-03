package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PrivacySafeLoggerTest {
  @Test fun forbiddenContentFieldsNeverReachSink() {
    val forbidden = listOf(
      "text",
      "ocrText",
      "filename",
      "url",
      "fileBytes",
      "detectorMatch",
    )
    forbidden.forEach { key ->
      val serialized = mutableListOf<String>()
      val logger = PrivacySafeLogger(serialized::add)
      assertPrivacyError("UNSAFE_LOG_FIELD") {
        logger.log("import_completed", mapOf(key to "synthetic-private-value"))
      }
      assertTrue(serialized.isEmpty())
    }
  }

  @Test fun approvedKeysRejectUserControlledValues() {
    val invalid = listOf(
      mapOf("code" to "secret text"),
      mapOf("engine" to "private-engine"),
      mapOf("version" to "private/path"),
      mapOf("anonymousId" to "fixture.png"),
      mapOf("count" to 1.5),
      mapOf("bytes" to -1),
      mapOf("durationMs" to Double.POSITIVE_INFINITY),
    )
    invalid.forEach { fields ->
      assertPrivacyError("UNSAFE_LOG_VALUE") {
        PrivacySafeLogger.serialize("ocr_completed", fields)
      }
    }
  }

  @Test fun unknownEventIsRejected() {
    assertPrivacyError("UNSAFE_LOG_EVENT") {
      PrivacySafeLogger.serialize("private event")
    }
  }

  @Test fun allowlistedMetadataSerializesDeterministically() {
    val serialized = PrivacySafeLogger.serialize(
      "ocr_completed",
      mapOf(
        "engine" to "ml-kit-latin",
        "durationMs" to 12.5,
        "version" to "16.0.1",
        "anonymousId" to "f".repeat(64),
      ),
    )
    assertTrue(serialized.startsWith("{\"anonymousId\":\""))
    assertTrue(serialized.contains("\"event\":\"ocr_completed\""))
    assertTrue(serialized.contains("\"durationMs\":12.5"))
    assertFalse(serialized.contains("text"))
  }

  private fun assertPrivacyError(code: String, operation: () -> Unit) {
    try {
      operation()
      fail("expected $code")
    } catch (error: PrivacySafeLogException) {
      assertEquals(code, error.stableCode)
    }
  }
}
