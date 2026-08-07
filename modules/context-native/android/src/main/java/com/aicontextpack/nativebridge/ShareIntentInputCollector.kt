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
    val representedUris = mutableSetOf<String>()
    val representedText = mutableSetOf<String>()
    val clip = intent.clipData
    if (clip != null && clip.itemCount > 0) {
      for (index in 0 until clip.itemCount) {
        val item = clip.getItemAt(index)
        val uri = item.uri
        val text = item.text?.toString()
        when {
          uri != null -> {
            planned.appendBounded { uriInput(context, uri, intent.type) }
            representedUris += uri.toString()
          }
          text != null -> {
            planned.appendBounded { textInput(text, intent.type) }
            representedText += text
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
    streamUris(intent).filter { uri -> representedUris.add(uri.toString()) }
      .forEach { uri ->
        planned.appendBounded { uriInput(context, uri, intent.type) }
      }
    textValues(intent).filterNot(representedText::contains)
      .forEach { value ->
        planned.appendBounded { textInput(value, intent.type) }
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
    return if (normalized != null && concreteMediaType.matches(normalized)) normalized
    else "application/octet-stream"
  }

  private fun uriInput(context: Context, uri: Uri, intentType: String?): PlannedInput {
    val resolved = try { context.contentResolver.getType(uri) } catch (_: RuntimeException) { null }
    return PlannedInput(
      declaredMediaType = resolved ?: intentType,
      openStream = { context.contentResolver.openInputStream(uri) },
    )
  }

  private fun textInput(text: String, intentType: String?): PlannedInput = PlannedInput(
    declaredMediaType = if (intentType?.startsWith("text/") == true) intentType else "text/plain",
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
