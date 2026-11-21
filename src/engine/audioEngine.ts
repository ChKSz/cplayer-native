import { MediaRecovery, type AudioTargetLike } from '../services/mediaRecovery';
import { buildAudioCacheKey } from '../services/preloadCache';
import type { SongPlaybackData } from '../types/music';
import {
  getNativeMediaApi,
  registerNativeMediaBridge,
  type CPlayerNativeMediaApi,
} from './nativeMediaBridge';

export interface AudioEngineCallbacks {
  onTimeUpdate: (currentTime: number, duration: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onEnded: () => void;
  onBufferingChange: (buffering: boolean) => void;
  onError: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  resolveExpiredSong: (id: string | number) => Promise<SongPlaybackData>;
  onNativeTrackTransition?: (trackId: string) => void;
  onNativeSleepTimerFired?: (mode: 'timed' | 'track') => void;
}

class NativeAudioProxy extends EventTarget implements AudioTargetLike {
  public currentTime = 0;
  public error: MediaError | null = null;
}

/**
 * Dual-backend audio controller:
 * - On Android APK (with Media3 ExoPlayer + 500MB SimpleCache + MediaSessionService):
 *   delegates playback, preloaded next-item queue, and lock-screen sleep timer to
 *   `window.CPlayerNativeMedia` so playback never stalls when the screen locks.
 * - On Web/Desktop preview: uses HTML5 `<audio>` + Web MediaSession API.
 * Strictly keeps audio stream requests credential-free.
 */
export class AudioEngine {
  private nativeApi: CPlayerNativeMediaApi | null;
  private audio: HTMLAudioElement | null = null;
  private unregisterBridge: (() => void) | null = null;

  private recovery: MediaRecovery<SongPlaybackData>;
  private currentData: SongPlaybackData | null = null;
  private callbacks: AudioEngineCallbacks;

  // Native interpolation state for smooth 60fps verbatim lyrics
  private nativePlaying = false;
  private nativeBasePosSec = 0;
  private nativeSyncedAtPerf = 0;
  private nativeDurationSec = 0;

  constructor(callbacks: AudioEngineCallbacks) {
    this.callbacks = callbacks;
    this.nativeApi = getNativeMediaApi();

    if (this.nativeApi) {
      const proxy = new NativeAudioProxy();

      this.recovery = new MediaRecovery<SongPlaybackData>(proxy, {
        snapshot: () => this.currentData,
        resolve: (id) => this.callbacks.resolveExpiredSong(id),
        current: (snap) => this.currentData !== null && String(this.currentData.id) === String(snap.id),
        restore: async (fresh, time, wasPlaying) => {
          this.currentData = fresh;
          const cacheKey = buildAudioCacheKey(fresh.id, fresh.requestedLevel || fresh.source);
          this.nativeApi?.loadAndPlay(
            String(fresh.id),
            fresh.url,
            fresh.name || '未知歌曲',
            fresh.artist || '未知歌手',
            fresh.album || 'CPlayer',
            fresh.cover || '',
            Math.max(0, Math.round(time * 1000)),
            cacheKey,
          );
          if (!wasPlaying) {
            this.nativeApi?.pause();
          }
        },
        failure: (err) => {
          const msg = err instanceof Error ? err.message : '音频链接已失效，请重试';
          this.callbacks.onError(msg);
        },
      });

      this.unregisterBridge = registerNativeMediaBridge({
        onState: (playing, buffering, positionMs, durationMs) => {
          const posSec = Math.max(0, positionMs / 1000);
          const durSec = Math.max(0, durationMs / 1000);
          this.nativePlaying = playing;
          this.nativeBasePosSec = posSec;
          this.nativeSyncedAtPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
          this.nativeDurationSec = durSec;

          proxy.currentTime = posSec;
          proxy.error = null;
          proxy.dispatchEvent(new Event('timeupdate'));
          proxy.dispatchEvent(new Event(playing ? 'play' : 'pause'));

          this.callbacks.onBufferingChange(buffering);
          this.callbacks.onPlayStateChange(playing);
          this.callbacks.onTimeUpdate(posSec, durSec);
        },
        onEnded: () => {
          this.nativePlaying = false;
          this.callbacks.onEnded();
        },
        onError: (message) => {
          this.nativePlaying = false;
          this.callbacks.onBufferingChange(false);
          const data = this.currentData;
          if (data?.streamExpiresAt && data.streamExpiresAt <= Date.now()) {
            proxy.error = { code: 2, message } as MediaError;
            proxy.dispatchEvent(new Event('error'));
            return;
          }
          this.callbacks.onError(message || '音频加载失败');
        },
        onRemoteCommand: (action) => {
          if (action === 'prev') this.callbacks.onPrev();
          if (action === 'next') this.callbacks.onNext();
        },
        onTrackTransition: (mediaId) => {
          this.callbacks.onNativeTrackTransition?.(mediaId);
        },
        onSleepTimerFired: (mode) => {
          this.nativePlaying = false;
          this.callbacks.onNativeSleepTimerFired?.(mode);
        },
      });
      return;
    }

    // Browser / Desktop HTML5 <audio> fallback
    const audio = new Audio();
    audio.preload = 'metadata';
    this.audio = audio;

    this.recovery = new MediaRecovery<SongPlaybackData>(audio, {
      snapshot: () => this.currentData,
      resolve: (id) => this.callbacks.resolveExpiredSong(id),
      current: (snap) => this.currentData !== null && String(this.currentData.id) === String(snap.id),
      restore: async (fresh, time, wasPlaying) => {
        this.currentData = fresh;
        audio.src = fresh.url;
        audio.load();
        await this.seekWhenReady(time);
        if (wasPlaying) {
          await audio.play();
        }
      },
      failure: (err) => {
        const msg = err instanceof Error ? err.message : '音频链接已失效，请重试';
        this.callbacks.onError(msg);
      },
    });

    this.bindHtmlEvents(audio);
    this.setupMediaSession();
  }

  private bindHtmlEvents(audio: HTMLAudioElement): void {
    audio.addEventListener('timeupdate', () => {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.callbacks.onTimeUpdate(audio.currentTime || 0, dur);
      this.updatePositionState(audio.currentTime || 0, dur);
    });

    audio.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
      this.callbacks.onTimeUpdate(audio.currentTime || 0, dur);
    });

    audio.addEventListener('waiting', () => this.callbacks.onBufferingChange(true));
    audio.addEventListener('canplay', () => this.callbacks.onBufferingChange(false));
    audio.addEventListener('playing', () => {
      this.callbacks.onBufferingChange(false);
      this.callbacks.onPlayStateChange(true);
      this.setMediaSessionState('playing');
    });

    audio.addEventListener('pause', () => {
      this.callbacks.onPlayStateChange(false);
      this.setMediaSessionState('paused');
    });

    audio.addEventListener('ended', () => {
      this.callbacks.onEnded();
    });

    audio.addEventListener('error', () => {
      this.callbacks.onBufferingChange(false);
      const data = this.currentData;
      if (data?.streamExpiresAt && data.streamExpiresAt <= Date.now()) {
        return;
      }
      if (audio.src) {
        this.callbacks.onError('音频加载失败，可能该音源受限或网络异常');
      }
    });
  }

  private setupMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const bind = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Action unsupported on platform
      }
    };
    bind('play', () => { void this.play(); });
    bind('pause', () => this.pause());
    bind('previoustrack', () => this.callbacks.onPrev());
    bind('nexttrack', () => this.callbacks.onNext());
    bind('seekto', (details) => {
      if (typeof details.seekTime === 'number') this.seek(details.seekTime);
    });
  }

  private setMediaSessionState(state: MediaSessionPlaybackState): void {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state;
    }
  }

  private updatePositionState(position: number, duration: number): void {
    if (
      typeof navigator !== 'undefined' &&
      'mediaSession' in navigator &&
      typeof navigator.mediaSession.setPositionState === 'function' &&
      duration > 0 &&
      Number.isFinite(duration)
    ) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: this.audio?.playbackRate || 1,
          position: Math.min(position, duration),
        });
      } catch {
        // Ignore invalid state
      }
    }
  }

  public updateMetadata(data: { name: string; artist: string; album?: string; cover?: string }): void {
    if (this.nativeApi) return;
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
      return;
    }
    const artwork: MediaImage[] = data.cover
      ? [{ src: data.cover, sizes: '512x512', type: 'image/jpeg' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: data.name || '未知歌曲',
      artist: data.artist || '未知歌手',
      album: data.album || 'CPlayer',
      artwork,
    });
  }

  private seekWhenReady(time: number): Promise<void> {
    const audio = this.audio;
    if (!audio || !Number.isFinite(time) || time <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        try {
          audio.currentTime = time;
        } catch {
          // Ignore seek range error
        }
        resolve();
      };
      if (audio.readyState >= 1) {
        done();
      } else {
        audio.addEventListener('loadedmetadata', done, { once: true });
      }
    });
  }

  public async loadAndPlay(data: SongPlaybackData, startTime = 0, cacheKey?: string): Promise<void> {
    this.recovery.reset();
    this.currentData = data;
    this.callbacks.onBufferingChange(true);
    this.updateMetadata(data);

    if (this.nativeApi) {
      const resolvedKey = cacheKey || buildAudioCacheKey(data.id, data.requestedLevel || data.source);
      this.nativeBasePosSec = Math.max(0, startTime);
      this.nativeSyncedAtPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.nativePlaying = false;
      this.nativeApi.loadAndPlay(
        String(data.id),
        data.url,
        data.name || '未知歌曲',
        data.artist || '未知歌手',
        data.album || 'CPlayer',
        data.cover || '',
        Math.max(0, Math.round(startTime * 1000)),
        resolvedKey,
      );
      return;
    }

    const audio = this.audio;
    if (!audio) return;
    audio.volume = 1;
    audio.src = data.url;
    audio.load();
    if (startTime > 0) {
      await this.seekWhenReady(startTime);
    }
    try {
      await audio.play();
    } catch (err) {
      this.callbacks.onBufferingChange(false);
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
  }

  /**
   * Synchronizes JS state when ExoPlayer automatically advances to a preloaded item
   * in the background without restarting playback.
   */
  public syncTransitionedTrack(data: SongPlaybackData): void {
    this.recovery.reset();
    this.currentData = data;
    this.nativeBasePosSec = 0;
    this.nativeSyncedAtPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.nativeDurationSec = 0;
    this.updateMetadata(data);
  }

  public setNextPreloadedTrack(data: SongPlaybackData, cacheKey?: string): void {
    if (!this.nativeApi?.setNextMediaItem) return;
    const resolvedKey = cacheKey || buildAudioCacheKey(data.id, data.requestedLevel || data.source);
    try {
      this.nativeApi.setNextMediaItem(
        String(data.id),
        data.url,
        data.name || '未知歌曲',
        data.artist || '未知歌手',
        data.album || 'CPlayer',
        data.cover || '',
        resolvedKey,
      );
    } catch {
      // Ignore bridge errors
    }
  }

  public clearNextPreloadedTrack(): void {
    try {
      this.nativeApi?.clearNextMediaItem?.();
    } catch {
      // Ignore bridge errors
    }
  }

  public setRepeatOne(enabled: boolean): void {
    try {
      this.nativeApi?.setRepeatOne?.(enabled);
    } catch {
      // Ignore bridge errors
    }
  }

  public setNativeSleepTimer(mode: 'off' | 'timed' | 'track', durationMs: number): boolean {
    if (!this.nativeApi?.setSleepTimer) return false;
    try {
      this.nativeApi.setSleepTimer(mode, Math.max(0, Math.round(durationMs)));
      return true;
    } catch {
      return false;
    }
  }

  public getNativeSleepTimerRemainingMs(): number {
    try {
      return this.nativeApi?.getSleepTimerRemainingMs?.() ?? 0;
    } catch {
      return 0;
    }
  }

  public getAudioCacheBytes(): number {
    try {
      return this.nativeApi?.getAudioCacheBytes?.() ?? 0;
    } catch {
      return 0;
    }
  }

  public clearAudioCache(): boolean {
    try {
      return Boolean(this.nativeApi?.clearAudioCache?.());
    } catch {
      return false;
    }
  }

  public isMeteredNetwork(): boolean {
    if (this.nativeApi?.isMeteredNetwork) {
      try {
        return Boolean(this.nativeApi.isMeteredNetwork());
      } catch {
        return false;
      }
    }
    if (typeof navigator !== 'undefined') {
      const nav = navigator as Navigator & {
        connection?: { type?: string; saveData?: boolean };
      };
      if (nav.connection) {
        return nav.connection.type === 'cellular' || Boolean(nav.connection.saveData);
      }
    }
    return false;
  }

  public openExternalUrl(url: string): boolean {
    if (this.nativeApi?.openExternalUrl) {
      try {
        if (this.nativeApi.openExternalUrl(url)) return true;
      } catch {
        // Fallback below
      }
    }
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
    return false;
  }

  public setVolume(volume: number): void {
    if (this.audio) {
      this.audio.volume = Math.max(0, Math.min(1, volume));
    }
  }

  public async play(): Promise<void> {
    if (this.nativeApi) {
      this.nativeApi.play();
      return;
    }
    if (!this.audio || !this.audio.src) return;
    this.audio.volume = 1;
    await this.audio.play();
  }

  public pause(): void {
    if (this.nativeApi) {
      this.nativePlaying = false;
      this.nativeApi.pause();
      return;
    }
    this.audio?.pause();
  }

  public getPreciseCurrentTime(): number {
    if (this.nativeApi) {
      if (!this.nativePlaying) return this.nativeBasePosSec;
      const nowPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = Math.max(0, (nowPerf - this.nativeSyncedAtPerf) / 1000);
      const interpolated = this.nativeBasePosSec + elapsed;
      return this.nativeDurationSec > 0
        ? Math.min(this.nativeDurationSec, interpolated)
        : interpolated;
    }
    return this.audio && Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  public seek(time: number): void {
    if (!Number.isFinite(time)) return;
    if (this.nativeApi) {
      const clamped =
        this.nativeDurationSec > 0
          ? Math.max(0, Math.min(this.nativeDurationSec, time))
          : Math.max(0, time);
      this.nativeBasePosSec = clamped;
      this.nativeSyncedAtPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
      this.nativeApi.seekTo(Math.round(clamped * 1000));
      this.callbacks.onTimeUpdate(clamped, this.nativeDurationSec);
      return;
    }

    const audio = this.audio;
    if (!audio) return;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(dur, time)) : Math.max(0, time);
    try {
      audio.currentTime = clamped;
    } catch {
      // Ignore if not loaded yet
    }
    this.callbacks.onTimeUpdate(clamped, dur);
  }

  public stop(): void {
    this.recovery.reset();
    this.currentData = null;
    if (this.nativeApi) {
      this.nativePlaying = false;
      this.nativeBasePosSec = 0;
      this.nativeDurationSec = 0;
      this.nativeApi.stop();
      return;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  public dispose(): void {
    this.recovery.dispose();
    this.unregisterBridge?.();
    this.stop();
  }
}
