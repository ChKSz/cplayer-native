import { DEFAULT_FLUID_PALETTE, type FluidPalette } from '../services/colorExtractor';

/**
 * Exact WebGL Fluid Background ported verbatim from CPlayer `index.html#L6419-L6486`
 * (Aura-Music noise + rotation + sinusoidal wave shader), enhanced with:
 * - smooth RGB color interpolation on track transitions
 * - visibilitychange background pause (0 GPU/CPU work while screen locked or app backgrounded)
 * - automatic idle sleep once paused and color transition has converged
 * - configurable power-save mode (lower DPR + 30fps cap, 15fps when obscured by list/search scrim)
 */
export class FluidBackgroundEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private program: WebGLProgram | null = null;
  private uResolution: WebGLUniformLocation | null = null;
  private uTime: WebGLUniformLocation | null = null;
  private uColor1: WebGLUniformLocation | null = null;
  private uColor2: WebGLUniformLocation | null = null;
  private uColor3: WebGLUniformLocation | null = null;
  private uColor4: WebGLUniformLocation | null = null;

  private isPlaying = true;
  private powerSave = true;
  private obscuredByList = false;
  private pageHidden = false;
  private timeAccumulator = 0;
  private lastFrameTime = performance.now();
  private lastDrawTime = 0;
  private rafId: number | null = null;
  private disposed = false;

  private currentColors: FluidPalette = DEFAULT_FLUID_PALETTE.map((c) => [...c]) as FluidPalette;
  private targetColors: FluidPalette = DEFAULT_FLUID_PALETTE.map((c) => [...c]) as FluidPalette;

  private onResizeBound: () => void;
  private onVisibilityBound: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl =
      canvas.getContext('webgl', { alpha: false, antialias: false, depth: false }) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    this.onResizeBound = () => {
      this.resize();
      this.requestSingleFrame();
    };
    this.onVisibilityBound = () => {
      this.pageHidden = typeof document !== 'undefined' && document.hidden;
      if (this.pageHidden) {
        this.stopLoop();
      } else {
        this.lastFrameTime = performance.now();
        this.lastDrawTime = 0;
        this.ensureRunning();
      }
    };

    if (this.gl) {
      this.pageHidden = typeof document !== 'undefined' && document.hidden;
      this.initShader();
      this.resize();
      window.addEventListener('resize', this.onResizeBound);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', this.onVisibilityBound);
      }
      this.render(performance.now());
      this.ensureRunning();
    }
  }

  private initShader(): void {
    const gl = this.gl;
    if (!gl) return;

    const vs = `attribute vec2 position; void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
    const fs = `
      precision highp float;
      uniform vec2 uResolution; uniform float uTime;
      uniform vec3 uColor1, uColor2, uColor3, uColor4;
      #define S(a,b,t) smoothstep(a,b,t)
      mat2 Rot(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
      vec2 hash(vec2 p) { p = vec2(dot(p, vec2(2127.1, 81.17)), dot(p, vec2(1269.5, 283.37))); return fract(sin(p) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
        float n = mix(mix(dot(-1.0 + 2.0 * hash(i), f), dot(-1.0 + 2.0 * hash(i + vec2(1,0)), f - vec2(1,0)), u.x),
                      mix(dot(-1.0 + 2.0 * hash(i + vec2(0,1)), f - vec2(0,1)), dot(-1.0 + 2.0 * hash(i + vec2(1,1)), f - vec2(1,1)), u.x), u.y);
        return 0.5 + 0.5 * n;
      }
      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution.xy;
        float ratio = uResolution.x / uResolution.y;
        vec2 tuv = uv - 0.5;
        float degree = noise(vec2(uTime * 0.1, tuv.x * tuv.y));
        tuv.y *= 1.0 / ratio;
        tuv *= Rot(radians((degree - 0.5) * 720.0 + 180.0));
        tuv.y *= ratio;
        float frequency = 5.0, amplitude = 30.0, speed = uTime * 2.0;
        tuv.x += sin(tuv.y * frequency + speed) / amplitude;
        tuv.y += sin(tuv.x * frequency * 1.5 + speed) / (amplitude * 0.5);
        vec3 layer1 = mix(uColor1, uColor2, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
        vec3 layer2 = mix(uColor3, uColor4, S(-0.3, 0.2, (tuv * Rot(radians(-5.0))).x));
        gl_FragColor = vec4(mix(layer1, layer2, S(0.5, -0.3, tuv.y)), 1.0);
      }
    `;

    const compile = (type: number, src: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };

    const vShader = compile(gl.VERTEX_SHADER, vs);
    const fShader = compile(gl.FRAGMENT_SHADER, fs);
    if (!vShader || !fShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);
    gl.useProgram(program);
    this.program = program;

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const posLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    this.uResolution = gl.getUniformLocation(program, 'uResolution');
    this.uTime = gl.getUniformLocation(program, 'uTime');
    this.uColor1 = gl.getUniformLocation(program, 'uColor1');
    this.uColor2 = gl.getUniformLocation(program, 'uColor2');
    this.uColor3 = gl.getUniformLocation(program, 'uColor3');
    this.uColor4 = gl.getUniformLocation(program, 'uColor4');
  }

  public resize(): void {
    if (!this.gl) return;
    const parent = this.canvas.parentElement;
    const rect = parent
      ? parent.getBoundingClientRect()
      : { width: window.innerWidth, height: window.innerHeight };
    const maxDpr = this.powerSave ? 0.65 : 1.35;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  public setPlaying(playing: boolean): void {
    if (this.isPlaying === playing) return;
    this.isPlaying = playing;
    if (playing) {
      this.lastFrameTime = performance.now();
      this.ensureRunning();
    }
  }

  public setPowerSave(enabled: boolean): void {
    if (this.powerSave === enabled) return;
    this.powerSave = enabled;
    this.resize();
    this.requestSingleFrame();
  }

  public setObscured(obscured: boolean): void {
    this.obscuredByList = obscured;
  }

  public setPalette(palette: FluidPalette): void {
    this.targetColors = palette.map((c) => [...c]) as FluidPalette;
    this.lastFrameTime = performance.now();
    this.ensureRunning();
  }

  private hasPendingColorLerp(): boolean {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        if (Math.abs(this.targetColors[i][j] - this.currentColors[i][j]) > 0.35) {
          return true;
        }
      }
    }
    return false;
  }

  private targetFrameIntervalMs(): number {
    if (this.obscuredByList) return this.powerSave ? 66 : 33; // ~15fps or ~30fps behind list scrim
    return this.powerSave ? 33 : 16; // ~30fps in power-save, ~60fps in high quality
  }

  private render(now: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const delta = Math.min(now - this.lastFrameTime, 50);
    this.lastFrameTime = now;
    if (this.isPlaying) {
      this.timeAccumulator += delta;
    }

    const lerp = 1 - Math.exp(-delta * 0.0045);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const diff = this.targetColors[i][j] - this.currentColors[i][j];
        if (Math.abs(diff) <= 0.35) {
          this.currentColors[i][j] = this.targetColors[i][j];
        } else {
          this.currentColors[i][j] += diff * lerp;
        }
      }
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uTime, this.timeAccumulator * 0.0005);

    const [c1, c2, c3, c4] = this.currentColors;
    gl.uniform3f(this.uColor1, c1[0] / 255, c1[1] / 255, c1[2] / 255);
    gl.uniform3f(this.uColor2, c2[0] / 255, c2[1] / 255, c2[2] / 255);
    gl.uniform3f(this.uColor3, c3[0] / 255, c3[1] / 255, c3[2] / 255);
    gl.uniform3f(this.uColor4, c4[0] / 255, c4[1] / 255, c4[2] / 255);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.lastDrawTime = now;
  }

  private requestSingleFrame(): void {
    if (this.disposed || this.pageHidden || !this.gl) return;
    if (this.rafId === null) {
      this.render(performance.now());
    }
  }

  private stopLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private ensureRunning(): void {
    if (this.disposed || this.pageHidden || !this.gl || this.rafId !== null) return;
    if (!this.isPlaying && !this.hasPendingColorLerp()) return;
    this.rafId = requestAnimationFrame((now) => this.animate(now));
  }

  private animate(now: number): void {
    if (this.disposed || this.pageHidden) {
      this.rafId = null;
      return;
    }

    const minInterval = this.targetFrameIntervalMs();
    if (now - this.lastDrawTime >= minInterval - 1) {
      this.render(now);
    }

    // Sleep cleanly when paused AND palette transition has settled (0% GPU usage)
    if (!this.isPlaying && !this.hasPendingColorLerp()) {
      this.rafId = null;
      return;
    }

    this.rafId = requestAnimationFrame((t) => this.animate(t));
  }

  public dispose(): void {
    this.disposed = true;
    this.stopLoop();
    window.removeEventListener('resize', this.onResizeBound);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityBound);
    }
  }
}
