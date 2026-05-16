/* eslint-disable no-console */
/**
 * Contour Line Generator
 *
 * Generates organic topographic contour SVG using:
 * - Fractal Brownian Motion (FBM) noise
 * - Domain warping for natural terrain look
 * - Marching squares for iso-line extraction
 * - Ramer-Douglas-Peucker path simplification
 *
 * Run with: npx tsx scripts/generate-contours.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  tileSize: 900,
  gridResolution: 300,
  expandSize: 1200,

  baseFrequency: 0.008,
  octaves: 5,
  lacunarity: 2.0,
  gain: 0.5,
  seed: 42,

  warpFrequency: 0.012,
  warpOctaves: 3,
  warpLacunarity: 2.0,
  warpGain: 0.5,
  warpAmplitude: 35,
  warpOffsetX: { x: 37.2, y: 91.7 },
  warpOffsetY: { x: 187.9, y: 12.4 },

  contourLevels: 8,

  simplifyTolerance: 1.8,
  minPathLength: 80,

  strokeColor: '#9fb7ff',
  strokeWidth: 0.9,

  opacityHigh: 1.0,
  opacityLow: 0.12,
};

class SimplexNoise {
  private perm: number[] = [];
  private permMod12: number[] = [];

  private static grad2 = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  private static F2 = 0.5 * (Math.sqrt(3) - 1);
  private static G2 = (3 - Math.sqrt(3)) / 6;

  constructor(seed: number = 0) {
    const p: number[] = [];
    for (let i = 0; i < 256; i++) p[i] = i;

    let n = seed;
    for (let i = 255; i > 0; i--) {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      const j = n % (i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }

    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 8;
    }
  }

  noise2D(x: number, y: number): number {
    const F2 = SimplexNoise.F2;
    const G2 = SimplexNoise.G2;
    const grad2 = SimplexNoise.grad2;

    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);

    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    const gi0 = this.permMod12[ii + this.perm[jj]];
    const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]];
    const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]];

    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad2[gi0][0] * x0 + grad2[gi0][1] * y0);
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad2[gi1][0] * x1 + grad2[gi1][1] * y1);
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad2[gi2][0] * x2 + grad2[gi2][1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  }
}

function fbm(
  noise: SimplexNoise,
  x: number,
  y: number,
  octaves: number,
  frequency: number,
  lacunarity: number,
  gain: number
): number {
  let value = 0;
  let amplitude = 1;
  let freq = frequency;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise.noise2D(x * freq, y * freq);
    maxValue += amplitude;
    amplitude *= gain;
    freq *= lacunarity;
  }

  return (value / maxValue + 1) / 2;
}

function generateHeightField(config: typeof CONFIG): number[][] {
  const noise = new SimplexNoise(config.seed);
  const warpNoise = new SimplexNoise(config.seed + 1337);

  const density = config.gridResolution / config.tileSize;
  const expandedSamples = Math.round(config.expandSize * density);
  const field: number[][] = [];

  const scale = config.expandSize / (expandedSamples - 1);

  for (let y = 0; y < expandedSamples; y++) {
    const row: number[] = [];
    for (let x = 0; x < expandedSamples; x++) {
      const px = x * scale;
      const py = y * scale;

      const wx = fbm(
        warpNoise,
        px + config.warpOffsetX.x,
        py + config.warpOffsetX.y,
        config.warpOctaves,
        config.warpFrequency,
        config.warpLacunarity,
        config.warpGain
      ) * 2 - 1;

      const wy = fbm(
        warpNoise,
        px + config.warpOffsetY.x,
        py + config.warpOffsetY.y,
        config.warpOctaves,
        config.warpFrequency,
        config.warpLacunarity,
        config.warpGain
      ) * 2 - 1;

      const warpedX = px + wx * config.warpAmplitude;
      const warpedY = py + wy * config.warpAmplitude;

      const height = fbm(
        noise, warpedX, warpedY,
        config.octaves, config.baseFrequency,
        config.lacunarity, config.gain
      );

      row.push(height);
    }
    field.push(row);
  }

  return applyBoxBlur(field);
}

function applyBoxBlur(field: number[][]): number[][] {
  const h = field.length;
  const w = field[0].length;
  const result: number[][] = [];

  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = Math.min(h - 1, Math.max(0, y + dy));
          const nx = Math.min(w - 1, Math.max(0, x + dx));
          sum += field[ny][nx];
          count++;
        }
      }
      row.push(sum / count);
    }
    result.push(row);
  }

  return result;
}

function cropCenter(field: number[][], config: typeof CONFIG): number[][] {
  const density = config.gridResolution / config.tileSize;
  const cropSamples = Math.round(config.tileSize * density);
  const expandedSamples = field.length;

  const startX = Math.floor((expandedSamples - cropSamples) / 2);
  const startY = Math.floor((expandedSamples - cropSamples) / 2);

  const cropped: number[][] = [];
  for (let y = 0; y < cropSamples; y++) {
    cropped.push(field[startY + y].slice(startX, startX + cropSamples));
  }
  return cropped;
}

type Point = [number, number];
type Polyline = Point[];

function marchingSquares(
  field: number[][],
  threshold: number,
  scale: number
): Polyline[] {
  const height = field.length - 1;
  const width = field[0].length - 1;
  const segments: [Point, Point][] = [];

  const edgeTable: Record<number, number[][]> = {
    0: [], 15: [],
    1: [[3, 0]], 14: [[0, 3]],
    2: [[0, 1]], 13: [[1, 0]],
    3: [[3, 1]], 12: [[1, 3]],
    4: [[1, 2]], 11: [[2, 1]],
    5: [[3, 0], [1, 2]], 10: [[0, 1], [2, 3]],
    6: [[0, 2]], 9: [[2, 0]],
    7: [[3, 2]], 8: [[2, 3]],
  };

  function getEdgePoint(edge: number, x: number, y: number, values: number[]): Point {
    const [v0, v1, v2, v3] = values;

    switch (edge) {
      case 0: {
        const t = (threshold - v0) / (v1 - v0);
        return [(x + t) * scale, y * scale];
      }
      case 1: {
        const t = (threshold - v1) / (v2 - v1);
        return [(x + 1) * scale, (y + t) * scale];
      }
      case 2: {
        const t = (threshold - v3) / (v2 - v3);
        return [(x + t) * scale, (y + 1) * scale];
      }
      case 3: {
        const t = (threshold - v0) / (v3 - v0);
        return [x * scale, (y + t) * scale];
      }
      default:
        return [0, 0];
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v0 = field[y][x];
      const v1 = field[y][x + 1];
      const v2 = field[y + 1][x + 1];
      const v3 = field[y + 1][x];

      let index = 0;
      if (v0 >= threshold) index |= 1;
      if (v1 >= threshold) index |= 2;
      if (v2 >= threshold) index |= 4;
      if (v3 >= threshold) index |= 8;

      const edges = edgeTable[index];
      const values = [v0, v1, v2, v3];

      for (const [e1, e2] of edges) {
        const p1 = getEdgePoint(e1, x, y, values);
        const p2 = getEdgePoint(e2, x, y, values);
        segments.push([p1, p2]);
      }
    }
  }

  return connectSegments(segments);
}

function connectSegments(segments: [Point, Point][]): Polyline[] {
  if (segments.length === 0) return [];

  const polylines: Polyline[] = [];
  const used = new Set<number>();
  const eps = 0.001;

  function pointsEqual(a: Point, b: Point): boolean {
    return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  }

  function findConnecting(point: Point, exclude: number): number {
    for (let i = 0; i < segments.length; i++) {
      if (used.has(i) || i === exclude) continue;
      if (pointsEqual(segments[i][0], point) || pointsEqual(segments[i][1], point)) {
        return i;
      }
    }
    return -1;
  }

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;

    used.add(i);
    const polyline: Polyline = [segments[i][0], segments[i][1]];

    let lastPoint = polyline[polyline.length - 1];
    let nextIdx = findConnecting(lastPoint, i);
    while (nextIdx !== -1) {
      used.add(nextIdx);
      const seg = segments[nextIdx];
      const newPoint = pointsEqual(seg[0], lastPoint) ? seg[1] : seg[0];
      polyline.push(newPoint);
      lastPoint = newPoint;
      nextIdx = findConnecting(lastPoint, nextIdx);
    }

    let firstPoint = polyline[0];
    let prevIdx = findConnecting(firstPoint, i);
    while (prevIdx !== -1) {
      used.add(prevIdx);
      const seg = segments[prevIdx];
      const newPoint = pointsEqual(seg[0], firstPoint) ? seg[1] : seg[0];
      polyline.unshift(newPoint);
      firstPoint = newPoint;
      prevIdx = findConnecting(firstPoint, prevIdx);
    }

    polylines.push(polyline);
  }

  return polylines;
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd[0] - lineStart[0];
  const dy = lineEnd[1] - lineStart[1];

  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag < 0.00001) {
    return Math.sqrt(
      Math.pow(point[0] - lineStart[0], 2) +
      Math.pow(point[1] - lineStart[1], 2)
    );
  }

  const u = ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) / (mag * mag);

  let closestX: number, closestY: number;
  if (u < 0) {
    closestX = lineStart[0];
    closestY = lineStart[1];
  } else if (u > 1) {
    closestX = lineEnd[0];
    closestY = lineEnd[1];
  } else {
    closestX = lineStart[0] + u * dx;
    closestY = lineStart[1] + u * dy;
  }

  return Math.sqrt(
    Math.pow(point[0] - closestX, 2) +
    Math.pow(point[1] - closestY, 2)
  );
}

function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;

  let maxDistance = 0;
  let maxIndex = 0;

  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPath(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

function pathLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

function generateSVG(
  polylines: Polyline[],
  config: typeof CONFIG,
  levelIndex: number,
  totalLevels: number
): string {
  const paths: string[] = [];

  const t = levelIndex / Math.max(1, totalLevels - 1);
  const opacity = config.opacityHigh - t * (config.opacityHigh - config.opacityLow);

  for (const polyline of polylines) {
    if (polyline.length < 2) continue;

    const d = polyline.map((p, i) => {
      const cmd = i === 0 ? 'M' : 'L';
      return `${cmd}${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    }).join(' ');

    paths.push(`    <path d="${d}" opacity="${opacity.toFixed(3)}"/>`);
  }

  return paths.join('\n');
}

async function main() {
  console.log('Generating contour lines...');
  console.log(`Config: ${CONFIG.expandSize}x${CONFIG.expandSize} expanded, crop to ${CONFIG.tileSize}x${CONFIG.tileSize}`);
  console.log(`Levels: ${CONFIG.contourLevels}, warp amplitude: ${CONFIG.warpAmplitude}px`);

  console.log('Generating height field with domain warping...');
  const expandedField = generateHeightField(CONFIG);

  console.log('Cropping center tile...');
  const field = cropCenter(expandedField, CONFIG);

  const scale = CONFIG.tileSize / (field.length - 1);

  const levels: number[] = [];
  for (let i = 1; i <= CONFIG.contourLevels; i++) {
    levels.push(i / (CONFIG.contourLevels + 1));
  }

  console.log('Extracting iso-lines...');
  const allPaths: string[] = [];

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    console.log(`  Level ${i + 1}/${levels.length}: ${level.toFixed(3)}`);

    const polylines = marchingSquares(field, level, scale);

    const simplified = polylines
      .map(p => simplifyPath(p, CONFIG.simplifyTolerance))
      .filter(p => pathLength(p) >= CONFIG.minPathLength);

    console.log(`    ${polylines.length} raw -> ${simplified.length} simplified`);

    const svgPaths = generateSVG(simplified, CONFIG, i, levels.length);
    if (svgPaths) allPaths.push(svgPaths);
  }

  const svg = `<svg width="${CONFIG.tileSize}" height="${CONFIG.tileSize}" viewBox="0 0 ${CONFIG.tileSize} ${CONFIG.tileSize}" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="${CONFIG.strokeColor}" stroke-width="${CONFIG.strokeWidth}"
     stroke-linecap="round" stroke-linejoin="round">
${allPaths.join('\n')}
  </g>
</svg>`;

  const outputPath = path.join(__dirname, '..', 'public', 'assets', 'contours.svg');
  fs.writeFileSync(outputPath, svg);

  console.log(`\nGenerated: ${outputPath}`);
  console.log(`File size: ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
