import type { Track } from '../types/music';

const DB_NAME = 'CPlayer5DB';
const DB_VERSION = 2;

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
): Promise<{ lrc: string; tlrc: string } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('lyrics', 'readonly');
      const req = tx.objectStore('lyrics').get(String(songId));
      req.onsuccess = () => {
        const val = req.result;
        resolve(val ? { lrc: val.lrc || '', tlrc: val.tlrc || '' } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function setCachedLyric(
  songId: string | number,
  lrc: string,
  tlrc: string,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction('lyrics', 'readwrite');
      tx.objectStore('lyrics').put({ songId: String(songId), lrc, tlrc, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
