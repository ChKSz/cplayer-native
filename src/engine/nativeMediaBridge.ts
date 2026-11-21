export interface CPlayerNativeMediaApi {
  isAvailable(): boolean;
  loadAndPlay(
    trackId: string,
    url: string,
    title: string,
    artist: string,
    album: string,
    coverUrl: string,
    startMs: number,
    cacheKey: string,
  ): void;
  setNextMediaItem?: (
    trackId: string,
    url: string,
    title: string,
    artist: string,
    album: string,
    coverUrl: string,
    cacheKey: string,
  ) => void;
  clearNextMediaItem?: () => void;
  setRepeatOne?: (enabled: boolean) => void;
  setSleepTimer?: (mode: string, durationMs: number) => void;
  getSleepTimerRemainingMs?: () => number;
  getAudioCacheBytes?: () => number;
  clearAudioCache?: () => boolean;
  isMeteredNetwork?: () => boolean;
  openExternalUrl?: (url: string) => boolean;
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  stop(): void;
}

export interface NativeMediaCallbacks {
  onState: (playing: boolean, buffering: boolean, positionMs: number, durationMs: number) => void;
  onEnded: () => void;
  onError: (message: string) => void;
  onRemoteCommand: (action: 'prev' | 'next') => void;
  onTrackTransition?: (mediaId: string) => void;
  onSleepTimerFired?: (mode: 'timed' | 'track') => void;
}

declare global {
  interface Window {
    CPlayerNativeMedia?: CPlayerNativeMediaApi;
    __cplayerNativeBridge?: NativeMediaCallbacks;
  }
}

export function getNativeMediaApi(): CPlayerNativeMediaApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.CPlayerNativeMedia;
  try {
    if (api && typeof api.isAvailable === 'function' && api.isAvailable()) {
      return api;
    }
  } catch {
    return null;
  }
  return null;
}

export function registerNativeMediaBridge(callbacks: NativeMediaCallbacks): () => void {
  if (typeof window === 'undefined') return () => {};
  window.__cplayerNativeBridge = callbacks;
  return () => {
    if (window.__cplayerNativeBridge === callbacks) {
      delete window.__cplayerNativeBridge;
    }
  };
}
