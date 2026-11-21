import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { findActiveLyricIndex } from '../services/lyrics';
import { getAdjacentIndices } from '../services/queueOrder';
import { triggerHaptic } from '../services/transport';
import {
  getPreciseAudioTime,
  trackCoverOrFallback,
  usePlayerStore,
} from '../stores/usePlayerStore';
import { QUALITY_OPTIONS, songSourceOf, type LyricLine } from '../types/music';
import {
  IconChevronDown,
  IconClose,
  IconHeart,
  IconMore,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconQueue,
  IconRepeat,
  IconSettings,
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
  focusedIndex: number;
  displayTime: number;
  isScrubbing: boolean;
  isPlaying: boolean;
  showLyrics: boolean;
  userBrowsing: boolean;
  showVerbatim: boolean;
  showTranslation: boolean;
  showRomaji: boolean;
  setRef: (el: HTMLDivElement | null) => void;
}

/**
 * Renders one lyric line.
 * When `showVerbatim` & `line.words` are enabled on the active line, runs a zero-React-rerender
 * 60fps RAF loop updating `--word-p` and `data-state` directly on syllable spans.
 */
function LyricRow({
  line,
  index,
  activeIndex,
  focusedIndex,
  displayTime,
  isScrubbing,
  isPlaying,
  showLyrics,
  userBrowsing,
  showVerbatim,
  showTranslation,
  showRomaji,
  setRef,
}: LyricRowProps) {
  const isActive = index === activeIndex;
  const isFocused = userBrowsing && index === focusedIndex;
  const isPast = activeIndex >= 0 && index < activeIndex;
  const dist = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0;
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);

  const hasWords = Boolean(showVerbatim && line.words && line.words.length > 0);

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
    : isFocused
      ? 'focused'
      : !userBrowsing && dist >= 3
        ? 'far'
        : !userBrowsing && dist === 2
          ? 'mid'
          : '';

  return (
    <div ref={setRef} className={`lyric-line ${depthClass}`}>
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
      {showRomaji && line.romaji && <span className="lrc-romaji">{line.romaji}</span>}
      {showTranslation && line.translation && <span className="tlrc">{line.translation}</span>}
    </div>
  );
}

/** Minimalist white NetEase-style tonearm SVG proportionally anchored to --vinyl-size. */
function VinylTonearm({ engaged }: { engaged: boolean }) {
  return (
    <div
      className={`vinyl-tonearm ${engaged ? 'engaged' : ''}`}
      data-testid="vinyl-tonearm"
      aria-hidden="true"
    >
      <svg viewBox="0 0 186 204" width="100%" height="100%" fill="none">
        {/* Pivot collar */}
        <circle cx="26" cy="22" r="14" fill="rgba(255,255,255,0.20)" />
        <circle cx="26" cy="22" r="7.5" fill="#ffffff" />
        {/* Curved white tonearm shaft */}
        <path
          d="M 26 22 L 54 106 Q 58 119 70 127 L 95 144"
          stroke="#ffffff"
          strokeWidth="5.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Stylus cartridge head resting squarely on black vinyl groove when engaged */}
        <g data-testid="tonearm-stylus" transform="translate(101 148) rotate(34)">
          <rect x="-11" y="-6.5" width="24" height="13" rx="3.2" fill="#ffffff" />
          <line x1="6" y1="-3.5" x2="6" y2="3.5" stroke="rgba(18,20,26,0.45)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="9.5" y1="-3.5" x2="9.5" y2="3.5" stroke="rgba(18,20,26,0.45)" strokeWidth="1.5" strokeLinecap="round" />
        </g>
      </svg>
    </div>
  );
}

export function PlayerPage() {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
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
  const showVerbatim = usePlayerStore((s) => s.showVerbatim);
  const showTranslation = usePlayerStore((s) => s.showTranslation);
  const showRomaji = usePlayerStore((s) => s.showRomaji);
  const lyricFontSize = usePlayerStore((s) => s.lyricFontSize);
  const sleepTimerMode = usePlayerStore((s) => s.sleepTimerMode);
  const favoriteTrackIds = usePlayerStore((s) => s.favoriteTrackIds);
  const failedTrackOffer = usePlayerStore((s) => s.failedTrackOffer);

  const setShowLyrics = usePlayerStore((s) => s.setShowLyrics);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const playPrev = usePlayerStore((s) => s.playPrev);
  const playNext = usePlayerStore((s) => s.playNext);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const cyclePlayMode = usePlayerStore((s) => s.cyclePlayMode);
  const openSheet = usePlayerStore((s) => s.openSheet);
  const toggleFavorite = usePlayerStore((s) => s.toggleFavorite);
  const dismissFailedOffer = usePlayerStore((s) => s.dismissFailedOffer);
  const switchSourceForTrack = usePlayerStore((s) => s.switchSourceForTrack);

  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [userBrowsing, setUserBrowsing] = useState(false);
  const [focusedLineIdx, setFocusedLineIdx] = useState(0);
  const [draggingDisc, setDraggingDisc] = useState(false);
  const [flipAngle, setFlipAngle] = useState(() => (showLyrics ? 180 : 0));

  const stageRef = useRef<HTMLDivElement | null>(null);
  const discTrackRef = useRef<HTMLDivElement | null>(null);
  const lyricsBoxRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const progressRef = useRef<HTMLDivElement | null>(null);

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

  // Adjacent tracks for 3-disc carousel (1:1 parity with playPrev/playNext)
  const { prevTrack, nextTrack } = useMemo(() => {
    if (queue.length <= 1 || currentIndex < 0) {
      return { prevTrack: currentTrack, nextTrack: currentTrack };
    }
    const { prevIndex, nextIndex } = getAdjacentIndices(queue.length, currentIndex);
    return { prevTrack: queue[prevIndex], nextTrack: queue[nextIndex] };
  }, [queue, currentIndex, currentTrack]);

  // Synchronize external store `showLyrics` changes (e.g., Android back button) to 3D flipAngle
  useEffect(() => {
    setFlipAngle((prev) => {
      const isBackShowing = Math.abs(Math.round(prev / 180)) % 2 === 1;
      if (isBackShowing === showLyrics) return prev;
      return prev + 180;
    });
  }, [showLyrics]);

  const flipStage = useCallback(
    (clientX?: number) => {
      const rect = stageRef.current?.getBoundingClientRect();
      const goRight =
        rect && typeof clientX === 'number' ? clientX >= rect.left + rect.width / 2 : true;
      setFlipAngle((a) => a + (goRight ? 180 : -180));
      setShowLyrics(!showLyrics);
      void triggerHaptic('selection');
    },
    [setShowLyrics, showLyrics],
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

  // Center active lyric cleanly whenever 3D-flipping onto lyrics face
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollLeft = 0;
    if (showLyrics) {
      setUserBrowsing(false);
      if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
      const t = setTimeout(() => scrollToActiveRef.current(0), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [showLyrics]);

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

  const computeCenterLineIndex = () => {
    const box = lyricsBoxRef.current;
    if (!box || !lyrics.length) return 0;
    const targetY = box.scrollTop + box.clientHeight * 0.42;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < lyrics.length; i++) {
      const el = lineRefs.current[i];
      if (!el) continue;
      const mid = el.offsetTop + el.clientHeight / 2;
      const d = Math.abs(mid - targetY);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const scheduleAutoResume = () => {
    cancelScrollAnim();
    setUserBrowsing(true);
    setFocusedLineIdx(computeCenterLineIndex());
    if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
    userIdleTimerRef.current = setTimeout(() => {
      if (touchingLyricsRef.current) return;
      setUserBrowsing(false);
    }, 2000);
  };

  const handleLyricsUserScroll = () => {
    if (programmaticScrollRef.current) return;
    scheduleAutoResume();
  };

  // ================= 3-Disc Horizontal Drag-to-Skip + Tap-to-Flip =================
  const discDragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    lastX: number;
    lastTime: number;
    velX: number;
    dragging: boolean;
    captured: boolean;
    width: number;
    settling: boolean;
  } | null>(null);

  const pendingSnapResetRef = useRef(false);

  const setDiscTrackPosition = useCallback((offsetPx: number, animated = false) => {
    const el = discTrackRef.current;
    if (!el) return;
    el.style.transition = animated ? 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    el.style.transform = `translate3d(calc(-33.333333% + ${offsetPx.toFixed(2)}px), 0, 0)`;
  }, []);

  // Reset carousel to center synchronously after React renders the newly active track cover (zero flash)
  useLayoutEffect(() => {
    if (pendingSnapResetRef.current) {
      pendingSnapResetRef.current = false;
      setDiscTrackPosition(0, false);
      setDraggingDisc(false);
    }
  }, [currentIndex, currentTrack?.id, setDiscTrackPosition]);

  const onDiscPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (discDragRef.current?.settling) return;
    const width = e.currentTarget.getBoundingClientRect().width || 352;
    discDragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastTime: performance.now(),
      velX: 0,
      dragging: false,
      captured: false,
      width,
      settling: false,
    };
  };

  const onDiscPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = discDragRef.current;
    if (!g || g.settling || e.pointerId !== g.id) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const now = performance.now();
    const dt = Math.max(1, now - g.lastTime);

    if (!g.dragging && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      g.dragging = true;
      setDraggingDisc(true);
      if (!g.captured) {
        g.captured = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Ignore if unavailable
        }
      }
    }

    if (g.dragging) {
      const instVx = (e.clientX - g.lastX) / dt; // px/ms
      g.velX = g.velX * 0.55 + instVx * 0.45;
      const effectiveDx = queue.length > 1 ? dx : dx * 0.24;
      setDiscTrackPosition(effectiveDx, false);
    }

    g.lastX = e.clientX;
    g.lastTime = now;
  };

  const finishDiscGesture = (e: React.PointerEvent<HTMLDivElement>, canceled = false) => {
    const g = discDragRef.current;
    if (!g || g.settling || e.pointerId !== g.id) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dist = Math.hypot(dx, dy);

    if (!g.dragging) {
      discDragRef.current = null;
      if (!canceled && dist <= 10) {
        flipStage(e.clientX);
      }
      return;
    }

    const canSkip = queue.length > 1;
    const goNext = canSkip && !canceled && (dx < -Math.min(82, g.width * 0.24) || g.velX < -0.5);
    const goPrev = canSkip && !canceled && (dx > Math.min(82, g.width * 0.24) || g.velX > 0.5);

    if (goNext || goPrev) {
      g.settling = true;
      void triggerHaptic('light');
      const targetOffset = goNext ? -g.width : g.width;
      setDiscTrackPosition(targetOffset, true);
      setTimeout(() => {
        discDragRef.current = null;
        pendingSnapResetRef.current = true;
        if (goNext) void playNext();
        else void playPrev();
        // Fallback reset in case track index didn't change (e.g. 1-song edge case)
        requestAnimationFrame(() => {
          if (pendingSnapResetRef.current) {
            pendingSnapResetRef.current = false;
            setDiscTrackPosition(0, false);
            setDraggingDisc(false);
          }
        });
      }, 270);
      return;
    }

    discDragRef.current = null;
    setDiscTrackPosition(0, true);
    setTimeout(() => setDraggingDisc(false), 260);
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

  const armEngaged = isPlaying && !draggingDisc && !showLyrics;
  const focusedLine = lyrics[focusedLineIdx];
  const isFavorite = Boolean(
    currentTrack && favoriteTrackIds.includes(String(currentTrack.id)),
  );

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

        <div className="top-bar-actions">
          <button
            type="button"
            className="icon-btn tap"
            aria-label="账号与云同步"
            data-testid="account-btn"
            onClick={() => openSheet('account')}
          >
            <IconUser size={18} />
            <span
              className={`sync-dot ${
                !user ? 'idle' : syncStatus === 'offline' ? 'offline' : ''
              }`}
            />
          </button>

          <button
            type="button"
            className="icon-btn tap"
            aria-label="应用设置"
            data-testid="settings-btn"
            onClick={() => openSheet('settings')}
          >
            <IconSettings size={18} />
            {sleepTimerMode !== 'off' && <span className="timer-dot" />}
          </button>
        </div>
      </header>

      {/* 3D Flip Stage: Front = White Tonearm + 3-Disc Drag Vinyl | Back = NetEase Centerline Lyrics */}
      <div
        ref={stageRef}
        className="player-stage flip-scene"
        data-testid="player-stage"
      >
        <div
          className="flip-card"
          data-testid="flip-card"
          style={{ transform: `rotateY(${flipAngle}deg)` }}
        >
          {/* FRONT FACE: Vinyl + Tonearm */}
          <div
            className="flip-face flip-front"
            data-testid="slide-vinyl"
            style={{ pointerEvents: showLyrics ? 'none' : 'auto' }}
            onPointerDown={onDiscPointerDown}
            onPointerMove={onDiscPointerMove}
            onPointerUp={(e) => finishDiscGesture(e, false)}
            onPointerCancel={(e) => finishDiscGesture(e, true)}
          >
            <div className="vinyl-stage-box">
              <VinylTonearm engaged={armEngaged} />

              <div className="disc-carousel-viewport">
                <div ref={discTrackRef} className="disc-track">
                  {/* Prev Disc */}
                  <div className="disc-slot" data-testid="disc-slot-prev">
                    <div className="vinyl-platter">
                      <div className="vinyl-disc">
                        <div className="vinyl-cover">
                          <img src={trackCoverOrFallback(prevTrack)} alt="" draggable={false} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Current Active Disc (NO center spindle hole!) */}
                  <div className="disc-slot" data-testid="disc-slot-current">
                    <div className="vinyl-platter" data-testid="vinyl-platter-current">
                      <div className={`vinyl-disc ${armEngaged ? 'playing' : ''}`} data-testid="vinyl-disc-current">
                        <div className="vinyl-cover" data-testid="vinyl-cover-current">
                          <img src={trackCoverOrFallback(currentTrack)} alt="" draggable={false} />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Next Disc */}
                  <div className="disc-slot" data-testid="disc-slot-next">
                    <div className="vinyl-platter">
                      <div className="vinyl-disc">
                        <div className="vinyl-cover">
                          <img src={trackCoverOrFallback(nextTrack)} alt="" draggable={false} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* BACK FACE: Verbatim Lyrics + NetEase Centerline Scrubber */}
          <div
            className="flip-face flip-back"
            data-testid="slide-lyrics"
            style={{ pointerEvents: showLyrics ? 'auto' : 'none' }}
          >
            <div
              ref={lyricsBoxRef}
              className={`lyrics-box lyric-size-${lyricFontSize}`}
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
                flipStage(e.clientX);
              }}
            >
              {lyrics.length > 0 ? (
                lyrics.map((line, idx) => (
                  <LyricRow
                    key={`${line.time}-${idx}`}
                    line={line}
                    index={idx}
                    activeIndex={activeLyricIdx}
                    focusedIndex={focusedLineIdx}
                    displayTime={displayTime}
                    isScrubbing={scrubTime !== null}
                    isPlaying={isPlaying}
                    showLyrics={showLyrics}
                    userBrowsing={userBrowsing}
                    showVerbatim={showVerbatim}
                    showTranslation={showTranslation}
                    showRomaji={showRomaji}
                    setRef={(el) => {
                      lineRefs.current[idx] = el;
                    }}
                  />
                ))
              ) : (
                <div className="empty-box">
                  <span>{currentTrack ? '纯音乐，请欣赏' : '尚未开始播放'}</span>
                  <span style={{ fontSize: 12, opacity: 0.6 }}>轻点屏幕翻回黑胶唱片</span>
                  {!user && !currentTrack && (
                    <button
                      type="button"
                      className="pill-btn tap"
                      style={{ marginTop: 6 }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        openSheet('account');
                      }}
                    >
                      登录 CPlayerSync 开启无损同步
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* NetEase-style centerline scrubber shown ONLY while manually browsing lyrics */}
            {userBrowsing && lyrics.length > 0 && focusedLine && (
              <div className="lyric-scrub-line" data-testid="lyric-scrub-line">
                <span className="lyric-scrub-time">{fmtTime(focusedLine.time)}</span>
                <span className="lyric-scrub-rule" />
                <button
                  type="button"
                  className="lyric-scrub-play tap"
                  aria-label="跳转到此句并播放"
                  data-testid="lyric-scrub-play"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (userIdleTimerRef.current) clearTimeout(userIdleTimerRef.current);
                    setUserBrowsing(false);
                    seekTo(focusedLine.time);
                    if (!isPlaying) void togglePlay();
                    void triggerHaptic('light');
                  }}
                >
                  <IconPlay size={12} />
                </button>
              </div>
            )}
          </div>
        </div>
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
                : '登录账号开启云歌单与无损聆听'}
          </p>
        </div>
        {currentTrack ? (
          <div className="meta-actions">
            <button
              type="button"
              className={`icon-btn ghost tap heart-btn ${isFavorite ? 'active' : ''}`}
              aria-label={isFavorite ? '取消喜欢' : '收藏到我喜欢的音乐'}
              data-testid="favorite-btn"
              onClick={() => {
                void triggerHaptic('selection');
                void toggleFavorite(currentTrack);
              }}
            >
              <IconHeart size={18} filled={isFavorite} />
            </button>
            <button
              type="button"
              className="icon-btn ghost tap"
              aria-label="歌曲操作"
              onClick={() => openSheet('trackAction', currentTrack)}
            >
              <IconMore size={18} />
            </button>
          </div>
        ) : (
          !user && (
            <button
              type="button"
              className="pill-btn tap"
              onClick={() => openSheet('account')}
            >
              去登录
            </button>
          )
        )}
      </div>

      {failedTrackOffer && (
        <div className="failed-banner" data-testid="failed-track-banner">
          <span className="failed-banner-text">
            「{failedTrackOffer.name}」当前音源暂不可播
          </span>
          <button
            type="button"
            className="pill-btn tap"
            style={{ height: 26, fontSize: 11.5, padding: '0 10px' }}
            onClick={() => switchSourceForTrack(failedTrackOffer)}
          >
            换源试听
          </button>
          <button
            type="button"
            className="icon-btn ghost tap"
            style={{ width: 24, height: 24 }}
            aria-label="关闭提示"
            onClick={() => dismissFailedOffer()}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

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

      {/* Restrained Transport Controls (Slot 5 is now reliable Queue button!) */}
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
          aria-label="播放队列"
          data-testid="queue-btn"
          onClick={() => {
            void triggerHaptic('light');
            openSheet('queue');
          }}
        >
          <IconQueue size={21} />
        </button>
      </div>
    </section>
  );
}
