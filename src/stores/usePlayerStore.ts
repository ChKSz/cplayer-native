import { create } from 'zustand';
import { AudioEngine } from '../engine/audioEngine';
import { CPSync } from '../services/cpSync';
import { MusicService } from '../services/musicApi';
import { PlayerAuth } from '../services/playerAuth';
import { parseLyrics } from '../services/lyrics';
import {
  getAdjacentIndices,
  restoreOriginalOrder,
  shuffleQueueKeepingCurrent,
} from '../services/queueOrder';
import {
  clearDbCaches,
  getCachedLyric,
  getCachedPlaylist,
  getDbCacheStats,
  setCachedLyric,
  setCachedPlaylist,
} from '../services/cacheDb';
import {
  DEFAULT_FLUID_PALETTE,
  extractFluidPalette,
  type FluidPalette,
} from '../services/colorExtractor';
import {
  buildAudioCacheKey,
  PreloadCache,
  resolveEffectiveQuality,
} from '../services/preloadCache';
import {
  clearSearchHistory,
  loadSearchHistory,
  pushSearchHistory,
  removeSearchHistoryItem,
} from '../services/searchHistory';
import {
  songSourceOf,
  type AuthUser,
  type LyricLine,
  type MusicSource,
  type PlayMode,
  type PlaylistDetail,
  type PlaylistSummary,
  type QualityLevel,
  type SongPlaybackData,
  type SyncStatusType,
  type Track,
} from '../types/music';

export type ActiveSheetType =
  | null
  | 'queue'
  | 'quality'
  | 'account'
  | 'settings'
  | 'importNetease'
  | 'createPlaylist'
  | 'playlistManage'
  | 'trackAction'
  | 'addToPlaylist';

export type LyricFontSize = 'sm' | 'md' | 'lg';
export type SleepTimerMode = 'off' | '15' | '30' | '60' | 'track';

export type PreferenceKey =
  | 'showVerbatim'
  | 'showTranslation'
  | 'showRomaji'
  | 'fluidMotion'
  | 'fluidPowerSave'
  | 'mobileQualityLimit'
  | 'preloadNextEnabled'
  | 'autoSkipFailed';

const PREF_STORAGE_KEYS: Record<PreferenceKey, string> = {
  showVerbatim: 'cp_lyric_yrc',
  showTranslation: 'cp_lyric_trans',
  showRomaji: 'cp_lyric_roma',
  fluidMotion: 'cp_fluid_motion',
  fluidPowerSave: 'cp_fluid_power_save',
  mobileQualityLimit: 'cp_mobile_quality_limit',
  preloadNextEnabled: 'cp_preload_next',
  autoSkipFailed: 'cp_auto_skip_failed',
};

const LYRIC_SIZE_KEY = 'cp_lyric_font_size';
const FAVORITE_PLAYLIST_NAME = '我喜欢的音乐';

function safeStorageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore storage error
  }
}

function readBoolPref(key: PreferenceKey, fallback = true): boolean {
  const val = safeStorageGet(PREF_STORAGE_KEYS[key]);
  if (val === null) return fallback;
  return val !== '0' && val !== 'false';
}

function readLyricFontSize(): LyricFontSize {
  const val = safeStorageGet(LYRIC_SIZE_KEY);
  return val === 'sm' || val === 'lg' ? val : 'md';
}

const playerAuth = new PlayerAuth();
export const cpSync = new CPSync();
export const musicService = new MusicService(playerAuth);
const preloadCache = new PreloadCache();

let audioEngine: AudioEngine | null = null;
let sleepTimeoutId: ReturnType<typeof setTimeout> | null = null;
let sleepFadeIntervalId: ReturnType<typeof setInterval> | null = null;
let preloadTimerId: ReturnType<typeof setTimeout> | null = null;
let autoSkipTimerId: ReturnType<typeof setTimeout> | null = null;
let songRequestSeq = 0;
let lastPreloadRefreshSeq = -1;
let consecutiveAutoSkipErrors = 0;
let activeSongAbort: AbortController | null = null;
let searchAbort: AbortController | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function makeFallbackArt(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue1 = Math.abs(h) % 360;
  const hue2 = (hue1 + 48) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue1},45%,34%)"/>
        <stop offset="100%" stop-color="hsl(${hue2},42%,16%)"/>
      </linearGradient>
    </defs>
    <rect width="320" height="320" fill="url(#g)"/>
    <circle cx="160" cy="160" r="88" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>
    <circle cx="160" cy="160" r="24" fill="rgba(255,255,255,0.12)"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function trackCoverOrFallback(track: Track | null | undefined): string {
  if (!track) return makeFallbackArt('cplayer');
  return track.cover || makeFallbackArt(`${track.id}-${track.name}`);
}

function computeQualityBadge(songData: SongPlaybackData): string | null {
  return (
    songData.qualityText ||
    (songData.level
      ? ({
          standard: '标准 128K',
          higher: '较高 192K',
          exhigh: '极高 320K',
          lossless: '无损 FLAC',
          hires: 'Hi-Res',
          jyeffect: '高清臻音',
          sky: '沉浸环绕声',
          jymaster: '超清母带',
        }[songData.level] ?? songData.level)
      : null)
  );
}

function extractNeteasePlaylistId(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4,}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/[?&]id=(\d+)/) || trimmed.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

export interface PlayerStoreState {
  // Navigation & Sheets
  activeTab: number; // 0: Player, 1: Playlist, 2: Search
  showLyrics: boolean;
  activeSheet: ActiveSheetType;
  sheetTrackTarget: Track | null;

  // Toast
  toastMessage: string | null;

  // Auth & Cloud Sync
  user: AuthUser | null;
  syncStatus: SyncStatusType;
  cloudPlaylists: PlaylistSummary[];
  activePlaylistKey: string; // 'cloud:<id>' | 'netease:<id>' | 'queue'
  activePlaylistName: string;
  activePlaylistTracks: Track[];
  activeCloudPlaylistId: string | null;
  activeNeteasePlaylistId: string | null;
  loadingPlaylist: boolean;
  favoritePlaylistId: string | null;
  favoriteTrackIds: string[];
  savedCloudTrackIds: string[];
  cloudTrackPlaylistMap: Record<string, string[]>;

  // Playback
  queue: Track[];
  originalQueue: Track[];
  currentIndex: number;
  currentTrack: Track | null;
  currentSongData: SongPlaybackData | null;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  playMode: PlayMode;
  quality: QualityLevel;
  actualQualityText: string | null;
  lyrics: LyricLine[];
  fluidPalette: FluidPalette;
  isMeteredNetwork: boolean;
  failedTrackOffer: Track | null;

  // Preferences & Sleep Timer
  showVerbatim: boolean;
  showTranslation: boolean;
  showRomaji: boolean;
  fluidMotion: boolean;
  fluidPowerSave: boolean;
  mobileQualityLimit: boolean;
  preloadNextEnabled: boolean;
  autoSkipFailed: boolean;
  lyricFontSize: LyricFontSize;
  sleepTimerMode: SleepTimerMode;
  sleepTimerEndsAt: number | null;

  // Search
  searchSource: MusicSource;
  searchQuery: string;
  searchResults: Track[];
  searching: boolean;
  searchError: string | null;
  searchHistory: string[];

  // Actions
  init: () => Promise<void>;
  setActiveTab: (tab: number) => void;
  setShowLyrics: (show: boolean) => void;
  openSheet: (type: ActiveSheetType, track?: Track | null) => void;
  closeSheet: () => void;
  showToast: (msg: string) => void;
  dismissFailedOffer: () => void;

  // Auth / Sync / Preferences
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshCloudPlaylists: () => Promise<void>;
  updateEndpoints: (apiBase: string, syncApi: string) => void;
  setPreference: (key: PreferenceKey, value: boolean) => void;
  setLyricFontSize: (size: LyricFontSize) => void;
  setSleepTimer: (mode: SleepTimerMode) => void;
  refreshNetworkStatus: () => boolean;
  getCacheSummary: () => Promise<{
    audioBytes: number;
    playlistCount: number;
    lyricCount: number;
  }>;
  clearAudioCache: () => boolean;
  clearMetadataCache: () => Promise<void>;
  openExternalLink: (url: string) => boolean;

  // Playlists & Favorites
  selectCloudPlaylist: (id: string, force?: boolean) => Promise<void>;
  importNeteasePlaylist: (input: string) => Promise<void>;
  createCloudPlaylist: (name: string) => Promise<void>;
  createCloudPlaylistWithTrack: (name: string, track: Track) => Promise<void>;
  renameCloudPlaylist: (id: string, name: string) => Promise<void>;
  deleteCloudPlaylist: (id: string) => Promise<void>;
  saveNeteasePlaylistToCloud: () => Promise<void>;
  addTrackToCloudPlaylist: (playlistId: string, track: Track) => Promise<void>;
  removeTrackFromCloudPlaylist: (playlistId: string, trackId: string | number) => Promise<void>;
  removeTrackFromActivePlaylist: (trackId: string | number) => Promise<void>;
  toggleFavorite: (track: Track) => Promise<void>;

  // Playback & Queue
  playTrackList: (
    tracks: Track[],
    index: number,
    meta?: { kind?: 'cloud' | 'netease'; playlistId?: string | null; sourceId?: string | null },
  ) => Promise<void>;
  playQueueIndex: (index: number) => Promise<void>;
  reshuffleQueue: () => void;
  playTrackNow: (track: Track) => Promise<void>;
  playNextInQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  switchSourceForTrack: (track: Track) => void;
  togglePlay: () => Promise<void>;
  playPrev: () => Promise<void>;
  playNext: (autoAdvance?: boolean) => Promise<void>;
  seekTo: (time: number) => void;
  cyclePlayMode: () => void;
  setQuality: (q: QualityLevel) => Promise<void>;

  // Search
  setSearchSource: (src: MusicSource) => void;
  setSearchQuery: (q: string) => void;
  executeSearch: (query?: string, source?: MusicSource) => Promise<void>;
  removeSearchHistory: (term: string) => void;
  clearAllSearchHistory: () => void;
}

const MODE_ORDER: PlayMode[] = ['sequence', 'random', 'single'];

export const usePlayerStore = create<PlayerStoreState>((set, get) => {
  const clearWebSleepTimers = () => {
    if (sleepTimeoutId) {
      clearTimeout(sleepTimeoutId);
      sleepTimeoutId = null;
    }
    if (sleepFadeIntervalId) {
      clearInterval(sleepFadeIntervalId);
      sleepFadeIntervalId = null;
    }
  };

  const cancelScheduledPreload = () => {
    if (preloadTimerId) {
      clearTimeout(preloadTimerId);
      preloadTimerId = null;
    }
  };

  const syncFavoriteSnapshot = (
    playlists: PlaylistSummary[] = cpSync.mirror.playlists,
    extraCloudContext?: { playlistId: string | null; tracks: Track[] },
  ) => {
    const favSummary = playlists.find((p) => p.name.trim() === FAVORITE_PLAYLIST_NAME);
    const trackMap: Record<string, string[]> = {};
    const idSet = new Set<string>();

    const recordTrack = (playlistId: string, trackId: string | number) => {
      const tid = String(trackId);
      idSet.add(tid);
      const list = trackMap[tid];
      if (!list) {
        trackMap[tid] = [playlistId];
      } else if (!list.includes(playlistId)) {
        list.push(playlistId);
      }
    };

    for (const pl of playlists) {
      const detail = cpSync.mirror.detail[pl.id];
      if (detail?.tracks?.length) {
        for (const t of detail.tracks) {
          recordTrack(pl.id, t.id);
        }
      }
    }

    // Also include currently loaded/playing cloud playlist tracks immediately
    const st = get();
    const ctxPlaylistId = extraCloudContext?.playlistId ?? st.activeCloudPlaylistId;
    const ctxTracks = extraCloudContext?.tracks ?? (st.activeCloudPlaylistId ? st.activePlaylistTracks : []);
    if (ctxPlaylistId && ctxTracks.length > 0) {
      for (const t of ctxTracks) {
        recordTrack(ctxPlaylistId, t.id);
      }
    }

    const allSavedIds = Array.from(idSet);
    set({
      favoritePlaylistId: favSummary ? favSummary.id : null,
      favoriteTrackIds: allSavedIds,
      savedCloudTrackIds: allSavedIds,
      cloudTrackPlaylistMap: trackMap,
    });
    return favSummary ? favSummary.id : null;
  };

  let preloadingAllCloudDetails = false;
  const preloadFavoritesDetailIfNeeded = async () => {
    syncFavoriteSnapshot();
    if (!cpSync.isLoggedIn() || preloadingAllCloudDetails) return;
    const missing = cpSync.mirror.playlists.filter((p) => !cpSync.mirror.detail[p.id]);
    if (!missing.length) return;
    preloadingAllCloudDetails = true;
    try {
      for (const pl of missing) {
        try {
          await cpSync.getPlaylist(pl.id, false);
          syncFavoriteSnapshot();
        } catch {
          // Ignore silent background fetch failure for individual playlists
        }
      }
    } finally {
      preloadingAllCloudDetails = false;
    }
  };

  const effectiveQualityForStore = (): Exclude<QualityLevel, 'auto'> => {
    const st = get();
    const metered = audioEngine ? audioEngine.isMeteredNetwork() : st.isMeteredNetwork;
    if (metered !== st.isMeteredNetwork) {
      set({ isMeteredNetwork: metered });
    }
    return resolveEffectiveQuality(st.quality, metered, st.mobileQualityLimit);
  };

  const syncRepeatMode = () => {
    const st = get();
    audioEngine?.setRepeatOne(st.playMode === 'single' && st.sleepTimerMode !== 'track');
  };

  const runNextPreload = async () => {
    const st = get();
    if (
      !st.preloadNextEnabled ||
      st.playMode === 'single' ||
      st.sleepTimerMode === 'track' ||
      st.queue.length <= 1 ||
      st.currentIndex < 0
    ) {
      audioEngine?.clearNextPreloadedTrack();
      return;
    }

    const { nextIndex } = getAdjacentIndices(st.queue.length, st.currentIndex);
    if (nextIndex < 0 || nextIndex === st.currentIndex) return;
    const nextTrack = st.queue[nextIndex];
    if (!nextTrack) return;

    const reqSeqSnapshot = songRequestSeq;
    const effectiveQ = effectiveQualityForStore();
    const src = songSourceOf(nextTrack.id);
    const cacheTag = src === 'wy' ? effectiveQ : src;

    try {
      const data = await preloadCache.getOrFetch(nextTrack.id, cacheTag, () =>
        musicService.getSong(nextTrack.id, effectiveQ),
      );
      const latest = get();
      if (songRequestSeq !== reqSeqSnapshot) return;
      if (
        !latest.preloadNextEnabled ||
        latest.playMode === 'single' ||
        latest.sleepTimerMode === 'track'
      ) {
        return;
      }
      const latestAdj = getAdjacentIndices(latest.queue.length, latest.currentIndex);
      const latestNext = latest.queue[latestAdj.nextIndex];
      if (!latestNext || String(latestNext.id) !== String(nextTrack.id)) return;

      const exoKey = buildAudioCacheKey(data.id, data.requestedLevel || src);
      audioEngine?.setNextPreloadedTrack(data, exoKey);
    } catch {
      // Preload errors are silent; fallback happens only if playback actually reaches the track
    }
  };

  const scheduleNextPreload = (delayMs = 1200) => {
    cancelScheduledPreload();
    const st = get();
    if (
      !st.preloadNextEnabled ||
      st.playMode === 'single' ||
      st.sleepTimerMode === 'track' ||
      st.queue.length <= 1 ||
      st.currentIndex < 0
    ) {
      audioEngine?.clearNextPreloadedTrack();
      return;
    }
    preloadTimerId = setTimeout(() => {
      preloadTimerId = null;
      void runNextPreload();
    }, delayMs);
  };

  const persistPlaybackProgress = (track: Track) => {
    const st = get();
    if (st.activeCloudPlaylistId) {
      cpSync.setPlaybackState({
        kind: 'cloud',
        playlistId: st.activeCloudPlaylistId,
        trackIndex: st.currentIndex,
        trackId: String(track.id),
        updatedAt: Date.now(),
      });
    } else if (st.activeNeteasePlaylistId) {
      cpSync.setPlaybackState({
        kind: 'netease',
        sourceId: st.activeNeteasePlaylistId,
        trackIndex: st.currentIndex,
        trackId: String(track.id),
        updatedAt: Date.now(),
      });
    }
  };

  const loadLyricsFor = async (id: string | number, seq: number) => {
    const cached = await getCachedLyric(id);
    if (cached && seq === songRequestSeq) {
      set({ lyrics: parseLyrics(cached) });
    }
    const fetched = await musicService.getLyric(id);
    if (fetched && seq === songRequestSeq) {
      set({ lyrics: parseLyrics(fetched) });
      void setCachedLyric(id, fetched);
    }
  };

  const handleNativeTrackTransition = (mediaId: string) => {
    const st = get();
    if (!st.queue.length) return;
    const { nextIndex } = getAdjacentIndices(st.queue.length, st.currentIndex);
    let resolvedIndex = -1;
    if (
      nextIndex >= 0 &&
      st.queue[nextIndex] &&
      String(st.queue[nextIndex].id) === String(mediaId)
    ) {
      resolvedIndex = nextIndex;
    } else if (mediaId) {
      resolvedIndex = st.queue.findIndex((t) => String(t.id) === String(mediaId));
    }
    if (resolvedIndex < 0) return;

    const track = st.queue[resolvedIndex];
    const seq = ++songRequestSeq;
    lastPreloadRefreshSeq = -1;
    consecutiveAutoSkipErrors = 0;
    activeSongAbort?.abort();
    activeSongAbort = null;
    if (autoSkipTimerId) {
      clearTimeout(autoSkipTimerId);
      autoSkipTimerId = null;
    }

    const effectiveQ = effectiveQualityForStore();
    const src = songSourceOf(track.id);
    const cacheTag = src === 'wy' ? effectiveQ : src;
    const preloaded = preloadCache.getValid(track.id, cacheTag);

    const songData: SongPlaybackData = preloaded || {
      id: track.id,
      url: '',
      name: track.name,
      artist: track.artist,
      album: track.album,
      cover: track.cover,
      source: track.source || src.toUpperCase(),
      requestedLevel: src === 'wy' ? effectiveQ : null,
      level: src === 'wy' ? effectiveQ : null,
      br: null,
    };

    const mergedTrack: Track = {
      ...track,
      name: songData.name || track.name,
      artist: songData.artist || track.artist,
      cover: songData.cover || track.cover,
    };

    audioEngine?.syncTransitionedTrack(songData);

    set({
      currentIndex: resolvedIndex,
      currentTrack: mergedTrack,
      currentSongData: songData,
      isPlaying: true,
      isBuffering: false,
      currentTime: 0,
      duration: 0,
      lyrics: [],
      actualQualityText: computeQualityBadge(songData),
      failedTrackOffer: null,
    });

    void extractFluidPalette(mergedTrack.cover, `${mergedTrack.id}-${mergedTrack.name}`).then(
      (palette) => {
        if (songRequestSeq === seq) set({ fluidPalette: palette });
      },
    );

    persistPlaybackProgress(mergedTrack);
    void loadLyricsFor(mergedTrack.id, seq);
    scheduleNextPreload(120);
  };

  const ensureAudioEngine = (): AudioEngine => {
    if (audioEngine) return audioEngine;
    audioEngine = new AudioEngine({
      onTimeUpdate: (currentTime, duration) => {
        const dur = duration || get().duration;
        set({ currentTime, duration: dur });
        if (dur > 35 && dur - currentTime <= 28 && lastPreloadRefreshSeq !== songRequestSeq) {
          lastPreloadRefreshSeq = songRequestSeq;
          void runNextPreload();
        }
      },
      onPlayStateChange: (isPlaying) => set({ isPlaying }),
      onBufferingChange: (isBuffering) => set({ isBuffering }),
      onEnded: () => {
        const st = get();
        if (st.sleepTimerMode === 'track') {
          set({ sleepTimerMode: 'off', sleepTimerEndsAt: null, isPlaying: false });
          audioEngine?.pause();
          syncRepeatMode();
          st.showToast('本首播完，睡眠定时已暂停播放');
          return;
        }
        if (st.playMode === 'single') {
          audioEngine?.seek(0);
          void audioEngine?.play();
        } else {
          void st.playNext(true);
        }
      },
      onError: (msg) => {
        const st = get();
        if (st.currentTrack) set({ failedTrackOffer: st.currentTrack });
        st.showToast(msg);
      },
      onPrev: () => {
        void get().playPrev();
      },
      onNext: () => {
        void get().playNext(false);
      },
      resolveExpiredSong: async (id) => {
        preloadCache.invalidate(id);
        return musicService.getSong(id, effectiveQualityForStore());
      },
      onNativeTrackTransition: (mediaId) => {
        handleNativeTrackTransition(mediaId);
      },
      onNativeSleepTimerFired: (mode) => {
        clearWebSleepTimers();
        set({ sleepTimerMode: 'off', sleepTimerEndsAt: null, isPlaying: false });
        syncRepeatMode();
        get().showToast(
          mode === 'track' ? '本首播完，睡眠定时已暂停播放' : '睡眠定时已到达，已暂停播放',
        );
      },
    });
    return audioEngine;
  };

  const loadSongAt = async (
    track: Track,
    startTime = 0,
    opts: { autoAdvance?: boolean } = {},
  ) => {
    const seq = ++songRequestSeq;
    lastPreloadRefreshSeq = -1;
    if (!opts.autoAdvance) {
      consecutiveAutoSkipErrors = 0;
    }
    if (autoSkipTimerId) {
      clearTimeout(autoSkipTimerId);
      autoSkipTimerId = null;
    }
    cancelScheduledPreload();
    activeSongAbort?.abort();
    const controller = new AbortController();
    activeSongAbort = controller;

    set({
      currentTrack: track,
      isBuffering: true,
      currentTime: startTime,
      duration: 0,
      lyrics: [],
      actualQualityText: null,
      failedTrackOffer: null,
    });

    // Update fluid backdrop immediately (smooth lerp)
    void extractFluidPalette(track.cover, `${track.id}-${track.name}`).then((palette) => {
      if (songRequestSeq === seq) set({ fluidPalette: palette });
    });

    const engine = ensureAudioEngine();
    engine.updateMetadata({
      name: track.name,
      artist: track.artist,
      album: track.album,
      cover: track.cover,
    });

    try {
      const effectiveQ = effectiveQualityForStore();
      const src = songSourceOf(track.id);
      const cacheTag = src === 'wy' ? effectiveQ : src;
      const songData = await preloadCache.getOrFetch(track.id, cacheTag, () =>
        musicService.getSong(track.id, effectiveQ, controller.signal),
      );
      if (seq !== songRequestSeq) return;

      const mergedTrack: Track = {
        ...track,
        name: songData.name || track.name,
        artist: songData.artist || track.artist,
        cover: songData.cover || track.cover,
      };

      set({
        currentTrack: mergedTrack,
        currentSongData: songData,
        actualQualityText: computeQualityBadge(songData),
      });

      if (songData.cover && songData.cover !== track.cover) {
        void extractFluidPalette(songData.cover, `${mergedTrack.id}-${mergedTrack.name}`).then(
          (palette) => {
            if (songRequestSeq === seq) set({ fluidPalette: palette });
          },
        );
      }

      const exoKey = buildAudioCacheKey(songData.id, songData.requestedLevel || src);
      syncRepeatMode();
      await engine.loadAndPlay(songData, startTime, exoKey);
      if (seq !== songRequestSeq) return;

      consecutiveAutoSkipErrors = 0;
      persistPlaybackProgress(mergedTrack);
      void loadLyricsFor(mergedTrack.id, seq);
      scheduleNextPreload(120);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (seq !== songRequestSeq) return;

      const msg = err instanceof Error ? err.message : '播放失败';
      if (msg.includes('登录')) {
        consecutiveAutoSkipErrors = 0;
        set({ isBuffering: false, isPlaying: false });
        get().showToast(msg);
        get().openSheet('account');
        return;
      }

      const st = get();
      if (
        opts.autoAdvance &&
        st.autoSkipFailed &&
        st.queue.length > 1 &&
        consecutiveAutoSkipErrors < 3
      ) {
        consecutiveAutoSkipErrors += 1;
        set({ isBuffering: false, isPlaying: false });
        get().showToast(`「${track.name}」暂不可播，自动跳过`);
        autoSkipTimerId = setTimeout(() => {
          autoSkipTimerId = null;
          if (songRequestSeq === seq) {
            void get().playNext(true);
          }
        }, 350);
        return;
      }

      consecutiveAutoSkipErrors = 0;
      set({ isBuffering: false, isPlaying: false, failedTrackOffer: track });
      get().showToast(msg);
    }
  };

  let initialized = false;

  return {
    activeTab: 0,
    showLyrics: false,
    activeSheet: null,
    sheetTrackTarget: null,
    toastMessage: null,

    user: null,
    syncStatus: cpSync.status,
    cloudPlaylists: cpSync.mirror.playlists,
    activePlaylistKey: 'queue',
    activePlaylistName: '当前播放',
    activePlaylistTracks: [],
    activeCloudPlaylistId: null,
    activeNeteasePlaylistId: null,
    loadingPlaylist: false,
    favoritePlaylistId: null,
    favoriteTrackIds: [],
    savedCloudTrackIds: [],
    cloudTrackPlaylistMap: {},

    queue: [],
    originalQueue: [],
    currentIndex: -1,
    currentTrack: null,
    currentSongData: null,
    isPlaying: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    playMode: (safeStorageGet('cp_play_mode') as PlayMode) || 'sequence',
    quality: musicService.quality,
    actualQualityText: null,
    lyrics: [],
    fluidPalette: DEFAULT_FLUID_PALETTE,
    isMeteredNetwork: false,
    failedTrackOffer: null,

    showVerbatim: readBoolPref('showVerbatim', true),
    showTranslation: readBoolPref('showTranslation', true),
    showRomaji: readBoolPref('showRomaji', true),
    fluidMotion: readBoolPref('fluidMotion', true),
    fluidPowerSave: readBoolPref('fluidPowerSave', true),
    mobileQualityLimit: readBoolPref('mobileQualityLimit', true),
    preloadNextEnabled: readBoolPref('preloadNextEnabled', true),
    autoSkipFailed: readBoolPref('autoSkipFailed', true),
    lyricFontSize: readLyricFontSize(),
    sleepTimerMode: 'off',
    sleepTimerEndsAt: null,

    searchSource: (safeStorageGet('cp_search_source') as MusicSource) || 'wy',
    searchQuery: '',
    searchResults: [],
    searching: false,
    searchError: null,
    searchHistory: loadSearchHistory(),

    init: async () => {
      if (initialized) return;
      initialized = true;
      const engine = ensureAudioEngine();
      set({ isMeteredNetwork: engine.isMeteredNetwork() });
      syncRepeatMode();
      syncFavoriteSnapshot();

      cpSync.addEventListener('status', (e) => {
        const detail = (e as CustomEvent<{ status: SyncStatusType }>).detail;
        set({ syncStatus: detail.status });
      });
      cpSync.addEventListener('mirror', () => {
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        syncFavoriteSnapshot();
      });
      cpSync.addEventListener('auth', (e) => {
        const detail = (e as CustomEvent<{ user: AuthUser | null }>).detail;
        playerAuth.invalidate();
        preloadCache.invalidate();
        set({ user: detail.user });
      });

      if (typeof document !== 'undefined') {
        document.addEventListener('cplayer:login-required', () => {
          get().openSheet('account');
        });
      }

      const restored = await cpSync.restoreSession();
      if (restored) {
        set({ user: restored, cloudPlaylists: [...cpSync.mirror.playlists] });
        void preloadFavoritesDetailIfNeeded();

        const pb = cpSync.mirror.playbackState;
        if (pb?.kind === 'cloud' && pb.playlistId) {
          await get().selectCloudPlaylist(pb.playlistId, false);
          const tracks = get().activePlaylistTracks;
          const idx = pb.trackId
            ? tracks.findIndex((t) => String(t.id) === String(pb.trackId))
            : pb.trackIndex;
          if (tracks.length > 0) {
            const safeIdx = idx >= 0 && idx < tracks.length ? idx : 0;
            const restoredOrder =
              get().playMode === 'random' && tracks.length > 1
                ? shuffleQueueKeepingCurrent(tracks, safeIdx)
                : { queue: tracks, currentIndex: safeIdx };
            set({
              originalQueue: tracks,
              queue: restoredOrder.queue,
              currentIndex: restoredOrder.currentIndex,
              currentTrack: restoredOrder.queue[restoredOrder.currentIndex],
            });
            const cur = restoredOrder.queue[restoredOrder.currentIndex];
            void extractFluidPalette(cur.cover, `${cur.id}-${cur.name}`).then((palette) =>
              set({ fluidPalette: palette }),
            );
          }
        } else if (cpSync.mirror.playlists.length > 0) {
          await get().selectCloudPlaylist(cpSync.mirror.playlists[0].id, false);
        }
      }
    },

    setActiveTab: (activeTab) => set({ activeTab: Math.max(0, Math.min(2, activeTab)) }),
    setShowLyrics: (showLyrics) => set({ showLyrics }),
    openSheet: (activeSheet, track = null) => {
      if (activeSheet === 'settings' || activeSheet === 'quality') {
        get().refreshNetworkStatus();
      }
      if (activeSheet === 'addToPlaylist') {
        void preloadFavoritesDetailIfNeeded();
      }
      set({ activeSheet, sheetTrackTarget: track });
    },
    closeSheet: () => set({ activeSheet: null, sheetTrackTarget: null }),

    showToast: (msg) => {
      set({ toastMessage: msg });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toastMessage: null }), 2200);
    },

    dismissFailedOffer: () => set({ failedTrackOffer: null }),

    login: async (username, password) => {
      const data = await cpSync.login(username.trim(), password);
      playerAuth.invalidate();
      preloadCache.invalidate();
      set({ user: data.user, cloudPlaylists: [...cpSync.mirror.playlists] });
      void preloadFavoritesDetailIfNeeded();
      get().showToast(`欢迎回来，${data.user.username}`);
      if (cpSync.mirror.playlists.length > 0) {
        await get().selectCloudPlaylist(cpSync.mirror.playlists[0].id, false);
      }
      get().closeSheet();
    },

    register: async (username, password, inviteCode) => {
      const data = await cpSync.register(username.trim(), password, inviteCode?.trim());
      playerAuth.invalidate();
      preloadCache.invalidate();
      set({ user: data.user, cloudPlaylists: [...cpSync.mirror.playlists] });
      syncFavoriteSnapshot();
      get().showToast(`注册成功，${data.user.username}`);
      get().closeSheet();
    },

    logout: async () => {
      await cpSync.logout();
      playerAuth.invalidate();
      preloadCache.invalidate();
      set({
        user: null,
        cloudPlaylists: [...cpSync.mirror.playlists],
        favoritePlaylistId: null,
        favoriteTrackIds: [],
        savedCloudTrackIds: [],
        cloudTrackPlaylistMap: {},
      });
      get().showToast('已退出登录');
    },

    refreshCloudPlaylists: async () => {
      try {
        await cpSync.refreshAll();
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        void preloadFavoritesDetailIfNeeded();
        const curCloudId = get().activeCloudPlaylistId;
        if (curCloudId) {
          await get().selectCloudPlaylist(curCloudId, true);
        }
        get().showToast('云歌单已同步');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '同步失败');
      }
    },

    updateEndpoints: (apiBase, syncApi) => {
      musicService.setBaseUrl(apiBase);
      cpSync.setBaseUrl(syncApi);
      playerAuth.setSyncBase(cpSync.baseUrl);
      preloadCache.invalidate();
      get().showToast('接口地址已更新');
    },

    setPreference: (key, value) => {
      safeStorageSet(PREF_STORAGE_KEYS[key], value ? '1' : '0');
      set({ [key]: value } as Partial<PlayerStoreState>);
      if (key === 'mobileQualityLimit') {
        get().refreshNetworkStatus();
        scheduleNextPreload(150);
      } else if (key === 'preloadNextEnabled') {
        if (value) scheduleNextPreload(150);
        else {
          cancelScheduledPreload();
          audioEngine?.clearNextPreloadedTrack();
        }
      }
    },

    setLyricFontSize: (lyricFontSize) => {
      safeStorageSet(LYRIC_SIZE_KEY, lyricFontSize);
      set({ lyricFontSize });
    },

    setSleepTimer: (mode) => {
      clearWebSleepTimers();
      const engine = ensureAudioEngine();
      engine.setVolume(1);

      if (mode === 'off') {
        engine.setNativeSleepTimer('off', 0);
        set({ sleepTimerMode: 'off', sleepTimerEndsAt: null });
        syncRepeatMode();
        scheduleNextPreload(200);
        get().showToast('已关闭睡眠定时');
        return;
      }

      if (mode === 'track') {
        engine.setNativeSleepTimer('track', 0);
        engine.clearNextPreloadedTrack();
        cancelScheduledPreload();
        set({ sleepTimerMode: 'track', sleepTimerEndsAt: null });
        syncRepeatMode();
        get().showToast('播完当前歌曲后将自动暂停');
        return;
      }

      const minutes = parseInt(mode, 10);
      const ms = minutes * 60_000;
      const endsAt = Date.now() + ms;
      const handledNative = engine.setNativeSleepTimer('timed', ms);
      set({ sleepTimerMode: mode, sleepTimerEndsAt: endsAt });
      syncRepeatMode();
      scheduleNextPreload(200);

      if (!handledNative) {
        const fadeStartDelay = Math.max(0, ms - 3000);
        sleepTimeoutId = setTimeout(() => {
          sleepTimeoutId = null;
          let step = 0;
          const totalSteps = 15;
          sleepFadeIntervalId = setInterval(() => {
            step += 1;
            if (step >= totalSteps) {
              if (sleepFadeIntervalId) {
                clearInterval(sleepFadeIntervalId);
                sleepFadeIntervalId = null;
              }
              engine.pause();
              engine.setVolume(1);
              set({ sleepTimerMode: 'off', sleepTimerEndsAt: null, isPlaying: false });
              get().showToast('睡眠定时已到达，已暂停播放');
              return;
            }
            engine.setVolume((totalSteps - step) / totalSteps);
          }, 200);
        }, fadeStartDelay);
      }

      get().showToast(`已开启 ${minutes} 分钟睡眠定时`);
    },

    refreshNetworkStatus: () => {
      const metered = audioEngine ? audioEngine.isMeteredNetwork() : false;
      set({ isMeteredNetwork: metered });
      return metered;
    },

    getCacheSummary: async () => {
      const audioBytes = audioEngine ? audioEngine.getAudioCacheBytes() : 0;
      const dbStats = await getDbCacheStats();
      return {
        audioBytes,
        playlistCount: dbStats.playlistCount,
        lyricCount: dbStats.lyricCount,
      };
    },

    clearAudioCache: () => {
      const ok = audioEngine ? audioEngine.clearAudioCache() : false;
      preloadCache.invalidate();
      get().showToast(ok ? '已清理音频边听边存缓存' : '当前环境无本地音频缓存');
      return ok;
    },

    clearMetadataCache: async () => {
      await clearDbCaches();
      get().showToast('已清理歌单与歌词本地缓存');
    },

    openExternalLink: (url) => {
      return ensureAudioEngine().openExternalUrl(url);
    },

    selectCloudPlaylist: async (id, force = false) => {
      set({ loadingPlaylist: true });
      try {
        const detail: PlaylistDetail = await cpSync.getPlaylist(id, force);
        const tracks = CPSync.toPlayerTracks(detail.tracks);
        set({
          activePlaylistKey: `cloud:${detail.id}`,
          activePlaylistName: detail.name,
          activePlaylistTracks: tracks,
          activeCloudPlaylistId: detail.id,
          activeNeteasePlaylistId: null,
          loadingPlaylist: false,
        });
        syncFavoriteSnapshot(cpSync.mirror.playlists, { playlistId: detail.id, tracks });
      } catch (err) {
        set({ loadingPlaylist: false });
        get().showToast(err instanceof Error ? err.message : '加载云歌单失败');
      }
    },

    importNeteasePlaylist: async (input) => {
      let listId = extractNeteasePlaylistId(input);
      if (!listId && /^https?:\/\//i.test(input.trim())) {
        try {
          listId = await cpSync.resolveShortLink(input.trim());
        } catch {
          listId = null;
        }
      }
      if (!listId) {
        get().showToast('请输入有效的网易云歌单 ID 或分享链接');
        return;
      }

      set({ loadingPlaylist: true });
      try {
        const cached = await getCachedPlaylist(listId);
        if (cached && cached.songs.length > 0) {
          set({
            activePlaylistKey: `netease:${listId}`,
            activePlaylistName: cached.name || `网易云歌单 #${listId}`,
            activePlaylistTracks: cached.songs,
            activeCloudPlaylistId: null,
            activeNeteasePlaylistId: listId,
            loadingPlaylist: false,
          });
        }

        const fresh = await musicService.fetchNeteasePlaylist(listId);
        if (fresh.tracks.length === 0) {
          throw new Error('该歌单为空或无访问权限');
        }
        void setCachedPlaylist(listId, fresh.name, fresh.tracks);
        set({
          activePlaylistKey: `netease:${listId}`,
          activePlaylistName: fresh.name,
          activePlaylistTracks: fresh.tracks,
          activeCloudPlaylistId: null,
          activeNeteasePlaylistId: listId,
          loadingPlaylist: false,
        });
        get().closeSheet();
        get().showToast(`已加载「${fresh.name}」(${fresh.tracks.length} 首)`);
      } catch (err) {
        set({ loadingPlaylist: false });
        const msg = err instanceof Error ? err.message : '导入网易云歌单失败';
        get().showToast(msg);
        if (msg.includes('登录')) get().openSheet('account');
      }
    },

    createCloudPlaylist: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const created = await cpSync.createPlaylist({ name: trimmed, tracks: [] });
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        syncFavoriteSnapshot();
        await get().selectCloudPlaylist(created.id);
        get().closeSheet();
        get().showToast(`已创建歌单「${created.name}」`);
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '创建歌单失败');
      }
    },

    createCloudPlaylistWithTrack: async (name, track) => {
      const trimmed = name.trim();
      if (!trimmed) {
        get().showToast('请输入新歌单名称');
        return;
      }
      if (!cpSync.isLoggedIn()) {
        get().showToast('请先登录 CPlayerSync 以创建云歌单');
        get().openSheet('account');
        return;
      }
      try {
        const created = await cpSync.createPlaylist({ name: trimmed, tracks: [track] });
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        syncFavoriteSnapshot(cpSync.mirror.playlists, {
          playlistId: created.id,
          tracks: [track],
        });
        get().closeSheet();
        get().showToast(`已新建「${created.name}」并存入歌曲`);
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '创建并存入失败');
      }
    },

    renameCloudPlaylist: async (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        get().showToast('歌单名称不能为空');
        return;
      }
      try {
        const detail = await cpSync.getPlaylist(id);
        const updated = await cpSync.updatePlaylist(id, { name: trimmed }, detail.version);
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        if (get().activeCloudPlaylistId === id) {
          set({ activePlaylistName: updated.name });
        }
        syncFavoriteSnapshot();
        get().closeSheet();
        get().showToast(`已重命名为「${updated.name}」`);
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '重命名失败');
      }
    },

    deleteCloudPlaylist: async (id) => {
      try {
        await cpSync.deletePlaylist(id);
        const remaining = [...cpSync.mirror.playlists];
        set({ cloudPlaylists: remaining });
        syncFavoriteSnapshot();
        if (get().activeCloudPlaylistId === id) {
          if (remaining.length > 0) {
            await get().selectCloudPlaylist(remaining[0].id);
          } else {
            set({
              activePlaylistKey: 'queue',
              activePlaylistName: '当前播放',
              activePlaylistTracks: [],
              activeCloudPlaylistId: null,
            });
          }
        }
        if (get().activeSheet === 'playlistManage') get().closeSheet();
        get().showToast('已删除歌单');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '删除失败');
      }
    },

    saveNeteasePlaylistToCloud: async () => {
      const st = get();
      if (!cpSync.isLoggedIn()) {
        st.showToast('请先登录 CPlayerSync 再保存到云歌单');
        st.openSheet('account');
        return;
      }
      if (!st.activePlaylistTracks.length) {
        st.showToast('当前歌单为空');
        return;
      }
      try {
        const created = await cpSync.createPlaylist({
          name: st.activePlaylistName || '导入的网易云歌单',
          source: 'netease',
          sourceId: st.activeNeteasePlaylistId,
          tracks: st.activePlaylistTracks,
        });
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        syncFavoriteSnapshot();
        await get().selectCloudPlaylist(created.id);
        get().showToast(`已保存至云歌单「${created.name}」`);
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '保存云歌单失败');
      }
    },

    addTrackToCloudPlaylist: async (playlistId, track) => {
      try {
        const res = await cpSync.addTracks(playlistId, [track]);
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        if (get().activeCloudPlaylistId === playlistId && res.playlist) {
          set({ activePlaylistTracks: CPSync.toPlayerTracks(res.playlist.tracks) });
        }
        syncFavoriteSnapshot();
        const plName = cpSync.mirror.playlists.find((p) => p.id === playlistId)?.name;
        get().showToast(plName ? `已加入「${plName}」` : '已加入歌单');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '添加失败');
      }
    },

    removeTrackFromCloudPlaylist: async (playlistId, trackId) => {
      try {
        const res = await cpSync.removeTrack(playlistId, trackId);
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        if (get().activeCloudPlaylistId === playlistId) {
          set({
            activePlaylistTracks: res.playlist ? CPSync.toPlayerTracks(res.playlist.tracks) : [],
          });
        }
        syncFavoriteSnapshot();
        const plName = cpSync.mirror.playlists.find((p) => p.id === playlistId)?.name;
        get().showToast(plName ? `已从「${plName}」移除` : '已从歌单移除');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '移除失败');
      }
    },

    removeTrackFromActivePlaylist: async (trackId) => {
      const cloudId = get().activeCloudPlaylistId;
      if (cloudId) {
        try {
          const res = await cpSync.removeTrack(cloudId, trackId);
          set({
            cloudPlaylists: [...cpSync.mirror.playlists],
            activePlaylistTracks: res.playlist ? CPSync.toPlayerTracks(res.playlist.tracks) : [],
          });
          syncFavoriteSnapshot();
          get().showToast('已从歌单移除');
        } catch (err) {
          get().showToast(err instanceof Error ? err.message : '移除失败');
        }
      } else {
        const filtered = get().activePlaylistTracks.filter((t) => String(t.id) !== String(trackId));
        set({ activePlaylistTracks: filtered });
        get().showToast('已从列表移除');
      }
    },

    toggleFavorite: async (track) => {
      if (!cpSync.isLoggedIn()) {
        get().showToast('请先登录 CPlayerSync 以收藏歌曲');
        get().openSheet('account');
        return;
      }
      try {
        let favId = get().favoritePlaylistId || syncFavoriteSnapshot();
        if (!favId) {
          await cpSync.createPlaylist({
            name: FAVORITE_PLAYLIST_NAME,
            tracks: [track],
          });
          set({ cloudPlaylists: [...cpSync.mirror.playlists] });
          syncFavoriteSnapshot();
          get().showToast('已添加到我喜欢的音乐');
          return;
        }

        const detail = await cpSync.getPlaylist(favId);
        const exists = detail.tracks.some((t) => String(t.id) === String(track.id));
        if (exists) {
          const res = await cpSync.removeTrack(favId, track.id);
          set({ cloudPlaylists: [...cpSync.mirror.playlists] });
          syncFavoriteSnapshot();
          if (get().activeCloudPlaylistId === favId && res.playlist) {
            set({ activePlaylistTracks: CPSync.toPlayerTracks(res.playlist.tracks) });
          }
          get().showToast('已取消喜欢');
        } else {
          const res = await cpSync.addTracks(favId, [track]);
          set({ cloudPlaylists: [...cpSync.mirror.playlists] });
          syncFavoriteSnapshot();
          if (get().activeCloudPlaylistId === favId && res.playlist) {
            set({ activePlaylistTracks: CPSync.toPlayerTracks(res.playlist.tracks) });
          }
          get().showToast('已添加到我喜欢的音乐');
        }
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '收藏操作失败');
      }
    },

    playTrackList: async (tracks, index, meta) => {
      if (!tracks.length) return;
      const safeIdx = Math.max(0, Math.min(tracks.length - 1, index));
      const isRandom = get().playMode === 'random' && tracks.length > 1;
      const nextOrder = isRandom
        ? shuffleQueueKeepingCurrent(tracks, safeIdx)
        : { queue: [...tracks], currentIndex: safeIdx };
      set({
        originalQueue: [...tracks],
        queue: nextOrder.queue,
        currentIndex: nextOrder.currentIndex,
        ...(meta?.kind === 'cloud'
          ? { activeCloudPlaylistId: meta.playlistId ?? get().activeCloudPlaylistId }
          : {}),
      });
      if (meta?.kind === 'cloud') {
        syncFavoriteSnapshot(cpSync.mirror.playlists, {
          playlistId: meta.playlistId ?? get().activeCloudPlaylistId ?? '__active_cloud__',
          tracks,
        });
      }
      if (isRandom) {
        get().showToast('随机播放 · 已按随机顺序打乱列表');
      }
      await loadSongAt(nextOrder.queue[nextOrder.currentIndex], 0);
    },

    playQueueIndex: async (index) => {
      const { queue } = get();
      if (!queue.length) return;
      const safeIdx = Math.max(0, Math.min(queue.length - 1, index));
      set({ currentIndex: safeIdx });
      await loadSongAt(queue[safeIdx], 0);
    },

    reshuffleQueue: () => {
      const { queue, originalQueue, currentIndex } = get();
      if (queue.length <= 1) return;
      const baseOriginal = originalQueue.length ? originalQueue : [...queue];
      const shuffled = shuffleQueueKeepingCurrent(queue, currentIndex);
      set({
        originalQueue: baseOriginal,
        queue: shuffled.queue,
        currentIndex: shuffled.currentIndex,
      });
      scheduleNextPreload(200);
      get().showToast('已重新随机打乱播放列表');
    },

    playTrackNow: async (track) => {
      const q = [...get().queue];
      const orig = [...get().originalQueue];
      const existingIdx = q.findIndex((t) => String(t.id) === String(track.id));
      if (existingIdx >= 0) {
        set({ currentIndex: existingIdx });
        await loadSongAt(q[existingIdx], 0);
      } else {
        const insertAt = get().currentIndex >= 0 ? get().currentIndex + 1 : 0;
        q.splice(insertAt, 0, track);
        if (!orig.some((t) => String(t.id) === String(track.id))) {
          orig.push(track);
        }
        set({ queue: q, originalQueue: orig, currentIndex: insertAt });
        await loadSongAt(track, 0);
      }
    },

    playNextInQueue: (track) => {
      const q = [...get().queue];
      const orig = [...get().originalQueue];
      const curIdx = get().currentIndex;
      const existing = q.findIndex((t) => String(t.id) === String(track.id));
      if (existing >= 0 && existing !== curIdx) {
        q.splice(existing, 1);
      }
      const nextCurIdx = q.findIndex(
        (t) => get().currentTrack && String(t.id) === String(get().currentTrack?.id),
      );
      const insertAt = nextCurIdx >= 0 ? nextCurIdx + 1 : q.length;
      if (existing !== nextCurIdx) {
        q.splice(insertAt, 0, track);
      }
      if (!orig.some((t) => String(t.id) === String(track.id))) {
        orig.push(track);
      }
      set({ queue: q, originalQueue: orig, currentIndex: nextCurIdx >= 0 ? nextCurIdx : curIdx });
      scheduleNextPreload(200);
      get().showToast(`已添加到下一首播放 · ${track.name}`);
    },

    removeFromQueue: (index) => {
      const st = get();
      if (index < 0 || index >= st.queue.length) return;
      if (st.queue.length === 1) {
        st.clearQueue();
        return;
      }

      const removed = st.queue[index];
      const nextQueue = st.queue.filter((_, i) => i !== index);
      const nextOrig = st.originalQueue.filter((t) => String(t.id) !== String(removed.id));

      if (index < st.currentIndex) {
        set({
          queue: nextQueue,
          originalQueue: nextOrig,
          currentIndex: st.currentIndex - 1,
        });
        scheduleNextPreload(200);
        return;
      }

      if (index === st.currentIndex) {
        const nextIdx = Math.min(index, nextQueue.length - 1);
        set({
          queue: nextQueue,
          originalQueue: nextOrig,
          currentIndex: nextIdx,
        });
        void loadSongAt(nextQueue[nextIdx], 0);
        return;
      }

      set({ queue: nextQueue, originalQueue: nextOrig });
      scheduleNextPreload(200);
    },

    clearQueue: () => {
      ++songRequestSeq;
      lastPreloadRefreshSeq = -1;
      consecutiveAutoSkipErrors = 0;
      if (autoSkipTimerId) {
        clearTimeout(autoSkipTimerId);
        autoSkipTimerId = null;
      }
      cancelScheduledPreload();
      activeSongAbort?.abort();
      activeSongAbort = null;
      audioEngine?.clearNextPreloadedTrack();
      audioEngine?.stop();
      set({
        queue: [],
        originalQueue: [],
        currentIndex: -1,
        currentTrack: null,
        currentSongData: null,
        isPlaying: false,
        isBuffering: false,
        currentTime: 0,
        duration: 0,
        lyrics: [],
        actualQualityText: null,
        failedTrackOffer: null,
      });
      get().showToast('已清空播放队列');
    },

    switchSourceForTrack: (track) => {
      const src = songSourceOf(track.id);
      const altSource: MusicSource = src === 'wy' ? 'qq' : 'wy';
      const query = `${track.name} ${track.artist || ''}`.trim();
      safeStorageSet('cp_search_source', altSource);
      set({
        failedTrackOffer: null,
        activeSheet: null,
        sheetTrackTarget: null,
        activeTab: 2,
        searchSource: altSource,
        searchQuery: query,
      });
      void get().executeSearch(query, altSource);
    },

    togglePlay: async () => {
      const st = get();
      const engine = ensureAudioEngine();
      if (!st.currentTrack) {
        if (st.activePlaylistTracks.length > 0) {
          await st.playTrackList(st.activePlaylistTracks, 0);
        } else {
          st.showToast('先去「歌单」或「搜索」选一首歌吧');
        }
        return;
      }
      if (!st.currentSongData || !st.currentSongData.url) {
        await loadSongAt(st.currentTrack, st.currentTime);
        return;
      }
      if (st.isPlaying) {
        engine.pause();
      } else {
        try {
          await engine.play();
        } catch {
          await loadSongAt(st.currentTrack, st.currentTime);
        }
      }
    },

    playPrev: async () => {
      const { queue, currentIndex } = get();
      if (!queue.length) return;
      const { prevIndex } = getAdjacentIndices(queue.length, currentIndex);
      if (prevIndex < 0) return;
      set({ currentIndex: prevIndex });
      await loadSongAt(queue[prevIndex], 0);
    },

    playNext: async (autoAdvance = false) => {
      const { queue, currentIndex } = get();
      if (!queue.length) return;
      const { nextIndex } = getAdjacentIndices(queue.length, currentIndex);
      if (nextIndex < 0) return;
      set({ currentIndex: nextIndex });
      await loadSongAt(queue[nextIndex], 0, { autoAdvance });
    },

    seekTo: (time) => {
      ensureAudioEngine().seek(time);
    },

    cyclePlayMode: () => {
      const { playMode: cur, queue, originalQueue, currentIndex, currentTrack } = get();
      const next = MODE_ORDER[(MODE_ORDER.indexOf(cur) + 1) % MODE_ORDER.length];
      safeStorageSet('cp_play_mode', next);

      if (next === 'random') {
        const snapshot = originalQueue.length ? originalQueue : [...queue];
        const shuffled = shuffleQueueKeepingCurrent(queue, currentIndex);
        set({
          playMode: next,
          originalQueue: snapshot,
          queue: shuffled.queue,
          currentIndex: shuffled.currentIndex,
        });
        syncRepeatMode();
        scheduleNextPreload(200);
        get().showToast(
          queue.length > 1
            ? '随机播放 · 已打乱播放列表顺序'
            : '播放模式 · 随机播放',
        );
        return;
      }

      if (cur === 'random' && originalQueue.length > 0) {
        const restored = restoreOriginalOrder(originalQueue, queue, currentTrack);
        set({
          playMode: next,
          queue: restored.queue,
          currentIndex: restored.currentIndex,
        });
        syncRepeatMode();
        scheduleNextPreload(200);
        get().showToast(
          next === 'single'
            ? '单曲循环 · 已恢复原歌单顺序'
            : '列表循环 · 已恢复原歌单顺序',
        );
        return;
      }

      set({ playMode: next });
      syncRepeatMode();
      scheduleNextPreload(200);
      const labels: Record<PlayMode, string> = {
        sequence: '列表循环',
        random: '随机播放',
        single: '单曲循环',
      };
      get().showToast(`播放模式 · ${labels[next]}`);
    },

    setQuality: async (q) => {
      musicService.setQuality(q);
      set({ quality: q });
      get().closeSheet();
      const { currentTrack, currentTime } = get();
      if (currentTrack && songSourceOf(currentTrack.id) === 'wy') {
        get().showToast('正在切换音质并无感续播...');
        await loadSongAt(currentTrack, currentTime);
      } else {
        scheduleNextPreload(200);
        get().showToast('音质偏好已保存');
      }
    },

    setSearchSource: (src) => {
      safeStorageSet('cp_search_source', src);
      set({ searchSource: src });
      const q = get().searchQuery.trim();
      if (q) void get().executeSearch(q, src);
    },

    setSearchQuery: (searchQuery) => set({ searchQuery }),

    executeSearch: async (queryOverride, sourceOverride) => {
      const q = (queryOverride ?? get().searchQuery).trim();
      const src = sourceOverride ?? get().searchSource;
      if (!q) {
        set({ searchResults: [], searchError: null, searching: false });
        return;
      }
      searchAbort?.abort();
      const controller = new AbortController();
      searchAbort = controller;

      set({
        searching: true,
        searchError: null,
        searchHistory: pushSearchHistory(q),
      });
      try {
        if (src === 'wy' && /^\d{5,}$/.test(q)) {
          const song = await musicService.getSong(q, effectiveQualityForStore(), controller.signal);
          set({
            searching: false,
            searchResults: [
              {
                id: song.id,
                name: song.name,
                artist: song.artist,
                album: song.album || '',
                cover: song.cover,
                source: song.source,
              },
            ],
          });
          return;
        }
        const results = await musicService.searchBySource(src, q, controller.signal);
        if (controller.signal.aborted) return;
        set({ searchResults: results, searching: false });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : '搜索失败';
        set({ searching: false, searchError: msg });
        get().showToast(msg);
        if (msg.includes('登录')) get().openSheet('account');
      }
    },

    removeSearchHistory: (term) => {
      set({ searchHistory: removeSearchHistoryItem(term) });
    },

    clearAllSearchHistory: () => {
      set({ searchHistory: clearSearchHistory() });
    },
  };
});

export function getPlayerAuthCredentialSnapshot() {
  return playerAuth.getCredentialSnapshot();
}

export function getPreciseAudioTime(): number {
  const engineTime = audioEngine ? audioEngine.getPreciseCurrentTime() : 0;
  return engineTime > 0 ? engineTime : usePlayerStore.getState().currentTime;
}
