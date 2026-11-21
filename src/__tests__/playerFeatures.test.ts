import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CPlayerNativeMediaApi, NativeMediaCallbacks } from '../engine/nativeMediaBridge';
import type { Track } from '../types/music';

const originalWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalLocalStorageDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function createStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  } as Storage;
}

function makeTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${1000 + i}`,
    name: `Track ${i + 1}`,
    artist: `Artist ${i + 1}`,
    album: 'Album',
    cover: '',
    source: 'ChKSz',
  }));
}

async function setupHarness() {
  vi.resetModules();
  const storage = createStorage();
  const loadCalls: { trackId: string; url: string; cacheKey: string }[] = [];
  const nextCalls: { trackId: string; url: string; cacheKey: string }[] = [];
  const sleepCalls: { mode: string; durationMs: number }[] = [];
  const repeatCalls: boolean[] = [];
  let clearNextCalls = 0;

  const nativeMedia: CPlayerNativeMediaApi = {
    isAvailable: () => true,
    loadAndPlay: (trackId, url, _t, _a, _al, _c, _ms, cacheKey) => {
      loadCalls.push({ trackId, url, cacheKey });
    },
    setNextMediaItem: (trackId, url, _t, _a, _al, _c, cacheKey) => {
      nextCalls.push({ trackId, url, cacheKey });
    },
    clearNextMediaItem: () => {
      clearNextCalls++;
    },
    setRepeatOne: (enabled) => {
      repeatCalls.push(enabled);
    },
    setSleepTimer: (mode, durationMs) => {
      sleepCalls.push({ mode, durationMs });
    },
    getSleepTimerRemainingMs: () => 0,
    getAudioCacheBytes: () => 1024 * 1024 * 12,
    clearAudioCache: () => true,
    isMeteredNetwork: () => false,
    openExternalUrl: () => true,
    play: vi.fn(),
    pause: vi.fn(),
    seekTo: vi.fn(),
    stop: vi.fn(),
  };

  const mockWin = {
    localStorage: storage,
    CPlayerNativeMedia: nativeMedia,
    __cplayerNativeBridge: undefined as NativeMediaCallbacks | undefined,
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: mockWin,
    configurable: true,
    writable: true,
  });

  const storeMod = await import('../stores/usePlayerStore');
  await storeMod.usePlayerStore.getState().init();

  return {
    ...storeMod,
    mockWin,
    loadCalls,
    nextCalls,
    sleepCalls,
    repeatCalls,
    getClearNextCalls: () => clearNextCalls,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalWindowDesc) {
    Object.defineProperty(globalThis, 'window', originalWindowDesc);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (originalLocalStorageDesc) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorageDesc);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('Player store v1.1 native preloading, sleep timer, queue, auto-skip & settings separation', () => {
  it('preloads next track into ExoPlayer and syncs native background transitions without re-calling loadAndPlay', async () => {
    vi.useFakeTimers();
    const h = await setupHarness();
    const getSongSpy = vi
      .spyOn(h.musicService, 'getSong')
      .mockImplementation(async (id) => ({
        id,
        url: `https://cdn.example.com/audio/${id}.flac`,
        name: `Song ${id}`,
        artist: 'Artist',
        cover: '',
        source: 'ChKSz',
        requestedLevel: 'lossless',
        level: 'lossless',
        br: 999000,
      }));

    const tracks = makeTracks(3);
    await h.usePlayerStore.getState().playTrackList(tracks, 0);
    expect(h.loadCalls.length).toBe(1);
    expect(h.loadCalls[0].trackId).toBe('1000');
    expect(h.loadCalls[0].cacheKey).toBe('cplayer:track:1000:lossless');

    // Advance timer to trigger next-track pre-resolution & ExoPlayer queue push
    await vi.advanceTimersByTimeAsync(1300);
    expect(h.nextCalls.length).toBe(1);
    expect(h.nextCalls[0].trackId).toBe('1001');
    expect(getSongSpy).toHaveBeenCalledTimes(2);

    // Simulate lock-screen automatic transition inside CPlayerPlaybackService
    h.mockWin.__cplayerNativeBridge?.onTrackTransition?.('1001');
    const afterTransition = h.usePlayerStore.getState();
    expect(afterTransition.currentIndex).toBe(1);
    expect(String(afterTransition.currentTrack?.id)).toBe('1001');
    expect(h.loadCalls.length).toBe(1); // NEVER restarted ExoPlayer!

    // Follows up by preloading track 3 ('1002')
    await vi.advanceTimersByTimeAsync(500);
    expect(h.nextCalls.length).toBe(2);
    expect(h.nextCalls[1].trackId).toBe('1002');
  });

  it('routes sleep timer to native Media3 service and handles native firing callbacks', async () => {
    const h = await setupHarness();
    h.usePlayerStore.getState().setSleepTimer('15');
    expect(h.sleepCalls.at(-1)).toEqual({ mode: 'timed', durationMs: 15 * 60_000 });
    expect(h.usePlayerStore.getState().sleepTimerMode).toBe('15');
    expect(h.usePlayerStore.getState().sleepTimerEndsAt).not.toBeNull();

    h.mockWin.__cplayerNativeBridge?.onSleepTimerFired?.('timed');
    expect(h.usePlayerStore.getState().sleepTimerMode).toBe('off');
    expect(h.usePlayerStore.getState().sleepTimerEndsAt).toBeNull();

    h.usePlayerStore.getState().setSleepTimer('track');
    expect(h.sleepCalls.at(-1)).toEqual({ mode: 'track', durationMs: 0 });
    expect(h.getClearNextCalls()).toBeGreaterThan(0);

    h.mockWin.__cplayerNativeBridge?.onSleepTimerFired?.('track');
    expect(h.usePlayerStore.getState().sleepTimerMode).toBe('off');
  });

  it('syncs single-repeat mode to native ExoPlayer and clears preloaded next item', async () => {
    const h = await setupHarness();
    // sequence -> random -> single
    h.usePlayerStore.getState().cyclePlayMode();
    expect(h.usePlayerStore.getState().playMode).toBe('random');
    expect(h.repeatCalls.at(-1)).toBe(false);

    h.usePlayerStore.getState().cyclePlayMode();
    expect(h.usePlayerStore.getState().playMode).toBe('single');
    expect(h.repeatCalls.at(-1)).toBe(true);
    expect(h.getClearNextCalls()).toBeGreaterThan(0);
  });

  it('maintains valid indices on queue item removal and clears queue cleanly', async () => {
    const h = await setupHarness();
    vi.spyOn(h.musicService, 'getSong').mockImplementation(async (id) => ({
      id,
      url: `https://cdn.example.com/${id}.mp3`,
      name: `Song ${id}`,
      artist: 'Artist',
      cover: '',
      source: 'ChKSz',
      requestedLevel: 'lossless',
      level: 'lossless',
      br: 320000,
    }));

    const tracks = makeTracks(4); // 1000, 1001, 1002, 1003
    await h.usePlayerStore.getState().playTrackList(tracks, 2); // active: 1002 (index 2)
    expect(h.usePlayerStore.getState().currentIndex).toBe(2);

    // Remove before active -> active index shifts down to 1
    h.usePlayerStore.getState().removeFromQueue(0);
    expect(h.usePlayerStore.getState().queue.length).toBe(3);
    expect(h.usePlayerStore.getState().currentIndex).toBe(1);
    expect(String(h.usePlayerStore.getState().currentTrack?.id)).toBe('1002');

    // Remove after active -> index remains 1
    h.usePlayerStore.getState().removeFromQueue(2);
    expect(h.usePlayerStore.getState().queue.length).toBe(2);
    expect(h.usePlayerStore.getState().currentIndex).toBe(1);

    h.usePlayerStore.getState().clearQueue();
    expect(h.usePlayerStore.getState().queue).toEqual([]);
    expect(h.usePlayerStore.getState().currentIndex).toBe(-1);
    expect(h.usePlayerStore.getState().currentTrack).toBeNull();
  });

  it('auto-skips broken tracks up to 3 consecutive failures then stops with failedTrackOffer', async () => {
    vi.useFakeTimers();
    const h = await setupHarness();
    let getCalls = 0;
    vi.spyOn(h.musicService, 'getSong').mockImplementation(async (id) => {
      getCalls++;
      if (id === '1000') {
        return {
          id,
          url: 'https://cdn.example.com/1000.mp3',
          name: 'Song 1000',
          artist: 'Artist',
          cover: '',
          source: 'ChKSz',
          requestedLevel: 'lossless',
          level: 'lossless',
          br: 320000,
        };
      }
      throw new Error('版权受限');
    });

    const tracks = makeTracks(5); // 1000 succeeds, 1001..1004 fail
    await h.usePlayerStore.getState().playTrackList(tracks, 0);

    // End of track 1 triggers autoAdvance playNext(true) -> fails 1001 (err 1) -> 1002 (err 2) -> 1003 (err 3) -> 1004 (stops & offers source switch)
    h.mockWin.__cplayerNativeBridge?.onEnded?.();
    await vi.advanceTimersByTimeAsync(2000);

    const st = h.usePlayerStore.getState();
    expect(getCalls).toBe(5); // 1 success + 4 failures (capped after 3 auto-skips)
    expect(st.failedTrackOffer?.id).toBe('1004');
    expect(st.isPlaying).toBe(false);
  });

  it('routes switchSourceForTrack to Search tab on an alternate music source and keeps settings/account sheets separate', async () => {
    const h = await setupHarness();
    vi.spyOn(h.musicService, 'searchBySource').mockResolvedValue([]);

    h.usePlayerStore.getState().openSheet('settings');
    expect(h.usePlayerStore.getState().activeSheet).toBe('settings');

    h.usePlayerStore.getState().openSheet('account');
    expect(h.usePlayerStore.getState().activeSheet).toBe('account');

    h.usePlayerStore.getState().switchSourceForTrack({
      id: '99999',
      name: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      cover: '',
    });

    const st = h.usePlayerStore.getState();
    expect(st.activeTab).toBe(2);
    expect(st.searchSource).toBe('qq'); // wy -> qq
    expect(st.searchQuery).toBe('晴天 周杰伦');
    expect(st.activeSheet).toBeNull();
  });

  it('immediately preloads the next track right after playback starts and marks cloud-playlist tracks as saved', async () => {
    vi.useFakeTimers();
    const h = await setupHarness();
    vi.spyOn(h.musicService, 'getSong').mockImplementation(async (id) => ({
      id,
      url: `https://cdn.example.com/audio/${id}.mp3`,
      name: `Song ${id}`,
      artist: 'Artist',
      cover: '',
      source: 'ChKSz',
      requestedLevel: 'lossless',
      level: 'lossless',
      br: 320000,
    }));

    const tracks = makeTracks(2);
    await h.usePlayerStore
      .getState()
      .playTrackList(tracks, 0, { kind: 'cloud', playlistId: 'pl-custom-1' });

    // Playing from ANY cloud playlist immediately lights up the saved cloud track set
    expect(h.usePlayerStore.getState().savedCloudTrackIds).toContain('1000');
    expect(h.usePlayerStore.getState().cloudTrackPlaylistMap['1000']).toContain('pl-custom-1');

    // Immediate next-track pre-resolution fires within 150ms of starting track 1
    await vi.advanceTimersByTimeAsync(150);
    expect(h.nextCalls.length).toBe(1);
    expect(h.nextCalls[0].trackId).toBe('1001');
  });
});
