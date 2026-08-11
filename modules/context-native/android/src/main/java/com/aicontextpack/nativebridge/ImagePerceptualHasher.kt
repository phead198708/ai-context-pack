package com.aicontextpack.nativebridge

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.SystemClock
import java.io.File

internal object ImagePerceptualHasher {
  const val sampleWidth = 9
  const val sampleHeight = 8
  const val maximumSourceBytes = 52_428_800L
  // v1 decodes the bounded original once so both platforms sample identical
  // source coordinates. This limit caps the RGBA working set at about 64 MiB.
  const val maximumPixelCount = 16_000_000L

  fun hash(context: Context, fileUri: String): Map<String, Any> {
    val started = SystemClock.elapsedRealtimeNanos()
    val file = controlledSandboxFile(context, fileUri)
    if (!file.isFile || file.length() !in 1..maximumSourceBytes) {
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
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
    val decoded = try {
      BitmapFactory.decodeFile(file.path, decodeOptions)
        ?: throw NativeException("PROCESSOR_OUTPUT_INVALID")
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    val oriented = try {
      applyOrientation(decoded, file)
    } catch (error: OutOfMemoryError) {
      decoded.recycle()
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } catch (error: Exception) {
      decoded.recycle()
      throw NativeException("PROCESSOR_OUTPUT_INVALID")
    }
    val orientedWidth = oriented.width
    val orientedHeight = oriented.height
    val pixels = try {
      IntArray(orientedWidth * orientedHeight)
    } catch (_: OutOfMemoryError) {
      if (oriented !== decoded) oriented.recycle()
      decoded.recycle()
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    }
    try {
      oriented.getPixels(pixels, 0, orientedWidth, 0, 0, orientedWidth, orientedHeight)
    } catch (_: OutOfMemoryError) {
      throw NativeException("RESOURCE_MEMORY_PRESSURE")
    } finally {
      if (oriented !== decoded) oriented.recycle()
      decoded.recycle()
    }
    val luminance = sampleLuminance(pixels, orientedWidth, orientedHeight)
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
          luminance[row * sampleWidth + column + 1]) {
          result = result or 1UL
        }
      }
    }
    return result.toString(16).padStart(16, '0')
  }

  internal fun sampleLuminance(pixels: IntArray, width: Int, height: Int): IntArray {
    require(width > 0 && height > 0 && pixels.size == width * height)
    val samples = IntArray(sampleWidth * sampleHeight)
    for (row in 0 until sampleHeight) {
      val yStart = row * height / sampleHeight
      val yEnd = minOf(height, maxOf(yStart + 1, (row + 1) * height / sampleHeight))
      for (column in 0 until sampleWidth) {
        val xStart = column * width / sampleWidth
        val xEnd = minOf(width, maxOf(xStart + 1, (column + 1) * width / sampleWidth))
        var total = 0L
        var count = 0L
        for (y in yStart until yEnd) {
          for (x in xStart until xEnd) {
            total += luminanceOverWhite(pixels[y * width + x])
            count += 1
          }
        }
        samples[row * sampleWidth + column] = (total / count).toInt()
      }
    }
    return samples
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

  private fun applyOrientation(source: Bitmap, file: File): Bitmap {
    val orientation = try {
      ExifInterface(file.path).getAttributeInt(
        ExifInterface.TAG_ORIENTATION,
        ExifInterface.ORIENTATION_NORMAL,
      )
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.setRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.setRotate(-90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
      else -> return source
    }
    return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
  }
}
