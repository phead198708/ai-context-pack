package com.aicontextpack.nativebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EphemeralShareEventStoreTest {
  @Test fun completionBeforeReactInitializationIsReadableAndAckableLater() {
    val id = "523e4567-e89b-42d3-a456-426614174000"
    EphemeralShareEventStore.publishIfEphemeral(mapOf(
      "schemaVersion" to 1,
      "id" to id,
      "result" to "failed",
      "durable" to false,
      "code" to "SHARE_RESULT_PERSIST_FAILED",
    ))
    assertTrue(EphemeralShareEventStore.read().any { it["id"] == id })
    assertTrue(EphemeralShareEventStore.ack(id))
    assertFalse(EphemeralShareEventStore.read().any { it["id"] == id })
  }

  @Test fun duplicateDeliveryKeepsOneEvent() {
    val id = "623e4567-e89b-42d3-a456-426614174000"
    val event = mapOf<String, Any>("id" to id, "durable" to false)
    EphemeralShareEventStore.publishIfEphemeral(event)
    EphemeralShareEventStore.publishIfEphemeral(event)
    assertEquals(1, EphemeralShareEventStore.read().count { it["id"] == id })
    EphemeralShareEventStore.ack(id)
  }
}
