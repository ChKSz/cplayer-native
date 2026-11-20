import type { Track } from '../types/music';

/**
 * Fisher-Yates shuffle that anchors the currently playing track at index 0,
 * so enabling shuffle never interrupts playback and prev/next vinyl covers
 * always match the exact upcoming/previous tracks in the shuffled queue.
 */
export function shuffleQueueKeepingCurrent(
  tracks: Track[],
  currentIndex: number,
  rng: () => number = Math.random,
): { queue: Track[]; currentIndex: number } {
  if (tracks.length <= 1) {
    return {
      queue: [...tracks],
      currentIndex: tracks.length === 1 ? 0 : -1,
    };
  }

  const safeIdx =
    currentIndex >= 0 && currentIndex < tracks.length ? currentIndex : 0;
  const anchor = tracks[safeIdx];
  const rest = tracks.filter((_, idx) => idx !== safeIdx);

  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = rest[i];
    rest[i] = rest[j];
    rest[j] = tmp;
  }

  return {
    queue: [anchor, ...rest],
    currentIndex: 0,
  };
}

/**
 * Restores the original playlist order when leaving shuffle mode, while
 * keeping any tracks added to the queue during shuffle and re-locating
 * the currently playing track seamlessly.
 */
export function restoreOriginalOrder(
  originalQueue: Track[],
  currentQueue: Track[],
  currentTrack: Track | null,
): { queue: Track[]; currentIndex: number } {
  if (!originalQueue.length) {
    const idx = currentTrack
      ? currentQueue.findIndex((t) => String(t.id) === String(currentTrack.id))
      : currentQueue.length > 0
        ? 0
        : -1;
    return { queue: [...currentQueue], currentIndex: idx };
  }

  const currentIds = new Set(currentQueue.map((t) => String(t.id)));
  const restored: Track[] = [];
  const seen = new Set<string>();

  for (const t of originalQueue) {
    const key = String(t.id);
    if (currentIds.has(key) && !seen.has(key)) {
      restored.push(t);
      seen.add(key);
    }
  }

  // Append any tracks added while in shuffle mode
  for (const t of currentQueue) {
    const key = String(t.id);
    if (!seen.has(key)) {
      restored.push(t);
      seen.add(key);
    }
  }

  const nextIdx = currentTrack
    ? restored.findIndex((t) => String(t.id) === String(currentTrack.id))
    : restored.length > 0
      ? 0
      : -1;

  return {
    queue: restored,
    currentIndex: nextIdx >= 0 ? nextIdx : restored.length > 0 ? 0 : -1,
  };
}

/**
 * Deterministic circular prev/next indices for both playback stepping and
 * 3-disc vinyl carousel covers, guaranteeing visual/audio 1:1 parity.
 */
export function getAdjacentIndices(
  length: number,
  currentIndex: number,
): { prevIndex: number; nextIndex: number } {
  if (length <= 0) return { prevIndex: -1, nextIndex: -1 };
  const safe = currentIndex >= 0 && currentIndex < length ? currentIndex : 0;
  return {
    prevIndex: (safe - 1 + length) % length,
    nextIndex: (safe + 1) % length,
  };
}
