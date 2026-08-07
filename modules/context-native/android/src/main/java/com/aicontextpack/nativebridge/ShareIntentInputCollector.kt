package com.aicontextpack.nativebridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.UUID

/** Converts Android share payload surfaces into one ordered, provider-lifetime-bound input list. */
object ShareIntentInputCollector {
  fun collect(context: Context, intent: Intent): List<ShareIngestionInput> {
    val planned = mutableListOf<PlannedInput>()
    val representedUris = mutableMapOf<String, Int>()
    val representedText = mutableMapOf<String, Int>()
    val clip = intent.clipData
    if (clip != null && clip.itemCount > 0) {
      for (index in 0 until clip.itemCount) {
        val item = clip.getItemAt(index)
        val uri = item.uri
        val text = item.text?.toString()
        when {
          uri != null -> {
            planned.appendBounded { uriInput(context, uri, intent.type) }
            representedUris.increment(uri.toString())
          }
          text != null -> {
            planned.appendBounded { textInput(text, intent.type) }
            representedText.increment(text)
          }
          else -> {
            planned.appendBounded {
              PlannedInput(
                declaredMediaType = "application/octet-stream",
                preflightError = "IMPORT_COPY_FAILED",
              )
            }
          }
        }
      }
    }
    val extraUriOccurrences = mutableMapOf<String, Int>()
    streamUris(intent).forEach { uri ->
      val key = uri.toString()
      val occurrence = extraUriOccurrences.increment(key)
      if (occurrence > (representedUris[key] ?: 0)) {
        planned.appendBounded { uriInput(context, uri, intent.type) }
      }
    }
    val extraTextOccurrences = mutableMapOf<String, Int>()
    textValues(intent).forEach { value ->
      val occurrence = extraTextOccurrences.increment(value)
      if (occurrence > (representedText[value] ?: 0)) {
        planned.appendBounded { textInput(value, intent.type) }
      }
    }
    if (planned.isEmpty()) {
      planned += PlannedInput(
        declaredMediaType = concreteOrFallback(intent.type),
        preflightError = "IMPORT_COPY_FAILED",
      )
    }
    return planned.mapIndexed { index, input ->
      val overItemLimit = index >= ShareIngestionWriter.maximumItemCount
      ShareIngestionInput(
        id = UUID.randomUUID().toString(),
        order = index,
        declaredMediaType = input.declaredMediaType,
        openStream = if (overItemLimit) null else input.openStream,
        preflightError = if (overItemLimit) "IMPORT_SIZE_LIMIT_EXCEEDED" else input.preflightError,
      )
    }
  }

  private fun MutableList<PlannedInput>.appendBounded(create: () -> PlannedInput) {
    if (size >= ShareIngestionWriter.maximumReportedItemCount) {
      throw ShareInputCollectionException("IMPORT_SIZE_LIMIT_EXCEEDED")
    }
    add(create())
  }

  fun concreteOrFallback(value: String?): String {
    val normalized = value?.substringBefore(';')?.trim()?.lowercase()
    return if (
      normalized != null &&
      normalized.length <= ShareIngestionWriter.maximumMediaTypeLength &&
      concreteMediaType.matches(normalized)
    ) normalized
    else "application/octet-stream"
  }

  private fun MutableMap<String, Int>.increment(key: String): Int =
    (get(key) ?: 0).plus(1).also { put(key, it) }

  private fun uriInput(context: Context, uri: Uri, intentType: String?): PlannedInput {
    val resolved = try { context.contentResolver.getType(uri) } catch (_: RuntimeException) { null }
    return PlannedInput(
      declaredMediaType = concreteOrFallback(resolved ?: intentType),
      openStream = { context.contentResolver.openInputStream(uri) },
    )
  }

  private fun textInput(text: String, intentType: String?): PlannedInput = PlannedInput(
    declaredMediaType = concreteOrFallback(intentType).takeIf { it.startsWith("text/") }
      ?: "text/plain",
    openStream = { ByteArrayInputStream(text.toByteArray(StandardCharsets.UTF_8)) },
  )

  @Suppress("DEPRECATION")
  private fun streamUris(intent: Intent): List<Uri> {
    val multiple = if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
    }
    if (!multiple.isNullOrEmpty()) return multiple
    val single = if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }
    return listOfNotNull(single)
  }

  @Suppress("DEPRECATION")
  private fun textValues(intent: Intent): Sequence<String> = when (
    val value = intent.extras?.get(Intent.EXTRA_TEXT)
  ) {
    is CharSequence -> sequenceOf(value.toString())
    is Array<*> -> value.asSequence().filterIsInstance<CharSequence>().map(CharSequence::toString)
    is List<*> -> value.asSequence().filterIsInstance<CharSequence>().map(CharSequence::toString)
    else -> emptySequence()
  }

  private data class PlannedInput(
    val declaredMediaType: String?,
    val openStream: (() -> InputStream?)? = null,
    val preflightError: String? = null,
  )

  private val concreteMediaType = Regex(
    "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$",
  )
}
