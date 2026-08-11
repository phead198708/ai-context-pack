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
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.DataInputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

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

  fun isCancelled(): Boolean = cancelled.get()
}

internal class ImageHashTaskRegistry {
  private data class Entry(
    val ownerId: String,
    val token: ImageHashCancellationToken,
    var cancelAndWait: (() -> Boolean)? = null,
  )

  private val entries = mutableMapOf<String, Entry>()

  @Synchronized
  fun reserve(ownerId: String, taskId: String): ImageHashCancellationToken? {
    if (!isCanonicalImageHashTaskId(taskId) || entries.containsKey(taskId)) return null
    return ImageHashCancellationToken().also { entries[taskId] = Entry(ownerId, it) }
  }

  fun attach(
    ownerId: String,
    taskId: String,
    token: ImageHashCancellationToken,
    cancelAndWait: () -> Boolean,
  ) {
    val acceptedAndCancelled = synchronized(this) {
      val entry = entries[taskId]
      if (entry?.ownerId == ownerId && entry.token === token) {
        entry.cancelAndWait = cancelAndWait
        Pair(true, entry.token.isCancelled())
      } else Pair(false, false)
    }
    if (!acceptedAndCancelled.first || acceptedAndCancelled.second) cancelAndWait()
  }

  fun cancel(ownerId: String, taskId: String): Boolean {
    val cancellation = synchronized(this) {
      val entry = entries[taskId]
      if (entry?.ownerId != ownerId) return false
      entry.token.cancel()
      entry.cancelAndWait
    }
    return cancellation?.invoke() ?: true
  }

  @Synchronized
  fun finish(ownerId: String, taskId: String, token: ImageHashCancellationToken) {
    val entry = entries[taskId]
    if (entry?.ownerId == ownerId && entry.token === token) entries.remove(taskId)
  }

  fun destroyOwner(ownerId: String) {
    val owned = synchronized(this) {
      val ownedEntries = entries.filterValues { it.ownerId == ownerId }.values.toList()
      entries.entries.removeAll { it.value.ownerId == ownerId }
      ownedEntries.onEach { it.token.cancel() }.mapNotNull { it.cancelAndWait }
    }
    owned.forEach { it() }
  }
}

internal class ImageHashScheduledWork(
  private val executor: ThreadPoolExecutor,
  private val token: ImageHashCancellationToken,
  private val action: () -> Unit,
  private val cancelBeforeStart: () -> Unit,
  private val afterFinish: () -> Unit,
) {
  private val started = AtomicBoolean(false)
  private val scheduled = AtomicBoolean(false)
  private val finished = AtomicBoolean(false)
  private val finishedLatch = CountDownLatch(1)
  private val worker = AtomicReference<Thread?>()
  private val runnable = Runnable {
    started.set(true)
    worker.set(Thread.currentThread())
    try {
      token.throwIfCancelled()
      action()
    } finally {
      worker.set(null)
      finishOnce()
    }
  }

  fun schedule() {
    check(scheduled.compareAndSet(false, true))
    if (finished.get() || token.isCancelled()) {
      cancelBeforeStart()
      finishOnce()
      return
    }
    try { executor.execute(runnable) } catch (error: RuntimeException) {
      finishOnce()
      throw error
    }
  }

  fun cancelAndWait(): Boolean {
    token.cancel()
    if (!scheduled.get() && !started.get()) {
      cancelBeforeStart()
      finishOnce()
      return true
    }
    val removed = executor.remove(runnable)
    if (removed && !started.get()) {
      cancelBeforeStart()
      finishOnce()
    } else {
      worker.get()?.interrupt()
    }
    return finishedLatch.await(2, TimeUnit.SECONDS)
  }

  private fun finishOnce() {
    if (!finished.compareAndSet(false, true)) return
    try { afterFinish() } finally { finishedLatch.countDown() }
  }
}

internal class ImmutableImageSnapshot private constructor(val file: File) : Closeable {
  override fun close() { file.delete() }

  companion object {
    fun create(
      context: Context,
      source: File,
      expectedByteCount: Long,
      expectedSha256: String,
      cancellation: ImageHashCancellationToken,
    ): ImmutableImageSnapshot {
      if (
        expectedByteCount !in 1..ImagePerceptualHasher.maximumSourceBytes ||
        !Regex("^[0-9a-f]{64}$").matches(expectedSha256)
      ) throw NativeException("ARTIFACT_INTEGRITY_FAILED")
      val sourceFd = try {
        Os.open(
          source.path,
          OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW,
          0,
        )
      } catch (_: Exception) {
        throw NativeException("ARTIFACT_INTEGRITY_FAILED")
      }
      val snapshot = try {
        File.createTempFile("aicp-image-hash-", ".snapshot", context.cacheDir)
      } catch (_: Exception) {
        Os.close(sourceFd)
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      }
      var keep = false
      try {
        val stat = Os.fstat(sourceFd)
        if (!OsConstants.S_ISREG(stat.st_mode) || stat.st_size != expectedByteCount) {
          throw NativeException("ARTIFACT_INTEGRITY_FAILED")
        }
        val destinationFd = Os.open(
          snapshot.path,
          OsConstants.O_WRONLY or OsConstants.O_TRUNC or OsConstants.O_CLOEXEC or
            OsConstants.O_NOFOLLOW,
          0,
        )
        try {
          val digest = MessageDigest.getInstance("SHA-256")
          val buffer = ByteArray(64 * 1_024)
          var copied = 0L
          while (true) {
            cancellation.throwIfCancelled()
            val count = Os.read(sourceFd, buffer, 0, buffer.size)
            if (count == 0) break
            copied += count
            if (copied > expectedByteCount) throw NativeException("ARTIFACT_INTEGRITY_FAILED")
            digest.update(buffer, 0, count)
            var written = 0
            while (written < count) {
              val amount = Os.write(destinationFd, buffer, written, count - written)
              if (amount <= 0) throw NativeException("RESOURCE_MEMORY_PRESSURE")
              written += amount
            }
          }
          val actual = digest.digest().joinToString("") { "%02x".format(it) }
          if (copied != expectedByteCount || actual != expectedSha256) {
            throw NativeException("ARTIFACT_INTEGRITY_FAILED")
          }
        } finally {
          Os.close(destinationFd)
        }
        Os.chmod(snapshot.path, OsConstants.S_IRUSR)
        keep = true
        return ImmutableImageSnapshot(snapshot)
      } catch (error: NativeException) {
        throw error
      } catch (_: Exception) {
        throw NativeException("ARTIFACT_INTEGRITY_FAILED")
      } finally {
        Os.close(sourceFd)
        if (!keep) snapshot.delete()
      }
    }
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

  fun hash(
    context: Context,
    fileUri: String,
    expectedByteCount: Long,
    expectedSha256: String,
    cancellation: ImageHashCancellationToken = ImageHashCancellationToken(),
    sourceMutationHook: ((String) -> Unit)? = null,
  ): Map<String, Any> {
    val started = SystemClock.elapsedRealtimeNanos()
    cancellation.throwIfCancelled()
    val source = controlledSandboxFile(context, fileUri)
    ImmutableImageSnapshot.create(
      context,
      source,
      expectedByteCount,
      expectedSha256,
      cancellation,
    ).use { snapshot ->
      val file = snapshot.file
      sourceMutationHook?.invoke("snapshot-ready")
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
      sourceMutationHook?.invoke("decode-complete")
      cancellation.throwIfCancelled()
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
    if (java.io.File(path).inputStream().buffered().use(::isAnimatedPng)) return true
    if (java.io.File(path).inputStream().buffered().use(::isAnimatedGif)) return true
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

  internal fun isAnimatedPng(bytes: ByteArray): Boolean =
    ByteArrayInputStream(bytes).use(::isAnimatedPng)

  internal fun isAnimatedGif(bytes: ByteArray): Boolean =
    ByteArrayInputStream(bytes).use(::isAnimatedGif)

  private fun isAnimatedPng(input: InputStream): Boolean {
    val data = DataInputStream(input)
    val signature = ByteArray(8)
    if (runCatching { data.readFully(signature) }.isFailure ||
      !signature.contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))) return false
    repeat(1_024) {
      val length = runCatching { data.readInt().toLong() and 0xffff_ffffL }.getOrNull()
        ?: return false
      if (length > maximumSourceBytes) return false
      val type = ByteArray(4)
      if (runCatching { data.readFully(type) }.isFailure) return false
      if (type.contentEquals("acTL".toByteArray(Charsets.US_ASCII))) {
        if (length != 8L) return true
        val frameCount = runCatching { data.readInt().toLong() and 0xffff_ffffL }.getOrNull()
          ?: return true
        return frameCount != 1L
      }
      var remaining = length + 4L // chunk data plus CRC
      while (remaining > 0) {
        val skipped = data.skip(remaining)
        if (skipped <= 0) return false
        remaining -= skipped
      }
      if (type.contentEquals("IEND".toByteArray(Charsets.US_ASCII))) return false
    }
    return false
  }

  private fun isAnimatedGif(input: InputStream): Boolean {
    val data = DataInputStream(input)
    val header = ByteArray(6)
    if (runCatching { data.readFully(header) }.isFailure ||
      String(header, Charsets.US_ASCII) !in setOf("GIF87a", "GIF89a")) return false
    val descriptor = ByteArray(7)
    if (runCatching { data.readFully(descriptor) }.isFailure) return false
    if ((descriptor[4].toInt() and 0x80) != 0) {
      val tableBytes = 3L * (1 shl ((descriptor[4].toInt() and 0x07) + 1))
      if (!skipExactly(data, tableBytes)) return false
    }
    var frameCount = 0
    repeat(65_536) {
      when (runCatching { data.readUnsignedByte() }.getOrNull() ?: return false) {
        0x2c -> {
          val imageDescriptor = ByteArray(9)
          if (runCatching { data.readFully(imageDescriptor) }.isFailure) return false
          if ((imageDescriptor[8].toInt() and 0x80) != 0) {
            val tableBytes = 3L * (1 shl ((imageDescriptor[8].toInt() and 0x07) + 1))
            if (!skipExactly(data, tableBytes)) return false
          }
          if (runCatching { data.readUnsignedByte() }.isFailure || !skipSubBlocks(data)) return false
          frameCount += 1
          if (frameCount > 1) return true
        }
        0x21 -> {
          if (runCatching { data.readUnsignedByte() }.isFailure || !skipSubBlocks(data)) return false
        }
        0x3b -> return false
        else -> return false
      }
    }
    return false
  }

  private fun skipSubBlocks(data: DataInputStream): Boolean {
    repeat(65_536) {
      val length = runCatching { data.readUnsignedByte() }.getOrNull() ?: return false
      if (length == 0) return true
      if (!skipExactly(data, length.toLong())) return false
    }
    return false
  }

  private fun skipExactly(data: DataInputStream, byteCount: Long): Boolean {
    var remaining = byteCount
    while (remaining > 0) {
      val skipped = data.skip(remaining)
      if (skipped <= 0) return false
      remaining -= skipped
    }
    return true
  }
}
