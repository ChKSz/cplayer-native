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
  getCachedLyric,
  getCachedPlaylist,
  setCachedLyric,
  setCachedPlaylist,
} from '../services/cacheDb';
import {
  DEFAULT_FLUID_PALETTE,
  extractFluidPalette,
  type FluidPalette,
} from '../services/colorExtractor';
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
  | 'importNetease'
  | 'createPlaylist'
  | 'trackAction';

const playerAuth = new PlayerAuth();
export const cpSync = new CPSync();
export const musicService = new MusicService(playerAuth);

export type SleepTimerMode = 'off' | '15' | '30' | '60' | 'track';

export type PreferenceKey =
  | 'showVerbatim'
  | 'showTranslation'
  | 'showRomaji'
  | 'fluidMotion';

const PREF_STORAGE_KEYS: Record<PreferenceKey, string> = {
  showVerbatim: 'cp_lyric_yrc',
  showTranslation: 'cp_lyric_trans',
  showRomaji: 'cp_lyric_roma',
  fluidMotion: 'cp_fluid_motion',
};

function readBoolPref(key: PreferenceKey, fallback = true): boolean {
  try {
    const val = localStorage.getItem(PREF_STORAGE_KEYS[key]);
    if (val === null) return fallback;
    return val !== '0' && val !== 'false';
  } catch {
    return fallback;
  }
}

let audioEngine: AudioEngine | null = null;
let sleepTimeoutId: ReturnType<typeof setTimeout> | null = null;
let songRequestSeq = 0;
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

  // Preferences & Sleep Timer
  showVerbatim: boolean;
  showTranslation: boolean;
  showRomaji: boolean;
  fluidMotion: boolean;
  sleepTimerMode: SleepTimerMode;
  sleepTimerEndsAt: number | null;

  // Search
  searchSource: MusicSource;
  searchQuery: string;
  searchResults: Track[];
  searching: boolean;
  searchError: string | null;

  // Actions
  init: () => Promise<void>;
  setActiveTab: (tab: number) => void;
  setShowLyrics: (show: boolean) => void;
  openSheet: (type: ActiveSheetType, track?: Track | null) => void;
  closeSheet: () => void;
  showToast: (msg: string) => void;

  // Auth / Sync
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshCloudPlaylists: () => Promise<void>;
  updateEndpoints: (apiBase: string, syncApi: string) => void;
  setPreference: (key: PreferenceKey, value: boolean) => void;
  setSleepTimer: (mode: SleepTimerMode) => void;

  // Playlists
  selectCloudPlaylist: (id: string, force?: boolean) => Promise<void>;
  importNeteasePlaylist: (input: string) => Promise<void>;
  createCloudPlaylist: (name: string) => Promise<void>;
  deleteCloudPlaylist: (id: string) => Promise<void>;
  addTrackToCloudPlaylist: (playlistId: string, track: Track) => Promise<void>;
  removeTrackFromActivePlaylist: (trackId: string | number) => Promise<void>;

  // Playback
  playTrackList: (tracks: Track[], index: number, meta?: { kind?: 'cloud' | 'netease'; playlistId?: string | null; sourceId?: string | null }) => Promise<void>;
  playQueueIndex: (index: number) => Promise<void>;
  reshuffleQueue: () => void;
  playTrackNow: (track: Track) => Promise<void>;
  playNextInQueue: (track: Track) => void;
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
}

const MODE_ORDER: PlayMode[] = ['sequence', 'random', 'single'];

function extractNeteasePlaylistId(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{4,}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/[?&]id=(\d+)/) || trimmed.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => {
  const ensureAudioEngine = (): AudioEngine => {
    if (audioEngine) return audioEngine;
    audioEngine = new AudioEngine({
      onTimeUpdate: (currentTime, duration) => {
        set({ currentTime, duration: duration || get().duration });
      },
      onPlayStateChange: (isPlaying) => set({ isPlaying }),
      onBufferingChange: (isBuffering) => set({ isBuffering }),
      onEnded: () => {
        const st = get();
        if (st.sleepTimerMode === 'track') {
          set({ sleepTimerMode: 'off', sleepTimerEndsAt: null, isPlaying: false });
          audioEngine?.pause();
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
        get().showToast(msg);
      },
      onPrev: () => {
        void get().playPrev();
      },
      onNext: () => {
        void get().playNext(false);
      },
      resolveExpiredSong: async (id) => {
        return musicService.getSong(id, get().quality);
      },
    });
    return audioEngine;
  };

  const loadSongAt = async (track: Track, startTime = 0) => {
    const seq = ++songRequestSeq;
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
      const songData = await musicService.getSong(track.id, get().quality, controller.signal);
      if (seq !== songRequestSeq) return;

      const mergedTrack: Track = {
        ...track,
        name: songData.name || track.name,
        artist: songData.artist || track.artist,
        cover: songData.cover || track.cover,
      };

      const qualityBadge =
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
          : null);

      set({
        currentTrack: mergedTrack,
        currentSongData: songData,
        actualQualityText: qualityBadge,
      });

      if (songData.cover && songData.cover !== track.cover) {
        void extractFluidPalette(songData.cover, `${mergedTrack.id}-${mergedTrack.name}`).then((palette) => {
          if (songRequestSeq === seq) set({ fluidPalette: palette });
        });
      }

      // Start audio playback FIRST (highest priority)
      await engine.loadAndPlay(songData, startTime);

      // Persist playback state to CPSync
      const st = get();
      if (st.activeCloudPlaylistId) {
        cpSync.setPlaybackState({
          kind: 'cloud',
          playlistId: st.activeCloudPlaylistId,
          trackIndex: st.currentIndex,
          trackId: String(mergedTrack.id),
          updatedAt: Date.now(),
        });
      } else if (st.activeNeteasePlaylistId) {
        cpSync.setPlaybackState({
          kind: 'netease',
          sourceId: st.activeNeteasePlaylistId,
          trackIndex: st.currentIndex,
          trackId: String(mergedTrack.id),
          updatedAt: Date.now(),
        });
      }

      // Fetch lyrics asynchronously after playback starts
      void loadLyricsFor(mergedTrack.id, seq);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (seq !== songRequestSeq) return;
      set({ isBuffering: false, isPlaying: false });
      const msg = err instanceof Error ? err.message : '播放失败';
      get().showToast(msg);
      if (msg.includes('登录')) {
        get().openSheet('account');
      }
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

    queue: [],
    originalQueue: [],
    currentIndex: -1,
    currentTrack: null,
    currentSongData: null,
    isPlaying: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    playMode: (localStorage.getItem('cp_play_mode') as PlayMode) || 'sequence',
    quality: musicService.quality,
    actualQualityText: null,
    lyrics: [],
    fluidPalette: DEFAULT_FLUID_PALETTE,

    showVerbatim: readBoolPref('showVerbatim', true),
    showTranslation: readBoolPref('showTranslation', true),
    showRomaji: readBoolPref('showRomaji', true),
    fluidMotion: readBoolPref('fluidMotion', true),
    sleepTimerMode: 'off',
    sleepTimerEndsAt: null,

    searchSource: (localStorage.getItem('cp_search_source') as MusicSource) || 'wy',
    searchQuery: '',
    searchResults: [],
    searching: false,
    searchError: null,

    init: async () => {
      if (initialized) return;
      initialized = true;
      ensureAudioEngine();

      cpSync.addEventListener('status', (e) => {
        const detail = (e as CustomEvent<{ status: SyncStatusType }>).detail;
        set({ syncStatus: detail.status });
      });
      cpSync.addEventListener('mirror', () => {
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
      });
      cpSync.addEventListener('auth', (e) => {
        const detail = (e as CustomEvent<{ user: AuthUser | null }>).detail;
        playerAuth.invalidate();
        set({ user: detail.user });
      });

      document.addEventListener('cplayer:login-required', () => {
        get().openSheet('account');
      });

      // Restore session if token exists
      const restored = await cpSync.restoreSession();
      if (restored) {
        set({ user: restored, cloudPlaylists: [...cpSync.mirror.playlists] });
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
            void extractFluidPalette(cur.cover, `${cur.id}-${cur.name}`).then(
              (palette) => set({ fluidPalette: palette }),
            );
          }
        } else if (cpSync.mirror.playlists.length > 0) {
          await get().selectCloudPlaylist(cpSync.mirror.playlists[0].id, false);
        }
      }
    },

    setActiveTab: (activeTab) => set({ activeTab: Math.max(0, Math.min(2, activeTab)) }),
    setShowLyrics: (showLyrics) => set({ showLyrics }),
    openSheet: (activeSheet, track = null) => set({ activeSheet, sheetTrackTarget: track }),
    closeSheet: () => set({ activeSheet: null, sheetTrackTarget: null }),

    showToast: (msg) => {
      set({ toastMessage: msg });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set({ toastMessage: null }), 2200);
    },

    login: async (username, password) => {
      const data = await cpSync.login(username.trim(), password);
      playerAuth.invalidate();
      set({ user: data.user, cloudPlaylists: [...cpSync.mirror.playlists] });
      get().showToast(`欢迎回来，${data.user.username}`);
      if (cpSync.mirror.playlists.length > 0) {
        await get().selectCloudPlaylist(cpSync.mirror.playlists[0].id, false);
      }
      get().closeSheet();
    },

    register: async (username, password, inviteCode) => {
      const data = await cpSync.register(username.trim(), password, inviteCode?.trim());
      playerAuth.invalidate();
      set({ user: data.user, cloudPlaylists: [...cpSync.mirror.playlists] });
      get().showToast(`注册成功，${data.user.username}`);
      get().closeSheet();
    },

    logout: async () => {
      await cpSync.logout();
      playerAuth.invalidate();
      set({
        user: null,
        cloudPlaylists: [...cpSync.mirror.playlists],
      });
      get().showToast('已退出登录');
    },

    refreshCloudPlaylists: async () => {
      try {
        await cpSync.refreshAll();
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
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
      get().showToast('接口地址已更新');
    },

    setPreference: (key, value) => {
      try {
        localStorage.setItem(PREF_STORAGE_KEYS[key], value ? '1' : '0');
      } catch {
        // Ignore storage error
      }
      set({ [key]: value } as Partial<PlayerStoreState>);
    },

    setSleepTimer: (mode) => {
      if (sleepTimeoutId) {
        clearTimeout(sleepTimeoutId);
        sleepTimeoutId = null;
      }
      if (mode === 'off') {
        set({ sleepTimerMode: 'off', sleepTimerEndsAt: null });
        get().showToast('已关闭睡眠定时');
        return;
      }
      if (mode === 'track') {
        set({ sleepTimerMode: 'track', sleepTimerEndsAt: null });
        get().showToast('播完当前歌曲后将自动暂停');
        return;
      }
      const minutes = parseInt(mode, 10);
      const ms = minutes * 60_000;
      const endsAt = Date.now() + ms;
      set({ sleepTimerMode: mode, sleepTimerEndsAt: endsAt });
      sleepTimeoutId = setTimeout(() => {
        sleepTimeoutId = null;
        audioEngine?.pause();
        set({ sleepTimerMode: 'off', sleepTimerEndsAt: null, isPlaying: false });
        get().showToast('睡眠定时已到达，已暂停播放');
      }, ms);
      get().showToast(`已开启 ${minutes} 分钟睡眠定时`);
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
        await get().selectCloudPlaylist(created.id);
        get().closeSheet();
        get().showToast(`已创建歌单「${created.name}」`);
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '创建歌单失败');
      }
    },

    deleteCloudPlaylist: async (id) => {
      try {
        await cpSync.deletePlaylist(id);
        const remaining = [...cpSync.mirror.playlists];
        set({ cloudPlaylists: remaining });
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
        get().showToast('已删除歌单');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '删除失败');
      }
    },

    addTrackToCloudPlaylist: async (playlistId, track) => {
      try {
        const res = await cpSync.addTracks(playlistId, [track]);
        set({ cloudPlaylists: [...cpSync.mirror.playlists] });
        if (get().activeCloudPlaylistId === playlistId && res.playlist) {
          set({ activePlaylistTracks: CPSync.toPlayerTracks(res.playlist.tracks) });
        }
        get().showToast('已加入歌单');
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : '添加失败');
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
      q.splice(insertAt, 0, track);
      if (!orig.some((t) => String(t.id) === String(track.id))) {
        orig.push(track);
      }
      set({ queue: q, originalQueue: orig, currentIndex: nextCurIdx >= 0 ? nextCurIdx : curIdx });
      get().showToast(`已添加到下一首播放 · ${track.name}`);
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
      if (!st.currentSongData) {
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

    playNext: async () => {
      const { queue, currentIndex } = get();
      if (!queue.length) return;
      const { nextIndex } = getAdjacentIndices(queue.length, currentIndex);
      if (nextIndex < 0) return;
      set({ currentIndex: nextIndex });
      await loadSongAt(queue[nextIndex], 0);
    },

    seekTo: (time) => {
      ensureAudioEngine().seek(time);
    },

    cyclePlayMode: () => {
      const { playMode: cur, queue, originalQueue, currentIndex, currentTrack } = get();
      const next = MODE_ORDER[(MODE_ORDER.indexOf(cur) + 1) % MODE_ORDER.length];
      localStorage.setItem('cp_play_mode', next);

      if (next === 'random') {
        const snapshot = originalQueue.length ? originalQueue : [...queue];
        const shuffled = shuffleQueueKeepingCurrent(queue, currentIndex);
        set({
          playMode: next,
          originalQueue: snapshot,
          queue: shuffled.queue,
          currentIndex: shuffled.currentIndex,
        });
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
        get().showToast(
          next === 'single'
            ? '单曲循环 · 已恢复原歌单顺序'
            : '列表循环 · 已恢复原歌单顺序',
        );
        return;
      }

      set({ playMode: next });
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
        get().showToast('音质偏好已保存');
      }
    },

    setSearchSource: (src) => {
      localStorage.setItem('cp_search_source', src);
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

      set({ searching: true, searchError: null });
      try {
        // Direct NetEase song ID lookup if pure digits
        if (src === 'wy' && /^\d{5,}$/.test(q)) {
          const song = await musicService.getSong(q, get().quality, controller.signal);
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
  };
});

export function getPlayerAuthCredentialSnapshot() {
  return playerAuth.getCredentialSnapshot();
}

export function getPreciseAudioTime(): number {
  const engineTime = audioEngine ? audioEngine.getPreciseCurrentTime() : 0;
  return engineTime > 0 ? engineTime : usePlayerStore.getState().currentTime;
}
