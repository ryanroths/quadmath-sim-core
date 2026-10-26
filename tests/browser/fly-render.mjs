// The fly harness's view, WebGL2 with no library: a grey ground with a faint
// metre grid, a sky above the horizon with the horizon drawn as a line, the
// scenery as solid boxes (fly.mjs: eight 1 m cubes and a gate), and the quad
// as a box the size of its footprint. Two cameras: FPV, at the
// CG with the camera tilted up camDeg about the body's pitch axis (as
// quadmath's sim mounts it, sim.html:3436-3437), and a fixed line-of-sight
// view from beside the start, the only one the quad's box shows in.
//
// The ground and sky are one full-screen pass that casts each pixel's ray at
// the plane z = 0 from the camera: the horizon is exact, and the grid under a
// camera 10 mm off the floor keeps its precision, which a 4 km ground quad's
// interpolated coordinates would not.
//
// Frames are sim-core's: X forward, Y left, Z up, quaternions w x y z body to
// world. Render only; nothing here reaches the sim.
//
// This file is part of quadmath-sim-core, GPL-3.0-or-later. See LICENSE.

const SKY = [0.70, 0.78, 0.86];
const HORIZON = [0.12, 0.14, 0.17];
const QUAD = [0.85, 0.32, 0.12];
const NEAR = 0.005;   // m
const FAR = 5000;
const LOS_EYE = [-3, -1.5, 1.4];   // m, the line-of-sight pilot's eyes

// ---- 4x4 matrices, column-major (WebGL's layout) ----

function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function perspective(vfovDeg, aspect, near, far) {
  const f = 1 / Math.tan((vfovDeg * Math.PI) / 360);
  const o = new Float32Array(16);
  o[0] = f / aspect;
  o[5] = f;
  o[10] = (far + near) / (near - far);
  o[11] = -1;
  o[14] = (2 * far * near) / (near - far);
  return o;
}

// Body to world rotation, rows of a 3x3, from w x y z.
export function quatToMat3([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

const col = (m, j) => [m[0][j], m[1][j], m[2][j]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const n = Math.hypot(...a);
  return a.map((v) => v / n);
};

// A camera: its position and its forward, left and up axes in the world.

// The FPV camera: the body's axes turned up camDeg about body Y (left), so
// forward rises: forward' = forward cos + up sin, up' = up cos - forward sin.
export function fpvCamera(pos, quat, camDeg) {
  const m = quatToMat3(quat);
  const f = col(m, 0);
  const u = col(m, 2);
  const a = (camDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { eye: pos, fwd: f.map((v, k) => v * c + u[k] * s), left: col(m, 1), up: u.map((v, k) => v * c - f[k] * s) };
}

export function lookAtCamera(eye, target) {
  const fwd = norm(target.map((v, k) => v - eye[k]));
  const left = norm(cross([0, 0, 1], fwd));
  return { eye, fwd, left, up: cross(fwd, left) };
}

// World to eye: GL's eye looks down -z with +x right and +y up.
export function viewMatrix({ eye, fwd, left, up }) {
  const o = new Float32Array(16);
  [left.map((v) => -v), up, fwd.map((v) => -v)].forEach((axis, r) => {
    o[r] = axis[0];
    o[4 + r] = axis[1];
    o[8 + r] = axis[2];
    o[12 + r] = -dot(axis, eye);
  });
  o[15] = 1;
  return o;
}

// The box's model matrix: scale to the box, rotate by the quad's attitude,
// move to its CG.
function boxModel(pos, quat, box) {
  const m = quatToMat3(quat);
  const size = [box.halfX * 2, box.halfY * 2, box.top - box.bottom];
  const centre = [0, 0, (box.top + box.bottom) / 2];
  const o = new Float32Array(16);
  for (let j = 0; j < 3; j++) for (let r = 0; r < 3; r++) o[j * 4 + r] = m[r][j] * size[j];
  for (let r = 0; r < 3; r++) o[12 + r] = pos[r] + dot(m[r], centre);
  o[15] = 1;
  return o;
}

// A world box's model matrix: the unit cube scaled and moved to min..max.
function aabbModel(min, max) {
  const o = new Float32Array(16);
  for (let k = 0; k < 3; k++) {
    o[k * 5] = max[k] - min[k];
    o[12 + k] = (min[k] + max[k]) / 2;
  }
  o[15] = 1;
  return o;
}

// ---- GL ----

// One triangle over the whole screen; each pixel's ray in the world is
// right x ndc.x x tan(half hfov) + up x ndc.y x tan(half vfov) + forward.
const GROUND_VS = `#version 300 es
in vec2 aCorner;
out vec2 vNdc;
void main() {
  vNdc = aCorner;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

// Sky above the horizon; below it the ground: grey, grid lines every 1 m and
// darker every 10 m, faded out where they would alias, hazed toward the
// horizon. The horizon itself (rays level with the ground) is a dark line
// about two pixels wide. Positions are relative to the camera; uCell1 and uCell10 carry the
// camera's place inside its 1 m and 10 m cells, computed in doubles.
const GROUND_FS = `#version 300 es
precision highp float;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uTan;
uniform float uHeight;
uniform vec2 uCell1;
uniform vec2 uCell10;
uniform vec3 uSky;
uniform vec3 uHorizon;
in vec2 vNdc;
out vec4 outColor;
float line(vec2 q) {
  vec2 w = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(w, vec2(1e-6));
  float l = 1.0 - min(min(g.x, g.y), 1.0);
  return l * (1.0 - smoothstep(0.15, 0.5, max(w.x, w.y)));
}
void main() {
  vec3 dir = normalize(uRight * (vNdc.x * uTan.x) + uUp * (vNdc.y * uTan.y) + uFwd);
  float down = min(dir.z, -1e-6);
  vec2 rel = dir.xy * (uHeight / -down);
  vec3 c = vec3(0.50);
  c = mix(c, vec3(0.42), line(uCell1 + rel));
  c = mix(c, vec3(0.34), line(uCell10 + rel / 10.0));
  c = mix(c, uSky, smoothstep(60.0, 1800.0, length(vec3(rel, uHeight))) * 0.85);
  vec3 col = dir.z < 0.0 && uHeight > 0.0 ? c : uSky;
  float px = abs(dir.z) / max(fwidth(dir.z), 1e-7);
  outColor = vec4(mix(uHorizon, col, smoothstep(0.5, 1.5, px)), 1.0);
}`;

const BOX_VS = `#version 300 es
uniform mat4 uViewProj;
uniform mat4 uModel;
in vec3 aPos;
in vec3 aNormal;
out vec3 vNormal;
void main() {
  vNormal = normalize(mat3(uModel) * aNormal);
  gl_Position = uViewProj * uModel * vec4(aPos, 1.0);
}`;

const BOX_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
in vec3 vNormal;
out vec4 outColor;
void main() {
  float light = 0.45 + 0.55 * max(dot(normalize(vNormal), normalize(vec3(-0.4, 0.3, 0.85))), 0.0);
  outColor = vec4(uColor * light, 1.0);
}`;

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

// A unit cube centred on the origin, a normal per face, wound outward.
function cube() {
  const out = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, a, b] of faces) {
    const corner = (sa, sb) => n.map((v, k) => 0.5 * v + 0.5 * sa * a[k] + 0.5 * sb * b[k]);
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) out.push(...corner(sa, sb), ...n);
  }
  return new Float32Array(out);
}

// box: the quad's { halfX, halfY, bottom, top } in metres about the CG.
// scenery: world boxes { min, max, color }, metres, drawn in both views.
export function createRenderer(canvas, { box, scenery = [] }) {
  const gl = canvas.getContext('webgl2', { antialias: true });
  if (!gl) throw new Error('WebGL2 is not available in this browser');
  const ground = program(gl, GROUND_VS, GROUND_FS);
  const solid = program(gl, BOX_VS, BOX_FS);

  const groundVao = gl.createVertexArray();
  gl.bindVertexArray(groundVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aCorner = gl.getAttribLocation(ground, 'aCorner');
  gl.enableVertexAttribArray(aCorner);
  gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

  const boxVao = gl.createVertexArray();
  gl.bindVertexArray(boxVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, cube(), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(solid, 'aPos');
  const aNormal = gl.getAttribLocation(solid, 'aNormal');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);

  const u = (p, name) => gl.getUniformLocation(p, name);
  // The camera's place in a cell of the grid, 0..1, from a double.
  const cell = (v, size) => (((v % size) + size) % size) / size;

  return {
    // state: lerpState() of the sim; view: { fpv: true, camDeg, vfovDeg }
    // or { fpv: false, vfovDeg } for line of sight.
    draw(state, view) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clear(gl.DEPTH_BUFFER_BIT);

      const cam = view.fpv ? fpvCamera(state.pos, state.quat, view.camDeg) : lookAtCamera(LOS_EYE, state.pos);
      const tanV = Math.tan((view.vfovDeg * Math.PI) / 360);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(ground);
      gl.uniform3f(u(ground, 'uRight'), ...cam.left.map((v) => -v));
      gl.uniform3f(u(ground, 'uUp'), ...cam.up);
      gl.uniform3f(u(ground, 'uFwd'), ...cam.fwd);
      gl.uniform2f(u(ground, 'uTan'), tanV * (w / h), tanV);
      gl.uniform1f(u(ground, 'uHeight'), cam.eye[2]);
      gl.uniform2f(u(ground, 'uCell1'), cell(cam.eye[0], 1), cell(cam.eye[1], 1));
      gl.uniform2f(u(ground, 'uCell10'), cell(cam.eye[0], 10), cell(cam.eye[1], 10));
      gl.uniform3f(u(ground, 'uSky'), ...SKY);
      gl.uniform3f(u(ground, 'uHorizon'), ...HORIZON);
      gl.bindVertexArray(groundVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const viewProj = multiply(perspective(view.vfovDeg, w / h, NEAR, FAR), viewMatrix(cam));
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.useProgram(solid);
      gl.uniformMatrix4fv(u(solid, 'uViewProj'), false, viewProj);
      gl.bindVertexArray(boxVao);
      const solidBox = (model, color) => {
        gl.uniformMatrix4fv(u(solid, 'uModel'), false, model);
        gl.uniform3f(u(solid, 'uColor'), ...color);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      };
      for (const b of scenery) solidBox(aabbModel(b.min, b.max), b.color);
      if (!view.fpv) solidBox(boxModel(state.pos, state.quat, box), QUAD);
      gl.bindVertexArray(null);
    },
  };
}
