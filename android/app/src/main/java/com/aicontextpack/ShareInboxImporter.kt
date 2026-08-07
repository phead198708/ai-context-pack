package com.aicontextpack

import android.content.Context
import android.content.Intent
import com.aicontextpack.nativebridge.ShareIngestionInput
import com.aicontextpack.nativebridge.ShareIngestionSummary
import com.aicontextpack.nativebridge.ShareInputCollectionException
import com.aicontextpack.nativebridge.ShareIntentInputCollector
import com.aicontextpack.nativebridge.ShareIngestionWriter
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.Executors

object ShareInboxImporter {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "share-inbox-import").apply { isDaemon = true }
  }

  data class Result(
    val published: Boolean,
    val status: String? = null,
    val copied: Int = 0,
    val rejected: Int = 0,
    val failed: Int = 0,
    val code: String? = null,
  )

  fun importIfSupportedAsync(
    context: Context,
    intent: Intent?,
    ingestionId: String,
    started: () -> Unit,
    completion: (Result) -> Unit,
  ): Boolean {
    if (intent?.action != Intent.ACTION_SEND && intent?.action != Intent.ACTION_SEND_MULTIPLE) {
      return false
    }
    val shareIntent = Intent(intent)
    executor.execute {
      val result = try {
        started()
        val inputs = collectInputs(context, shareIntent)
        ShareIngestionWriter.publish(context.filesDir, ingestionId, inputs).toResult()
      } catch (error: ShareInputCollectionException) {
        Result(published = false, code = error.stableCode)
      } catch (_: Exception) {
        Result(published = false, code = "SHARE_IMPORT_FAILED")
      }
      completion(result)
    }
    return true
  }

  internal fun collectInputs(context: Context, intent: Intent): List<ShareIngestionInput> {
    return ShareIntentInputCollector.collect(context, intent)
  }

  internal fun copyBounded(input: InputStream, output: OutputStream, limit: Long): Long {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) return total
      if (read == 0) continue
      total += read
      check(total <= limit) { "IMPORT_SIZE_LIMIT_EXCEEDED" }
      output.write(buffer, 0, read)
    }
  }

  internal fun concreteOrFallback(value: String?): String {
    return ShareIntentInputCollector.concreteOrFallback(value)
  }

  private fun ShareIngestionSummary.toResult(): Result = Result(
    published = true,
    status = status,
    copied = copied,
    rejected = rejected,
    failed = failed,
  )
}
