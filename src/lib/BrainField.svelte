<script>
  // Background hero effect. Two tiers of particles in one draw call:
  //   • ~1000 large, READABLE source-file icons (js/ts/rs/py/…) drift in chaos,
  //     stream in, and morph from file glyph → glowing dot as they lock in.
  //   • ~99000 brain-fill dots that fade in near their target as the brain forms,
  //     so the point count grows from ~1k to ~100k imperceptibly. The assembled
  //     brain is dense and shimmers iridescently.
  //
  // Notes:
  // - One THREE.Points draw call; all motion/morph/fade is on the GPU.
  // - Brain target positions: real surface-sampled mesh baked to brain-points.bin
  //   (scripts/bake-brain.mjs). Procedural fallback if the asset can't be fetched.
  // - The brain is shown in horizontal side profile (its recognizable silhouette).
  // - `three` is dynamically imported so it never lands in the chat-route bundle.
  import { onMount } from 'svelte';
  import brainUrl from './brain-points.bin?url';

  let canvas;

  // Tunables ----------------------------------------------------------------
  const COUNT_DESKTOP = 60000; // fallback only (procedural brain)
  const COUNT_MOBILE = 24000;
  const CHAOS_HOLD = 1.8; // seconds of pure chaos before assembly starts
  const ASSEMBLE = 6.0;   // seconds for the document framework to stream in
  const FILL = 4.0;       // seconds for completion points to ignite inside the brain
  const GLOW_RAMP = 2.5;  // seconds to fade the glow in once complete
  const ATLAS_COLS = 4;   // 4x4 = 16 file-type icons

  onMount(() => {
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const THREE = await import('three');
      if (disposed || !canvas) return;

      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const small = Math.min(innerWidth, innerHeight) < 720;

      // --- Brain target positions ------------------------------------------
      let COUNT, targets;
      try {
        const buf = await fetch(brainUrl).then((r) => r.arrayBuffer());
        if (disposed || !canvas) return;
        const q = new Int16Array(buf);
        const total = (q.length / 3) | 0;
        const stride = small ? 3 : 1; // thin out on small screens
        COUNT = Math.ceil(total / stride);
        targets = new Float32Array(COUNT * 3);
        for (let i = 0, j = 0; i < total; i += stride, j++) {
          targets[j * 3] = q[i * 3] / 32767;
          targets[j * 3 + 1] = q[i * 3 + 1] / 32767;
          targets[j * 3 + 2] = q[i * 3 + 2] / 32767;
        }
      } catch {
        COUNT = small ? COUNT_MOBILE : COUNT_DESKTOP;
        targets = new Float32Array(COUNT * 3);
        genBrainTargets(targets, COUNT);
      }

      // --- Per-particle attributes -----------------------------------------
      const starts = new Float32Array(COUNT * 3);
      const delays = new Float32Array(COUNT);
      const rands = new Float32Array(COUNT);
      const iconCells = new Float32Array(COUNT);
      const types = new Float32Array(COUNT);  // 1 = readable file icon, 0 = fill dot
      const spawns = new Float32Array(COUNT);  // fill dots: uProgress at which they fade in
      const ICON_COUNT = Math.min(COUNT, small ? 4000 : 10000);
      for (let i = 0; i < COUNT; i++) {
        rands[i] = Math.random();
        iconCells[i] = Math.floor(Math.random() * (ATLAS_COLS * ATLAS_COLS));
        if (i < ICON_COUNT) {
          // Framework: a readable file icon that streams in from chaos and morphs
          // to a glowing point, building the brain's skeleton.
          types[i] = 1;
          const u = Math.random() * 2 - 1;
          const th = Math.random() * Math.PI * 2;
          const rr = 1.3 + Math.random() * 1.8;
          const s = Math.sqrt(1 - u * u);
          starts[i * 3] = rr * s * Math.cos(th);
          starts[i * 3 + 1] = rr * u * 0.85;
          starts[i * 3 + 2] = rr * s * Math.sin(th);
          delays[i] = Math.random();
        } else {
          // Completion: a point that IGNITES at its target only after the framework
          // is assembled, filling the brain out to ~100k.
          types[i] = 0;
          starts[i * 3] = targets[i * 3];
          starts[i * 3 + 1] = targets[i * 3 + 1];
          starts[i * 3 + 2] = targets[i * 3 + 2];
          spawns[i] = Math.random() * 0.9;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(starts, 3));
      geo.setAttribute('aTarget', new THREE.BufferAttribute(targets, 3));
      geo.setAttribute('aDelay', new THREE.BufferAttribute(delays, 1));
      geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));
      geo.setAttribute('aIcon', new THREE.BufferAttribute(iconCells, 1));
      geo.setAttribute('aType', new THREE.BufferAttribute(types, 1));
      geo.setAttribute('aSpawn', new THREE.BufferAttribute(spawns, 1));

      const atlas = makeIconAtlas(THREE);

      const uniforms = {
        uTime: { value: 0 },
        uProgress: { value: 0 }, // framework assembly (documents → skeleton)
        uFill: { value: 0 },     // completion (points ignite to fill the brain)
        uGlow: { value: 0 },
        uIconBig: { value: small ? 34 : 46 }, // readable icon size (CSS px)
        uDot: { value: 4.5 },                 // assembled-dot size
        uFocal: { value: 4.3 },
        uPixelRatio: { value: Math.min(devicePixelRatio, 2) },
        uBase: { value: new THREE.Color(0.28, 0.36, 0.95) },
        uAtlas: { value: atlas },
        uCols: { value: ATLAS_COLS },
      };

      const material = new THREE.ShaderMaterial({
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform float uTime, uProgress, uFill, uGlow, uIconBig, uDot, uFocal, uPixelRatio;
          attribute vec3 aTarget;
          attribute float aDelay, aRand, aIcon, aType, aSpawn;
          varying float vRand, vGlow, vCell, vMorph, vAlpha;

          float easeInOut(float t){
            return t < 0.5 ? 2.0*t*t : 1.0 - pow(-2.0*t+2.0, 2.0)/2.0;
          }

          void main(){
            vRand = aRand;
            vGlow = uGlow;
            vCell = aIcon;

            vec3 pos;
            float sizePx;

            if (aType > 0.5) {
              // Readable file icon: chaos → brain, glyph → dot.
              float span = 0.6;
              float local = clamp((uProgress - aDelay*(1.0-span)) / span, 0.0, 1.0);
              float e = easeInOut(local);
              pos = mix(position, aTarget, e);
              float drift = 1.0 - e;
              pos += drift * 0.12 * vec3(
                sin(uTime*0.7 + aRand*6.28),
                cos(uTime*0.6 + aRand*5.0),
                sin(uTime*0.5 + aRand*4.0)
              );
              vMorph = smoothstep(0.6, 0.98, local);
              sizePx = mix(uIconBig, uDot, smoothstep(0.45, 1.0, local)) * (0.7 + 0.6*aRand);
              vAlpha = 1.0;
            } else {
              // Completion point: ignites in place (grows + fades in) during the
              // fill phase, after the framework is already assembled.
              float sp = smoothstep(aSpawn, aSpawn + 0.07, uFill);
              pos = aTarget;
              vMorph = 1.0;
              sizePx = uDot * (0.7 + 0.6*aRand) * sp; // grow from 0 → ignite
              vAlpha = sp;
            }

            // Breathing once assembled.
            pos *= 1.0 + uGlow * 0.018 * sin(uTime*1.3 + aRand*2.0);

            vec4 mv = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = sizePx * uPixelRatio * (uFocal / -mv.z);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform float uTime, uCols;
          uniform vec3 uBase;
          uniform sampler2D uAtlas;
          varying float vRand, vGlow, vCell, vMorph, vAlpha;

          vec3 hue2rgb(float h){
            vec3 k = mod(vec3(5.0, 3.0, 1.0) + h*6.0, 6.0);
            return clamp(min(k, 4.0 - k), 0.0, 1.0);
          }

          void main(){
            vec2 pc = gl_PointCoord;

            // File-icon atlas cell (only matters while vMorph < 1).
            float c = mod(vCell, uCols);
            float r = floor(vCell / uCols);
            vec4 icon = texture2D(uAtlas, (vec2(c, r) + pc) / uCols);

            // Soft dot.
            float dl = length(pc - 0.5);
            float dotA = smoothstep(0.5, 0.0, dl);
            float h = fract(uTime*0.045 + vRand*0.7);
            vec3 dotC = mix(uBase, hue2rgb(h), vGlow*0.85) * (0.85 + 0.85*vGlow);

            vec3 col = mix(icon.rgb, dotC, vMorph);
            float a = mix(icon.a, dotA, vMorph) * vAlpha;
            if (a < 0.01) discard;
            gl_FragColor = vec4(col, a);
          }
        `,
      });

      const points = new THREE.Points(geo, material);
      const spin = new THREE.Group(); // viewing angle + sway/parallax
      spin.add(points);
      const rig = new THREE.Group();  // 90° lay-down + lift + scale
      rig.add(spin);
      rig.rotation.z = Math.PI / 2;   // turn the brain horizontal
      rig.position.y = 0.5;
      rig.scale.setScalar(small ? 1.7 : 2.0);

      const scene = new THREE.Scene();
      scene.add(rig);

      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.set(0, 0, 4.3);
      const FAR_Z = 8.0, NEAR_Z = 4.2; // dolly: wide for the file cloud → close for the brain

      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        alpha: true,
        powerPreference: 'high-performance',
      });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

      const resize = () => {
        const w = canvas.clientWidth || innerWidth;
        const h = canvas.clientHeight || innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);

      let visible = true;
      const io = new IntersectionObserver(
        (es) => { visible = es[0].isIntersecting; if (visible) loop(); },
        { threshold: 0 }
      );
      io.observe(canvas);
      const onVis = () => { visible = !document.hidden; if (visible) loop(); };
      document.addEventListener('visibilitychange', onVis);

      const clock = new THREE.Clock();
      let raf = 0;
      let running = false;

      const frame = () => {
        running = true;
        if (disposed || !visible || document.hidden) { running = false; return; }
        const t = clock.getElapsedTime();
        uniforms.uTime.value = t;

        if (reduced) {
          uniforms.uProgress.value = 1;
          uniforms.uFill.value = 1;
          uniforms.uGlow.value = 1;
        } else {
          uniforms.uProgress.value = clamp((t - CHAOS_HOLD) / ASSEMBLE, 0, 1);
          uniforms.uFill.value = clamp((t - CHAOS_HOLD - ASSEMBLE) / FILL, 0, 1);
          uniforms.uGlow.value = clamp((t - CHAOS_HOLD - ASSEMBLE - FILL) / GLOW_RAMP, 0, 1);
        }

        // Dolly in as the framework assembles: wide for the file cloud, close for
        // the brain.
        const pr = uniforms.uProgress.value;
        const eased = pr < 0.5 ? 2.0 * pr * pr : 1.0 - Math.pow(-2.0 * pr + 2.0, 2.0) / 2.0;
        camera.position.z = reduced ? NEAR_Z : FAR_Z + (NEAR_Z - FAR_Z) * eased;

        // Side profile with a gentle automatic sway (no cursor parallax).
        const base = Math.PI * 0.5;
        const sway = reduced ? 0 : Math.sin(t * 0.15) * 0.22;
        spin.rotation.y = base + sway;
        spin.rotation.x = -0.12;

        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      const loop = () => { if (!running) frame(); };
      loop();

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        geo.dispose();
        material.dispose();
        atlas.dispose();
        renderer.dispose();
      };

      // --- helpers ---------------------------------------------------------
      function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

      // Draws a 4x4 atlas of glowing source-file icons. Strokes/text are bright on
      // transparent so they read well under additive blending.
      function makeIconAtlas(THREE) {
        const cell = 128;
        const size = ATLAS_COLS * cell;
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const g = cv.getContext('2d');
        const types = [
          { ext: 'js', c: '#f7df1e' }, { ext: 'ts', c: '#3aa0ff' },
          { ext: 'rs', c: '#ff8a5c' }, { ext: 'py', c: '#6ab0f3' },
          { ext: 'go', c: '#42d3e8' }, { ext: 'html', c: '#ff6a45' },
          { ext: 'css', c: '#5a8dff' }, { ext: 'json', c: '#e0e066' },
          { ext: 'md', c: '#b8bdc7' }, { ext: 'sql', c: '#ffb24d' },
          { ext: 'sh', c: '#9ff05a' }, { ext: 'yml', c: '#ff5d6c' },
          { ext: 'cpp', c: '#5aa9ff' }, { ext: 'svg', c: '#ffc24d' },
          { ext: 'env', c: '#f0e05a' }, { ext: 'vue', c: '#5fe0a0' },
        ];
        for (let i = 0; i < types.length; i++) {
          drawFile(g, (i % ATLAS_COLS) * cell, ((i / ATLAS_COLS) | 0) * cell, cell, types[i]);
        }
        const tex = new THREE.CanvasTexture(cv);
        tex.flipY = false; // match gl_PointCoord origin (top-left)
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        return tex;
      }

      function drawFile(g, ox, oy, s, t) {
        g.save();
        g.translate(ox, oy);
        const pad = s * 0.2;
        const fx = pad, fy = pad * 0.7;
        const w = s - 2 * pad, h = s - pad * 0.7 - pad;
        const fold = s * 0.24;
        g.lineJoin = 'round';
        g.lineWidth = Math.max(2.5, s * 0.045);
        // No body fill: it stacks into a muddy grey mass where icons overlap under
        // additive blending. Outline + code lines + label only.
        g.strokeStyle = t.c;
        g.beginPath();
        g.moveTo(fx, fy);
        g.lineTo(fx + w - fold, fy);
        g.lineTo(fx + w, fy + fold);
        g.lineTo(fx + w, fy + h);
        g.lineTo(fx, fy + h);
        g.closePath();
        g.stroke();
        g.beginPath();
        g.moveTo(fx + w - fold, fy);
        g.lineTo(fx + w - fold, fy + fold);
        g.lineTo(fx + w, fy + fold);
        g.stroke();
        g.lineWidth = Math.max(1.5, s * 0.022);
        g.globalAlpha = 0.9;
        const lx = fx + s * 0.13;
        const lw = w - s * 0.26;
        for (let k = 0; k < 3; k++) {
          const yy = fy + fold + s * 0.13 + k * s * 0.12;
          const ind = k === 1 ? s * 0.1 : 0;
          const trim = k === 2 ? s * 0.2 : 0;
          g.beginPath();
          g.moveTo(lx + ind, yy);
          g.lineTo(lx + lw - trim, yy);
          g.stroke();
        }
        g.globalAlpha = 1;
        g.fillStyle = t.c;
        g.font = `bold ${Math.floor(s * 0.15)}px ui-monospace, Menlo, monospace`;
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillText('.' + t.ext, fx + w / 2, fy + h - s * 0.07);
        g.restore();
      }

      // Procedural brain fallback (if the baked point cloud can't be fetched).
      function genBrainTargets(out, n) {
        for (let i = 0; i < n; i++) {
          const side = Math.random() < 0.5 ? 1 : -1;
          const u = Math.random() * 2 - 1;
          const th = Math.random() * Math.PI * 2;
          const s = Math.sqrt(1 - u * u);
          let dx = s * Math.cos(th), dy = u, dz = s * Math.sin(th);
          const fold =
            0.06 * Math.sin(6.0 * dx * Math.PI) * Math.sin(5.0 * dz * Math.PI) +
            0.05 * Math.sin(8.0 * dy * Math.PI + 1.3) +
            0.03 * Math.sin(11.0 * dz * Math.PI);
          const rr = 1 + fold;
          let x = side * 0.42 + dx * 0.6 * rr;
          let y = dy * 0.74 * rr;
          let z = dz * 1.02 * rr;
          if (Math.abs(x) < 0.12 && y > -0.15) { y -= (0.12 - Math.abs(x)) * 0.9; x += side * 0.05; }
          if (y < -0.35) y = -0.35 + (y + 0.35) * 0.55;
          const shell = 0.9 + Math.random() * 0.12;
          out[i * 3] = x * shell;
          out[i * 3 + 1] = y * shell;
          out[i * 3 + 2] = z * shell;
        }
      }
    })();

    return () => { disposed = true; cleanup(); };
  });
</script>

<canvas bind:this={canvas} class="brain-canvas" aria-hidden="true"></canvas>

<style>
  .brain-canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
