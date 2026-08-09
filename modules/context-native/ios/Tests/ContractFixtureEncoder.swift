import Foundation

enum ContractFixtureEncoder {
  private static let ingestionId = "123e4567-e89b-42d3-a456-426614174000"
  private static let itemId = "223e4567-e89b-42d3-a456-426614174000"
  private static let runId = "323e4567-e89b-42d3-a456-426614174000"
  private static let checkpointId = "423e4567-e89b-42d3-a456-426614174000"
  private static let packId = "523e4567-e89b-42d3-a456-426614174000"
  private static let artifactId = "623e4567-e89b-42d3-a456-426614174000"
  private static let findingId = "723e4567-e89b-42d3-a456-426614174000"
  private static let exportId = "823e4567-e89b-42d3-a456-426614174000"
  private static let exportArtifactId = "923e4567-e89b-42d3-a456-426614174000"

  static let payloads: [String: [String: Any]] = [
    "import-manifest-v1.json": [
      "schemaVersion": 1,
      "ingestionId": ingestionId,
      "createdAt": "2026-01-01T00:00:00Z",
      "source": "android-share-intent",
      "status": "complete",
      "items": [[
        "id": itemId,
        "order": 0,
        "mediaType": "image/png",
        "byteCount": 128,
        "relativePath": "\(itemId).bin",
        "status": "copied",
        "sha256": String(repeating: "a", count: 64),
      ]],
    ],
    "ocr-result-v1.json": [
      "schemaVersion": 1,
      "text": "Synthetic fixture",
      "blocks": [[
        "text": "Synthetic fixture",
        "bounds": ["x": 0.1, "y": 0.2, "width": 0.5, "height": 0.1],
        "confidence": 0.99,
        "language": "en",
      ]],
      "durationMs": 4,
      "engine": "apple-vision",
      "revision": "3",
      "recognitionLevel": "accurate",
      "warnings": [],
    ],
    "pdf-page-extraction-v1.json": [
      "schemaVersion": 1,
      "pageIndex": 0,
      "method": "embedded-text",
      "engine": "pdfkit",
      "revision": "1",
      "durationMs": 2,
      "status": "complete",
      "text": "中文 👩🏽‍💻 e\u{0301}",
      "blocks": [],
    ],
    "pipeline-checkpoint-v1.json": [
      "schemaVersion": 1,
      "id": checkpointId,
      "runId": runId,
      "packId": packId,
      "itemId": itemId,
      "stage": "extract",
      "reason": "recovery",
      "resumeAction": "recover-stage",
      "completedArtifactIds": [artifactId],
      "processor": "context-pdf",
      "processorVersion": "1.0.0",
      "updatedAt": "2026-01-01T00:00:01Z",
      "errorCode": "PIPELINE_RECOVERY_REQUIRED",
    ],
    "risk-finding-v1.json": [
      "schemaVersion": 1,
      "id": findingId,
      "itemId": itemId,
      "detector": "synthetic-patterns",
      "detectorVersion": "1.0.0",
      "category": "api-key",
      "severity": "high",
      "confidence": 0.99,
      "location": ["kind": "text-range", "start": 0, "length": 12],
      "decision": "pending",
    ],
    "export-manifest-v1.json": [
      "schemaVersion": 1,
      "exportId": exportId,
      "packId": packId,
      "createdAt": "2026-01-01T00:00:02Z",
      "format": "attachment-bundle",
      "artifacts": [[
        "id": exportArtifactId,
        "kind": "attachment",
        "relativePath": "attachments/\(exportArtifactId).bin",
        "mediaType": "image/png",
        "byteCount": 128,
        "sha256": String(repeating: "b", count: 64),
      ]],
      "privacyReview": [
        "status": "complete",
        "decisionSetSha256": String(repeating: "c", count: 64),
      ],
    ],
  ]
}
