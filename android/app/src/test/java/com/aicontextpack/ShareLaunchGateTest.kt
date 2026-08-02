package com.aicontextpack

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareLaunchGateTest {
  @Test fun consumesAGenuinelyNewTaskInitialIntent() {
    assertTrue(ShareLaunchGate.shouldConsumeInitialIntent(restoredSystemTask = false))
  }

  @Test fun doesNotReplayTheInitialIntentAfterSystemTaskRestoration() {
    assertFalse(ShareLaunchGate.shouldConsumeInitialIntent(restoredSystemTask = true))
  }


  @Test fun persistenceFailureStillProducesAVisibleFailedEvent() {
    val event = ShareResultEventPublisher.persistOrFallback("complete") { error("disk full") }
    assertTrue(event["id"] is String)
    assertTrue(event["result"] == "failed")
    assertFalse(event["durable"] as Boolean)
  }
}
