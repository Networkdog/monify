// Cache of GPU textures for text and remote images. Keys are stable strings.

import type { RGBA } from '../types';

export interface TextureEntry {
  texture: WebGLTexture;
  /** Texture pixel width. */
  width: number;
  /** Texture pixel height. */
  height: number;
  /** World-space height the texture represents (for text: world font size). */
  worldHeight?: number;
  /** True when the GPU upload is complete. */
  ready: boolean;
  /** Frame index of most recent access (LRU). */
  lastUsedFrame: number;
  /** Approximate GPU footprint in pixels (width * height). */
  pixels: number;
  /** Key in the cache map (for fast eviction). */
  key: string;
  /** Fraction of texture height by which the visual center sits above the
   *  geometric center (descent / (2 * height)). Used to vertically center
   *  text on its cap-height midline rather than the ascent+descent midline. */
  yBias?: number;
}

/**
 * Discrete font-size buckets used to key text textures. Without bucketing,
 * a continuous zoom animation creates a new texture every frame because
 * `sizePx` changes by ~1 each tick — pure CPU + GPU upload thrash with no
 * visual benefit (the LINEAR sampler hides the resulting fractional scale).
 */
const TEXT_SIZE_BUCKETS = [10, 12, 14, 16, 20, 24, 32, 40, 48, 64, 96] as const;
export function bucketTextSize(px: number): number {
  for (const b of TEXT_SIZE_BUCKETS) if (px <= b) return b;
  return TEXT_SIZE_BUCKETS[TEXT_SIZE_BUCKETS.length - 1];
}

/** Soft cap on cached texture pixels before LRU eviction kicks in (~32 MB at RGBA8). */
const DEFAULT_PIXEL_BUDGET = 8 * 1024 * 1024;
/** Always keep at least this many entries regardless of budget. */
const MIN_RETAINED_ENTRIES = 32;
/** Max retries for failed image loads. */
const IMAGE_MAX_RETRIES = 3;
/** Base delay (ms) between image load retries (doubles each attempt). */
const IMAGE_RETRY_BASE_MS = 500;

export class TextureCache {
  private gl: WebGL2RenderingContext;
  private map = new Map<string, TextureEntry>();
  private totalPixels = 0;
  private frame = 0;
  private pixelBudget: number;
  private anisoExt: EXT_texture_filter_anisotropic | null;
  private maxAniso: number;
  /** Shared scratch canvas + context for text rendering — avoids expensive
   *  document.createElement + getContext allocations on every cache miss. */
  private scratchCanvas: HTMLCanvasElement | OffscreenCanvas;
  private scratchCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Number of text textures rasterized in the current frame. */
  private textMintedThisFrame = 0;
  /** Max textures to rasterize per frame — spreads cold-cache cost. */
  private readonly TEXT_MINT_BUDGET = 16;
  /** 1×1 transparent placeholder texture for deferred text. */
  private placeholderTex: WebGLTexture | null = null;
  /** True when getText() returned a placeholder this frame (caller should redraw). */
  hasDeferredText = false;

  constructor(gl: WebGL2RenderingContext, pixelBudget: number = DEFAULT_PIXEL_BUDGET) {
    this.gl = gl;
    this.pixelBudget = pixelBudget;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    // Pre-allocate a scratch canvas for text rendering to avoid per-text
    // DOM element creation (the main cause of cold-cache stutter).
    if (typeof OffscreenCanvas !== 'undefined') {
      this.scratchCanvas = new OffscreenCanvas(256, 64);
      this.scratchCtx = this.scratchCanvas.getContext('2d')!;
    } else {
      this.scratchCanvas = document.createElement('canvas');
      this.scratchCtx = this.scratchCanvas.getContext('2d')!;
    }
    this.maxAniso = this.anisoExt
      ? Math.min(8, gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT))
      : 0;
  }

  /** Advance the frame counter (called once per scene.draw). */
  frameTick(): void {
    this.frame++;
    this.textMintedThisFrame = 0;
    this.hasDeferredText = false;
  }

  get(key: string): TextureEntry | undefined {
    const e = this.map.get(key);
    if (e) e.lastUsedFrame = this.frame;
    return e;
  }

  /** Number of cached texture entries (text + image). */
  size(): number {
    return this.map.size;
  }

  /** Approximate GPU bytes (RGBA8) currently held. */
  bytes(): number {
    return this.totalPixels * 4;
  }

  /** Get or create a text texture rendered with Canvas2D. */
  /**
   * Get or create a text texture.
   * @param fontSpec Optional CSS font fragment prepended before the size.
   *   Format: `"[style] [weight] [family]"` — any subset is valid.
   *   Examples: `"bold"`, `"italic bold"`, `"bold monospace"`,
   *   `"italic 'Courier New', monospace"`.
   *   The size is always injected by the engine.
   */
  getText(text: string, sizePx: number, color: RGBA, fontSpec?: string): TextureEntry {
    const r = Math.round(color[0] * 255);
    const g = Math.round(color[1] * 255);
    const b = Math.round(color[2] * 255);
    const a = color[3];
    // Snap to a discrete bucket so the cache key stays stable across a zoom.
    const bucket = bucketTextSize(sizePx);
    const fontKey = fontSpec ?? '';
    const key = `text:${bucket}:${r},${g},${b},${a}:${fontKey}:${text}`;
    const cached = this.map.get(key);
    if (cached) { cached.lastUsedFrame = this.frame; return cached; }

    // Throttle: limit rasterizations per frame to prevent cold-cache stutter
    // when many unique text strings appear simultaneously (e.g. Region names
    // at zoom 12). Deferred texts get a transparent placeholder and will be
    // rasterized on subsequent frames.
    if (this.textMintedThisFrame >= this.TEXT_MINT_BUDGET) {
      this.hasDeferredText = true;
      return this.getPlaceholder();
    }
    this.textMintedThisFrame++;

    sizePx = bucket;

    const canvas = this.scratchCanvas;
    const ctx = this.scratchCtx;
    // Build CSS font string. fontSpec can be:
    //   "bold"                    → "bold 24px ui-sans-serif, ..."
    //   "italic bold monospace"   → "italic bold 24px monospace"
    //   undefined                 → "24px ui-sans-serif, ..."
    const defaultFamily = 'ui-sans-serif, system-ui, sans-serif';
    let font: string;
    if (fontSpec) {
      // Check if fontSpec contains a font family (comma or known keyword)
      const familyKeywords = /serif|sans-serif|monospace|system-ui|ui-sans-serif|cursive|fantasy|'|"/i;
      if (familyKeywords.test(fontSpec)) {
        // Extract style/weight prefix and family suffix
        // Split on the first family keyword occurrence
        const parts = fontSpec.split(/(?=(?:serif|sans-serif|monospace|system-ui|ui-sans-serif|cursive|fantasy|'|"))/i);
        const prefix = parts[0].trim(); // "bold italic" etc.
        const family = fontSpec.slice(prefix.length).trim() || defaultFamily;
        font = prefix ? `${prefix} ${sizePx}px ${family}` : `${sizePx}px ${family}`;
      } else {
        // Just style/weight, no family
        font = `${fontSpec} ${sizePx}px ${defaultFamily}`;
      }
    } else {
      font = `${sizePx}px ${defaultFamily}`;
    }
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const ascent = metrics.actualBoundingBoxAscent || sizePx * 0.8;
    const descent = metrics.actualBoundingBoxDescent || sizePx * 0.2;
    const padding = 2;
    const w = Math.max(1, Math.ceil(metrics.width + padding * 2));
    const h = Math.max(1, Math.ceil(ascent + descent + padding * 2));
    canvas.width = w;
    canvas.height = h;
    // Resizing resets context state; re-apply font and baseline.
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fillText(text, padding, padding + ascent);

    const entry = this.uploadCanvas(canvas, key);
    entry.worldHeight = h / sizePx; // scale factor for world->texture-rows
    entry.yBias = descent / (2 * h); // visual center offset
    this.map.set(key, entry);
    this.totalPixels += entry.pixels;
    this.evictIfNeeded();
    return entry;
  }

  /** Lazy-init 1×1 transparent placeholder for throttled text. */
  private getPlaceholder(): TextureEntry {
    if (!this.placeholderTex) {
      const gl = this.gl;
      this.placeholderTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.placeholderTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    return {
      texture: this.placeholderTex, width: 1, height: 1, ready: true,
      lastUsedFrame: this.frame, pixels: 0, key: '__placeholder__',
    };
  }

  /** Get or create an image texture (asynchronously loaded). */
  getImage(url: string): TextureEntry {
    const key = `img:${url}`;
    const cached = this.map.get(key);
    if (cached) { cached.lastUsedFrame = this.frame; return cached; }

    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 1x1 transparent placeholder until load completes.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const entry: TextureEntry = {
      texture: tex, width: 1, height: 1, ready: false,
      lastUsedFrame: this.frame, pixels: 1, key,
    };
    this.map.set(key, entry);
    this.totalPixels += 1;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (this.anisoExt) {
        gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAniso);
      }
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      // Adjust budget bookkeeping now that the real size is known.
      this.totalPixels -= entry.pixels;
      entry.pixels = entry.width * entry.height;
      this.totalPixels += entry.pixels;
      entry.ready = true;
      this.evictIfNeeded();
    };
    // Retry with exponential backoff (up to IMAGE_MAX_RETRIES attempts).
    let retries = 0;
    img.onerror = () => {
      if (retries < IMAGE_MAX_RETRIES) {
        const delay = IMAGE_RETRY_BASE_MS * Math.pow(2, retries);
        retries++;
        setTimeout(() => { img.src = url; }, delay);
      } else {
        entry.ready = false;
      }
    };
    img.src = url;
    return entry;
  }

  /**
   * Get or create a texture from a pre-drawn canvas. The caller renders
   * content into the canvas; the cache stores it by `key` and handles
   * GPU upload, LRU eviction, and budget management.
   */
  getCanvas(key: string, canvas: HTMLCanvasElement): TextureEntry {
    const cached = this.map.get(key);
    if (cached) { cached.lastUsedFrame = this.frame; return cached; }
    const entry = this.uploadCanvas(canvas, key);
    this.map.set(key, entry);
    this.totalPixels += entry.pixels;
    this.evictIfNeeded();
    return entry;
  }

  private uploadCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, key: string): TextureEntry {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return {
      texture: tex, width: canvas.width, height: canvas.height, ready: true,
      lastUsedFrame: this.frame, pixels: canvas.width * canvas.height, key,
    };
  }

  /**
   * Evict least-recently-used entries until totalPixels fits the budget.
   * Skips entries used on the current frame (still in use). Keeps at least
   * MIN_RETAINED_ENTRIES so a tiny budget can't kill everything.
   */
  private evictIfNeeded(): void {
    if (this.totalPixels <= this.pixelBudget) return;
    if (this.map.size <= MIN_RETAINED_ENTRIES) return;
    // Collect entries not used this frame, oldest first.
    const evictable: TextureEntry[] = [];
    for (const e of this.map.values()) {
      if (e.lastUsedFrame !== this.frame) evictable.push(e);
    }
    evictable.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    const gl = this.gl;
    for (const e of evictable) {
      if (this.totalPixels <= this.pixelBudget) break;
      if (this.map.size <= MIN_RETAINED_ENTRIES) break;
      this.map.delete(e.key);
      this.totalPixels -= e.pixels;
      gl.deleteTexture(e.texture);
    }
  }

  destroy(): void {
    const gl = this.gl;
    for (const e of this.map.values()) gl.deleteTexture(e.texture);
    this.map.clear();
    this.totalPixels = 0;
  }
}
