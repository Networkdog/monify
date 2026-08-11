import { Camera, resetTilePool, visibleTiles, zoomLayers } from './camera';
import { BACKGROUND } from '../color/tokens';
import { TILE_SIZE } from './constants';
import {
  LayerComposer,
  getGL,
  COLORED_STRIDE,
  QuadRenderer,
  TEXTURED_STRIDE,
  VECTOR_STRIDE,
  MESH_STRIDE,
  strokeVertexCount,
  buildFillTris,
  tessellateStroke,
  bucketTextSize,
  TextureCache,
} from './gl';
import { LiveStore, MutationBus, type LayerMeta } from './live';
import { TileCache, WsTileSource, TileLoader } from './tile';
import type {
  FlatElement,
  FlatTile,
  PackedShapeBatch,
  PackedTile,
  ShapeElement,
  TileJSON,
} from './tile/tile-schema';
import type { RGBA, TileCoord } from './types';

export interface SceneOptions {
  /** Build a fetchable URL for (z,x,y). Required unless `tileSource` or `wsUrl` is set. */
  tileUrl?: (z: number, x: number, y: number) => string;
  /**
   * Direct tile producer. When set, bypasses URL/fetch/JSON round-trip
   * entirely — `TileLoader` calls this on a yielded task per tile.
   */
  tileSource?: (z: number, x: number, y: number) => TileJSON;
  /**
   * WebSocket tile server URL (ws:// or wss://). When set, tiles are loaded
   * on-demand from the remote server over a persistent WebSocket connection.
   * Takes priority over `tileUrl` but not `tileSource`.
   */
  wsUrl?: string;
  /** Min integer zoom available in the tile pyramid. */
  minTileZ?: number;
  /** Max integer zoom available in the tile pyramid. */
  maxTileZ?: number;
  /** Background clear color. */
  background?: RGBA;
  /**
   * Layer metadata for the MutationBus (zoom ranges per layer).
   * Required for real-time mutation support.
   */
  layerMeta?: LayerMeta[];
  /**
   * Resolve a procedural object ID to its world position.
   * Required for targeted tile invalidation in the MutationBus.
   */
  resolvePosition?: (id: string) => [number, number] | null;
  /**
   * Optional per-zoom border (in tiles) added around the viewport when
   * computing the visible tile set. Defaults to 1. Increase for zoom
   * levels whose cells span multiple tiles, so their (off-screen)
   * center tile is still loaded and drawn while extents reach into
   * the viewport.
   */
  tileMargin?: (z: number) => number;
}

const DEFAULT_BG: RGBA = BACKGROUND;

/** Top-level scene composing camera, tiles, and the WebGL renderer. */
export class Scene {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly camera = new Camera();
  readonly cache = new TileCache();
  readonly loader: TileLoader;
  readonly renderer: QuadRenderer;
  readonly textures: TextureCache;
  readonly composer: LayerComposer;

  /** Mutable runtime state layer for real-time object mutation. */
  readonly live = new LiveStore();
  /** Mutation dispatcher that applies ops and invalidates tiles. */
  readonly mutations: MutationBus;

  /** WebSocket tile source (created when wsUrl is set). */
  readonly wsTileSource: WsTileSource | null = null;

  private opts: {
    tileUrl?: (z: number, x: number, y: number) => string;
    tileSource?: (z: number, x: number, y: number) => TileJSON;
    minTileZ: number;
    maxTileZ: number;
    background: RGBA;
    tileMargin?: (z: number) => number;
  };
  private viewW = 0;
  private viewH = 0;
  private dpr = 1;
  private viewMat = new Float32Array(16);
  /** Camera height above the ground plane (world units) from the last
   *  buildMVP — used to sort translucent prisms by true camera distance. */
  private camHeight = 1;
  private _dirty = true;
  private _colorEpoch = 0;

  // --- Per-frame cache: avoids redundant zoomLayers / visibleTiles between
  // refreshTileRequests() and draw() in the same frame. ----
  private _zl = { lower: 0, upper: 0, frac: 0 };
  private _layerTiles = new Map<number, TileCoord[]>();
  private _frameSeq = 0;
  private _cachedSeq = -1;

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.canvas = canvas;
    this.gl = getGL(canvas);
    if (!opts.tileUrl && !opts.tileSource && !opts.wsUrl) {
      throw new Error('SceneOptions: provide tileUrl, tileSource, or wsUrl');
    }
    this.opts = {
      tileUrl: opts.tileUrl,
      tileSource: opts.tileSource,
      minTileZ: opts.minTileZ ?? 0,
      maxTileZ: opts.maxTileZ ?? 6,
      background: opts.background ?? DEFAULT_BG,
      tileMargin: opts.tileMargin,
    };

    // WebSocket tile source — create if wsUrl is provided.
    let wsTileSource: WsTileSource | undefined;
    if (opts.wsUrl && !opts.tileSource) {
      wsTileSource = new WsTileSource({
        url: opts.wsUrl,
        onTile: (z, x, y, tile) => {
          this.cache.set(z, x, y, { status: 'ready', tile });
          this._dirty = true;
        },
        onEmpty: (z, x, y) => {
          this.cache.set(z, x, y, {
            status: 'ready',
            tile: { z, x, y, elements: [] },
          });
          this._dirty = true;
        },
        onError: (z, x, y, error) => {
          this.cache.set(z, x, y, { status: 'error', error: new Error(error) });
        },
        onConnect: () => { this._dirty = true; },
      });
      wsTileSource.connect();
      this.wsTileSource = wsTileSource;
    }

    this.loader = new TileLoader(this.cache, {
      url: this.opts.tileUrl,
      source: this.opts.tileSource,
      ws: wsTileSource,
      onReady: () => { this._dirty = true; },
    });
    this.renderer = new QuadRenderer(this.gl);
    this.textures = new TextureCache(this.gl);
    this.composer = new LayerComposer(this.gl);

    this.mutations = new MutationBus({
      store: this.live,
      cache: this.cache,
      layers: opts.layerMeta ?? [],
      resolvePosition: opts.resolvePosition ?? (() => null),
      onDirty: () => { this._dirty = true; },
    });

    const gl = this.gl;
    gl.enable(gl.BLEND);
    // Premultiplied alpha blending.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // 3D: depth testing and back-face culling.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
  }

  /** Resize the backing canvas to its CSS size at `dpr`. */
  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1): void {
    this.viewW = cssWidth;
    this.viewH = cssHeight;
    this.dpr = dpr;
    const pxW = Math.max(1, Math.round(cssWidth * dpr));
    const pxH = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;
    this.gl.viewport(0, 0, pxW, pxH);
    this.composer.resize(pxW, pxH);
    this._dirty = true;
  }

  /** View size in CSS pixels. */
  getViewSize(): [number, number] {
    return [this.viewW, this.viewH];
  }

  /** Force a redraw on the next frame. */
  markDirty(): void {
    this._dirty = true;
    // Content change: packed tiles re-read their fills on the next draw. Every
    // other path that can alter a colour replaces the tile outright.
    this._colorEpoch++;
  }

  /** Read-and-clear the dirty flag. */
  consumeDirty(): boolean {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  // Pre-allocated request buffer — reused per frame to avoid per-tile allocation.
  private _requests: { z: number; x: number; y: number; priority: number }[] = [];
  private _requestCount = 0;

  /** Request the tiles required to cover the current view. */
  refreshTileRequests(): void {
    this._frameSeq++;
    resetTilePool();   // reclaim tile coord objects from last frame
    this._ensureFrameCache();

    const z = Math.max(this.opts.minTileZ, Math.min(this.opts.maxTileZ, Math.round(this.camera.zoom)));
    const { lower, upper, frac } = this._zl;
    const layers = new Set<number>([z]);
    if (frac < 1) layers.add(lower);
    if (frac > 0) layers.add(upper);

    // Reuse the request buffer (grow-only, zero per-frame allocation).
    this._requestCount = 0;
    const pushReq = (tz: number, tx: number, ty: number, p: number) => {
      const idx = this._requestCount++;
      if (idx >= this._requests.length) {
        this._requests.push({ z: tz, x: tx, y: ty, priority: p });
      } else {
        const r = this._requests[idx];
        r.z = tz; r.x = tx; r.y = ty; r.priority = p;
      }
    };

    for (const lz of layers) {
      const tiles = this._getCachedTiles(lz);
      const priority = Math.abs(lz - z) * 10;
      for (const t of tiles) pushReq(t.z, t.x, t.y, priority);
    }

    // Spatial prefetching: if camera is panning, request tiles ahead
    const vx = this.camera.velX;
    const vy = this.camera.velY;
    if (vx * vx + vy * vy > 1e-12) {
      const savedCx = this.camera.centerX;
      const savedCy = this.camera.centerY;
      this.camera.centerX += vx * 0.15;
      this.camera.centerY += vy * 0.15;
      for (const lz of layers) {
        const margin = this.opts.tileMargin ? this.opts.tileMargin(lz) : 1;
        const ahead = visibleTiles(this.camera, this.viewW, this.viewH, lz, margin);
        const priority = 100 + Math.abs(lz - z) * 10;
        for (const t of ahead) pushReq(t.z, t.x, t.y, priority);
      }
      this.camera.centerX = savedCx;
      this.camera.centerY = savedCy;
    }

    // Pass the active slice (not the full buffer) to the loader.
    this.loader.request(this._requests, this._requestCount);
  }

  /** Render one frame. */
  draw(): void {
    const gl = this.gl;
    this.renderer.resetStats();
    this.textures.frameTick();
    const [r, g, b, a] = this.opts.background;
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this.viewW === 0 || this.viewH === 0) return;

    this._ensureFrameCache();
    const { lower, upper, frac } = this._zl;
    this.buildMVP(this.viewMat);

    // True cross-dissolve via offscreen composition. Each layer is rendered
    // into its own FBO at full opacity, then a fullscreen pass computes
    //   result = mix(lower, upper, frac)
    // on the premultiplied-alpha colors. This is a real linear lerp: shared
    // content (identical in both layers) stays exactly itself at every frac,
    // while content unique to one layer fades symmetrically. We bypass the
    // FBO path at the endpoints to avoid two extra full-screen passes when
    // the zoom is at rest.
    if (frac === 0) {
      this.drawTileLayer(lower, 1, false);
    } else if (frac === 1) {
      this.drawTileLayer(upper, 1, false);
    } else {
      this.composer.bindLayer(0);
      this.drawTileLayer(lower, 1, false);
      this.composer.bindLayer(1);
      this.drawTileLayer(upper, 1, true);   // upper: no parent fallback
      this.composer.composite(frac);
    }
  }

  /**
   * Build a 4×4 column-major MVP matrix for a perspective top-down camera.
   * The camera is directly above the scene looking down. The view matrix
   * flips Y (world Y-down → clip Y-up) and translates Z by -camHeight.
   * The translation by `-camera.center` is still performed on the CPU
   * in float64 to avoid catastrophic cancellation at deep zoom.
   */
  private buildMVP(out: Float32Array): void {
    const s = this.camera.scale;
    const FOV_DEG = 60;
    const halfFov = (FOV_DEG * 0.5 * Math.PI) / 180;
    const tanHalf = Math.tan(halfFov);
    const f = 1 / tanHalf;
    const aspect = this.viewW / this.viewH;
    // Camera height so that ground coverage matches the 2D view.
    const h = this.viewH / (2 * s * tanHalf);
    // Remember it so translucent prisms can be depth-sorted by true camera
    // distance (see drawTileLayer / prismCamDist2).
    this.camHeight = h;
    const near = h * 0.1;
    const far = h * 2.0;
    const nf = far - near;
    // Column-major 4×4 = Projection × View (no translation — positions are camera-relative).
    out[0]  = f / aspect; out[1]  = 0;   out[2]  = 0;                       out[3]  = 0;
    out[4]  = 0;          out[5]  = -f;  out[6]  = 0;                       out[7]  = 0;
    out[8]  = 0;          out[9]  = 0;   out[10] = -(far + near) / nf;      out[11] = -1;
    out[12] = 0;          out[13] = 0;   out[14] = (h * (far + near) - 2 * far * near) / nf;  out[15] = h;
  }

  // --- Per-frame cache helpers ---

  private _ensureFrameCache(): void {
    if (this._cachedSeq === this._frameSeq) return;
    this._cachedSeq = this._frameSeq;
    const zl = zoomLayers(this.camera.zoom, this.opts.minTileZ, this.opts.maxTileZ);
    this._zl.lower = zl.lower;
    this._zl.upper = zl.upper;
    this._zl.frac = zl.frac;
    this._layerTiles.clear();
  }

  private _getCachedTiles(z: number): TileCoord[] {
    let t = this._layerTiles.get(z);
    if (!t) {
      const margin = this.opts.tileMargin ? this.opts.tileMargin(z) : 1;
      t = visibleTiles(this.camera, this.viewW, this.viewH, z, margin);
      this._layerTiles.set(z, t);
    }
    return t;
  }

  private drawTileLayer(z: number, opacity: number, skipFallback = false): void {
    const tiles = this._getCachedTiles(z);

    // Snapshot the camera center once per layer. ALL world positions written
    // into the float32 instance buffers below are shifted by (-cx, -cy) in
    // float64 first; the view matrix has no translation term. This is what
    // keeps deep-zoom rendering stable -- see `buildViewMatrix` for details.
    const cx = this.camera.centerX;
    const cy = this.camera.centerY;

    // First pass: colored shapes split into three batches by geometry cost.
    //  - flat:     height=0 shapes (6 indices/instance — fast path)
    //  - box:      rects with height>0 (36 indices/instance)
    //  - cylinder: circles with height>0 (384 indices/instance)
    let flatCount = 0;
    let flatArr = SCRATCH_FLAT;
    const ensureFlat = (n: number) => {
      const need = (flatCount + n) * COLORED_STRIDE;
      if (flatArr.length < need) {
        const next = new Float32Array(Math.max(need, flatArr.length * 2));
        next.set(flatArr);
        flatArr = next;
        SCRATCH_FLAT = flatArr;
      }
    };
    let boxCount = 0;
    let boxArr = SCRATCH_BOX;
    const ensureBox = (n: number) => {
      const need = (boxCount + n) * COLORED_STRIDE;
      if (boxArr.length < need) {
        const next = new Float32Array(Math.max(need, boxArr.length * 2));
        next.set(boxArr);
        boxArr = next;
        SCRATCH_BOX = boxArr;
      }
    };
    let cylCount = 0;
    let cylArr = SCRATCH_CYL;
    const ensureCyl = (n: number) => {
      const need = (cylCount + n) * COLORED_STRIDE;
      if (cylArr.length < need) {
        const next = new Float32Array(Math.max(need, cylArr.length * 2));
        next.set(cylArr);
        cylArr = next;
        SCRATCH_CYL = cylArr;
      }
    };
    let hexCount = 0;
    let hexArr = SCRATCH_HEX;
    const ensureHex = (n: number) => {
      const need = (hexCount + n) * COLORED_STRIDE;
      if (hexArr.length < need) {
        const next = new Float32Array(Math.max(need, hexArr.length * 2));
        next.set(hexArr);
        hexArr = next;
        SCRATCH_HEX = hexArr;
      }
    };
    let flatHexCount = 0;
    let flatHexArr = SCRATCH_FLATHEX;
    const ensureFlatHex = (n: number) => {
      const need = (flatHexCount + n) * COLORED_STRIDE;
      if (flatHexArr.length < need) {
        const next = new Float32Array(Math.max(need, flatHexArr.length * 2));
        next.set(flatHexArr);
        flatHexArr = next;
        SCRATCH_FLATHEX = flatHexArr;
      }
    };
    let vectorOffset = 0; // offset in floats into vectorArr
    let vectorArr = SCRATCH_VECTOR;
    const ensureVector = (floats: number) => {
      const need = vectorOffset + floats;
      if (vectorArr.length < need) {
        const next = new Float32Array(Math.max(need, vectorArr.length * 2));
        next.set(vectorArr);
        vectorArr = next;
        SCRATCH_VECTOR = vectorArr;
      }
    };
    let meshOffset = 0; // offset in floats into meshArr
    let meshArr = SCRATCH_MESH;
    const ensureMesh = (floats: number) => {
      const need = meshOffset + floats;
      if (meshArr.length < need) {
        const next = new Float32Array(Math.max(need, meshArr.length * 2));
        next.set(meshArr);
        meshArr = next;
        SCRATCH_MESH = meshArr;
      }
    };
    // Extruded prisms are collected here and tessellated AFTER the tile loop so
    // they can first be sorted back-to-front (translucent, depth-writes off).
    const prisms = SCRATCH_PRISMS;
    prisms.length = 0;

    // Group textured instances by texture (rendered one draw call per texture).
    // Reuse the module-level pooled map: reset counts for existing entries so
    // their Float32Arrays survive across frames without reallocation.
    for (const b of SCRATCH_TEXTURED.values()) b.count = 0;
    const texturedBatches = SCRATCH_TEXTURED;
    const pushTextured = (tex: WebGLTexture, rect: [number, number, number, number], color: RGBA, uv: [number, number, number, number], elevation = 0) => {
      let b = texturedBatches.get(tex);
      if (!b) { b = { arr: new Float32Array(TEXTURED_STRIDE * 32), count: 0 }; texturedBatches.set(tex, b); }
      const need = (b.count + 1) * TEXTURED_STRIDE;
      if (b.arr.length < need) {
        const next = new Float32Array(Math.max(need, b.arr.length * 2));
        next.set(b.arr);
        b.arr = next;
      }
      const o = b.count * TEXTURED_STRIDE;
      // Shift to camera-relative coords (float64 subtract, then narrow).
      b.arr[o] = rect[0] - cx; b.arr[o + 1] = rect[1] - cy; b.arr[o + 2] = rect[2]; b.arr[o + 3] = rect[3];
      b.arr[o + 4] = color[0]; b.arr[o + 5] = color[1]; b.arr[o + 6] = color[2]; b.arr[o + 7] = color[3];
      b.arr[o + 8] = uv[0]; b.arr[o + 9] = uv[1]; b.arr[o + 10] = uv[2]; b.arr[o + 11] = uv[3];
      b.arr[o + 12] = elevation;
      b.count++;
    };

    for (const t of tiles) {
      const entry = this.cache.get(t.z, t.x, t.y);
      let flat = entry?.tile;
      if (!flat) {
        if (skipFallback) {
          // Upper layer of cross-fade: don't use parent fallback.
          // Missing tiles stay transparent — the lower layer shows through.
          // This prevents wrong-layer content (e.g., Hosts) appearing where
          // the new layer (e.g., VMs) hasn't loaded yet.
          continue;
        }
        // Single-layer or lower layer: try parent tile as fallback.
        const parentEntry = this.cache.get(t.z - 1, t.x >> 1, t.y >> 1);
        if (parentEntry?.tile) {
          flat = parentEntry.tile;
        } else {
          continue;
        }
      }
      // Bulk of a dense tile: blit the pre-packed instance records and only add
      // the camera offset, instead of walking element objects and re-deriving
      // every field. Whatever could not be packed falls through to the loop.
      let packed = flat.packed;
      if (packed === undefined) packed = flat.packed = this.packTile(flat);
      let list: readonly FlatElement[] = flat.elements;
      if (packed) {
        if (packed.epoch !== this._colorEpoch) {
          packed.epoch = this._colorEpoch;
          refreshPacked(packed);
        }
        const dx = packed.ox - cx;
        const dy = packed.oy - cy;
        if (packed.flat) {
          ensureFlat(packed.flat.count);
          flatCount = blitPacked(flatArr, flatCount, packed.flat, dx, dy);
        }
        if (packed.flatHex) {
          ensureFlatHex(packed.flatHex.count);
          flatHexCount = blitPacked(flatHexArr, flatHexCount, packed.flatHex, dx, dy);
        }
        if (packed.box) {
          ensureBox(packed.box.count);
          boxCount = blitPacked(boxArr, boxCount, packed.box, dx, dy);
        }
        if (packed.cyl) {
          ensureCyl(packed.cyl.count);
          cylCount = blitPacked(cylArr, cylCount, packed.cyl, dx, dy);
        }
        if (packed.hex) {
          ensureHex(packed.hex.count);
          hexCount = blitPacked(hexArr, hexCount, packed.hex, dx, dy);
        }
        list = packed.rest;
      }
      for (const el of list) {
        if (el.type === 'shape') {
          const isRect = el.shape === 'rect';
          const isHex = el.shape === 'hexagon';
          const has3D = (el.height ?? 0) > 0;
          if (isHex) {
            if (has3D) {
              // 3D hexagon: full extruded prism (flat top + lit side walls).
              if (el.stroke && el.strokeWidth) {
                ensureHex(2);
                this.writeStroke(hexArr, hexCount, el as ShapeElement, cx, cy);
                hexCount++;
                this.writeColored(hexArr, hexCount, el, cx, cy);
                hexCount++;
              } else {
                ensureHex(1);
                this.writeColored(hexArr, hexCount, el, cx, cy);
                hexCount++;
              }
            } else {
              // Flat hexagon (height=0): draw only the top-face fan. A collapsed
              // prism would render identically but pay for 24 assembled
              // triangles per cell (discarded walls + culled bottom); the fan is
              // 6, which is what keeps a 50k-cell honeycomb cheap.
              if (el.stroke && el.strokeWidth) {
                ensureFlatHex(2);
                this.writeStroke(flatHexArr, flatHexCount, el as ShapeElement, cx, cy);
                flatHexCount++;
                this.writeColored(flatHexArr, flatHexCount, el, cx, cy);
                flatHexCount++;
              } else {
                ensureFlatHex(1);
                this.writeColored(flatHexArr, flatHexCount, el, cx, cy);
                flatHexCount++;
              }
            }
          } else if (has3D) {
            // 3D path: box for rects, cylinder for circles
            if (el.stroke && el.strokeWidth) {
              if (isRect) {
                ensureBox(2);
                this.writeStroke(boxArr, boxCount, el as ShapeElement, cx, cy);
                boxCount++;
                this.writeColored(boxArr, boxCount, el, cx, cy);
                boxCount++;
              } else {
                ensureCyl(2);
                this.writeStroke(cylArr, cylCount, el as ShapeElement, cx, cy);
                cylCount++;
                this.writeColored(cylArr, cylCount, el, cx, cy);
                cylCount++;
              }
            } else {
              if (isRect) {
                ensureBox(1);
                this.writeColored(boxArr, boxCount, el, cx, cy);
                boxCount++;
              } else {
                ensureCyl(1);
                this.writeColored(cylArr, cylCount, el, cx, cy);
                cylCount++;
              }
            }
          } else {
            // Flat path: 6 indices/instance (fast)
            if (el.stroke && el.strokeWidth) {
              ensureFlat(2);
              this.writeStroke(flatArr, flatCount, el as ShapeElement, cx, cy);
              flatCount++;
              this.writeColored(flatArr, flatCount, el, cx, cy);
              flatCount++;
            } else {
              ensureFlat(1);
              this.writeColored(flatArr, flatCount, el, cx, cy);
              flatCount++;
            }
          }
        } else if (el.type === 'image') {
          const tex = this.textures.getImage(el.url);
          pushTextured(tex.texture, [el.x, el.y, el.w, el.h], [1, 1, 1, 1], [0, 0, 1, 1]);
        } else if (el.type === 'text') {
          // Floating text: constant screen-pixel size regardless of zoom.
          // Regular text: world-unit size that scales with zoom.
          if (el.floating) {
            const floatPx = el.size * this.dpr;
            const sizePx = bucketTextSize(Math.max(10, Math.min(96, Math.round(floatPx))));
            const color = el.color ?? ([1, 1, 1, 1] as RGBA);
            const tex = this.textures.getText(el.text, sizePx, color, el.font, el.tracking, el.halo);
            // Convert screen pixels back to world units at the *live* camera
            // scale (not the tile layer's native scale). The floating texture
            // is already generated at a fixed screen size regardless of zoom,
            // so there is no cache cost — and using the live scale keeps the
            // label an exact constant on-screen size with no per-layer
            // "breathing". It also makes the label pixel-identical in both
            // cross-fading layers, so the compositor cancels the duplicate
            // instead of showing two mismatched copies during a transition.
            const worldPerPx = 1 / (this.camera.scale * this.dpr);
            const worldW = tex.width * worldPerPx;
            const worldH = tex.height * worldPerPx;
            const tx = el.align === 'center' ? el.x - worldW * 0.5 : el.x;
            const ty = el.y - worldH * 0.5 + (tex.yBias ?? 0) * worldH;
            pushTextured(tex.texture, [tx, ty, worldW, worldH], [1, 1, 1, 1], [0, 0, 1, 1], el.elevation ?? 0);
          } else {
          // Pick Canvas pixel size from the *tile layer's* native scale, not
          // the live camera scale. Otherwise every fractional zoom step
          // regenerates every visible text texture (CPU + GL upload thrash)
          // and the TextureCache grows unboundedly during a zoom animation.
          // Using scaleAt(z) keeps the cache key stable across an animation
          // and lets the GPU's LINEAR filter blend the size mismatch (which
          // is already imperceptible during the cross-fade).
          const screenPx = el.size * this.camera.scaleAt(z) * this.dpr;
          // Skip text that would be unreadably small on screen — avoids
          // creating a Canvas2D texture + GPU upload for sub-pixel text.
          if (screenPx < 6) continue;
          // Clamp to keep texture costs reasonable, then snap to a discrete
          // bucket. The TextureCache also buckets internally; we mirror it
          // here so the world rect we compute matches the bucket-sized
          // texture's pixel dimensions.
          const sizePx = bucketTextSize(Math.max(10, Math.min(96, Math.round(screenPx))));
          const color = el.color ?? ([1, 1, 1, 1] as RGBA);
          const tex = this.textures.getText(el.text, sizePx, color, el.font, el.tracking, el.halo);
          // Map texture to world rect of width texWidth / sizePx * el.size.
          const worldW = (tex.width / sizePx) * el.size;
          const worldH = (tex.height / sizePx) * el.size;
          const tx = el.align === 'center' ? el.x - worldW * 0.5 : el.x;
          const ty = el.y - worldH * 0.5 + (tex.yBias ?? 0) * worldH; // vertically center on cap-height midline
          pushTextured(tex.texture, [tx, ty, worldW, worldH], [1, 1, 1, 1], [0, 0, 1, 1], el.elevation ?? 0);
          }
        } else if (el.type === 'vector') {
          // Fill pass: reuse a cached triangle soup (world-space positions), so
          // the O(n²) ear-clip runs ONCE per element (lazily on first draw, or
          // supplied pre-baked). Per frame we only subtract the camera centre
          // and write the (possibly live-updated) colour — cheap even for the
          // thousands of cluster polygons drawn at the zoomed-out aggregates.
          if (el.fill) {
            let tris = el.fillTris;
            if (!tris) tris = el.fillTris = buildFillTris(el.rings);
            const nv = tris.length >> 1;
            if (nv > 0) {
              ensureVector(nv * VECTOR_STRIDE);
              const [fr, fg, fb, fa] = el.fill;
              let o = vectorOffset;
              for (let i = 0; i < nv; i++) {
                vectorArr[o] = tris[i * 2] - cx;
                vectorArr[o + 1] = tris[i * 2 + 1] - cy;
                vectorArr[o + 2] = fr;
                vectorArr[o + 3] = fg;
                vectorArr[o + 4] = fb;
                vectorArr[o + 5] = fa;
                o += VECTOR_STRIDE;
              }
              vectorOffset = o;
            }
          }
          // Stroke pass: tessellate each ring as a ribbon of quads.
          if (el.stroke && el.strokeWidth) {
            const [sr, sg, sb, sa] = el.stroke;
            const sw = el.strokeScreen ? el.strokeWidth / this.camera.scale : el.strokeWidth;
            for (const ring of el.rings) {
              const n = ring.length >> 1;
              // Rings are implicitly closed (first vertex connects to last).
              const verts = strokeVertexCount(n, true);
              if (verts > 0) {
                ensureVector(verts * VECTOR_STRIDE);
                vectorOffset = tessellateStroke(ring, sw, vectorArr, vectorOffset, cx, cy, sr, sg, sb, sa, true);
              }
            }
          }
        } else if (el.type === 'extruded') {
          prisms.push(el);
        }
      }
    }

    // Tessellate the translucent prisms sorted far -> near. Depth-WRITES are
    // off so the faces blend, which means DRAW ORDER — not the depth buffer —
    // decides which prism paints over which. Under this perspective camera
    // (hovering at camHeight straight above the scene) a prism's on-screen
    // occlusion depends on its full 3D distance from the camera, NOT on its
    // height alone: a tall prism far to the back (high on screen) must not
    // paint over a short prism up front. So rank each prism by the squared
    // camera distance of its top-centre and emit farthest -> nearest, letting
    // nearer prisms correctly overwrite farther ones.
    const camH = this.camHeight;
    prisms.sort(
      (a, b) => prismCamDist2(b, camH, cx, cy) - prismCamDist2(a, camH, cx, cy),
    );
    for (const el of prisms) {
      for (const ring of el.rings) {
        const n = ring.length >> 1;
        if (n < 3) continue;
        ensureMesh(9 * n * MESH_STRIDE);
        meshOffset = tessellateExtruded(ring, el.height, el.fill, meshArr, meshOffset, cx, cy);
      }
    }

    // Bind colored program once, then issue all geometry batches.
    this.renderer.bindColored(this.viewMat, opacity);
    if (flatCount > 0) {
      this.renderer.drawFlat(flatArr, flatCount);
    }
    if (boxCount > 0) {
      this.renderer.drawBoxes(boxArr, boxCount);
    }
    if (cylCount > 0) {
      this.renderer.drawCylinders(cylArr, cylCount);
    }
    if (hexCount > 0) {
      this.renderer.drawHexPrisms(hexArr, hexCount);
    }
    if (flatHexCount > 0) {
      this.renderer.drawFlatHex(flatHexArr, flatHexCount);
    }
    // Extruded polygon meshes (workload prisms): 3D and depth-TESTED, but with
    // depth-WRITES and back-face culling OFF, so the translucent faces actually
    // blend — you can see through a prism to the faces/prisms behind it — rather
    // than the nearest face fully occluding everything behind it.
    const meshVertexCount = meshOffset / MESH_STRIDE;
    if (meshVertexCount > 0) {
      this.gl.disable(this.gl.CULL_FACE);
      this.gl.depthMask(false);
      this.renderer.drawMesh(meshArr, meshVertexCount, this.viewMat, opacity);
      this.gl.depthMask(true);
      this.gl.enable(this.gl.CULL_FACE);
    }
    // Vector polygons, text, and images are all flat 2D geometry (z=0), drawn
    // after the colored 3D shapes. They render with depth test and back-face
    // culling disabled: the ear-clipped fill/stroke winding — like the textured
    // quad winding — is not guaranteed to be front-facing after the MVP's
    // Y-flip, so leaving culling on would drop the polygons entirely. Vectors
    // draw before text so labels overlay the geometry.
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const vectorVertexCount = vectorOffset / VECTOR_STRIDE;
    if (vectorVertexCount > 0) {
      this.renderer.drawVectors(vectorArr, vectorVertexCount, this.viewMat, opacity);
    }
    for (const [tex, b] of texturedBatches) {
      if (b.count > 0) {
        this.renderer.drawTextured(b.arr, b.count, this.viewMat, opacity, tex);
      }
    }
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);

    // If text textures were throttled this frame, schedule a redraw so
    // remaining texts get rasterized over the next few frames.
    if (this.textures.hasDeferredText) {
      this._dirty = true;
    }
  }

  private static readonly DEFAULT_FILL: RGBA = [0.5, 0.5, 0.5, 1];

  /**
   * Pack a tile's plain shapes into per-batch instance records once, positioned
   * relative to the tile origin. Per frame only the camera offset and the live
   * fill are applied, which turns a dense tile from a walk over element objects
   * into a typed-array copy. Returns null for tiles too small to pay for the
   * extra arrays.
   */
  private packTile(flat: FlatTile): PackedTile | null {
    const els = flat.elements;
    const counts = { flat: 0, flatHex: 0, box: 0, cyl: 0, hex: 0 };
    let total = 0;
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!isPackable(el)) continue;
      counts[batchOf(el)]++;
      total++;
    }
    if (total < PACK_MIN_SHAPES) return null;

    const span = 1 / Math.pow(2, flat.z);
    const make = (n: number): PackedShapeBatch | null =>
      n === 0 ? null : { data: new Float32Array(n * COLORED_STRIDE), fills: new Array<RGBA>(n), count: 0 };
    const packed: PackedTile = {
      ox: flat.x * span,
      oy: flat.y * span,
      epoch: this._colorEpoch,
      flat: make(counts.flat),
      flatHex: make(counts.flatHex),
      box: make(counts.box),
      cyl: make(counts.cyl),
      hex: make(counts.hex),
      rest: [],
    };
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!isPackable(el)) {
        packed.rest.push(el);
        continue;
      }
      const b = packed[batchOf(el)]!;
      // Packing against the tile origin keeps the stored floats small, so the
      // float32 narrowing stays as accurate as the camera-relative subtract.
      this.writeColored(b.data, b.count, el, packed.ox, packed.oy);
      b.fills[b.count] = el.fill ?? Scene.DEFAULT_FILL;
      b.count++;
    }
    return packed;
  }

  private writeColored(buf: Float32Array, idx: number, el: FlatElement & { type: 'shape' }, cx: number, cy: number): void {
    const o = idx * COLORED_STRIDE;
    const fill = el.fill ?? Scene.DEFAULT_FILL;
    const ht = el.height ?? 0;
    if (el.shape === 'arc') {
      const d = Math.max(el.w, el.h);
      buf[o] = (el.x - cx) - d / 2;
      buf[o + 1] = (el.y - cy) - d / 2;
      buf[o + 2] = d;
      buf[o + 3] = d;
      buf[o + 4] = fill[0]; buf[o + 5] = fill[1]; buf[o + 6] = fill[2]; buf[o + 7] = fill[3];
      buf[o + 8] = 2;
      buf[o + 9] = el.arcInner ?? 0;
      buf[o + 10] = el.arcStart ?? 0;
      buf[o + 11] = el.arcEnd ?? (Math.PI * 2);
      buf[o + 12] = ht;
    } else if (el.shape === 'hexagon') {
      // Centered like a circle, but aShape=0 (no fragment mask): the hex-prism
      // geometry itself provides the hexagonal outline.
      const d = Math.max(el.w, el.h);
      buf[o] = (el.x - cx) - d / 2;
      buf[o + 1] = (el.y - cy) - d / 2;
      buf[o + 2] = d;
      buf[o + 3] = d;
      buf[o + 4] = fill[0]; buf[o + 5] = fill[1]; buf[o + 6] = fill[2]; buf[o + 7] = fill[3];
      buf[o + 8] = 0;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else if (el.shape === 'circle') {
      const d = Math.max(el.w, el.h);
      buf[o] = (el.x - cx) - d / 2;
      buf[o + 1] = (el.y - cy) - d / 2;
      buf[o + 2] = d;
      buf[o + 3] = d;
      buf[o + 4] = fill[0]; buf[o + 5] = fill[1]; buf[o + 6] = fill[2]; buf[o + 7] = fill[3];
      buf[o + 8] = 1;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else if (el.shape === 'ellipse') {
      buf[o] = (el.x - cx) - el.w / 2;
      buf[o + 1] = (el.y - cy) - el.h / 2;
      buf[o + 2] = el.w;
      buf[o + 3] = el.h;
      buf[o + 4] = fill[0]; buf[o + 5] = fill[1]; buf[o + 6] = fill[2]; buf[o + 7] = fill[3];
      buf[o + 8] = 1;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else {
      const inset = el.insetScreen ? el.insetScreen / this.camera.scale : 0;
      buf[o] = el.x - cx + inset;
      buf[o + 1] = el.y - cy + inset;
      buf[o + 2] = Math.max(0, el.w - inset * 2);
      buf[o + 3] = Math.max(0, el.h - inset * 2);
      buf[o + 4] = fill[0]; buf[o + 5] = fill[1]; buf[o + 6] = fill[2]; buf[o + 7] = fill[3];
      buf[o + 8] = 0;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    }
  }

  private writeStroke(buf: Float32Array, idx: number, el: ShapeElement, cx: number, cy: number): void {
    const o = idx * COLORED_STRIDE;
    const stroke = el.stroke!;
    // Screen-space strokes keep a constant on-screen thickness: convert the
    // authored CSS-pixel width into world units at the current camera scale.
    const sw = el.strokeScreen ? el.strokeWidth! / this.camera.scale : el.strokeWidth!;
    const ht = el.height ?? 0;
    if (el.shape === 'hexagon') {
      const d = Math.max(el.w, el.h) + sw * 2;
      buf[o] = (el.x - cx) - d / 2;
      buf[o + 1] = (el.y - cy) - d / 2;
      buf[o + 2] = d;
      buf[o + 3] = d;
      buf[o + 4] = stroke[0]; buf[o + 5] = stroke[1]; buf[o + 6] = stroke[2]; buf[o + 7] = stroke[3];
      buf[o + 8] = 0;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else if (el.shape === 'circle') {
      const d = Math.max(el.w, el.h) + sw * 2;
      buf[o] = (el.x - cx) - d / 2;
      buf[o + 1] = (el.y - cy) - d / 2;
      buf[o + 2] = d;
      buf[o + 3] = d;
      buf[o + 4] = stroke[0]; buf[o + 5] = stroke[1]; buf[o + 6] = stroke[2]; buf[o + 7] = stroke[3];
      buf[o + 8] = 1;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else if (el.shape === 'ellipse') {
      buf[o] = (el.x - cx) - el.w / 2 - sw;
      buf[o + 1] = (el.y - cy) - el.h / 2 - sw;
      buf[o + 2] = el.w + sw * 2;
      buf[o + 3] = el.h + sw * 2;
      buf[o + 4] = stroke[0]; buf[o + 5] = stroke[1]; buf[o + 6] = stroke[2]; buf[o + 7] = stroke[3];
      buf[o + 8] = 1;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    } else {
      buf[o] = el.x - cx - sw;
      buf[o + 1] = el.y - cy - sw;
      buf[o + 2] = el.w + sw * 2;
      buf[o + 3] = el.h + sw * 2;
      buf[o + 4] = stroke[0]; buf[o + 5] = stroke[1]; buf[o + 6] = stroke[2]; buf[o + 7] = stroke[3];
      buf[o + 8] = 0;
      buf[o + 9] = 0; buf[o + 10] = 0; buf[o + 11] = 0; buf[o + 12] = ht;
    }
  }

  /**
   * Release all GPU resources, close WebSocket connections, and cancel
   * pending operations. After calling destroy(), the Scene instance must
   * not be used.
   */
  destroy(): void {
    this.mutations.dispose();
    if (this.wsTileSource) this.wsTileSource.dispose();
    this.renderer.destroy();
    this.textures.destroy();
    this.composer.destroy();
    // Abort any in-flight tile fetches.
    for (const [, entry] of this.cache.entries()) {
      entry.abort?.abort();
    }
    this._dirty = false;
  }
}

type ShapeBatchKind = 'flat' | 'flatHex' | 'box' | 'cyl' | 'hex';

/** Below this a tile is too small for the packed arrays to pay for themselves. */
const PACK_MIN_SHAPES = 64;

/** Shapes whose instance record is fixed once the tile is built. Screen-space
 *  strokes and insets are re-derived from the live camera every frame. */
function isPackable(el: FlatElement): el is ShapeElement {
  return el.type === 'shape' && !(el.stroke && el.strokeWidth) && !el.insetScreen;
}

/** The geometry bucket a shape draws with — mirrors the dispatch in drawTileLayer. */
function batchOf(el: ShapeElement): ShapeBatchKind {
  const has3D = (el.height ?? 0) > 0;
  if (el.shape === 'hexagon') return has3D ? 'hex' : 'flatHex';
  if (!has3D) return 'flat';
  return el.shape === 'rect' ? 'box' : 'cyl';
}

/** Re-read every instance's live fill into the packed records. Chasing tens of
 *  thousands of separate RGBA arrays is the most expensive thing in a dense
 *  frame, so this only runs when the data model reports a content change —
 *  camera-driven frames reuse the colours already packed. */
function refreshPacked(p: PackedTile): void {
  if (p.flat) refreshFills(p.flat);
  if (p.flatHex) refreshFills(p.flatHex);
  if (p.box) refreshFills(p.box);
  if (p.cyl) refreshFills(p.cyl);
  if (p.hex) refreshFills(p.hex);
}

function refreshFills(b: PackedShapeBatch): void {
  const data = b.data;
  const fills = b.fills;
  const n = b.count;
  let o = 4;
  for (let i = 0; i < n; i++) {
    const f = fills[i];
    data[o] = f[0];
    data[o + 1] = f[1];
    data[o + 2] = f[2];
    data[o + 3] = f[3];
    o += COLORED_STRIDE;
  }
}

/** Copy a packed batch into the frame's instance buffer, shifting it to
 *  camera-relative coords. */
function blitPacked(
  dst: Float32Array,
  at: number,
  b: PackedShapeBatch,
  dx: number,
  dy: number,
): number {
  const base = at * COLORED_STRIDE;
  dst.set(b.data, base);
  let o = base;
  for (let i = 0; i < b.count; i++) {
    dst[o] += dx;
    dst[o + 1] += dy;
    o += COLORED_STRIDE;
  }
  return at + b.count;
}

// --- 3D extruded-polygon tessellation (workload prisms) --------------------
// Light direction matching the colored 3D pipeline's fragment shader.
const MESH_LIGHT_X = -0.2673;
const MESH_LIGHT_Y = -0.3578;
const MESH_LIGHT_Z = 0.8944;

function pointInTri2(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, ptcx: number, ptcy: number,
): boolean {
  const v0x = ptcx - ax, v0y = ptcy - ay;
  const v1x = bx - ax, v1y = by - ay;
  const v2x = px - ax, v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (denom === 0) return false;
  const inv = 1 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

/** Ear-clip a simple polygon ring into a flat list of triangle vertex indices. */
function earClip(ring: number[]): number[] {
  const n = ring.length >> 1;
  const tris: number[] = [];
  if (n < 3) return tris;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  if (area2 < 0) idx.reverse();
  let remaining = n;
  let guard = remaining * remaining;
  let i = 0;
  while (remaining > 3 && guard-- > 0) {
    const i0 = idx[i % remaining];
    const i1 = idx[(i + 1) % remaining];
    const i2 = idx[(i + 2) % remaining];
    const ax = ring[i0 * 2], ay = ring[i0 * 2 + 1];
    const bx = ring[i1 * 2], by = ring[i1 * 2 + 1];
    const cxp = ring[i2 * 2], cyp = ring[i2 * 2 + 1];
    let isEar = (bx - ax) * (cyp - ay) - (by - ay) * (cxp - ax) > 0;
    if (isEar) {
      for (let k = 0; k < remaining; k++) {
        if (k === i % remaining || k === (i + 1) % remaining || k === (i + 2) % remaining) continue;
        const p = idx[k];
        if (pointInTri2(ring[p * 2], ring[p * 2 + 1], ax, ay, bx, by, cxp, cyp)) { isEar = false; break; }
      }
    }
    if (isEar) {
      tris.push(i0, i1, i2);
      idx.splice((i + 1) % remaining, 1);
      remaining--;
    } else {
      i++;
    }
  }
  if (remaining === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

/**
 * Append an extruded polygon (top face at z=`height` plus side walls down to
 * z=0) to `out` in MESH_STRIDE layout `[x, y, z, r, g, b, a]`, shifted to be
 * camera-relative by (cx, cy). Faces are flat-shaded (constant per face, no
 * gradient); alpha passes straight through for translucency. Returns the new
 * float offset.
 */
function tessellateExtruded(
  ring: number[],
  height: number,
  fill: RGBA,
  out: Float32Array,
  offset: number,
  cx: number,
  cy: number,
): number {
  const n = ring.length >> 1;
  if (n < 3) return offset;
  const fr = fill[0], fg = fill[1], fb = fill[2], fa = fill[3];
  const stride = MESH_STRIDE;
  let ccx = 0, ccy = 0;
  for (let k = 0; k < n; k++) { ccx += ring[k * 2]; ccy += ring[k * 2 + 1]; }
  ccx /= n; ccy /= n;

  const put = (x: number, y: number, z: number, r: number, g: number, b: number): void => {
    out[offset] = x - cx; out[offset + 1] = y - cy; out[offset + 2] = z;
    out[offset + 3] = r; out[offset + 4] = g; out[offset + 5] = b; out[offset + 6] = fa;
    offset += stride;
  };

  // Side walls first (flat shade per face), then the top face over them, so
  // with depth-writes disabled the translucent top blends over the walls (a
  // glassy look) instead of being hidden behind them.
  for (let e = 0; e < n; e++) {
    const j = (e + 1) % n;
    const x0 = ring[e * 2], y0 = ring[e * 2 + 1];
    const x1 = ring[j * 2], y1 = ring[j * 2 + 1];
    let dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    let nx = dy, ny = -dx;
    if (nx * ((x0 + x1) / 2 - ccx) + ny * ((y0 + y1) / 2 - ccy) < 0) { nx = -nx; ny = -ny; }
    const sh = 0.45 + 0.55 * Math.max(0, nx * MESH_LIGHT_X + ny * MESH_LIGHT_Y);
    const sr = fr * sh, sg = fg * sh, sb = fb * sh;
    put(x0, y0, 0, sr, sg, sb);
    put(x0, y0, height, sr, sg, sb);
    put(x1, y1, height, sr, sg, sb);
    put(x0, y0, 0, sr, sg, sb);
    put(x1, y1, height, sr, sg, sb);
    put(x1, y1, 0, sr, sg, sb);
  }

  // Top face (flat, +Z normal).
  const topShade = 0.45 + 0.55 * MESH_LIGHT_Z;
  const tr = fr * topShade, tg = fg * topShade, tb = fb * topShade;
  const tris = earClip(ring);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    put(ring[a * 2], ring[a * 2 + 1], height, tr, tg, tb);
    put(ring[b * 2], ring[b * 2 + 1], height, tr, tg, tb);
    put(ring[c * 2], ring[c * 2 + 1], height, tr, tg, tb);
  }
  return offset;
}

// Module-level scratch buffers (reused across frames).
let SCRATCH_FLAT = new Float32Array(COLORED_STRIDE * 2048);
let SCRATCH_BOX = new Float32Array(COLORED_STRIDE * 256);
let SCRATCH_CYL = new Float32Array(COLORED_STRIDE * 256);
let SCRATCH_HEX = new Float32Array(COLORED_STRIDE * 512);
let SCRATCH_FLATHEX = new Float32Array(COLORED_STRIDE * 2048);
let SCRATCH_VECTOR = new Float32Array(VECTOR_STRIDE * 4096);
let SCRATCH_MESH = new Float32Array(MESH_STRIDE * 4096);
/**
 * Squared distance from the camera to a prism's top-centre, in camera-relative
 * space where the camera sits at (0, 0, camH) directly above the scene. Used to
 * sort the translucent prisms back-to-front: because depth-writes are off (so
 * the faces blend), draw order alone decides occlusion, and under perspective a
 * prism's on-screen depth is its full 3D camera distance — not its height.
 */
function prismCamDist2(
  el: FlatElement & { type: 'extruded' },
  camH: number,
  cx: number,
  cy: number,
): number {
  const ring = el.rings[0];
  if (!ring) return camH * camH;
  const n = ring.length >> 1;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += ring[i * 2];
    my += ring[i * 2 + 1];
  }
  mx = mx / n - cx;
  my = my / n - cy;
  const dz = camH - el.height;
  return mx * mx + my * my + dz * dz;
}

// Reused per layer: extruded prisms collected during the tile loop so they can
// be sorted back-to-front (by camera distance) before tessellation, so nearer
// prisms paint over farther ones (see drawTileLayer).
const SCRATCH_PRISMS: (FlatElement & { type: 'extruded' })[] = [];

// Pooled textured batch map. Cleared by resetting counts (not by deleting
// entries) so the backing Float32Arrays survive between frames.
const SCRATCH_TEXTURED = new Map<WebGLTexture, { arr: Float32Array; count: number }>();

// Silence "unused" warnings for the constant TILE_SIZE import — kept to make
// the magic constant explicit for readers of this file.
void TILE_SIZE;
