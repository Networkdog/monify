// Hierarchical tile JSON schema. Coordinates inside a tile are given in
// world units (1.0 = 1 tile at zoom 0). Groups apply a transform to children;
// the loader flattens this into a flat element list with absolute world coords.

import type { RGBA } from '../types';

export interface BaseElement {
  /** Optional element id (for hit-testing). */
  id?: string;
  /** Layer z-order *within* a tile (higher draws on top). Default 0. */
  layer?: number;
  /**
   * Hierarchy depth this element belongs to (0 = root generation). Used by
   * the cross-fade renderer to draw only the *new* generation in the upper
   * layer during a zoom transition, so shared ancestors are not double-blended.
   */
  depth?: number;
}

export interface ShapeElement extends BaseElement {
  type: 'shape';
  /** "rect" | "circle" | "ellipse" | "arc" | "hexagon". */
  shape: 'rect' | 'circle' | 'ellipse' | 'arc' | 'hexagon';
  /** World-space anchor (top-left for rect, center for circle/ellipse/arc). */
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: RGBA;
  stroke?: RGBA;
  strokeWidth?: number;
  /**
   * When true, `strokeWidth` is interpreted as a constant screen-pixel width
   * (CSS px, before DPR) and converted to world units at render time, so the
   * border keeps the same on-screen thickness regardless of zoom. Mirrors the
   * `floating` flag on text elements.
   */
  strokeScreen?: boolean;
  /**
   * Shrink the shape by this many screen pixels (CSS px, before DPR) on every
   * side at render time. Yields a constant on-screen inset/gap between adjacent
   * filled shapes regardless of zoom (e.g. treemap cell separators).
   */
  insetScreen?: number;
  /** Arc-only: inner radius as fraction of outer radius (0–1). */
  arcInner?: number;
  /** Arc-only: start angle in radians (0 = right, π/2 = down). */
  arcStart?: number;
  /** Arc-only: end angle in radians. */
  arcEnd?: number;
  /**
   * 3D extrusion height in world units. When > 0, the renderer draws
   * side-wall quads behind the top face to simulate a top-down 3D view.
   */
  height?: number;
}

export interface ImageElement extends BaseElement {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
}

export interface TextElement extends BaseElement {
  type: 'text';
  x: number;
  y: number;
  /** Font size in world units (or screen pixels when `floating` is true). */
  size: number;
  text: string;
  color?: RGBA;
  align?: 'left' | 'center';
  /** CSS font string fragment: weight, style, and family. Default: 'ui-sans-serif, system-ui, sans-serif'. */
  font?: string;
  /** CSS letter-spacing (e.g. '0.03em'). Open up small text, tighten large text. */
  tracking?: string;
  /** Outline drawn behind the glyph so it keeps contrast over any background. */
  halo?: RGBA;
  /** Optional max width (world units) for wrapping. */
  maxWidth?: number;
  /**
   * When true, the text renders at a constant screen-pixel size regardless of
   * zoom level. `size` is interpreted as screen pixels (before DPR scaling).
   * The text stays anchored at its world position but does not shrink/grow
   * with zoom — useful for always-readable labels, HUD overlays, and tooltips.
   */
  floating?: boolean;
  /**
   * Z-axis elevation in world units. When > 0, the text quad is rendered at
   * this height above the ground plane, matching the top face of a 3D shape.
   */
  elevation?: number;
}

export interface VectorElement extends BaseElement {
  type: 'vector';
  /** Flat array of polygon contours, each as [x0,y0,x1,y1,...]. */
  rings: number[][];
  fill?: RGBA;
  stroke?: RGBA;
  strokeWidth?: number;
  /** Interpret `strokeWidth` as constant screen pixels, as on ShapeElement — a
   *  hairline stays a hairline at every zoom instead of vanishing. */
  strokeScreen?: boolean;
  /**
   * Renderer cache: the fill triangulated ONCE into a world-space triangle soup
   * ([x0,y0,x1,y1,...]). Filled lazily by the scene on first draw, or supplied
   * pre-baked (e.g. by the zoom-out aggregates) so the O(n²) ear-clip never runs
   * per frame. Drawing only shifts by the camera + applies `fill`. Recolouring in
   * place (mutating `fill`) is free; changing `rings` requires clearing this.
   */
  fillTris?: Float32Array;
}

export interface ExtrudedElement extends BaseElement {
  type: 'extruded';
  /** Polygon contour(s) in world coords, each [x0,y0,x1,y1,...], extruded
   *  straight up from z=0 to z=`height`. */
  rings: number[][];
  /** Extrusion height in world units. */
  height: number;
  fill: RGBA;
}

export interface GroupElement extends BaseElement {
  type: 'group';
  /** Optional translation applied to all children. */
  tx?: number;
  ty?: number;
  /** Optional uniform scale applied to all children. */
  scale?: number;
  children: TileElement[];
}

export type TileElement = ShapeElement | ImageElement | TextElement | VectorElement | ExtrudedElement | GroupElement;
export type FlatElement = ShapeElement | ImageElement | TextElement | VectorElement | ExtrudedElement;

export interface TileJSON {
  z: number;
  x: number;
  y: number;
  elements: TileElement[];
}

/**
 * One geometry bucket's worth of pre-packed instance records. Positions are
 * relative to the tile origin, so drawing only adds the camera offset.
 */
export interface PackedShapeBatch {
  /** Instance records, `COLORED_STRIDE` floats each. */
  data: Float32Array;
  /**
   * The live fill array behind each instance. Colours are copied into `data`
   * and refreshed from here whenever the scene reports a content change, so
   * recolouring in place still works without a tile rebuild — the same contract
   * as `VectorElement.fillTris`.
   */
  fills: RGBA[];
  count: number;
}

/**
 * Renderer cache: a tile's plain shapes packed once at build time. Geometry is
 * frozen here, so moving or resizing an element afterwards needs a tile rebuild.
 */
export interface PackedTile {
  /** Tile origin the packed positions are relative to (world units). */
  ox: number;
  oy: number;
  /** `Scene` colour epoch the inline fills were last refreshed at. */
  epoch: number;
  flat: PackedShapeBatch | null;
  flatHex: PackedShapeBatch | null;
  box: PackedShapeBatch | null;
  cyl: PackedShapeBatch | null;
  hex: PackedShapeBatch | null;
  /** Elements the packer skipped — non-shapes and camera-dependent shapes. */
  rest: FlatElement[];
}

export interface FlatTile {
  z: number;
  x: number;
  y: number;
  elements: FlatElement[];
  /** Filled lazily on first draw; `null` means the tile wasn't worth packing. */
  packed?: PackedTile | null;
}

/** Recursively flatten group transforms into absolute coordinates. */
export function flattenTile(t: TileJSON): FlatTile {
  // Fast path: when there are no group transforms (e.g. procedural
  // renderContent tiles), skip the walk+copy entirely. This avoids
  // duplicating every element and cuts per-tile allocation in half.
  let hasGroups = false;
  for (let i = 0; i < t.elements.length; i++) {
    if (t.elements[i].type === 'group') { hasGroups = true; break; }
  }
  if (!hasGroups) {
    const flat = t.elements as FlatElement[];
    if (flat.length > 1) flat.sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
    return { z: t.z, x: t.x, y: t.y, elements: flat };
  }
  const out: FlatElement[] = [];
  walk(t.elements, 0, 0, 1, out);
  out.sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));
  return { z: t.z, x: t.x, y: t.y, elements: out };
}

function walk(
  elements: TileElement[],
  tx: number,
  ty: number,
  scale: number,
  out: FlatElement[]
): void {
  for (let i = 0, len = elements.length; i < len; i++) {
    const e = elements[i];
    if (e.type === 'group') {
      const ntx = tx + (e.tx ?? 0) * scale;
      const nty = ty + (e.ty ?? 0) * scale;
      const ns = scale * (e.scale ?? 1);
      walk(e.children, ntx, nty, ns, out);
    } else if (e.type === 'shape') {
      out.push({
        type: 'shape', shape: e.shape, id: e.id, layer: e.layer, depth: e.depth,
        x: tx + e.x * scale, y: ty + e.y * scale,
        w: e.w * scale, h: e.h * scale,
        fill: e.fill, stroke: e.stroke, strokeWidth: e.strokeWidth,
        strokeScreen: e.strokeScreen, insetScreen: e.insetScreen,
      });
    } else if (e.type === 'image') {
      out.push({
        type: 'image', id: e.id, layer: e.layer, depth: e.depth,
        x: tx + e.x * scale, y: ty + e.y * scale,
        w: e.w * scale, h: e.h * scale, url: e.url,
      });
    } else if (e.type === 'text') {
      out.push({
        type: 'text', id: e.id, layer: e.layer, depth: e.depth,
        x: tx + e.x * scale, y: ty + e.y * scale,
        size: e.size * scale, text: e.text, color: e.color, maxWidth: e.maxWidth,
        align: e.align, font: e.font, tracking: e.tracking, floating: e.floating,
        halo: e.halo,
        elevation: e.elevation,
      });
    } else if (e.type === 'vector') {
      const rings = e.rings.map((r) => {
        const nr = new Array(r.length);
        for (let j = 0; j < r.length; j += 2) {
          nr[j] = tx + r[j] * scale;
          nr[j + 1] = ty + r[j + 1] * scale;
        }
        return nr;
      });
      out.push({
        type: 'vector', id: e.id, layer: e.layer, depth: e.depth,
        rings, fill: e.fill, stroke: e.stroke, strokeWidth: e.strokeWidth,
        strokeScreen: e.strokeScreen,
      });
    } else if (e.type === 'extruded') {
      const rings = e.rings.map((r) => {
        const nr = new Array(r.length);
        for (let j = 0; j < r.length; j += 2) {
          nr[j] = tx + r[j] * scale;
          nr[j + 1] = ty + r[j + 1] * scale;
        }
        return nr;
      });
      out.push({
        type: 'extruded', id: e.id, layer: e.layer, depth: e.depth,
        rings, height: e.height * scale, fill: e.fill,
      });
    }
  }
}
