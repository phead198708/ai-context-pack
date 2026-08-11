package com.aicontextpack.nativebridge

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

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
      val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
        .joinToString("") { "%02x".format(it) }
      val value = ImagePerceptualHasher.hash(
        context,
        file.toURI().toString(),
        file.length(),
        digest,
      )
      val hash = value.getValue("hash") as String
      assertEquals("000000a810000000", hash)
    }
  }

  @Test
  fun immutableSnapshotSurvivesAtomicPathSwapBack() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val file = File(context.cacheDir, "image-hash-swap.png")
    val original = InstrumentationRegistry.getInstrumentation().context.assets
      .open("ocr-english.png").use { it.readBytes() }
    file.writeBytes(original)
    val digest = MessageDigest.getInstance("SHA-256").digest(original)
      .joinToString("") { "%02x".format(it) }
    val value = ImagePerceptualHasher.hash(
      context,
      file.toURI().toString(),
      original.size.toLong(),
      digest,
      sourceMutationHook = { phase ->
        if (phase == "snapshot-ready") {
          val replacement = File(context.cacheDir, "image-hash-replacement")
          replacement.writeText("replacement")
          android.system.Os.rename(replacement.path, file.path)
        } else if (phase == "decode-complete") {
          val restored = File(context.cacheDir, "image-hash-restored")
          restored.writeBytes(original)
          android.system.Os.rename(restored.path, file.path)
        }
      },
    )
    assertEquals("000000a810000000", value["hash"] as String)
    assertEquals(true, file.readBytes().contentEquals(original))
  }

  @Test
  fun sharedAnimatedFixturesFailTheSameSingleFramePolicy() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val lines = InstrumentationRegistry.getInstrumentation().context.assets
      .open("image-animation-policy-v1.tsv").bufferedReader().readLines()
    for (line in lines) {
      val (name, encoded) = line.split('\t', limit = 2)
      val bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
      val file = File(context.cacheDir, "$name.bin")
      file.writeBytes(bytes)
      val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
      val error = org.junit.Assert.assertThrows(NativeException::class.java) {
        ImagePerceptualHasher.hash(context, file.toURI().toString(), file.length(), digest)
      }
      assertEquals("PROCESSOR_OUTPUT_INVALID", error.code)
    }
  }
}
