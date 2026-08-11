package com.aicontextpack.nativebridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ImagePerceptualHasherInstrumentedTest {
  @Test
  fun syntheticMediaHashesMatchTheCrossPlatformGolden() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    for (name in listOf("ocr-english.png", "ocr-rotated.jpg")) {
      val file = File(context.cacheDir, "image-hash-$name")
      InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { input ->
        file.outputStream().use { output -> input.copyTo(output) }
      }
      val value = ImagePerceptualHasher.hash(context, file.toURI().toString())
      val hash = value.getValue("hash") as String
      assertEquals("000000a810000000", hash)
    }
  }
}
