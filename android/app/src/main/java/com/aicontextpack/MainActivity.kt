package com.aicontextpack

import android.os.Build
import android.os.Bundle
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.aicontextpack.nativebridge.MetadataEventStore
import com.aicontextpack.nativebridge.EphemeralShareEventStore

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
    importSharedImage(intent, restored = savedInstanceState != null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    importSharedImage(intent, restored = false)
  }

  private fun importSharedImage(intent: Intent?, restored: Boolean) {
    if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("image/") != true) return
    val transactionStore = ShareIntentTransactionStore(applicationContext.filesDir)
    val transaction = if (restored) transactionStore.restored() ?: transactionStore.acceptNew()
      else transactionStore.acceptNew()
    when (transaction.state) {
      ShareIntentTransactionStore.State.PUBLISHED_NEEDS_EVENT -> {
        publishTerminalResult(transaction.id, ShareInboxImporter.Result.COMPLETE, transactionStore)
        return
      }
      ShareIntentTransactionStore.State.COMPLETE,
      ShareIntentTransactionStore.State.FAILED,
      ShareIntentTransactionStore.State.RECOVERY_REQUIRED -> return
      else -> Unit
    }
    setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
    ShareInboxImporter.importIfSupportedAsync(
      applicationContext,
      intent,
      transaction.id,
      started = { transactionStore.transition(transaction.id, ShareIntentTransactionStore.State.IN_PROGRESS) },
    ) { result ->
      publishTerminalResult(transaction.id, result, transactionStore)
    }
  }

  private fun publishTerminalResult(
    transactionId: String,
    result: ShareInboxImporter.Result,
    transactionStore: ShareIntentTransactionStore,
  ) {
    val event = ShareResultEventPublisher.persistOrFallback(transactionId, result.wireValue) { value ->
      MetadataEventStore.persistShareResult(applicationContext.filesDir, value, transactionId, transactionId)
    }
    if (event["durable"] == true) {
      transactionStore.transition(
        transactionId,
        if (result == ShareInboxImporter.Result.COMPLETE) ShareIntentTransactionStore.State.COMPLETE
        else ShareIntentTransactionStore.State.FAILED,
      )
    }
    EphemeralShareEventStore.publishIfEphemeral(event)
    runOnUiThread {
      reactInstanceManager.currentReactContext
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("AIContextPackInboxChanged", Arguments.makeNativeMap(event))
    }
  }

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
    persist: (String) -> Map<String, Any>,
  ): Map<String, Any> = try {
    persist(result) + ("durable" to true)
  } catch (_: Exception) {
    mapOf(
      "schemaVersion" to 1,
      "id" to transactionId,
      "result" to "failed",
      "durable" to false,
      "code" to "SHARE_RESULT_PERSIST_FAILED",
    )
  }
}
