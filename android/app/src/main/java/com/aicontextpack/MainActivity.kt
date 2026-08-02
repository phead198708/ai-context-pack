package com.aicontextpack

import android.os.Build
import android.os.Bundle
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.aicontextpack.nativebridge.MetadataEventStore

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
    if (ShareLaunchGate.shouldConsumeInitialIntent(savedInstanceState != null)) importSharedImage(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    importSharedImage(intent)
  }

  private fun importSharedImage(intent: Intent?) {
    if (intent?.action == Intent.ACTION_SEND && intent.type?.startsWith("image/") == true) {
      setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
    }
    ShareInboxImporter.importIfSupportedAsync(applicationContext, intent) { result ->
      val event = ShareResultEventPublisher.persistOrFallback(result.wireValue) { value ->
        MetadataEventStore.persistShareResult(applicationContext.filesDir, value)
      }
      runOnUiThread {
        reactInstanceManager.currentReactContext
          ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          ?.emit("AIContextPackInboxChanged", Arguments.makeNativeMap(event))
      }
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

internal object ShareLaunchGate {
  fun shouldConsumeInitialIntent(restoredSystemTask: Boolean): Boolean = !restoredSystemTask
}

internal object ShareResultEventPublisher {
  fun persistOrFallback(
    result: String,
    persist: (String) -> Map<String, Any>,
  ): Map<String, Any> = try {
    persist(result)
  } catch (_: Exception) {
    mapOf(
      "schemaVersion" to 1,
      "id" to java.util.UUID.randomUUID().toString(),
      "result" to "failed",
      "durable" to false,
    )
  }
}
