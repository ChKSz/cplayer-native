import { useEffect, useMemo, useRef, useState } from 'react';
import { findActiveLyricIndex } from '../services/lyrics';
import { triggerHaptic } from '../services/transport';
import { trackCoverOrFallback, usePlayerStore } from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf } from '../types/music';
import {
  IconChevronDown,
  IconLyrics,
  IconMore,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconRepeat,
  IconUser,
} from './Icons';

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function PlayerPage() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const playMode = usePlayerStore((s) => s.playMode);
  const quality = usePlayerStore((s) => s.quality);
  const actualQualityText = usePlayerStore((s) => s.actualQualityText);
  const lyrics = usePlayerStore((s) => s.lyrics);
  const showLyrics = usePlayerStore((s) => s.showLyrics);
  const user = usePlayerStore((s) => s.user);
  const syncStatus = usePlayerStore((s) => s.syncStatus);

  const setShowLyrics = usePlayerStore((s) => s.setShowLyrics);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const playPrev = usePlayerStore((s) => s.playPrev);
  const playNext = usePlayerStore((s) => s.playNext);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const cyclePlayMode = usePlayerStore((s) => s.cyclePlayMode);
  const openSheet = usePlayerStore((s) => s.openSheet);

  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const activeLyricRef = useRef<HTMLDivElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const displayTime = scrubTime !== null ? scrubTime : currentTime;
  const ratio = duration > 0 ? Math.max(0, Math.min(1, displayTime / duration)) : 0;

  const activeLyricIdx = useMemo(
    () => findActiveLyricIndex(lyrics, displayTime),
    [lyrics, displayTime],
  );

  useEffect(() => {
    if (showLyrics && activeLyricRef.current) {
      activeLyricRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeLyricIdx, showLyrics]);

  const src = songSourceOf(currentTrack?.id);
  const qualityLabel =
    actualQualityText ||
    QUALITY_OPTIONS.find((q) => q.level === quality)?.name ||
    '无损';

  const calcScrub = (clientX: number) => {
    const el = progressRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return r * duration;
  };

  return (
    <section className="page" data-page="0">
      <header className="top-bar">
        <button
          type="button"
          className="pill-btn tap"
          onClick={() => openSheet('quality')}
        >
          <span className={`src-tag ${src}`}>{src.toUpperCase()}</span>
          <span>{qualityLabel}</span>
          <IconChevronDown size={12} />
        </button>

        <button
          type="button"
          className="icon-btn tap"
          aria-label="账号与云同步"
          onClick={() => openSheet('account')}
        >
          <IconUser size={18} />
          <span
            className={`sync-dot ${
              !user ? 'idle' : syncStatus === 'offline' ? 'offline' : ''
            }`}
          />
        </button>
      </header>

      {/* Center Stage: Black Vinyl <-> Scrolling Lyrics */}
      <div
        className="player-stage"
        onPointerDown={(e) => {
          swipeStartRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const st = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!st) return;
          const dx = e.clientX - st.x;
          const dy = e.clientY - st.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
            if (dx < 0 && !showLyrics) setShowLyrics(true);
            if (dx > 0 && showLyrics) setShowLyrics(false);
          }
        }}
      >
        <div className={`stage-track ${showLyrics ? 'show-lyrics' : ''}`}>
          {/* Slide 1: Authentic Black Vinyl Disc */}
          <div className="stage-slide">
            <div
              className="vinyl-wrap tap-soft"
              onClick={() => setShowLyrics(true)}
              title="点击或左滑查看歌词"
            >
              <div className={`vinyl-disc ${isPlaying ? 'playing' : ''}`}>
                <div className="vinyl-cover">
                  <img src={trackCoverOrFallback(currentTrack)} alt="" />
                </div>
                <div className="vinyl-spindle" />
              </div>
            </div>

            <div className="lyric-teaser tap" onClick={() => setShowLyrics(true)}>
              {lyrics[activeLyricIdx]?.text ||
                (currentTrack ? '轻点黑胶查看歌词' : '在歌单或搜索中选歌播放')}
            </div>
          </div>

          {/* Slide 2: Scrolling LRC / TLRC Lyrics (tap empty area to return to Vinyl) */}
          <div className="stage-slide">
            <div className="lyrics-box" onClick={() => setShowLyrics(false)}>
              {lyrics.length > 0 ? (
                lyrics.map((line, idx) => (
                  <div
                    key={`${line.time}-${idx}`}
                    ref={idx === activeLyricIdx ? activeLyricRef : null}
                    className={`lyric-line ${idx === activeLyricIdx ? 'active' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      seekTo(line.time);
                      void triggerHaptic('selection');
                    }}
                  >
                    {line.text}
                    {line.translation && <span className="tlrc">{line.translation}</span>}
                  </div>
                ))
              ) : (
                <div className="empty-box">
                  <span>{currentTrack ? '暂无同步歌词' : '尚未开始播放'}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>轻点空白处或右滑返回黑胶</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="stage-dots">
        <span className={`stage-dot ${!showLyrics ? 'active' : ''}`} />
        <span className={`stage-dot ${showLyrics ? 'active' : ''}`} />
      </div>

      {/* Song Metadata */}
      <div className="meta-row">
        <div className="meta-text">
          <h2 className="song-title">{currentTrack?.name || 'CPlayer'}</h2>
          <p className="song-artist">
            {currentTrack
              ? `${currentTrack.artist}${currentTrack.album ? ` · ${currentTrack.album}` : ''}`
              : user
                ? `已登录 · ${user.username}`
                : '登录 CPlayerSync 账号解锁多音源无损'}
          </p>
        </div>
        {currentTrack && (
          <button
            type="button"
            className="icon-btn ghost tap"
            aria-label="歌曲操作"
            onClick={() => openSheet('trackAction', currentTrack)}
          >
            <IconMore size={18} />
          </button>
        )}
      </div>

      {/* 1:1 Pointer Scrub Progress Bar */}
      <div
        ref={progressRef}
        className={`progress-wrap ${scrubTime !== null ? 'scrubbing' : ''}`}
        onPointerDown={(e) => {
          if (duration <= 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubTime(calcScrub(e.clientX));
        }}
        onPointerMove={(e) => {
          if (scrubTime !== null) setScrubTime(calcScrub(e.clientX));
        }}
        onPointerUp={(e) => {
          if (scrubTime !== null) {
            const target = calcScrub(e.clientX);
            setScrubTime(null);
            seekTo(target);
          }
        }}
        onPointerCancel={() => setScrubTime(null)}
      >
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
        <div className="time-row">
          <span>{fmtTime(displayTime)}</span>
          <span>{fmtTime(duration)}</span>
        </div>
      </div>

      {/* Restrained Transport Controls */}
      <div className="controls-row">
        <button
          type="button"
          className="ctrl-btn muted tap"
          aria-label="播放模式"
          onClick={() => {
            void triggerHaptic('selection');
            cyclePlayMode();
          }}
        >
          <IconRepeat mode={playMode} />
        </button>

        <button
          type="button"
          className="ctrl-btn tap"
          aria-label="上一首"
          onClick={() => {
            void triggerHaptic('light');
            void playPrev();
          }}
        >
          <IconPrev size={24} />
        </button>

        <button
          type="button"
          className="play-main tap"
          aria-label={isPlaying ? '暂停' : '播放'}
          onClick={() => {
            void triggerHaptic('light');
            void togglePlay();
          }}
        >
          {isBuffering ? (
            <span className="spinner dark" />
          ) : isPlaying ? (
            <IconPause size={24} />
          ) : (
            <IconPlay size={24} />
          )}
        </button>

        <button
          type="button"
          className="ctrl-btn tap"
          aria-label="下一首"
          onClick={() => {
            void triggerHaptic('light');
            void playNext();
          }}
        >
          <IconNext size={24} />
        </button>

        <button
          type="button"
          className="ctrl-btn muted tap"
          aria-label="切换歌词视图"
          onClick={() => {
            void triggerHaptic('selection');
            setShowLyrics(!showLyrics);
          }}
        >
          <IconLyrics size={20} />
        </button>
      </div>
    </section>
  );
}
