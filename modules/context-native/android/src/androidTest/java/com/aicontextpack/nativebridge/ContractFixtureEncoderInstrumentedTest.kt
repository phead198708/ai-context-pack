package com.aicontextpack.nativebridge

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ContractFixtureEncoderInstrumentedTest {
  @Test
  fun kotlinEncodersMatchEverySharedV1Fixture() {
    val assets = InstrumentationRegistry.getInstrumentation().context.assets
    ContractFixtureEncoder.payloads().forEach { (name, encoded) ->
      val expected = assets.open(name).bufferedReader().use { JSONObject(it.readText()) }
      assertEquals(name, canonicalJson(expected), canonicalJson(encoded))
    }
  }

  private fun canonicalJson(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
      prefix = "{",
      postfix = "}",
    ) { key -> "${JSONObject.quote(key)}:${canonicalJson(value.get(key))}" }
    is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { index ->
      canonicalJson(value.get(index))
    }
    is String -> JSONObject.quote(value)
    JSONObject.NULL, null -> "null"
    else -> value.toString()
  }
}

private object ContractFixtureEncoder {
  private const val ingestionId = "123e4567-e89b-42d3-a456-426614174000"
  private const val itemId = "223e4567-e89b-42d3-a456-426614174000"
  private const val runId = "323e4567-e89b-42d3-a456-426614174000"
  private const val checkpointId = "423e4567-e89b-42d3-a456-426614174000"
  private const val packId = "523e4567-e89b-42d3-a456-426614174000"
  private const val artifactId = "623e4567-e89b-42d3-a456-426614174000"
  private const val findingId = "723e4567-e89b-42d3-a456-426614174000"
  private const val exportId = "823e4567-e89b-42d3-a456-426614174000"
  private const val exportArtifactId = "923e4567-e89b-42d3-a456-426614174000"

  fun payloads(): Map<String, JSONObject> = linkedMapOf(
    "import-manifest-v1.json" to importManifest(),
    "ocr-result-v1.json" to ocrResult(),
    "pdf-page-extraction-v1.json" to pdfPageExtraction(),
    "pipeline-checkpoint-v1.json" to pipelineCheckpoint(),
    "risk-finding-v1.json" to riskFinding(),
    "export-manifest-v1.json" to exportManifest(),
    "image-perceptual-hash-v1.json" to imagePerceptualHash(),
    "image-compression-inspection-v1.json" to imageCompressionInspection(),
    "image-compression-result-v1.json" to imageCompressionResult(),
  )

  private fun importManifest() = JSONObject()
    .put("schemaVersion", 1)
    .put("ingestionId", ingestionId)
    .put("createdAt", "2026-01-01T00:00:00Z")
    .put("source", "android-share-intent")
    .put("status", "complete")
    .put(
      "items",
      JSONArray().put(
        JSONObject()
          .put("id", itemId)
          .put("order", 0)
          .put("mediaType", "image/png")
          .put("byteCount", 128)
          .put("relativePath", "$itemId.bin")
          .put("status", "copied")
          .put("sha256", "a".repeat(64)),
      ),
    )

  private fun ocrResult() = JSONObject()
    .put("schemaVersion", 1)
    .put("text", "Synthetic fixture")
    .put(
      "blocks",
      JSONArray().put(
        JSONObject()
          .put("text", "Synthetic fixture")
          .put(
            "bounds",
            JSONObject().put("x", 0.1).put("y", 0.2).put("width", 0.5).put("height", 0.1),
          )
          .put("confidence", 0.99)
          .put("language", "en"),
      ),
    )
    .put("durationMs", 4)
    .put("engine", "apple-vision")
    .put("revision", "3")
    .put("recognitionLevel", "accurate")
    .put("warnings", JSONArray())

  private fun pdfPageExtraction() = JSONObject()
    .put("schemaVersion", 1)
    .put("pageIndex", 0)
    .put("method", "embedded-text")
    .put("engine", "pdfkit")
    .put("revision", "1")
    .put("durationMs", 2)
    .put("characterCount", 13)
    .put("warnings", JSONArray())
    .put("status", "complete")
    .put("text", "中文 👩🏽‍💻 e\u0301")
    .put("blocks", JSONArray())

  private fun pipelineCheckpoint() = JSONObject()
    .put("schemaVersion", 1)
    .put("id", checkpointId)
    .put("runId", runId)
    .put("packId", packId)
    .put("itemId", itemId)
    .put("stage", "extract")
    .put("reason", "recovery")
    .put("resumeAction", "recover-stage")
    .put("completedArtifactIds", JSONArray().put(artifactId))
    .put("processor", "context-pdf")
    .put("processorVersion", "1.0.0")
    .put("updatedAt", "2026-01-01T00:00:01Z")
    .put("errorCode", "PIPELINE_RECOVERY_REQUIRED")

  private fun riskFinding() = JSONObject()
    .put("schemaVersion", 1)
    .put("id", findingId)
    .put("itemId", itemId)
    .put("detector", "synthetic-patterns")
    .put("detectorVersion", "1.0.0")
    .put("category", "api-key")
    .put("severity", "high")
    .put("confidence", 0.99)
    .put("location", JSONObject().put("kind", "text-range").put("start", 0).put("length", 12))
    .put("decision", "pending")

  private fun exportManifest() = JSONObject()
    .put("schemaVersion", 1)
    .put("exportId", exportId)
    .put("packId", packId)
    .put("createdAt", "2026-01-01T00:00:02Z")
    .put("format", "attachment-bundle")
    .put(
      "artifacts",
      JSONArray().put(
        JSONObject()
          .put("id", exportArtifactId)
          .put("kind", "attachment")
          .put("relativePath", "attachments/$exportArtifactId.bin")
          .put("mediaType", "image/png")
          .put("byteCount", 128)
          .put("sha256", "b".repeat(64)),
      ),
    )
    .put(
      "privacyReview",
      JSONObject().put("status", "complete").put("decisionSetSha256", "c".repeat(64)),
    )

  private fun imagePerceptualHash() = JSONObject()
    .put("schemaVersion", 1)
    .put("algorithm", "dhash-64-v1")
    .put("hash", "0123456789abcdef")
    .put("sampleWidth", 9)
    .put("sampleHeight", 8)
    .put("orientationApplied", true)
    .put("durationMs", 2)
    .put("revision", "1")

  private fun imageCompressionInspection() = JSONObject()
    .put("schemaVersion", 1)
    .put("sourceByteCount", 128)
    .put("sourceSha256", "a".repeat(64))
    .put("sourceMediaType", "image/png")
    .put("width", 640)
    .put("height", 480)
    .put("hasAlpha", true)
    .put("animated", false)
    .put("orientationApplied", true)
    .put("revision", "1")

  private fun imageCompressionResult() = JSONObject()
    .put("schemaVersion", 1)
    .put("taskId", runId)
    .put("sourceSha256", "a".repeat(64))
    .put("temporaryFileUri", "file:///tmp/$runId.tmp")
    .put("outputByteCount", 96)
    .put("outputSha256", "b".repeat(64))
    .put("width", 320)
    .put("height", 240)
    .put("mediaType", "image/png")
    .put("quality", 1)
    .put("alphaPreserved", true)
    .put("engine", "core-graphics")
    .put("revision", "1")
    .put("durationMs", 2)
}
