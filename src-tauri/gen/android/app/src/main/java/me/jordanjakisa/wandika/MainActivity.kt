package me.jordanjakisa.wandika

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Text follows the phone's font size setting, as it does in native apps.
  override fun onWebViewCreate(webView: WebView) {
    webView.settings.textZoom = (resources.configuration.fontScale * 100).toInt()
  }
}
