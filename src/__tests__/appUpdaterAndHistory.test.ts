import { describe, expect, it } from 'vitest';
import { checkForAppUpdate, compareSemver } from '../services/appUpdater';
import {
  clearSearchHistory,
  loadSearchHistory,
  pushSearchHistory,
  removeSearchHistoryItem,
  type StorageBackend,
} from '../services/searchHistory';

function memoryStorage(): StorageBackend {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('App updater and search history services', () => {
  it('compares semantic versions accurately across tags and prereleases', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('v2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.1.0-beta.1', '1.1.0')).toBe(0);
    expect(compareSemver('1.0.9', '1.1.0')).toBeLessThan(0);
  });

  it('parses GitHub latest release, APK asset link, 404, and HTTP failures', async () => {
    const newer = await checkForAppUpdate(
      async () =>
        Response.json({
          tag_name: 'v1.2.0',
          name: 'CPlayer v1.2.0',
          body: 'Fix background playback',
          html_url: 'https://github.com/ChKSz/cplayer-native/releases/tag/v1.2.0',
          assets: [
            {
              name: 'app-universal-release-signed.apk',
              browser_download_url: 'https://example.com/cplayer-v1.2.0.apk',
            },
          ],
        }),
      '1.1.0',
    );
    expect(newer.hasUpdate).toBe(true);
    expect(newer.latestVersion).toBe('1.2.0');
    expect(newer.downloadUrl).toBe('https://example.com/cplayer-v1.2.0.apk');

    const same = await checkForAppUpdate(
      async () =>
        Response.json({
          tag_name: 'v1.1.0',
          html_url: 'https://github.com/ChKSz/cplayer-native/releases/tag/v1.1.0',
          assets: [],
        }),
      '1.1.0',
    );
    expect(same.hasUpdate).toBe(false);

    const noRelease = await checkForAppUpdate(
      async () => new Response('', { status: 404 }),
      '1.1.0',
    );
    expect(noRelease.hasUpdate).toBe(false);
    expect(noRelease.noPublishedRelease).toBe(true);

    await expect(
      checkForAppUpdate(async () => new Response('', { status: 503 }), '1.1.0'),
    ).rejects.toThrow(/503/);
  });

  it('deduplicates, caps at 10, removes, and clears search history', () => {
    const storage = memoryStorage();
    expect(loadSearchHistory(storage)).toEqual([]);

    pushSearchHistory('周杰伦', storage);
    pushSearchHistory('Jay', storage);
    pushSearchHistory('jay', storage); // case-insensitive dedup moves to front
    expect(loadSearchHistory(storage)).toEqual(['jay', '周杰伦']);

    for (let i = 1; i <= 12; i++) {
      pushSearchHistory(`song-${i}`, storage);
    }
    const list = loadSearchHistory(storage);
    expect(list.length).toBe(10);
    expect(list[0]).toBe('song-12');

    expect(removeSearchHistoryItem('song-12', storage)[0]).toBe('song-11');
    expect(clearSearchHistory(storage)).toEqual([]);
    expect(loadSearchHistory(storage)).toEqual([]);
  });
});
