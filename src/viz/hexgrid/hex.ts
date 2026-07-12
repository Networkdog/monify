// Pointy-top hexagon math on an axial (q, r) coordinate system.
//
//   pixel = axialToPixel(q, r, size)   center of a hex, `size` = circumradius
//   axial = hexRound(pixelToAxial(...)) nearest hex to a pixel (for hit-testing)
//
// `hexSpiral` enumerates cells outward from the origin — used both to place
// workloads deterministically and to lay out resource sub-hexes inside a cell.

export type Axial = [number, number];

const SQRT3 = Math.sqrt(3);

/** Center pixel of hex (q, r) with circumradius `size` (pointy-top). */
export function axialToPixel(q: number, r: number, size: number): [number, number] {
  return [size * SQRT3 * (q + r / 2), size * 1.5 * r];
}

/** Fractional axial coordinate of a pixel (inverse of axialToPixel). */
export function pixelToAxial(x: number, y: number, size: number): [number, number] {
  const q = ((SQRT3 / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return [q, r];
}

/** Round fractional axial coordinates to the nearest hex (cube rounding). */
export function hexRound(q: number, r: number): Axial {
  const x = q;
  const z = r;
  const y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return [rx, rz];
}

export const HEX_DIRECTIONS: readonly Axial[] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** The six neighbors of (q, r). */
export function hexNeighbors(q: number, r: number): Axial[] {
  return HEX_DIRECTIONS.map((d) => [q + d[0], r + d[1]] as Axial);
}

/** Cube distance between two axial cells. */
export function hexDistance(aq: number, ar: number, bq: number, br: number): number {
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
}

/** The ring of cells at exactly `radius` from the origin. */
export function hexRing(radius: number): Axial[] {
  if (radius <= 0) return [[0, 0]];
  const out: Axial[] = [];
  let q = HEX_DIRECTIONS[4][0] * radius;
  let r = HEX_DIRECTIONS[4][1] * radius;
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push([q, r]);
      q += HEX_DIRECTIONS[side][0];
      r += HEX_DIRECTIONS[side][1];
    }
  }
  return out;
}

/** All cells within `maxRadius` of the origin, spiraling outward. */
export function hexSpiral(maxRadius: number): Axial[] {
  const out: Axial[] = [[0, 0]];
  for (let k = 1; k <= maxRadius; k++) out.push(...hexRing(k));
  return out;
}

/** Number of cells in a full spiral of the given radius. */
export function spiralCount(radius: number): number {
  return 1 + 3 * radius * (radius + 1);
}

/** Smallest spiral radius whose cell count is >= `n`. */
export function spiralRadiusFor(n: number): number {
  let r = 0;
  while (spiralCount(r) < n) r++;
  return r;
}

/** Flat `[x0,y0,x1,y1,...]` ring of a pointy-top hexagon. */
export function hexPolygon(cx: number, cy: number, size: number): number[] {
  const pts = new Array<number>(12);
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i - 90);
    pts[i * 2] = cx + size * Math.cos(ang);
    pts[i * 2 + 1] = cy + size * Math.sin(ang);
  }
  return pts;
}

/** Stable string key for an axial cell. */
export function axialKey(q: number, r: number): string {
  return q + ',' + r;
}
