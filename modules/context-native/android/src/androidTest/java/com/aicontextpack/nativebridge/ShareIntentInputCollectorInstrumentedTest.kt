package com.aicontextpack.nativebridge

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ShareIntentInputCollectorInstrumentedTest {
  private val context = InstrumentationRegistry.getInstrumentation().targetContext

  @Test fun actionSendPlainTextBecomesOneReadableOrderedInput() {
    val intent = Intent(Intent.ACTION_SEND)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, "synthetic text")

    val inputs = ShareIntentInputCollector.collect(context, intent)

    assertEquals(1, inputs.size)
    assertEquals(0, inputs.single().order)
    assertEquals("text/plain", inputs.single().declaredMediaType)
    assertEquals("synthetic text", inputs.single().openStream?.invoke()?.reader()?.readText())
    assertNull(inputs.single().preflightError)
  }

  @Test fun clipDataOrderIsAuthoritativeAndDistinctExtraTextIsNotOmitted() {
    val clip = ClipData.newPlainText("synthetic", "first")
    clip.addItem(ClipData.Item("second"))
    val intent = Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/plain").apply {
      clipData = clip
      putExtra(Intent.EXTRA_TEXT, "caption")
    }

    val inputs = ShareIntentInputCollector.collect(context, intent)

    assertEquals(listOf(0, 1, 2), inputs.map { it.order })
    assertEquals(
      listOf("first", "second", "caption"),
      inputs.map { it.openStream?.invoke()?.reader()?.readText() },
    )
  }

  @Test fun duplicateTextSurfaceIsRepresentedOnce() {
    val clip = ClipData.newPlainText("synthetic", "same")
    val intent = Intent(Intent.ACTION_SEND).setType("text/plain").apply {
      clipData = clip
      putExtra(Intent.EXTRA_TEXT, "same")
    }

    assertEquals(1, ShareIntentInputCollector.collect(context, intent).size)
  }

  @Test fun uriAndFallbackTextOnOneClipItemRemainOneHostOrderedInput() {
    val item = ClipData.Item(
      "provider fallback",
      null,
      Uri.parse("content://synthetic.invalid/item"),
    )
    val intent = Intent(Intent.ACTION_SEND).setType("image/png").apply {
      clipData = ClipData("synthetic", arrayOf("image/png"), item)
    }

    val inputs = ShareIntentInputCollector.collect(context, intent)

    assertEquals(1, inputs.size)
    assertEquals(0, inputs.single().order)
    assertNotNull(inputs.single().openStream)
  }

  @Test fun distinctExtraStreamIsNotOmittedWhenClipDataExists() {
    val stream = Uri.parse("content://synthetic.invalid/extra-stream")
    val intent = Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").apply {
      clipData = ClipData.newPlainText("synthetic", "caption")
      putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(stream))
    }

    val inputs = ShareIntentInputCollector.collect(context, intent)

    assertEquals(listOf(0, 1), inputs.map { it.order })
    assertEquals("caption", inputs.first().openStream?.invoke()?.reader()?.readText())
    assertNotNull(inputs.last().openStream)
  }

  @Test fun aStreamMirroredByClipDataIsRepresentedOnce() {
    val stream = Uri.parse("content://synthetic.invalid/mirrored-stream")
    val intent = Intent(Intent.ACTION_SEND).setType("image/png").apply {
      clipData = ClipData("synthetic", arrayOf("image/png"), ClipData.Item(stream))
      putExtra(Intent.EXTRA_STREAM, stream)
    }

    assertEquals(1, ShareIntentInputCollector.collect(context, intent).size)
  }

  @Test fun malformedShareProducesOneVisibleFailedInput() {
    val input = ShareIntentInputCollector.collect(
      context,
      Intent(Intent.ACTION_SEND).setType("application/octet-stream"),
    ).single()

    assertEquals("IMPORT_COPY_FAILED", input.preflightError)
    assertNull(input.openStream)
    assertNotNull(input.id)
  }

  @Test fun valuesBeyondTwentyAreRetainedAsStableRejectedItems() {
    val values = Array<CharSequence>(21) { index -> "item-$index" }
    val intent = Intent(Intent.ACTION_SEND_MULTIPLE)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, values)

    val inputs = ShareIntentInputCollector.collect(context, intent)

    assertEquals(21, inputs.size)
    assertEquals((0..20).toList(), inputs.map { it.order })
    assertNull(inputs[19].preflightError)
    assertEquals("IMPORT_SIZE_LIMIT_EXCEEDED", inputs[20].preflightError)
    assertNull(inputs[20].openStream)
  }

  @Test fun payloadBeyondTheManifestBoundFailsAsAWholeWithoutSilentOmission() {
    val values = Array<CharSequence>(ShareIngestionWriter.maximumReportedItemCount + 1) { index ->
      "item-$index"
    }
    val intent = Intent(Intent.ACTION_SEND_MULTIPLE)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_TEXT, values)

    val error = assertThrows(ShareInputCollectionException::class.java) {
      ShareIntentInputCollector.collect(context, intent)
    }

    assertEquals("IMPORT_SIZE_LIMIT_EXCEEDED", error.stableCode)
  }
}
