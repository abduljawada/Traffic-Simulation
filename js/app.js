'use strict';
(function () {
  const { Highway, runHighway, WBINS } = window.HighwaySim;
  const { City, runCity, VFREE } = window.CitySim;
  const $ = (s) => document.querySelector(s);

  // ---------------------------------------------------------------- theme
  let C = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'panel', 'line', 'text', 'muted', 'accent', 'good', 'warn', 'bad', 'road', 'road-edge', 'grass']) {
      C[k] = cs.getPropertyValue('--' + k).trim();
    }
  }
  readTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);

  const STOPS = [[255, 77, 77], [255, 194, 51], [62, 230, 193]];
  const LUT = [];
  for (let i = 0; i <= 64; i++) {
    const r = i / 64, seg = r < 0.5 ? 0 : 1, f = r < 0.5 ? r * 2 : (r - 0.5) * 2;
    const a = STOPS[seg], b = STOPS[seg + 1];
    LUT.push(`rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`);
  }
  const speedColor = (r) => LUT[Math.round(Math.max(0, Math.min(1, r)) * 64)];

  // ------------------------------------------------------- control specs
  const HW = {
    causes: [
      { key: 'density', label: 'Traffic volume', min: 8, max: 45, step: 1, fmt: (v) => `${v} veh/km/lane`,
        tip: 'Roads jam when demand crosses a critical density, not gradually.' },
      { key: 'noise', label: 'Braking noise', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2),
        tip: 'Random over-braking and distraction: the seed of phantom jams.' },
      { key: 'rampRate', label: 'On-ramp traffic', min: 0, max: 30, step: 1, fmt: (v) => `${v} veh/min`,
        tip: 'Merging cars need gaps; forced merges send a braking wave upstream.' },
      { key: 'incident', type: 'toggle', label: 'Breakdown in right lane', tip: 'A stopped vehicle blocks the lane at 62% of the loop.' },
      { key: 'rubber', type: 'toggle', label: 'Rubbernecking', dep: 'incident', tip: 'Drivers in other lanes slow down to look.' },
      { key: 'headway', label: 'Following gap', min: 0.8, max: 2.5, step: 0.1, fmt: (v) => `${v.toFixed(1)} s`,
        tip: 'Short gaps raise capacity but leave no room to absorb a brake tap. Long gaps cost capacity.' },
      { key: 'laneChange', type: 'toggle', label: 'Lane changing', tip: 'Switching lanes finds gaps but disturbs the cars behind.' },
    ],
    fixes: [
      { key: 'lanes', label: 'Lanes', min: 2, max: 5, step: 1, fmt: (v) => `${v}`,
        tip: 'Same cars spread over more lanes. (Real roads often refill: induced demand.)' },
      { key: 'limit', label: 'Speed limit', min: 60, max: 130, step: 5, fmt: (v) => `${v} km/h`,
        tip: 'Lower speeds shrink the shockwaves; too low wastes free-flow capacity.' },
      { key: 'cacc', label: 'Connected automated cars', min: 0, max: 100, step: 5, pct: true, fmt: (v) => `${v}%`,
        tip: 'They react to the 2 cars ahead, keep 0.9 s gaps and never over-brake.' },
      { key: 'vsl', type: 'toggle', label: 'Variable speed limits', tip: 'Gantries slow traffic upstream of a queue so it arrives smoothly.' },
      { key: 'metering', type: 'toggle', label: 'Ramp metering', tip: 'Holds ramp cars back when the lane is busy. Moves delay onto the ramp.' },
    ],
  };
  const CITY = {
    causes: [
      { key: 'demand', label: 'Trips entering', min: 20, max: 200, step: 5, fmt: (v) => `${v} /min`,
        tip: 'Rush-hour demand, tilted toward the east and south exits.' },
      { key: 'cruising', label: 'Cruising for parking', min: 0, max: 60, step: 5, pct: true, fmt: (v) => `${v}% of cars`,
        tip: 'Purple-outlined cars circle blocks before heading to their destination.' },
      { key: 'blocks', type: 'blocks', label: 'Curbside disruptions',
        tip: 'Double parking and deliveries: cars squeeze past at crawl speed. Click any street to add or remove one.' },
      { key: 'cycle', label: 'Signal cycle', min: 30, max: 150, step: 5, fmt: (v) => `${v} s`,
        tip: 'Long cycles mean long reds and queues that spill back to the previous junction.' },
    ],
    fixes: [
      { key: 'signal', type: 'seg', label: 'Signal control',
        opts: [['fixed', 'Uncoordinated'], ['sync', 'Green wave'], ['adaptive', 'Adaptive']],
        tip: 'Green wave favours the dominant east/south flow. Adaptive reacts to queues.' },
      { key: 'transit', label: 'Shift to transit / bike / carpool', min: 0, max: 50, step: 5, pct: true, fmt: (v) => `${v}%`,
        tip: 'Fewer cars on the same streets.' },
      { key: 'flex', label: 'Staggered hours / remote work', min: 0, max: 40, step: 5, pct: true, fmt: (v) => `${v}%`,
        tip: 'Flattens the peak instead of widening the road.' },
    ],
  };

  const PRESETS = {
    highway: [
      { name: 'Free flow', p: { density: 14, noise: 0.3 } },
      { name: 'Phantom jam', p: { density: 30, noise: 0.8 } },
      { name: 'Merge crunch', p: { density: 22, rampRate: 14 } },
      { name: 'Breakdown', p: { density: 22, incident: true } },
      { name: 'Everything helps', p: { density: 28, noise: 0.8, rampRate: 10, cacc: 0.5, vsl: true, metering: true } },
    ],
    city: [
      { name: 'Rush hour', p: {} },
      { name: 'Delivery chaos', p: { randomBlocks: 6 } },
      { name: 'Gridlock', p: { demand: 150, cycle: 110 } },
      { name: 'Smart city', p: { signal: 'adaptive', cycle: 60, transit: 0.25, flex: 0.1, cruising: 0.05 } },
    ],
  };

  const KPIS = {
    highway: [
      { id: 'speed', label: 'Average speed', unit: 'km/h', better: 1, get: (s) => s.stats.meanV * 3.6, fmt: (v) => v.toFixed(0),
        sub: (s, v) => `${Math.round(v / (s.v0 * 3.6) * 100)}% of free flow` },
      { id: 'flow', label: 'Flow past a point', unit: 'veh/h', better: 1, get: (s) => s.stats.flow, fmt: (v) => Math.round(v / 10) * 10 },
      { id: 'jam', label: 'Crawling cars', unit: '%', better: -1, get: (s) => s.stats.jam * 100, fmt: (v) => v.toFixed(0) },
      { id: 'ramp', label: 'Ramp queue', unit: 'cars', better: -1, get: (s) => s.stats.rampQ, fmt: (v) => v.toFixed(0) },
    ],
    city: [
      { id: 'speed', label: 'Network speed', unit: 'km/h', better: 1, get: (s) => s.stats.eff * 3.6, fmt: (v) => v.toFixed(0),
        sub: (s, v) => `${Math.round(v / (VFREE * 3.6) * 100)}% of free flow` },
      { id: 'delay', label: 'Trip time vs free flow', unit: '×', better: -1, get: (s) => s.stats.delay, fmt: (v) => v.toFixed(1) },
      { id: 'idle', label: 'Idling', unit: '%', better: -1, get: (s) => s.stats.idle * 100, fmt: (v) => v.toFixed(0) },
      { id: 'tpm', label: 'Trips finished', unit: '/min', better: 1, get: (s) => s.stats.tpm, fmt: (v) => v.toFixed(0) },
      { id: 'wait', label: 'Waiting to enter', unit: 'cars', better: -1, get: (s) => s.stats.backlog, fmt: (v) => v.toFixed(0) },
    ],
  };

  const EXPLAIN = {
    highway: [
      ['Demand beats capacity', 'A lane moves roughly 1,800 to 2,200 vehicles per hour at best. Past a critical density each extra car lowers total flow. Watch the flow-density chart bend over: that is the "capacity drop".'],
      ['Phantom jams', 'No crash needed. One driver over-brakes, human reaction lag makes the next driver brake harder, and the disturbance grows into a stop-and-go wave that travels backwards at about 15 to 20 km/h. In the space-time chart it is the red diagonal band.'],
      ['Merging', 'Ramp cars need gaps. When none come, drivers force in, the car behind brakes, and a wave runs upstream. Ramps are bottlenecks well below nominal capacity.'],
      ['Breakdowns', 'One blocked lane out of three removes far more than a third of capacity, because everyone must change lanes at the same spot. Rubbernecking in the open lanes adds to it.'],
      ['Smoothing fixes', 'Cars that see beyond the car ahead (connected automation), speed limits that slow traffic before a queue, and metering that keeps the mainline just under breakdown density all work by removing the sudden brake, not by adding road.'],
      ['Capacity vs demand', 'A lane adds capacity, but in real cities new capacity tends to fill up again (induced demand), which this sim does not model. Cutting cars by 10 to 15% can flip a jammed road to free flow. Use Diagnose to see the ranking for your setup.'],
      ['What the model leaves out', 'Closed loop (no true origins and destinations), cars only, identical driver physics except speed preference and lag, no weather or trucks, no induced demand. Treat results as direction and rough size, not forecasts.', true],
    ],
    city: [
      ['Signals', 'Every red costs a stop and a restart. Uncoordinated lights send cars into a red at nearly every block. A green wave helps only the dominant direction; adaptive signals shift green to where queues are. Neither can fix demand above capacity.'],
      ['Queue spillback', 'When a queue is longer than the block, it blocks the junction behind it and the jam spreads backwards through the grid. Long signal cycles make queues longer.'],
      ['Curbside disruptions', 'One double-parked truck turns a street into a bottleneck for everything behind it. Click streets to place or remove them and watch the ripple.'],
      ['Cruising for parking', 'Drivers hunting for a space add trips that go nowhere. Studies of downtown streets often put them at a large minority of traffic. Priced, well-signed parking cuts it.'],
      ['Demand management', 'Transit, carpooling, staggered work hours and remote days reduce cars at the peak. Once the network is saturated this is the lever with the biggest effect, and signals alone cannot match it.'],
      ['What the model leaves out', 'Two-phase signals, single lane per direction, no turn conflicts, pedestrians, buses, or rerouting. Drivers do not avoid jams or react to apps. Results show direction and rough size only.', true],
    ],
  };

  // ------------------------------------------------------------ app state
  const S = {
    mode: 'highway', sim: null, playing: true, speed: 2, ema: {}, base: null, diag: null, diagRun: 0,
    hits: [], lastChart: 0, rampPulse: 0,
  };
  const DT = { highway: 0.2, city: 0.25 };

  function makeSim(mode, params) {
    const seed = (Math.random() * 1e6) | 0;
    const sim = mode === 'highway' ? new Highway(params, seed) : new City(params, seed);
    const dt = DT[mode], pre = mode === 'highway' ? 200 : 300;
    for (let t = 0; t < pre; t += dt) sim.step(dt);
    return sim;
  }

  function params() { return Object.assign({}, S.sim.p); }

  function resetSim(over) {
    const base = over ? (S.mode === 'highway' ? Object.assign({}, window.HighwaySim.DEFAULTS) : Object.assign({}, window.CitySim.DEFAULTS)) : params();
    const extra = over || {};
    const p = Object.assign(base, extra);
    const rb = p.randomBlocks; delete p.randomBlocks;
    if (S.mode === 'city' && !over) p.blocks = S.sim.links.filter((l) => l.block !== null).map((l) => [l.id, l.block]);
    S.sim = makeSim(S.mode, p);
    if (rb) S.sim.randomBlocks(rb);
    S.ema = {}; clearDiag(); refreshControls(); updateHint();
  }

  // --------------------------------------------------------------- controls
  const ctlEls = {};
  function buildControls() {
    for (const k of Object.keys(ctlEls)) delete ctlEls[k];
    const spec = S.mode === 'highway' ? HW : CITY;
    for (const [host, list] of [[$('#causes'), spec.causes], [$('#fixes'), spec.fixes]]) {
      host.innerHTML = '';
      for (const c of list) host.appendChild(buildControl(c));
    }
    refreshControls();
  }

  function buildControl(c) {
    const w = document.createElement('div');
    w.className = 'ctl' + (c.type === 'toggle' ? ' toggle' : '');
    const id = 'ctl-' + c.key;
    const tip = `<div class="tip">${c.tip || ''}</div>`;
    if (c.type === 'toggle') {
      w.innerHTML = `<label class="row" for="${id}"><span>${c.label}</span><input type="checkbox" id="${id}"></label>${tip}`;
      w.querySelector('input').addEventListener('change', (e) => setParam(c.key, e.target.checked));
    } else if (c.type === 'seg') {
      w.innerHTML = `<div class="row"><span>${c.label}</span></div><div class="seg">${c.opts.map(([v, n]) =>
        `<button class="btn sm" data-v="${v}">${n}</button>`).join('')}</div>${tip}`;
      w.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setParam(c.key, b.dataset.v)));
    } else if (c.type === 'blocks') {
      w.innerHTML = `<div class="row"><span>${c.label}</span><span class="val" id="${id}-v"></span></div>
        <div class="acts"><button class="btn sm" data-a="add">+ 4 random</button><button class="btn sm" data-a="clear">Clear</button></div>${tip}`;
      w.querySelector('[data-a=add]').addEventListener('click', () => { S.sim.randomBlocks(4); refreshControls(); clearDiag(); });
      w.querySelector('[data-a=clear]').addEventListener('click', () => { S.sim.clearBlocks(); refreshControls(); clearDiag(); });
    } else {
      w.innerHTML = `<label class="row" for="${id}"><span>${c.label}</span><span class="val" id="${id}-v"></span></label>
        <input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${tip}`;
      w.querySelector('input').addEventListener('input', (e) => setParam(c.key, c.pct ? +e.target.value / 100 : +e.target.value));
    }
    ctlEls[c.key] = { spec: c, el: w };
    return w;
  }

  function refreshControls() {
    const p = S.sim.p;
    for (const { spec: c, el } of Object.values(ctlEls)) {
      const v = p[c.key];
      if (c.type === 'toggle') el.querySelector('input').checked = !!v;
      else if (c.type === 'seg') el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      else if (c.type === 'blocks') el.querySelector('.val').textContent = S.sim.disruptionCount();
      else {
        const x = c.pct ? Math.round(v * 100) : Math.round(v * 100) / 100;
        el.querySelector('input').value = x;
        el.querySelector('.val').textContent = c.fmt(c.key === 'density' ? Math.round(v) : x);
      }
      if (c.dep) el.classList.toggle('disabled', !p[c.dep]);
    }
  }

  function setParam(key, val) {
    const sim = S.sim;
    if (S.mode === 'highway' && key === 'lanes') {
      const total = Math.round(sim.p.density * sim.p.lanes * sim.p.L / 1000);
      const p = params();
      p.lanes = val; p.density = total / (val * p.L / 1000);
      S.sim = makeSim('highway', p);
      S.ema = {};
    } else sim.set(key, val);
    clearDiag(); refreshControls();
  }

  function buildPresets() {
    const host = $('#presets'); host.innerHTML = '';
    for (const pr of PRESETS[S.mode]) {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.textContent = pr.name;
      b.addEventListener('click', () => { S.base = null; renderBaseline(); resetSim(Object.assign({}, pr.p)); });
      host.appendChild(b);
    }
  }

  function updateHint() {
    $('#hint').textContent = S.mode === 'highway'
      ? 'Click a car to make it brake hard'
      : 'Click a street to add or remove a disruption';
  }

  // ------------------------------------------------------------------ KPIs
  function buildKpis() {
    const host = $('#kpis'); host.innerHTML = '';
    for (const k of KPIS[S.mode]) {
      const d = document.createElement('div');
      d.className = 'kpi'; d.id = 'kpi-' + k.id;
      d.innerHTML = `<div class="l">${k.label}</div><div class="v"><span class="n">–</span> <small>${k.unit}</small></div><div class="d"></div>`;
      host.appendChild(d);
    }
  }

  function updateKpis(dtSim) {
    const a = 1 - Math.exp(-dtSim / 8);
    for (const k of KPIS[S.mode]) {
      const raw = k.get(S.sim);
      S.ema[k.id] = S.ema[k.id] === undefined ? raw : S.ema[k.id] + (raw - S.ema[k.id]) * a;
    }
  }

  function renderKpis() {
    for (const k of KPIS[S.mode]) {
      const el = $('#kpi-' + k.id); if (!el) continue;
      const v = S.ema[k.id];
      if (v === undefined) continue;
      el.querySelector('.n').textContent = k.fmt(v);
      const d = el.querySelector('.d');
      if (S.base && S.base[k.id] !== undefined) {
        const b = S.base[k.id], diff = v - b;
        const rel = Math.abs(b) < 1e-6 ? 0 : diff / Math.abs(b) * 100;
        if (Math.abs(rel) < 1) { d.textContent = 'same as baseline'; d.className = 'd'; }
        else {
          const good = diff * k.better > 0;
          d.textContent = `${diff > 0 ? '▲' : '▼'} ${Math.abs(rel).toFixed(0)}% vs baseline`;
          d.className = 'd ' + (good ? 'up' : 'down');
        }
      } else if (k.sub) { d.textContent = k.sub(S.sim, v); d.className = 'd muted'; }
      else { d.textContent = ''; d.className = 'd'; }
    }
  }

  function renderBaseline() {
    $('#unpin').hidden = !S.base;
    $('#pin-note').textContent = S.base ? 'Tiles show change against it.' : 'Pin a state, change a setting, compare.';
  }

  // ---------------------------------------------------------------- banner
  function updateBanner() {
    const s = S.sim, st = s.stats;
    let level, text;
    if (S.mode === 'highway') {
      const r = st.meanV / s.v0;
      if (s.p.incident && st.jam > 0.1) { level = 'jam'; text = 'Bottleneck: the blocked lane forces a merge and a queue grows upstream.'; }
      else if (r > 0.85) { level = 'free'; text = 'Free flow: cars move near the speed limit.'; }
      else if (st.jam > 0.04) { level = 'jam'; text = 'Stop-and-go waves: small braking events are amplified and drift backwards.'; }
      else if (r > 0.5) { level = 'dense'; text = 'Dense traffic: close to the point where a small disturbance becomes a jam.'; }
      else { level = 'jam'; text = 'Saturated: too many cars for the road, speeds are low everywhere.'; }
      if (st.rampQ > 12) text += ` Ramp queue: ${Math.round(st.rampQ)} cars.`;
    } else {
      const r = st.eff / VFREE;
      if (st.n > 40 && st.speed < 0.8) { level = 'gridlock'; text = 'Gridlock: queues have locked the junctions.'; }
      else if (r > 0.65) { level = 'free'; text = 'Moving well: most cars catch green lights.'; }
      else if (r > 0.4) { level = 'dense'; text = 'Stop-start driving: queues form at every red.'; }
      else { level = 'jam'; text = 'Congested: queues spill back through junctions.'; }
      if (st.backlog > 20) text += ` ${st.backlog} cars cannot even enter the network.`;
      if (s.disruptionCount() && r < 0.65) text += ' Curbside disruptions add friction.';
    }
    $('#banner').dataset.level = level;
    $('#banner-text').textContent = text;
  }

  // -------------------------------------------------------------- canvases
  function fit(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ----- highway rendering
  function hwGeom(w, h, lanes) {
    const lw = Math.max(8, Math.min(13, h / 36));
    const half = lanes * lw / 2 + 8;
    let R = (h - 2 * (half + 16 + 75)) / 2;
    R = Math.max(50, Math.min(R, w * 0.2));
    const S2 = Math.max(60, w - 2 * (R + half + 70));
    return { lw, half, R, S: S2, cx: w / 2, cy: h / 2, total: 2 * S2 + 2 * Math.PI * R };
  }

  function stadium(g, u, off) {
    const { S: S2, R, cx, cy } = g;
    const s = (((u % 1) + 1) % 1) * g.total;
    let x, y, dx, dy;
    if (s < S2) { x = cx - S2 / 2 + s; y = cy + R; dx = 1; dy = 0; }
    else if (s < S2 + Math.PI * R) {
      const th = Math.PI / 2 - (s - S2) / R;
      x = cx + S2 / 2 + R * Math.cos(th); y = cy + R * Math.sin(th); dx = Math.sin(th); dy = -Math.cos(th);
    } else if (s < 2 * S2 + Math.PI * R) { const q = s - S2 - Math.PI * R; x = cx + S2 / 2 - q; y = cy - R; dx = -1; dy = 0; }
    else {
      const q = s - 2 * S2 - Math.PI * R, th = -Math.PI / 2 - q / R;
      x = cx - S2 / 2 + R * Math.cos(th); y = cy + R * Math.sin(th); dx = Math.sin(th); dy = -Math.cos(th);
    }
    return { x: x - dy * off, y: y + dx * off, ang: Math.atan2(dy, dx), dx, dy };
  }

  function tracePath(ctx, g, off) {
    const { S: S2, R, cx, cy } = g;
    ctx.moveTo(cx - S2 / 2, cy + R + off);
    ctx.lineTo(cx + S2 / 2, cy + R + off);
    ctx.arc(cx + S2 / 2, cy, R + off, Math.PI / 2, -Math.PI / 2, true);
    ctx.lineTo(cx - S2 / 2, cy - R - off);
    ctx.arc(cx - S2 / 2, cy, R + off, -Math.PI / 2, -3 * Math.PI / 2, true);
    ctx.closePath();
  }

  function bez(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  }

  function drawCar(ctx, x, y, ang, len, wid, fill, stroke) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = fill; ctx.fillRect(-len / 2, -wid / 2, len, wid);
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.strokeRect(-len / 2, -wid / 2, len, wid); }
    ctx.restore();
  }

  function drawHighway() {
    const sim = S.sim, p = sim.p, cv = $('#stage');
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const g = hwGeom(w, h, p.lanes), lw = g.lw, half = p.lanes * lw / 2;
    // road
    ctx.beginPath(); tracePath(ctx, g, half + 2); tracePath(ctx, g, -half - 2);
    ctx.fillStyle = C.road; ctx.fill('evenodd');
    ctx.lineWidth = 2; ctx.strokeStyle = C['road-edge'];
    ctx.beginPath(); tracePath(ctx, g, half + 2); ctx.stroke();
    ctx.beginPath(); tracePath(ctx, g, -half - 2); ctx.stroke();
    ctx.setLineDash([8, 10]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.35)';
    for (let k = 1; k < p.lanes; k++) { ctx.beginPath(); tracePath(ctx, g, (p.lanes / 2 - k) * lw); ctx.stroke(); }
    ctx.setLineDash([]);

    // ramps
    const onU = sim.onX / p.L, offU = sim.offX / p.L;
    const edge = half + 2;
    const pOn = stadium(g, onU, edge), pOff = stadium(g, offU, edge);
    const nx = (q) => -q.dy, ny = (q) => q.dx;
    const rampW = lw + 2;
    const on0 = [pOn.x + nx(pOn) * 38 - pOn.dx * 70, pOn.y + ny(pOn) * 38 - pOn.dy * 70];
    const on1 = [on0[0] + pOn.dx * 55, on0[1] + pOn.dy * 55];
    const on2 = [pOn.x - pOn.dx * 55, pOn.y - pOn.dy * 55];
    const on3 = [pOn.x, pOn.y];
    const of0 = [pOff.x, pOff.y];
    const of1 = [pOff.x + pOff.dx * 55, pOff.y + pOff.dy * 55];
    const of3 = [pOff.x + nx(pOff) * 38 + pOff.dx * 70, pOff.y + ny(pOff) * 38 + pOff.dy * 70];
    const of2 = [of3[0] - pOff.dx * 55, of3[1] - pOff.dy * 55];
    ctx.lineCap = 'butt'; ctx.lineWidth = rampW; ctx.strokeStyle = C.road;
    ctx.beginPath(); ctx.moveTo(...on0); ctx.bezierCurveTo(...on1, ...on2, ...on3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(...of0); ctx.bezierCurveTo(...of1, ...of2, ...of3); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('on-ramp', on0[0], on0[1] - 10);
    ctx.fillText('exit', of3[0], of3[1] + 16);
    // ramp queue
    const q = Math.min(14, Math.floor(sim.stats.rampQ + 0.5));
    for (let i = 0; i < q; i++) {
      const t = Math.max(0.02, 1 - (i + 0.8) * 9 / 135);
      const [x, y] = bez(on0, on1, on2, on3, t);
      const [x2, y2] = bez(on0, on1, on2, on3, Math.min(1, t + 0.02));
      drawCar(ctx, x, y, Math.atan2(y2 - y, x2 - x), 8, 4.5, speedColor(0.05 + (i === 0 ? 0.3 : 0)), null);
    }
    if (sim.stats.rampQ >= 1) {
      ctx.fillStyle = C.warn; ctx.fillText(`${Math.round(sim.stats.rampQ)} waiting`, on0[0], on0[1] + 18);
    }

    // speed-limit gantries
    if (p.vsl) {
      for (const k of [0, 3, 5, 8]) {
        const u = (k + 0.5) / 10, q2 = stadium(g, u, -half - 22);
        const lim = Math.round(sim.segLimit[k] * 3.6 / 5) * 5;
        ctx.beginPath(); ctx.arc(q2.x, q2.y, 11, 0, 7);
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#e53935'; ctx.stroke();
        ctx.fillStyle = '#111'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(lim, q2.x, q2.y + 0.5); ctx.textBaseline = 'alphabetic';
      }
    }

    // cars
    const pxm = g.total / p.L, len = 4.5 * pxm, wid = lw * 0.55;
    S.hits = [];
    for (const c of sim.cars) {
      const off = ((p.lanes - 1) / 2 - c.lane) * lw;
      const q2 = stadium(g, c.x / p.L, off);
      if (c.isObs) {
        drawCar(ctx, q2.x, q2.y, q2.ang, len + 2, wid + 1, '#8a1c1c', '#ffd24a');
        continue;
      }
      drawCar(ctx, q2.x, q2.y, q2.ang, len, wid, speedColor(c.v / (sim.v0 * 1.05)), c.type === 'c' ? '#7fd4ff' : null);
      S.hits.push([q2.x, q2.y, c]);
      if (sim.t < c.brakeUntil && c.brakeA <= -3.9) {
        ctx.beginPath(); ctx.arc(q2.x, q2.y, 9, 0, 7); ctx.strokeStyle = C.bad; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
    if (sim.obstacle) {
      const q2 = stadium(g, sim.incX / p.L, half + 14);
      ctx.fillStyle = '#ffd24a'; ctx.beginPath();
      ctx.moveTo(q2.x, q2.y - 9); ctx.lineTo(q2.x + 9, q2.y + 7); ctx.lineTo(q2.x - 9, q2.y + 7); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('!', q2.x, q2.y + 5);
    }
    // centre label
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.font = '12px system-ui';
    ctx.fillText(`${p.lanes}-lane loop, ${p.L} m, ${sim.stats.n} cars`, w / 2, h / 2 - 6);
    ctx.fillText(`${sim.stats.density.toFixed(0)} veh/km/lane`, w / 2, h / 2 + 12);
    if (p.cacc > 0) { ctx.fillStyle = '#7fd4ff'; ctx.fillText('cyan outline = automated', w / 2, h / 2 + 30); }
  }

  // ----- city rendering
  const DIRV = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const BOX = 7; // metres of junction box on each side
  function cityView(w, h) {
    const c = S.sim, B = c.p.block, G = c.p.gate;
    const ww = (c.p.cols - 1) * B + 2 * G, hh = (c.p.rows - 1) * B + 2 * G;
    const sc = Math.min((w - 30) / ww, (h - 30) / hh);
    return { sc, ox: (w - ww * sc) / 2 + G * sc, oy: (h - hh * sc) / 2 + G * sc };
  }
  function linkPos(l, s, lat) {
    const d = DIRV[l.dir], sp = BOX + s * (l.len - 2 * BOX) / l.len;
    return [l.a.x + d[0] * sp - d[1] * lat, l.a.y + d[1] * sp + d[0] * lat];
  }

  function drawCity() {
    const sim = S.sim, cv = $('#stage');
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const V = cityView(w, h), sc = V.sc;
    const X = (x) => V.ox + x * sc, Y = (y) => V.oy + y * sc;
    // roads
    ctx.lineCap = 'butt';
    ctx.strokeStyle = C.road; ctx.lineWidth = 14 * sc;
    for (const l of sim.links) {
      if (l.dir > 1) continue;
      ctx.beginPath(); ctx.moveTo(X(l.a.x), Y(l.a.y)); ctx.lineTo(X(l.b.x), Y(l.b.y)); ctx.stroke();
    }
    ctx.setLineDash([6 * sc, 8 * sc]); ctx.strokeStyle = 'rgba(255,214,102,.45)'; ctx.lineWidth = 1;
    for (const l of sim.links) {
      if (l.dir > 1) continue;
      ctx.beginPath(); ctx.moveTo(X(l.a.x), Y(l.a.y)); ctx.lineTo(X(l.b.x), Y(l.b.y)); ctx.stroke();
    }
    ctx.setLineDash([]);
    // signals at stop lines
    for (const n of sim.interior) {
      for (const l of n.inLinks) {
        const d = DIRV[l.dir], st = n.st[l.group];
        const bx = n.x - d[0] * BOX, by = n.y - d[1] * BOX;
        const cx = bx - d[1] * 3, cy = by + d[0] * 3;
        ctx.fillStyle = st === 2 ? '#37e08a' : st === 1 ? '#ffc233' : '#ff4d4d';
        ctx.save(); ctx.translate(X(cx), Y(cy)); ctx.rotate(Math.atan2(d[1], d[0]));
        ctx.fillRect(-1.8 * sc, -3.5 * sc, 3.6 * sc, 7 * sc); ctx.restore();
      }
    }
    // disruptions
    for (const l of sim.links) {
      if (l.block === null) continue;
      const [x, y] = linkPos(l, l.block, 6.2);
      ctx.save(); ctx.translate(X(x), Y(y)); ctx.rotate(Math.atan2(DIRV[l.dir][1], DIRV[l.dir][0]));
      ctx.fillStyle = '#ff9f1c'; ctx.fillRect(-4.5 * sc, -2 * sc, 9 * sc, 4 * sc);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.strokeRect(-4.5 * sc, -2 * sc, 9 * sc, 4 * sc);
      ctx.restore();
    }
    // cars
    const cl = 8 * sc, cw = 4 * sc;
    for (const l of sim.links) {
      const ang = Math.atan2(DIRV[l.dir][1], DIRV[l.dir][0]);
      for (const c of l.cars) {
        const [x, y] = linkPos(l, c.s, 3);
        drawCar(ctx, X(x), Y(y), ang, cl, cw, speedColor(c.v / (VFREE * 0.9)), c.wander > 0 ? '#c77dff' : null);
      }
    }
    // queued-outside badges
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const g of sim.gates) {
      if (g.backlog < 1) continue;
      const x = X(g.x), y = Y(g.y);
      ctx.fillStyle = C.warn; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillText(g.backlog, x, y + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function canvasPoint(e) {
    const r = $('#stage').getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  $('#stage').addEventListener('click', (e) => {
    const [mx, my] = canvasPoint(e);
    if (S.mode === 'highway') {
      let best = null, bd = 18 * 18;
      for (const [x, y, c] of S.hits) {
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      if (best) S.sim.brakeCar(best);
    } else {
      const { w, h } = fit($('#stage'));
      const V = cityView(w, h);
      let best = null, bd = 12;
      for (const l of S.sim.links) {
        if (l.a.gate || l.b.gate) continue;
        const [x0, y0] = linkPos(l, 0, 3), [x1, y1] = linkPos(l, l.len, 3);
        const ax = V.ox + x0 * V.sc, ay = V.oy + y0 * V.sc, bx = V.ox + x1 * V.sc, by = V.oy + y1 * V.sc;
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(ax + t * dx - mx, ay + t * dy - my);
        if (d < bd) { bd = d; best = [l, t * l.len]; }
      }
      if (best) { S.sim.toggleBlock(best[0], best[1]); refreshControls(); clearDiag(); }
    }
  });

  // ---------------------------------------------------------------- charts
  function axes(ctx, w, h, m) {
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, h - m.b); ctx.lineTo(w - m.r, h - m.b); ctx.stroke();
  }

  function lineChart(cv, series, o) {
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const m = { l: 34, r: 8, t: 8, b: 18 };
    axes(ctx, w, h, m);
    const n = Math.max(...series.map((s) => s.data.length), 0);
    if (n < 2) return;
    let ymax = o.ymax;
    if (!ymax) ymax = Math.max(1, ...series.flatMap((s) => s.data)) * 1.1;
    ctx.font = '10px system-ui'; ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) {
      const y = h - m.b - (h - m.t - m.b) * i / 2;
      ctx.fillText(Math.round(ymax * i / 2), m.l - 4, y + 3);
      if (i) { ctx.strokeStyle = C.line; ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    ctx.textAlign = 'left'; ctx.fillText('older', m.l, h - 4); ctx.textAlign = 'right'; ctx.fillText('now', w - m.r, h - 4);
    series.forEach((s) => {
      ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      s.data.forEach((v, i) => {
        const px = m.l + (w - m.l - m.r) * (i + (n - s.data.length)) / (n - 1);
        const y = h - m.b - (h - m.t - m.b) * Math.min(1, v / ymax);
        if (i) ctx.lineTo(px, y); else ctx.moveTo(px, y);
      });
      ctx.stroke();
    });
    if (o.legend) {
      ctx.textAlign = 'left';
      series.forEach((s, i) => { ctx.fillStyle = s.color; ctx.fillText('— ' + s.label, m.l + 8 + i * 90, m.t + 10); });
    }
  }

  const wavePix = document.createElement('canvas');
  function spaceTime(cv) {
    const sim = S.sim, { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const m = { l: 34, r: 8, t: 8, b: 18 };
    axes(ctx, w, h, m);
    const rows = sim.wave.length;
    if (rows < 2) return;
    wavePix.width = rows; wavePix.height = WBINS;
    const px = wavePix.getContext('2d'), img = px.createImageData(rows, WBINS);
    for (let x = 0; x < rows; x++) {
      for (let k = 0; k < WBINS; k++) {
        const v = sim.wave[x][k], y = WBINS - 1 - k, i = (y * rows + x) * 4;
        let r = 40, g = 46, b = 56;
        if (v >= 0) {
          const col = speedColor(v / sim.v0).match(/\d+/g).map(Number);
          [r, g, b] = col;
        }
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    px.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const aw = w - m.l - m.r, ah = h - m.t - m.b;
    ctx.drawImage(wavePix, m.l + aw * (1 - rows / 240), m.t, aw * rows / 240, ah);
    ctx.fillStyle = C.muted; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
    ctx.fillText('1 km', m.l - 4, m.t + 8); ctx.fillText('0', m.l - 4, h - m.b);
    ctx.textAlign = 'left'; ctx.fillText('4 min ago', m.l, h - 4); ctx.textAlign = 'right'; ctx.fillText('now', w - m.r, h - 4);
    if (sim.p.incident) {
      const y = m.t + ah * (1 - sim.incX / sim.p.L);
      ctx.strokeStyle = '#ffd24a'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function scatter(cv) {
    const sim = S.sim, { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h);
    const m = { l: 34, r: 8, t: 8, b: 18 };
    axes(ctx, w, h, m);
    const xmax = 60, ymax = 2400, aw = w - m.l - m.r, ah = h - m.t - m.b;
    ctx.font = '10px system-ui'; ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) ctx.fillText(Math.round(ymax * i / 2), m.l - 4, h - m.b - ah * i / 2 + 3);
    ctx.textAlign = 'center';
    for (let i = 0; i <= 3; i++) ctx.fillText(Math.round(xmax * i / 3), m.l + aw * i / 3, h - 4);
    sim.scatter.forEach(([d, q], i, a) => {
      ctx.globalAlpha = 0.15 + 0.85 * (i / a.length);
      ctx.fillStyle = C.accent;
      ctx.beginPath(); ctx.arc(m.l + aw * Math.min(1, d / xmax), h - m.b - ah * Math.min(1, q / ymax), i === a.length - 1 ? 4 : 2.4, 0, 7); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawCharts() {
    const sim = S.sim;
    if (S.mode === 'highway') {
      lineChart($('#c1'), [{ data: sim.hist.map((x) => x.v * 3.6), color: C.accent }], { ymax: sim.v0 * 3.6 * 1.05 });
      spaceTime($('#c2'));
      scatter($('#c3'));
    } else {
      const k = VFREE * 3.6;
      lineChart($('#c1'), [{ data: sim.hist.map((x) => x.ratio * k), color: C.accent }], { ymax: k });
      lineChart($('#c2'), [
        { data: sim.hist.map((x) => x.n), color: C.accent, label: 'on streets' },
        { data: sim.hist.map((x) => x.backlog), color: C.warn, label: 'waiting to enter' },
      ], { legend: true });
      lineChart($('#c3'), [{ data: sim.hist.map((x) => x.idle * 100), color: C.bad }], { ymax: 100 });
    }
  }

  function setChartTitles() {
    const t = S.mode === 'highway'
      ? ['Average speed (km/h)', 'Space-time: speed along the road (bands slanting down = jam moving backwards)', 'Flow vs density per lane (the capacity drop)']
      : ['Network speed of moving cars (km/h)', 'Cars on streets and waiting to enter', 'Idling share (%)'];
    ['c1t', 'c2t', 'c3t'].forEach((id, i) => { $('#' + id).textContent = t[i]; });
  }

  // ------------------------------------------------------------- diagnosis
  function clearDiag() { S.diagRun++; S.diag = null; $('#diag-out').innerHTML = ''; $('#diag').disabled = false; }

  function hwVariants(p) {
    const v = [];
    const add = (name, tag, ch) => v.push({ name, tag, set: ch, p: Object.assign({}, p, ch) });
    if (p.noise > 0) add('No random braking', 'cause', { noise: 0 });
    if (p.rampRate > 0) add('No ramp traffic', 'cause', { rampRate: 0 });
    if (p.incident) add('Clear the breakdown', 'cause', { incident: false });
    if (p.laneChange) add('No lane changing', 'cause', { laneChange: false });
    if (p.lanes < 5) {
      const total = p.density * p.lanes;
      add('Add a lane (same cars)', 'fix', { lanes: p.lanes + 1, density: total / (p.lanes + 1) });
    }
    if (p.cacc < 0.3) add('30% automated cars', 'fix', { cacc: 0.3 });
    if (!p.vsl) add('Variable speed limits', 'fix', { vsl: true });
    if (p.rampRate > 0 && !p.metering) add('Ramp metering', 'fix', { metering: true });
    add('15% fewer cars', 'fix', { density: p.density * 0.85 });
    if (p.limit > 90) add('90 km/h limit', 'fix', { limit: 90 });
    if (p.headway < 1.9) add('2 s following gap', 'fix', { headway: 2 });
    return v;
  }

  function cityVariants(p) {
    const v = [];
    const add = (name, tag, ch) => v.push({ name, tag, set: ch, p: Object.assign({}, p, ch) });
    if (p.cruising > 0) add('No cruising for parking', 'cause', { cruising: 0 });
    if (p.blocks && p.blocks.length) add('Clear curbside disruptions', 'cause', { blocks: [], _clear: true });
    if (p.signal !== 'adaptive') add('Adaptive signals', 'fix', { signal: 'adaptive' });
    if (p.signal !== 'sync') add('Green-wave coordination', 'fix', { signal: 'sync' });
    if (p.cycle > 55) add('Shorter cycle (50 s)', 'fix', { cycle: 50 });
    add('20% shift to transit/bike', 'fix', { transit: Math.min(0.6, p.transit + 0.2) });
    add('15% staggered / remote', 'fix', { flex: Math.min(0.5, p.flex + 0.15) });
    return v;
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function runDiagnosis() {
    const id = ++S.diagRun;
    const btn = $('#diag'); btn.disabled = true;
    const out = $('#diag-out');
    const mode = S.mode;
    const p0 = params();
    if (mode === 'city') p0.blocks = S.sim.links.filter((l) => l.block !== null).map((l) => [l.id, l.block]);
    const variants = mode === 'highway' ? hwVariants(p0) : cityVariants(p0);
    const seeds = mode === 'highway' ? [11, 12, 13, 14] : [21, 22, 23, 24, 25];
    const run = (pp, seed) => (mode === 'highway' ? runHighway(pp, 240, 90, seed) : runCity(pp, 420, 150, seed));
    out.innerHTML = '<div class="progress"><i></i></div>';
    const bar = out.querySelector('.progress i');
    const avg = (pp) => {
      let sp = 0, fl = 0, q = 0;
      for (const sd of seeds) { const r = run(pp, sd); sp += r.speed; fl += r.flow || r.tpm || 0; q += r.rampQ || r.backlog || 0; }
      return { speed: sp / seeds.length, flow: fl / seeds.length, queue: q / seeds.length };
    };
    await tick();
    const base = avg(p0);
    const results = [];
    for (let i = 0; i < variants.length; i++) {
      bar.style.width = `${(i + 1) / (variants.length + 1) * 100}%`;
      await tick();
      if (id !== S.diagRun) return;
      const vr = variants[i];
      const r = avg(vr.p);
      results.push({ vr, gain: r.speed - base.speed, rel: (r.speed - base.speed) / Math.max(base.speed, 1) * 100, r });
    }
    if (id !== S.diagRun) return;
    results.sort((a, b) => b.gain - a.gain);
    S.diag = results;
    renderDiag(base, mode);
    btn.disabled = false;
  }

  function renderDiag(base, mode) {
    const out = $('#diag-out');
    const maxAbs = Math.max(1, ...S.diag.map((x) => Math.abs(x.gain)));
    const unit = mode === 'highway' ? 'veh/h' : 'trips/min';
    out.innerHTML = `<div class="muted">Baseline: ${base.speed.toFixed(0)} km/h average.${mode === 'city' && base.queue > 5 ? ` ~${Math.round(base.queue)} cars stuck outside.` : ''}</div>`;
    S.diag.forEach((x, i) => {
      const row = document.createElement('div'); row.className = 'drow';
      const neg = x.gain < 0;
      const flowD = x.r.flow - base.flow;
      row.innerHTML = `<div class="name"><b>${x.vr.name}</b><span class="tag">${x.vr.tag === 'cause' ? 'removes a cause' : 'fix'}</span></div>
        <div class="gain ${neg ? 'neg' : ''}">${neg ? '' : '+'}${x.gain.toFixed(1)} km/h <span class="muted">(${neg ? '' : '+'}${x.rel.toFixed(0)}%)</span></div>
        <div class="bar"><i class="${neg ? 'neg' : ''}" style="width:${Math.abs(x.gain) / maxAbs * 100}%"></i></div>
        <div class="muted" style="grid-column:1/-1">${unit} ${flowD >= 0 ? '+' : ''}${Math.round(flowD)}${neg ? ' · this makes it worse' : ''}
          <button class="btn sm" style="margin-left:6px">Apply</button></div>`;
      row.querySelector('button').addEventListener('click', () => applyVariant(x.vr));
      out.appendChild(row);
    });
  }

  function applyVariant(vr) {
    const ch = Object.assign({}, vr.set);
    if (S.mode === 'city' && ch._clear) { S.sim.clearBlocks(); delete ch._clear; delete ch.blocks; }
    if (S.mode === 'highway' && ch.lanes) {
      const p = params(); Object.assign(p, ch);
      S.sim = makeSim('highway', p); S.ema = {};
    } else for (const [k, v] of Object.entries(ch)) S.sim.set(k, v);
    refreshControls();
    $('#diag-out').insertAdjacentHTML('afterbegin', `<div class="muted">Applied: ${vr.name}. Re-run to rank again.</div>`);
  }

  // ----------------------------------------------------------- explain text
  function buildExplain() {
    const host = $('#explain');
    host.innerHTML = `<h2>${S.mode === 'highway' ? 'Why highways jam' : 'Why city streets jam'}</h2>` +
      EXPLAIN[S.mode].map(([t, b, lim]) => `<div class="card${lim ? ' limit' : ''}"><h3>${t}</h3><p>${b}</p></div>`).join('');
  }

  // ------------------------------------------------------------- mode/loop
  function setMode(mode) {
    S.mode = mode;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    S.base = null; renderBaseline();
    S.sim = makeSim(mode, {});
    S.ema = {}; clearDiag();
    buildControls(); buildPresets(); buildKpis(); buildExplain(); setChartTitles(); updateHint();
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    S.speed = +b.dataset.speed;
    document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#play').addEventListener('click', () => {
    S.playing = !S.playing; $('#play').textContent = S.playing ? 'Pause' : 'Play';
  });
  $('#reset').addEventListener('click', () => { resetSim(null); });
  $('#diag').addEventListener('click', runDiagnosis);
  $('#pin').addEventListener('click', () => { S.base = Object.assign({}, S.ema); renderBaseline(); });
  $('#unpin').addEventListener('click', () => { S.base = null; renderBaseline(); });

  let last = performance.now(), acc = 0;
  function frame(now) {
    const real = Math.min(0.1, (now - last) / 1000); last = now;
    const sim = S.sim, dt = DT[S.mode];
    if (S.playing && !document.hidden) {
      acc += real * S.speed;
      let n = 0;
      while (acc >= dt && n < 60) { sim.step(dt); acc -= dt; n++; }
      if (n === 60) acc = 0;
      if (n) updateKpis(n * dt);
    }
    if (S.mode === 'highway') drawHighway(); else drawCity();
    if (now - S.lastChart > 250) {
      S.lastChart = now; renderKpis(); updateBanner(); drawCharts();
    }
    requestAnimationFrame(frame);
  }

  document.querySelector('[data-speed="2"]').classList.add('on');
  setMode('highway');
  renderBaseline();
  requestAnimationFrame(frame);
})();
