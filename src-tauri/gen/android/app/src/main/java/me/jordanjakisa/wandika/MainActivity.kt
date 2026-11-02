package me.jordanjakisa.wandika

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Text follows the phone's font size setting, as it does in native apps.
    webView.settings.textZoom = (resources.configuration.fontScale * 100).toInt()
    // The page picks light or dark itself (Settings can override the system), so it tells us which,
    // and the status and navigation bar icons follow: dark icons on the light page, light on dark.
    webView.addJavascriptInterface(Bars(), "WandikaAndroid")
  }

  inner class Bars {
    @JavascriptInterface
    fun setDark(dark: Boolean) {
      runOnUiThread {
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightStatusBars = !dark
        bars.isAppearanceLightNavigationBars = !dark
      }
    }
  }
}
