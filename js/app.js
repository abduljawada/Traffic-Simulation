'use strict';
(function () {
  const MM = window.MetroMap, NS = window.NetSim;
  const { Renderer, speedColor } = window.MetroRender;
  const { Net, runNet } = NS;
  const $ = (s) => document.querySelector(s);

  // ------------------------------------------------------------- theme
  const C = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['panel', 'line', 'text', 'muted', 'accent', 'good', 'warn', 'bad']) C[k] = cs.getPropertyValue('--' + k).trim();
    const explicit = document.documentElement.dataset.theme;
    const light = explicit ? explicit === 'light' : matchMedia('(prefers-color-scheme: light)').matches;
    if (S && S.rend) S.rend.setTheme(light ? 'light' : 'dark');
    return light ? 'light' : 'dark';
  }

  // ------------------------------------------------------------- labels
  const AV = MM.AVENUES, IX = MM.INTERCHANGES;
  const ART_NAMES = { 650: 'Market St', 1400: 'Harbor Rd', 2550: 'Eastside Blvd' };
  const AVE_NAMES = { 520: '1st Avenue', 760: '2nd Avenue', 1000: '3rd Avenue' };
  const near = (arr, v) => arr.reduce((b, x) => (Math.abs(x - v) < Math.abs(b - v) ? x : b), arr[0]);
  function linkLabel(L) {
    const mx = (L.pts[0][0] + L.pts[L.pts.length - 1][0]) / 2, my = (L.pts[0][1] + L.pts[L.pts.length - 1][1]) / 2;
    const dirs = Math.abs(L.h1[0]) > Math.abs(L.h1[1]) ? (L.h1[0] > 0 ? 'eastbound' : 'westbound') : (L.h1[1] > 0 ? 'southbound' : 'northbound');
    if (L.kind === 'hw') return `Highway 1 ${dirs}`;
    if (L.kind === 'ramp') return L.to.type === 'merge' ? 'On-ramp' : 'Off-ramp';
    if (L.kind === 'art') {
      if (Math.abs(L.h1[0]) > Math.abs(L.h1[1])) return `${AVE_NAMES[near(AV, my)]} ${dirs}`;
      return `${ART_NAMES[near(IX, mx)]} ${dirs}`;
    }
    return `Local street ${dirs}`;
  }
  function gateLabel(g) {
    if (g.id === 'gW') return 'the west highway gate';
    if (g.id === 'gE') return 'the east highway gate';
    if (g.id[0] === 'a') return `${AVE_NAMES[g.y]} ${g.x < 1 ? 'west' : 'east'} end`;
    if (g.id.startsWith('gN')) return `${ART_NAMES[g.x]} north end`;
    return `the south end at x=${g.x}`;
  }

  // ---------------------------------------------------------- controls
  const CAUSES = [
    { key: 'demand', label: 'Trips entering', min: 20, max: 140, step: 5, fmt: (v) => `${v} /min`, tip: 'Cars entering the map every minute. Roads jam when demand crosses capacity.' },
    { key: 'hwShare', label: 'Trips starting on the highway', min: 10, max: 70, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'The rest start on city streets. Highway trips can exit at any interchange.' },
    { key: 'tidal', label: 'Commuter tilt', min: 0, max: 100, step: 10, pct: true, fmt: (v) => `${v}%`, tip: 'How lopsided rush hour is toward the south and east. High tilt overloads a few exits.' },
    { key: 'noise', label: 'Braking noise', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), tip: 'Random over-braking and distraction: the seed of phantom jams.' },
    { key: 'headway', label: 'Following gap', min: 0.8, max: 2.5, step: 0.1, fmt: (v) => `${v.toFixed(1)} s`, tip: 'Short gaps raise capacity but leave no room for a brake tap.' },
    { key: 'trucks', label: 'Trucks', min: 0, max: 25, step: 1, pct: true, fmt: (v) => `${v}%`, tip: 'Slow, long, slow to accelerate. They form moving bottlenecks.' },
    { key: 'cruising', label: 'Cruising for parking', min: 0, max: 60, step: 5, pct: true, fmt: (v) => `${v}% of street trips`, tip: 'Purple-outlined cars circle blocks, take extra turns and U-turns.' },
    { key: 'rubber', type: 'toggle', label: 'Rubbernecking', tip: 'Drivers in open lanes slow down to look at a breakdown.' },
    { key: 'cycle', label: 'Signal cycle', min: 30, max: 150, step: 5, fmt: (v) => `${v} s`, tip: 'Long cycles mean long reds and queues that spill back.' },
    { key: 'disrupt', type: 'disrupt', label: 'Breakdowns and disruptions', tip: 'Tap any road on the map to add or remove one. Highway and avenue lanes get a stopped vehicle, small streets a slow zone.' },
  ];
  const FIXES = [
    { key: 'signal', type: 'seg', label: 'Signal control', opts: [['fixed', 'Uncoordinated'], ['sync', 'Green wave'], ['adaptive', 'Adaptive']], tip: 'Green wave favours eastbound and southbound. Adaptive reacts to queues.' },
    { key: 'reroute', type: 'toggle', label: 'Live navigation rerouting', tip: 'Drivers re-plan every 20 s around slow roads. Watch traffic spread to side streets and the highway.' },
    { key: 'metering', type: 'toggle', label: 'Ramp metering', tip: 'Holds on-ramp cars when the highway lane is busy. Moves delay onto the ramp.' },
    { key: 'vsl', type: 'toggle', label: 'Variable speed limits', tip: 'Gantries slow highway traffic before a queue so it arrives smoothly.' },
    { key: 'cacc', label: 'Connected automated cars', min: 0, max: 100, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'React to the two cars ahead, keep 0.9 s gaps, never over-brake. Cyan outline.' },
    { key: 'limit', label: 'Highway speed limit', min: 60, max: 130, step: 5, fmt: (v) => `${v} km/h`, tip: 'Lower speeds shrink shockwaves; too low wastes capacity.' },
    { key: 'transit', label: 'Shift to transit / bike / carpool', min: 0, max: 50, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Fewer cars on the same roads.' },
    { key: 'flex', label: 'Staggered hours / remote work', min: 0, max: 40, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Flattens the peak instead of widening the road.' },
  ];

  const PRESETS = [
    { name: 'Rush hour', p: {} },
    { name: 'Free flow', p: { demand: 35, noise: 0.3 } },
    { name: 'Highway crash', p: { demand: 80, hwShare: 0.5, tidal: 0.3 }, after: (n) => { const L = n.links.find((l) => l.from.id === 'DE650' && l.to.id === 'ME650'); n.toggleDisruption(L, 330); } },
    { name: 'Delivery chaos', p: { demand: 75 }, after: (n) => n.randomDisruptions(9, ['art', 'loc']) },
    { name: 'Gridlock', p: { demand: 110, cycle: 110, cruising: 0.4, tidal: 0.7 } },
    { name: 'Smart metro', p: { demand: 85, signal: 'adaptive', cycle: 60, reroute: true, metering: true, vsl: true, cacc: 0.3, transit: 0.15, cruising: 0.05 } },
  ];

  const KPIS = [
    { id: 'speed', label: 'Network speed', unit: 'km/h', better: 1, get: (n) => n.stats.eff * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'hw', label: 'Highway speed', unit: 'km/h', better: 1, get: (n) => n.stats.hwV * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'city', label: 'Street speed', unit: 'km/h', better: 1, get: (n) => n.stats.cityV * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'tpm', label: 'Trips finished', unit: '/min', better: 1, get: (n) => n.stats.tpm, fmt: (v) => v.toFixed(0) },
    { id: 'idle', label: 'Idling', unit: '%', better: -1, get: (n) => n.stats.idle * 100, fmt: (v) => v.toFixed(0) },
    { id: 'wait', label: 'Waiting to enter', unit: 'cars', better: -1, get: (n) => n.stats.backlog, fmt: (v) => v.toFixed(0) },
  ];

  const EXPLAIN = [
    ['Demand beats capacity', 'A lane moves roughly 1,800 to 2,200 vehicles an hour at best. Past a critical density each added car lowers total flow, so a road that carried traffic fine at 90% load can fall apart at 100%.'],
    ['Phantom jams', 'No crash needed. One driver over-brakes, reaction lag makes the next brake harder, and the disturbance grows into a stop-and-go wave that drifts backwards at 15 to 20 km/h. Look for slanting bands in the highway chart.'],
    ['Merging and exits', 'Ramp cars need gaps in the right lane, so on-ramps are bottlenecks below nominal capacity. Off-ramps are worse when the signal at the bottom cannot clear the queue: it backs up onto the highway and blocks every lane.'],
    ['Breakdowns', 'One blocked lane of three removes far more than a third of capacity, because everyone must change lanes at one spot. Rubbernecking in the open lanes adds to it. A stopped vehicle in an avenue lane is a double-parked truck.'],
    ['Signals, spillback and U-turns', 'Every red costs a stop and a restart. A green wave helps only the dominant direction, adaptive signals follow queues, and neither fixes demand above capacity. Left turns, U-turns and cruising for parking share the inner lane and slow everyone behind.'],
    ['Navigation', 'With rerouting on, drivers leave slow roads and use the highway or parallel streets. That evens out load, and in a saturated network can also spread a jam to roads that were fine.'],
    ['Fixes that remove the sudden brake', 'Connected cars that see two vehicles ahead, speed limits that drop before a queue, and metering that keeps the main lane just under breakdown density work by smoothing flow, not by adding road.'],
    ['What the model leaves out', 'Cars and trucks only (no buses, bikes or pedestrians), two-phase signals with no turn conflicts inside junctions, one trip purpose, no induced demand, weather or incidents beyond the ones you place. Treat results as direction and rough size, not forecasts.', true],
  ];

  // --------------------------------------------------------------- state
  const S = { net: null, rend: null, decor: null, playing: true, speed: 2, ema: {}, base: null, diagRun: 0, sel: null, lastChart: 0, ctl: {} };
  const DT = 0.2;

  function makeNet(params, after) {
    const seed = (Math.random() * 1e6) | 0;
    const net = new Net(params, seed);
    if (after) after(net);
    for (let t = 0; t < 300; t += DT) net.step(DT);
    net.hist = net.hist.slice(-90); net.wave = net.wave.slice(-90);
    return net;
  }
  function params() { const p = Object.assign({}, S.net.p); Object.assign(p, S.net.disruptions()); return p; }
  function setNet(net) {
    S.net = net; S.rend.setNet(net); S.ema = {}; S.sel = null; showSel(); clearDiag(); refreshControls();
  }
  function resetNet(preset) {
    if (preset) {
      S.base = null; renderBaseline();
      setNet(makeNet(Object.assign({}, NS.DEFAULTS, preset.p), preset.after));
    } else setNet(makeNet(params()));
  }

  // ------------------------------------------------------------ controls
  function buildControls() {
    for (const [host, list] of [[$('#causes'), CAUSES], [$('#fixes'), FIXES]]) {
      host.innerHTML = '';
      for (const c of list) host.appendChild(buildControl(c));
    }
    refreshControls();
  }

  function buildControl(c) {
    const w = document.createElement('div');
    w.className = 'ctl' + (c.type === 'toggle' ? ' toggle' : '');
    const id = 'ctl-' + c.key, tip = `<div class="tip">${c.tip || ''}</div>`;
    if (c.type === 'toggle') {
      w.innerHTML = `<label class="row" for="${id}"><span>${c.label}</span><input type="checkbox" id="${id}"></label>${tip}`;
      w.querySelector('input').addEventListener('change', (e) => setParam(c.key, e.target.checked));
    } else if (c.type === 'seg') {
      w.innerHTML = `<div class="row"><span>${c.label}</span></div><div class="seg">${c.opts.map(([v, n]) => `<button class="btn sm" data-v="${v}">${n}</button>`).join('')}</div>${tip}`;
      w.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setParam(c.key, b.dataset.v)));
    } else if (c.type === 'disrupt') {
      w.innerHTML = `<div class="row"><span>${c.label}</span><span class="val" id="${id}-v"></span></div>
        <div class="acts"><button class="btn sm" data-a="hw">+ Highway breakdown</button><button class="btn sm" data-a="st">+ 4 street disruptions</button><button class="btn sm" data-a="clear">Clear</button></div>${tip}`;
      w.querySelector('[data-a=hw]').addEventListener('click', () => {
        const cand = S.net.links.filter((l) => l.kind === 'hw' && !l.bridge && l.len > 250 && !l.obs);
        if (!cand.length) return;
        const L = cand[(Math.random() * cand.length) | 0];
        S.net.toggleDisruption(L, L.len * (0.45 + 0.3 * Math.random())); refreshControls(); clearDiag();
      });
      w.querySelector('[data-a=st]').addEventListener('click', () => { S.net.randomDisruptions(4, ['art', 'loc']); refreshControls(); clearDiag(); });
      w.querySelector('[data-a=clear]').addEventListener('click', () => { S.net.clearDisruptions(); refreshControls(); clearDiag(); });
    } else {
      w.innerHTML = `<label class="row" for="${id}"><span>${c.label}</span><span class="val" id="${id}-v"></span></label>
        <input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${tip}`;
      w.querySelector('input').addEventListener('input', (e) => setParam(c.key, c.pct ? +e.target.value / 100 : +e.target.value));
    }
    S.ctl[c.key] = { spec: c, el: w };
    return w;
  }

  function refreshControls() {
    const p = S.net.p;
    for (const { spec: c, el } of Object.values(S.ctl)) {
      const v = p[c.key];
      if (c.type === 'toggle') el.querySelector('input').checked = !!v;
      else if (c.type === 'seg') el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      else if (c.type === 'disrupt') el.querySelector('.val').textContent = S.net.countDisruptions();
      else {
        const x = c.pct ? Math.round(v * 100) : Math.round(v * 100) / 100;
        el.querySelector('input').value = x;
        el.querySelector('.val').textContent = c.fmt(x);
      }
    }
  }

  function setParam(key, val) { S.net.set(key, val); clearDiag(); refreshControls(); }

  function buildPresets() {
    const host = $('#presets'); host.innerHTML = '';
    for (const pr of PRESETS) {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.textContent = pr.name;
      b.addEventListener('click', () => resetNet(pr));
      host.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- KPIs
  function buildKpis() {
    const host = $('#kpis'); host.innerHTML = '';
    for (const k of KPIS) {
      const d = document.createElement('div');
      d.className = 'kpi'; d.id = 'kpi-' + k.id;
      d.innerHTML = `<div class="l">${k.label}</div><div class="v"><span class="n">–</span> <small>${k.unit}</small></div><div class="d"></div>`;
      host.appendChild(d);
    }
  }
  function updateKpis(dtSim) {
    const a = 1 - Math.exp(-dtSim / 10);
    for (const k of KPIS) {
      const raw = k.get(S.net);
      S.ema[k.id] = S.ema[k.id] === undefined ? raw : S.ema[k.id] + (raw - S.ema[k.id]) * a;
    }
  }
  function renderKpis() {
    for (const k of KPIS) {
      const el = $('#kpi-' + k.id), v = S.ema[k.id];
      if (!el || v === undefined) continue;
      el.querySelector('.n').textContent = k.fmt(v);
      const d = el.querySelector('.d');
      if (S.base && S.base[k.id] !== undefined) {
        const b = S.base[k.id], diff = v - b, rel = Math.abs(b) < 1e-6 ? 0 : diff / Math.abs(b) * 100;
        if (Math.abs(rel) < 1) { d.textContent = 'same as baseline'; d.className = 'd muted'; }
        else { d.textContent = `${diff > 0 ? '▲' : '▼'} ${Math.abs(rel).toFixed(0)}% vs baseline`; d.className = 'd ' + (diff * k.better > 0 ? 'up' : 'down'); }
      } else if (k.id === 'speed') { d.textContent = `${Math.round(v / (13.9 * 3.6) * 100)}% of free flow`; d.className = 'd muted'; }
      else if (k.id === 'hw') { d.textContent = `limit ${S.net.p.limit} km/h`; d.className = 'd muted'; }
      else { d.textContent = ''; d.className = 'd'; }
    }
  }
  function renderBaseline() {
    $('#unpin').hidden = !S.base;
    $('#pin-note').textContent = S.base ? 'Tiles show change against it.' : 'Pin a state, change a setting, compare.';
  }

  function updateBanner() {
    const n = S.net, st = n.stats, p = n.p;
    let level, text;
    const hwRatio = st.hwV / (p.limit / 3.6);
    if (st.n > 80 && st.eff < 1.5) { level = 'gridlock'; text = 'Gridlock: queues have locked the network.'; }
    else if (hwRatio < 0.5) { level = 'jam'; text = 'Highway congested: speeds are well below the limit and queues are backing up the ramps.'; }
    else if (st.cityV < 6.5) { level = 'jam'; text = 'Streets congested: queues at signals spill back through junctions.'; }
    else if (hwRatio < 0.75 || st.cityV < 9) { level = 'dense'; text = 'Busy: stop-start driving on some roads.'; }
    else { level = 'free'; text = 'Flowing: most cars are moving near the limit.'; }
    const spill = n.links.find((L) => L.kind === 'ramp' && L.to.type !== 'merge' && L.n >= 10 && L.ratio < 0.35);
    if (spill) text += ' An off-ramp queue is backing onto the highway.';
    const dis = n.countDisruptions();
    if (dis) text += ` ${dis} disruption${dis > 1 ? 's' : ''} on the map.`;
    if (st.backlog > 20) text += ` ${st.backlog} cars cannot enter.`;
    $('#banner').dataset.level = level;
    $('#banner-text').textContent = text;
  }

  // ----------------------------------------------------------- selection
  const TYPE_NAME = { h: 'Car', t: 'Truck', c: 'Connected car' };
  function showSel() {
    const el = $('#sel'), s = S.sel;
    if (!s) { el.hidden = true; S.rend.sel = null; return; }
    S.rend.sel = s;
    el.hidden = false;
    if (s.car) {
      const c = s.car;
      el.innerHTML = `<div class="st"><b>${TYPE_NAME[c.type] || 'Car'}</b><button class="x" aria-label="Close">×</button></div>
        <div class="muted" id="sel-info"></div><div class="acts"><button class="btn sm" data-a="brake">Hard brake for 3 s</button></div>`;
      el.querySelector('[data-a=brake]').addEventListener('click', () => { c.brakeUntil = S.net.t + 3; c.brakeA = -4.5; });
    } else {
      const L = s.link;
      const has = !!(L.obs || L.block !== null);
      const canAdd = L.kind !== 'ramp' && !(L.from.type === 'gate' && L.to.type === 'gate');
      const what = L.lanes >= 2 ? (L.kind === 'hw' ? 'breakdown' : 'double-parked vehicle') : 'slow zone';
      el.innerHTML = `<div class="st"><b>${linkLabel(L)}</b><button class="x" aria-label="Close">×</button></div>
        <div class="muted" id="sel-info"></div>
        <div class="acts">${canAdd ? `<button class="btn sm" data-a="tog">${has ? 'Remove disruption' : 'Add ' + what + ' here'}</button>` : ''}</div>`;
      const b = el.querySelector('[data-a=tog]');
      if (b) b.addEventListener('click', () => { S.net.toggleDisruption(L, s.at); refreshControls(); clearDiag(); showSel(); });
    }
    el.querySelector('.x').addEventListener('click', () => { S.sel = null; showSel(); });
    updateSelInfo();
  }
  function updateSelInfo() {
    const s = S.sel; if (!s) return;
    const el = $('#sel-info'); if (!el) return;
    if (s.car) {
      const c = s.car;
      const alive = c.link.lanesArr[c.lane] && c.link.lanesArr[c.lane].includes(c);
      if (!alive) { el.textContent = 'Left the map.'; return; }
      const dest = gateLabel(c.dest);
      const mode = c.wander > 0 ? 'Cruising for parking, then to ' + dest : 'Heading to ' + dest;
      const nm = c.next ? ({ left: 'turning left', right: 'turning right', straight: 'going straight', u: 'making a U-turn', exit: 'taking the exit', merge: 'merging' })[c.next.kind] : '';
      el.textContent = `${Math.round(c.v * 3.6)} km/h on ${linkLabel(c.link)}. ${mode}${nm ? ', next ' + nm : ''}.`;
    } else {
      const L = s.link;
      el.textContent = `${L.lanes} lane${L.lanes > 1 ? 's' : ''}, limit ${Math.round(L.vlim * 3.6)} km/h, now ${Math.round(L.vAvg * 3.6)} km/h with ${L.n} vehicle${L.n === 1 ? '' : 's'}.`;
    }
  }

  // ------------------------------------------------------- map gestures
  function setupMap() {
    const cv = $('#stage'), ptrs = new Map();
    let pinch = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY, sx: e.offsetX, sy: e.offsetY, moved: false });
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
      p.x = e.offsetX; p.y = e.offsetY;
      if (Math.hypot(p.x - p.sx, p.y - p.sy) > 6) p.moved = true;
      if (ptrs.size === 1 && p.moved) S.rend.pan(dx, dy);
      else if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        S.rend.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d); pinch.d = d;
        a.moved = b.moved = true;
      }
    });
    const up = (e) => {
      const p = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId); pinch = null;
      if (p && !p.moved && ptrs.size === 0 && e.type === 'pointerup') {
        const hit = S.rend.pick(p.x, p.y);
        S.sel = hit; showSel();
      }
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); S.rend.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    cv.addEventListener('dblclick', (e) => S.rend.zoomAt(e.offsetX, e.offsetY, 1.8));
    $('#zin').addEventListener('click', () => S.rend.zoomAt(S.rend.size[0] / 2, S.rend.size[1] / 2, 1.5));
    $('#zout').addEventListener('click', () => S.rend.zoomAt(S.rend.size[0] / 2, S.rend.size[1] / 2, 1 / 1.5));
    $('#traffic').addEventListener('change', (e) => { S.rend.traffic = e.target.checked; });
    const VIEWS = { interchange: [1400, 270, 1.15], merge: [1000, 285, 1.9], downtown: [1400, 760, 1.2], bridge: [1900, 760, 1.1] };
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'fit') S.rend.fitAll();
      else { const w = S.rend.size[0]; S.rend.view(VIEWS[v][0], VIEWS[v][1], VIEWS[v][2] * Math.max(0.55, w / 1000)); }
    }));
  }

  // -------------------------------------------------------------- charts
  function fit(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  const M = { l: 34, r: 8, t: 8, b: 18 };
  function axes(ctx, w, h) {
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  }
  function lineChart(cv, series, o) {
    const { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h); axes(ctx, w, h);
    const n = Math.max(...series.map((s) => s.data.length), 0);
    if (n < 2) return;
    const ymax = o.ymax || Math.max(1, ...series.flatMap((s) => s.data)) * 1.1;
    ctx.font = '10px system-ui'; ctx.fillStyle = C.muted; ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) {
      const y = h - M.b - (h - M.t - M.b) * i / 2;
      ctx.fillText(Math.round(ymax * i / 2), M.l - 4, y + 3);
      if (i) { ctx.strokeStyle = C.line; ctx.globalAlpha = 0.4; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke(); ctx.globalAlpha = 1; }
    }
    ctx.textAlign = 'left'; ctx.fillText('older', M.l, h - 4); ctx.textAlign = 'right'; ctx.fillText('now', w - M.r, h - 4);
    for (const s of series) {
      ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      s.data.forEach((v, i) => {
        const px = M.l + (w - M.l - M.r) * (i + (n - s.data.length)) / (n - 1), y = h - M.b - (h - M.t - M.b) * Math.min(1, v / ymax);
        if (i) ctx.lineTo(px, y); else ctx.moveTo(px, y);
      });
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    series.forEach((s, i) => { ctx.fillStyle = s.color; ctx.fillText('— ' + s.label, M.l + 8 + i * 100, M.t + 10); });
  }
  const wavePix = document.createElement('canvas');
  function spaceTime(cv) {
    const net = S.net, { ctx, w, h } = fit(cv);
    ctx.clearRect(0, 0, w, h); axes(ctx, w, h);
    const rows = net.wave.length; if (rows < 2) return;
    const nb = net.wave[0].length;
    wavePix.width = rows; wavePix.height = nb;
    const px = wavePix.getContext('2d'), img = px.createImageData(rows, nb), v0 = net.p.limit / 3.6;
    for (let x = 0; x < rows; x++) for (let k = 0; k < nb; k++) {
      const v = net.wave[x][k], y = nb - 1 - k, i = (y * rows + x) * 4;
      let rgb = [40, 46, 56];
      if (v >= 0) rgb = speedColor(v / v0).match(/\d+/g).map(Number);
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
    px.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const aw = w - M.l - M.r, ah = h - M.t - M.b;
    ctx.drawImage(wavePix, M.l + aw * (1 - rows / 240), M.t, aw * rows / 240, ah);
    const tot = net.map.hwChain.total;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([2, 3]); ctx.fillStyle = C.muted; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
    let k = 0;
    for (const e of net.map.hwChain.list) {
      if (e.link.to.type !== 'diverge') continue;
      k++;
      const y = M.t + ah * (1 - (e.off + e.link.len) / tot);
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
      ctx.fillText('exit ' + k, M.l - 3, y + 3);
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'left'; ctx.fillText('4 min ago', M.l, h - 4); ctx.textAlign = 'right'; ctx.fillText('now', w - M.r, h - 4);
  }
  function drawCharts() {
    const net = S.net, h = net.hist;
    lineChart($('#c1'), [{ data: h.map((x) => x.hwV * 3.6), color: C.accent, label: 'highway' }, { data: h.map((x) => x.cityV * 3.6), color: C.warn, label: 'streets' }], { ymax: Math.max(60, net.p.limit) });
    spaceTime($('#c2'));
    lineChart($('#c3'), [{ data: h.map((x) => x.n), color: C.accent, label: 'on roads' }, { data: h.map((x) => x.backlog), color: C.bad, label: 'waiting' }], {});
  }

  // ------------------------------------------------------------ diagnosis
  function clearDiag() { S.diagRun++; $('#diag-out').innerHTML = ''; $('#diag').disabled = false; }

  function variants(p) {
    const v = [];
    const add = (name, tag, ch) => v.push({ name, tag, set: ch, p: Object.assign({}, p, ch) });
    if (p.noise > 0) add('No random braking', 'cause', { noise: 0 });
    if (p.cruising > 0) add('No cruising for parking', 'cause', { cruising: 0 });
    if (p.trucks > 0.02) add('Trucks off peak (2%)', 'cause', { trucks: 0.02 });
    if ((p.obstacles && p.obstacles.length) || (p.blocks && p.blocks.length)) add('Clear all disruptions', 'cause', { obstacles: [], blocks: [] });
    if (p.signal !== 'adaptive') add('Adaptive signals', 'fix', { signal: 'adaptive' });
    if (p.signal !== 'sync') add('Green-wave coordination', 'fix', { signal: 'sync' });
    if (p.cycle > 55) add('Shorter signal cycle (50 s)', 'fix', { cycle: 50 });
    if (!p.reroute) add('Live navigation rerouting', 'fix', { reroute: true });
    if (!p.metering) add('Ramp metering', 'fix', { metering: true });
    if (!p.vsl) add('Variable speed limits', 'fix', { vsl: true });
    if (p.cacc < 0.3) add('30% connected cars', 'fix', { cacc: 0.3 });
    add('20% shift to transit/bike', 'fix', { transit: Math.min(0.6, p.transit + 0.2) });
    add('15% staggered / remote', 'fix', { flex: Math.min(0.5, p.flex + 0.15) });
    if (p.limit > 90) add('90 km/h highway limit', 'fix', { limit: 90 });
    return v;
  }

  function makePool(n) {
    const workers = [];
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker('js/worker.js');
        workers.push(w);
      }
    } catch (e) { return null; }
    return workers;
  }

  async function runJobs(jobs, onProgress, token) {
    const results = new Array(jobs.length);
    let done = 0;
    const pool = typeof Worker !== 'undefined' ? makePool(Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) : null;
    if (pool) {
      try {
        await new Promise((resolve, reject) => {
          let next = 0, failed = false;
          const feed = (w) => {
            if (token !== S.diagRun) { resolve(); return; }
            if (next >= jobs.length) { if (done >= jobs.length) resolve(); return; }
            const i = next++;
            w.onmessage = (e) => { results[i] = e.data.r; done++; onProgress(done / jobs.length); feed(w); };
            w.onerror = (e) => { if (!failed) { failed = true; reject(e); } };
            w.postMessage(Object.assign({ id: i }, jobs[i]));
          };
          pool.forEach(feed);
        });
        pool.forEach((w) => w.terminate());
        if (token !== S.diagRun) return null;
        return results;
      } catch (e) { pool.forEach((w) => w.terminate()); done = 0; }
    }
    for (let i = 0; i < jobs.length; i++) {
      if (token !== S.diagRun) return null;
      await new Promise((r) => setTimeout(r, 0));
      const j = jobs[i];
      results[i] = runNet(j.params, j.seconds, j.warm, j.seed);
      onProgress((i + 1) / jobs.length);
    }
    return results;
  }

  async function runDiagnosis() {
    const token = ++S.diagRun;
    const btn = $('#diag'); btn.disabled = true;
    const out = $('#diag-out');
    const p0 = params();
    const vs = variants(p0), seeds = [11, 12, 13];
    const all = [{ name: 'base', p: p0 }, ...vs];
    const jobs = [];
    for (const v of all) for (const sd of seeds) jobs.push({ params: v.p, seconds: 600, warm: 300, seed: sd });
    out.innerHTML = '<div class="progress"><i></i></div><div class="muted">Simulating ' + jobs.length + ' runs of 10 minutes each.</div>';
    const bar = out.querySelector('.progress i');
    const res = await runJobs(jobs, (f) => { bar.style.width = (f * 100).toFixed(0) + '%'; }, token);
    if (!res || token !== S.diagRun) return;
    const avg = (k) => {
      const rs = res.slice(k * seeds.length, (k + 1) * seeds.length), m = (f) => rs.reduce((s, r) => s + r[f], 0) / rs.length;
      return { speed: m('speed'), hw: m('hwV'), city: m('cityV'), tpm: m('tpm'), back: m('backlog') };
    };
    const base = avg(0);
    const rows = vs.map((v, i) => { const r = avg(i + 1); return { v, gain: r.speed - base.speed, rel: (r.speed - base.speed) / Math.max(base.speed, 1) * 100, r }; });
    rows.sort((a, b) => b.gain - a.gain);
    renderDiag(base, rows);
    btn.disabled = false;
  }

  function renderDiag(base, rows) {
    const out = $('#diag-out');
    const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.gain)));
    out.innerHTML = `<div class="muted">Baseline: ${base.speed.toFixed(0)} km/h network average (highway ${base.hw.toFixed(0)}, streets ${base.city.toFixed(0)}), ${base.tpm.toFixed(0)} trips/min.</div>`;
    for (const x of rows) {
      const noise = Math.abs(x.gain) < 1.2, neg = x.gain < 0 && !noise, row = document.createElement('div');
      row.className = 'drow';
      const d = (a, b) => `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(0)}`;
      row.innerHTML = `<div class="name"><b>${x.v.name}</b><span class="tag">${x.v.tag === 'cause' ? 'removes a cause' : 'fix'}</span></div>
        <div class="gain ${neg ? 'neg' : ''}${noise ? ' flat' : ''}">${x.gain < 0 ? '' : '+'}${x.gain.toFixed(1)} km/h <span class="muted">(${x.gain < 0 ? '' : '+'}${x.rel.toFixed(0)}%)</span></div>
        <div class="bar"><i class="${neg ? 'neg' : ''}${noise ? ' flat' : ''}" style="width:${Math.abs(x.gain) / maxAbs * 100}%"></i></div>
        <div class="muted" style="grid-column:1/-1">highway ${d(x.r.hw, base.hw)} km/h · streets ${d(x.r.city, base.city)} km/h · trips ${d(x.r.tpm, base.tpm)}/min${noise ? ' · within run-to-run noise' : neg ? ' · makes it worse' : ''}
          <button class="btn sm" style="margin-left:6px">Apply</button></div>`;
      row.querySelector('button').addEventListener('click', () => applyVariant(x.v));
      out.appendChild(row);
    }
  }

  function applyVariant(v) {
    for (const [k, val] of Object.entries(v.set)) {
      if (k === 'obstacles' || k === 'blocks') S.net.clearDisruptions();
      else S.net.set(k, val);
    }
    refreshControls();
    $('#diag-out').insertAdjacentHTML('afterbegin', `<div class="muted">Applied: ${v.name}. Re-run to rank again.</div>`);
  }

  // ---------------------------------------------------------------- misc
  function buildExplain() {
    $('#explain').innerHTML = '<h2>What drives congestion in this metro</h2>' +
      EXPLAIN.map(([t, b, lim]) => `<div class="card${lim ? ' limit' : ''}"><h3>${t}</h3><p>${b}</p></div>`).join('');
  }

  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    S.speed = +b.dataset.speed;
    document.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#play').addEventListener('click', () => { S.playing = !S.playing; $('#play').textContent = S.playing ? 'Pause' : 'Play'; });
  $('#reset').addEventListener('click', () => resetNet(null));
  $('#diag').addEventListener('click', runDiagnosis);
  $('#pin').addEventListener('click', () => { S.base = Object.assign({}, S.ema); renderBaseline(); });
  $('#unpin').addEventListener('click', () => { S.base = null; renderBaseline(); });

  // ---------------------------------------------------------------- loop
  let last = performance.now(), acc = 0;
  function frame(now) {
    const real = Math.min(0.1, (now - last) / 1000); last = now;
    const net = S.net;
    if (S.playing && !document.hidden) {
      acc += real * S.speed;
      let n = 0;
      while (acc >= DT && n < 80) { net.step(DT); acc -= DT; n++; }
      if (n === 80) acc = 0;
      if (n) updateKpis(n * DT);
    }
    S.rend.draw(now);
    if (now - S.lastChart > 250) {
      S.lastChart = now; renderKpis(); updateBanner(); drawCharts(); updateSelInfo();
    }
    requestAnimationFrame(frame);
  }

  function boot() {
    const map0 = MM.buildMap();
    S.decor = MM.buildDecor(map0);
    S.net = makeNet({});
    S.rend = new Renderer($('#stage'), S.net, S.decor);
    readTheme();
    S.rend.setTheme(readTheme());
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => S.rend.setTheme(readTheme()));
    setupMap(); buildControls(); buildPresets(); buildKpis(); buildExplain(); renderBaseline();
    document.querySelector('[data-speed="2"]').classList.add('on');
    requestAnimationFrame(frame);
  }
  boot();
})();
