/** Get a WebGL2 context with options appropriate for vector rendering. */
export function getGL(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error(
    'WebGL2 is not supported by this browser or device. '
    + 'Try Chrome, Edge, or Firefox on a device with GPU support.',
  );
  return gl;
}

export function compileProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  if (!prog) throw new Error(
    'gl.createProgram() returned null — the WebGL context may be lost. '
    + 'Check for context-lost events or GPU driver issues.',
  );
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Program link error: ' + log);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(
    `gl.createShader(${type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT'}) returned null — `
    + 'the WebGL context may be lost.',
  );
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + log);
  }
  return sh;
}
