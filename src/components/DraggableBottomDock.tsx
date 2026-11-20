import { useEffect, useRef } from 'react';
import {
  computeCapsuleDragPos,
  computeLiquidStretch,
  resolveSnapTab,
  RollingVelocity,
  stepSpring,
} from '../engine/dockPhysics';
import { triggerHaptic } from '../services/transport';
import { trackCoverOrFallback, usePlayerStore } from '../stores/usePlayerStore';
import { IconDisc, IconMusic, IconPause, IconPlay, IconQueue, IconSearch } from './Icons';

export interface DockExternalSheetHooks {
  beginExternalDrag: (sheetType: 'queue', clientY: number) => void;
  moveExternalDrag: (clientY: number) => void;
  endExternalDrag: () => void;
}

interface DraggableBottomDockProps {
  /** Direct DOM callback so pager & listScrim stay 100% 60/120fps without React re-renders during drag */
  onVisualProgress: (continuousTabPos: number) => void;
  sheetHooks: DockExternalSheetHooks;
}

const TABS = [
  { id: 0, label: '播放', Icon: IconDisc },
  { id: 1, label: '歌单', Icon: IconMusic },
  { id: 2, label: '搜索', Icon: IconSearch },
] as const;

const MAX_TAB = TABS.length - 1;

export function DraggableBottomDock({ onVisualProgress, sheetHooks }: DraggableBottomDockProps) {
  const activeTab = usePlayerStore((s) => s.activeTab);
  const setActiveTab = usePlayerStore((s) => s.setActiveTab);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const openSheet = usePlayerStore((s) => s.openSheet);

  const capsuleRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const orbRef = useRef<HTMLButtonElement | null>(null);

  // Physics mutable refs (never trigger React renders at 120fps)
  const phys = useRef({
    pos: activeTab,
    vel: 0,
    target: activeTab,
    rafId: null as number | null,
    lastHapticTab: activeTab,
    isDragging: false,
  });

  const applyDOM = (pos: number, scaleX = 1, scaleY = 1) => {
    const pill = pillRef.current;
    if (pill) {
      pill.style.transform = `translate3d(${(pos * 100).toFixed(3)}%, 0, 0) scaleX(${scaleX.toFixed(4)}) scaleY(${scaleY.toFixed(4)})`;
    }
    const clamped = Math.max(0, Math.min(MAX_TAB, pos));
    onVisualProgress(clamped);

    const nearest = Math.max(0, Math.min(MAX_TAB, Math.round(clamped)));
    itemRefs.current.forEach((el, i) => {
      if (el) el.classList.toggle('active', i === nearest);
    });
    if (orbRef.current) {
      orbRef.current.classList.toggle('mode-mini', clamped > 0.45);
    }

    if (phys.current.isDragging && nearest !== phys.current.lastHapticTab) {
      phys.current.lastHapticTab = nearest;
      void triggerHaptic('selection');
    }
  };

  const stopSpring = () => {
    if (phys.current.rafId !== null) {
      cancelAnimationFrame(phys.current.rafId);
      phys.current.rafId = null;
    }
  };

  const startSpringTo = (target: number, initialVel?: number) => {
    const p = phys.current;
    p.target = Math.max(0, Math.min(MAX_TAB, target));
    if (initialVel !== undefined) p.vel = initialVel;
    stopSpring();

    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const res = stepSpring(p.pos, p.vel, p.target, dt, 330, 28);
      p.pos = res.pos;
      p.vel = res.vel;

      const { scaleX, scaleY } = res.settled
        ? { scaleX: 1, scaleY: 1 }
        : computeLiquidStretch(p.pos, p.vel, MAX_TAB);
      applyDOM(p.pos, scaleX, scaleY);

      if (res.settled) {
        p.rafId = null;
        return;
      }
      p.rafId = requestAnimationFrame(tick);
    };
    p.rafId = requestAnimationFrame(tick);
  };

  // Sync external tab changes (e.g., Android back key returning to tab 0)
  useEffect(() => {
    if (!phys.current.isDragging && Math.abs(phys.current.target - activeTab) > 0.001) {
      startSpringTo(activeTab);
    }
  }, [activeTab]);

  // Initial mount sync & cleanup
  useEffect(() => {
    applyDOM(phys.current.pos, 1, 1);
    return () => stopSpring();
  }, []);

  // Unified pointer gesture for the draggable capsule
  const navGestureRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    slotW: number;
    startPos: number;
    grabbedActive: boolean;
    tappedTab: number;
    axis: 'x' | 'y' | null;
    moved: boolean;
    velTracker: RollingVelocity;
  } | null>(null);

  const onCapsulePointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const el = capsuleRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    stopSpring();

    const rect = el.getBoundingClientRect();
    const slotW = (rect.width - 10) / TABS.length;
    const relX = e.clientX - rect.left - 5;
    const tappedTab = Math.max(0, Math.min(MAX_TAB, Math.floor(relX / slotW)));
    const grabbedActive = Math.abs(phys.current.pos - tappedTab) < 0.55;

    const velTracker = new RollingVelocity(80, 14);
    velTracker.reset(phys.current.pos, performance.now());

    phys.current.isDragging = true;
    phys.current.lastHapticTab = Math.round(Math.max(0, Math.min(MAX_TAB, phys.current.pos)));

    navGestureRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      slotW,
      startPos: phys.current.pos,
      grabbedActive,
      tappedTab,
      axis: null,
      moved: false,
      velTracker,
    };
    el.classList.add('dragging');
  };

  const onCapsulePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = navGestureRef.current;
    const el = capsuleRef.current;
    if (!g || !el || e.pointerId !== g.id) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dist = Math.hypot(dx, dy);

    if (!g.axis && dist > 7) {
      g.moved = true;
      // Lock cleanly to vertical upward pull OR horizontal capsule scrubbing
      g.axis = dy < -7 && Math.abs(dy) > Math.abs(dx) * 1.2 ? 'y' : 'x';
      if (g.axis === 'y') {
        sheetHooks.beginExternalDrag('queue', e.clientY);
      }
    }

    if (g.axis === 'x') {
      const rect = el.getBoundingClientRect();
      const relX = e.clientX - rect.left - 5;
      const dragBlend = Math.min(1, Math.abs(dx) / 28);
      const nextPos = computeCapsuleDragPos({
        grabbedActive: g.grabbedActive,
        startPos: g.startPos,
        dx,
        slotWidth: g.slotW,
        pointerRelX: relX,
        dragBlend,
        maxIndex: MAX_TAB,
      });

      g.velTracker.push(nextPos, performance.now());
      phys.current.pos = nextPos;
      const { scaleX, scaleY } = computeLiquidStretch(nextPos, g.velTracker.getVelocity(), MAX_TAB);
      applyDOM(nextPos, scaleX, scaleY);
    } else if (g.axis === 'y') {
      sheetHooks.moveExternalDrag(e.clientY);
    }
  };

  const finishCapsuleGesture = (e: React.PointerEvent<HTMLElement>, canceled = false) => {
    const g = navGestureRef.current;
    const el = capsuleRef.current;
    if (!g || !el || e.pointerId !== g.id) return;
    navGestureRef.current = null;
    phys.current.isDragging = false;
    el.classList.remove('dragging');

    if (g.axis === 'y') {
      sheetHooks.endExternalDrag();
      // Always ensure pill settles cleanly back on activeTab
      startSpringTo(activeTab, 0);
      return;
    }

    if (canceled) {
      startSpringTo(activeTab, 0);
      return;
    }

    if (!g.moved) {
      // Tap: always spring cleanly to tappedTab (even if previous animation was interrupted mid-flight!)
      if (g.tappedTab !== activeTab) void triggerHaptic('selection');
      setActiveTab(g.tappedTab);
      startSpringTo(g.tappedTab, 0);
      return;
    }

    const releaseVel = g.velTracker.getVelocity();
    const target = resolveSnapTab(phys.current.pos, releaseVel, MAX_TAB);
    if (target !== activeTab) void triggerHaptic('light');
    setActiveTab(target);
    startSpringTo(target, releaseVel * 0.45);
  };

  // Right Floating Orb gesture (Tap or Pull-Up Sheet)
  const orbGestureRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    draggingSheet: boolean;
  } | null>(null);

  const onOrbPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    orbGestureRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      draggingSheet: false,
    };
  };

  const onOrbPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = orbGestureRef.current;
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    // Require deliberate upward drag (-18px, vertically dominant) so finger jitter on taps never hijacks click
    if (!g.draggingSheet && dy < -18 && Math.abs(dy) > Math.abs(dx) * 1.25) {
      g.draggingSheet = true;
      sheetHooks.beginExternalDrag('queue', e.clientY);
    }
    if (g.draggingSheet) {
      sheetHooks.moveExternalDrag(e.clientY);
    }
  };

  const finishOrbGesture = (e: React.PointerEvent<HTMLButtonElement>, canceled = false) => {
    const g = orbGestureRef.current;
    if (!g || e.pointerId !== g.id) return;
    orbGestureRef.current = null;
    if (g.draggingSheet) {
      sheetHooks.endExternalDrag();
      return;
    }
    if (canceled) return;
    void triggerHaptic('light');
    if (activeTab === 0) {
      openSheet('queue');
    } else {
      void togglePlay();
    }
  };

  const progressRatio = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
  const dashOffset = 169.65 * (1 - progressRatio);

  return (
    <div className="dock-container">
      <nav
        ref={capsuleRef}
        className="nav-capsule"
        aria-label="底部可拖动导航栏"
        data-testid="draggable-nav-capsule"
        onPointerDown={onCapsulePointerDown}
        onPointerMove={onCapsulePointerMove}
        onPointerUp={(e) => finishCapsuleGesture(e, false)}
        onPointerCancel={(e) => finishCapsuleGesture(e, true)}
      >
        <div ref={pillRef} className="nav-pill" data-testid="nav-pill" />
        {TABS.map(({ id, label, Icon }) => (
          <div
            key={id}
            ref={(el) => {
              itemRefs.current[id] = el;
            }}
            className={`nav-item ${activeTab === id ? 'active' : ''}`}
            data-tab={id}
          >
            <Icon size={20} />
            <span>{label}</span>
          </div>
        ))}
      </nav>

      <button
        ref={orbRef}
        type="button"
        className={`dock-orb tap ${activeTab > 0 ? 'mode-mini' : ''}`}
        aria-label={activeTab === 0 ? '打开播放队列' : '播放或暂停'}
        data-testid="dock-orb"
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={(e) => finishOrbGesture(e, false)}
        onPointerCancel={(e) => finishOrbGesture(e, true)}
      >
        <svg className="orb-ring" viewBox="0 0 58 58">
          <circle cx="29" cy="29" r="27" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
          <circle
            cx="29"
            cy="29"
            r="27"
            fill="none"
            stroke="rgba(255,255,255,0.86)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="169.65"
            strokeDashoffset={dashOffset}
            transform="rotate(-90 29 29)"
          />
        </svg>
        <span className="orb-queue-icon">
          <IconQueue size={21} />
        </span>
        <div className={`orb-mini-disc ${isPlaying ? 'playing' : ''}`}>
          <img src={trackCoverOrFallback(currentTrack)} alt="" />
          <div className="orb-mini-mask">
            {isPlaying ? <IconPause size={15} /> : <IconPlay size={15} />}
          </div>
        </div>
      </button>
    </div>
  );
}
