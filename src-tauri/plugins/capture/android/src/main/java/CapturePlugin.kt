package me.jordanjakisa.wandika.capture

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class PdfArgs {
    lateinit var title: String
}

@InvokeArg
class VoiceArgs {
    lateinit var onEvent: Channel
}

/**
 * PDF export through Android's print dialog (Save as PDF is one of its printers), and voice notes
 * turned into text by the phone's on-device recognizer. A recognizer that needs the network is
 * never used, so no audio leaves the phone. Each pause ends a line; listening goes on until Stop.
 */
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")])
class CapturePlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var recognizer: SpeechRecognizer? = null
    private var channel: Channel? = null
    private val lines = mutableListOf<String>()
    private var live = ""
    private var listening = false
    private var stopping: Invoke? = null
    private val main = Handler(Looper.getMainLooper())

    override fun load(webView: WebView) {
        this.webView = webView
    }

    @Command
    fun exportPdf(invoke: Invoke) {
        val args = invoke.parseArgs(PdfArgs::class.java)
        activity.runOnUiThread {
            val view = webView
            if (view == null) {
                invoke.reject("The note isn't ready to export yet.")
                return@runOnUiThread
            }
            val name = args.title.ifBlank { "Note" }
            val printer = activity.getSystemService(Context.PRINT_SERVICE) as PrintManager
            printer.print(name, view.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
            invoke.resolve()
        }
    }

    @Command
    fun voiceStart(invoke: Invoke) {
        channel = invoke.parseArgs(VoiceArgs::class.java).onEvent
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", invoke, "micAnswered")
            return
        }
        begin(invoke)
    }

    @PermissionCallback
    private fun micAnswered(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            begin(invoke)
        } else {
            fail("Wandika can't use the microphone. Turn it on in Settings, Apps, Wandika, Permissions.", "voice_denied")
            invoke.resolve()
        }
    }

    private fun begin(invoke: Invoke) {
        activity.runOnUiThread {
            if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(activity)) {
                fail("This phone can't turn speech into text offline. Voice notes need Android 12 or later with on-device speech.", "voice_offline")
                invoke.resolve()
                return@runOnUiThread
            }
            recognizer?.destroy()
            lines.clear()
            live = ""
            listening = true
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(activity).also { it.setRecognitionListener(listener) }
            listen()
            invoke.resolve()
        }
    }

    private fun recognizeIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
    }

    private fun listen() = recognizer?.startListening(recognizeIntent())

    private fun text() = (lines + live).map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n")

    private fun send(kind: String, extra: (JSObject) -> Unit = {}) {
        val o = JSObject()
        o.put("kind", kind)
        extra(o)
        channel?.send(o)
    }

    private fun fail(message: String, code: String) = send("failed") {
        it.put("message", message)
        it.put("code", code)
        it.put("text", text())
    }

    private fun firstResult(b: Bundle?) = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val t = firstResult(partialResults)
            if (t.isNotEmpty()) {
                live = t
                send("text") { it.put("text", text()) }
            }
        }

        override fun onResults(results: Bundle?) {
            val t = firstResult(results).ifEmpty { live }
            if (t.isNotBlank()) lines.add(t)
            live = ""
            send("text") { it.put("text", text()) }
            when {
                stopping != null -> finishStop()
                listening -> listen()
            }
        }

        override fun onError(error: Int) {
            if (stopping != null) return finishStop()
            if (!listening) return
            when (error) {
                // A pause with nothing said: keep listening.
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> listen()
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE, SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> {
                    if (Build.VERSION.SDK_INT >= 33) recognizer?.triggerModelDownload(recognizeIntent())
                    end()
                    fail("This phone is downloading speech for your language. Try again in a minute.", "voice_offline")
                }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                    end()
                    fail("Wandika can't use the microphone. Turn it on in Settings, Apps, Wandika, Permissions.", "voice_denied")
                }
                else -> {
                    end()
                    fail("Listening stopped. Try again.", "voice_failed")
                }
            }
        }
    }

    @Command
    fun voiceStop(invoke: Invoke) {
        activity.runOnUiThread {
            if (!listening) {
                invoke.resolve()
                return@runOnUiThread
            }
            listening = false
            stopping = invoke
            recognizer?.stopListening()
            // The last words arrive in onResults; don't wait for ever.
            main.postDelayed({ if (stopping != null) finishStop() }, 1500)
        }
    }

    private fun finishStop() {
        val invoke = stopping
        stopping = null
        if (live.isNotBlank()) lines.add(live)
        live = ""
        send("done") { it.put("text", text()) }
        end()
        invoke?.resolve()
    }

    private fun end() {
        listening = false
        recognizer?.destroy()
        recognizer = null
    }

    override fun onPause(activity: AppCompatActivity) {
        // Leaving the app ends the note with what was said so far.
        if (listening) activity.runOnUiThread {
            listening = false
            stopping = null
            if (live.isNotBlank()) lines.add(live)
            live = ""
            send("done") { it.put("text", text()) }
            end()
        }
    }

    /** Voice notes from outside the app exist only on iPhone; Android has none waiting. */
    @Command
    fun pendingCaptures(invoke: Invoke) {
        val o = JSObject()
        o.put("captures", JSArray())
        invoke.resolve(o)
    }

    @Command
    fun clearCaptures(invoke: Invoke) = invoke.resolve()
}
