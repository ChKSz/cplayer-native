import { describe, expect, it } from 'vitest';
import { findActiveLyricIndex, parseLrc, parseLyrics, parseYrc } from '../services/lyrics';

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

  it('parses NetEase YRC verbatim syllable timing and skips JSON metadata', () => {
    const yrc = [
      '{"t":0,"c":[{"tx":"作词: Test"}]}',
      '[1000,2000](1000,500,0)你(1500,1500,0)好',
      '[4000,1500](4000,700,0)世(4700,800,0)界',
    ].join('\n');
    const parsed = parseYrc(yrc);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].time).toBe(1);
    expect(parsed[0].duration).toBe(2);
    expect(parsed[0].text).toBe('你好');
    expect(parsed[0].words).toEqual([
      { startTime: 1, duration: 0.5, text: '你' },
      { startTime: 1.5, duration: 1.5, text: '好' },
    ]);
    expect(parsed[1].text).toBe('世界');
  });

  it('prefers valid YRC with ytlrc/yromalrc and falls back to LRC when YRC is empty', () => {
    const withYrc = parseLyrics({
      lrc: '[00:01.00]Fallback',
      tlrc: '[00:01.00]旧译文',
      yrc: '[1000,2000](1000,500,0)你(1500,1500,0)好',
      ytlrc: '[00:01.10]Hello',
      yromalrc: '[00:01.05]ni hao',
    });
    expect(withYrc).toHaveLength(1);
    expect(withYrc[0].words).toHaveLength(2);
    expect(withYrc[0].translation).toBe('Hello');
    expect(withYrc[0].romaji).toBe('ni hao');

    const fallback = parseLyrics({
      lrc: '[00:02.00]Line LRC',
      tlrc: '[00:02.10]行级译文',
      romalrc: '[00:02.00]hang ji',
      yrc: '',
      ytlrc: '[00:02.00]Should not override',
    });
    expect(fallback).toHaveLength(1);
    expect(fallback[0].words).toBeUndefined();
    expect(fallback[0].text).toBe('Line LRC');
    expect(fallback[0].translation).toBe('行级译文');
    expect(fallback[0].romaji).toBe('hang ji');
  });
});
