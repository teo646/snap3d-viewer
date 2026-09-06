// WebGL2 resources for one bundle: the program from shaders.js, the two atlas
// textures, and the mesh VAO. Everything here is built once at load and only the MVP
// and camera position change per frame - the same shape as ParallaxRasterContext.

import { PIPELINE_GLSL_SHA256, VERTEX_SHADER, fragmentShader } from './shaders.js';

const ATTRIBUTES = [
  ['in_pos', 'position', 3],
  ['in_uv', 'uv', 2],
  ['in_normal', 'normal', 3],
  ['in_tangent', 'tangent', 3],
  ['in_bitangent', 'bitangent', 3],
];

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    // Number the lines: the fragment source is assembled from four pieces, so a bare
    // "ERROR: 0:73" is otherwise unmappable to anything you can read.
    const numbered = source.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
    throw new Error(`${kind} shader failed to compile:\n${log}\n\n${numbered}`);
  }
  return shader;
}

function buildProgram(gl, config) {
  const fragment = fragmentShader({
    degree: config.sh.degree,
    kCoeffs: config.sh.coefficients,
    numSteps: config.height.num_steps,
  });
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program failed to link:\n${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function texParams(gl, target) {
  // float16 is filterable in core WebGL2 - no OES_texture_float_linear needed, which
  // is one of the things that made RGBA16F the format the bundle ships.
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // repeat_x = repeat_y = False, as every atlas texture is bound in the desktop
  // viewer: a march that overshoots a chart must clamp, never wrap to the far edge.
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_2D_ARRAY) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
}

export function createRenderer(gl, bundle) {
  const { config, geometry, textures } = bundle;
  const [w, h] = config.texture_resolution;
  const kCoeffs = config.sh.coefficients;
  const warnings = [];

  // Dormant unless the pipeline records the hash of the GLSL it compiled; see shaders.js.
  if (config.glsl_sha256 && config.glsl_sha256 !== PIPELINE_GLSL_SHA256) {
    warnings.push(
      'This bundle was built by a pipeline whose GLSL differs from the port in ' +
        'shaders.js - colours may be subtly wrong. Re-port pipeline/core/slf_shaders.py.',
    );
  }

  const program = buildProgram(gl, config);
  gl.useProgram(program);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const uniform = (name) => gl.getUniformLocation(program, name);

  // Unit 0: the relief texture. r is the displacement the parallax march walks
  // against, g is the atlas coverage the fragment discards outside of - one RG16F
  // fetch where the previous format needed two.
  const heightTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, heightTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16F, w, h);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RG, gl.HALF_FLOAT, textures.height.data);
  texParams(gl, gl.TEXTURE_2D);

  // Unit 2: one array layer per SH coefficient, RGBA16F straight out of the KTX2 -
  // alpha is padding, because WebGL has no 3-channel float format. eval_sh reads .rgb.
  const coeffTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, coeffTex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, w, h, kCoeffs);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, h, kCoeffs, gl.RGBA, gl.HALF_FLOAT, textures.sh.data);
  texParams(gl, gl.TEXTURE_2D_ARRAY);

  gl.uniform1i(uniform('u_height_tex'), 0);
  gl.uniform1i(uniform('u_coeffs'), 2);
  gl.uniform2f(uniform('u_tex_size'), w, h);
  gl.uniform1f(uniform('u_height_range'), config.height.range);
  gl.uniform1f(uniform('u_layer_step'), (2 * config.height.range) / config.height.num_steps);

  const buffers = [];
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [attribute, key, components] of ATTRIBUTES) {
    const location = gl.getAttribLocation(program, attribute);
    if (location < 0) continue; // linker dropped it as unused
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry[key], gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
  }
  const indexBuffer = gl.createBuffer();
  buffers.push(indexBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);

  const indexCount = geometry.indices.length;
  const mvpLocation = uniform('u_mvp');
  const camPosLocation = uniform('u_cam_pos');

  return {
    warnings,
    draw(mvp, camPos) {
      gl.useProgram(program);
      // Rebound every frame rather than once at build: this renderer may share its
      // context with a host application that binds its own textures to these units.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, coeffTex);

      gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(mvpLocation, false, mvp);
      gl.uniform3f(camPosLocation, camPos[0], camPos[1], camPos[2]);
      // 65k verts overflows 16-bit indices; UNSIGNED_INT is core in WebGL2.
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },
    /** Release every GL object. An embedded viewer that is torn down and rebuilt on
     *  each route change would otherwise leak ~38 MB of atlas per instance. */
    dispose() {
      gl.deleteVertexArray(vao);
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      for (const texture of [heightTex, coeffTex]) gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
}
