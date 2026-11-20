import { describe, expect, it } from 'vitest';
import { MediaRecovery, type AudioTargetLike } from '../services/mediaRecovery';

interface MockSnap {
  id: string;
  streamExpiresAt: number;
}

function fixture(overrides: Partial<ConstructorParameters<typeof MediaRecovery<MockSnap>>[1]> = {}) {
  const audio = new EventTarget() as AudioTargetLike;
  audio.currentTime = 42;
  let data: MockSnap = { id: 'kg:hash', streamExpiresAt: 1 };
  let calls = 0;
  const restored: [MockSnap, number, boolean][] = [];
  const failures: unknown[] = [];

  const recovery = new MediaRecovery<MockSnap>(audio, {
    snapshot: () => data,
    resolve: async () => {
      calls++;
      return { ...data, streamExpiresAt: Date.now() + 900_000 };
    },
    current: (snap) => snap === data,
    restore: async (fresh, time, playing) => {
      restored.push([fresh, time, playing]);
    },
    failure: (err) => {
      failures.push(err);
    },
    ...overrides,
  });

  return {
    audio,
    recovery,
    replace: (v: MockSnap) => {
      data = v;
    },
    result: () => ({ calls, restored, failures }),
  };
}

describe('MediaRecovery signed stream recovery', () => {
  it('expired media re-resolves once and preserves playback position and play intent', async () => {
    const h = fixture();
    h.audio.dispatchEvent(new Event('play'));
    await h.recovery.recover();
    await h.recovery.recover();
    expect(h.result().calls).toBe(1);
    expect(h.result().restored[0][1]).toBe(42);
    expect(h.result().restored[0][2]).toBe(true);
    h.recovery.dispose();
  });

  it('unexpired media does not trigger re-parsing', async () => {
    const h = fixture();
    h.replace({ id: 'kg:hash', streamExpiresAt: Date.now() + 900_000 });
    await h.recovery.recover();
    expect(h.result().calls).toBe(0);
    h.recovery.dispose();
  });

  it('403/429 failure surfaces once without retry loops', async () => {
    let calls = 0;
    const h = fixture({
      resolve: async () => {
        calls++;
        throw Object.assign(new Error('limited'), { status: 429 });
      },
    });
    await h.recovery.recover();
    await h.recovery.recover();
    expect(calls).toBe(1);
    expect(h.result().failures.length).toBe(1);
    h.recovery.dispose();
  });

  it('switching song while re-parsing prevents stale result from replacing it', async () => {
    let finish!: (snap: MockSnap) => void;
    const h = fixture({
      resolve: () => new Promise<MockSnap>((resolve) => { finish = resolve; }),
    });
    const pending = h.recovery.recover();
    h.recovery.reset();
    finish({ id: 'old', streamExpiresAt: Date.now() + 900_000 });
    await pending;
    expect(h.result().restored.length).toBe(0);
    h.recovery.dispose();
  });
});
