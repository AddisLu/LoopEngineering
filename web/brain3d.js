import * as THREE from './lib/three/three.module.min.js';
import { ensure3D, stepForceClustered3D, decayAlpha, shouldStep, reheat } from './graph-layout.js';

/**
 * 知識星圖 3D: the same graph as the 2D canvas, drawn with WebGL so it can be orbited.
 *
 * Why WebGL and not more canvas: in 3D every vertex needs a depth-sorted sprite and every edge
 * a line in perspective — on a 2D canvas that is one draw call per element. Here the whole
 * galaxy is two draw calls (one Points, one LineSegments) with per-vertex colour, which is why
 * a five-year-old laptop renders tens of thousands of nodes; our 550 are nothing.
 *
 * Deliberately NOT a force-graph library: the physics (graph-layout.js), the category anchors,
 * the label LoD and the focus/lineage behaviour already exist and are unit-tested. This file is
 * only a renderer plus an orbit camera; it owns no graph semantics of its own.
 *
 * The page keeps ownership of everything else — filters, the drawer, the tooltip — and hands
 * this module a live state plus callbacks (see createGalaxy3D's opts).
 */

const VERTEX_SHADER = `
  attribute float size;
  attribute vec3 tint;
  attribute float dim;
  varying vec3 vTint;
  varying float vDim;
  void main() {
    vTint = tint;
    vDim = dim;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // perspective size attenuation, clamped so a far leaf never vanishes and a near hub
    // never fills the screen
    gl_PointSize = clamp(size * (900.0 / -mv.z), 2.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;

// A soft radial falloff drawn procedurally: core -> halo -> nothing. Additive blending makes
// overlapping halos accumulate toward white, which is what gives a dense cluster its glow.
const FRAGMENT_SHADER = `
  varying vec3 vTint;
  varying float vDim;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = smoothstep(0.45, 0.0, r);
    float halo = smoothstep(1.0, 0.15, r) * 0.42;
    vec3 c = mix(vTint, vec3(1.0), core * 0.75);
    gl_FragColor = vec4(c, (core + halo) * vDim);
  }
`;

const DIM_FACTOR = 0.12; // how far a vertex outside the lit lineage fades

export function createGalaxy3D(opts) {
  const { canvas, labelLayer } = opts;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(new THREE.Color(opts.background ?? '#070a0f'), 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(opts.background ?? '#070a0f'), 0.00035);
  const camera = new THREE.PerspectiveCamera(55, 1, 1, 40000);

  // ---- geometry (rebuilt whenever the visible set changes) ----
  const pointGeom = new THREE.BufferGeometry();
  const pointMat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(pointGeom, pointMat);
  points.frustumCulled = false;
  scene.add(points);

  const lineGeom = new THREE.BufferGeometry();
  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
  const lines = new THREE.LineSegments(lineGeom, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  // ---- orbit camera (hand-rolled: ~60 lines beats vendoring another example module) ----
  const cam = { theta: 0.6, phi: 1.15, radius: 1900, target: new THREE.Vector3(), targetRadius: 1900 };
  let drag = null;
  const applyCamera = () => {
    cam.radius += (cam.targetRadius - cam.radius) * 0.18;
    const sp = Math.sin(cam.phi);
    camera.position.set(
      cam.target.x + cam.radius * sp * Math.sin(cam.theta),
      cam.target.y + cam.radius * Math.cos(cam.phi),
      cam.target.z + cam.radius * sp * Math.cos(cam.theta),
    );
    camera.lookAt(cam.target);
  };

  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, moved: 0 };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      opts.onHover?.(pickAt(e), e);
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.pan) {
      // pan along the camera's own right/up axes so dragging always moves the sky with the mouse
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const k = cam.radius * 0.0015;
      cam.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    } else {
      cam.theta -= dx * 0.005;
      cam.phi = Math.max(0.12, Math.min(Math.PI - 0.12, cam.phi - dy * 0.005));
    }
  });
  const endDrag = (e) => {
    if (drag && drag.moved < 5) opts.onPick?.(pickAt(e));
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => (drag = null));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.targetRadius = Math.max(120, Math.min(9000, cam.targetRadius * (e.deltaY > 0 ? 1.12 : 0.89)));
    },
    { passive: false },
  );

  // ---- picking: project every visible vertex and take the nearest within a pixel pad.
  // Same semantics as the 2D hit test (a generous pad, not the drawn radius), and at 550
  // vertices it costs less than building a raycaster's octree.
  let laidOut = []; // [{ id, v }] in draw order
  const v3 = new THREE.Vector3();
  function project(v) {
    v3.set(v.x, v.y, v.z ?? 0).project(camera);
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    return { x: (v3.x * 0.5 + 0.5) * w, y: (-v3.y * 0.5 + 0.5) * h, depth: v3.z };
  }
  function pickAt(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestD = 18; // px
    for (const { id, v } of laidOut) {
      const p = project(v);
      if (p.depth > 1) continue; // behind the camera
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // ---- data ----
  let highlight = null; // Set of ids to keep lit, or null for "everything"
  let highlightId = null;

  function rebuild() {
    const state = opts.getState();
    if (!state) return;
    ensure3D(state);
    const vertices = opts.visible();
    laidOut = vertices.map((v) => ({ id: v.id, v }));
    const n = vertices.length;
    const pos = new Float32Array(n * 3);
    const tint = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const dim = new Float32Array(n);
    const index = new Map();
    const c = new THREE.Color();
    vertices.forEach((v, i) => {
      index.set(v.id, i);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z ?? 0;
      c.set(opts.colorOf(v));
      tint[i * 3] = c.r;
      tint[i * 3 + 1] = c.g;
      tint[i * 3 + 2] = c.b;
      size[i] = 9 + Math.min(30, Math.sqrt(v.degree ?? 0) * 8);
      dim[i] = 1;
    });
    pointGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pointGeom.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    pointGeom.setAttribute('size', new THREE.BufferAttribute(size, 1));
    pointGeom.setAttribute('dim', new THREE.BufferAttribute(dim, 1));

    const edges = state.edges.filter((e) => index.has(e.src) && index.has(e.dst));
    const lp = new Float32Array(edges.length * 6);
    const lc = new Float32Array(edges.length * 6);
    edges.forEach((e, i) => {
      const a = state.vertices.get(e.src);
      const b = state.vertices.get(e.dst);
      lp.set([a.x, a.y, a.z ?? 0, b.x, b.y, b.z ?? 0], i * 6);
      c.set(opts.colorOf(a));
      lc.set([c.r * 0.5, c.g * 0.5, c.b * 0.5], i * 6);
      c.set(opts.colorOf(b));
      lc.set([c.r * 0.5, c.g * 0.5, c.b * 0.5], i * 6 + 3);
    });
    lineGeom.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lineGeom.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    lineGeom.userData = { edges, index };
    pointGeom.userData = { index };
    applyHighlight();
  }

  /** Positions only — called every frame while the sim is still moving (no reallocation). */
  function syncPositions() {
    const state = opts.getState();
    const pos = pointGeom.getAttribute('position');
    if (!state || !pos) return;
    laidOut.forEach(({ v }, i) => {
      pos.setXYZ(i, v.x, v.y, v.z ?? 0);
    });
    pos.needsUpdate = true;
    const lpos = lineGeom.getAttribute('position');
    const edges = lineGeom.userData?.edges ?? [];
    if (lpos) {
      edges.forEach((e, i) => {
        const a = state.vertices.get(e.src);
        const b = state.vertices.get(e.dst);
        if (!a || !b) return;
        lpos.setXYZ(i * 2, a.x, a.y, a.z ?? 0);
        lpos.setXYZ(i * 2 + 1, b.x, b.y, b.z ?? 0);
      });
      lpos.needsUpdate = true;
    }
  }

  /** Put the whole cloud on screen: centre on its centroid, back off past its radius. */
  function fit() {
    if (!laidOut.length) return;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const { v } of laidOut) {
      cx += v.x;
      cy += v.y;
      cz += v.z ?? 0;
    }
    const n = laidOut.length;
    cx /= n;
    cy /= n;
    cz /= n;
    let far = 0;
    for (const { v } of laidOut) far = Math.max(far, Math.hypot(v.x - cx, v.y - cy, (v.z ?? 0) - cz));
    cam.target.set(cx, cy, cz);
    cam.targetRadius = Math.max(300, far * 2.4); // a margin so nothing clips at the edges
  }

  function applyHighlight() {
    const dim = pointGeom.getAttribute('dim');
    if (!dim) return;
    laidOut.forEach(({ id }, i) => dim.setX(i, !highlight || highlight.has(id) ? 1 : DIM_FACTOR));
    dim.needsUpdate = true;
    lineMat.opacity = highlight ? 0.14 : 0.32;
  }

  // ---- labels: HTML over the canvas, so Chinese text stays crisp at any zoom ----
  const labelNodes = new Map();
  function syncLabels() {
    const wanted = new Map();
    for (const { id, v } of laidOut) {
      if (!opts.labelFor) break;
      const text = opts.labelFor(v, { highlightId, highlight });
      if (text) wanted.set(id, { text, v });
    }
    for (const [id, el] of labelNodes) if (!wanted.has(id)) (el.remove(), labelNodes.delete(id));
    for (const [id, { text, v }] of wanted) {
      let el = labelNodes.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'g3d-label';
        labelLayer.append(el);
        labelNodes.set(id, el);
      }
      if (el.textContent !== text) el.textContent = text;
      const p = project(v);
      const off = p.depth > 1;
      el.style.display = off ? 'none' : 'block';
      if (!off) el.style.transform = `translate(-50%, 0) translate(${p.x}px, ${p.y + 10}px)`;
    }
  }

  // ---- loop ----
  let raf = 0;
  let running = false;
  let lastSig = '';
  let cooled = false;
  // The filters live on the page and can change from a dozen controls; rather than hooking
  // every one of them, notice that the visible set changed and rebuild. The 2D view already
  // recomputes this same list every frame, so the cost is known to be acceptable.
  const signature = (vis) =>
    `${vis.length}:${vis[0]?.id ?? ''}:${vis[vis.length >> 1]?.id ?? ''}:${vis[vis.length - 1]?.id ?? ''}`;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function frame() {
    if (!running) return;
    const state = opts.getState();
    if (state) {
      const sig = signature(opts.visible());
      if (sig !== lastSig) {
        rebuild();
        lastSig = sig;
      }
      if (shouldStep(state)) {
        stepForceClustered3D(state);
        decayAlpha(state);
        syncPositions();
        if (!cooled) fit(); // the cloud grows while the sim settles; keep it framed
      } else if (!cooled) {
        cooled = true;
        fit();
      }
      applyCamera();
      syncLabels();
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      running = true;
      resize();
      rebuild();
      lastSig = signature(opts.visible());
      cooled = false;
      fit();
      const state = opts.getState();
      if (state) reheat(state);
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
      for (const [, el] of labelNodes) el.remove();
      labelNodes.clear();
    },
    resize,
    rebuild,
    setHighlight(id, ids) {
      highlightId = id;
      highlight = ids;
      applyHighlight();
    },
    /** Frame the whole cloud, or one vertex when given an id. */
    focus(id) {
      const state = opts.getState();
      const v = id && state ? state.vertices.get(id) : null;
      if (v) {
        cam.target.set(v.x, v.y, v.z ?? 0);
        cam.targetRadius = 420;
      } else {
        fit();
      }
    },
    dispose() {
      this.stop();
      pointGeom.dispose();
      lineGeom.dispose();
      pointMat.dispose();
      lineMat.dispose();
      renderer.dispose();
    },
  };
}
