package com.aicontextpack.nativebridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Rect
import android.media.ExifInterface
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.FilterInputStream
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
  internal val currentProcessPrefix =
    "$prefix${UUID.randomUUID().toString().replace("-", "")}-"
  private val currentProcessOrphans = mutableSetOf<File>()

  fun prepare(context: Context): File {
    val directory = File(context.cacheDir, directoryName)
    if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    runCatching { Os.chmod(directory.path, OsConstants.S_IRWXU) }
      .getOrElse { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    return directory
  }

  fun runStartupMaintenance(context: Context) {
    val directory = runCatching { prepare(context) }.getOrNull() ?: return
    purgeInherited(directory)
    retryCurrentProcessOrphans()
  }

  @Synchronized
  internal fun registerCurrentProcessOrphan(candidate: File) {
    if (
      candidate.name.startsWith(currentProcessPrefix) &&
      candidate.name.endsWith(suffix)
    ) currentProcessOrphans += candidate
  }

  internal fun retryCurrentProcessOrphans(): Int {
    val candidates = synchronized(this) { currentProcessOrphans.toList() }
    var removed = 0
    for (candidate in candidates) {
      if (deleteSnapshot(candidate)) {
        synchronized(this) { currentProcessOrphans.remove(candidate) }
        removed += 1
      }
    }
    return removed
  }

  internal fun deleteSnapshot(
    candidate: File,
    remove: (File) -> Boolean = { file -> file.delete() },
    classify: (File) -> SnapshotPathState = ::classifySnapshotPath,
  ): Boolean {
    if (runCatching { remove(candidate) }.getOrDefault(false)) return true
    return runCatching { classify(candidate) }
      .getOrDefault(SnapshotPathState.UNVERIFIED) == SnapshotPathState.ABSENT
  }

  internal fun classifySnapshotPath(candidate: File): SnapshotPathState = try {
    Os.lstat(candidate.path)
    SnapshotPathState.PRESENT
  } catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) SnapshotPathState.ABSENT
    else SnapshotPathState.UNVERIFIED
  } catch (_: Exception) {
    SnapshotPathState.UNVERIFIED
  }

  internal fun purgeInherited(
    directory: File,
    preservingPrefix: String = currentProcessPrefix,
  ): Int {
    if (!directory.isDirectory) return 0
    var removed = 0
    val canonicalDirectory = runCatching { directory.canonicalFile }.getOrNull() ?: return 0
    for (candidate in directory.listFiles().orEmpty()) {
      if (
        !candidate.name.startsWith(prefix) ||
        !candidate.name.endsWith(suffix) ||
        candidate.name.startsWith(preservingPrefix) ||
        !candidate.isFile ||
        runCatching {
          candidate.canonicalFile != File(canonicalDirectory, candidate.name)
        }.getOrDefault(true)
      ) continue
      if (candidate.delete()) removed += 1
    }
    return removed
  }

  fun create(context: Context): File = try {
    val directory = prepare(context)
    retryCurrentProcessOrphans()
    File.createTempFile(currentProcessPrefix, suffix, directory)
  } catch (_: NativeException) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  } catch (_: Exception) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  }
}

internal class ImmutableImageSnapshot internal constructor(
  val file: File,
  private val classify: (File) -> SnapshotPathState = ImageHashSnapshotStore::classifySnapshotPath,
  private val remove: (File) -> Boolean = { candidate -> candidate.delete() },
) : Closeable {
  override fun close() {
    if (!ImageHashSnapshotStore.deleteSnapshot(file, remove, classify)) {
      ImageHashSnapshotStore.registerCurrentProcessOrphan(file)
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
  }

  internal fun <ResultValue> useDeleting(body: (File) -> ResultValue): ResultValue {
    val result = runCatching { body(file) }
    // A cleanup error wins over a processing error so private snapshot
    // retention cannot be hidden behind the original failure.
    close()
    return result.getOrThrow()
  }

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
      var failure: NativeException? = null
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
        failure = error
        throw error
      } catch (_: Exception) {
        val error = NativeException("ARTIFACT_INTEGRITY_FAILED")
        failure = error
        throw error
      } finally {
        Os.close(sourceFd)
        if (!keep && !ImageHashSnapshotStore.deleteSnapshot(snapshot)) {
          ImageHashSnapshotStore.registerCurrentProcessOrphan(snapshot)
          val cleanupError = NativeException("RESOURCE_MEMORY_PRESSURE")
          failure?.let { cleanupError.addSuppressed(it) }
          throw cleanupError
        }
      }
    }
  }
}

internal enum class SnapshotPathState {
  PRESENT,
  ABSENT,
  UNVERIFIED,
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
  private const val maximumBmffItems = 4_096
  private val bmffImageItemTypes = setOf(
    "hvc1", "hev1", "av01", "jpeg", "j2k1", "j2k2", "grid", "iovl", "iden",
  )
  private val bmffPreludeBoxTypes = setOf("free", "skip", "wide", "uuid")
  // v1 retains one bounded decoded bitmap plus one scanline. It never creates an
  // orientation copy or a full-image IntArray.
  const val maximumPixelCount = 16_000_000L
  internal const val maximumDecodeRegionPixels = 1_000_000L
  internal const val maximumFallbackDecodePixels = 1_000_000L

  fun hash(
    context: Context,
    fileUri: String,
    expectedByteCount: Long,
    expectedSha256: String,
    cancellation: ImageHashCancellationToken = ImageHashCancellationToken(),
    sourceMutationHook: ((String) -> Unit)? = null,
    fullDecodeReadHook: ((Long) -> Unit)? = null,
    regionDecodedHook: (() -> Unit)? = null,
    maximumRegionPixels: Long = maximumDecodeRegionPixels,
    forceFallbackDecode: Boolean = false,
  ): Map<String, Any> {
    val started = SystemClock.elapsedRealtimeNanos()
    cancellation.throwIfCancelled()
    val source = controlledSandboxFile(context, fileUri)
    return ImmutableImageSnapshot.create(
      context,
      source,
      expectedByteCount,
      expectedSha256,
      cancellation,
    ).useDeleting { file ->
      sourceMutationHook?.invoke("snapshot-ready")
      cancellation.throwIfCancelled()
      if (violatesSingleFramePolicy(file.path, cancellation)) {
        throw NativeException("PROCESSOR_OUTPUT_INVALID")
      }
      val orientation = readOrientation(file, expectedByteCount, cancellation)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      cancellation.attachDecode(bounds)
      try {
        file.inputStream().use { source ->
          CancellableBoundedInputStream(source, expectedByteCount, cancellation).use { input ->
            BitmapFactory.decodeStream(input, null, bounds)
          }
        }
        cancellation.throwIfCancelled()
      } finally {
        cancellation.detachDecode(bounds)
      }
      val pixelCount = bounds.outWidth.toLong() * bounds.outHeight.toLong()
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        throw NativeException("PROCESSOR_OUTPUT_INVALID")
      }
      if (pixelCount > maximumPixelCount) throw NativeException("RESOURCE_MEMORY_PRESSURE")
      val luminance = decodeAndSampleRegions(
        file,
        expectedByteCount,
        bounds.outWidth,
        bounds.outHeight,
        orientation,
        cancellation,
        fullDecodeReadHook,
        regionDecodedHook,
        maximumRegionPixels,
        forceFallbackDecode,
      )
      sourceMutationHook?.invoke("decode-complete")
      cancellation.throwIfCancelled()
      mapOf(
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

  private fun decodeAndSampleRegions(
    file: File,
    expectedByteCount: Long,
    width: Int,
    height: Int,
    orientation: Int,
    cancellation: ImageHashCancellationToken,
    readHook: ((Long) -> Unit)?,
    regionDecodedHook: (() -> Unit)?,
    maximumRegionPixels: Long,
    forceFallbackDecode: Boolean,
  ): IntArray {
    require(maximumRegionPixels in 1..maximumPixelCount)
    val swapsAxes = orientation in setOf(
      ExifInterface.ORIENTATION_TRANSPOSE,
      ExifInterface.ORIENTATION_ROTATE_90,
      ExifInterface.ORIENTATION_TRANSVERSE,
      ExifInterface.ORIENTATION_ROTATE_270,
    )
    val orientedWidth = if (swapsAxes) height else width
    val orientedHeight = if (swapsAxes) width else height
    val totals = LongArray(sampleWidth * sampleHeight)
    val counts = LongArray(sampleWidth * sampleHeight)
    val decoder = if (forceFallbackDecode) null else
      tryCreateRegionDecoder(file, expectedByteCount, cancellation, readHook)
    if (decoder == null) {
      return decodeAndSampleBoundedFallback(
        file,
        expectedByteCount,
        width,
        height,
        orientation,
        cancellation,
        readHook,
        regionDecodedHook,
      )
    }
    try {
      cancellation.throwIfCancelled()
      if (decoder.width != width || decoder.height != height) {
        throw NativeException("PROCESSOR_OUTPUT_INVALID")
      }
      val regionWidth = minOf(width.toLong(), maximumRegionPixels).toInt()
      val regionHeight = maxOf(1, (maximumRegionPixels / regionWidth).toInt())
      var top = 0
      while (top < height) {
        val bottom = minOf(height, top + regionHeight)
        var left = 0
        while (left < width) {
          cancellation.throwIfCancelled()
          val right = minOf(width, left + regionWidth)
          val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            inPreferredConfig = Bitmap.Config.ARGB_8888
          }
          val bitmap = try {
            decoder.decodeRegion(Rect(left, top, right, bottom), options)
              ?: throw NativeException("PROCESSOR_OUTPUT_INVALID")
          } catch (error: NativeException) {
            throw error
          } catch (_: OutOfMemoryError) {
            throw NativeException("RESOURCE_MEMORY_PRESSURE")
          } catch (_: Exception) {
            cancellation.throwIfCancelled()
            throw NativeException("PROCESSOR_OUTPUT_INVALID")
          }
          try {
            regionDecodedHook?.invoke()
            cancellation.throwIfCancelled()
            accumulateRegion(
              bitmap,
              left,
              top,
              width,
              height,
              orientation,
              orientedWidth,
              orientedHeight,
              totals,
              counts,
              cancellation,
            )
          } finally {
            bitmap.recycle()
          }
          left = right
        }
        top = bottom
      }
    } finally {
      decoder.recycle()
    }
    return averagedSamples(totals, counts)
  }

  private fun tryCreateRegionDecoder(
    file: File,
    expectedByteCount: Long,
    cancellation: ImageHashCancellationToken,
    readHook: ((Long) -> Unit)?,
  ): BitmapRegionDecoder? = try {
    file.inputStream().use { source ->
      CancellableBoundedInputStream(
        source,
        expectedByteCount,
        cancellation,
        readHook,
      ).use { input ->
        @Suppress("DEPRECATION")
        BitmapRegionDecoder.newInstance(input, false)
      }
    }
  } catch (error: NativeException) {
    throw error
  } catch (_: OutOfMemoryError) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  } catch (_: Exception) {
    cancellation.throwIfCancelled()
    null
  }

  private fun decodeAndSampleBoundedFallback(
    file: File,
    expectedByteCount: Long,
    width: Int,
    height: Int,
    orientation: Int,
    cancellation: ImageHashCancellationToken,
    readHook: ((Long) -> Unit)?,
    decodedHook: (() -> Unit)?,
  ): IntArray {
    val totals = LongArray(sampleWidth * sampleHeight)
    val counts = LongArray(sampleWidth * sampleHeight)
    val fallbackSampleSize = fallbackSampleSize(width, height)
    val options = BitmapFactory.Options().apply {
      inSampleSize = fallbackSampleSize
      inScaled = false
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val bitmap = try {
      file.inputStream().use { source ->
        CancellableBoundedInputStream(
          source,
          expectedByteCount,
          cancellation,
          readHook,
        ).use { input -> BitmapFactory.decodeStream(input, null, options) }
      } ?: throw NativeException("PROCESSOR_OUTPUT_INVALID")
    } catch (error: NativeException) {
      throw error
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } catch (_: Exception) {
      cancellation.throwIfCancelled()
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    try {
      decodedHook?.invoke()
      cancellation.throwIfCancelled()
      if (
        bitmap.width <= 0 || bitmap.height <= 0 ||
        bitmap.width.toLong() * bitmap.height.toLong() > maximumFallbackDecodePixels
      ) {
        throw NativeException("PROCESSOR_OUTPUT_INVALID")
      }
      val decodedSwapsAxes = orientation in setOf(
        ExifInterface.ORIENTATION_TRANSPOSE,
        ExifInterface.ORIENTATION_ROTATE_90,
        ExifInterface.ORIENTATION_TRANSVERSE,
        ExifInterface.ORIENTATION_ROTATE_270,
      )
      val decodedOrientedWidth = if (decodedSwapsAxes) bitmap.height else bitmap.width
      val decodedOrientedHeight = if (decodedSwapsAxes) bitmap.width else bitmap.height
      accumulateRegion(
        bitmap,
        0,
        0,
        bitmap.width,
        bitmap.height,
        orientation,
        decodedOrientedWidth,
        decodedOrientedHeight,
        totals,
        counts,
        cancellation,
      )
    } finally {
      bitmap.recycle()
    }
    return averagedSamples(totals, counts)
  }

  internal fun fallbackSampleSize(width: Int, height: Int): Int {
    require(width > 0 && height > 0)
    var sampleSize = 1
    while (
      ceilDiv(width, sampleSize).toLong() *
        ceilDiv(height, sampleSize).toLong() > maximumFallbackDecodePixels
    ) {
      sampleSize = sampleSize shl 1
    }
    return sampleSize
  }

  private fun ceilDiv(value: Int, divisor: Int): Int =
    ((value.toLong() + divisor - 1L) / divisor).toInt()

  private fun accumulateRegion(
    bitmap: Bitmap,
    left: Int,
    top: Int,
    sourceWidth: Int,
    sourceHeight: Int,
    orientation: Int,
    orientedWidth: Int,
    orientedHeight: Int,
    totals: LongArray,
    counts: LongArray,
    cancellation: ImageHashCancellationToken,
  ) {
    val rowPixels = IntArray(bitmap.width)
    for (localY in 0 until bitmap.height) {
      cancellation.throwIfCancelled()
      bitmap.getPixels(rowPixels, 0, bitmap.width, 0, localY, bitmap.width, 1)
      for (localX in 0 until bitmap.width) {
        val (orientedX, orientedY) = orientedCoordinate(
          left + localX,
          top + localY,
          sourceWidth,
          sourceHeight,
          orientation,
        )
        accumulateSample(
          totals,
          counts,
          orientedX,
          orientedY,
          orientedWidth,
          orientedHeight,
          luminanceOverWhite(rowPixels[localX]),
        )
      }
    }
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

  private fun readOrientation(
    file: File,
    expectedByteCount: Long,
    cancellation: ImageHashCancellationToken,
  ): Int {
    cancellation.throwIfCancelled()
    return try {
      file.inputStream().use { source ->
        CancellableBoundedInputStream(source, expectedByteCount, cancellation).use { input ->
          ExifInterface(input).getAttributeInt(
            ExifInterface.TAG_ORIENTATION,
            ExifInterface.ORIENTATION_NORMAL,
          )
        }
      }.also { cancellation.throwIfCancelled() }
    } catch (error: NativeException) {
      throw error
    } catch (_: Exception) {
      cancellation.throwIfCancelled()
      ExifInterface.ORIENTATION_NORMAL
    }
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
    when (
      java.io.File(path).inputStream().buffered().use { input ->
        inspectWebPFrames(input, sourceLength, cancellation)
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
        inspectBmffFrames(input, sourceLength, cancellation)
      }
    ) {
      ContainerFrameInspection.ANIMATED,
      ContainerFrameInspection.INVALID,
      -> return true
      ContainerFrameInspection.SINGLE -> return false
      ContainerFrameInspection.NOT_RECOGNIZED -> Unit
    }
    cancellation.throwIfCancelled()
    return false
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

  internal fun inspectWebPFrames(bytes: ByteArray): ContainerFrameInspection =
    ByteArrayInputStream(bytes).use { input ->
      inspectWebPFrames(input, bytes.size.toLong(), ImageHashCancellationToken())
    }

  internal fun inspectWebPFrames(
    bytes: ByteArray,
    cancellation: ImageHashCancellationToken,
  ): ContainerFrameInspection = ByteArrayInputStream(bytes).use { input ->
    inspectWebPFrames(input, bytes.size.toLong(), cancellation)
  }

  internal fun inspectBmffFrames(bytes: ByteArray): ContainerFrameInspection =
    ByteArrayInputStream(bytes).use { input ->
      inspectBmffFrames(input, bytes.size.toLong(), ImageHashCancellationToken())
    }

  internal fun inspectBmffFrames(
    input: InputStream,
    maximumBytes: Long,
    cancellation: ImageHashCancellationToken,
  ): ContainerFrameInspection {
    val reader = BoundedContainerReader(input, maximumBytes, cancellation)
    if (maximumBytes < 16L) return ContainerFrameInspection.NOT_RECOGNIZED
    var fileType = readBmffBox(reader, maximumBytes)
      ?: return ContainerFrameInspection.NOT_RECOGNIZED
    if (!fileType.isValid) {
      return if (fileType.type == "ftyp" || fileType.type in bmffPreludeBoxTypes) {
        ContainerFrameInspection.INVALID
      } else {
        ContainerFrameInspection.NOT_RECOGNIZED
      }
    }
    var preludeCount = 0
    while (fileType.type != "ftyp") {
      if (fileType.type !in bmffPreludeBoxTypes || preludeCount >= 16) {
        return ContainerFrameInspection.NOT_RECOGNIZED
      }
      if (!reader.skipExactly(fileType.endOffset - reader.consumedBytes)) {
        return ContainerFrameInspection.INVALID
      }
      if (maximumBytes - reader.consumedBytes < 8L) return ContainerFrameInspection.INVALID
      fileType = readBmffBox(reader, maximumBytes) ?: return ContainerFrameInspection.INVALID
      if (!fileType.isValid) return ContainerFrameInspection.INVALID
      preludeCount += 1
    }
    if ((fileType.endOffset - reader.consumedBytes) < 8L) {
      return ContainerFrameInspection.INVALID
    }
    var brandFlags = bmffBrandFlags(
      reader.readUnsignedInt() ?: return ContainerFrameInspection.INVALID,
    )
    if (!reader.skipExactly(4L)) return ContainerFrameInspection.INVALID
    val compatibleBrandFlags = reader.scanBmffBrandFlags(fileType.endOffset)
    if (compatibleBrandFlags < 0) {
      return ContainerFrameInspection.INVALID
    }
    brandFlags = brandFlags or compatibleBrandFlags
    if (brandFlags and BMFF_IMAGE_BRAND_FLAG == 0) {
      return ContainerFrameInspection.NOT_RECOGNIZED
    }
    if (brandFlags and BMFF_SEQUENCE_BRAND_FLAG != 0) {
      return ContainerFrameInspection.ANIMATED
    }

    var metadata: BmffMetadata? = null
    while (reader.consumedBytes < maximumBytes) {
      if (maximumBytes - reader.consumedBytes < 8L) return ContainerFrameInspection.INVALID
      val box = readBmffBox(reader, maximumBytes) ?: return ContainerFrameInspection.INVALID
      if (!box.isValid) return ContainerFrameInspection.INVALID
      if (box.type == "meta") {
        if (metadata != null) return ContainerFrameInspection.INVALID
        metadata = parseBmffMetadata(reader, box.endOffset)
          ?: return ContainerFrameInspection.INVALID
      } else if (!reader.skipExactly(box.endOffset - reader.consumedBytes)) {
        return ContainerFrameInspection.INVALID
      }
    }
    if (!reader.isAtExactEof()) return ContainerFrameInspection.INVALID
    val parsed = metadata ?: return ContainerFrameInspection.INVALID
    val primary = parsed.primaryItem ?: return ContainerFrameInspection.INVALID
    if (!parsed.sawItemInfo || primary !in parsed.imageItems) {
      return ContainerFrameInspection.INVALID
    }
    if (!parsed.requiredImageReferenceItems.all { it in parsed.imageItems }) {
      return ContainerFrameInspection.INVALID
    }
    val displayedRoots = parsed.imageItems - parsed.dependentItems
    return when {
      displayedRoots.size > 1 -> ContainerFrameInspection.ANIMATED
      displayedRoots.size == 1 && primary in displayedRoots -> ContainerFrameInspection.SINGLE
      else -> ContainerFrameInspection.INVALID
    }
  }

  private data class BmffBox(
    val type: String,
    val endOffset: Long,
    val isValid: Boolean = true,
  )

  private data class BmffMetadata(
    var primaryItem: Long? = null,
    var sawItemInfo: Boolean = false,
    val allItems: MutableSet<Long> = mutableSetOf(),
    val imageItems: MutableSet<Long> = mutableSetOf(),
    val dependentItems: MutableSet<Long> = mutableSetOf(),
    val requiredImageReferenceItems: MutableSet<Long> = mutableSetOf(),
  )

  private fun readBmffBox(reader: BoundedContainerReader, parentEnd: Long): BmffBox? {
    val start = reader.consumedBytes
    if (parentEnd - start < 8L) return null
    val size32 = reader.readUnsignedInt() ?: return null
    val type = String(reader.readBytes(4) ?: return null, Charsets.US_ASCII)
    val headerBytes: Long
    val boxBytes = when (size32) {
      0L -> {
        headerBytes = 8L
        parentEnd - start
      }
      1L -> {
        headerBytes = 16L
        reader.readBoundedUnsignedLong() ?: return BmffBox(type, start, false)
      }
      else -> {
        headerBytes = 8L
        size32
      }
    }
    if (boxBytes < headerBytes || boxBytes > parentEnd - start) {
      return BmffBox(type, start, false)
    }
    return BmffBox(type, start + boxBytes)
  }

  private fun parseBmffMetadata(
    reader: BoundedContainerReader,
    metadataEnd: Long,
  ): BmffMetadata? {
    val fullBox = reader.readBytes(4) ?: return null
    if (fullBox[0].toInt() != 0) return null
    val metadata = BmffMetadata()
    var sawPrimary = false
    var sawReferences = false
    while (reader.consumedBytes < metadataEnd) {
      val box = readBmffBox(reader, metadataEnd) ?: return null
      if (!box.isValid) return null
      when (box.type) {
        "pitm" -> {
          if (sawPrimary || !parseBmffPrimaryItem(reader, box.endOffset, metadata)) return null
          sawPrimary = true
        }
        "iinf" -> {
          if (metadata.sawItemInfo || !parseBmffItemInfo(reader, box.endOffset, metadata)) {
            return null
          }
          metadata.sawItemInfo = true
        }
        "iref" -> {
          if (sawReferences || !parseBmffReferences(reader, box.endOffset, metadata)) return null
          sawReferences = true
        }
        else -> if (!reader.skipExactly(box.endOffset - reader.consumedBytes)) return null
      }
      if (reader.consumedBytes != box.endOffset) return null
    }
    return if (reader.consumedBytes == metadataEnd) metadata else null
  }

  private fun parseBmffPrimaryItem(
    reader: BoundedContainerReader,
    boxEnd: Long,
    metadata: BmffMetadata,
  ): Boolean {
    val fullBox = reader.readBytes(4) ?: return false
    metadata.primaryItem = when (fullBox[0].toInt() and 0xff) {
      0 -> reader.readUnsignedShort()?.toLong()
      1 -> reader.readUnsignedInt()
      else -> return false
    } ?: return false
    return reader.skipExactly(boxEnd - reader.consumedBytes)
  }

  private fun parseBmffItemInfo(
    reader: BoundedContainerReader,
    boxEnd: Long,
    metadata: BmffMetadata,
  ): Boolean {
    val fullBox = reader.readBytes(4) ?: return false
    val version = fullBox[0].toInt() and 0xff
    val entryCount = when (version) {
      0 -> reader.readUnsignedShort()?.toLong()
      1 -> reader.readUnsignedInt()
      else -> return false
    } ?: return false
    if (entryCount > maximumBmffItems || entryCount > (boxEnd - reader.consumedBytes) / 8L) {
      return false
    }
    repeat(entryCount.toInt()) {
      val entry = readBmffBox(reader, boxEnd) ?: return false
      if (!entry.isValid) return false
      if (entry.type != "infe" || !parseBmffItemInfoEntry(reader, entry.endOffset, metadata)) {
        return false
      }
    }
    return reader.skipExactly(boxEnd - reader.consumedBytes)
  }

  private fun parseBmffItemInfoEntry(
    reader: BoundedContainerReader,
    boxEnd: Long,
    metadata: BmffMetadata,
  ): Boolean {
    val fullBox = reader.readBytes(4) ?: return false
    val version = fullBox[0].toInt() and 0xff
    val itemId = when (version) {
      2 -> reader.readUnsignedShort()?.toLong()
      3 -> reader.readUnsignedInt()
      else -> return false
    } ?: return false
    if (reader.readUnsignedShort() == null) return false
    val itemType = reader.readBytes(4)?.let { String(it, Charsets.US_ASCII) } ?: return false
    if (!metadata.allItems.add(itemId)) return false
    if (itemType in bmffImageItemTypes) {
      metadata.imageItems += itemId
      if (metadata.imageItems.size > maximumBmffItems) return false
    }
    return reader.skipExactly(boxEnd - reader.consumedBytes)
  }

  private fun parseBmffReferences(
    reader: BoundedContainerReader,
    boxEnd: Long,
    metadata: BmffMetadata,
  ): Boolean {
    val fullBox = reader.readBytes(4) ?: return false
    val version = fullBox[0].toInt() and 0xff
    if (version !in 0..1) return false
    var referenceCount = 0
    while (reader.consumedBytes < boxEnd) {
      val reference = readBmffBox(reader, boxEnd) ?: return false
      if (!reference.isValid) return false
      val fromItem = if (version == 0) {
        reader.readUnsignedShort()?.toLong()
      } else {
        reader.readUnsignedInt()
      } ?: return false
      val targetCount = reader.readUnsignedShort() ?: return false
      if (
        targetCount == 0 ||
        targetCount > maximumBmffItems ||
        referenceCount + targetCount > maximumBmffItems
      ) {
        return false
      }
      val targets = mutableListOf<Long>()
      repeat(targetCount) {
        val target = if (version == 0) {
          reader.readUnsignedShort()?.toLong()
        } else {
          reader.readUnsignedInt()
        } ?: return false
        targets += target
      }
      when (reference.type) {
        "thmb", "auxl" -> {
          metadata.dependentItems += fromItem
          metadata.requiredImageReferenceItems += fromItem
          metadata.requiredImageReferenceItems += targets
        }
        "dimg" -> {
          metadata.dependentItems += targets
          metadata.requiredImageReferenceItems += fromItem
          metadata.requiredImageReferenceItems += targets
        }
      }
      referenceCount += targetCount
      if (!reader.skipExactly(reference.endOffset - reader.consumedBytes)) return false
    }
    return reader.consumedBytes == boxEnd
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

  internal fun inspectWebPFrames(
    input: InputStream,
    maximumBytes: Long,
    cancellation: ImageHashCancellationToken,
  ): ContainerFrameInspection {
    val reader = BoundedContainerReader(input, maximumBytes, cancellation)
    val riff = reader.readBytes(4) ?: return ContainerFrameInspection.NOT_RECOGNIZED
    if (String(riff, Charsets.US_ASCII) != "RIFF") {
      return ContainerFrameInspection.NOT_RECOGNIZED
    }
    val declaredSize = reader.readUnsignedLittleEndianInt()
      ?: return ContainerFrameInspection.INVALID
    val webp = reader.readBytes(4) ?: return ContainerFrameInspection.INVALID
    if (
      String(webp, Charsets.US_ASCII) != "WEBP" ||
      declaredSize < 4L ||
      declaredSize + 8L != maximumBytes
    ) {
      return ContainerFrameInspection.INVALID
    }
    var imagePayloadCount = 0
    var sawExtendedHeader = false
    var sawAnimationSignal = false
    while (reader.remainingBytes > 0L) {
      if (reader.remainingBytes < 8L) return ContainerFrameInspection.INVALID
      val type = reader.readBytes(4) ?: return ContainerFrameInspection.INVALID
      val typeName = String(type, Charsets.US_ASCII)
      val length = reader.readUnsignedLittleEndianInt()
        ?: return ContainerFrameInspection.INVALID
      val padding = length and 1L
      if (length > reader.remainingBytes - padding) {
        return ContainerFrameInspection.INVALID
      }
      val capture = if (typeName == "VP8X") ByteArray(1) else null
      if (!reader.readPrefixAndSkip(length, capture)) {
        return ContainerFrameInspection.INVALID
      }
      if (padding == 1L && reader.readByte() == null) {
        return ContainerFrameInspection.INVALID
      }
      when (typeName) {
        "VP8 ", "VP8L" -> {
          imagePayloadCount += 1
          if (imagePayloadCount > 1) return ContainerFrameInspection.INVALID
        }
        "VP8X" -> {
          if (length != 10L || sawExtendedHeader || imagePayloadCount > 0) {
            return ContainerFrameInspection.INVALID
          }
          sawExtendedHeader = true
          sawAnimationSignal = (capture!![0].toInt() and 0x02) != 0
        }
        "ANIM", "ANMF" -> sawAnimationSignal = true
      }
    }
    if (!reader.isAtExactEof()) return ContainerFrameInspection.INVALID
    return when {
      sawAnimationSignal -> ContainerFrameInspection.ANIMATED
      imagePayloadCount == 1 -> ContainerFrameInspection.SINGLE
      else -> ContainerFrameInspection.INVALID
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

private const val BMFF_IMAGE_BRAND_FLAG = 1
private const val BMFF_SEQUENCE_BRAND_FLAG = 2

private fun bmffBrandFlags(value: Long): Int = when (value) {
  0x6d696631L, // mif1
  0x68656963L, // heic
  0x68656978L, // heix
  0x6865696dL, // heim
  0x68656973L, // heis
  0x61766966L, // avif
  0x6176696fL, // avio
  0x4d413141L, // MA1A
  0x4d413142L, // MA1B
  -> BMFF_IMAGE_BRAND_FLAG
  0x6d736631L, // msf1
  0x68657663L, // hevc
  0x68657678L, // hevx
  0x6865766dL, // hevm
  0x68657673L, // hevs
  0x61766973L, // avis
  -> BMFF_IMAGE_BRAND_FLAG or BMFF_SEQUENCE_BRAND_FLAG
  else -> 0
}

internal class CancellableBoundedInputStream(
  source: InputStream,
  maximumBytes: Long,
  private val cancellation: ImageHashCancellationToken,
  private val readHook: ((Long) -> Unit)? = null,
) : FilterInputStream(source) {
  private val maximumReadBytes = 64 * 1_024
  private val skipBuffer = ByteArray(16 * 1_024)
  private var remaining = maximumBytes

  init {
    require(maximumBytes >= 0)
  }

  override fun read(): Int {
    cancellation.throwIfCancelled()
    if (remaining == 0L) return -1
    val value = super.read()
    if (value >= 0) {
      remaining -= 1
      readHook?.invoke(1)
    }
    return value
  }

  override fun read(target: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    cancellation.throwIfCancelled()
    if (remaining == 0L) return -1
    val boundedLength = minOf(length.toLong(), remaining, maximumReadBytes.toLong()).toInt()
    val count = super.read(target, offset, boundedLength)
    if (count > 0) {
      remaining -= count
      readHook?.invoke(count.toLong())
    }
    return count
  }

  override fun skip(byteCount: Long): Long {
    if (byteCount <= 0L) return 0L
    var skipped = 0L
    val target = minOf(byteCount, remaining)
    while (skipped < target) {
      cancellation.throwIfCancelled()
      val requested = minOf(skipBuffer.size.toLong(), target - skipped).toInt()
      val count = read(skipBuffer, 0, requested)
      if (count <= 0) break
      skipped += count
    }
    return skipped
  }

  override fun available(): Int =
    minOf(super.available().toLong(), remaining, Int.MAX_VALUE.toLong()).toInt()
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

  fun scanBmffBrandFlags(endOffset: Long): Int {
    val byteCount = endOffset - consumedBytes
    if (byteCount < 0L || byteCount > remainingBytes || byteCount % 4L != 0L) return -1
    var flags = 0
    var remaining = byteCount
    while (remaining > 0L) {
      cancellation.throwIfCancelled()
      val chunkSize = minOf(remaining, transferBuffer.size.toLong()).toInt()
      var chunkOffset = 0
      while (chunkOffset < chunkSize) {
        cancellation.throwIfCancelled()
        val count = input.read(transferBuffer, chunkOffset, chunkSize - chunkOffset)
        if (count <= 0) return -1
        chunkOffset += count
        consumedBytes += count
      }
      for (offset in 0 until chunkSize step 4) {
        val code =
          ((transferBuffer[offset].toLong() and 0xffL) shl 24) or
            ((transferBuffer[offset + 1].toLong() and 0xffL) shl 16) or
            ((transferBuffer[offset + 2].toLong() and 0xffL) shl 8) or
            (transferBuffer[offset + 3].toLong() and 0xffL)
        flags = flags or bmffBrandFlags(code)
      }
      remaining -= chunkSize
    }
    return flags
  }

  fun readUnsignedShort(): Int? {
    val bytes = readBytes(2) ?: return null
    return ((bytes[0].toInt() and 0xff) shl 8) or
      (bytes[1].toInt() and 0xff)
  }

  fun readBoundedUnsignedLong(): Long? {
    val bytes = readBytes(8) ?: return null
    if ((bytes[0].toInt() and 0x80) != 0) return null
    var value = 0L
    for (byte in bytes) value = (value shl 8) or (byte.toLong() and 0xffL)
    return value
  }

  fun readUnsignedLittleEndianInt(): Long? {
    val bytes = readBytes(4) ?: return null
    return (bytes[0].toLong() and 0xffL) or
      ((bytes[1].toLong() and 0xffL) shl 8) or
      ((bytes[2].toLong() and 0xffL) shl 16) or
      ((bytes[3].toLong() and 0xffL) shl 24)
  }

  fun readPrefixAndSkip(byteCount: Long, capture: ByteArray?): Boolean {
    if (
      byteCount < 0L ||
      byteCount > remainingBytes ||
      (capture != null && capture.size.toLong() > byteCount)
    ) {
      return false
    }
    if (capture != null) {
      val prefix = readBytes(capture.size) ?: return false
      prefix.copyInto(capture)
    }
    return skipExactly(byteCount - (capture?.size ?: 0))
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
