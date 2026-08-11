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
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.CRC32

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

internal object ImageHashSnapshotStore {
  private const val directoryName = "ImageHashSnapshots"
  private const val prefix = "snapshot-"
  private const val suffix = ".tmp"
  const val staleAfterMs = 60 * 60 * 1_000L

  fun prepare(context: Context): File {
    val directory = File(context.cacheDir, directoryName)
    if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    runCatching { Os.chmod(directory.path, OsConstants.S_IRWXU) }
      .getOrElse { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    return directory
  }

  fun runStartupMaintenance(context: Context, nowEpochMs: Long = System.currentTimeMillis()) {
    val directory = runCatching { prepare(context) }.getOrNull() ?: return
    purgeStale(directory, nowEpochMs - staleAfterMs)
  }

  internal fun purgeStale(directory: File, olderThanEpochMs: Long): Int {
    if (!directory.isDirectory) return 0
    var removed = 0
    for (candidate in directory.listFiles().orEmpty()) {
      if (
        !candidate.name.startsWith(prefix) ||
        !candidate.name.endsWith(suffix) ||
        !candidate.isFile ||
        runCatching { candidate.canonicalFile.parentFile != directory.canonicalFile }
          .getOrDefault(true) ||
        candidate.lastModified() >= olderThanEpochMs
      ) continue
      if (candidate.delete()) removed += 1
    }
    return removed
  }

  fun create(context: Context): File = try {
    File.createTempFile(prefix, suffix, prepare(context))
  } catch (_: NativeException) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  } catch (_: Exception) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
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
        ImageHashSnapshotStore.create(context)
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
      if (violatesSingleFramePolicy(file.path, cancellation)) {
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

  private fun violatesSingleFramePolicy(
    path: String,
    cancellation: ImageHashCancellationToken,
  ): Boolean {
    cancellation.throwIfCancelled()
    val sourceLength = java.io.File(path).length()
    if (sourceLength !in 1..maximumSourceBytes) return true
    when (
      java.io.File(path).inputStream().buffered().use { input ->
        inspectPngFrames(input, sourceLength, cancellation)
      }
    ) {
      ContainerFrameInspection.ANIMATED,
      ContainerFrameInspection.INVALID,
      -> return true
      ContainerFrameInspection.SINGLE -> return false
      ContainerFrameInspection.NOT_RECOGNIZED -> Unit
    }
    when (
      java.io.File(path).inputStream().buffered().use { input ->
        inspectGifFrames(input, sourceLength, cancellation)
      }
    ) {
      ContainerFrameInspection.ANIMATED,
      ContainerFrameInspection.INVALID,
      -> return true
      ContainerFrameInspection.SINGLE -> return false
      ContainerFrameInspection.NOT_RECOGNIZED -> Unit
    }
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
    inspectPngFrames(bytes) == ContainerFrameInspection.ANIMATED

  internal fun isAnimatedGif(bytes: ByteArray): Boolean =
    inspectGifFrames(bytes) == ContainerFrameInspection.ANIMATED

  internal fun inspectPngFrames(bytes: ByteArray): ContainerFrameInspection =
    ByteArrayInputStream(bytes).use { input ->
      inspectPngFrames(input, bytes.size.toLong(), ImageHashCancellationToken())
    }

  internal fun inspectGifFrames(bytes: ByteArray): ContainerFrameInspection =
    ByteArrayInputStream(bytes).use { input ->
      inspectGifFrames(input, bytes.size.toLong(), ImageHashCancellationToken())
    }

  private fun inspectPngFrames(
    input: InputStream,
    maximumBytes: Long,
    cancellation: ImageHashCancellationToken,
  ): ContainerFrameInspection {
    val reader = BoundedContainerReader(input, maximumBytes, cancellation)
    val signature = reader.readBytes(8) ?: return ContainerFrameInspection.NOT_RECOGNIZED
    if (!signature.contentEquals(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))) {
      return ContainerFrameInspection.NOT_RECOGNIZED
    }
    var sawHeader = false
    var sawImageData = false
    var declaredAnimationFrames: Long? = null
    var animationFrameControls = 0L
    var nextAnimationSequence = 0L
    var currentAnimationFrameHasData = false
    while (true) {
      val length = reader.readUnsignedInt() ?: return ContainerFrameInspection.INVALID
      val type = reader.readBytes(4) ?: return ContainerFrameInspection.INVALID
      if (!isValidPngChunkType(type) || length > reader.remainingBytes - 4L) {
        return ContainerFrameInspection.INVALID
      }
      val typeName = String(type, Charsets.US_ASCII)
      if (!sawHeader && (typeName != "IHDR" || length != 13L)) {
        return ContainerFrameInspection.INVALID
      }
      if (typeName == "IHDR" && sawHeader) return ContainerFrameInspection.INVALID
      if (
        typeName == "acTL" &&
        (length != 8L || declaredAnimationFrames != null || sawImageData)
      ) {
        return ContainerFrameInspection.INVALID
      }
      if (typeName == "fcTL" && (length != 26L || declaredAnimationFrames == null)) {
        return ContainerFrameInspection.INVALID
      }
      if (typeName == "fdAT" && (length < 4L || declaredAnimationFrames == null)) {
        return ContainerFrameInspection.INVALID
      }
      if (typeName == "IEND" && length != 0L) return ContainerFrameInspection.INVALID

      val crc = CRC32().apply { update(type) }
      val animationData = when (typeName) {
        "acTL" -> ByteArray(8)
        "fcTL" -> ByteArray(26)
        "fdAT" -> ByteArray(4)
        else -> null
      }
      if (!reader.readPayload(length, crc, animationData)) {
        return ContainerFrameInspection.INVALID
      }
      val expectedCrc = reader.readUnsignedInt() ?: return ContainerFrameInspection.INVALID
      if (crc.value != expectedCrc) return ContainerFrameInspection.INVALID

      when (typeName) {
        "IHDR" -> sawHeader = true
        "IDAT" -> {
          sawImageData = true
          if (animationFrameControls == 1L) currentAnimationFrameHasData = true
        }
        "acTL" -> {
          val frameCount = unsignedInt(animationData!!, 0)
          if (frameCount == 0L) return ContainerFrameInspection.INVALID
          declaredAnimationFrames = frameCount
        }
        "fcTL" -> {
          if (animationFrameControls > 0L && !currentAnimationFrameHasData) {
            return ContainerFrameInspection.INVALID
          }
          if (unsignedInt(animationData!!, 0) != nextAnimationSequence) {
            return ContainerFrameInspection.INVALID
          }
          nextAnimationSequence += 1
          animationFrameControls += 1
          currentAnimationFrameHasData = false
          if (animationFrameControls > declaredAnimationFrames!!) {
            return ContainerFrameInspection.INVALID
          }
        }
        "fdAT" -> {
          if (
            animationFrameControls == 0L ||
            unsignedInt(animationData!!, 0) != nextAnimationSequence
          ) {
            return ContainerFrameInspection.INVALID
          }
          nextAnimationSequence += 1
          currentAnimationFrameHasData = true
        }
        "IEND" -> {
          if (!sawHeader || !sawImageData || !reader.isAtExactEof()) {
            return ContainerFrameInspection.INVALID
          }
          val declared = declaredAnimationFrames
          if (
            declared != null &&
            (animationFrameControls != declared || !currentAnimationFrameHasData)
          ) {
            return ContainerFrameInspection.INVALID
          }
          return if (declared != null && declared > 1L) {
            ContainerFrameInspection.ANIMATED
          } else {
            ContainerFrameInspection.SINGLE
          }
        }
      }
    }
  }

  private fun inspectGifFrames(
    input: InputStream,
    maximumBytes: Long,
    cancellation: ImageHashCancellationToken,
  ): ContainerFrameInspection {
    val reader = BoundedContainerReader(input, maximumBytes, cancellation)
    val header = reader.readBytes(6) ?: return ContainerFrameInspection.NOT_RECOGNIZED
    if (String(header, Charsets.US_ASCII) !in setOf("GIF87a", "GIF89a")) {
      return ContainerFrameInspection.NOT_RECOGNIZED
    }
    val descriptor = reader.readBytes(7) ?: return ContainerFrameInspection.INVALID
    if ((descriptor[4].toInt() and 0x80) != 0) {
      val tableBytes = 3L * (1 shl ((descriptor[4].toInt() and 0x07) + 1))
      if (!reader.skipExactly(tableBytes)) return ContainerFrameInspection.INVALID
    }
    var frameCount = 0
    while (true) {
      when (reader.readByte() ?: return ContainerFrameInspection.INVALID) {
        0x2c -> {
          val imageDescriptor = reader.readBytes(9) ?: return ContainerFrameInspection.INVALID
          if ((imageDescriptor[8].toInt() and 0x80) != 0) {
            val tableBytes = 3L * (1 shl ((imageDescriptor[8].toInt() and 0x07) + 1))
            if (!reader.skipExactly(tableBytes)) return ContainerFrameInspection.INVALID
          }
          if (reader.readByte() == null || !skipGifSubBlocks(reader)) {
            return ContainerFrameInspection.INVALID
          }
          frameCount += 1
        }
        0x21 -> {
          if (reader.readByte() == null || !skipGifSubBlocks(reader)) {
            return ContainerFrameInspection.INVALID
          }
        }
        0x3b -> {
          if (!reader.isAtExactEof() || frameCount == 0) {
            return ContainerFrameInspection.INVALID
          }
          return if (frameCount > 1) {
            ContainerFrameInspection.ANIMATED
          } else {
            ContainerFrameInspection.SINGLE
          }
        }
        else -> return ContainerFrameInspection.INVALID
      }
    }
  }

  private fun skipGifSubBlocks(reader: BoundedContainerReader): Boolean {
    while (true) {
      val length = reader.readByte() ?: return false
      if (length == 0) return true
      if (!reader.skipExactly(length.toLong())) return false
    }
  }

  private fun isValidPngChunkType(type: ByteArray): Boolean =
    type.size == 4 &&
      type.all { byte ->
        val value = byte.toInt() and 0xff
        value in 'A'.code..'Z'.code || value in 'a'.code..'z'.code
      } &&
      (type[2].toInt() and 0x20) == 0

  private fun unsignedInt(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset].toLong() and 0xffL) shl 24) or
      ((bytes[offset + 1].toLong() and 0xffL) shl 16) or
      ((bytes[offset + 2].toLong() and 0xffL) shl 8) or
      (bytes[offset + 3].toLong() and 0xffL)
}

internal enum class ContainerFrameInspection {
  NOT_RECOGNIZED,
  SINGLE,
  ANIMATED,
  INVALID,
}

private class BoundedContainerReader(
  private val input: InputStream,
  private val maximumBytes: Long,
  private val cancellation: ImageHashCancellationToken,
) {
  private val transferBuffer = ByteArray(16 * 1_024)
  var consumedBytes: Long = 0
    private set
  val remainingBytes: Long
    get() = maximumBytes - consumedBytes

  fun readByte(): Int? {
    cancellation.throwIfCancelled()
    if (consumedBytes >= maximumBytes) return null
    val value = input.read()
    if (value < 0) return null
    consumedBytes += 1
    return value
  }

  fun readBytes(byteCount: Int): ByteArray? {
    if (byteCount < 0 || byteCount.toLong() > remainingBytes) return null
    val value = ByteArray(byteCount)
    var offset = 0
    while (offset < byteCount) {
      cancellation.throwIfCancelled()
      val count = input.read(value, offset, byteCount - offset)
      if (count <= 0) return null
      offset += count
      consumedBytes += count
    }
    return value
  }

  fun readUnsignedInt(): Long? {
    val bytes = readBytes(4) ?: return null
    return ((bytes[0].toLong() and 0xffL) shl 24) or
      ((bytes[1].toLong() and 0xffL) shl 16) or
      ((bytes[2].toLong() and 0xffL) shl 8) or
      (bytes[3].toLong() and 0xffL)
  }

  fun readPayload(byteCount: Long, crc: CRC32, capture: ByteArray?): Boolean {
    if (
      byteCount < 0 ||
      byteCount > remainingBytes ||
      (capture != null && capture.size.toLong() > byteCount)
    ) {
      return false
    }
    var remaining = byteCount
    var captured = 0
    while (remaining > 0) {
      cancellation.throwIfCancelled()
      val requested = minOf(transferBuffer.size.toLong(), remaining).toInt()
      val count = input.read(transferBuffer, 0, requested)
      if (count <= 0) return false
      crc.update(transferBuffer, 0, count)
      capture?.let {
        if (captured < it.size) {
          val capturedCount = minOf(count, it.size - captured)
          transferBuffer.copyInto(it, captured, 0, capturedCount)
          captured += capturedCount
        }
      }
      consumedBytes += count
      remaining -= count
    }
    return true
  }

  fun skipExactly(byteCount: Long): Boolean {
    if (byteCount < 0 || byteCount > remainingBytes) return false
    var remaining = byteCount
    while (remaining > 0) {
      cancellation.throwIfCancelled()
      val requested = minOf(transferBuffer.size.toLong(), remaining).toInt()
      val count = input.read(transferBuffer, 0, requested)
      if (count <= 0) return false
      consumedBytes += count
      remaining -= count
    }
    return true
  }

  fun isAtExactEof(): Boolean {
    cancellation.throwIfCancelled()
    val value = input.read()
    if (value < 0) return true
    consumedBytes += 1
    return false
  }
}
