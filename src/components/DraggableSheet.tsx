import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import {
  resolveSheetDetent,
  RollingVelocity,
  type SheetDetent,
} from '../engine/dockPhysics';
import { triggerHaptic } from '../services/transport';

export interface DraggableSheetHandle {
  beginExternalDrag: (clientY: number) => void;
  moveExternalDrag: (clientY: number) => void;
  endExternalDrag: () => void;
  expandToFull: () => void;
}

interface DraggableSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  headerAction?: ReactNode;
  initialDetent?: 'half' | 'full';
  onClose: () => void;
  children: ReactNode;
}

/**
 * Multi-detent 1:1 draggable Bottom Sheet (RikkaHub-inspired).
 * Supports:
 * - Immediate peek from external pull-up gestures on the bottom dock/orb
 * - Dragging from the top handle area
 * - Seamless nested scroll handoff when dragging down from sheet body at scrollTop === 0
 * - Half (~64% height) <-> Full (~86% height) <-> Dismiss with velocity-aware spring snap
 */
export const DraggableSheet = forwardRef<DraggableSheetHandle, DraggableSheetProps>(
  function DraggableSheet(
    { open, title, subtitle, headerAction, initialDetent = 'half', onClose, children },
    ref,
  ) {
    const sheetRef = useRef<HTMLDivElement | null>(null);
    const backdropRef = useRef<HTMLDivElement | null>(null);
    const bodyRef = useRef<HTMLDivElement | null>(null);

    const stateRef = useRef({
      offsetY: 9999,
      detent: 'closed' as SheetDetent,
      externalActive: false,
    });

    const getMetrics = () => {
      const h = sheetRef.current?.getBoundingClientRect().height || Math.round(window.innerHeight * 0.86);
      return {
        fullY: 0,
        halfY: Math.round(h * 0.24),
        closedY: Math.round(h + 48),
      };
    };

    const setSheetY = (y: number, animated: boolean) => {
      stateRef.current.offsetY = y;
      const el = sheetRef.current;
      const bd = backdropRef.current;
      if (el) {
        el.style.transition = animated ? 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
        el.style.transform = `translate3d(0, ${y}px, 0)`;
      }
      if (bd) {
        const { closedY } = getMetrics();
        const progress = Math.max(0, Math.min(1, 1 - y / Math.max(1, closedY)));
        bd.style.transition = animated ? 'opacity 240ms ease' : 'none';
        bd.style.opacity = String(progress);
      }
    };

    const snapTo = (detent: SheetDetent) => {
      const { fullY, halfY, closedY } = getMetrics();
      stateRef.current.detent = detent;
      if (detent === 'closed') {
        setSheetY(closedY, true);
        onClose();
      } else if (detent === 'full') {
        void triggerHaptic('selection');
        setSheetY(fullY, true);
      } else {
        setSheetY(halfY, true);
      }
    };

    useEffect(() => {
      if (stateRef.current.externalActive) return;
      const { fullY, halfY, closedY } = getMetrics();
      if (open) {
        stateRef.current.detent = initialDetent;
        requestAnimationFrame(() => setSheetY(initialDetent === 'full' ? fullY : halfY, true));
      } else {
        stateRef.current.detent = 'closed';
        setSheetY(closedY, true);
      }
    }, [open, initialDetent]);

    // External drag (pulling straight up from bottom capsule or right orb)
    const extRef = useRef<{
      startY: number;
      peekY: number;
      vel: RollingVelocity;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      beginExternalDrag: (clientY: number) => {
        stateRef.current.externalActive = true;
        const { closedY } = getMetrics();
        // Start peeking immediately under finger instead of buried off-screen!
        const peekY = Math.max(0, closedY - 84);
        const vel = new RollingVelocity(80, 3200);
        vel.reset(peekY, performance.now());
        extRef.current = { startY: clientY, peekY, vel };
        setSheetY(peekY, false);
      },
      moveExternalDrag: (clientY: number) => {
        const g = extRef.current;
        if (!g) return;
        const dy = clientY - g.startY;
        let nextY = g.peekY + dy;
        if (nextY < 0) nextY *= 0.22;
        g.vel.push(nextY, performance.now());
        setSheetY(nextY, false);
      },
      endExternalDrag: () => {
        const g = extRef.current;
        extRef.current = null;
        stateRef.current.externalActive = false;
        if (!g) return;
        const { halfY, closedY } = getMetrics();
        const detent = resolveSheetDetent(
          stateRef.current.offsetY,
          g.vel.getVelocity(),
          halfY,
          closedY,
          true,
        );
        snapTo(detent);
      },
      expandToFull: () => {
        if (open) snapTo('full');
      },
    }));

    // Handle drag
    const handleDragRef = useRef<{
      id: number;
      startY: number;
      startOffset: number;
      vel: RollingVelocity;
    } | null>(null);

    const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('button, a, input')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const vel = new RollingVelocity(80, 3200);
      vel.reset(stateRef.current.offsetY, performance.now());
      handleDragRef.current = {
        id: e.pointerId,
        startY: e.clientY,
        startOffset: stateRef.current.offsetY,
        vel,
      };
    };

    const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = handleDragRef.current;
      if (!g || e.pointerId !== g.id) return;
      let nextY = g.startOffset + (e.clientY - g.startY);
      if (nextY < 0) nextY *= 0.22;
      g.vel.push(nextY, performance.now());
      setSheetY(nextY, false);
    };

    const onHandleEnd = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = handleDragRef.current;
      if (!g || e.pointerId !== g.id) return;
      handleDragRef.current = null;
      const { halfY, closedY } = getMetrics();
      const detent = resolveSheetDetent(stateRef.current.offsetY, g.vel.getVelocity(), halfY, closedY);
      snapTo(detent);
    };

    // Nested scroll handoff on sheet body (dragging down when scrollTop === 0 pulls sheet down!)
    const bodyDragRef = useRef<{
      id: number;
      startY: number;
      startOffset: number;
      active: boolean;
      vel: RollingVelocity;
    } | null>(null);

    const onBodyDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if ((bodyRef.current?.scrollTop || 0) > 2) return;
      const vel = new RollingVelocity(80, 3200);
      vel.reset(stateRef.current.offsetY, performance.now());
      bodyDragRef.current = {
        id: e.pointerId,
        startY: e.clientY,
        startOffset: stateRef.current.offsetY,
        active: false,
        vel,
      };
    };

    const onBodyMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = bodyDragRef.current;
      if (!g || e.pointerId !== g.id) return;
      const dy = e.clientY - g.startY;
      if (!g.active) {
        if (dy > 10 && (bodyRef.current?.scrollTop || 0) <= 1) {
          g.active = true;
          g.startY = e.clientY;
        } else if (dy < -8) {
          bodyDragRef.current = null;
          return;
        } else {
          return;
        }
      }
      const nextY = Math.max(0, g.startOffset + (e.clientY - g.startY));
      g.vel.push(nextY, performance.now());
      setSheetY(nextY, false);
    };

    const onBodyEnd = (e: React.PointerEvent<HTMLDivElement>) => {
      const g = bodyDragRef.current;
      if (!g || e.pointerId !== g.id) return;
      bodyDragRef.current = null;
      if (!g.active) return;
      const { halfY, closedY } = getMetrics();
      const detent = resolveSheetDetent(stateRef.current.offsetY, g.vel.getVelocity(), halfY, closedY);
      snapTo(detent);
    };

    return (
      <>
        <div
          ref={backdropRef}
          className={`sheet-backdrop ${open ? 'open' : ''}`}
          onClick={() => snapTo('closed')}
        />
        <div
          ref={sheetRef}
          className="sheet"
          role="dialog"
          aria-modal={open}
          aria-hidden={!open}
          inert={!open}
          data-testid="draggable-sheet"
          style={{
            pointerEvents: open ? 'auto' : 'none',
          }}
        >
          <div
            className="sheet-handle-area"
            data-testid="sheet-handle"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleEnd}
            onPointerCancel={onHandleEnd}
          >
            <div className="sheet-grabber" />
            <div className="sheet-header">
              <div style={{ minWidth: 0 }}>
                <h3 className="sheet-title">{title}</h3>
                {subtitle && <span className="sheet-sub">{subtitle}</span>}
              </div>
              {headerAction}
            </div>
          </div>
          <div
            ref={bodyRef}
            className="sheet-body"
            onPointerDown={onBodyDown}
            onPointerMove={onBodyMove}
            onPointerUp={onBodyEnd}
            onPointerCancel={onBodyEnd}
          >
            {children}
          </div>
        </div>
      </>
    );
  },
);
