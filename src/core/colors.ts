/** Legend colour sets. "Ladybug" reproduces the default Ladybug Tools gradient. */
export type RGB = [number, number, number];

export const PALETTES: Record<string, { label: string; colors: RGB[] }> = {
  ladybug: {
    label: 'Ladybug (default)',
    colors: [
      [75, 107, 169], [115, 147, 202], [170, 200, 247], [193, 213, 208], [245, 239, 103],
      [252, 230, 74], [239, 156, 21], [234, 123, 0], [234, 74, 0], [234, 38, 0],
    ],
  },
  sequential: {
    label: 'Sequential (one hue)',
    colors: [[239, 243, 255], [198, 219, 239], [158, 202, 225], [107, 174, 214], [66, 146, 198], [33, 113, 181], [8, 69, 148]],
  },
  viridis: {
    label: 'Viridis',
    colors: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  },
  daylight: {
    label: 'Daylight (dark → bright)',
    colors: [[20, 20, 30], [80, 60, 40], [170, 120, 40], [235, 190, 60], [255, 240, 170], [255, 255, 255]],
  },
  thermal: {
    label: 'Thermal (cold → hot)',
    colors: [[49, 54, 149], [69, 117, 180], [116, 173, 209], [224, 243, 248], [220, 220, 220], [254, 224, 144], [244, 109, 67], [215, 48, 39], [165, 0, 38]],
  },
};

/** Sample a palette at t ∈ [0,1]; returns 0-1 floats. */
export function sample(colors: RGB[], t: number): RGB {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(x));
  const f = x - i;
  const a = colors[i];
  const b = colors[i + 1];
  return [(a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255];
}

export interface LegendSettings {
  palette: string;
  min: number;
  max: number;
  segments: number; // 0 = continuous
}

export function colorFor(v: number, s: LegendSettings): RGB {
  const colors = PALETTES[s.palette]?.colors ?? PALETTES.ladybug.colors;
  let t = s.max === s.min ? 0.5 : (v - s.min) / (s.max - s.min);
  if (s.segments > 1) {
    t = Math.min(s.segments - 1, Math.floor(Math.min(0.99999, Math.max(0, t)) * s.segments)) / (s.segments - 1);
  }
  return sample(colors, t);
}

export function cssColor(c: RGB): string {
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
}

export function gradientCss(palette: string, direction = 'to top'): string {
  const colors = PALETTES[palette]?.colors ?? PALETTES.ladybug.colors;
  return `linear-gradient(${direction}, ${colors.map((c, i) => `rgb(${c.join(',')}) ${((i / (colors.length - 1)) * 100).toFixed(1)}%`).join(', ')})`;
}
