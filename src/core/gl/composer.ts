import { compileProgram } from './context';

/* eslint-disable @typescript-eslint/no-non-null-assertion */

// Fullscreen quad in clip space. aCorner is in [0..1]^2 and used directly as UV.
const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Lerp two premultiplied-alpha source textures. mix() of premultiplied colors
// IS a valid cross-dissolve -- shared pixels (identical in both layers) come
// out exactly as themselves at any frac, eliminating the alpha pumping that
// premultiplied "over" with (1-f, f) opacities would otherwise cause.
const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform float uFrac;
out vec4 outColor;
void main() {
  vec4 a = texture(uTex0, vUV);
  vec4 b = texture(uTex1, vUV);
  outColor = mix(a, b, uFrac);
}
`;

/**
 * Two offscreen color FBOs the Scene can render each tile layer into at full
 * opacity, then composite onto the default framebuffer with a true lerp.
 */
export class LayerComposer {
  private gl: WebGL2RenderingContext;
  private fbos: WebGLFramebuffer[] = [];
  private textures: WebGLTexture[] = [];
  private depthRbs: WebGLRenderbuffer[] = [];
  private pxW = 0;
  private pxH = 0;
  private prog: WebGLProgram;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private uFrac: WebGLUniformLocation;
  private uTex0: WebGLUniformLocation;
  private uTex1: WebGLUniformLocation;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = compileProgram(gl, VS, FS);
    this.uFrac = gl.getUniformLocation(this.prog, 'uFrac')!;
    this.uTex0 = gl.getUniformLocation(this.prog, 'uTex0')!;
    this.uTex1 = gl.getUniformLocation(this.prog, 'uTex1')!;

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(tex);

      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const depthRb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      this.depthRbs.push(depthRb);

      this.fbos.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Resize the offscreen attachments to match the canvas backing store. */
  resize(pxW: number, pxH: number): void {
    if (this.pxW === pxW && this.pxH === pxH) return;
    this.pxW = pxW;
    this.pxH = pxH;
    const gl = this.gl;
    for (const tex of this.textures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pxW, pxH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    for (const rb of this.depthRbs) {
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, pxW, pxH);
    }
  }

  /**
   * Bind layer `i`'s FBO for rendering and clear it to fully transparent so
   * the subsequent draw call accumulates as premultiplied alpha on an empty
   * canvas (independent of any background color).
   */
  bindLayer(i: 0 | 1): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[i]);
    gl.viewport(0, 0, this.pxW, this.pxH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Bind the default framebuffer and composite the two layers onto it as
   * `mix(layer0, layer1, frac)`. The result is premultiplied, so the active
   * "src=ONE, dst=ONE_MINUS_SRC_ALPHA" blending lays it cleanly over the
   * already-cleared background.
   */
  composite(frac: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pxW, this.pxH);
    // Disable 3D state for the fullscreen composite pass.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.uniform1i(this.uTex0, 0);
    gl.uniform1i(this.uTex1, 1);
    gl.uniform1f(this.uFrac, frac);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    // Re-enable 3D state.
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    // Leave TEXTURE0 as the active unit so later code that assumes the
    // default unit (e.g. QuadRenderer.drawTextured) is unaffected.
    gl.activeTexture(gl.TEXTURE0);
  }

  destroy(): void {
    const gl = this.gl;
    for (const fbo of this.fbos) gl.deleteFramebuffer(fbo);
    for (const tex of this.textures) gl.deleteTexture(tex);
    for (const rb of this.depthRbs) gl.deleteRenderbuffer(rb);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
  }
}
