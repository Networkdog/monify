import { compileProgram } from './context';

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// ---------------------------------------------------------------------------
// 3D colored vertex shader: unit box [0..1]^3 extruded by per-instance
// height (aArc.w), transformed by a 4×4 MVP matrix for perspective from above.
// ---------------------------------------------------------------------------
const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;      // unit box corner [0..1]^3
layout(location = 1) in vec3 aNormal;   // outward face normal
layout(location = 2) in vec4 aRect;     // x, y, w, h (camera-relative world)
layout(location = 3) in vec4 aColor;    // rgba (0..1)
layout(location = 4) in float aShape;   // 0=rect, 1=circle, 2=arc
layout(location = 5) in vec4 aArc;      // innerR, startAngle, endAngle, height

uniform mat4 uMVP;

out vec2 vLocal;
out vec4 vColor;
out vec3 vNormal;
flat out int vShape;
flat out vec4 vArc;

void main() {
  float height = aArc.w;
  vec3 world;
  world.x = aRect.x + aPos.x * aRect.z;
  world.y = aRect.y + aPos.y * aRect.w;
  world.z = aPos.z * height;
  gl_Position = uMVP * vec4(world, 1.0);
  vLocal = aPos.xy * 2.0 - 1.0;
  vColor = aColor;
  vNormal = aNormal;
  vShape = int(aShape);
  vArc = aArc;
}
`;

// ---------------------------------------------------------------------------
// 3D colored fragment shader: per-face directional lighting, circle/arc
// masking on top face, side faces discarded for round shapes.
// ---------------------------------------------------------------------------
const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec4 vColor;
in vec3 vNormal;
flat in int vShape;
flat in vec4 vArc;

uniform float uOpacity;
out vec4 outColor;

void main() {
  float height = vArc.w;
  bool isSideFace = abs(vNormal.z) < 0.5;

  // Discard degenerate side faces (flat shapes with height=0).
  if (isSideFace && height <= 0.0) discard;

  float alpha = 1.0;
  if (vShape == 1) {
    // Circle masking only on top/bottom faces; side faces are fully opaque.
    if (!isSideFace) {
      float d = length(vLocal);
      float aa = fwidth(d) * 1.5;
      alpha = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    }
  } else if (vShape == 2) {
    float d = length(vLocal);
    float innerR = vArc.x;
    float aa = fwidth(d) * 1.5;
    float outerMask = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    float innerMask = smoothstep(innerR - aa, innerR, d);
    float angle = atan(vLocal.y, vLocal.x);
    float startA = vArc.y;
    float endA = vArc.z;
    float a = angle - startA;
    a = a - floor(a / 6.2831853) * 6.2831853;
    float sweep = endA - startA;
    sweep = sweep - floor(sweep / 6.2831853) * 6.2831853;
    float aaA = fwidth(a) * 1.5;
    float angMask = smoothstep(-aaA, aaA, a) * (1.0 - smoothstep(sweep - aaA, sweep + aaA, a));
    alpha = outerMask * innerMask * angMask;
  }

  // Directional lighting (only for 3D shapes; flat shapes stay full brightness).
  float lighting = 1.0;
  if (height > 0.0) {
    vec3 lightDir = vec3(-0.2673, -0.3578, 0.8944);
    float NdotL = max(dot(vNormal, lightDir), 0.0);
    lighting = 0.45 + 0.55 * NdotL;
  }

  vec4 c = vColor;
  c.rgb *= lighting;
  c.a *= alpha * uOpacity;
  outColor = vec4(c.rgb * c.a, c.a);
}
`;

// ---------------------------------------------------------------------------
// Textured vertex shader: flat quad at z=0 with 4×4 MVP.
// ---------------------------------------------------------------------------
const TEXTURED_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec4 aUV;
layout(location = 4) in float aElevation;

uniform mat4 uMVP;

out vec2 vUV;
out vec4 vColor;

void main() {
  vec4 world = vec4(aRect.xy + aCorner * aRect.zw, aElevation, 1.0);
  gl_Position = uMVP * world;
  vUV = mix(aUV.xy, aUV.zw, aCorner);
  vColor = aColor;
}
`;

const TEXTURED_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vColor;

uniform sampler2D uTex;
uniform float uOpacity;
out vec4 outColor;

void main() {
  vec4 t = texture(uTex, vUV);
  vec4 c = t * vColor;
  c.a *= uOpacity;
  outColor = vec4(c.rgb * c.a, c.a);
}
`;

// ---------------------------------------------------------------------------
// 2D vector pipeline: flat-shaded triangles with per-vertex RGBA color.
// Used for arbitrary polygons (`'vector'` tile elements) — both fill rings
// and stroke ribbons are CPU-tessellated into triangles, then drawn as a
// single non-instanced buffer per frame. No depth, no lighting.
// ---------------------------------------------------------------------------
const VECTOR_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;    // camera-relative world XY
layout(location = 1) in vec4 aColor;  // rgba (0..1)

uniform mat4 uMVP;

out vec4 vColor;

void main() {
  gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
  vColor = aColor;
}
`;

const VECTOR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vColor;
uniform float uOpacity;
out vec4 outColor;

void main() {
  vec4 c = vColor;
  c.a *= uOpacity;
  outColor = vec4(c.rgb * c.a, c.a);
}
`;

// ---------------------------------------------------------------------------
// 3D mesh pipeline: per-vertex position + straight RGBA. Used for extruded
// polygons (workload prisms). Flat shading is baked into the vertex colours on
// the CPU (no gradient); the alpha carries translucency. Depth-tested like the
// other 3D shapes, drawn as one non-instanced buffer per frame.
// ---------------------------------------------------------------------------
const MESH_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;    // camera-relative world XYZ
layout(location = 1) in vec4 aColor;  // straight rgba (flat shade baked into rgb)

uniform mat4 uMVP;

out vec4 vColor;

void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  vColor = aColor;
}
`;

const MESH_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vColor;
uniform float uOpacity;
out vec4 outColor;

void main() {
  float a = vColor.a * uOpacity;
  outColor = vec4(vColor.rgb * a, a);
}
`;

// ---------------------------------------------------------------------------
// Unit box geometry: 24 vertices (6 faces × 4 corners), 36 indices.
// Winding is CW from outside each face so that after the Y-flip in the MVP
// the triangles are CCW in clip space (front-facing with GL default).
// ---------------------------------------------------------------------------
// prettier-ignore
const BOX_VERTS = new Float32Array([
  // pos(3) + normal(3)
  // Top face (+Z)
  0,0,1, 0,0,1,  0,1,1, 0,0,1,  1,1,1, 0,0,1,  1,0,1, 0,0,1,
  // Bottom face (-Z) — back-face culled
  0,0,0, 0,0,-1, 1,0,0, 0,0,-1, 1,1,0, 0,0,-1, 0,1,0, 0,0,-1,
  // South face (+Y)
  0,1,0, 0,1,0,  1,1,0, 0,1,0,  1,1,1, 0,1,0,  0,1,1, 0,1,0,
  // North face (-Y)
  1,0,0, 0,-1,0, 0,0,0, 0,-1,0, 0,0,1, 0,-1,0, 1,0,1, 0,-1,0,
  // East face (+X)
  1,1,0, 1,0,0,  1,0,0, 1,0,0,  1,0,1, 1,0,0,  1,1,1, 1,0,0,
  // West face (-X)
  0,0,0, -1,0,0, 0,1,0, -1,0,0, 0,1,1, -1,0,0, 0,0,1, -1,0,0,
]);
// prettier-ignore
const BOX_IDX = new Uint16Array([
  0,1,2,  0,2,3,     // top
  4,5,6,  4,6,7,     // bottom
  8,9,10, 8,10,11,   // south
  12,13,14,12,14,15, // north
  16,17,18,16,18,19, // east
  20,21,22,20,22,23, // west
]);

// ---------------------------------------------------------------------------
// Cylinder geometry: 32-segment prism for circle/ellipse/arc shapes.
// Same winding convention as the box.
// ---------------------------------------------------------------------------
const CYL_N = 32;
// Build an N-sided prism in the unit box [0..1]^3: a top N-gon (+Z), a bottom
// N-gon (-Z, back-face culled), and N side quads with smooth outward normals.
// `angleOffset` rotates the polygon (e.g. -π/2 puts a vertex at the top, for a
// pointy-top hexagon). N=32 approximates a cylinder; N=6 is a hex prism.
function buildPrism(N: number, angleOffset = 0): { verts: Float32Array; idx: Uint16Array; idxCount: number } {
  const verts = new Float32Array(((N + 1) * 2 + N * 2) * 6);
  const idx = new Uint16Array(N * 3 * 2 + N * 6);
  let vi = 0, ii = 0;
  const TAU = Math.PI * 2;
  // --- Top face (normal +Z) ---
  verts[vi++] = 0.5; verts[vi++] = 0.5; verts[vi++] = 1;
  verts[vi++] = 0;   verts[vi++] = 0;   verts[vi++] = 1;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU + angleOffset;
    verts[vi++] = 0.5 + 0.5 * Math.cos(t);
    verts[vi++] = 0.5 + 0.5 * Math.sin(t);
    verts[vi++] = 1;
    verts[vi++] = 0; verts[vi++] = 0; verts[vi++] = 1;
  }
  for (let i = 0; i < N; i++) {
    idx[ii++] = 0; idx[ii++] = 1 + ((i + 1) % N); idx[ii++] = 1 + i;
  }
  // --- Bottom face (normal -Z, back-face culled) ---
  const bc = N + 1;
  verts[vi++] = 0.5; verts[vi++] = 0.5; verts[vi++] = 0;
  verts[vi++] = 0;   verts[vi++] = 0;   verts[vi++] = -1;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU + angleOffset;
    verts[vi++] = 0.5 + 0.5 * Math.cos(t);
    verts[vi++] = 0.5 + 0.5 * Math.sin(t);
    verts[vi++] = 0;
    verts[vi++] = 0; verts[vi++] = 0; verts[vi++] = -1;
  }
  for (let i = 0; i < N; i++) {
    idx[ii++] = bc; idx[ii++] = bc + 1 + i; idx[ii++] = bc + 1 + ((i + 1) % N);
  }
  // --- Side wall (smooth outward normals) ---
  const st = (N + 1) * 2;
  const sb = st + N;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU + angleOffset;
    const cx = Math.cos(t), cy = Math.sin(t);
    // top ring
    verts[vi++] = 0.5 + 0.5 * cx; verts[vi++] = 0.5 + 0.5 * cy; verts[vi++] = 1;
    verts[vi++] = cx; verts[vi++] = cy; verts[vi++] = 0;
  }
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU + angleOffset;
    const cx = Math.cos(t), cy = Math.sin(t);
    // bottom ring
    verts[vi++] = 0.5 + 0.5 * cx; verts[vi++] = 0.5 + 0.5 * cy; verts[vi++] = 0;
    verts[vi++] = cx; verts[vi++] = cy; verts[vi++] = 0;
  }
  for (let i = 0; i < N; i++) {
    const i1 = (i + 1) % N;
    idx[ii++] = sb + i;  idx[ii++] = st + i1; idx[ii++] = sb + i1;
    idx[ii++] = sb + i;  idx[ii++] = st + i;  idx[ii++] = st + i1;
  }
  return { verts: verts.subarray(0, vi), idx: idx.subarray(0, ii), idxCount: ii };
}
const CYL = buildPrism(CYL_N);
// Pointy-top hexagonal prism (a vertex at the top, matching hexPolygon()).
const HEX = buildPrism(6, -Math.PI / 2);

// Flat pointy-top hexagon — just the prism's top face as a 6-triangle fan at
// z=0 (18 indices vs the prism's 72). A height=0 hexagon collapses the prism to
// this exact silhouette anyway, but still pays for 24 assembled triangles (12
// discarded side walls + a culled bottom) per instance; drawing the top face
// alone renders identically while cutting the per-cell triangle count 4×, which
// matters when tens of thousands of flat hex cells fill the overview.
function buildFlatHexTop(): { verts: Float32Array; idx: Uint16Array; idxCount: number } {
  const N = 6;
  const angleOffset = -Math.PI / 2;
  const verts = new Float32Array((N + 1) * 6);
  const idx = new Uint16Array(N * 3);
  let vi = 0, ii = 0;
  // Centre vertex (normal +Z).
  verts[vi++] = 0.5; verts[vi++] = 0.5; verts[vi++] = 0;
  verts[vi++] = 0; verts[vi++] = 0; verts[vi++] = 1;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2 + angleOffset;
    verts[vi++] = 0.5 + 0.5 * Math.cos(t);
    verts[vi++] = 0.5 + 0.5 * Math.sin(t);
    verts[vi++] = 0;
    verts[vi++] = 0; verts[vi++] = 0; verts[vi++] = 1;
  }
  // Same winding as the prism's top face so it stays front-facing after the
  // MVP's Y-flip (front-face = CCW, back-face culled).
  for (let i = 0; i < N; i++) {
    idx[ii++] = 0; idx[ii++] = 1 + ((i + 1) % N); idx[ii++] = 1 + i;
  }
  return { verts, idx, idxCount: ii };
}
const FLAT_HEX = buildFlatHexTop();

// ---------------------------------------------------------------------------
// Flat quad: 4 vertices (same attrib layout as box — pos3 + normal3) for
// shapes with height=0.  Only 6 indices vs 36 (box) or 384 (cylinder).
// ---------------------------------------------------------------------------
// prettier-ignore
const FLAT_VERTS = new Float32Array([
  0,0,0, 0,0,1,  0,1,0, 0,0,1,  1,1,0, 0,0,1,  1,0,0, 0,0,1,
]);
// prettier-ignore
const FLAT_IDX = new Uint16Array([0,1,2, 0,2,3]);

/** Per-instance data layout: rect(4) + color(4) + shape(1) + arc(4) = 13 floats.
 *  Height is packed into arc.w (the 13th float). */
const COLORED_STRIDE = 13;
/** Per-instance: rect(4) + color(4) + uv(4) + elevation(1) = 13 floats. */
const TEXTURED_STRIDE = 13;
/** Per-vertex: pos(2) + color(4) = 6 floats. Used by the 2D vector pipeline. */
const VECTOR_STRIDE = 6;
/** Per-vertex: pos(3) + color(4) = 7 floats. Used by the 3D extruded-mesh pipeline. */
const MESH_STRIDE = 7;

interface PoolBuffer {
  cpu: Float32Array;
  gpu: WebGLBuffer;
  capacity: number;
}

/** Per-frame draw counters. Reset by the caller (Scene) at the start of
 * each frame; PerfMonitor reads them after `scene.draw()` completes. */
export interface RendererStats {
  drawCalls: number;
  coloredInstances: number;
  texturedInstances: number;
  texturedBatches: number;
  bytesUploaded: number;
}

export class QuadRenderer {
  /** Lightweight counters; mutated in-place to avoid per-frame allocations. */
  readonly stats: RendererStats = {
    drawCalls: 0,
    coloredInstances: 0,
    texturedInstances: 0,
    texturedBatches: 0,
    bytesUploaded: 0,
  };

  resetStats(): void {
    const s = this.stats;
    s.drawCalls = 0;
    s.coloredInstances = 0;
    s.texturedInstances = 0;
    s.texturedBatches = 0;
    s.bytesUploaded = 0;
  }

  private gl: WebGL2RenderingContext;

  private coloredProg: WebGLProgram;
  private coloredVAO: WebGLVertexArrayObject;
  private cylinderVAO: WebGLVertexArrayObject;
  private hexVAO: WebGLVertexArrayObject;
  private flatVAO: WebGLVertexArrayObject;
  private flatHexVAO: WebGLVertexArrayObject;
  private coloredInstance: PoolBuffer;
  private cylinderInstance: PoolBuffer;
  private hexInstance: PoolBuffer;
  private flatInstance: PoolBuffer;
  private flatHexInstance: PoolBuffer;
  private uColoredMVP: WebGLUniformLocation;
  private uColoredOpacity: WebGLUniformLocation;

  private texturedProg: WebGLProgram;
  private texturedVAO: WebGLVertexArrayObject;
  private texturedInstance: PoolBuffer;
  private uTexturedMVP: WebGLUniformLocation;
  private uTexturedOpacity: WebGLUniformLocation;
  private uTexturedSampler: WebGLUniformLocation;

  private vectorProg: WebGLProgram;
  private vectorVAO: WebGLVertexArrayObject;
  private vectorBuffer: PoolBuffer;
  private uVectorMVP: WebGLUniformLocation;
  private uVectorOpacity: WebGLUniformLocation;

  private meshProg: WebGLProgram;
  private meshVAO: WebGLVertexArrayObject;
  private meshBuffer: PoolBuffer;
  private uMeshMVP: WebGLUniformLocation;
  private uMeshOpacity: WebGLUniformLocation;

  private quadBuffer: WebGLBuffer;
  private boxBuffer: WebGLBuffer;
  private boxIndexBuffer: WebGLBuffer;
  private cylBuffer: WebGLBuffer;
  private cylIndexBuffer: WebGLBuffer;
  private hexBuffer: WebGLBuffer;
  private hexIndexBuffer: WebGLBuffer;
  private flatBuffer: WebGLBuffer;
  private flatIndexBuffer: WebGLBuffer;
  private flatHexBuffer: WebGLBuffer;
  private flatHexIndexBuffer: WebGLBuffer;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    // Unit quad (for textured pipeline): two triangles via TRIANGLE_STRIP.
    this.quadBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    // Unit box (for 3D colored pipeline): 24 vertices + 36 indices.
    this.boxBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, BOX_VERTS, gl.STATIC_DRAW);
    this.boxIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.boxIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, BOX_IDX, gl.STATIC_DRAW);

    // Cylinder geometry for circle/ellipse/arc shapes.
    this.cylBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cylBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CYL.verts, gl.STATIC_DRAW);
    this.cylIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cylIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CYL.idx, gl.STATIC_DRAW);

    // Hexagonal prism geometry for 3D 'hexagon' shapes.
    this.hexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, HEX.verts, gl.STATIC_DRAW);
    this.hexIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.hexIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, HEX.idx, gl.STATIC_DRAW);

    // Flat quad geometry for shapes with height=0 (fast path).
    this.flatBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FLAT_VERTS, gl.STATIC_DRAW);
    this.flatIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FLAT_IDX, gl.STATIC_DRAW);

    // Flat hexagon geometry (top-face fan) for height=0 'hexagon' shapes.
    this.flatHexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatHexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FLAT_HEX.verts, gl.STATIC_DRAW);
    this.flatHexIndexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatHexIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FLAT_HEX.idx, gl.STATIC_DRAW);

    // --- Colored 3D program ---
    this.coloredProg = compileProgram(gl, VS, FS);
    this.uColoredMVP = gl.getUniformLocation(this.coloredProg, 'uMVP')!;
    this.uColoredOpacity = gl.getUniformLocation(this.coloredProg, 'uOpacity')!;
    this.coloredInstance = makePool(gl, 1024 * COLORED_STRIDE);
    this.coloredVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.coloredVAO);
    // Per-vertex: position + normal from box buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);   // aPos
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);  // aNormal
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.boxIndexBuffer);
    // Per-instance attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coloredInstance.gpu);
    const stride = COLORED_STRIDE * 4;
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);   // aRect
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);  // aColor
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);  // aShape
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 36);  // aArc (+height)
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // --- Cylinder VAO (same program + instance layout, different geometry) ---
    this.cylinderInstance = makePool(gl, 512 * COLORED_STRIDE);
    this.cylinderVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.cylinderVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cylBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cylIndexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cylinderInstance.gpu);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // --- Hex-prism VAO (same program + instance layout, hexagonal geometry) ---
    this.hexInstance = makePool(gl, 512 * COLORED_STRIDE);
    this.hexVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.hexVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.hexIndexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hexInstance.gpu);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // --- Flat quad VAO (same program, fast path for height=0 shapes) ---
    this.flatInstance = makePool(gl, 1024 * COLORED_STRIDE);
    this.flatVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.flatVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatIndexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatInstance.gpu);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // --- Flat hexagon VAO (same program + instance layout, top-face fan) ---
    this.flatHexInstance = makePool(gl, 1024 * COLORED_STRIDE);
    this.flatHexVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.flatHexVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatHexBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.flatHexIndexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatHexInstance.gpu);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // --- Textured program (flat quads at z=0) ---
    this.texturedProg = compileProgram(gl, TEXTURED_VS, TEXTURED_FS);
    this.uTexturedMVP = gl.getUniformLocation(this.texturedProg, 'uMVP')!;
    this.uTexturedOpacity = gl.getUniformLocation(this.texturedProg, 'uOpacity')!;
    this.uTexturedSampler = gl.getUniformLocation(this.texturedProg, 'uTex')!;
    this.texturedInstance = makePool(gl, 256 * TEXTURED_STRIDE);
    this.texturedVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.texturedVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texturedInstance.gpu);
    const tstride = TEXTURED_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, tstride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, tstride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, tstride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, tstride, 48);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);

    // --- Vector program (flat 2D triangles with per-vertex color) ---
    // Non-instanced: one big vertex buffer per frame, one draw call.
    // Used for arbitrary polygons from `'vector'` tile elements.
    this.vectorProg = compileProgram(gl, VECTOR_VS, VECTOR_FS);
    this.uVectorMVP = gl.getUniformLocation(this.vectorProg, 'uMVP')!;
    this.uVectorOpacity = gl.getUniformLocation(this.vectorProg, 'uOpacity')!;
    this.vectorBuffer = makePool(gl, 1024 * VECTOR_STRIDE);
    this.vectorVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.vectorVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer.gpu);
    const vstride = VECTOR_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, vstride, 0);
    // No divisor — per-vertex, not per-instance.
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, vstride, 8);
    gl.bindVertexArray(null);

    // --- Mesh program (3D triangles: extruded polygons, baked flat shade) ---
    this.meshProg = compileProgram(gl, MESH_VS, MESH_FS);
    this.uMeshMVP = gl.getUniformLocation(this.meshProg, 'uMVP')!;
    this.uMeshOpacity = gl.getUniformLocation(this.meshProg, 'uOpacity')!;
    this.meshBuffer = makePool(gl, 1024 * MESH_STRIDE);
    this.meshVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer.gpu);
    const mstride = MESH_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, mstride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, mstride, 12);
    gl.bindVertexArray(null);
  }

  /**
   * Bind the colored program and set MVP + opacity uniforms.
   * Call once before a sequence of drawFlat/drawBoxes/drawCylinders.
   */
  bindColored(mvp: Float32Array, opacity: number): void {
    const gl = this.gl;
    gl.useProgram(this.coloredProg);
    gl.uniformMatrix4fv(this.uColoredMVP, false, mvp);
    gl.uniform1f(this.uColoredOpacity, opacity);
  }

  /**
   * Draw rect shapes as 3D boxes. Call bindColored() first.
   */
  drawBoxes(instances: Float32Array, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.coloredInstance, count * COLORED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coloredInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * COLORED_STRIDE);
    gl.bindVertexArray(this.coloredVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.coloredInstances += count;
    this.stats.bytesUploaded += count * COLORED_STRIDE * 4;
  }

  /**
   * Draw circle/ellipse/arc shapes as 3D cylinders. Call bindColored() first.
   */
  drawCylinders(instances: Float32Array, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.cylinderInstance, count * COLORED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cylinderInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * COLORED_STRIDE);
    gl.bindVertexArray(this.cylinderVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, CYL.idxCount, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.coloredInstances += count;
    this.stats.bytesUploaded += count * COLORED_STRIDE * 4;
  }

  /**
   * Draw 3D hexagonal-prism shapes (extruded pointy-top hexagons). Call
   * bindColored() first to bind the shared colored program + MVP.
   */
  drawHexPrisms(instances: Float32Array, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.hexInstance, count * COLORED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hexInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * COLORED_STRIDE);
    gl.bindVertexArray(this.hexVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, HEX.idxCount, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.coloredInstances += count;
    this.stats.bytesUploaded += count * COLORED_STRIDE * 4;
  }

  /**
   * Draw any shape as a flat quad (fast path for height=0). Call bindColored() first.
   */
  drawFlat(instances: Float32Array, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.flatInstance, count * COLORED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * COLORED_STRIDE);
    gl.bindVertexArray(this.flatVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.coloredInstances += count;
    this.stats.bytesUploaded += count * COLORED_STRIDE * 4;
  }

  /**
   * Draw flat (height=0) hexagon shapes as a top-face fan (18 indices/instance
   * vs the 72 of a full hex prism). Visually identical to a collapsed prism but
   * ~4× cheaper per cell — the fast path for the estate's flat honeycomb. Call
   * bindColored() first.
   */
  drawFlatHex(instances: Float32Array, count: number): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.flatHexInstance, count * COLORED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatHexInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * COLORED_STRIDE);
    gl.bindVertexArray(this.flatHexVAO);
    gl.drawElementsInstanced(gl.TRIANGLES, FLAT_HEX.idxCount, gl.UNSIGNED_SHORT, 0, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.coloredInstances += count;
    this.stats.bytesUploaded += count * COLORED_STRIDE * 4;
  }

  drawTextured(
    instances: Float32Array,
    count: number,
    mvp: Float32Array,
    opacity: number,
    texture: WebGLTexture
  ): void {
    if (count === 0) return;
    const gl = this.gl;
    this.ensurePool(this.texturedInstance, count * TEXTURED_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texturedInstance.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * TEXTURED_STRIDE);
    gl.useProgram(this.texturedProg);
    gl.uniformMatrix4fv(this.uTexturedMVP, false, mvp);
    gl.uniform1f(this.uTexturedOpacity, opacity);
    gl.uniform1i(this.uTexturedSampler, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(this.texturedVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.texturedInstances += count;
    this.stats.texturedBatches++;
    this.stats.bytesUploaded += count * TEXTURED_STRIDE * 4;
  }

  /**
   * Draw pre-tessellated 2D triangles (per-vertex RGBA). One non-instanced
   * draw call. `vertexCount` is the number of vertices (not floats); the
   * buffer holds `vertexCount × VECTOR_STRIDE` floats laid out as
   * `[x, y, r, g, b, a]` per vertex. Triangles are formed by consecutive
   * groups of 3 vertices (no index buffer).
   */
  drawVectors(vertices: Float32Array, vertexCount: number, mvp: Float32Array, opacity: number): void {
    if (vertexCount === 0) return;
    const gl = this.gl;
    const floats = vertexCount * VECTOR_STRIDE;
    this.ensurePool(this.vectorBuffer, floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, floats);
    gl.useProgram(this.vectorProg);
    gl.uniformMatrix4fv(this.uVectorMVP, false, mvp);
    gl.uniform1f(this.uVectorOpacity, opacity);
    gl.bindVertexArray(this.vectorVAO);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.bytesUploaded += floats * 4;
  }

  /**
   * Draw pre-tessellated 3D triangles (per-vertex position + straight RGBA),
   * `[x, y, z, r, g, b, a]` per vertex. Used for extruded polygons; the caller
   * (Scene) sets depth state so meshes occlude correctly among the 3D shapes.
   */
  drawMesh(vertices: Float32Array, vertexCount: number, mvp: Float32Array, opacity: number): void {
    if (vertexCount === 0) return;
    const gl = this.gl;
    const floats = vertexCount * MESH_STRIDE;
    this.ensurePool(this.meshBuffer, floats);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer.gpu);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices, 0, floats);
    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(this.uMeshMVP, false, mvp);
    gl.uniform1f(this.uMeshOpacity, opacity);
    gl.bindVertexArray(this.meshVAO);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
    this.stats.bytesUploaded += floats * 4;
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.coloredProg);
    gl.deleteProgram(this.texturedProg);
    gl.deleteProgram(this.vectorProg);
    gl.deleteProgram(this.meshProg);
    gl.deleteVertexArray(this.coloredVAO);
    gl.deleteVertexArray(this.cylinderVAO);
    gl.deleteVertexArray(this.hexVAO);
    gl.deleteVertexArray(this.flatVAO);
    gl.deleteVertexArray(this.flatHexVAO);
    gl.deleteVertexArray(this.texturedVAO);
    gl.deleteVertexArray(this.vectorVAO);
    gl.deleteVertexArray(this.meshVAO);
    gl.deleteBuffer(this.coloredInstance.gpu);
    gl.deleteBuffer(this.cylinderInstance.gpu);
    gl.deleteBuffer(this.hexInstance.gpu);
    gl.deleteBuffer(this.flatInstance.gpu);
    gl.deleteBuffer(this.flatHexInstance.gpu);
    gl.deleteBuffer(this.texturedInstance.gpu);
    gl.deleteBuffer(this.vectorBuffer.gpu);
    gl.deleteBuffer(this.meshBuffer.gpu);
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.boxBuffer);
    gl.deleteBuffer(this.boxIndexBuffer);
    gl.deleteBuffer(this.cylBuffer);
    gl.deleteBuffer(this.cylIndexBuffer);
    gl.deleteBuffer(this.hexBuffer);
    gl.deleteBuffer(this.hexIndexBuffer);
    gl.deleteBuffer(this.flatBuffer);
    gl.deleteBuffer(this.flatIndexBuffer);
    gl.deleteBuffer(this.flatHexBuffer);
    gl.deleteBuffer(this.flatHexIndexBuffer);
  }

  private ensurePool(pool: PoolBuffer, neededFloats: number): void {
    if (pool.capacity >= neededFloats) return;
    let cap = pool.capacity;
    while (cap < neededFloats) cap *= 2;
    pool.cpu = new Float32Array(cap);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, pool.gpu);
    gl.bufferData(gl.ARRAY_BUFFER, pool.cpu.byteLength, gl.DYNAMIC_DRAW);
    pool.capacity = cap;
  }
}

function makePool(gl: WebGL2RenderingContext, floats: number): PoolBuffer {
  const cpu = new Float32Array(floats);
  const gpu = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu);
  gl.bufferData(gl.ARRAY_BUFFER, cpu.byteLength, gl.DYNAMIC_DRAW);
  return { cpu, gpu, capacity: floats };
}

// ---------------------------------------------------------------------------
// 2D vector tessellation helpers
//
// These run on the CPU once per visible vector element per frame. Output is
// appended to a caller-owned Float32Array using the VECTOR_STRIDE layout
// `[x, y, r, g, b, a]` per vertex (triangles are flat groups of 3 vertices).
//
// `cx`, `cy` are subtracted from each absolute world coordinate so that
// vertices end up in camera-relative float32 space (matches the convention
// used by the colored / textured pipelines for deep-zoom precision).
// ---------------------------------------------------------------------------

/**
 * Triangulate a single ring (closed polygon) by ear clipping. Handles both
 * convex (O(n) effective) and concave (worst case O(n²)) polygons. Self-
 * intersecting rings are not supported — output is undefined for them, but
 * we never crash.
 *
 * `ring` is a flat `[x0,y0,x1,y1,...]` array in absolute world coords; the
 * last vertex is implicitly connected back to the first. Returns the new
 * write offset into `out` (in floats).
 */
/**
 * Ear-clip one polygon ring into triangle vertex POSITIONS (world coords),
 * appended to `out` at `offset` as [x,y] pairs; returns the new offset. This is
 * the position-only core of the fill tessellation — colour and the camera-
 * relative shift are applied later (per frame) when the cached result is drawn,
 * so this O(n²) clip runs once per element instead of every frame.
 */
function tessellateFillPos(ring: number[], out: Float32Array, offset: number): number {
  const n = ring.length >> 1;
  if (n < 3) return offset;

  // Build index list and detect winding (we want CCW for the cross-product
  // sign convention below; flip if CW so the same `isEar` check works).
  const indices: number[] = new Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  if (area2 < 0) indices.reverse();

  let remaining = n;
  let guard = remaining * remaining; // safety bound against pathological input
  let i = 0;
  while (remaining > 3 && guard-- > 0) {
    const i0 = indices[(i + 0) % remaining];
    const i1 = indices[(i + 1) % remaining];
    const i2 = indices[(i + 2) % remaining];
    const ax = ring[i0 * 2];
    const ay = ring[i0 * 2 + 1];
    const bx = ring[i1 * 2];
    const by = ring[i1 * 2 + 1];
    const cxp = ring[i2 * 2];
    const cyp = ring[i2 * 2 + 1];

    const cross = (bx - ax) * (cyp - ay) - (by - ay) * (cxp - ax);
    let isEar = cross > 0;
    if (isEar) {
      for (let k = 0; k < remaining; k++) {
        if (k === (i + 0) % remaining || k === (i + 1) % remaining || k === (i + 2) % remaining) continue;
        const idx = indices[k];
        if (pointInTri(ring[idx * 2], ring[idx * 2 + 1], ax, ay, bx, by, cxp, cyp)) {
          isEar = false;
          break;
        }
      }
    }

    if (isEar) {
      out[offset++] = ax; out[offset++] = ay;
      out[offset++] = bx; out[offset++] = by;
      out[offset++] = cxp; out[offset++] = cyp;
      indices.splice((i + 1) % remaining, 1);
      remaining--;
    } else {
      i++;
    }
  }

  if (remaining === 3) {
    const i0 = indices[0];
    const i1 = indices[1];
    const i2 = indices[2];
    out[offset++] = ring[i0 * 2]; out[offset++] = ring[i0 * 2 + 1];
    out[offset++] = ring[i1 * 2]; out[offset++] = ring[i1 * 2 + 1];
    out[offset++] = ring[i2 * 2]; out[offset++] = ring[i2 * 2 + 1];
  }
  return offset;
}

/**
 * Triangulate all of a vector element's fill rings ONCE into a packed triangle
 * soup of world-space positions ([x0,y0,x1,y1,...]), for caching on the element.
 * Each ring is triangulated independently (holes are filled), which is what we
 * want for a solid cluster silhouette. Drawing the cache later only subtracts the
 * camera centre and writes the colour — no per-frame ear-clipping.
 */
function buildFillTris(rings: number[][]): Float32Array {
  let total = 0;
  for (const ring of rings) total += fillVertexCount(ring.length >> 1);
  const out = new Float32Array(total * 2);
  let off = 0;
  for (const ring of rings) off = tessellateFillPos(ring, out, off);
  return out;
}


function pointInTri(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): boolean {
  const v0x = cx - ax, v0y = cy - ay;
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

/**
 * Tessellate a polyline stroke into quads of width `strokeWidth` (world
 * units). For each segment we emit two triangles. Joints between adjacent
 * segments use miter joins, clamped at miterLimit (defaults to 4× the
 * stroke half-width) to avoid runaway spikes at acute angles.
 *
 * If `closed` is true, the first and last vertices are joined.
 */
function tessellateStroke(
  ring: number[],
  strokeWidth: number,
  out: Float32Array,
  offset: number,
  cx: number,
  cy: number,
  r: number,
  g: number,
  b: number,
  a: number,
  closed: boolean
): number {
  const n = ring.length >> 1;
  if (n < 2 || strokeWidth <= 0) return offset;
  const hw = strokeWidth * 0.5;
  const miterLimit = hw * 4;
  const stride = VECTOR_STRIDE;

  // Precompute per-vertex left-side offset vectors (perpendicular to
  // the bisector of incoming and outgoing edges).
  //   offX[i], offY[i] = unit perpendicular × scaled-by-miter-length.
  // For open paths the endpoints just use the edge perpendicular.
  const offX = new Float64Array(n);
  const offY = new Float64Array(n);

  const segCount = closed ? n : n - 1;
  // Per-segment unit tangent and normal.
  const tx = new Float64Array(segCount);
  const ty = new Float64Array(segCount);
  for (let s = 0; s < segCount; s++) {
    const i0 = s;
    const i1 = (s + 1) % n;
    const dx = ring[i1 * 2] - ring[i0 * 2];
    const dy = ring[i1 * 2 + 1] - ring[i0 * 2 + 1];
    const len = Math.hypot(dx, dy) || 1;
    tx[s] = dx / len;
    ty[s] = dy / len;
  }

  // Vertex offsets.
  for (let i = 0; i < n; i++) {
    let prevSeg = -1;
    let nextSeg = -1;
    if (closed) {
      prevSeg = (i + n - 1) % n;
      nextSeg = i;
    } else {
      if (i > 0) prevSeg = i - 1;
      if (i < n - 1) nextSeg = i;
    }
    let nxA = 0, nyA = 0, nxB = 0, nyB = 0, count = 0;
    if (prevSeg >= 0) {
      // Left normal of segment (prevSeg) = (-ty, tx).
      nxA = -ty[prevSeg];
      nyA = tx[prevSeg];
      count++;
    }
    if (nextSeg >= 0) {
      nxB = -ty[nextSeg];
      nyB = tx[nextSeg];
      count++;
    }
    if (count === 1) {
      // Endpoint — use the single edge normal.
      offX[i] = (nxA + nxB) * hw;
      offY[i] = (nyA + nyB) * hw;
    } else {
      // Interior — miter join via averaged-normal trick.
      const mx = nxA + nxB;
      const my = nyA + nyB;
      const len2 = mx * mx + my * my;
      if (len2 < 1e-12) {
        // 180° flip — fall back to one of the normals.
        offX[i] = nxA * hw;
        offY[i] = nyA * hw;
      } else {
        // Miter length = hw / cos(theta/2), where cos = dot(nA, m̂).
        const invLen = 1 / Math.sqrt(len2);
        const mxN = mx * invLen;
        const myN = my * invLen;
        const cosHalf = nxA * mxN + nyA * myN;
        let miterLen = hw / Math.max(0.1, Math.abs(cosHalf));
        if (miterLen > miterLimit) miterLen = miterLimit;
        offX[i] = mxN * miterLen;
        offY[i] = myN * miterLen;
      }
    }
  }

  // Emit two triangles per segment using vertex offsets at each end.
  for (let s = 0; s < segCount; s++) {
    const i0 = s;
    const i1 = (s + 1) % n;
    const x0 = ring[i0 * 2];
    const y0 = ring[i0 * 2 + 1];
    const x1 = ring[i1 * 2];
    const y1 = ring[i1 * 2 + 1];
    const l0x = x0 + offX[i0] - cx;
    const l0y = y0 + offY[i0] - cy;
    const r0x = x0 - offX[i0] - cx;
    const r0y = y0 - offY[i0] - cy;
    const l1x = x1 + offX[i1] - cx;
    const l1y = y1 + offY[i1] - cy;
    const r1x = x1 - offX[i1] - cx;
    const r1y = y1 - offY[i1] - cy;
    // Triangle 1: l0, r0, r1
    out[offset + 0] = l0x; out[offset + 1] = l0y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
    out[offset + 0] = r0x; out[offset + 1] = r0y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
    out[offset + 0] = r1x; out[offset + 1] = r1y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
    // Triangle 2: l0, r1, l1
    out[offset + 0] = l0x; out[offset + 1] = l0y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
    out[offset + 0] = r1x; out[offset + 1] = r1y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
    out[offset + 0] = l1x; out[offset + 1] = l1y;
    out[offset + 2] = r; out[offset + 3] = g; out[offset + 4] = b; out[offset + 5] = a;
    offset += stride;
  }
  return offset;
}

/** Worst-case vertex count for a fill of `n` ring vertices: `(n − 2) × 3`. */
function fillVertexCount(n: number): number {
  return n < 3 ? 0 : (n - 2) * 3;
}

/** Vertex count for a stroke of `n` ring vertices: 6 per segment. */
function strokeVertexCount(n: number, closed: boolean): number {
  if (n < 2) return 0;
  return (closed ? n : n - 1) * 6;
}

export { COLORED_STRIDE, TEXTURED_STRIDE, VECTOR_STRIDE, MESH_STRIDE };
export { buildFillTris, tessellateStroke, fillVertexCount, strokeVertexCount };
