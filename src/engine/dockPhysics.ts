/**
 * Pure, deterministic physics & gesture math for:
 * 1. Hachimi `BlurBottomBar`-style draggable liquid-glass navigation capsule
 * 2. RikkaHub-style multi-detent draggable bottom sheet
 *
 * Fixes every classic drag bug:
 * - Zero jump on pointerdown/move when grabbing the active pill (relative delta tracking!)
 * - Smooth rubber-band damping beyond [0, maxIndex]
 * - Rolling 80ms velocity sampler clamped to prevent 1ms pointer jitter spikes
 * - Edge-safe elastic liquid stretch that tapers cleanly near outer capsule boundaries
 */

export interface VelocitySample {
  pos: number;
  time: number;
}

export class RollingVelocity {
  private samples: VelocitySample[] = [];
  private windowMs: number;
  private maxSpeed: number;

  constructor(windowMs = 80, maxSpeed = 14) {
    this.windowMs = windowMs;
    this.maxSpeed = maxSpeed;
  }

  public reset(pos: number, time: number): void {
    this.samples = [{ pos, time }];
  }

  public push(pos: number, time: number): void {
    this.samples.push({ pos, time });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  /** Returns velocity in units per second, smoothly clamped against spike artifacts. */
  public getVelocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dtMs = last.time - first.time;
    if (dtMs < 6) return 0;
    const raw = ((last.pos - first.pos) / dtMs) * 1000;
    return Math.max(-this.maxSpeed, Math.min(this.maxSpeed, raw));
  }
}

/**
 * Applies smooth asymptotic rubber-band resistance outside [min, max].
 * Never allows harsh over-stretch or clipping.
 */
export function rubberBand(value: number, min: number, max: number, limit = 0.22): number {
  if (value < min) {
    const over = min - value;
    return min - (limit * over) / (over + limit * 2.2);
  }
  if (value > max) {
    const over = value - max;
    return max + (limit * over) / (over + limit * 2.2);
  }
  return value;
}

/**
 * Computes drag position for the bottom capsule pill:
 * - If the user grabbed the currently active slot (grabbedActive=true),
 *   movement is 100% relative to the initial touch point -> ZERO jump!
 * - If the user touched another slot and started dragging, the pill smoothly
 *   tracks toward the finger slot center without teleporting abruptly on pixel 1.
 */
export function computeCapsuleDragPos(params: {
  grabbedActive: boolean;
  startPos: number;
  dx: number;
  slotWidth: number;
  pointerRelX: number;
  dragBlend: number; // 0..1 ramps up over first 28px of drag
  maxIndex: number;
}): number {
  const { grabbedActive, startPos, dx, slotWidth, pointerRelX, dragBlend, maxIndex } = params;
  if (slotWidth <= 0) return startPos;

  let raw: number;
  if (grabbedActive) {
    raw = startPos + dx / slotWidth;
  } else {
    const fingerSlot = pointerRelX / slotWidth - 0.5;
    const t = Math.max(0, Math.min(1, dragBlend));
    raw = startPos + (fingerSlot - startPos) * t;
  }
  return rubberBand(raw, 0, maxIndex, 0.2);
}

/**
 * Computes edge-safe liquid glass pill stretch (scaleX, scaleY).
 * Tapers stretch down to 1.0 near the outer edges (0 and maxIndex) so the pill
 * NEVER clips awkwardly against the outer capsule's border-radius!
 */
export function computeLiquidStretch(
  pos: number,
  velocitySlotsPerSec: number,
  maxIndex: number,
): { scaleX: number; scaleY: number } {
  const edgeDist = Math.min(Math.max(0, pos), Math.max(0, maxIndex - pos));
  // Full stretch in interior (>= 0.25 slots from edge), softly tapered to 0.25x at edges
  const edgeFactor = 0.25 + 0.75 * Math.min(1, edgeDist / 0.25);
  const speed = Math.min(Math.abs(velocitySlotsPerSec), 12);
  const stretch = Math.min(speed * 0.015, 0.13) * edgeFactor;
  return {
    scaleX: 1 + stretch,
    scaleY: 1 - stretch * 0.38,
  };
}

/**
 * Determines the snapped target tab on release using position + release velocity.
 */
export function resolveSnapTab(pos: number, velSlotsPerSec: number, maxIndex: number): number {
  const projected = pos + velSlotsPerSec * 0.075;
  return Math.max(0, Math.min(maxIndex, Math.round(projected)));
}

/**
 * Advances a critically-damped / mildly underdamped spring by dt seconds.
 */
export function stepSpring(
  pos: number,
  vel: number,
  target: number,
  dt: number,
  stiffness = 320,
  damping = 28,
): { pos: number; vel: number; settled: boolean } {
  const clampedDt = Math.min(Math.max(dt, 0.001), 0.032);
  const force = (target - pos) * stiffness;
  const accel = force - damping * vel;
  const nextVel = vel + accel * clampedDt;
  const nextPos = pos + nextVel * clampedDt;
  const settled = Math.abs(target - nextPos) < 0.0015 && Math.abs(nextVel) < 0.008;
  return settled
    ? { pos: target, vel: 0, settled: true }
    : { pos: nextPos, vel: nextVel, settled: false };
}

export type SheetDetent = 'closed' | 'half' | 'full';

/**
 * Velocity-aware snap resolver for multi-detent Bottom Sheet (fullY=0, halfY, closedY).
 * Uses asymmetric thresholds so carefully dragging UP from the bottom dock opens reliably
 * even if the user pauses briefly before releasing (velocity ~ 0).
 */
export function resolveSheetDetent(
  offsetY: number,
  velPxPerSec: number,
  halfY: number,
  closedY: number,
  startedFromClosed = false,
): SheetDetent {
  if (startedFromClosed) {
    // Opening gesture from bottom dock: modest drag (~110px) or gentle flick opens smoothly
    if (velPxPerSec < -450) {
      return offsetY < halfY * 0.85 ? 'full' : 'half';
    }
    if (velPxPerSec > 700) {
      return 'closed';
    }
    const openThreshold = closedY - 180; // peekY starts at closedY - 84 -> ~96px drag opens
    if (offsetY > openThreshold) return 'closed';
    if (offsetY <= halfY * 0.52) return 'full';
    return 'half';
  }

  // Fast downward flick immediately closes or drops a detent
  if (velPxPerSec > 800) {
    return offsetY > halfY * 0.45 ? 'closed' : 'half';
  }
  // Fast upward flick expands cleanly
  if (velPxPerSec < -800) {
    return offsetY < halfY * 1.15 ? 'full' : 'half';
  }

  const projected = offsetY + velPxPerSec * 0.12;
  const closeThreshold = halfY + (closedY - halfY) * 0.38;
  const fullThreshold = halfY * 0.48;

  if (projected >= closeThreshold) return 'closed';
  if (projected <= fullThreshold) return 'full';
  return 'half';
}
