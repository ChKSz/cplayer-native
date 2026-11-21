import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const androidRoot = join(process.cwd(), 'src-tauri', 'gen', 'android');
const buildSrcDir = join(androidRoot, 'buildSrc');
const buildSrcSettingsPath = join(buildSrcDir, 'settings.gradle.kts');
const buildSrcGradlePath = join(buildSrcDir, 'build.gradle.kts');
const rootGradlePath = join(androidRoot, 'build.gradle.kts');
const gradlePath = join(androidRoot, 'app', 'build.gradle.kts');
const proguardPath = join(androidRoot, 'app', 'proguard-cplayer.pro');
const GCS_MAVEN_CENTRAL = 'https://maven-central.storage-download.googleapis.com/maven2/';
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

// 0. Ensure buildSrc and root Gradle resolve Maven Central via Google's GCS mirror first
// (avoids Maven Central / Cloudflare edge 404/rate-limit issues on GitHub Actions runners)
if (existsSync(buildSrcDir)) {
  const buildSrcSettings = `pluginManagement {
    repositories {
        maven {
            name = "GoogleMavenCentralMirror"
            url = uri("${GCS_MAVEN_CENTRAL}")
        }
        google()
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "buildSrc"
`;
  writeFileSync(buildSrcSettingsPath, buildSrcSettings, 'utf8');
  console.log('[patch-android] Wrote buildSrc/settings.gradle.kts with Google GCS Maven mirror');
}

function injectGcsMirror(filePath, label) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  if (content.includes('maven-central.storage-download.googleapis.com')) return;
  const patched = content.replace(
    /^([ \t]*)mavenCentral\(\)/gm,
    `$1maven { url = uri("${GCS_MAVEN_CENTRAL}") }\n$1mavenCentral()`,
  );
  if (patched !== content) {
    writeFileSync(filePath, patched, 'utf8');
    console.log(`[patch-android] Added Google GCS Maven mirror to ${label}`);
  }
}

injectGcsMirror(buildSrcGradlePath, 'buildSrc/build.gradle.kts');
injectGcsMirror(rootGradlePath, 'build.gradle.kts');

// 1. Patch app/build.gradle.kts with AndroidX Media3 dependencies & APK size optimizations
if (existsSync(gradlePath)) {
  let gradle = readFileSync(gradlePath, 'utf8');
  let gradleChanged = false;

  if (!gradle.includes('androidx.media3:media3-exoplayer')) {
    const media3Deps = `
    val media3Version = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3Version")
    implementation("androidx.media3:media3-session:$media3Version")
    implementation("androidx.media3:media3-common:$media3Version")
    implementation("androidx.media3:media3-datasource:$media3Version")
    implementation("androidx.media3:media3-database:$media3Version")
`;
    if (/dependencies\s*\{/.test(gradle)) {
      gradle = gradle.replace(/dependencies\s*\{/, (match) => `${match}\n${media3Deps}`);
    } else {
      gradle += `\ndependencies {\n${media3Deps}\n}\n`;
    }
    gradleChanged = true;
    console.log('[patch-android] Added AndroidX Media3 dependencies to build.gradle.kts');
  } else if (!gradle.includes('androidx.media3:media3-datasource')) {
    gradle = gradle.replace(
      'implementation("androidx.media3:media3-common:$media3Version")',
      `implementation("androidx.media3:media3-common:$media3Version")\n    implementation("androidx.media3:media3-datasource:$media3Version")\n    implementation("androidx.media3:media3-database:$media3Version")`,
    );
    gradleChanged = true;
    console.log('[patch-android] Added Media3 datasource/database cache dependencies to build.gradle.kts');
  }

  // Strip debug symbols from debug .so as well (prevents 120+ MB unstripped Rust .so in debug APKs)
  const withoutKeepDebug = gradle.replace(/^\s*jniLibs\.keepDebugSymbols\.add\([^\n]*\)\r?\n?/gm, '');
  if (withoutKeepDebug !== gradle) {
    gradle = withoutKeepDebug;
    gradleChanged = true;
    console.log('[patch-android] Removed jniLibs.keepDebugSymbols from debug buildType');
  }

  // Enable compressed jniLibs, locale filtering (zh/en), and metadata exclusions
  if (!gradle.includes('useLegacyPackaging')) {
    const sizeOptBlock = `    androidResources {
        localeFilters.addAll(listOf("zh", "en"))
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
        resources {
            excludes += setOf(
                "META-INF/AL2.0",
                "META-INF/LGPL2.1",
                "META-INF/DEPENDENCIES",
                "META-INF/**/LICENSE*",
                "META-INF/**/NOTICE*",
                "DebugProbesKt.bin",
            )
        }
    }
`;
    if (/^[ \t]*compileOptions\s*\{/m.test(gradle)) {
      gradle = gradle.replace(/^[ \t]*compileOptions\s*\{/m, (match) => `${sizeOptBlock}${match}`);
      gradleChanged = true;
      console.log('[patch-android] Added androidResources.localeFilters & packaging compression to build.gradle.kts');
    } else {
      console.warn('[patch-android] Could not locate compileOptions block in build.gradle.kts; skipped packaging patch');
    }
  }

  if (gradleChanged) {
    writeFileSync(gradlePath, gradle, 'utf8');
  }
}

// 2. Write R8 / ProGuard keep rules for WebView @JavascriptInterface bridges & playback service
const proguardRules = `# Keep CPlayer WebView @JavascriptInterface bridges under R8 full optimization
-keepattributes *Annotation*
-keepclassmembers class top.chksz.cplayer.MainActivity$NativeMediaBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class top.chksz.cplayer.MainActivity$NativeHttpBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class top.chksz.cplayer.MainActivity { *; }
-keep class top.chksz.cplayer.CPlayerPlaybackService { *; }
-dontwarn java.beans.**
-dontwarn javax.xml.**
-dontwarn org.w3c.dom.bootstrap.**
`;
if (existsSync(join(androidRoot, 'app'))) {
  writeFileSync(proguardPath, proguardRules, 'utf8');
  console.log('[patch-android] Wrote app/proguard-cplayer.pro');
}

// 3. Patch AndroidManifest.xml with media playback permissions and MediaSessionService declaration
if (existsSync(manifestPath)) {
  let manifest = readFileSync(manifestPath, 'utf8');
  const requiredPerms = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
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

// 4. Generate CPlayerPlaybackService.kt (ExoPlayer + 500MB SimpleCache + Native Sleep Timer + MediaSessionService)
const playbackServiceKotlin = `package top.chksz.cplayer

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.File

@OptIn(UnstableApi::class)
object CPlayerMediaCache {
  private const val MAX_CACHE_BYTES: Long = 500L * 1024L * 1024L
  private var simpleCache: SimpleCache? = null

  @Synchronized
  fun getCache(context: Context): SimpleCache {
    val existing = simpleCache
    if (existing != null) return existing
    val appCtx = context.applicationContext
    val dir = File(appCtx.cacheDir, "cplayer_audio_cache")
    val evictor = LeastRecentlyUsedCacheEvictor(MAX_CACHE_BYTES)
    val dbProvider = StandaloneDatabaseProvider(appCtx)
    val created = SimpleCache(dir, evictor, dbProvider)
    simpleCache = created
    return created
  }

  @Synchronized
  fun getCacheSizeBytes(context: Context): Long {
    return try {
      getCache(context).cacheSpace
    } catch (_: Exception) {
      0L
    }
  }

  @Synchronized
  fun clearCache(context: Context): Boolean {
    return try {
      val cache = getCache(context)
      val keys = cache.keys.toList()
      for (key in keys) {
        cache.removeResource(key)
      }
      true
    } catch (_: Exception) {
      false
    }
  }
}

@OptIn(UnstableApi::class)
class CPlayerPlaybackService : MediaSessionService() {
  companion object {
    @Volatile
    var instance: CPlayerPlaybackService? = null

    @Volatile
    var onRemoteSkip: ((String) -> Unit)? = null

    @Volatile
    var onAutoTrackTransition: ((String) -> Unit)? = null

    @Volatile
    var onNativeEnded: (() -> Unit)? = null

    @Volatile
    var onSleepTimerFired: ((String) -> Unit)? = null
  }

  private val serviceHandler = Handler(Looper.getMainLooper())
  private var exoPlayer: ExoPlayer? = null
  private var mediaSession: MediaSession? = null

  @Volatile
  private var desiredRepeatOne: Boolean = false

  @Volatile
  private var stopAfterCurrentTrack: Boolean = false

  @Volatile
  private var sleepEndElapsedMs: Long = 0L

  private var fadeStepIndex: Int = 0
  private var sleepFadeStartRunnable: Runnable? = null
  private var sleepFadeStepRunnable: Runnable? = null

  private fun cancelTimedSleepRunnables() {
    sleepFadeStartRunnable?.let { serviceHandler.removeCallbacks(it) }
    sleepFadeStepRunnable?.let { serviceHandler.removeCallbacks(it) }
    sleepFadeStartRunnable = null
    sleepFadeStepRunnable = null
    sleepEndElapsedMs = 0L
  }

  private fun startFadeOutAndPause() {
    val player = exoPlayer ?: return
    fadeStepIndex = 0
    val totalSteps = 15
    val stepDelayMs = 200L
    val runnable = object : Runnable {
      override fun run() {
        val activePlayer = exoPlayer ?: return
        fadeStepIndex++
        if (fadeStepIndex >= totalSteps) {
          activePlayer.pause()
          activePlayer.volume = 1f
          sleepEndElapsedMs = 0L
          sleepFadeStepRunnable = null
          onSleepTimerFired?.invoke("timed")
          return
        }
        val vol = ((totalSteps - fadeStepIndex).toFloat() / totalSteps.toFloat()).coerceIn(0f, 1f)
        activePlayer.volume = vol
        serviceHandler.postDelayed(this, stepDelayMs)
      }
    }
    sleepFadeStepRunnable = runnable
    serviceHandler.post(runnable)
  }

  fun setNextItem(item: MediaItem) {
    serviceHandler.post {
      val player = exoPlayer ?: return@post
      if (stopAfterCurrentTrack || player.repeatMode == Player.REPEAT_MODE_ONE) return@post
      if (player.mediaItemCount == 0) return@post
      val targetIdx = player.currentMediaItemIndex + 1
      if (player.mediaItemCount > targetIdx) {
        player.removeMediaItems(targetIdx, player.mediaItemCount)
      }
      player.addMediaItem(item)
    }
  }

  fun clearNextItem() {
    serviceHandler.post {
      val player = exoPlayer ?: return@post
      val targetIdx = player.currentMediaItemIndex + 1
      if (player.mediaItemCount > targetIdx) {
        player.removeMediaItems(targetIdx, player.mediaItemCount)
      }
    }
  }

  fun setRepeatOne(enabled: Boolean) {
    desiredRepeatOne = enabled
    serviceHandler.post {
      val player = exoPlayer ?: return@post
      if (stopAfterCurrentTrack) {
        player.repeatMode = Player.REPEAT_MODE_OFF
      } else {
        player.repeatMode = if (enabled) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
      }
      if (enabled) {
        val targetIdx = player.currentMediaItemIndex + 1
        if (player.mediaItemCount > targetIdx) {
          player.removeMediaItems(targetIdx, player.mediaItemCount)
        }
      }
    }
  }

  fun configureSleepTimer(mode: String, durationMs: Long) {
    serviceHandler.post {
      val player = exoPlayer ?: return@post
      cancelTimedSleepRunnables()
      player.volume = 1f
      when (mode) {
        "track" -> {
          stopAfterCurrentTrack = true
          player.repeatMode = Player.REPEAT_MODE_OFF
          val targetIdx = player.currentMediaItemIndex + 1
          if (player.mediaItemCount > targetIdx) {
            player.removeMediaItems(targetIdx, player.mediaItemCount)
          }
        }
        "timed" -> {
          stopAfterCurrentTrack = false
          player.repeatMode = if (desiredRepeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
          if (durationMs > 0L) {
            sleepEndElapsedMs = SystemClock.elapsedRealtime() + durationMs
            val fadeStartDelay = (durationMs - 3000L).coerceAtLeast(0L)
            val starter = Runnable { startFadeOutAndPause() }
            sleepFadeStartRunnable = starter
            serviceHandler.postDelayed(starter, fadeStartDelay)
          }
        }
        else -> {
          stopAfterCurrentTrack = false
          player.repeatMode = if (desiredRepeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        }
      }
    }
  }

  fun getSleepTimerRemainingMs(): Long {
    val end = sleepEndElapsedMs
    if (end <= 0L) return 0L
    return (end - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
  }

  override fun onCreate() {
    super.onCreate()
    instance = this

    val audioAttrs = AudioAttributes.Builder()
      .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
      .setUsage(C.USAGE_MEDIA)
      .build()

    val httpFactory = DefaultHttpDataSource.Factory()
      .setUserAgent("CPlayer-Native/1.0 (Android; Media3)")
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(20_000)

    val cacheFactory = CacheDataSource.Factory()
      .setCache(CPlayerMediaCache.getCache(this))
      .setUpstreamDataSourceFactory(httpFactory)
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

    val player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(cacheFactory))
      .setAudioAttributes(audioAttrs, true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    exoPlayer = player

    player.addListener(object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && mediaItem != null) {
          val curIdx = player.currentMediaItemIndex
          if (curIdx > 0) {
            player.removeMediaItems(0, curIdx)
          }
          onAutoTrackTransition?.invoke(mediaItem.mediaId)
        }
      }

      override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
          if (stopAfterCurrentTrack) {
            stopAfterCurrentTrack = false
            player.playWhenReady = false
            player.repeatMode = if (desiredRepeatOne) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            onSleepTimerFired?.invoke("track")
          } else {
            onNativeEnded?.invoke()
          }
        }
      }
    })

    val sessionPlayer = object : ForwardingPlayer(player) {
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
    val player = exoPlayer
    if (player == null || !player.playWhenReady || player.mediaItemCount == 0) {
      stopSelf()
    }
  }

  override fun onDestroy() {
    cancelTimedSleepRunnables()
    instance = null
    mediaSession?.run {
      exoPlayer?.release()
      exoPlayer = null
      release()
      mediaSession = null
    }
    super.onDestroy()
  }
}
`;

// 5. Patch MainActivity.kt (Edge-to-Edge + MediaController JS Bridge + Native HTTP Bridge + Back-to-Background)
const mainActivityKotlin = `package top.chksz.cplayer

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
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
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

class MainActivity : TauriActivity() {
  private class ActiveHttpCall {
    @Volatile
    var connection: HttpURLConnection? = null

    @Volatile
    var cancelled: Boolean = false

    @Volatile
    var future: Future<*>? = null
  }

  private var webViewRef: WebView? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var mediaController: MediaController? = null
  private var pendingAction: ((MediaController) -> Unit)? = null
  private val httpExecutor: ExecutorService = Executors.newCachedThreadPool()
  private val activeHttpCalls = ConcurrentHashMap<String, ActiveHttpCall>()

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

  private fun wakeAndEmitJs(script: String) {
    mainHandler.post {
      webViewRef?.let { wv ->
        wv.resumeTimers()
        wv.evaluateJavascript(script, null)
      }
    }
  }

  private fun jsStringLiteral(value: String): String {
    return JSONObject.quote(value)
      .replace("\\u2028", "\\\\u2028")
      .replace("\\u2029", "\\\\u2029")
  }

  private fun validateAndParseUrl(rawUrl: String): URL {
    val parsed = try {
      URL(rawUrl)
    } catch (e: Exception) {
      val detail = e.message ?: rawUrl
      throw IllegalArgumentException("无效请求地址: $detail")
    }
    val scheme = parsed.protocol.lowercase(Locale.ROOT)
    val host = parsed.host?.lowercase(Locale.ROOT)
    when (scheme) {
      "https" -> {
        if (host.isNullOrBlank()) {
          throw IllegalArgumentException("无效请求地址: 缺少主机名")
        }
      }
      "http" -> {
        if (host != "localhost" && host != "127.0.0.1") {
          throw IllegalArgumentException("不支持的协议: $scheme")
        }
      }
      else -> throw IllegalArgumentException("不支持的协议: $scheme")
    }
    return parsed
  }

  private fun effectivePort(url: URL): Int {
    if (url.port != -1) return url.port
    return if (url.protocol.equals("https", ignoreCase = true)) 443 else 80
  }

  private fun executeNativeHttp(
    reqId: String,
    call: ActiveHttpCall,
    rawUrl: String,
    method: String,
    headersJson: String,
    hasBody: Boolean,
    body: String,
    rejectRedirects: Boolean,
  ) {
    try {
      if (call.cancelled || Thread.currentThread().isInterrupted) return

      val currentHeaders = LinkedHashMap<String, String>()
      if (headersJson.isNotBlank()) {
        val obj = JSONObject(headersJson)
        val keys = obj.keys()
        while (keys.hasNext()) {
          val k = keys.next()
          if (!obj.isNull(k)) {
            currentHeaders[k] = obj.optString(k, "")
          }
        }
      }

      var currentUrl = validateAndParseUrl(rawUrl)
      var currentMethod = method.trim().uppercase(Locale.ROOT).ifEmpty { "GET" }
      var currentHasBody = hasBody
      var currentBody = body

      for (hop in 0..5) {
        if (call.cancelled || Thread.currentThread().isInterrupted) return

        val conn = currentUrl.openConnection() as HttpURLConnection
        call.connection = conn
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 25_000
        conn.readTimeout = 25_000
        conn.useCaches = false
        conn.doInput = true
        conn.requestMethod = currentMethod

        var hasUserAgent = false
        for ((k, v) in currentHeaders) {
          if (k.equals("user-agent", ignoreCase = true)) {
            hasUserAgent = true
          }
          conn.setRequestProperty(k, v)
        }
        if (!hasUserAgent) {
          conn.setRequestProperty("User-Agent", "CPlayer-Native/1.0 (Android; Tauri2)")
        }

        if (currentHasBody) {
          val bodyBytes = currentBody.toByteArray(Charsets.UTF_8)
          conn.doOutput = true
          conn.setFixedLengthStreamingMode(bodyBytes.size)
          conn.outputStream.use { out ->
            out.write(bodyBytes)
          }
        } else if (currentMethod == "POST" || currentMethod == "PUT" || currentMethod == "PATCH") {
          conn.doOutput = true
          conn.setFixedLengthStreamingMode(0)
          conn.outputStream.close()
        }

        val status = conn.responseCode
        if (status in 300..399) {
          if (rejectRedirects) {
            conn.disconnect()
            throw IllegalStateException("已拦截非预期的重定向响应")
          }
          val location = conn.getHeaderField("Location")?.trim()
          if (!location.isNullOrEmpty() && status in listOf(301, 302, 303, 307, 308)) {
            if (hop == 5) {
              conn.disconnect()
              throw IllegalStateException("重定向次数过多")
            }
            val nextUrl = validateAndParseUrl(URL(currentUrl, location).toString())
            val sameOrigin =
              currentUrl.protocol.equals(nextUrl.protocol, ignoreCase = true) &&
                currentUrl.host.equals(nextUrl.host, ignoreCase = true) &&
                effectivePort(currentUrl) == effectivePort(nextUrl)
            if (!sameOrigin) {
              val iter = currentHeaders.entries.iterator()
              while (iter.hasNext()) {
                val keyLower = iter.next().key.lowercase(Locale.ROOT)
                if (keyLower == "authorization" || keyLower == "cookie") {
                  iter.remove()
                }
              }
            }
            if (status == 303 || ((status == 301 || status == 302) && currentMethod == "POST")) {
              currentMethod = "GET"
              currentHasBody = false
              currentBody = ""
              val iter = currentHeaders.entries.iterator()
              while (iter.hasNext()) {
                val keyLower = iter.next().key.lowercase(Locale.ROOT)
                if (keyLower == "content-type" || keyLower == "content-length") {
                  iter.remove()
                }
              }
            }
            conn.disconnect()
            currentUrl = nextUrl
            continue
          }
        }

        val respHeaders = LinkedHashMap<String, String>()
        for ((rawKey, values) in conn.headerFields) {
          if (rawKey != null && values != null && values.isNotEmpty()) {
            respHeaders[rawKey.lowercase(Locale.ROOT)] = values.joinToString(", ")
          }
        }

        val rawStream: InputStream? = if (status >= 400) {
          conn.errorStream ?: try { conn.inputStream } catch (_: Exception) { null }
        } else {
          try { conn.inputStream } catch (_: Exception) { conn.errorStream }
        }

        val encoding = conn.contentEncoding?.lowercase(Locale.ROOT)?.trim()
        val bodyText = if (rawStream == null) {
          ""
        } else {
          val decodedStream: InputStream = when (encoding) {
            "gzip" -> {
              respHeaders.remove("content-encoding")
              respHeaders.remove("content-length")
              GZIPInputStream(BufferedInputStream(rawStream))
            }
            "deflate" -> {
              respHeaders.remove("content-encoding")
              respHeaders.remove("content-length")
              InflaterInputStream(BufferedInputStream(rawStream))
            }
            else -> BufferedInputStream(rawStream)
          }
          decodedStream.use { stream ->
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            while (true) {
              if (call.cancelled || Thread.currentThread().isInterrupted) {
                return
              }
              val read = stream.read(chunk)
              if (read == -1) break
              buffer.write(chunk, 0, read)
            }
            String(buffer.toByteArray(), Charsets.UTF_8)
          }
        }

        val headersObj = JSONObject()
        for ((k, v) in respHeaders) {
          headersObj.put(k, v)
        }
        val payloadJson = JSONObject().apply {
          put("status", status)
          put("headers", headersObj)
          put("body", bodyText)
        }.toString()

        if (!call.cancelled) {
          val idLit = jsStringLiteral(reqId)
          val payloadLit = jsStringLiteral(payloadJson)
          emitJs("window.__cplayerNativeHttp?.onResolve?.($idLit, $payloadLit)")
        }
        return
      }
    } catch (e: Exception) {
      if (!call.cancelled && !Thread.currentThread().isInterrupted) {
        val errMsg = when (e) {
          is IllegalArgumentException, is IllegalStateException -> e.message ?: "网络请求失败"
          else -> {
            val detail = e.localizedMessage ?: e.message ?: e.javaClass.simpleName
            "网络请求失败: $detail"
          }
        }
        val idLit = jsStringLiteral(reqId)
        val msgLit = jsStringLiteral(errMsg)
        emitJs("window.__cplayerNativeHttp?.onReject?.($idLit, $msgLit)")
      }
    } finally {
      try {
        call.connection?.disconnect()
      } catch (_: Exception) {
      }
      activeHttpCalls.remove(reqId, call)
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

  inner class NativeHttpBridge {
    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun request(
      reqId: String,
      url: String,
      method: String,
      headersJson: String,
      hasBody: Boolean,
      body: String,
      rejectRedirects: Boolean,
    ) {
      val call = ActiveHttpCall()
      activeHttpCalls[reqId] = call
      call.future = httpExecutor.submit {
        executeNativeHttp(reqId, call, url, method, headersJson, hasBody, body, rejectRedirects)
      }
    }

    @JavascriptInterface
    fun abort(reqId: String) {
      val call = activeHttpCalls.remove(reqId) ?: return
      call.cancelled = true
      call.future?.cancel(true)
      val conn = call.connection
      if (conn != null) {
        try {
          httpExecutor.execute {
            try {
              conn.disconnect()
            } catch (_: Exception) {
            }
          }
        } catch (_: Exception) {
          try {
            conn.disconnect()
          } catch (_: Exception) {
          }
        }
      }
    }
  }

  private fun buildMediaItem(
    trackId: String,
    url: String,
    title: String,
    artist: String,
    album: String,
    coverUrl: String,
    cacheKey: String,
  ): MediaItem {
    val metaBuilder = MediaMetadata.Builder()
      .setTitle(title)
      .setArtist(artist)
      .setAlbumTitle(album)
    if (coverUrl.isNotBlank()) {
      metaBuilder.setArtworkUri(Uri.parse(coverUrl))
    }
    val builder = MediaItem.Builder()
      .setMediaId(trackId)
      .setUri(url)
      .setMediaMetadata(metaBuilder.build())
    if (cacheKey.isNotBlank()) {
      builder.setCustomCacheKey(cacheKey)
    }
    return builder.build()
  }

  inner class NativeMediaBridge {
    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun loadAndPlay(
      trackId: String,
      url: String,
      title: String,
      artist: String,
      album: String,
      coverUrl: String,
      startMs: Long,
      cacheKey: String,
    ) {
      val item = buildMediaItem(trackId, url, title, artist, album, coverUrl, cacheKey)
      withController { ctrl ->
        ctrl.setMediaItem(item, startMs.coerceAtLeast(0L))
        ctrl.prepare()
        ctrl.play()
      }
    }

    @JavascriptInterface
    fun setNextMediaItem(
      trackId: String,
      url: String,
      title: String,
      artist: String,
      album: String,
      coverUrl: String,
      cacheKey: String,
    ) {
      val item = buildMediaItem(trackId, url, title, artist, album, coverUrl, cacheKey)
      val svc = CPlayerPlaybackService.instance
      if (svc != null) {
        svc.setNextItem(item)
      } else {
        withController { ctrl ->
          if (ctrl.mediaItemCount > 0) {
            val nextIdx = ctrl.currentMediaItemIndex + 1
            if (ctrl.mediaItemCount > nextIdx) {
              ctrl.removeMediaItems(nextIdx, ctrl.mediaItemCount)
            }
            ctrl.addMediaItem(item)
          }
        }
      }
    }

    @JavascriptInterface
    fun clearNextMediaItem() {
      val svc = CPlayerPlaybackService.instance
      if (svc != null) {
        svc.clearNextItem()
      } else {
        withController { ctrl ->
          val nextIdx = ctrl.currentMediaItemIndex + 1
          if (ctrl.mediaItemCount > nextIdx) {
            ctrl.removeMediaItems(nextIdx, ctrl.mediaItemCount)
          }
        }
      }
    }

    @JavascriptInterface
    fun setRepeatOne(enabled: Boolean) {
      val svc = CPlayerPlaybackService.instance
      if (svc != null) {
        svc.setRepeatOne(enabled)
      } else {
        withController { ctrl ->
          ctrl.repeatMode = if (enabled) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        }
      }
    }

    @JavascriptInterface
    fun setSleepTimer(mode: String, durationMs: Long) {
      CPlayerPlaybackService.instance?.configureSleepTimer(mode, durationMs)
    }

    @JavascriptInterface
    fun getSleepTimerRemainingMs(): Long {
      return CPlayerPlaybackService.instance?.getSleepTimerRemainingMs() ?: 0L
    }

    @JavascriptInterface
    fun getAudioCacheBytes(): Long {
      return CPlayerMediaCache.getCacheSizeBytes(applicationContext)
    }

    @JavascriptInterface
    fun clearAudioCache(): Boolean {
      return CPlayerMediaCache.clearCache(applicationContext)
    }

    @JavascriptInterface
    fun isMeteredNetwork(): Boolean {
      return try {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        cm.isActiveNetworkMetered
      } catch (_: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun openExternalUrl(url: String): Boolean {
      return try {
        val parsed = Uri.parse(url)
        if (!parsed.scheme.equals("https", ignoreCase = true)) return false
        val intent = Intent(Intent.ACTION_VIEW, parsed).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
        true
      } catch (_: Exception) {
        false
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
            }

            override fun onPlayerError(error: PlaybackException) {
              val msg = jsStringLiteral(error.localizedMessage ?: "音频播放失败")
              wakeAndEmitJs("window.__cplayerNativeBridge?.onError?.($msg)")
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
      val quoted = jsStringLiteral(action)
      wakeAndEmitJs("window.__cplayerNativeBridge?.onRemoteCommand?.($quoted)")
    }

    CPlayerPlaybackService.onAutoTrackTransition = { mediaId ->
      val quoted = jsStringLiteral(mediaId)
      wakeAndEmitJs("window.__cplayerNativeBridge?.onTrackTransition?.($quoted)")
    }

    CPlayerPlaybackService.onNativeEnded = {
      wakeAndEmitJs("window.__cplayerNativeBridge?.onEnded?.()")
    }

    CPlayerPlaybackService.onSleepTimerFired = { mode ->
      val quoted = jsStringLiteral(mode)
      wakeAndEmitJs("window.__cplayerNativeBridge?.onSleepTimerFired?.($quoted)")
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
    webView.addJavascriptInterface(NativeHttpBridge(), "CPlayerNativeHttp")
  }

  override fun onDestroy() {
    mainHandler.removeCallbacks(progressTicker)
    CPlayerPlaybackService.onRemoteSkip = null
    CPlayerPlaybackService.onAutoTrackTransition = null
    CPlayerPlaybackService.onNativeEnded = null
    CPlayerPlaybackService.onSleepTimerFired = null
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    mediaController = null
    for (call in activeHttpCalls.values) {
      call.cancelled = true
      call.future?.cancel(true)
      try {
        call.connection?.disconnect()
      } catch (_: Exception) {
      }
    }
    activeHttpCalls.clear()
    httpExecutor.shutdownNow()
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
