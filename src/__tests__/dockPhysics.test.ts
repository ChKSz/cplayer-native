import { describe, expect, it } from 'vitest';
import {
  computeCapsuleDragPos,
  computeLiquidStretch,
  resolveSheetDetent,
  resolveSnapTab,
  RollingVelocity,
  rubberBand,
  stepSpring,
} from '../engine/dockPhysics';

describe('Draggable Bottom Dock & Sheet Physics', () => {
  it('grabbing active pill uses relative tracking with zero jump on initial move', () => {
    // Active tab is 1, user grabs off-center inside tab 1 and drags +10px on a 100px slot
    const pos = computeCapsuleDragPos({
      grabbedActive: true,
      startPos: 1,
      dx: 10,
      slotWidth: 100,
      pointerRelX: 185, // off-center grab!
      dragBlend: 0.4,
      maxIndex: 2,
    });
    expect(pos).toBeCloseTo(1.1, 4);
  });

  it('applies smooth asymptotic rubber-band damping beyond boundaries', () => {
    const overRight = rubberBand(3.0, 0, 2, 0.2);
    expect(overRight).toBeGreaterThan(2);
    expect(overRight).toBeLessThan(2.2);

    const overLeft = rubberBand(-1.5, 0, 2, 0.2);
    expect(overLeft).toBeLessThan(0);
    expect(overLeft).toBeGreaterThan(-0.2);
  });

  it('tapers liquid stretch near outer capsule edges to prevent clipping', () => {
    const center = computeLiquidStretch(1.0, 10, 2);
    const edge = computeLiquidStretch(0.0, 10, 2);
    expect(center.scaleX).toBeGreaterThan(edge.scaleX);
    expect(edge.scaleX).toBeLessThan(1.05);
  });

  it('clamps velocity against 1ms micro-jitter spikes', () => {
    const v = new RollingVelocity(80, 14);
    v.reset(0, 1000);
    v.push(0.5, 1002); // 2ms spike -> ignored (<6ms)
    expect(v.getVelocity()).toBe(0);

    v.push(1.0, 1050); // 50ms -> 20 slots/sec -> clamped to 14
    expect(v.getVelocity()).toBe(14);
  });

  it('resolves snap tab with velocity projection and converges via spring', () => {
    expect(resolveSnapTab(0.42, 4.0, 2)).toBe(1);
    expect(resolveSnapTab(0.35, 0, 2)).toBe(0);

    let pos = 0.2;
    let vel = 2;
    let settled = false;
    for (let i = 0; i < 120; i++) {
      const next = stepSpring(pos, vel, 1, 1 / 60);
      pos = next.pos;
      vel = next.vel;
      if (next.settled) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect(pos).toBe(1);
  });

  it('resolves multi-detent bottom sheet positions and fast flicks cleanly', () => {
    expect(resolveSheetDetent(50, -1200, 175, 777)).toBe('full');
    expect(resolveSheetDetent(300, 1200, 175, 777)).toBe('closed');
    expect(resolveSheetDetent(200, 0, 175, 777)).toBe('half');
    expect(resolveSheetDetent(520, 0, 175, 777)).toBe('closed');
  });

  it('slow one-handed pull-up from bottom dock opens reliably even with zero end velocity', () => {
    // closedY=777, peekY=693, user drags up 200px -> offsetY=493, pauses (vel=0), releases
    expect(resolveSheetDetent(493, 0, 175, 777, true)).toBe('half');
    // Tiny accidental 40px pull (offsetY=653) stays closed
    expect(resolveSheetDetent(653, 0, 175, 777, true)).toBe('closed');
  });
});
