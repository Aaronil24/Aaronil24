/* Interactive lab for aarondsouza.space
   1. Controller tuning: two-link arm with PID, computed-torque and adaptive (Slotine–Li) control
   2. Cart-pole stress test: LQR vs the trained PPO policies from github.com/Aaronil24/cartpole-lqr-vs-rl
   3. Satellite thermal orbit: lumped thermal network of a small satellite in low Earth orbit
   Everything runs locally in the browser; only the visible lab is simulated. */
(function () {
  'use strict';
  var lab = document.getElementById('lab');
  if (!lab) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var NS = 'http://www.w3.org/2000/svg';

  /* ---------------- shared helpers ---------------- */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function fmt(v, d) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(d); }
  function svgEl(name, attrs, parent, text) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
    var steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (f <= steps[i] + 1e-9) return steps[i] * e;
    return 10 * e;
  }
  function fitCanvas(c, ratio, maxDpr) {
    var w = Math.max(1, c.clientWidth), h = Math.round(w * ratio);
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr || 2);
    c.style.height = h + 'px';
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    var ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: w, H: h };
  }
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function bindRange(id, onChange, format) {
    var el = document.getElementById(id), out = document.querySelector('output[for="' + id + '"]');
    function show() { if (out) out.textContent = format(+el.value); }
    el.addEventListener('input', function () { show(); onChange(+el.value); });
    show();
    return { el: el, set: function (v) { el.value = v; show(); } };
  }
  function bindSeg(group, onChange) {
    var btns = group.querySelectorAll('button');
    function set(v) { btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.v === v)); }); }
    btns.forEach(function (b) { b.addEventListener('click', function () { set(b.dataset.v); onChange(b.dataset.v); }); });
    return { set: set };
  }

  /* Small SVG line chart with a hover readout. Series: [{cls, data:[[x,y],...]}]; band: {lo, hi} arrays of [x,y] */
  function Chart(holder, cfg) {
    var svg = svgEl('svg', { 'class': 'lab-chart-svg', role: 'img', 'aria-label': cfg.label }, holder);
    var tip = document.createElement('div'); tip.className = 'lab-tip'; tip.hidden = true; holder.appendChild(tip);
    var state = { series: [], band: null, shade: [], hlines: [], cursor: null, yMin: 0, yMax: 1 };
    var W = 0, H = 0, L = 46, R = 12, T = 12, B = 30;
    function x(v) { return L + (v - cfg.xMin) / (cfg.xMax - cfg.xMin) * (W - L - R); }
    function y(v) { return T + (1 - (v - state.yMin) / (state.yMax - state.yMin)) * (H - T - B); }
    function draw() {
      W = Math.max(240, holder.clientWidth); H = cfg.height || 200;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('height', H);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      state.shade.forEach(function (s) { svgEl('rect', { x: x(s[0]), y: T, width: Math.max(0, x(s[1]) - x(s[0])), height: H - T - B, 'class': 'lc-shade' }, svg); if (s[2]) svgEl('text', { x: (x(s[0]) + x(s[1])) / 2, y: T + 14, 'text-anchor': 'middle', 'class': 'lc-note' }, svg, s[2]); });
      var step = (state.yMax - state.yMin) / 4;
      for (var i = 0; i <= 4; i++) {
        var v = state.yMin + i * step;
        svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), 'class': i === 0 ? 'lc-axis' : 'lc-grid' }, svg);
        svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'class': 'lc-tick' }, svg, fmt(v, step < 1 ? 1 : 0));
      }
      cfg.xTicks.forEach(function (t, i) { svgEl('text', { x: x(t), y: H - 10, 'text-anchor': i === cfg.xTicks.length - 1 ? 'end' : 'middle', 'class': 'lc-tick' }, svg, t + (i === cfg.xTicks.length - 1 ? ' ' + cfg.xUnit : '')); });
      svgEl('text', { x: L, y: T - 2, 'class': 'lc-tick' }, svg, cfg.yUnit);
      state.hlines.forEach(function (hl) {
        if (hl.v < state.yMin || hl.v > state.yMax) return;
        svgEl('line', { x1: L, x2: W - R, y1: y(hl.v), y2: y(hl.v), 'class': 'lc-limit' }, svg);
        svgEl('text', { x: W - R - 4, y: y(hl.v) - 5, 'text-anchor': 'end', 'class': 'lc-note' }, svg, hl.label);
      });
      if (state.band) {
        var d = state.band.hi.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('') +
          state.band.lo.slice().reverse().map(function (p) { return 'L' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1); }).join('') + 'Z';
        svgEl('path', { d: d, 'class': 'lc-band' }, svg);
      }
      state.series.forEach(function (s) {
        if (!s.data || s.data.length < 2) return;
        svgEl('path', { d: s.data.map(function (p, i) { return (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(clamp(p[1], state.yMin, state.yMax)).toFixed(1); }).join(''), 'class': s.cls }, svg);
      });
      if (state.cursor != null) svgEl('line', { x1: x(state.cursor), x2: x(state.cursor), y1: T, y2: H - B, 'class': 'lc-cursor' }, svg);
      hover = svgEl('line', { x1: 0, x2: 0, y1: T, y2: H - B, 'class': 'lc-hover', visibility: 'hidden' }, svg);
      svgEl('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent', 'class': 'lc-hit' }, svg);
    }
    var hover;
    function onMove(e) {
      var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * (W / r.width);
      if (px < L || px > W - R) { onLeave(); return; }
      var xv = cfg.xMin + (px - L) / (W - L - R) * (cfg.xMax - cfg.xMin);
      var html = cfg.tip(xv, state);
      if (!html) { onLeave(); return; }
      hover.setAttribute('x1', px); hover.setAttribute('x2', px); hover.setAttribute('visibility', 'visible');
      tip.innerHTML = html; tip.hidden = false;
      var left = (px / W) * r.width; tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left + 12)) + 'px';
    }
    function onLeave() { tip.hidden = true; if (hover) hover.setAttribute('visibility', 'hidden'); }
    svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerleave', onLeave);
    return {
      set: function (s) { for (var k in s) state[k] = s[k]; draw(); },
      draw: draw
    };
  }

  /* ---------------- tabs and run management ---------------- */
  var tabs = Array.prototype.slice.call(lab.querySelectorAll('[role="tab"]'));
  var panels = {}, labsById = {}, active = null, labVisible = false, raf = 0, last = 0;
  tabs.forEach(function (t) { panels[t.id] = document.getElementById(t.getAttribute('aria-controls')); });
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      panels[t.id].hidden = !on;
    });
    if (focus) tab.focus();
    active = labsById[tab.id];
    if (active && active.activate) active.activate();
    loop();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t); });
    t.addEventListener('keydown', function (e) {
      var j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
      if (j == null) return; e.preventDefault(); select(tabs[(j + tabs.length) % tabs.length], true);
    });
  });
  function frame(now) {
    raf = 0;
    if (!running()) return;
    var dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60; last = now;
    active.tick(dt);
    raf = requestAnimationFrame(frame);
  }
  function running() { return !reduce && active && labVisible && !document.hidden; }
  function loop() { if (running() && !raf) { last = 0; raf = requestAnimationFrame(frame); } }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { labVisible = en[0].isIntersecting; loop(); }, { rootMargin: '100px 0px' }).observe(lab);
  } else { labVisible = true; }
  document.addEventListener('visibilitychange', loop);
  var rT; window.addEventListener('resize', function () { clearTimeout(rT); rT = setTimeout(function () { Object.keys(labsById).forEach(function (k) { if (labsById[k].resize) labsById[k].resize(); }); }, 150); });

  /* =====================================================================
     1. Controller tuning lab
     ===================================================================== */
  labsById['tab-arm'] = (function () {
    var root = document.getElementById('panel-arm');
    var canvas = root.querySelector('canvas'), cv;
    var L1 = .4, L2 = .4, M1 = 2, M2 = 1.5, LC1 = .2, LC2 = .2, I1 = M1 * L1 * L1 / 12, I2 = M2 * L2 * L2 / 12, G = 9.81, FR = .05, TMAX = 60, T = 8, DT = 1 / 1000;
    // Dynamics are linear in a = [a1..a5]; a point payload at the end effector adds mp * PAY
    var NOM = [M1 * LC1 * LC1 + M2 * (L1 * L1 + LC2 * LC2) + I1 + I2, M2 * L1 * LC2, M2 * LC2 * LC2 + I2, (M1 * LC1 + M2 * L1) * G, M2 * LC2 * G];
    var PAY = [L1 * L1 + L2 * L2, L1 * L2, L2 * L2, L1 * G, L2 * G];
    var J = [NOM[0] + 2 * NOM[1], NOM[2]], GAMMA = 10;
    var cfg = { ctrl: 'ct', w: 12, err: 0.15, mp: 0.5 };
    var NAMES = { pid: 'PID', ct: 'Computed torque', ad: 'Adaptive' };
    var NOTES = {
      pid: 'Independent PID per joint, with integral clamping. It uses no model, so the model-error slider has no effect.',
      ct: 'Cancels the dynamics with the model. Excellent when the model is right; a wrong model or an unknown payload leaves a steady error. Try Adaptive with the same settings, or set both sliders to zero.',
      ad: 'Slotine–Li adaptive control: the same model-based structure, but the parameters are updated online with a Lyapunov-based law.'
    };
    var run, prev = null, lastDone = null;

    function ik(x, y) { var c2 = clamp((x * x + y * y - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1), s2 = Math.sqrt(1 - c2 * c2); return [Math.atan2(y, x) - Math.atan2(L2 * s2, L1 + L2 * c2), Math.atan2(s2, c2)]; }
    function fk(q1, q2) { return [L1 * Math.cos(q1) + L2 * Math.cos(q1 + q2), L1 * Math.sin(q1) + L2 * Math.sin(q1 + q2)]; }
    function path(t) { var w = 2 * Math.PI / T; return [-.28 + .2 * Math.sin(w * t), .42 + .14 * Math.sin(2 * w * t)]; }
    function qd(t) { var p = path(t); return ik(p[0], p[1]); }
    function ref(t) {
      var h = 1e-3, a = qd(t - h), b = qd(t), c = qd(t + h);
      return { q: b, d: [(c[0] - a[0]) / (2 * h), (c[1] - a[1]) / (2 * h)], dd: [(c[0] - 2 * b[0] + a[0]) / (h * h), (c[1] - 2 * b[1] + a[1]) / (h * h)] };
    }
    function Mm(a, q2) { var c = Math.cos(q2); return [a[0] + 2 * a[1] * c, a[2] + a[1] * c, a[2]]; }
    function Cq(a, q2, d1, d2) { var h = a[1] * Math.sin(q2); return [-h * (2 * d1 * d2 + d2 * d2), h * d1 * d1]; }
    function gv(a, q1, q2) { return [a[3] * Math.cos(q1) + a[4] * Math.cos(q1 + q2), a[4] * Math.cos(q1 + q2)]; }
    function key() { return [cfg.ctrl, cfg.w, cfg.err, cfg.mp].join('|'); }
    function label() { return NAMES[cfg.ctrl] + ', ω ' + cfg.w + (cfg.ctrl !== 'pid' ? ', model −' + Math.round(cfg.err * 100) + ' %' : '') + ', ' + cfg.mp.toFixed(1) + ' kg'; }

    function newRun() {
      var r0 = ref(0);
      run = { c: { ctrl: cfg.ctrl, w: cfg.w }, key: key(), label: label(), t: 0, q: r0.q.slice(), dq: r0.d.slice(), I: [0, 0],
        at: NOM.map(function (v, i) { return v + cfg.mp * PAY[i]; }),
        ah: NOM.map(function (v) { return v * (1 - cfg.err); }),
        trace: [[0, 0]], se: 0, n: 0, emax: 0, tmax: 0, nextSample: 0.02, trail: [] };
    }
    function step() {
      var r = ref(run.t), q = run.q, dq = run.dq, w = run.c.w, ah = run.ah, ctrl = run.c.ctrl, tau, j;
      var e = [q[0] - r.q[0], q[1] - r.q[1]], de = [dq[0] - r.d[0], dq[1] - r.d[1]];
      if (ctrl === 'pid') {
        tau = [0, 0];
        for (j = 0; j < 2; j++) {
          var Kp = J[j] * w * w, Kd = 2 * J[j] * w, Ki = Kp * w / 3, lim = 30 / Ki;
          run.I[j] = clamp(run.I[j] + e[j] * DT, -lim, lim);
          tau[j] = -(Kp * e[j] + Kd * de[j] + Ki * run.I[j]);
        }
      } else if (ctrl === 'ct') {
        var v = [r.dd[0] - 2 * w * de[0] - w * w * e[0], r.dd[1] - 2 * w * de[1] - w * w * e[1]];
        var M = Mm(ah, q[1]), c = Cq(ah, q[1], dq[0], dq[1]), g = gv(ah, q[0], q[1]);
        tau = [M[0] * v[0] + M[1] * v[1] + c[0] + g[0], M[1] * v[0] + M[2] * v[1] + c[1] + g[1]];
      } else {
        var qr = [r.d[0] - w * e[0], r.d[1] - w * e[1]], qrr = [r.dd[0] - w * de[0], r.dd[1] - w * de[1]], s = [de[0] + w * e[0], de[1] + w * e[1]];
        var c2 = Math.cos(q[1]), s2 = Math.sin(q[1]), c1 = Math.cos(q[0]), c12 = Math.cos(q[0] + q[1]);
        var Y0 = [qrr[0], 2 * c2 * qrr[0] + c2 * qrr[1] - s2 * dq[1] * qr[0] - s2 * (dq[0] + dq[1]) * qr[1], qrr[1], c1, c12];
        var Y1 = [0, c2 * qrr[0] + s2 * dq[0] * qr[0], qrr[0] + qrr[1], 0, c12];
        tau = [-J[0] * w * s[0], -J[1] * w * s[1]];
        for (var i = 0; i < 5; i++) {
          tau[0] += Y0[i] * ah[i]; tau[1] += Y1[i] * ah[i];
          ah[i] -= GAMMA * Math.max(.02, Math.abs(NOM[i])) * (Y0[i] * s[0] + Y1[i] * s[1]) * DT;
        }
      }
      tau[0] = clamp(tau[0], -TMAX, TMAX); tau[1] = clamp(tau[1], -TMAX, TMAX);
      run.tmax = Math.max(run.tmax, Math.abs(tau[0]), Math.abs(tau[1]));
      var P = Mm(run.at, q[1]), cc = Cq(run.at, q[1], dq[0], dq[1]), gg = gv(run.at, q[0], q[1]);
      var b0 = tau[0] - cc[0] - gg[0] - FR * dq[0], b1 = tau[1] - cc[1] - gg[1] - FR * dq[1], det = P[0] * P[2] - P[1] * P[1];
      dq[0] += (P[2] * b0 - P[1] * b1) / det * DT; dq[1] += (P[0] * b1 - P[1] * b0) / det * DT;
      q[0] += dq[0] * DT; q[1] += dq[1] * DT;
      run.t += DT;
      var A = fk(q[0], q[1]), D = fk(r.q[0], r.q[1]), err = Math.hypot(A[0] - D[0], A[1] - D[1]) * 1000;
      run.se += err * err; run.n++; run.emax = Math.max(run.emax, err);
      if (run.t >= run.nextSample) { run.trace.push([run.t, err]); run.nextSample += 0.02; }
    }
    function advance(sec) {
      var n = Math.round(sec / DT);
      for (var k = 0; k < n; k++) {
        step();
        if (run.t >= T) { finish(); return; }
      }
    }
    function runToEnd() { while (run.t < T - DT / 2) step(); }
    function finish() {
      lastDone = { key: run.key, label: run.label, trace: run.trace, rms: Math.sqrt(run.se / run.n) };
      newRun();
    }
    function settingsChanged() {
      if (run && run.key !== key() && run.n > 300) {
        // finish the interrupted run instantly so the comparison uses a full 8 seconds
        while (run.t < T) step();
        prev = { key: run.key, label: run.label, trace: run.trace, rms: Math.sqrt(run.se / run.n) };
      } else if (lastDone && lastDone.key !== key()) prev = lastDone;
      newRun();
      root.querySelector('.lab-note').textContent = NOTES[cfg.ctrl];
      document.getElementById('arm-err').disabled = cfg.ctrl === 'pid';
      if (reduce) { runToEnd(); render(); }
      chartUpdate();
    }

    var chart = Chart(root.querySelector('.lab-chart'), {
      label: 'Tracking error of the end effector over one 8-second run', xMin: 0, xMax: T, xTicks: [0, 2, 4, 6, 8], xUnit: 's', yUnit: 'mm', height: 180,
      tip: function (xv, st) {
        var rows = [];
        st.series.forEach(function (s) { if (!s.data.length) return; var i = Math.min(s.data.length - 1, Math.round(xv / 0.02)); if (s.data[i] && Math.abs(s.data[i][0] - xv) < 0.05) rows.push('<span class="sw ' + s.sw + '"></span>' + s.name + ': ' + s.data[i][1].toFixed(1) + ' mm'); });
        return rows.length ? '<strong>' + xv.toFixed(1) + ' s</strong><br>' + rows.join('<br>') : '';
      }
    });
    function chartUpdate() {
      var cur = run.trace, all = cur.concat(prev ? prev.trace : []), mx = 0;
      for (var i = 0; i < all.length; i++) mx = Math.max(mx, all[i][1]);
      var series = [];
      if (prev) series.push({ cls: 'lc-prev', sw: 'sw-prev', name: 'Previous', data: prev.trace });
      series.push({ cls: 'lc-line', sw: 'sw-cur', name: 'This run', data: cur });
      chart.set({ series: series, yMin: 0, yMax: niceMax(Math.max(2, mx * 1.1)) });
      var lg = root.querySelector('.lab-legend');
      lg.innerHTML = '<span><span class="sw sw-cur"></span>This run: ' + run.label + '</span>' + (prev ? '<span><span class="sw sw-prev"></span>Previous: ' + prev.label + ', RMS ' + prev.rms.toFixed(1) + ' mm</span>' : '');
    }

    var outRms = document.getElementById('arm-rms'), outMax = document.getElementById('arm-max'), outTau = document.getElementById('arm-tau'), outEst = document.getElementById('arm-est');
    function readouts() {
      outRms.textContent = run.n ? Math.sqrt(run.se / run.n).toFixed(1) + ' mm' : '–';
      outMax.textContent = run.n ? run.emax.toFixed(1) + ' mm' : '–';
      outTau.textContent = run.n ? run.tmax.toFixed(1) + ' N·m' : '–';
      if (cfg.ctrl === 'ad') outEst.textContent = Math.max(0, (run.ah[4] - NOM[4]) / PAY[4]).toFixed(2) + ' kg (true ' + cfg.mp.toFixed(1) + ')';
      else outEst.textContent = cfg.ctrl === 'ct' ? 'fixed: 0 kg' : 'no model';
    }

    function render() {
      if (!cv) cv = fitCanvas(canvas, .62, 2);
      var ctx = cv.ctx, W = cv.W, H = cv.H;
      var S = Math.min(W / 1.12, H / .92), bx = (W - 1.05 * S) / 2 + .8 * S, by = H - .06 * S - 16;
      function px(p) { return [bx + p[0] * S, by - p[1] * S]; }
      ctx.clearRect(0, 0, W, H);
      // floor and reach
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.moveTo(bx - S * .14, by + 12); ctx.lineTo(bx + S * .14, by + 12); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1; ctx.beginPath();
      for (var hx = bx - S * .14 + 7; hx <= bx + S * .14; hx += 9) { ctx.moveTo(hx, by + 12); ctx.lineTo(hx - 7, by + 21); } ctx.stroke();
      ctx.setLineDash([3, 6]); ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.beginPath(); ctx.arc(bx, by, .8 * S, Math.PI, 2 * Math.PI); ctx.stroke();
      // reference path
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath();
      for (var i = 0; i <= 160; i++) { var p = px(path(i / 160 * T)); if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }
      ctx.stroke(); ctx.setLineDash([]);
      var q = run.q, e1 = px([L1 * Math.cos(q[0]), L1 * Math.sin(q[0])]), ee = px(fk(q[0], q[1])), dpt = px(path(run.t));
      run.trail.push(ee); if (run.trail.length > 80) run.trail.shift();
      ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      for (i = 1; i < run.trail.length; i++) { ctx.strokeStyle = 'rgba(93,224,230,' + (i / run.trail.length * .7).toFixed(3) + ')'; ctx.beginPath(); ctx.moveTo(run.trail[i - 1][0], run.trail[i - 1][1]); ctx.lineTo(run.trail[i][0], run.trail[i][1]); ctx.stroke(); }
      var w = Math.max(9, S * .05), base = [bx, by];
      ctx.fillStyle = '#141920'; ctx.strokeStyle = 'rgba(242,244,247,.55)'; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(bx - w * 1.1, by + 12); ctx.lineTo(bx - w * .55, by - 2); ctx.lineTo(bx + w * .55, by - 2); ctx.lineTo(bx + w * 1.1, by + 12); ctx.closePath(); ctx.fill(); ctx.stroke();
      [[base, e1, w], [e1, ee, w * .82]].forEach(function (s) {
        ctx.strokeStyle = 'rgba(242,244,247,.55)'; ctx.lineWidth = s[2] + 2; ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); ctx.stroke();
        ctx.strokeStyle = '#141920'; ctx.lineWidth = s[2]; ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); ctx.stroke();
      });
      [[base, w * .62], [e1, w * .55]].forEach(function (j) {
        ctx.fillStyle = '#0E1116'; ctx.strokeStyle = 'rgba(242,244,247,.85)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(j[0][0], j[0][1], j[1], 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(242,244,247,.85)'; ctx.beginPath(); ctx.arc(j[0][0], j[0][1], j[1] * .28, 0, 7); ctx.fill();
      });
      // payload
      if (cfg.mp > 0) {
        var pr = 5 + 7 * Math.sqrt(cfg.mp / 1.5);
        ctx.fillStyle = '#323B47'; ctx.strokeStyle = 'rgba(242,244,247,.7)'; ctx.beginPath(); ctx.arc(ee[0], ee[1], pr, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(242,244,247,.75)'; ctx.font = '500 12px Inter, sans-serif'; ctx.fillText(cfg.mp.toFixed(1) + ' kg', ee[0] + pr + 6, ee[1] + 4);
      } else { ctx.fillStyle = '#5DE0E6'; ctx.beginPath(); ctx.arc(ee[0], ee[1], 4.5, 0, 7); ctx.fill(); }
      ctx.strokeStyle = 'rgba(93,224,230,.85)'; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.arc(dpt[0], dpt[1], 6, 0, 7); ctx.stroke();
      ctx.fillStyle = 'rgba(161,170,182,.9)'; ctx.font = '400 12px Inter, sans-serif';
      ctx.fillText('reference', Math.max(8, px(path(T * .75))[0] - 64), px(path(T * .75))[1] - 12);
      ctx.fillText('t = ' + run.t.toFixed(1) + ' s', 12, 20);
    }
    var acc = 0;
    function tick(dt) {
      advance(dt); render(); readouts();
      acc += dt; if (acc > .1) { acc = 0; chartUpdate(); }
    }

    var seg = bindSeg(root.querySelector('[data-seg="ctrl"]'), function (v) { cfg.ctrl = v; settingsChanged(); });
    bindRange('arm-w', function (v) { cfg.w = v; settingsChanged(); }, function (v) { return v + ' rad/s'; });
    bindRange('arm-err', function (v) { cfg.err = v / 100; settingsChanged(); }, function (v) { return '−' + v + ' %'; });
    bindRange('arm-mp', function (v) { cfg.mp = v; settingsChanged(); }, function (v) { return v.toFixed(1) + ' kg'; });
    root.querySelector('[data-act="rerun"]').addEventListener('click', function () { newRun(); if (reduce) runToEnd(); render(); chartUpdate(); readouts(); });
    seg.set(cfg.ctrl);
    newRun();
    root.querySelector('.lab-note').textContent = NOTES[cfg.ctrl];
    return {
      activate: function () { cv = null; if (reduce) runToEnd(); render(); readouts(); chartUpdate(); },
      tick: tick,
      resize: function () { cv = null; if (!root.hidden) { render(); chartUpdate(); } }
    };
  })();

  /* =====================================================================
     2. Cart-pole stress test
     ===================================================================== */
  labsById['tab-cartpole'] = (function () {
    var root = document.getElementById('panel-cartpole');
    var canvas = root.querySelector('canvas'), cv;
    var G = 9.81, FMAX = 10, DT = 0.02, XL = 2.4, THL = 0.8, STEPS = 500;
    var CTRL = [
      { id: 'lqr', name: 'LQR' },
      { id: 'ppo_nominal', name: 'PPO, nominal model' },
      { id: 'ppo_randomized', name: 'PPO, domain randomized' },
      { id: 'ppo_randomized_smooth', name: 'PPO, randomized + smooth' }
    ];
    var PRESETS = {
      nominal: { m: .1, motor: 100, delay: 0, noise: 0, repo: [100, 100, 100, 100] },
      heavy: { m: 3, motor: 100, delay: 0, noise: 0, repo: [81, 98, 100, 68] },
      weak: { m: .1, motor: 30, delay: 0, noise: 0, repo: [8, 92, 98, 8] },
      delay: { m: .1, motor: 100, delay: 80, noise: 0, repo: [82, 0, 100, 100] },
      noise: { m: .1, motor: 100, delay: 0, noise: .3, repo: [0, 2, 75, 62] }
    };
    var MASSES = [.05, .1, .2, .3, .5, .75, 1, 1.5, 2, 3];
    var cfg = { m: .1, motor: 100, delay: 0, noise: 0 }, data = null, loading = false, runSeed = 1, lanes = [], k = 0, acc = 0, finished = false, restartAt = 0;
    var statusEls = CTRL.map(function (c) { return root.querySelector('[data-lane="' + c.id + '"]'); });

    function decode(b64) { var bin = atob(b64), buf = new ArrayBuffer(bin.length), u = new Uint8Array(buf); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(buf); }
    function policy(f) {
      var W0 = f.subarray(0, 256), b0 = f.subarray(256, 320), W1 = f.subarray(320, 4416), b1 = f.subarray(4416, 4480), W2 = f.subarray(4480, 4544), b2 = f[4544];
      var h1 = new Float64Array(64), h2 = new Float64Array(64);
      return function (x) {
        var i, j, s;
        for (j = 0; j < 64; j++) { s = b0[j]; for (i = 0; i < 4; i++) s += x[i] * W0[i * 64 + j]; h1[j] = Math.tanh(s); }
        for (j = 0; j < 64; j++) { s = b1[j]; for (i = 0; i < 64; i++) s += h1[i] * W1[i * 64 + j]; h2[j] = Math.tanh(s); }
        s = b2; for (i = 0; i < 64; i++) s += h2[i] * W2[i]; return s;
      };
    }
    function deriv(s, F, p) {
      var xd = s[1], th = s[2], thd = s[3], M = 1, m = p.m, l = .5, I = m * l * l / 3, c = Math.cos(th), sn = Math.sin(th);
      var a11 = M + m, a12 = m * l * c, a22 = I + m * l * l, b1 = F - .1 * xd + m * l * sn * thd * thd, b2 = m * G * l * sn - .002 * thd, det = a11 * a22 - a12 * a12;
      return [xd, (b1 * a22 - a12 * b2) / det, thd, (a11 * b2 - a12 * b1) / det];
    }
    function rk4(s, F, p, h) {
      var k1 = deriv(s, F, p), s2 = [], s3 = [], s4 = [], i;
      for (i = 0; i < 4; i++) s2[i] = s[i] + .5 * h * k1[i]; var k2 = deriv(s2, F, p);
      for (i = 0; i < 4; i++) s3[i] = s[i] + .5 * h * k2[i]; var k3 = deriv(s3, F, p);
      for (i = 0; i < 4; i++) s4[i] = s[i] + h * k3[i]; var k4 = deriv(s4, F, p);
      return s.map(function (v, i) { return v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]); });
    }
    function gauss(rng) { return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng()); }

    function newRun(sameStart) {
      if (!sameStart) runSeed = (runSeed * 7919 + 17) % 100000;
      var rng = mulberry(runSeed);
      var s0 = [(rng() - .5), (rng() - .5) * .4, (rng() - .5) * .4, (rng() - .5) * .4];
      var noise = []; for (var i = 0; i < STEPS; i++) noise.push([gauss(rng), gauss(rng), gauss(rng), gauss(rng)]);
      var delaySteps = Math.round(cfg.delay / 20);
      lanes = CTRL.map(function (c) { return { c: c, s: s0.slice(), q: new Array(delaySteps + 1).fill(0), alive: true, tEnd: null, why: '', F: 0, sumF2: 0, nF: 0, noise: noise }; });
      k = 0; finished = false; acc = 0; restartAt = 0;
      updateStatus();
    }
    function act(lane, o) {
      var a;
      if (lane.c.id === 'lqr') { var K = data.K; a = -(K[0] * o[0] + K[1] * o[1] + K[2] * o[2] + K[3] * o[3]) / FMAX; }
      else a = data.pol[lane.c.id]([o[0] / 2.4, o[1] / 2, o[2] / .5, o[3] / 2]);
      return clamp(a, -1, 1);
    }
    function stepAll() {
      var p = { m: cfg.m }, motor = cfg.motor / 100;
      lanes.forEach(function (ln) {
        if (!ln.alive) return;
        var nz = ln.noise[k], o = [ln.s[0] + cfg.noise * nz[0], ln.s[1] + cfg.noise * nz[1], ln.s[2] + cfg.noise * nz[2], ln.s[3] + cfg.noise * nz[3]];
        ln.q.unshift(act(ln, o)); ln.q.pop();
        ln.F = FMAX * motor * ln.q[ln.q.length - 1];
        for (var j = 0; j < 4; j++) ln.s = rk4(ln.s, ln.F, p, DT / 4);
        if (k >= 250) { ln.sumF2 += ln.F * ln.F; ln.nF++; }
        if (Math.abs(ln.s[2]) > THL) { ln.alive = false; ln.tEnd = (k + 1) * DT; ln.why = 'fell'; }
        else if (Math.abs(ln.s[0]) > XL) { ln.alive = false; ln.tEnd = (k + 1) * DT; ln.why = 'track'; }
      });
      k++;
      if (k >= STEPS || lanes.every(function (l) { return !l.alive; })) { finished = true; updateStatus(); }
    }
    function updateStatus() {
      lanes.forEach(function (ln, i) {
        var el = statusEls[i], st = el.querySelector('.st'), rms = el.querySelector('.rms');
        if (!data) { st.textContent = 'Loading policy…'; st.className = 'st'; rms.textContent = ''; return; }
        if (!ln.alive) { st.innerHTML = '<span class="ico bad" aria-hidden="true">✕</span>' + (ln.why === 'fell' ? 'Pole fell at ' : 'Hit the track end at ') + ln.tEnd.toFixed(1) + ' s'; st.className = 'st'; }
        else if (finished) { st.innerHTML = '<span class="ico good" aria-hidden="true">✓</span>Balanced for 10 s'; st.className = 'st'; }
        else { st.textContent = 'Running, ' + (k * DT).toFixed(1) + ' s'; st.className = 'st running'; }
        rms.textContent = ln.nF > 10 ? 'RMS force ' + Math.sqrt(ln.sumF2 / ln.nF).toFixed(1) + ' N' : '';
      });
      var repo = root.querySelector('.lab-repo'), match = null;
      Object.keys(PRESETS).forEach(function (n) { var p = PRESETS[n]; if (p.m === cfg.m && p.motor === cfg.motor && p.delay === cfg.delay && p.noise === cfg.noise) match = p; });
      root.querySelectorAll('[data-preset]').forEach(function (b) { var p = PRESETS[b.dataset.preset]; b.setAttribute('aria-pressed', String(p === match)); });
      repo.innerHTML = match ? 'Over 200 runs of this scenario in the repository: ' + CTRL.map(function (c, i) { return c.name + ' <strong>' + match.repo[i] + ' %</strong>'; }).join(', ') + '.' : 'Custom scenario. Pick a preset to compare with the 200-run results in the repository.';
    }

    function render() {
      if (!cv) { var cw0 = canvas.clientWidth, cols0 = cw0 < 560 ? 1 : 2, s0 = (cw0 / cols0 - 28) / 5.2; cv = fitCanvas(canvas, (4 / cols0) * (s0 + 74) / cw0, 2); }
      var ctx = cv.ctx, W = cv.W, H = cv.H, cols = W < 560 ? 1 : 2, rows = 4 / cols, cw = W / cols, ch = H / rows;
      ctx.clearRect(0, 0, W, H);
      lanes.forEach(function (ln, i) {
        var ox = (i % cols) * cw, oy = Math.floor(i / cols) * ch, pad = 14, s = (cw - 2 * pad) / 5.2, ty = oy + ch - 26;
        var cx0 = ox + cw / 2;
        ctx.fillStyle = 'rgba(242,244,247,.9)'; ctx.font = '500 13px Inter, sans-serif'; ctx.fillText(ln.c.name, ox + pad, oy + 22);
        // track
        ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx0 - 2.4 * s, ty + 9); ctx.lineTo(cx0 + 2.4 * s, ty + 9); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; [-2.4, 2.4].forEach(function (e) { ctx.beginPath(); ctx.moveTo(cx0 + e * s, ty + 3); ctx.lineTo(cx0 + e * s, ty + 15); ctx.stroke(); });
        var x = cx0 + clamp(ln.s[0], -2.6, 2.6) * s, th = ln.s[2], dim = ln.alive ? 1 : .45;
        // force arrow
        if (ln.alive && Math.abs(ln.F) > .05) {
          var fl = ln.F / FMAX * .7 * s, dir = Math.sign(fl);
          ctx.strokeStyle = 'rgba(79,140,255,.9)'; ctx.fillStyle = 'rgba(79,140,255,.9)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x, ty + 1); ctx.lineTo(x + fl, ty + 1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x + fl + dir * 6, ty + 1); ctx.lineTo(x + fl, ty - 3); ctx.lineTo(x + fl, ty + 5); ctx.closePath(); ctx.fill();
        }
        // cart
        var cwid = Math.max(22, .3 * s), chh = 12;
        ctx.globalAlpha = dim;
        ctx.fillStyle = '#141920'; ctx.strokeStyle = 'rgba(242,244,247,.7)'; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - cwid / 2, ty - chh / 2 - 4, cwid, chh, 3) : ctx.rect(x - cwid / 2, ty - chh / 2 - 4, cwid, chh); ctx.fill(); ctx.stroke();
        // pole (length 2l = 1 m)
        var px = x, py = ty - 4 - chh / 2, tx = px + Math.sin(th) * s, tyy = py - Math.cos(th) * s;
        ctx.strokeStyle = ln.alive ? 'rgba(242,244,247,.95)' : 'rgba(208,59,59,.9)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, tyy); ctx.stroke();
        var pm = 3 + 4 * Math.sqrt(cfg.m / 3);
        ctx.fillStyle = ln.alive ? '#5DE0E6' : 'rgba(208,59,59,.9)'; ctx.beginPath(); ctx.arc(tx, tyy, pm, 0, 7); ctx.fill();
        ctx.fillStyle = '#0E1116'; ctx.strokeStyle = 'rgba(242,244,247,.85)'; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 7); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
        if (cols === 2 && i % 2 === 0) { ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(ox + cw, oy + 8); ctx.lineTo(ox + cw, oy + ch - 8); ctx.stroke(); }
        if (i < lanes.length - cols) { ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.moveTo(ox + 8, oy + ch); ctx.lineTo(ox + cw - 8, oy + ch); ctx.stroke(); }
      });
      ctx.fillStyle = 'rgba(161,170,182,.9)'; ctx.font = '400 12px Inter, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText('t = ' + (k * DT).toFixed(1) + ' s', W - 12, 20); ctx.textAlign = 'left';
    }
    function tick(dt) {
      if (!data) return;
      if (finished) {
        if (restartAt && performance.now() > restartAt) newRun();
        render(); return;
      }
      acc += dt;
      while (acc >= DT && !finished) { acc -= DT; stepAll(); }
      render();
      if (k % 5 === 0) updateStatus();
    }
    function runInstant() { while (!finished) stepAll(); render(); updateStatus(); }
    function changed() { newRun(true); if (reduce && data) runInstant(); else render(); }

    var mass = bindRange('cp-m', function (v) { cfg.m = MASSES[v]; changed(); }, function (v) { return MASSES[v] + ' kg'; });
    var motor = bindRange('cp-motor', function (v) { cfg.motor = v; changed(); }, function (v) { return v + ' %'; });
    var delay = bindRange('cp-delay', function (v) { cfg.delay = v; changed(); }, function (v) { return v + ' ms'; });
    var noise = bindRange('cp-noise', function (v) { cfg.noise = v; changed(); }, function (v) { return v.toFixed(2); });
    root.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = PRESETS[b.dataset.preset];
        cfg.m = p.m; cfg.motor = p.motor; cfg.delay = p.delay; cfg.noise = p.noise;
        mass.set(MASSES.indexOf(p.m)); motor.set(p.motor); delay.set(p.delay); noise.set(p.noise);
        changed();
      });
    });
    root.querySelector('[data-act="rerun"]').addEventListener('click', function () { newRun(); if (reduce && data) runInstant(); });

    function load() {
      if (data || loading) return; loading = true;
      fetch(root.dataset.src).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (d) {
        data = { K: d.K, pol: {} };
        Object.keys(d.policies).forEach(function (n) { data.pol[n] = policy(decode(d.policies[n])); });
        newRun(); if (reduce) runInstant(); else render();
      }).catch(function () {
        loading = false;
        statusEls.forEach(function (el) { el.querySelector('.st').textContent = 'The policies could not be loaded. Reload the page to try again.'; });
      });
    }
    newRun();
    return {
      activate: function () { cv = null; load(); render(); updateStatus(); },
      tick: tick,
      resize: function () { cv = null; if (!root.hidden) render(); }
    };
  })();

  /* =====================================================================
     3. Satellite thermal orbit
     ===================================================================== */
  labsById['tab-thermal'] = (function () {
    var root = document.getElementById('panel-thermal');
    var canvas = root.querySelector('canvas'), cv;
    var SIG = 5.670e-8, S0 = 1361, QIR = 237, ALB = .3, RE = 6371, R = 6871, MU = 398600;
    var P = 2 * Math.PI * Math.sqrt(R * R * R / MU), FE = (RE / R) * (RE / R), A = .25, CP = 2700 * 900 * A * .002, CE = 9000, GFE = .6, GFF = .4, DT = 2;
    var COAT = { black: { a: .95, e: .88, name: 'black paint' }, white: { a: .25, e: .88, name: 'white paint' }, bare: { a: .15, e: .05, name: 'bare aluminium' } };
    var FACE = { nadir: ['Zenith', 'Ram', 'Nadir', 'Wake'], sun: ['Sun side', 'Side +', 'Shade side', 'Side −'] };
    var LIM = [-20, 50], ORBIT_S = 24;
    var cfg = { coat: 'black', att: 'nadir', pw: 20 }, orbit = null, phase = 0;
    var eclHalf = Math.asin(RE / R);

    function normals(ph, att) {
      var rx = Math.cos(ph), ry = Math.sin(ph), vx = -ry, vy = rx;
      return att === 'nadir' ? [[rx, ry], [vx, vy], [-rx, -ry], [-vx, -vy]] : [[1, 0], [0, 1], [-1, 0], [0, -1]];
    }
    function sunlit(ph) { return !(Math.cos(ph) < 0 && Math.abs(Math.sin(ph)) < RE / R); }
    function solve() {
      var c = COAT[cfg.coat], T = [288, 288, 288, 288], Te = 293, N = Math.round(P / DT), out = [], orbits = 7;
      for (var k = 0; k < N * orbits; k++) {
        var ph = (k * DT / P) * 2 * Math.PI, rx = Math.cos(ph), ry = Math.sin(ph), lit = sunlit(ph), ns = normals(ph, cfg.att), q = [0, 0, 0, 0], i;
        for (i = 0; i < 4; i++) {
          var n = ns[i], cs = n[0], nd = -(n[0] * rx + n[1] * ry), F = FE * Math.max(0, nd) + .12 * (1 - Math.abs(nd));
          if (lit && cs > 0) q[i] += c.a * S0 * A * cs;
          q[i] += c.e * QIR * A * F;
          if (rx > 0) q[i] += c.a * ALB * S0 * A * F * rx;
          q[i] -= c.e * SIG * A * Math.pow(T[i], 4);
        }
        var nT = [], sumE = 0;
        for (i = 0; i < 4; i++) { nT[i] = T[i] + DT * (q[i] + GFE * (Te - T[i]) + GFF * (T[(i + 1) % 4] + T[(i + 3) % 4] - 2 * T[i])) / CP; sumE += GFE * (Te - T[i]); }
        Te += DT * (cfg.pw - sumE) / CE; T = nT;
        if (k >= N * (orbits - 1) && (k - N * (orbits - 1)) % 8 === 0) out.push({ t: (k - N * (orbits - 1)) * DT / 60, ph: ph % (2 * Math.PI), Te: Te - 273.15, T: T.map(function (v) { return v - 273.15; }) });
      }
      var emin = Infinity, emax = -Infinity, pmin = Infinity, pmax = -Infinity;
      out.forEach(function (o) { emin = Math.min(emin, o.Te); emax = Math.max(emax, o.Te); o.T.forEach(function (v) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }); });
      orbit = { pts: out, emin: emin, emax: emax, pmin: pmin, pmax: pmax };
    }
    function tempColor(t) {
      var stops = [[-60, [57, 135, 229]], [20, [78, 84, 94]], [100, [230, 103, 103]]], a, b, f;
      t = clamp(t, -60, 100);
      if (t <= 20) { a = stops[0]; b = stops[1]; } else { a = stops[1]; b = stops[2]; }
      f = (t - a[0]) / (b[0] - a[0]);
      return 'rgb(' + [0, 1, 2].map(function (i) { return Math.round(a[1][i] + f * (b[1][i] - a[1][i])); }).join(',') + ')';
    }
    function at(phi) { var n = orbit.pts.length; return orbit.pts[Math.floor(((phi % 1) + 1) % 1 * n) % n]; }

    var chart = Chart(root.querySelector('.lab-chart'), {
      label: 'Electronics temperature and the range of panel temperatures over one orbit', xMin: 0, xMax: 94.5, xTicks: [0, 30, 60, 90], xUnit: 'min', yUnit: '°C', height: 190,
      tip: function (xv) {
        var o = at(xv / (P / 60)); if (!o) return '';
        var lo = Math.min.apply(null, o.T), hi = Math.max.apply(null, o.T);
        return '<strong>' + xv.toFixed(0) + ' min' + (sunlit(o.ph) ? '' : ', eclipse') + '</strong><br><span class="sw sw-cur"></span>Electronics ' + fmt(o.Te, 1) + ' °C<br><span class="sw sw-band"></span>Panels ' + fmt(lo, 0) + ' to ' + fmt(hi, 0) + ' °C';
      }
    });
    function chartUpdate() {
      var pts = orbit.pts, ymin = Math.min(-40, orbit.pmin - 5), ymax = Math.max(60, orbit.pmax + 5);
      var span = niceMax((ymax - ymin) / 4) * 4; ymin = Math.floor(ymin / (span / 4)) * (span / 4);
      var e1 = (Math.PI - eclHalf) / (2 * Math.PI) * P / 60, e2 = (Math.PI + eclHalf) / (2 * Math.PI) * P / 60;
      chart.set({
        series: [{ cls: 'lc-line', data: pts.map(function (o) { return [o.t, o.Te]; }) }],
        band: { lo: pts.map(function (o) { return [o.t, Math.min.apply(null, o.T)]; }), hi: pts.map(function (o) { return [o.t, Math.max.apply(null, o.T)]; }) },
        shade: [[e1, e2, 'Eclipse']], hlines: [{ v: LIM[0], label: 'Lower limit −20 °C' }, { v: LIM[1], label: 'Upper limit +50 °C' }],
        yMin: ymin, yMax: ymin + span, cursor: phase * P / 60
      });
    }
    var outE = document.getElementById('th-elec'), outP = document.getElementById('th-panel'), outS = document.getElementById('th-status');
    function readouts() {
      outE.textContent = fmt(orbit.emin, 0) + ' to ' + fmt(orbit.emax, 0) + ' °C';
      outP.textContent = fmt(orbit.pmin, 0) + ' to ' + fmt(orbit.pmax, 0) + ' °C';
      var ok = orbit.emin >= LIM[0] && orbit.emax <= LIM[1];
      outS.innerHTML = ok ? '<span class="ico good" aria-hidden="true">✓</span>Within −20 to +50 °C'
        : '<span class="ico bad" aria-hidden="true">✕</span>' + (orbit.emax > LIM[1] ? 'Too hot: above +50 °C' : 'Too cold: below −20 °C');
    }

    function render() {
      if (!cv) cv = fitCanvas(canvas, canvas.clientWidth < 560 ? 1.15 : .56, 2);
      var ctx = cv.ctx, W = cv.W, H = cv.H, narrow = W < 560;
      var cx = narrow ? W * .5 : W * .38, cy = narrow ? H * .67 : H * .5, re = narrow ? W * .19 : Math.min(W, H) * .25, ro = re * 1.42;
      ctx.clearRect(0, 0, W, H);
      // sunlight from the right
      ctx.strokeStyle = 'rgba(227,181,91,.10)'; ctx.lineWidth = 1;
      for (var yy = 14; yy < H; yy += 18) { ctx.beginPath(); ctx.moveTo(W, yy); ctx.lineTo(cx, yy); ctx.stroke(); }
      ctx.fillStyle = 'rgba(227,181,91,.75)'; ctx.font = '500 12px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.fillText('Sunlight', W - 10, 18); ctx.textAlign = 'left';
      // shadow behind Earth
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, cy - re, cx, 2 * re);
      // Earth
      var g = ctx.createRadialGradient(cx + re * .35, cy - re * .2, re * .1, cx, cy, re);
      g.addColorStop(0, '#2c4a6e'); g.addColorStop(1, '#14202e');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, re, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(cx, cy, re, Math.PI / 2, Math.PI * 1.5); ctx.fill();
      ctx.strokeStyle = 'rgba(93,224,230,.25)'; ctx.beginPath(); ctx.arc(cx, cy, re, 0, 7); ctx.stroke();
      // orbit
      ctx.setLineDash([3, 6]); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.arc(cx, cy, ro, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      var ph = phase * 2 * Math.PI, o = at(phase), sx = cx + Math.cos(ph) * ro, sy = cy - Math.sin(ph) * ro;
      function sat(x0, y0, half, labels) {
        var ns = normals(ph, cfg.att), ang = cfg.att === 'nadir' ? ph : 0;
        ctx.save(); ctx.translate(x0, y0); ctx.rotate(-ang);
        ctx.fillStyle = '#0E1116'; ctx.fillRect(-half, -half, 2 * half, 2 * half);
        var edges = [[[half, -half], [half, half]], [[-half, -half], [half, -half]], [[-half, half], [-half, -half]], [[half, half], [-half, half]]];
        ctx.lineWidth = Math.max(3, half * .22); ctx.lineCap = 'square';
        edges.forEach(function (e, i) { ctx.strokeStyle = tempColor(o.T[i]); ctx.beginPath(); ctx.moveTo(e[0][0], e[0][1]); ctx.lineTo(e[1][0], e[1][1]); ctx.stroke(); });
        ctx.fillStyle = tempColor(o.Te); ctx.fillRect(-half * .35, -half * .35, half * .7, half * .7);
        ctx.restore();
        if (labels) {
          ctx.font = '500 12px Inter, sans-serif'; ctx.fillStyle = 'rgba(242,244,247,.92)';
          ns.forEach(function (n, i) {
            var lx = x0 + n[0] * (half + 14), ly = y0 - n[1] * (half + 14);
            ctx.textAlign = n[0] > .5 ? 'left' : n[0] < -.5 ? 'right' : 'center';
            ctx.fillText(FACE[cfg.att][i] + ' ' + fmt(o.T[i], 0) + ' °C', lx, ly + (n[1] < -.5 ? 10 : n[1] > .5 ? -2 : 4));
          });
          ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(161,170,182,.95)'; ctx.fillText('Electronics ' + fmt(o.Te, 0) + ' °C', x0, y0 + half + 44); ctx.textAlign = 'left';
        }
      }
      sat(sx, sy, Math.max(7, re * .09), false);
      // inset with labels
      var ih = narrow ? 30 : 40, ix = narrow ? W * .5 : W * .8, iy = narrow ? 78 : H * .42;
      if (!narrow) { ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ix - ih - 8, iy); ctx.stroke(); }
      sat(ix, iy, ih, true);
      ctx.fillStyle = sunlit(ph) ? 'rgba(227,181,91,.9)' : 'rgba(161,170,182,.9)'; ctx.font = '500 12px Inter, sans-serif';
      ctx.fillText(sunlit(ph) ? 'In sunlight' : 'In eclipse', 12, H - 14);
      ctx.fillStyle = 'rgba(122,132,146,.9)'; ctx.textAlign = 'right'; ctx.fillText('Not to scale', W - 12, H - 14); ctx.textAlign = 'left';
    }
    var acc = 0;
    function tick(dt) { phase = (phase + dt / ORBIT_S) % 1; render(); acc += dt; if (acc > .25) { acc = 0; chartUpdate(); } }
    function changed() { solve(); render(); readouts(); chartUpdate(); }

    bindSeg(root.querySelector('[data-seg="coat"]'), function (v) { cfg.coat = v; changed(); }).set(cfg.coat);
    bindSeg(root.querySelector('[data-seg="att"]'), function (v) { cfg.att = v; changed(); }).set(cfg.att);
    bindRange('th-pw', function (v) { cfg.pw = v; changed(); }, function (v) { return v + ' W'; });
    return {
      activate: function () { cv = null; if (!orbit) solve(); if (reduce) phase = .3; render(); readouts(); chartUpdate(); },
      tick: tick,
      resize: function () { cv = null; if (!root.hidden && orbit) { render(); chartUpdate(); } }
    };
  })();

  // Start with the first lab
  var initial = tabs[0];
  if (location.hash === '#lab-cartpole') initial = document.getElementById('tab-cartpole');
  if (location.hash === '#lab-thermal') initial = document.getElementById('tab-thermal');
  select(initial);
})();
