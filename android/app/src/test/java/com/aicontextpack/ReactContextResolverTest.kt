package com.aicontextpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReactContextResolverTest {
  @Test
  fun `uses bridgeless host context without touching legacy host`() {
    val context = ReactContextResolver.resolve(
      host = { "bridgeless" },
      legacy = { error("legacy host is unavailable") },
    )

    assertEquals("bridgeless", context)
  }

  @Test
  fun `falls back safely and suppresses unavailable host errors`() {
    val context = ReactContextResolver.resolve(
      host = { error("bridgeless host is unavailable") },
      legacy = { "legacy" },
    )

    assertEquals("legacy", context)
  }

  @Test
  fun `returns null when an uninitialized legacy host throws`() {
    val context = ReactContextResolver.resolve<String>(
      host = { null },
      legacy = { throw NullPointerException("legacy host is not initialized") },
    )

    assertNull(context)
  }
}
