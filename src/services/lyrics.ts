import type { LyricLine, LyricPayload, LyricWord } from '../types/music';

interface RawLyricLine {
  time: number;
  text: string;
}

export function parseLrc(text: string): RawLyricLine[] {
  if (!text) return [];
  const lines = text.split('\n');
  const res: RawLyricLine[] = [];
  const regex = /^\[(\d{1,3}):(\d{1,2})([.:]\d{1,3})?\](.*)/;

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

/**
 * Parses NetEase YRC verbatim lyrics:
 * `[lineStartMs,lineDurationMs](wordStartMs,wordDurationMs,flag)word...`
 * All timestamps are absolute milliseconds relative to song start.
 */
export function parseYrc(text: string): LyricLine[] {
  if (!text) return [];
  const lines = text.split('\n');
  const result: LyricLine[] = [];
  const lineRegex = /^\[(\d+),(\d+)\](.*)$/;
  const wordRegex = /\((\d+),(\d+),(\d+)\)([^(]*)/g;

  for (let raw of lines) {
    raw = raw.trim();
    if (!raw || raw.startsWith('{')) continue;

    const lineMatch = raw.match(lineRegex);
    if (!lineMatch) continue;

    const lineStartSec = parseInt(lineMatch[1], 10) / 1000;
    const lineDurSec = parseInt(lineMatch[2], 10) / 1000;
    const body = lineMatch[3];

    const words: LyricWord[] = [];
    let fullText = '';
    wordRegex.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = wordRegex.exec(body)) !== null) {
      const wordText = wm[4];
      if (!wordText) continue;
      const startTime = parseInt(wm[1], 10) / 1000;
      const duration = Math.max(0.05, parseInt(wm[2], 10) / 1000);
      words.push({ startTime, duration, text: wordText });
      fullText += wordText;
    }

    if (words.length > 0 && fullText.trim()) {
      result.push({
        time: lineStartSec,
        duration: lineDurSec,
        text: fullText,
        translation: null,
        romaji: null,
        words,
      });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

function findMatchingAuxLine(aux: RawLyricLine[], time: number): string | null {
  if (!aux.length) return null;
  let best: RawLyricLine | null = null;
  let bestDiff = 0.65;
  for (const item of aux) {
    const diff = Math.abs(item.time - time);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  }
  if (best) return best.text;
  const rounded = aux.find((t) => Math.round(t.time) === Math.round(time));
  return rounded ? rounded.text : null;
}

/**
 * Parses lyrics following ChKSz API contract:
 * Prefer valid `yrc` (with `ytlrc` -> `tlyric` and `yromalrc` -> `romalrc`);
 * fall back to `lrc` + `tlyric` + `romalrc` when `yrc` is absent.
 */
export function parseLyrics(
  lrcOrPayload: string | LyricPayload,
  tlrcFallback = '',
): LyricLine[] {
  const payload: LyricPayload =
    typeof lrcOrPayload === 'string'
      ? { lrc: lrcOrPayload, tlrc: tlrcFallback }
      : lrcOrPayload;

  const yrcLines = payload.yrc ? parseYrc(payload.yrc) : [];
  const useYrc = yrcLines.length > 0;

  const transSource = useYrc
    ? payload.ytlrc || payload.tlrc || ''
    : payload.tlrc || '';
  const romaSource = useYrc
    ? payload.yromalrc || payload.romalrc || ''
    : payload.romalrc || '';

  const transLines = parseLrc(transSource);
  const romaLines = parseLrc(romaSource);

  if (useYrc) {
    return yrcLines.map((line) => ({
      ...line,
      translation: findMatchingAuxLine(transLines, line.time),
      romaji: findMatchingAuxLine(romaLines, line.time),
    }));
  }

  const origin = parseLrc(payload.lrc || '');
  return origin.map((item) => ({
    time: item.time,
    text: item.text,
    translation: findMatchingAuxLine(transLines, item.time),
    romaji: findMatchingAuxLine(romaLines, item.time),
  }));
}

export function findActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
  if (!lines.length) return -1;
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (currentTime + 0.04 >= lines[i].time) active = i;
    else break;
  }
  return active;
}
