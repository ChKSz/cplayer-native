import { useEffect, useMemo, useRef } from 'react';
import {
  computeCapsuleDragPos,
  computeLiquidStretch,
  computePanelRubberBand,
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
  onVisualProgress: (continuousTabPos: number) => void;
  sheetHooks: DockExternalSheetHooks;
}

const TABS = [
  { id: 0, label: '播放', Icon: IconDisc },
  { id: 1, label: '歌单', Icon: IconMusic },
  { id: 2, label: '搜索', Icon: IconSearch },
] as const;

const MAX_TAB = TABS.length - 1;

/**
 * Generates an offscreen 128x64 radial pill displacement map for the SVG
 * `<feDisplacementMap>` liquid-glass rim refraction (neutral 128 center,
 * smooth optical curvature along the outer 26% rim of the pill).
 */
function buildLensDisplacementDataUrl(): string {
  if (typeof document === 'undefined') return '';
  try {
    const w = 128;
    const h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const img = ctx.createImageData(w, h);
    const data = img.data;
    const halfH = h / 2;
    const halfW = w / 2;
    const straightHalf = halfW - halfH; // capsule spine half-length

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5 - halfW;
        const py = y + 0.5 - halfH;
        const clampedX = Math.max(-straightHalf, Math.min(straightHalf, px));
        const dx = px - clampedX;
        const dy = py;
        const dist = Math.hypot(dx, dy) / halfH; // 0 at spine -> 1 at pill perimeter

        let nx = 0;
        let ny = 0;
        if (dist > 0.62 && dist < 1.04) {
          const rimT = Math.max(0, Math.min(1, (dist - 0.62) / 0.38));
          const mag = Math.sin(rimT * Math.PI * 0.5) * 0.92;
          const len = Math.max(0.001, Math.hypot(dx, dy));
          nx = (dx / len) * mag;
          ny = (dy / len) * mag;
        }

        const idx = (y * w + x) * 4;
        data[idx] = Math.round(128 + nx * 126);
        data[idx + 1] = Math.round(128 + ny * 126);
        data[idx + 2] = 128;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return '';
  }
}

export function DraggableBottomDock({ onVisualProgress, sheetHooks }: DraggableBottomDockProps) {
  const activeTab = usePlayerStore((s) => s.activeTab);
  const setActiveTab = usePlayerStore((s) => s.setActiveTab);
  const openSheet = usePlayerStore((s) => s.openSheet);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  const capsuleRef = useRef<HTMLElement | null>(null);
  const lensRef = useRef<HTMLDivElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  const baseItemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const orbBtnRef = useRef<HTMLButtonElement | null>(null);
  const dispMapRef = useRef<SVGFEDisplacementMapElement | null>(null);

  const dispUrl = useMemo(() => buildLensDisplacementDataUrl(), []);

  // Mutable 120fps physics refs (never trigger React renders during gesture frames)
  const phys = useRef({
    pos: activeTab,
    vel: 0,
    target: activeTab,
    press: 0,
    pressTarget: 0,
    panelShift: 0,
    panelTarget: 0,
    rafId: null as number | null,
    lastHapticTab: activeTab,
    isDragging: false,
    slotW: 96,
  });

  const applyDOM = (pos: number, press: number, vel: number, panelShift: number) => {
    const p = phys.current;
    const el = capsuleRef.current;
    if (el) {
      const slotW = (el.clientWidth - 8) / TABS.length;
      if (slotW > 0) p.slotW = slotW;
      const barScale = 1 + 0.025 * press;
      el.style.transform = `translate3d(${panelShift.toFixed(2)}px, 0, 0) scale(${barScale.toFixed(4)})`;
    }

    const { scaleX, scaleY } = computeLiquidStretch(pos, vel, MAX_TAB, press);
    const txPx = pos * p.slotW;

    const lens = lensRef.current;
    if (lens) {
      lens.style.width = `${p.slotW.toFixed(2)}px`;
      lens.style.transform = `translate3d(${txPx.toFixed(2)}px, 0, 0) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
      lens.style.setProperty('--press', press.toFixed(3));
      lens.classList.toggle('is-liquid', press > 0.04);
    }

    const portal = portalRef.current;
    if (portal) {
      portal.style.width = `${(p.slotW * TABS.length).toFixed(2)}px`;
      portal.style.transform = `translate3d(${(-txPx).toFixed(2)}px, 0, 0)`;
    }

    if (dispMapRef.current) {
      dispMapRef.current.setAttribute('scale', (press * 13).toFixed(2));
    }

    const clamped = Math.max(0, Math.min(MAX_TAB, pos));
    onVisualProgress(clamped);

    const nearest = Math.max(0, Math.min(MAX_TAB, Math.round(clamped)));
    baseItemRefs.current.forEach((item, i) => {
      if (item) item.classList.toggle('active', i === nearest);
    });

    // Keep bottom-right orb always present; morph smoothly between Queue (Tab 0) and Mini-Vinyl (Tabs 1 & 2)
    if (orbBtnRef.current) {
      orbBtnRef.current.classList.toggle('mode-player', clamped > 0.45);
    }

    if (p.isDragging && nearest !== p.lastHapticTab) {
      p.lastHapticTab = nearest;
      void triggerHaptic('selection');
    }
  };

  const stopAnim = () => {
    if (phys.current.rafId !== null) {
      cancelAnimationFrame(phys.current.rafId);
      phys.current.rafId = null;
    }
  };

  const ensureAnimLoop = () => {
    if (phys.current.rafId !== null) return;
    let last = performance.now();

    const tick = (now: number) => {
      const p = phys.current;
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
      last = now;

      // Press & panel rubber-band approach
      const pressAlpha = 1 - Math.exp(-dt * 18);
      p.press += (p.pressTarget - p.press) * pressAlpha;
      if (Math.abs(p.pressTarget - p.press) < 0.004) p.press = p.pressTarget;

      if (!p.isDragging) {
        p.panelShift += (p.panelTarget - p.panelShift) * (1 - Math.exp(-dt * 14));
        if (Math.abs(p.panelShift) < 0.05) p.panelShift = 0;

        const res = stepSpring(p.pos, p.vel, p.target, dt, 340, 29);
        p.pos = res.pos;
        p.vel = res.vel;

        applyDOM(p.pos, p.press, p.vel, p.panelShift);

        const done =
          res.settled &&
          p.press === p.pressTarget &&
          p.panelShift === 0;
        if (done) {
          p.rafId = null;
          return;
        }
      } else {
        applyDOM(p.pos, p.press, p.vel, p.panelShift);
      }

      p.rafId = requestAnimationFrame(tick);
    };
    phys.current.rafId = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!phys.current.isDragging && Math.abs(phys.current.target - activeTab) > 0.001) {
      phys.current.target = activeTab;
      ensureAnimLoop();
    }
  }, [activeTab]);

  useEffect(() => {
    const syncLayout = () => applyDOM(phys.current.pos, phys.current.press, 0, phys.current.panelShift);
    syncLayout();
    window.addEventListener('resize', syncLayout);
    return () => {
      window.removeEventListener('resize', syncLayout);
      stopAnim();
    };
  }, []);

  const navGestureRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    slotW: number;
    totalW: number;
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

    const rect = el.getBoundingClientRect();
    const slotW = (rect.width - 8) / TABS.length;
    const relX = e.clientX - rect.left - 4;
    const tappedTab = Math.max(0, Math.min(MAX_TAB, Math.floor(relX / slotW)));
    const grabbedActive = Math.abs(phys.current.pos - tappedTab) < 0.55;

    const velTracker = new RollingVelocity(80, 14);
    velTracker.reset(phys.current.pos, performance.now());

    phys.current.slotW = slotW;
    phys.current.isDragging = true;
    phys.current.pressTarget = 1;
    phys.current.lastHapticTab = Math.round(Math.max(0, Math.min(MAX_TAB, phys.current.pos)));

    navGestureRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      slotW,
      totalW: rect.width,
      startPos: phys.current.pos,
      grabbedActive,
      tappedTab,
      axis: null,
      moved: false,
      velTracker,
    };
    el.classList.add('dragging');
    ensureAnimLoop();
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
      g.axis = dy < -10 && Math.abs(dy) > Math.abs(dx) * 1.25 ? 'y' : 'x';
      if (g.axis === 'y') {
        phys.current.pressTarget = 0;
        sheetHooks.beginExternalDrag('queue', e.clientY);
      }
    }

    if (g.axis === 'x') {
      const rect = el.getBoundingClientRect();
      const relX = e.clientX - rect.left - 4;
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
      phys.current.vel = g.velTracker.getVelocity();
      phys.current.panelShift = computePanelRubberBand(dx, g.totalW, 4.5);
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
    phys.current.pressTarget = 0;
    phys.current.panelTarget = 0;
    el.classList.remove('dragging');

    if (g.axis === 'y') {
      sheetHooks.endExternalDrag();
      phys.current.target = activeTab;
      ensureAnimLoop();
      return;
    }

    if (canceled) {
      phys.current.target = activeTab;
      ensureAnimLoop();
      return;
    }

    if (!g.moved) {
      if (g.tappedTab !== activeTab) void triggerHaptic('selection');
      setActiveTab(g.tappedTab);
      phys.current.target = g.tappedTab;
      phys.current.vel = 0;
      ensureAnimLoop();
      return;
    }

    const releaseVel = g.velTracker.getVelocity();
    const target = resolveSnapTab(phys.current.pos, releaseVel, MAX_TAB);
    if (target !== activeTab) void triggerHaptic('light');
    setActiveTab(target);
    phys.current.target = target;
    phys.current.vel = releaseVel * 0.45;
    ensureAnimLoop();
  };

  // Persistent bottom-right orb click action (no drag-to-pull-sheet on Tabs 1 & 2)
  const onOrbClick = () => {
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
      {/* Hidden SVG radial refraction filter for liquid-glass lens rim */}
      {dispUrl && (
        <svg
          width="0"
          height="0"
          aria-hidden="true"
          style={{ position: 'absolute', pointerEvents: 'none', opacity: 0 }}
        >
          <defs>
            <filter id="liquid-glass-lens" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
              <feImage href={dispUrl} result="dispMap" preserveAspectRatio="none" />
              <feDisplacementMap
                ref={dispMapRef}
                in="SourceGraphic"
                in2="dispMap"
                scale="0"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      )}

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
        {/* Frosted glass background & dual-peak bevel highlight */}
        <div className="nav-capsule-bg" aria-hidden="true" />

        {/* Base Tab Layer (muted when covered by the bright lens portal) */}
        <div className="nav-base-row">
          {TABS.map(({ id, label, Icon }) => (
            <div
              key={id}
              ref={(el) => {
                baseItemRefs.current[id] = el;
              }}
              className={`nav-item ${activeTab === id ? 'active' : ''}`}
              data-tab={id}
            >
              <Icon size={20} />
              <span>{label}</span>
            </div>
          ))}
        </div>

        {/* Floating Refractive Glass Droplet Lens + Synchronized Bright Portal */}
        <div ref={lensRef} className="nav-lens" data-testid="nav-pill" aria-hidden="true">
          <div ref={portalRef} className="nav-lens-portal">
            {TABS.map(({ id, label, Icon }) => (
              <div key={id} className="nav-portal-item">
                <Icon size={20} />
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="nav-lens-rim" />
        </div>
      </nav>

      {/* Persistent Companion Orb: Queue button on Tab 0, Mini-Vinyl Play/Pause on Tabs 1 & 2 */}
      <div className="dock-orb-wrap visible">
        <button
          ref={orbBtnRef}
          type="button"
          className={`dock-orb tap ${activeTab > 0 ? 'mode-player' : ''}`}
          aria-label={activeTab === 0 ? '播放队列' : isPlaying ? '暂停播放' : '继续播放'}
          data-testid={activeTab === 0 ? 'queue-btn' : 'dock-orb'}
          onClick={onOrbClick}
        >
          <span className="orb-queue-layer" aria-hidden={activeTab > 0}>
            <IconQueue size={21} />
          </span>

          <span className="orb-player-layer" aria-hidden={activeTab === 0}>
            <svg className="orb-ring" viewBox="0 0 58 58">
              <circle cx="29" cy="29" r="27" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
              <circle
                cx="29"
                cy="29"
                r="27"
                fill="none"
                stroke="rgba(255,255,255,0.88)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="169.65"
                strokeDashoffset={dashOffset}
                transform="rotate(-90 29 29)"
              />
            </svg>
            <div className={`orb-mini-disc ${isPlaying ? 'playing' : ''}`}>
              <img src={trackCoverOrFallback(currentTrack)} alt="" />
              <div className="orb-mini-mask">
                {isPlaying ? <IconPause size={15} /> : <IconPlay size={15} />}
              </div>
            </div>
          </span>
        </button>
      </div>
    </div>
  );
}
