import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const androidRoot = join(process.cwd(), 'src-tauri', 'gen', 'android');
const gradlePath = join(androidRoot, 'app', 'build.gradle.kts');
const manifestPath = join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const pkgDir = join(
  androidRoot,
  'app',
  'src',
  'main',
  'java',
  'top',
  'chksz',
  'cplayer',
);
const mainActivityPath = join(pkgDir, 'MainActivity.kt');
const servicePath = join(pkgDir, 'CPlayerPlaybackService.kt');

if (!existsSync(androidRoot)) {
  console.error('[patch-android] src-tauri/gen/android not found. Run `npx tauri android init` first.');
  process.exit(1);
}

// 1. Patch app/build.gradle.kts with AndroidX Media3 dependencies
if (existsSync(gradlePath)) {
  let gradle = readFileSync(gradlePath, 'utf8');
  if (!gradle.includes('androidx.media3:media3-exoplayer')) {
    const media3Deps = `
    val media3Version = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3Version")
    implementation("androidx.media3:media3-session:$media3Version")
    implementation("androidx.media3:media3-common:$media3Version")
`;
    if (/dependencies\s*\{/.test(gradle)) {
      gradle = gradle.replace(/dependencies\s*\{/, (match) => `${match}\n${media3Deps}`);
    } else {
      gradle += `\ndependencies {\n${media3Deps}\n}\n`;
    }
    writeFileSync(gradlePath, gradle, 'utf8');
    console.log('[patch-android] Added AndroidX Media3 dependencies to build.gradle.kts');
  }
}

// 2. Patch AndroidManifest.xml with media playback permissions and MediaSessionService declaration
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

  if (!manifest.includes('CPlayerPlaybackService')) {
    const serviceXml = `
        <service
            android:name=".CPlayerPlaybackService"
            android:exported="true"
            android:foregroundServiceType="mediaPlayback">
            <intent-filter>
                <action android:name="androidx.media3.session.MediaSessionService" />
            </intent-filter>
        </service>
`;
    manifest = manifest.replace('</application>', `${serviceXml}    </application>`);
  }

  writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[patch-android] Patched AndroidManifest.xml');
}

// 3. Generate CPlayerPlaybackService.kt (ExoPlayer + MediaSessionService + Background Keep-Alive)
const playbackServiceKotlin = `package top.chksz.cplayer

import android.app.PendingIntent
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

@OptIn(UnstableApi::class)
class CPlayerPlaybackService : MediaSessionService() {
  companion object {
    @Volatile
    var onRemoteSkip: ((String) -> Unit)? = null
  }

  private lateinit var exoPlayer: ExoPlayer
  private var mediaSession: MediaSession? = null

  override fun onCreate() {
    super.onCreate()

    val audioAttrs = AudioAttributes.Builder()
      .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
      .setUsage(C.USAGE_MEDIA)
      .build()

    exoPlayer = ExoPlayer.Builder(this)
      .setAudioAttributes(audioAttrs, true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()

    val sessionPlayer = object : ForwardingPlayer(exoPlayer) {
      override fun getAvailableCommands(): Player.Commands {
        return super.getAvailableCommands().buildUpon()
          .add(COMMAND_SEEK_TO_NEXT)
          .add(COMMAND_SEEK_TO_PREVIOUS)
          .build()
      }

      override fun isCommandAvailable(command: Int): Boolean {
        if (command == COMMAND_SEEK_TO_NEXT || command == COMMAND_SEEK_TO_PREVIOUS) {
          return true
        }
        return super.isCommandAvailable(command)
      }

      override fun seekToNext() {
        onRemoteSkip?.invoke("next")
      }

      override fun seekToNextMediaItem() {
        onRemoteSkip?.invoke("next")
      }

      override fun seekToPrevious() {
        onRemoteSkip?.invoke("prev")
      }

      override fun seekToPreviousMediaItem() {
        onRemoteSkip?.invoke("prev")
      }
    }

    val activityIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val sessionActivity = PendingIntent.getActivity(
      this,
      0,
      activityIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    mediaSession = MediaSession.Builder(this, sessionPlayer)
      .setSessionActivity(sessionActivity)
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
    return mediaSession
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    val player = mediaSession?.player
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
      stopSelf()
    }
  }

  override fun onDestroy() {
    mediaSession?.run {
      exoPlayer.release()
      release()
      mediaSession = null
    }
    super.onDestroy()
  }
}
`;

// 4. Patch MainActivity.kt (Edge-to-Edge + MediaController JS Bridge + Back-to-Background)
const mainActivityKotlin = `package top.chksz.cplayer

import android.Manifest
import android.content.ComponentName
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var mediaController: MediaController? = null
  private var pendingAction: ((MediaController) -> Unit)? = null

  private val progressTicker = object : Runnable {
    override fun run() {
      emitPlaybackState()
      if (mediaController?.isPlaying == true) {
        mainHandler.postDelayed(this, 250L)
      }
    }
  }

  private fun emitJs(script: String) {
    mainHandler.post {
      webViewRef?.evaluateJavascript(script, null)
    }
  }

  private fun emitPlaybackState() {
    val ctrl = mediaController ?: return
    val playing = ctrl.isPlaying
    val buffering = ctrl.playbackState == Player.STATE_BUFFERING
    val posMs = ctrl.currentPosition.coerceAtLeast(0L)
    val durMs = if (ctrl.duration > 0L) ctrl.duration else 0L
    emitJs("window.__cplayerNativeBridge?.onState?.($playing, $buffering, $posMs, $durMs)")
  }

  private fun withController(block: (MediaController) -> Unit) {
    mainHandler.post {
      val ctrl = mediaController
      if (ctrl != null) {
        block(ctrl)
      } else {
        pendingAction = block
      }
    }
  }

  inner class NativeMediaBridge {
    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun loadAndPlay(
      url: String,
      title: String,
      artist: String,
      album: String,
      coverUrl: String,
      startMs: Long,
    ) {
      withController { ctrl ->
        val metaBuilder = MediaMetadata.Builder()
          .setTitle(title)
          .setArtist(artist)
          .setAlbumTitle(album)
        if (coverUrl.isNotBlank()) {
          metaBuilder.setArtworkUri(Uri.parse(coverUrl))
        }
        val item = MediaItem.Builder()
          .setUri(url)
          .setMediaMetadata(metaBuilder.build())
          .build()
        ctrl.setMediaItem(item, startMs.coerceAtLeast(0L))
        ctrl.prepare()
        ctrl.play()
      }
    }

    @JavascriptInterface
    fun play() {
      withController { it.play() }
    }

    @JavascriptInterface
    fun pause() {
      withController { it.pause() }
    }

    @JavascriptInterface
    fun seekTo(ms: Long) {
      withController { it.seekTo(ms.coerceAtLeast(0L)) }
    }

    @JavascriptInterface
    fun stop() {
      withController {
        it.stop()
        it.clearMediaItems()
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Edge-to-edge transparent status & navigation bars
    WindowCompat.setDecorFitsSystemWindows(window, false)
    @Suppress("DEPRECATION")
    window.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    window.navigationBarColor = Color.TRANSPARENT
    val insetsController = WindowInsetsControllerCompat(window, window.decorView)
    insetsController.isAppearanceLightStatusBars = false
    insetsController.isAppearanceLightNavigationBars = false

    // Request notification permission on Android 13+ for persistent Media3 playback controls
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val perm = Manifest.permission.POST_NOTIFICATIONS
      if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(this, arrayOf(perm), 1001)
      }
    }

    // Bind MediaController to foreground MediaSessionService
    val token = SessionToken(this, ComponentName(this, CPlayerPlaybackService::class.java))
    val future = MediaController.Builder(this, token).buildAsync()
    controllerFuture = future
    future.addListener(
      {
        try {
          val ctrl = future.get()
          mediaController = ctrl
          ctrl.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
              emitPlaybackState()
              mainHandler.removeCallbacks(progressTicker)
              if (isPlaying) {
                mainHandler.postDelayed(progressTicker, 250L)
              }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
              emitPlaybackState()
              if (playbackState == Player.STATE_ENDED) {
                emitJs("window.__cplayerNativeBridge?.onEnded?.()")
              }
            }

            override fun onPlayerError(error: PlaybackException) {
              val msg = JSONObject.quote(error.localizedMessage ?: "音频播放失败")
              emitJs("window.__cplayerNativeBridge?.onError?.($msg)")
            }
          })
          pendingAction?.let { action ->
            pendingAction = null
            action(ctrl)
          }
        } catch (_: Exception) {
          // Fallback safely if MediaController connection fails
        }
      },
      ContextCompat.getMainExecutor(this),
    )

    CPlayerPlaybackService.onRemoteSkip = { action ->
      val quoted = JSONObject.quote(action)
      emitJs("window.__cplayerNativeBridge?.onRemoteCommand?.($quoted)")
    }

    // Intercept system back gesture: let web UI close sheets/tabs/flip first,
    // otherwise move task to background so Media3 audio keeps playing.
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
    webView.addJavascriptInterface(NativeMediaBridge(), "CPlayerNativeMedia")
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(progressTicker)
    CPlayerPlaybackService.onRemoteSkip = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    mediaController = null
    super.onDestroy()
  }
}
`;

if (existsSync(pkgDir)) {
  writeFileSync(servicePath, playbackServiceKotlin, 'utf8');
  console.log('[patch-android] Wrote CPlayerPlaybackService.kt');
} else {
  console.warn('[patch-android] Kotlin package directory not found:', pkgDir);
}

if (existsSync(mainActivityPath)) {
  writeFileSync(mainActivityPath, mainActivityKotlin, 'utf8');
  console.log('[patch-android] Patched MainActivity.kt');
} else {
  console.warn('[patch-android] MainActivity.kt not found at expected path:', mainActivityPath);
}
