import { describe, expect, it, vi } from 'vitest';
import {
  buildAudioCacheKey,
  PreloadCache,
  resolveEffectiveQuality,
} from '../services/preloadCache';
import type { SongPlaybackData } from '../types/music';

function makeSong(id: string | number, overrides: Partial<SongPlaybackData> = {}): SongPlaybackData {
  return {
    id,
    url: `https://cdn.example.com/${id}?token=abc`,
    name: `Song ${id}`,
    artist: 'Artist',
    cover: '',
    source: 'ChKSz',
    requestedLevel: 'lossless',
    level: 'lossless',
    br: 999000,
    ...overrides,
  };
}

describe('PreloadCache, cache key, and mobile-network quality protection', () => {
  it('clamps lossless and higher tiers to exhigh on metered network when limit is enabled', () => {
    expect(resolveEffectiveQuality('auto', true, true)).toBe('exhigh');
    expect(resolveEffectiveQuality('lossless', true, true)).toBe('exhigh');
    expect(resolveEffectiveQuality('hires', true, true)).toBe('exhigh');
    expect(resolveEffectiveQuality('jymaster', true, true)).toBe('exhigh');
    expect(resolveEffectiveQuality('standard', true, true)).toBe('standard');
    expect(resolveEffectiveQuality('higher', true, true)).toBe('higher');
    expect(resolveEffectiveQuality('exhigh', true, true)).toBe('exhigh');

    // Unmetered or limit disabled keeps full requested quality
    expect(resolveEffectiveQuality('lossless', false, true)).toBe('lossless');
    expect(resolveEffectiveQuality('jymaster', true, false)).toBe('jymaster');
    expect(resolveEffectiveQuality('auto', false, true)).toBe('lossless');
  });

  it('builds deterministic ExoPlayer cache keys independent of CDN tokens', () => {
    expect(buildAudioCacheKey(12345, 'lossless')).toBe('cplayer:track:12345:lossless');
    expect(buildAudioCacheKey('kg:abc', 'KuGou')).toBe('cplayer:track:kg:abc:kugou');
    expect(buildAudioCacheKey('qq:xyz', null)).toBe('cplayer:track:qq:xyz:default');
  });

  it('caches entries before TTL, respects streamExpiresAt margin, and evicts oldest past 24', async () => {
    let now = 1_000_000;
    const cache = new PreloadCache(() => now);

    const s1 = makeSong(1, { streamExpiresAt: now + 120_000 });
    cache.set(1, 'lossless', s1);
    expect(cache.getValid(1, 'lossless')).toEqual(s1);

    // 10s before streamExpiresAt is inside the 20s safety margin -> expired
    now += 105_000;
    expect(cache.getValid(1, 'lossless')).toBeNull();

    // Concurrent getOrFetch deduplicates network calls
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return makeSong(2);
    });
    const [a, b] = await Promise.all([
      cache.getOrFetch(2, 'lossless', fetcher),
      cache.getOrFetch(2, 'lossless', fetcher),
    ]);
    expect(calls).toBe(1);
    expect(a.id).toBe(2);
    expect(b.id).toBe(2);

    // LRU cap at 24 entries
    for (let i = 10; i < 40; i++) {
      cache.set(i, 'lossless', makeSong(i));
    }
    expect(cache.size()).toBe(24);
    expect(cache.getValid(10, 'lossless')).toBeNull();
    expect(cache.getValid(39, 'lossless')).not.toBeNull();

    cache.invalidate(39);
    expect(cache.getValid(39, 'lossless')).toBeNull();
    cache.invalidate();
    expect(cache.size()).toBe(0);
  });
});
