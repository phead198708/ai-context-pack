package com.aicontextpack

import android.os.Build
import android.os.Bundle
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.aicontextpack.nativebridge.MetadataEventStore
import com.aicontextpack.nativebridge.EphemeralShareEventStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    handleLaunch(intent, restored = savedInstanceState != null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleLaunch(intent, restored = false)
  }

  private fun handleLaunch(intent: Intent?, restored: Boolean) {
    val transactionStore = ShareIntentTransactionStore(applicationContext.filesDir)
    val coordinator = lifecycleCoordinator(transactionStore)
    coordinator.reconcile(activeWorkerIds.toSet())
    if (intent?.action != Intent.ACTION_SEND) return
    setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
    if (restored || intent.type?.startsWith("image/") != true) return

    val id = UUID.randomUUID().toString()
    val transaction = coordinator.acceptNew(id) ?: return
    activeWorkerIds += transaction.id
    try {
      ShareInboxImporter.importIfSupportedAsync(
        applicationContext,
        intent,
        transaction.id,
        started = { coordinator.markInProgress(transaction.id) },
      ) { result ->
        try {
          coordinator.completeWorker(transaction.id, result)
        } finally {
          activeWorkerIds -= transaction.id
        }
      }
    } catch (_: Exception) {
      activeWorkerIds -= transaction.id
      coordinator.completeWorker(transaction.id, ShareInboxImporter.Result.FAILED)
    }
  }

  private fun lifecycleCoordinator(
    transactionStore: ShareIntentTransactionStore,
  ) = ShareIntentLifecycleCoordinator(
    transactionStore,
    artifactState = { id ->
      ShareIntentLifecycleCoordinator.inspectArtifacts(applicationContext.filesDir, id)
    },
    publishTerminal = { transaction ->
      val event = publishEvent(
        eventId = transaction.id,
        transactionId = transaction.id,
        result = requireNotNull(transaction.terminalResult).wireValue,
        code = transaction.terminalCode,
      )
      event["durable"] == true
    },
    publishIssue = { issue ->
      publishEvent(issue.eventId, issue.transactionId, "failed", issue.code)
    },
  )

  private fun publishEvent(
    eventId: String,
    transactionId: String,
    result: String,
    code: String?,
  ): Map<String, Any> {
    val event = ShareResultEventPublisher.persistOrFallback(
      transactionId,
      result,
      code,
      eventId,
    ) { value, stableCode ->
      MetadataEventStore.persistShareResult(
        applicationContext.filesDir,
        value,
        transactionId,
        eventId,
        stableCode,
      )
    }
    EphemeralShareEventStore.publishIfEphemeral(event)
    deliverEvent(event)
    return event
  }

  private fun deliverEvent(event: Map<String, Any>) {
    runOnUiThread {
      currentReactContextOrNull()
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("AIContextPackInboxChanged", Arguments.makeNativeMap(event))
    }
  }

  companion object {
    private val activeWorkerIds = ConcurrentHashMap.newKeySet<String>()
  }

  private fun currentReactContextOrNull() =
    ReactContextResolver.resolve(
      host = { reactHost?.currentReactContext },
      legacy = { reactInstanceManager.currentReactContext },
    )

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}

internal object ShareResultEventPublisher {
  fun persistOrFallback(
    transactionId: String,
    result: String,
    code: String? = null,
    eventId: String = transactionId,
    persist: (String, String?) -> Map<String, Any>,
  ): Map<String, Any> = try {
    persist(result, code) + ("durable" to true)
  } catch (_: Exception) {
    mapOf(
      "schemaVersion" to 1,
      "id" to stableFallbackId(eventId),
      "transactionId" to transactionId,
      "result" to "failed",
      "durable" to false,
      "code" to (code ?: "SHARE_RESULT_PERSIST_FAILED"),
    )
  }

  private fun stableFallbackId(transactionId: String): String = java.util.UUID.nameUUIDFromBytes(
    "ai-context-pack:share-result-persist:$transactionId".toByteArray(),
  ).toString()
}

internal object ReactContextResolver {
  // Events are already durable; live bridge delivery must stay optional during host transitions.
  fun <T> resolve(host: () -> T?, legacy: () -> T?): T? =
    resolveOrNull(host) ?: resolveOrNull(legacy)

  private fun <T> resolveOrNull(provider: () -> T?): T? = try {
    provider()
  } catch (_: RuntimeException) {
    null
  }
}
