import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findActiveLyricIndex } from '../services/lyrics';
import { triggerHaptic } from '../services/transport';
import {
  getPreciseAudioTime,
  trackCoverOrFallback,
  usePlayerStore,
} from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf, type LyricLine } from '../types/music';
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

interface LyricRowProps {
  line: LyricLine;
  index: number;
  activeIndex: number;
  displayTime: number;
  isScrubbing: boolean;
  isPlaying: boolean;
  showLyrics: boolean;
  userBrowsing: boolean;
  onSeek: (time: number) => void;
  setRef: (el: HTMLDivElement | null) => void;
}

/**
 * Renders one lyric line.
 * When `line.words` (YRC verbatim syllables) is present on the active line, runs a
 * zero-React-rerender 60fps RAF loop updating `--word-p` and `data-state` directly on spans.
 */
function LyricRow({
  line,
  index,
  activeIndex,
  displayTime,
  isScrubbing,
  isPlaying,
  showLyrics,
  userBrowsing,
  onSeek,
  setRef,
}: LyricRowProps) {
  const isActive = index === activeIndex;
  const isPast = activeIndex >= 0 && index < activeIndex;
  const dist = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0;
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  const hasWords = Boolean(line.words && line.words.length > 0);

  useEffect(() => {
    if (!hasWords || !line.words) return;

    const applyAtTime = (t: number) => {
      const words = line.words!;
      for (let i = 0; i < words.length; i++) {
        const span = wordRefs.current[i];
        if (!span) continue;
        const w = words[i];
        if (!isActive) {
          span.dataset.state = isPast ? 'past' : 'future';
          span.style.setProperty('--word-p', isPast ? '100%' : '0%');
          continue;
        }
        const elapsed = t - w.startTime;
        if (elapsed <= 0) {
          span.dataset.state = 'future';
          span.style.setProperty('--word-p', '0%');
        } else if (elapsed >= w.duration) {
          span.dataset.state = 'past';
          span.style.setProperty('--word-p', '100%');
        } else {
          const p = Math.max(0, Math.min(1, elapsed / w.duration));
          span.dataset.state = 'active';
          span.style.setProperty('--word-p', `${(p * 100).toFixed(2)}%`);
        }
      }
    };

    const readPreciseTime = (): number => {
      if (isScrubbing || !isPlaying) return displayTime;
      const engineTime = getPreciseAudioTime();
      return engineTime > 0 ? engineTime : usePlayerStore.getState().currentTime;
    };

    applyAtTime(readPreciseTime());

    if (!isActive || !showLyrics || !isPlaying || isScrubbing) return;

    let rafId = 0;
    const tick = () => {
      applyAtTime(readPreciseTime());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [hasWords, line.words, isActive, isPast, showLyrics, isPlaying, isScrubbing, displayTime]);

  const depthClass = isActive
    ? 'active'
    : !userBrowsing && dist >= 3
      ? 'far'
      : !userBrowsing && dist === 2
        ? 'mid'
        : '';

  return (
    <div
      ref={setRef}
      className={`lyric-line ${depthClass}`}
      onPointerDown={(e) => {
        downPosRef.current = { x: e.clientX, y: e.clientY };
      }}
      onClick={(e) => {
        e.stopPropagation();
        const dp = downPosRef.current;
        if (dp && Math.hypot(e.clientX - dp.x, e.clientY - dp.y) > 10) return;
        onSeek(line.time);
        void triggerHaptic('selection');
      }}
    >
      <div className="lyric-main">
        {hasWords && line.words
          ? line.words.map((w, wi) => (
              <span
                key={`${wi}-${w.startTime}`}
                ref={(el) => {
                  wordRefs.current[wi] = el;
                }}
                className="yrc-word"
                data-state={isPast ? 'past' : 'future'}
              >
                {w.text}
              </span>
            ))
          : line.text}
      </div>
      {line.romaji && <span className="lrc-romaji">{line.romaji}</span>}
      {line.translation && <span className="tlrc">{line.translation}</span>}
    </div>
  );
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
  const [userBrowsing, setUserBrowsing] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const lyricsBoxRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const progressRef = useRef<HTMLDivElement | null>(null);

  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const vinylDownRef = useRef<{ x: number; y: number } | null>(null);
  const lyricsDownRef = useRef<{ x: number; y: number } | null>(null);

  const programmaticScrollRef = useRef(false);
  const scrollAnimRafRef = useRef<number | null>(null);
  const progScrollClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchingLyricsRef = useRef(false);

  const displayTime = scrubTime !== null ? scrubTime : currentTime;
  const ratio = duration > 0 ? Math.max(0, Math.min(1, displayTime / duration)) : 0;

  const activeLyricIdx = useMemo(
    () => findActiveLyricIndex(lyrics, displayTime),
    [lyrics, displayTime],
  );

  const cancelScrollAnim = useCallback(() => {
    if (scrollAnimRafRef.current !== null) {
      cancelAnimationFrame(scrollAnimRafRef.current);
      scrollAnimRafRef.current = null;
    }
    if (progScrollClearRef.current) {
      clearTimeout(progScrollClearRef.current);
      progScrollClearRef.current = null;
    }
    programmaticScrollRef.current = false;
  }, []);

  /**
   * Custom smooth RAF scroll on ONLY `.lyrics-box` (never calls `scrollIntoView()`,
   * which would scroll `.player-stage` horizontally inside the 200% carousel).
   */
  const animateScrollTop = useCallback(
    (box: HTMLDivElement, rawTargetTop: number, durationMs = 460) => {
      cancelScrollAnim();
      const maxScroll = Math.max(0, box.scrollHeight - box.clientHeight);
      const target = Math.max(0, Math.min(maxScroll, rawTargetTop));
      programmaticScrollRef.current = true;

      if (durationMs <= 0 || Math.abs(target - box.scrollTop) < 1) {
        box.scrollTop = target;
        progScrollClearRef.current = setTimeout(() => {
          programmaticScrollRef.current = false;
        }, 60);
        return;
      }

      const startTop = box.scrollTop;
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        box.scrollTop = startTop + (target - startTop) * eased;
        if (t < 1) {
          scrollAnimRafRef.current = requestAnimationFrame(step);
        } else {
          scrollAnimRafRef.current = null;
          progScrollClearRef.current = setTimeout(() => {
            programmaticScrollRef.current = false;
          }, 60);
        }
      };
      scrollAnimRafRef.current = requestAnimationFrame(step);
    },
    [cancelScrollAnim],
  );

  const scrollToActiveLyric = useCallback(
    (durationMs = 460) => {
      const box = lyricsBoxRef.current;
      const idx = activeLyricIdx >= 0 ? activeLyricIdx : 0;
      const lineEl = lineRefs.current[idx];
      if (!box || !lineEl) return;
      const targetTop = lineEl.offsetTop - box.clientHeight * 0.42 + lineEl.clientHeight / 2;
      animateScrollTop(box, targetTop, durationMs);
    },
    [activeLyricIdx, animateScrollTop],
  );

  const scrollToActiveRef = useRef(scrollToActiveLyric);
  scrollToActiveRef.current = scrollToActiveLyric;

  // Defensively ensure stage horizontal scroll never drifts, and snap lyrics when opened
  useEffect(() => {
    if (stageRef.current) {
      stageRef.current.scrollLeft = 0;
    }
    if (showLyrics) {
      setUserBrowsing(false);
      if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
      const t = setTimeout(() => scrollToActiveRef.current(0), 50);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [showLyrics]);

  // Reset browse state on track change
  useEffect(() => {
    cancelScrollAnim();
    setUserBrowsing(false);
    if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
    if (lyricsBoxRef.current) {
      programmaticScrollRef.current = true;
      lyricsBoxRef.current.scrollTop = 0;
      progScrollClearRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 60);
    }
  }, [currentTrack?.id, cancelScrollAnim]);

  // Auto-follow active lyric whenever playing progresses or user idle auto-resumes
  useEffect(() => {
    if (!showLyrics || userBrowsing || activeLyricIdx < 0) return;
    scrollToActiveRef.current(460);
  }, [activeLyricIdx, showLyrics, userBrowsing]);

  useEffect(() => {
    return () => {
      cancelScrollAnim();
      if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
    };
  }, [cancelScrollAnim]);

  const scheduleAutoResume = () => {
    cancelScrollAnim();
    setUserBrowsing(true);
    if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
    userIdleTimerRef.current = setTimeout(() => {
      if (touchingLyricsRef.current) return;
      setUserBrowsing(false);
    }, 2200);
  };

  const handleLyricsUserScroll = () => {
    if (programmaticScrollRef.current) return;
    scheduleAutoResume();
  };

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

  const teaserLine = activeLyricIdx >= 0 ? lyrics[activeLyricIdx] : null;

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

      {/* Center Stage: Slide 0 (Black Vinyl) <-> Slide 1 (Verbatim Scrolling Lyrics) */}
      <div
        ref={stageRef}
        className="player-stage"
        data-testid="player-stage"
        onPointerDown={(e) => {
          swipeStartRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const st = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!st) return;
          const dx = e.clientX - st.x;
          const dy = e.clientY - st.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (dx < 0 && !showLyrics) setShowLyrics(true);
            if (dx > 0 && showLyrics) setShowLyrics(false);
          }
        }}
        onPointerCancel={() => {
          swipeStartRef.current = null;
        }}
      >
        <div className={`stage-track ${showLyrics ? 'show-lyrics' : ''}`}>
          {/* Slide 1: Authentic Black Vinyl Disc */}
          <div className="stage-slide" data-testid="slide-vinyl">
            <div
              className="vinyl-wrap tap-soft"
              onPointerDown={(e) => {
                vinylDownRef.current = { x: e.clientX, y: e.clientY };
              }}
              onClick={(e) => {
                const d = vinylDownRef.current;
                if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
                setShowLyrics(true);
              }}
              title="点击或左滑查看歌词"
            >
              <div className={`vinyl-disc ${isPlaying ? 'playing' : ''}`}>
                <div className="vinyl-cover">
                  <img src={trackCoverOrFallback(currentTrack)} alt="" />
                </div>
                <div className="vinyl-spindle" />
              </div>
            </div>

            <div
              className="lyric-teaser tap"
              onPointerDown={(e) => {
                vinylDownRef.current = { x: e.clientX, y: e.clientY };
              }}
              onClick={(e) => {
                const d = vinylDownRef.current;
                if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
                setShowLyrics(true);
              }}
            >
              {teaserLine?.text ||
                (currentTrack ? '轻点黑胶查看歌词' : '在歌单或搜索中选歌播放')}
            </div>
          </div>

          {/* Slide 2: Scrolling Verbatim YRC / LRC / TLRC Lyrics */}
          <div className="stage-slide" data-testid="slide-lyrics" style={{ position: 'relative' }}>
            <div
              ref={lyricsBoxRef}
              className="lyrics-box"
              data-testid="lyrics-box"
              onScroll={handleLyricsUserScroll}
              onWheel={() => scheduleAutoResume()}
              onTouchStart={() => {
                touchingLyricsRef.current = true;
                scheduleAutoResume();
              }}
              onTouchMove={() => {
                touchingLyricsRef.current = true;
                scheduleAutoResume();
              }}
              onTouchEnd={() => {
                touchingLyricsRef.current = false;
                scheduleAutoResume();
              }}
              onTouchCancel={() => {
                touchingLyricsRef.current = false;
                scheduleAutoResume();
              }}
              onPointerDown={(e) => {
                lyricsDownRef.current = { x: e.clientX, y: e.clientY };
              }}
              onClick={(e) => {
                const d = lyricsDownRef.current;
                if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
                setShowLyrics(false);
              }}
            >
              {lyrics.length > 0 ? (
                lyrics.map((line, idx) => (
                  <LyricRow
                    key={`${line.time}-${idx}`}
                    line={line}
                    index={idx}
                    activeIndex={activeLyricIdx}
                    displayTime={displayTime}
                    isScrubbing={scrubTime !== null}
                    isPlaying={isPlaying}
                    showLyrics={showLyrics}
                    userBrowsing={userBrowsing}
                    setRef={(el) => {
                      lineRefs.current[idx] = el;
                    }}
                    onSeek={(t) => {
                      if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
                      setUserBrowsing(false);
                      seekTo(t);
                    }}
                  />
                ))
              ) : (
                <div className="empty-box">
                  <span>{currentTrack ? '暂无同步歌词' : '尚未开始播放'}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>轻点空白处或右滑返回黑胶</span>
                </div>
              )}
            </div>

            {userBrowsing && lyrics.length > 0 && (
              <button
                type="button"
                className="pill-btn tap lyric-resume-pill"
                onClick={(e) => {
                  e.stopPropagation();
                  if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
                  setUserBrowsing(false);
                  scrollToActiveLyric(460);
                }}
              >
                回到当前歌词
              </button>
            )}
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
