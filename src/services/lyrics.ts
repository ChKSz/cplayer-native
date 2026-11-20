import type { LyricLine } from '../types/music';

interface RawLyricLine {
  time: number;
  text: string;
}

export function parseLrc(text: string): RawLyricLine[] {
  if (!text) return [];
  const lines = text.split('\n');
  const res: RawLyricLine[] = [];
  const regex = /^\[(\d{1,3}):(\d{1,2})(\.\d{1,3})?\](.*)/;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('{')) continue;

    // Support multiple timestamps on one line, e.g. [00:12.00][01:02.00]Lyrics
    let rest = line;
    const times: number[] = [];
    while (true) {
      const m = rest.match(regex);
      if (!m) break;
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const msStr = m[3] ? m[3].substring(1) : '0';
      const ms = parseInt(msStr.padEnd(3, '0').substring(0, 3), 10);
      times.push(min * 60 + sec + ms / 1000);
      rest = m[4].trim();
    }
    if (times.length > 0 && rest) {
      for (const time of times) {
        res.push({ time, text: rest });
      }
    }
  }
  return res.sort((a, b) => a.time - b.time);
}

export function parseLyrics(lrc: string, tlrc = ''): LyricLine[] {
  const origin = parseLrc(lrc);
  const trans = parseLrc(tlrc);

  const findTranslation = (time: number): string | null => {
    if (!trans.length) return null;
    const exact = trans.find((t) => Math.abs(t.time - time) < 0.5);
    if (exact) return exact.text;
    const rounded = trans.find((t) => t.time.toFixed(0) === time.toFixed(0));
    return rounded ? rounded.text : null;
  };

  return origin.map((item) => ({
    time: item.time,
    text: item.text,
    translation: findTranslation(item.time),
  }));
}

export function findActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
  if (!lines.length) return -1;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (currentTime >= lines[i].time) active = i;
    else break;
  }
  return active;
}
