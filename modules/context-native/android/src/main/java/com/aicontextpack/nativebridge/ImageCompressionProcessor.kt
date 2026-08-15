package com.aicontextpack.nativebridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

internal object ImageCompressionProcessor {
  const val revision = "1"
  const val maximumOutputPixels = 4_194_304L
  const val maximumOutputBytes = 52_428_800L

  fun inspect(
    context: Context,
    fileUri: String,
    expectedByteCount: Long,
    expectedSha256: String,
    cancellation: ImageHashCancellationToken,
  ): Map<String, Any> {
    cancellation.throwIfCancelled()
    val source = controlledSandboxFile(context, fileUri)
    return ImmutableImageSnapshot.create(
      context,
      source,
      expectedByteCount,
      expectedSha256,
      cancellation,
    ).useDeleting { snapshot ->
      val metadata = inspectSnapshot(snapshot, expectedByteCount, cancellation)
      mapOf(
        "schemaVersion" to 1,
        "sourceByteCount" to expectedByteCount.toDouble(),
        "sourceSha256" to expectedSha256,
        "sourceMediaType" to metadata.mediaType,
        "width" to metadata.orientedWidth,
        "height" to metadata.orientedHeight,
        "hasAlpha" to metadata.hasAlpha,
        "animated" to false,
        "orientationApplied" to true,
        "revision" to revision,
      )
    }
  }

  fun compress(
    context: Context,
    taskId: String,
    fileUri: String,
    expectedByteCount: Long,
    expectedSha256: String,
    targetWidth: Int,
    targetHeight: Int,
    quality: Double,
    outputMediaType: String,
    preserveAlpha: Boolean,
    cancellation: ImageHashCancellationToken,
    beforePublish: (() -> Unit)? = null,
  ): Map<String, Any> {
    val started = SystemClock.elapsedRealtimeNanos()
    val targetPixels = targetWidth.toLong() * targetHeight.toLong()
    if (
      !isCanonicalTaskId(taskId) ||
      targetWidth <= 0 || targetHeight <= 0 ||
      targetPixels !in 1..maximumOutputPixels ||
      !quality.isFinite() || quality !in 0.58..1.0 ||
      outputMediaType !in setOf("image/jpeg", "image/png") ||
      (outputMediaType == "image/png") != preserveAlpha ||
      (preserveAlpha && quality != 1.0)
    ) throw NativeException("PROCESSOR_OUTPUT_INVALID")
    val source = controlledSandboxFile(context, fileUri)
    val output = ImmutableImageSnapshot.create(
      context,
      source,
      expectedByteCount,
      expectedSha256,
      cancellation,
    ).useDeleting { snapshot ->
      val metadata = inspectSnapshot(snapshot, expectedByteCount, cancellation)
      if (
        targetWidth > metadata.orientedWidth || targetHeight > metadata.orientedHeight ||
        preserveAlpha != metadata.hasAlpha
      ) throw NativeException("PROCESSOR_OUTPUT_INVALID")
      val bitmap = decodeBounded(
        snapshot,
        expectedByteCount,
        metadata,
        targetWidth,
        targetHeight,
        cancellation,
      )
      val target = try {
        Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
      } catch (_: OutOfMemoryError) {
        bitmap.recycle()
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      }
      try {
        val canvas = Canvas(target)
        if (!preserveAlpha) canvas.drawColor(Color.WHITE)
        val matrix = sourceToTargetMatrix(
          bitmap.width,
          bitmap.height,
          targetWidth,
          targetHeight,
          metadata.orientation,
        )
        canvas.drawBitmap(bitmap, matrix, null)
        cancellation.throwIfCancelled()
        writeTemporary(
          context,
          taskId,
          target,
          outputMediaType,
          quality,
          cancellation,
          beforePublish,
        )
      } finally {
        bitmap.recycle()
        target.recycle()
      }
    }
    return try {
      cancellation.throwIfCancelled()
      val digest = digest(output, cancellation)
      mapOf(
        "schemaVersion" to 1,
        "taskId" to taskId,
        "sourceSha256" to expectedSha256,
        "temporaryFileUri" to Uri.fromFile(output).toString(),
        "outputByteCount" to digest.byteCount.toDouble(),
        "outputSha256" to digest.sha256,
        "width" to targetWidth,
        "height" to targetHeight,
        "mediaType" to outputMediaType,
        "quality" to quality,
        "alphaPreserved" to preserveAlpha,
        "engine" to "android-bitmap",
        "revision" to revision,
        "durationMs" to (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0,
      )
    } catch (error: Throwable) {
      if (!ImageCompressionTemporaryStore.finish(taskId)) {
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      }
      throw error
    }
  }

  private data class Metadata(
    val width: Int,
    val height: Int,
    val orientedWidth: Int,
    val orientedHeight: Int,
    val orientation: Int,
    val mediaType: String,
    val hasAlpha: Boolean,
  )

  private fun inspectSnapshot(
    file: File,
    expectedByteCount: Long,
    cancellation: ImageHashCancellationToken,
  ): Metadata {
    cancellation.throwIfCancelled()
    if (ImagePerceptualHasher.violatesSingleFramePolicy(file.path, cancellation)) {
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    cancellation.attachDecode(bounds)
    try {
      file.inputStream().use { source ->
        CancellableBoundedInputStream(source, expectedByteCount, cancellation).use { input ->
          BitmapFactory.decodeStream(input, null, bounds)
        }
      }
    } finally {
      cancellation.detachDecode(bounds)
    }
    cancellation.throwIfCancelled()
    val pixelCount = bounds.outWidth.toLong() * bounds.outHeight.toLong()
    if (
      bounds.outWidth <= 0 || bounds.outHeight <= 0 ||
      pixelCount !in 1..ImagePerceptualHasher.maximumPixelCount
    ) throw NativeException("RESOURCE_MEMORY_PRESSURE")
    val mediaType = when (bounds.outMimeType) {
      "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif" ->
        bounds.outMimeType
      "image/bmp", "image/x-ms-bmp" -> "image/bmp"
      else -> throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    val orientation = ImagePerceptualHasher.readOrientation(
      file,
      expectedByteCount,
      cancellation,
    )
    val swapsAxes = orientation in setOf(
      ExifInterface.ORIENTATION_TRANSPOSE,
      ExifInterface.ORIENTATION_ROTATE_90,
      ExifInterface.ORIENTATION_TRANSVERSE,
      ExifInterface.ORIENTATION_ROTATE_270,
    )
    val sample = boundedSampleSize(bounds.outWidth, bounds.outHeight, 1, 1)
    val alphaProbe = decodeBitmap(file, expectedByteCount, sample, cancellation)
    val hasAlpha = try { alphaProbe.hasAlpha() } finally { alphaProbe.recycle() }
    return Metadata(
      width = bounds.outWidth,
      height = bounds.outHeight,
      orientedWidth = if (swapsAxes) bounds.outHeight else bounds.outWidth,
      orientedHeight = if (swapsAxes) bounds.outWidth else bounds.outHeight,
      orientation = orientation,
      mediaType = mediaType,
      hasAlpha = hasAlpha,
    )
  }

  private fun decodeBounded(
    file: File,
    expectedByteCount: Long,
    metadata: Metadata,
    targetWidth: Int,
    targetHeight: Int,
    cancellation: ImageHashCancellationToken,
  ): Bitmap {
    val swapsAxes = metadata.orientedWidth != metadata.width
    val rawTargetWidth = if (swapsAxes) targetHeight else targetWidth
    val rawTargetHeight = if (swapsAxes) targetWidth else targetHeight
    val sample = boundedSampleSize(
      metadata.width,
      metadata.height,
      rawTargetWidth,
      rawTargetHeight,
    )
    return decodeBitmap(file, expectedByteCount, sample, cancellation)
  }

  private fun boundedSampleSize(
    width: Int,
    height: Int,
    minimumWidth: Int,
    minimumHeight: Int,
  ): Int {
    var sample = 1
    while (
      width / (sample * 2) >= minimumWidth &&
      height / (sample * 2) >= minimumHeight &&
      ceilDivide(width, sample * 2).toLong() * ceilDivide(height, sample * 2) >= 1
    ) sample *= 2
    while (
      ceilDivide(width, sample).toLong() * ceilDivide(height, sample) > maximumOutputPixels
    ) sample *= 2
    if (ceilDivide(width, sample) < minimumWidth || ceilDivide(height, sample) < minimumHeight) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    return sample
  }

  private fun decodeBitmap(
    file: File,
    expectedByteCount: Long,
    sample: Int,
    cancellation: ImageHashCancellationToken,
  ): Bitmap {
    val options = BitmapFactory.Options().apply {
      inSampleSize = sample
      inScaled = false
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    cancellation.attachDecode(options)
    val bitmap = try {
      file.inputStream().use { source ->
        CancellableBoundedInputStream(source, expectedByteCount, cancellation).use { input ->
          BitmapFactory.decodeStream(input, null, options)
        }
      } ?: throw NativeException("PROCESSOR_OUTPUT_INVALID")
    } catch (error: NativeException) {
      throw error
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } catch (_: Throwable) {
      cancellation.throwIfCancelled()
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    } finally {
      cancellation.detachDecode(options)
    }
    cancellation.throwIfCancelled()
    return bitmap
  }

  private fun sourceToTargetMatrix(
    width: Int,
    height: Int,
    targetWidth: Int,
    targetHeight: Int,
    orientation: Int,
  ): Matrix {
    val source = floatArrayOf(0f, 0f, width.toFloat(), 0f, 0f, height.toFloat())
    val w = targetWidth.toFloat()
    val h = targetHeight.toFloat()
    val destination = when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> floatArrayOf(w, 0f, 0f, 0f, w, h)
      ExifInterface.ORIENTATION_ROTATE_180 -> floatArrayOf(w, h, 0f, h, w, 0f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> floatArrayOf(0f, h, w, h, 0f, 0f)
      ExifInterface.ORIENTATION_TRANSPOSE -> floatArrayOf(0f, 0f, 0f, h, w, 0f)
      ExifInterface.ORIENTATION_ROTATE_90 -> floatArrayOf(w, 0f, w, h, 0f, 0f)
      ExifInterface.ORIENTATION_TRANSVERSE -> floatArrayOf(w, h, w, 0f, 0f, h)
      ExifInterface.ORIENTATION_ROTATE_270 -> floatArrayOf(0f, h, 0f, 0f, w, h)
      else -> floatArrayOf(0f, 0f, w, 0f, 0f, h)
    }
    return Matrix().also {
      if (!it.setPolyToPoly(source, 0, destination, 0, 3)) {
        throw NativeException("PROCESSOR_OUTPUT_INVALID")
      }
    }
  }

  private fun writeTemporary(
    context: Context,
    taskId: String,
    bitmap: Bitmap,
    mediaType: String,
    quality: Double,
    cancellation: ImageHashCancellationToken,
    beforePublish: (() -> Unit)?,
  ): File {
    val files = ImageCompressionTemporaryStore.prepare(context, taskId)
    try {
      FileOutputStream(files.partial).use { stream ->
        val format = if (mediaType == "image/png") {
          Bitmap.CompressFormat.PNG
        } else {
          Bitmap.CompressFormat.JPEG
        }
        if (!bitmap.compress(format, (quality * 100).toInt(), stream)) {
          throw NativeException("PROCESSOR_OUTPUT_INVALID")
        }
        stream.fd.sync()
      }
      beforePublish?.invoke()
      cancellation.throwIfCancelled()
      if (!files.partial.renameTo(files.complete)) {
        throw NativeException("RESOURCE_MEMORY_PRESSURE")
      }
      ImageCompressionTemporaryStore.register(taskId, files.complete)
      return files.complete
    } catch (error: Throwable) {
      runCatching {
        ImageCompressionTemporaryStore.removeUnregistered(
          listOf(files.partial, files.complete),
        )
      }.getOrElse { throw it }
      throw error
    }
  }

  private data class Digest(val byteCount: Long, val sha256: String)

  private fun digest(file: File, cancellation: ImageHashCancellationToken): Digest {
    val hash = MessageDigest.getInstance("SHA-256")
    var count = 0L
    val buffer = ByteArray(64 * 1_024)
    file.inputStream().use { input ->
      while (true) {
        cancellation.throwIfCancelled()
        val read = input.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        count += read
        if (count > maximumOutputBytes) throw NativeException("RESOURCE_MEMORY_PRESSURE")
        hash.update(buffer, 0, read)
      }
    }
    if (count <= 0) throw NativeException("PROCESSOR_OUTPUT_INVALID")
    return Digest(count, hash.digest().joinToString("") { "%02x".format(it) })
  }

  private fun ceilDivide(value: Int, divisor: Int): Int =
    (value.toLong() + divisor - 1L).div(divisor).toInt()

  private fun isCanonicalTaskId(value: String): Boolean =
    value == value.lowercase() && runCatching { UUID.fromString(value).toString() == value }
      .getOrDefault(false)
}

internal object ImageCompressionStartupRecoveryReporter {
  const val eventId = "00000000-0000-4000-8000-000000000014"

  fun reconcile(filesDir: File, failureCode: String?) {
    if (failureCode != null) {
      if (failureCode != "PIPELINE_RECOVERY_REQUIRED")
        throw NativeException("PIPELINE_RECOVERY_REQUIRED")
      MetadataEventStore.persistRecovery(filesDir, failureCode, eventId)
      return
    }
    MetadataEventStore.ack(filesDir, "RecoveryEvents", eventId)
  }
}

internal object ImageCompressionTemporaryStore {
  private const val directoryName = "ImageCompression"
  private val sessionPrefix = "${UUID.randomUUID()}-"
  private val outputs = mutableMapOf<String, File>()
  @Volatile private var startupFailureCode: String? = null

  data class Paths(val partial: File, val complete: File)

  @Synchronized
  fun startupMaintenance(
    context: Context,
    remover: (File) -> Boolean = { it.delete() },
  ) {
    repeat(2) { attempt ->
      try {
        val root = directory(context)
        val candidates = root.listFiles()
          ?: throw NativeException("PIPELINE_RECOVERY_REQUIRED")
        candidates.forEach { candidate ->
          if (candidate.name.startsWith(sessionPrefix)) return@forEach
          val stat = Os.lstat(candidate.path)
          if (
            OsConstants.S_ISREG(stat.st_mode) &&
            !remover(candidate) &&
            existsNoFollow(candidate)
          ) throw NativeException("PIPELINE_RECOVERY_REQUIRED")
        }
        startupFailureCode = null
        return
      } catch (_: Exception) {
        if (attempt == 1) {
          startupFailureCode = "PIPELINE_RECOVERY_REQUIRED"
          throw NativeException("PIPELINE_RECOVERY_REQUIRED")
        }
      }
    }
  }

  fun runStartupMaintenance(
    context: Context,
    remover: (File) -> Boolean = { it.delete() },
  ): String? =
    try {
      startupMaintenance(context, remover)
      null
    } catch (_: NativeException) {
      "PIPELINE_RECOVERY_REQUIRED"
    }

  fun currentStartupFailureCode(): String? = startupFailureCode

  fun prepare(context: Context, taskId: String): Paths {
    if (runCatching { UUID.fromString(taskId).toString() == taskId }.getOrDefault(false).not()) {
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    // Fence inherited-output cleanup before accepting current-process work so
    // cleanup failure is stable and visible through the compression request.
    startupMaintenance(context)
    val root = directory(context)
    val partial = File(root, "$sessionPrefix$taskId.tmp.partial")
    val complete = File(root, "$sessionPrefix$taskId.tmp")
    removeIfPresent(partial)
    if (existsNoFollow(complete)) throw NativeException("RESOURCE_MEMORY_PRESSURE")
    return Paths(partial, complete)
  }

  @Synchronized
  fun register(taskId: String, output: File) {
    outputs[taskId] = output
  }

  fun removeUnregistered(files: List<File>) {
    files.forEach(::removeIfPresent)
  }

  @Synchronized
  fun finish(taskId: String): Boolean {
    val output = outputs[taskId] ?: return true
    val removed = runCatching { removeIfPresent(output) }.isSuccess
    if (removed && outputs[taskId] == output) outputs.remove(taskId)
    return removed
  }

  private fun directory(context: Context): File {
    val root = File(context.cacheDir, directoryName)
    if (!existsNoFollow(root) && !root.mkdirs()) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    val metadata = runCatching { Os.lstat(root.path) }
      .getOrElse { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    if (!OsConstants.S_ISDIR(metadata.st_mode)) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    runCatching { Os.chmod(root.path, OsConstants.S_IRWXU) }
      .getOrElse { throw NativeException("RESOURCE_MEMORY_PRESSURE") }
    return root
  }

  private fun existsNoFollow(file: File): Boolean = try {
    Os.lstat(file.path)
    true
  } catch (error: ErrnoException) {
    if (error.errno == OsConstants.ENOENT) false
    else throw NativeException("RESOURCE_MEMORY_PRESSURE")
  } catch (_: Exception) {
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  }

  private fun removeIfPresent(file: File) {
    if (runCatching { file.delete() }.getOrDefault(false)) return
    if (!existsNoFollow(file)) return
    throw NativeException("RESOURCE_MEMORY_PRESSURE")
  }
}
