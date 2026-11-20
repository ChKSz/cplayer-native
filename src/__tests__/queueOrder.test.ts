import { describe, expect, it } from 'vitest';
import {
  getAdjacentIndices,
  restoreOriginalOrder,
  shuffleQueueKeepingCurrent,
} from '../services/queueOrder';
import type { Track } from '../types/music';

function makeTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t-${i + 1}`,
    name: `Song ${i + 1}`,
    artist: `Artist ${i + 1}`,
    album: '',
    cover: '',
    source: 'wy',
  }));
}

describe('queueOrder', () => {
  it('anchors current track at index 0 and preserves every track when shuffling', () => {
    const tracks = makeTracks(8);
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const res = shuffleQueueKeepingCurrent(tracks, 3, rng);
    expect(res.currentIndex).toBe(0);
    expect(res.queue[0].id).toBe('t-4');
    expect(res.queue).toHaveLength(tracks.length);
    expect(new Set(res.queue.map((t) => t.id))).toEqual(
      new Set(tracks.map((t) => t.id)),
    );
    // Shuffled remainder should differ from sequential order
    expect(res.queue.map((t) => t.id)).not.toEqual([
      't-4',
      't-1',
      't-2',
      't-3',
      't-5',
      't-6',
      't-7',
      't-8',
    ]);
  });

  it('restores original order and locates currently playing track accurately', () => {
    const original = makeTracks(6);
    const shuffled = shuffleQueueKeepingCurrent(original, 2, () => 0.25).queue;
    const extraTrack: Track = {
      id: 't-extra',
      name: 'Extra',
      artist: 'Guest',
      album: '',
      cover: '',
      source: 'qq',
    };
    const withExtra = [shuffled[0], extraTrack, ...shuffled.slice(1)];

    const restored = restoreOriginalOrder(original, withExtra, original[4]);
    expect(restored.queue.map((t) => t.id)).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
      't-5',
      't-6',
      't-extra',
    ]);
    expect(restored.currentIndex).toBe(4);
  });

  it('computes deterministic circular prev/next indices matching vinyl carousel', () => {
    expect(getAdjacentIndices(5, 0)).toEqual({ prevIndex: 4, nextIndex: 1 });
    expect(getAdjacentIndices(5, 4)).toEqual({ prevIndex: 3, nextIndex: 0 });
    expect(getAdjacentIndices(1, 0)).toEqual({ prevIndex: 0, nextIndex: 0 });
    expect(getAdjacentIndices(0, -1)).toEqual({ prevIndex: -1, nextIndex: -1 });
  });
});
