/**
 * Exact TypeScript port of CPlayer `js/media-recovery.js`.
 * Recovers only expired signed stream URLs (e.g., KuGou signed streamUrl),
 * once per explicitly selected song; never retry-loops on 403/429.
 */

export interface RecoverableMediaSnapshot {
  id: string | number;
  streamExpiresAt?: number | null;
}

export interface AudioTargetLike extends EventTarget {
  currentTime: number;
  error?: MediaError | null;
}

export interface MediaRecoveryOptions<T extends RecoverableMediaSnapshot> {
  snapshot: () => T | null;
  resolve: (id: string | number) => Promise<T>;
  current: (snapshot: T) => boolean;
  restore: (fresh: T, time: number, wasPlaying: boolean) => Promise<void>;
  failure: (error: unknown) => void;
  clock?: () => number;
}

export class MediaRecovery<T extends RecoverableMediaSnapshot> {
  private audio: AudioTargetLike;
  private snapshot: () => T | null;
  private resolveFn: (id: string | number) => Promise<T>;
  private isCurrent: (snapshot: T) => boolean;
  private restoreFn: (fresh: T, time: number, wasPlaying: boolean) => Promise<void>;
  private failureFn: (error: unknown) => void;
  private clock: () => number;

  private generation = 0;
  private attempted = false;
  private time = 0;
  private wasPlaying = false;

  private onTime: () => void;
  private onPlay: () => void;
  private onPause: () => void;
  private onError: () => void;

  constructor(audio: AudioTargetLike, options: MediaRecoveryOptions<T>) {
    this.audio = audio;
    this.snapshot = options.snapshot;
    this.resolveFn = options.resolve;
    this.isCurrent = options.current;
    this.restoreFn = options.restore;
    this.failureFn = options.failure;
    this.clock = options.clock || Date.now;

    this.reset();

    this.onTime = () => {
      this.time = audio.currentTime || this.time;
    };
    this.onPlay = () => {
      this.wasPlaying = true;
    };
    this.onPause = () => {
      if (!audio.error) this.wasPlaying = false;
    };
    this.onError = () => {
      void this.recover();
    };

    audio.addEventListener('timeupdate', this.onTime);
    audio.addEventListener('play', this.onPlay);
    audio.addEventListener('pause', this.onPause);
    audio.addEventListener('error', this.onError);
  }

  public reset(): void {
    this.generation += 1;
    this.attempted = false;
    this.time = 0;
    this.wasPlaying = false;
  }

  public async recover(): Promise<void> {
    const data = this.snapshot();
    if (!data?.streamExpiresAt || data.streamExpiresAt > this.clock() || this.attempted) {
      return;
    }
    this.attempted = true;
    const generation = this.generation;
    const time = this.audio.currentTime || this.time;
    const playing = this.wasPlaying;
    try {
      const fresh = await this.resolveFn(data.id);
      if (generation !== this.generation || !this.isCurrent(data)) return;
      await this.restoreFn(fresh, time, playing);
    } catch (error) {
      if (generation === this.generation) {
        this.failureFn(error);
      }
    }
  }

  public dispose(): void {
    this.reset();
    this.audio.removeEventListener('timeupdate', this.onTime);
    this.audio.removeEventListener('play', this.onPlay);
    this.audio.removeEventListener('pause', this.onPause);
    this.audio.removeEventListener('error', this.onError);
  }
}
