import { describe, expect, it } from 'vitest';
import { findActiveLyricIndex, parseLrc, parseLyrics } from '../services/lyrics';

describe('Lyrics parser & time synchronization', () => {
  it('parses standard LRC, multi-timestamp lines, and skips JSON metadata', () => {
    const raw = [
      '{"t":0,"c":[{"tx":"meta"}]}',
      '[00:10.50]Line A',
      '[00:20.00][01:00.00]Chorus',
    ].join('\n');
    const lines = parseLrc(raw);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ time: 10.5, text: 'Line A' });
    expect(lines[1]).toEqual({ time: 20, text: 'Chorus' });
    expect(lines[2]).toEqual({ time: 60, text: 'Chorus' });
  });

  it('matches TLRC translations within 0.5s tolerance', () => {
    const lrc = '[00:12.10]Hello world\n[00:18.00]Second line';
    const tlrc = '[00:12.35]你好世界\n[00:18.02]第二行';
    const parsed = parseLyrics(lrc, tlrc);
    expect(parsed[0].translation).toBe('你好世界');
    expect(parsed[1].translation).toBe('第二行');
    expect(findActiveLyricIndex(parsed, 15)).toBe(0);
    expect(findActiveLyricIndex(parsed, 18.5)).toBe(1);
  });
});
