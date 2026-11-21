const STORAGE_KEY = 'cp_search_history';
const MAX_HISTORY = 10;

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageBackend | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadSearchHistory(storage: StorageBackend | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export function pushSearchHistory(
  term: string,
  storage: StorageBackend | null = defaultStorage(),
): string[] {
  const clean = term.trim();
  const current = loadSearchHistory(storage);
  if (!clean) return current;
  const lower = clean.toLowerCase();
  const next = [clean, ...current.filter((item) => item.toLowerCase() !== lower)].slice(
    0,
    MAX_HISTORY,
  );
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota errors
  }
  return next;
}

export function removeSearchHistoryItem(
  term: string,
  storage: StorageBackend | null = defaultStorage(),
): string[] {
  const lower = term.trim().toLowerCase();
  const next = loadSearchHistory(storage).filter((item) => item.toLowerCase() !== lower);
  try {
    if (next.length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors
  }
  return next;
}

export function clearSearchHistory(storage: StorageBackend | null = defaultStorage()): string[] {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
  return [];
}
