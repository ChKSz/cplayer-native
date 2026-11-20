export type RGB = [number, number, number];
export type FluidPalette = [RGB, RGB, RGB, RGB];

export const DEFAULT_FLUID_PALETTE: FluidPalette = [
  [54, 24, 78],
  [92, 42, 68],
  [18, 20, 42],
  [42, 48, 92],
];

/**
 * Extracts a 4-color RGB palette from an album cover URL (with 0.8x luminance
 * scaling matching CPlayer's FluidBackground.extractColorsFromImage), falling
 * back deterministically to a tasteful color seed derived from the title/URL
 * when CORS prevents pixel readback.
 */
export async function extractFluidPalette(imgUrl: string, seedText = ''): Promise<FluidPalette> {
  if (imgUrl && typeof Image !== 'undefined' && typeof document !== 'undefined') {
    try {
      const palette = await sampleImageFourQuadrants(imgUrl);
      if (palette) return palette;
    } catch {
      // Fall through to deterministic palette
    }
  }
  return seededPalette(seedText || imgUrl || 'cplayer');
}

function sampleImageFourQuadrants(imgUrl: string): Promise<FluidPalette | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 4000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 4, 4);
        const d = ctx.getImageData(0, 0, 4, 4).data;
        const pick = (px: number): RGB => [
          Math.max(12, Math.round(d[px * 4] * 0.78)),
          Math.max(12, Math.round(d[px * 4 + 1] * 0.78)),
          Math.max(18, Math.round(d[px * 4 + 2] * 0.78)),
        ];
        resolve([pick(0), pick(3), pick(12), pick(15)]);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = imgUrl;
  });
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function seededPalette(seed: string): FluidPalette {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const baseHue = Math.abs(hash) % 360;
  return [
    hslToRgb(baseHue, 0.52, 0.30),
    hslToRgb((baseHue + 42) % 360, 0.46, 0.28),
    hslToRgb((baseHue + 190) % 360, 0.40, 0.14),
    hslToRgb((baseHue + 28) % 360, 0.48, 0.34),
  ];
}
