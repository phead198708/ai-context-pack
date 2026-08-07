package com.aicontextpack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class AndroidManifestContractTest {
  @Test
  fun registersNarrowDevelopmentSchemeWithoutChangingExistingEntryPoints() {
    val manifest = File("src/main/AndroidManifest.xml")
    assertTrue("source AndroidManifest.xml must be available", manifest.isFile)
    val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
    val document = factory.newDocumentBuilder().parse(manifest)
    val activities = document.getElementsByTagName("activity")
    val mainActivity = (0 until activities.length)
      .map { activities.item(it) as Element }
      .firstOrNull { it.androidName() == ".MainActivity" }
    assertNotNull("MainActivity must remain registered", mainActivity)

    val filters = requireNotNull(mainActivity).getElementsByTagName("intent-filter")
    val contracts = (0 until filters.length)
      .map { filters.item(it) as Element }
      .map(::contract)

    assertTrue(contracts.any {
      it.actions == setOf("android.intent.action.MAIN") &&
        it.categories == setOf("android.intent.category.LAUNCHER")
    })
    assertTrue(contracts.any {
      it.actions == setOf("android.intent.action.SEND") &&
        it.categories == setOf("android.intent.category.DEFAULT") &&
        it.data.map { data -> data.getAttributeNS(androidNamespace, "mimeType") }.toSet() ==
        setOf("image/*", "application/pdf", "text/plain", "text/uri-list")
    })
    assertTrue(contracts.any {
      it.actions == setOf("android.intent.action.SEND_MULTIPLE") &&
        it.categories == setOf("android.intent.category.DEFAULT") &&
        it.data.singleOrNull()?.getAttributeNS(androidNamespace, "mimeType") == "*/*"
    })

    val development = contracts.single {
      it.actions == setOf("android.intent.action.VIEW") &&
        it.data.any { data -> data.getAttributeNS(androidNamespace, "scheme") == "aicontextpack" }
    }
    assertEquals(
      setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"),
      development.categories,
    )
    assertEquals(1, development.data.size)
    val data = development.data.single()
    assertEquals("aicontextpack", data.getAttributeNS(androidNamespace, "scheme"))
    listOf("host", "port", "path", "pathPrefix", "pathPattern", "mimeType").forEach { attribute ->
      assertEquals("development scheme must not widen $attribute", "", data.getAttributeNS(androidNamespace, attribute))
    }
  }

  private fun contract(filter: Element): IntentFilterContract = IntentFilterContract(
    actions = filter.children("action").map { it.androidName() }.toSet(),
    categories = filter.children("category").map { it.androidName() }.toSet(),
    data = filter.children("data"),
  )

  private fun Element.children(tag: String): List<Element> {
    val nodes = getElementsByTagName(tag)
    return (0 until nodes.length).map { nodes.item(it) as Element }
  }

  private fun Element.androidName(): String = getAttributeNS(androidNamespace, "name")

  private data class IntentFilterContract(
    val actions: Set<String>,
    val categories: Set<String>,
    val data: List<Element>,
  )

  private companion object {
    const val androidNamespace = "http://schemas.android.com/apk/res/android"
  }
}
