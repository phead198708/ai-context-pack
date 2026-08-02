package com.aicontextpack.nativebridge

import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class PdfProbeInstrumentedTest {
  @Test
  fun usesRenderedFallbackForAllPagesBeforeApi35() {
    assumeTrue(Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM)

    val textResult = probeFixture("text-one-page.pdf")
    assertEquals(1, textResult["pageCount"])
    assertEquals(0, textResult["embeddedTextPages"])
    assertEquals(1, textResult["renderedFallbackPages"])
  }

  @Test
  fun distinguishesEmbeddedTextFromScannedFixtureOnApi35Plus() {
    assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM)

    val textResult = probeFixture("text-one-page.pdf")
    assertEquals(1, textResult["pageCount"])
    assertEquals(1, textResult["embeddedTextPages"])
    assertEquals(0, textResult["renderedFallbackPages"])

    val scannedResult = probeFixture("scanned-one-page.pdf")
    assertEquals(1, scannedResult["pageCount"])
    assertEquals(0, scannedResult["embeddedTextPages"])
    assertEquals(1, scannedResult["renderedFallbackPages"])
  }

  private fun probeFixture(name: String): Map<String, Any> {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val file = File(instrumentation.targetContext.cacheDir, name)
    instrumentation.context.assets.open(name).use { input ->
      file.outputStream().use { output -> input.copyTo(output) }
    }
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use(PdfProbe::probe)
  }
}
