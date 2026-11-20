import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { usePlayerStore } from './stores/usePlayerStore';
import './styles/app.css';

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__CPLAYER_STORE__ = usePlayerStore;

  // Allow isolated browser QA (`?qa=1`) to verify long-queue auto-scroll, YRC karaoke sweep,
  // and 2.2s idle lyric auto-resume without requiring live network credentials.
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('qa') === '1') {
    const qaTracks = Array.from({ length: 25 }, (_, i) => ({
      id: `qa-${i}`,
      name: `测试曲目 ${i + 1}`,
      artist: '测试歌手',
      album: '测试专辑',
      cover: '',
      source: 'ChKSz',
    }));
    const qaLyrics = Array.from({ length: 25 }, (_, i) => {
      const start = i * 3;
      return {
        time: start,
        duration: 3,
        text: `逐字测试第${i + 1}行歌词`,
        translation: `Verbatim line ${i + 1}`,
        romaji: `zhu zi di ${i + 1} hang`,
        words: [
          { startTime: start, duration: 0.7, text: '逐字' },
          { startTime: start + 0.7, duration: 0.7, text: '测试' },
          { startTime: start + 1.4, duration: 0.8, text: `第${i + 1}行` },
          { startTime: start + 2.2, duration: 0.8, text: '歌词' },
        ],
      };
    });
    setTimeout(() => {
      usePlayerStore.setState({
        queue: qaTracks,
        currentIndex: 18,
        currentTrack: qaTracks[18],
        isPlaying: true,
        duration: 240,
        currentTime: 36.35, // Mid-way through line index 12 (36.0s..39.0s), word 0!
        lyrics: qaLyrics,
      });
    }, 80);
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
