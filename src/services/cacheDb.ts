import type { LyricPayload, Track } from '../types/music';

const DB_NAME = 'CPlayer5DB';
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => resolve(null);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('playlists')) {
            const store = db.createObjectStore('playlists', { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp');
          }
          if (!db.objectStoreNames.contains('lyrics')) {
            db.createObjectStore('lyrics', { keyPath: 'songId' });
          }
        };
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

export async function getCachedPlaylist(
  id: string,
): Promise<{ id: string; name: string; songs: Track[]; timestamp: number } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('playlists', 'readonly');
      const req = tx.objectStore('playlists').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedPlaylist(id: string, name: string, songs: Track[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('playlists', 'readwrite');
      tx.objectStore('playlists').put({ id, name, songs, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getCachedLyric(
  songId: string | number,
): Promise<LyricPayload | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('lyrics', 'readonly');
      const req = tx.objectStore('lyrics').get(String(songId));
      req.onsuccess = () => {
        const val = req.result;
        resolve(
          val
            ? {
                lrc: val.lrc || '',
                tlrc: val.tlrc || '',
                romalrc: val.romalrc || '',
                yrc: val.yrc || '',
                ytlrc: val.ytlrc || '',
                yromalrc: val.yromalrc || '',
              }
            : null,
        );
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedLyric(
  songId: string | number,
  payload: LyricPayload,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('lyrics', 'readwrite');
      tx.objectStore('lyrics').put({
        songId: String(songId),
        lrc: payload.lrc || '',
        tlrc: payload.tlrc || '',
        romalrc: payload.romalrc || '',
        yrc: payload.yrc || '',
        ytlrc: payload.ytlrc || '',
        yromalrc: payload.yromalrc || '',
        timestamp: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getDbCacheStats(): Promise<{ playlistCount: number; lyricCount: number }> {
  const db = await openDb();
  if (!db) return { playlistCount: 0, lyricCount: 0 };
  const countStore = (storeName: string): Promise<number> =>
    new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(Number(req.result) || 0);
        req.onerror = () => resolve(0);
      } catch {
        resolve(0);
      }
    });
  const [playlistCount, lyricCount] = await Promise.all([
    countStore('playlists'),
    countStore('lyrics'),
  ]);
  return { playlistCount, lyricCount };
}

export async function clearDbCaches(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(['playlists', 'lyrics'], 'readwrite');
      tx.objectStore('playlists').clear();
      tx.objectStore('lyrics').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
