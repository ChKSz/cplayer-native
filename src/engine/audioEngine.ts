import { MediaRecovery } from '../services/mediaRecovery';
import type { SongPlaybackData } from '../types/music';

export interface AudioEngineCallbacks {
  onTimeUpdate: (currentTime: number, duration: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onEnded: () => void;
  onBufferingChange: (buffering: boolean) => void;
  onError: (message: string) => void;
  onPrev: () => void;
  onNext: () => void;
  resolveExpiredSong: (id: string | number) => Promise<SongPlaybackData>;
}

/**
 * Audio playback controller wrapping HTMLAudioElement + MediaRecovery + MediaSession API.
 * Strictly keeps audio stream requests credential-free (never sends Authorization headers to CDNs).
 */
export class AudioEngine {
  private audio: HTMLAudioElement;
  private recovery: MediaRecovery<SongPlaybackData>;
  private currentData: SongPlaybackData | null = null;
  private callbacks: AudioEngineCallbacks;

  constructor(callbacks: AudioEngineCallbacks) {
    this.callbacks = callbacks;
    this.audio = new Audio();
    // Do NOT force crossOrigin='anonymous' on audio CDNs that lack CORS headers
    this.audio.preload = 'metadata';

    this.recovery = new MediaRecovery<SongPlaybackData>(this.audio, {
      snapshot: () => this.currentData,
      resolve: (id) => this.callbacks.resolveExpiredSong(id),
      current: (snap) => this.currentData !== null && String(this.currentData.id) === String(snap.id),
      restore: async (fresh, time, wasPlaying) => {
        this.currentData = fresh;
        this.audio.src = fresh.url;
        this.audio.load();
        await this.seekWhenReady(time);
        if (wasPlaying) {
          await this.audio.play();
        }
      },
      failure: (err) => {
        const msg = err instanceof Error ? err.message : '音频链接已失效，请重试';
        this.callbacks.onError(msg);
      },
    });

    this.bindEvents();
    this.setupMediaSession();
  }

  private bindEvents(): void {
    this.audio.addEventListener('timeupdate', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
      this.callbacks.onTimeUpdate(this.audio.currentTime || 0, dur);
      this.updatePositionState(this.audio.currentTime || 0, dur);
    });

    this.audio.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
      this.callbacks.onTimeUpdate(this.audio.currentTime || 0, dur);
    });

    this.audio.addEventListener('waiting', () => this.callbacks.onBufferingChange(true));
    this.audio.addEventListener('canplay', () => this.callbacks.onBufferingChange(false));
    this.audio.addEventListener('playing', () => {
      this.callbacks.onBufferingChange(false);
      this.callbacks.onPlayStateChange(true);
      this.setMediaSessionState('playing');
    });

    this.audio.addEventListener('pause', () => {
      this.callbacks.onPlayStateChange(false);
      this.setMediaSessionState('paused');
    });

    this.audio.addEventListener('ended', () => {
      this.callbacks.onEnded();
    });

    this.audio.addEventListener('error', () => {
      this.callbacks.onBufferingChange(false);
      // If MediaRecovery handles an expired stream URL, avoid surfacing duplicate error
      const data = this.currentData;
      if (data?.streamExpiresAt && data.streamExpiresAt <= Date.now()) {
        return;
      }
      if (this.audio.src) {
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
          playbackRate: this.audio.playbackRate || 1,
          position: Math.min(position, duration),
        });
      } catch {
        // Ignore invalid state
      }
    }
  }

  public updateMetadata(data: { name: string; artist: string; album?: string; cover?: string }): void {
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
    if (!Number.isFinite(time) || time <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        try {
          this.audio.currentTime = time;
        } catch {
          // Ignore seek range error
        }
        resolve();
      };
      if (this.audio.readyState >= 1) {
        done();
      } else {
        this.audio.addEventListener('loadedmetadata', done, { once: true });
      }
    });
  }

  public async loadAndPlay(data: SongPlaybackData, startTime = 0): Promise<void> {
    this.recovery.reset();
    this.currentData = data;
    this.callbacks.onBufferingChange(true);
    this.updateMetadata(data);

    this.audio.src = data.url;
    this.audio.load();
    if (startTime > 0) {
      await this.seekWhenReady(startTime);
    }
    try {
      await this.audio.play();
    } catch (err) {
      this.callbacks.onBufferingChange(false);
      // Autoplay blocked or aborted by newer track switch
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
  }

  public async play(): Promise<void> {
    if (!this.audio.src) return;
    await this.audio.play();
  }

  public pause(): void {
    this.audio.pause();
  }

  public seek(time: number): void {
    if (!Number.isFinite(time)) return;
    const dur = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    const clamped = dur > 0 ? Math.max(0, Math.min(dur, time)) : Math.max(0, time);
    try {
      this.audio.currentTime = clamped;
    } catch {
      // Ignore if not loaded yet
    }
    this.callbacks.onTimeUpdate(clamped, dur);
  }

  public stop(): void {
    this.recovery.reset();
    this.currentData = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  public dispose(): void {
    this.recovery.dispose();
    this.stop();
  }
}
