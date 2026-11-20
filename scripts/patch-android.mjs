import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const androidRoot = join(process.cwd(), 'src-tauri', 'gen', 'android');
const manifestPath = join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const mainActivityPath = join(
  androidRoot,
  'app',
  'src',
  'main',
  'java',
  'top',
  'chksz',
  'cplayer',
  'MainActivity.kt',
);

if (!existsSync(androidRoot)) {
  console.error('[patch-android] src-tauri/gen/android not found. Run `npx tauri android init` first.');
  process.exit(1);
}

// 1. Patch AndroidManifest.xml with media playback & background permissions
if (existsSync(manifestPath)) {
  let manifest = readFileSync(manifestPath, 'utf8');
  const requiredPerms = [
    'android.permission.INTERNET',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.POST_NOTIFICATIONS',
  ];

  for (const perm of requiredPerms) {
    if (!manifest.includes(perm)) {
      manifest = manifest.replace(
        '<application',
        `    <uses-permission android:name="${perm}" />\n    <application`,
      );
    }
  }

  writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[patch-android] Patched AndroidManifest.xml');
}

// 2. Patch MainActivity.kt for Edge-to-Edge transparent system bars,
//    WebView media autoplay/background friendliness, and back-button -> moveTaskToBack
const mainActivityKotlin = `package top.chksz.cplayer

import android.graphics.Color
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Edge-to-edge transparent status & navigation bars
    WindowCompat.setDecorFitsSystemWindows(window, false)
    @Suppress("DEPRECATION")
    window.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    window.navigationBarColor = Color.TRANSPARENT
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = false
    controller.isAppearanceLightNavigationBars = false

    // Intercept system back gesture: let web UI close sheets/tabs first,
    // otherwise move to background so audio continues smoothly.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webViewRef
        if (wv == null) {
          moveTaskToBack(true)
          return
        }
        wv.evaluateJavascript(
          "(function(){ var e = new CustomEvent('cplayer:android-back', { cancelable: true }); return !window.dispatchEvent(e); })()"
        ) { result ->
          if (result != "true") {
            moveTaskToBack(true)
          }
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.settings.domStorageEnabled = true
  }
}
`;

if (existsSync(mainActivityPath)) {
  writeFileSync(mainActivityPath, mainActivityKotlin, 'utf8');
  console.log('[patch-android] Patched MainActivity.kt');
} else {
  console.warn('[patch-android] MainActivity.kt not found at expected path:', mainActivityPath);
}
