package com.aicontextpack.nativebridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Movie
import android.graphics.drawable.AnimatedImageDrawable
import android.media.ExifInterface
import android.os.Build
import android.os.SystemClock
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal class ImageHashCancellationToken {
  private val cancelled = AtomicBoolean(false)
  @Volatile private var decodeOptions: BitmapFactory.Options? = null

  @Suppress("DEPRECATION")
  fun cancel() {
    cancelled.set(true)
    decodeOptions?.requestCancelDecode()
  }

  @Suppress("DEPRECATION")
  fun attachDecode(options: BitmapFactory.Options) {
    decodeOptions = options
    if (cancelled.get()) options.requestCancelDecode()
  }

  fun detachDecode(options: BitmapFactory.Options) {
    if (decodeOptions === options) decodeOptions = null
  }

  fun throwIfCancelled() {
    if (cancelled.get()) throw NativeException("PIPELINE_STAGE_FAILED")
  }
}

internal class ImageHashTaskRegistry {
  private data class Entry(
    val ownerId: String,
    val token: ImageHashCancellationToken,
  )

  private val entries = mutableMapOf<String, Entry>()

  @Synchronized
  fun reserve(ownerId: String, taskId: String): ImageHashCancellationToken? {
    if (!isCanonicalImageHashTaskId(taskId) || entries.containsKey(taskId)) return null
    return ImageHashCancellationToken().also { entries[taskId] = Entry(ownerId, it) }
  }

  @Synchronized
  fun cancel(taskId: String): Boolean {
    entries[taskId]?.token?.cancel()
    return true
  }

  @Synchronized
  fun finish(ownerId: String, taskId: String, token: ImageHashCancellationToken) {
    val entry = entries[taskId]
    if (entry?.ownerId == ownerId && entry.token === token) entries.remove(taskId)
  }

  @Synchronized
  fun destroyOwner(ownerId: String) {
    entries.values.filter { it.ownerId == ownerId }.forEach { it.token.cancel() }
  }
}

private fun isCanonicalImageHashTaskId(value: String): Boolean {
  if (value != value.lowercase()) return false
  val parsed = runCatching { UUID.fromString(value) }.getOrNull() ?: return false
  return parsed.toString() == value && value[14] in '1'..'5' && value[19] in setOf('8', '9', 'a', 'b')
}

internal object ImagePerceptualHasher {
  const val sampleWidth = 9
  const val sampleHeight = 8
  const val maximumSourceBytes = 52_428_800L
  // v1 retains one bounded decoded bitmap plus one scanline. It never creates an
  // orientation copy or a full-image IntArray.
  const val maximumPixelCount = 16_000_000L
  private val sha256Pattern = Regex("^[0-9a-f]{64}$")

  fun hash(
    context: Context,
    fileUri: String,
    expectedByteCount: Long,
    expectedSha256: String,
    cancellation: ImageHashCancellationToken = ImageHashCancellationToken(),
  ): Map<String, Any> {
    val started = SystemClock.elapsedRealtimeNanos()
    cancellation.throwIfCancelled()
    val file = controlledSandboxFile(context, fileUri)
    if (
      !file.isFile ||
      file.length() !in 1..maximumSourceBytes ||
      expectedByteCount != file.length() ||
      !sha256Pattern.matches(expectedSha256) ||
      sha256(file.path, cancellation) != expectedSha256
    ) throw NativeException("ARTIFACT_INTEGRITY_FAILED")
    cancellation.throwIfCancelled()
    if (hasMultipleFrames(file.path, cancellation)) {
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    val orientation = readOrientation(file.path)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    val pixelCount = bounds.outWidth.toLong() * bounds.outHeight.toLong()
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    if (pixelCount > maximumPixelCount) throw NativeException("RESOURCE_MEMORY_PRESSURE")
    val decodeOptions = BitmapFactory.Options().apply {
      inSampleSize = 1
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    cancellation.attachDecode(decodeOptions)
    val decoded = try {
      BitmapFactory.decodeFile(file.path, decodeOptions)
        ?: throw NativeException(
          if (Thread.currentThread().isInterrupted) "PIPELINE_STAGE_FAILED"
          else "PROCESSOR_OUTPUT_INVALID",
        )
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } finally {
      cancellation.detachDecode(decodeOptions)
    }
    val luminance = try {
      cancellation.throwIfCancelled()
      sampleLuminance(decoded, orientation, cancellation)
    } finally {
      decoded.recycle()
    }
    cancellation.throwIfCancelled()
    if (file.length() != expectedByteCount || sha256(file.path, cancellation) != expectedSha256) {
      throw NativeException("ARTIFACT_INTEGRITY_FAILED")
    }
    return mapOf(
      "schemaVersion" to 1,
      "algorithm" to "dhash-64-v1",
      "hash" to differenceHash(luminance),
      "sampleWidth" to sampleWidth,
      "sampleHeight" to sampleHeight,
      "orientationApplied" to true,
      "durationMs" to (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0,
      "revision" to "1",
    )
  }

  internal fun differenceHash(luminance: IntArray): String {
    require(luminance.size == sampleWidth * sampleHeight)
    var result = 0UL
    for (row in 0 until sampleHeight) {
      for (column in 0 until sampleWidth - 1) {
        result = result shl 1
        if (luminance[row * sampleWidth + column] >
          luminance[row * sampleWidth + column + 1]) result = result or 1UL
      }
    }
    return result.toString(16).padStart(16, '0')
  }

  internal fun sampleLuminance(pixels: IntArray, width: Int, height: Int): IntArray {
    require(width > 0 && height > 0 && pixels.size == width * height)
    val totals = LongArray(sampleWidth * sampleHeight)
    val counts = LongArray(sampleWidth * sampleHeight)
    for (y in 0 until height) {
      for (x in 0 until width) {
        accumulateSample(totals, counts, x, y, width, height, luminanceOverWhite(pixels[y * width + x]))
      }
    }
    return averagedSamples(totals, counts)
  }

  internal fun orientedCoordinate(
    x: Int,
    y: Int,
    width: Int,
    height: Int,
    orientation: Int,
  ): Pair<Int, Int> = when (orientation) {
    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> Pair(width - 1 - x, y)
    ExifInterface.ORIENTATION_ROTATE_180 -> Pair(width - 1 - x, height - 1 - y)
    ExifInterface.ORIENTATION_FLIP_VERTICAL -> Pair(x, height - 1 - y)
    ExifInterface.ORIENTATION_TRANSPOSE -> Pair(y, x)
    ExifInterface.ORIENTATION_ROTATE_90 -> Pair(height - 1 - y, x)
    ExifInterface.ORIENTATION_TRANSVERSE -> Pair(height - 1 - y, width - 1 - x)
    ExifInterface.ORIENTATION_ROTATE_270 -> Pair(y, width - 1 - x)
    else -> Pair(x, y)
  }

  private fun sampleLuminance(
    bitmap: Bitmap,
    orientation: Int,
    cancellation: ImageHashCancellationToken,
  ): IntArray {
    val width = bitmap.width
    val height = bitmap.height
    val swapsAxes = orientation in setOf(
      ExifInterface.ORIENTATION_TRANSPOSE,
      ExifInterface.ORIENTATION_ROTATE_90,
      ExifInterface.ORIENTATION_TRANSVERSE,
      ExifInterface.ORIENTATION_ROTATE_270,
    )
    val orientedWidth = if (swapsAxes) height else width
    val orientedHeight = if (swapsAxes) width else height
    val rowPixels = IntArray(width)
    val totals = LongArray(sampleWidth * sampleHeight)
    val counts = LongArray(sampleWidth * sampleHeight)
    for (y in 0 until height) {
      cancellation.throwIfCancelled()
      bitmap.getPixels(rowPixels, 0, width, 0, y, width, 1)
      for (x in 0 until width) {
        val (orientedX, orientedY) = orientedCoordinate(x, y, width, height, orientation)
        accumulateSample(
          totals,
          counts,
          orientedX,
          orientedY,
          orientedWidth,
          orientedHeight,
          luminanceOverWhite(rowPixels[x]),
        )
      }
    }
    return averagedSamples(totals, counts)
  }

  private fun accumulateSample(
    totals: LongArray,
    counts: LongArray,
    x: Int,
    y: Int,
    width: Int,
    height: Int,
    luminance: Int,
  ) {
    for (row in matchingBuckets(y, height, sampleHeight)) {
      for (column in matchingBuckets(x, width, sampleWidth)) {
        val index = row * sampleWidth + column
        totals[index] += luminance.toLong()
        counts[index] += 1
      }
    }
  }

  private fun matchingBuckets(coordinate: Int, length: Int, count: Int): IntRange {
    if (length >= count) {
      val bucket = minOf(count - 1, (((coordinate + 1L) * count - 1L) / length).toInt())
      return bucket..bucket
    }
    var first = count
    var last = -1
    for (bucket in 0 until count) {
      val start = bucket * length / count
      val end = minOf(length, maxOf(start + 1, (bucket + 1) * length / count))
      if (coordinate in start until end) {
        first = minOf(first, bucket)
        last = maxOf(last, bucket)
      }
    }
    check(first <= last)
    return first..last
  }

  private fun averagedSamples(totals: LongArray, counts: LongArray): IntArray =
    IntArray(totals.size) { index ->
      check(counts[index] > 0)
      (totals[index] / counts[index]).toInt()
    }

  private fun luminanceOverWhite(pixel: Int): Int {
    val alpha = pixel ushr 24 and 0xff
    val red = pixel shr 16 and 0xff
    val green = pixel shr 8 and 0xff
    val blue = pixel and 0xff
    val compositedRed = (red * alpha + 255 * (255 - alpha) + 127) / 255
    val compositedGreen = (green * alpha + 255 * (255 - alpha) + 127) / 255
    val compositedBlue = (blue * alpha + 255 * (255 - alpha) + 127) / 255
    return (299 * compositedRed + 587 * compositedGreen + 114 * compositedBlue) / 1_000
  }

  private fun readOrientation(path: String): Int = try {
    ExifInterface(path).getAttributeInt(
      ExifInterface.TAG_ORIENTATION,
      ExifInterface.ORIENTATION_NORMAL,
    )
  } catch (_: Exception) {
    ExifInterface.ORIENTATION_NORMAL
  }

  private fun hasMultipleFrames(
    path: String,
    cancellation: ImageHashCancellationToken,
  ): Boolean {
    cancellation.throwIfCancelled()
    if (runCatching { Movie.decodeFile(path)?.duration() ?: 0 }.getOrDefault(0) > 0) {
      return true
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val drawable = try {
        ImageDecoder.decodeDrawable(ImageDecoder.createSource(java.io.File(path))) {
          decoder, info, _ ->
          decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
          decoder.setTargetSize(
            maxOf(1, minOf(info.size.width, sampleWidth)),
            maxOf(1, minOf(info.size.height, sampleHeight)),
          )
        }
      } catch (_: Exception) {
        null
      }
      if (drawable is AnimatedImageDrawable) {
        drawable.stop()
        return true
      }
    }
    val header = java.io.File(path).inputStream().use { input ->
      ByteArray(32).also { bytes -> input.read(bytes) }
    }
    return isAnimatedWebPHeader(header)
  }

  internal fun isAnimatedWebPHeader(header: ByteArray): Boolean =
    header.size >= 21 &&
      String(header, 0, 4, Charsets.US_ASCII) == "RIFF" &&
      String(header, 8, 4, Charsets.US_ASCII) == "WEBP" &&
      String(header, 12, 4, Charsets.US_ASCII) == "VP8X" &&
      (header[20].toInt() and 0x02) != 0

  private fun sha256(path: String, cancellation: ImageHashCancellationToken): String {
    val digest = MessageDigest.getInstance("SHA-256")
    java.io.File(path).inputStream().buffered().use { input ->
      val buffer = ByteArray(64 * 1_024)
      while (true) {
        cancellation.throwIfCancelled()
        val read = input.read(buffer)
        if (read < 0) break
        if (read > 0) digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
