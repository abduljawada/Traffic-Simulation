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
    if (L.kind === 'ring') return 'Roundabout';
    if (L.kind === 'hw') return `Highway 1 ${dirs}`;
    if (L.kind === 'ramp') return L.to.type === 'merge' ? 'On-ramp' : 'Off-ramp';
    if (L.kind === 'art') {
      if (Math.abs(L.h1[0]) > Math.abs(L.h1[1])) return `${AVE_NAMES[near(AV, my)]} ${dirs}`;
      return `${ART_NAMES[near(IX, mx)]} ${dirs}`;
    }
    return `Local street ${dirs}`;
  }
  function nodeLabel(n) {
    const a = AVE_NAMES[near(AV, n.y)];
    const x = n.x, art = IX.includes(x) ? ART_NAMES[x] : 'local street';
    return `${a} × ${art}`;
  }
  function gateLabel(g) {
    if (g.id === 'gW') return 'the west highway gate';
    if (g.id === 'gE') return 'the east highway gate';
    if (g.id[0] === 'a') return `${AVE_NAMES[g.y]} ${g.x < 1 ? 'west' : 'east'} end`;
    if (g.id.startsWith('gN')) return `${ART_NAMES[g.x]} north end`;
    return `the south end at x=${g.x}`;
  }
  const fmtClock = (s) => { const m = Math.floor(s / 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

  // ---------------------------------------------------------- controls
  const CAUSES = [
    { type: 'head', label: 'Demand' },
    { key: 'demand', label: 'Trips entering', min: 20, max: 140, step: 5, fmt: (v) => `${v} /min`, tip: 'Trips starting every minute (cars, trucks, bikes). Roads jam when demand crosses capacity.' },
    { key: 'profile', type: 'seg', label: 'Time of day', opts: [['steady', 'Steady'], ['peak', 'Peak hour']], tip: 'Peak hour builds up, peaks after 25 min and eases off. Recovery matters as much as the peak.' },
    { key: 'internalShare', label: 'Trips inside the city', min: 10, max: 80, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Between homes, offices, shops and downtown. The rest come in from, go out to, or pass through the map edges.' },
    { key: 'hwShare', label: 'Edge trips starting on the highway', min: 10, max: 70, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'The rest enter on city streets.' },
    { key: 'tidal', label: 'Commuter tilt', min: 0, max: 100, step: 10, pct: true, fmt: (v) => `${v}%`, tip: 'How lopsided edge traffic is toward the south and east. High tilt overloads a few exits.' },
    { key: 'elasticity', label: 'Demand response to delays', min: 0, max: 60, step: 5, pct: true, fmt: (v) => (v ? `${v}%` : 'off'), tip: 'When trips get slower some people stay home or switch. Faster roads attract new trips back (induced demand).' },
    { key: 'cruising', label: 'Cannot find curb parking', min: 0, max: 70, step: 5, pct: true, fmt: (v) => `${v}% of arrivals`, tip: 'These drivers pass the destination, circle the block and try again. Purple outline.' },
    { type: 'head', label: 'Drivers and vehicles' },
    { key: 'noise', label: 'Braking noise', min: 0, max: 1, step: 0.05, fmt: (v) => v.toFixed(2), tip: 'Random over-braking and distraction: the seed of phantom jams.' },
    { key: 'headway', label: 'Following gap', min: 0.7, max: 2.2, step: 0.1, fmt: (v) => `${v.toFixed(1)} s`, tip: 'Average desired time gap. Short gaps raise capacity but leave no room for a brake tap.' },
    { key: 'trucks', label: 'Trucks on edge trips', min: 0, max: 25, step: 1, pct: true, fmt: (v) => `${v}%`, tip: 'Slow, long, slow to accelerate. They form moving bottlenecks.' },
    { key: 'peds', label: 'Pedestrians at crosswalks', min: 0, max: 15, step: 1, fmt: (v) => `${v} /min each`, tip: 'Turning cars must yield. Left turns also wait for gaps in oncoming traffic.' },
    { type: 'head', label: 'Signals and incidents' },
    { key: 'cycle', label: 'Signal cycle (untuned and green wave)', min: 30, max: 150, step: 5, fmt: (v) => `${v} s`, tip: 'Long cycles mean long reds and queues that spill back.' },
    { key: 'incidents', label: 'Random incidents', min: 0, max: 8, step: 0.5, fmt: (v) => (v ? `${v} /hour` : 'none'), tip: 'A lane blocked on the highway or an avenue, cleared after 3 to 50 minutes.' },
    { key: 'rubber', type: 'toggle', label: 'Rubbernecking', tip: 'Drivers in open lanes slow down to look at a breakdown.' },
    { key: 'disrupt', type: 'disrupt', label: 'Your own disruptions', tip: 'Tap any road on the map to add one. They stay until you remove them.' },
  ];
  const FIXES = [
    { type: 'head', label: 'Signals and junctions' },
    { key: 'signal', type: 'seg', label: 'Signal control', opts: [['untuned', 'Untuned'], ['webster', 'Tuned'], ['sync', 'Green wave'], ['adaptive', 'Adaptive']], tip: 'Tuned = cycle and green split set from expected flows (Webster). Green wave favours east and south. Adaptive follows queues.' },
    { key: 'roundabouts', type: 'rbt', label: 'Roundabouts', tip: 'Replace signals with yield-controlled rings. Tap a junction on the map to convert just that one.' },
    { type: 'head', label: 'Highway' },
    { key: 'metering', type: 'toggle', label: 'Ramp metering', tip: 'Holds on-ramp cars when the highway lane is busy. Moves delay onto the ramp.' },
    { key: 'vsl', type: 'toggle', label: 'Variable speed limits', tip: 'Gantries slow highway traffic before a queue so it arrives smoothly.' },
    { key: 'cacc', label: 'Connected automated cars', min: 0, max: 100, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'React to the two cars ahead, keep 0.9 s gaps, never over-brake. Cyan outline.' },
    { key: 'limit', label: 'Highway speed limit', min: 60, max: 130, step: 5, fmt: (v) => `${v} km/h`, tip: 'Lower speeds shrink shockwaves; too low wastes capacity.' },
    { key: 'fastClear', type: 'toggle', label: 'Faster incident clearance', tip: 'Tow trucks and patrols halve the time a lane stays blocked.' },
    { type: 'head', label: 'Drivers, transit and bikes' },
    { key: 'navShare', label: 'Drivers using live navigation', min: 0, max: 100, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Each cohort re-plans every 20 s from smoothed travel times. Too many at once can herd onto one detour.' },
    { key: 'busFreq', label: 'Bus frequency per route', min: 0, max: 20, step: 1, fmt: (v) => (v ? `${v} /hour` : 'no buses'), tip: 'Buses stop in the right lane for 12 to 26 s and carry 28 people.' },
    { key: 'busLanes', type: 'toggle', label: 'Bus lanes on avenues', tip: 'The right lane is kept for buses. Cars lose a lane.' },
    { key: 'bikes', label: 'Share of trips by bike', min: 0, max: 20, step: 1, pct: true, fmt: (v) => `${v}%`, tip: 'Bikes ride at 19 km/h in the right lane of local trips and take cars off the road.' },
    { key: 'bikeLanes', type: 'toggle', label: 'Protected bike lanes', tip: 'Bikes get their own track beside the road and stop slowing cars.' },
    { key: 'transit', label: 'Shift to transit / carpool', min: 0, max: 50, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Fewer cars on the same roads.' },
    { key: 'flex', label: 'Staggered hours / remote work', min: 0, max: 40, step: 5, pct: true, fmt: (v) => `${v}%`, tip: 'Flattens the peak instead of widening the road.' },
  ];

  const PRESETS = [
    { name: 'Rush hour', p: {} },
    { name: 'Peak hour', p: { profile: 'peak', demand: 80 } },
    { name: 'Free flow', p: { demand: 30, noise: 0.25, incidents: 0 } },
    { name: 'Highway crash', p: { demand: 100, hwShare: 0.7, internalShare: 0.15, tidal: 0.3, incidents: 0 }, after: (n) => { const L = n.links.find((l) => l.from.id === 'DE650' && l.to.id === 'ME650'); n.toggleDisruption(L, 330); } },
    { name: 'Delivery chaos', p: { demand: 60 }, after: (n) => n.randomDisruptions(9, ['art', 'loc']) },
    { name: 'Gridlock', p: { demand: 105, cycle: 110, signal: 'untuned', cruising: 0.5, tidal: 0.7 } },
    { name: 'Smart metro', p: { demand: 75, signal: 'adaptive', navShare: 0.7, metering: true, vsl: true, cacc: 0.3, transit: 0.15, cruising: 0.1, fastClear: true, busLanes: true, bikeLanes: true, bikes: 0.08 } },
  ];

  const KPIS = [
    { id: 'speed', label: 'Network speed', unit: 'km/h', better: 1, get: (n) => n.stats.eff * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'hw', label: 'Highway speed', unit: 'km/h', better: 1, get: (n) => n.stats.hwV * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'city', label: 'Street speed', unit: 'km/h', better: 1, get: (n) => n.stats.cityV * 3.6, fmt: (v) => v.toFixed(0) },
    { id: 'bus', label: 'Bus speed', unit: 'km/h', better: 1, get: (n) => n.stats.busV * 3.6, fmt: (v) => (v > 0 ? v.toFixed(0) : '–') },
    { id: 'tpm', label: 'Trips finished', unit: '/min', better: 1, get: (n) => n.stats.tpm, fmt: (v) => v.toFixed(0) },
    { id: 'delay', label: 'Trip time vs free flow', unit: '×', better: -1, get: (n) => n.stats.delay, fmt: (v) => v.toFixed(2) },
    { id: 'p95', label: 'Worst 1 in 20 trips', unit: '×', better: -1, get: (n) => n.stats.p95, fmt: (v) => v.toFixed(1) },
    { id: 'wait', label: 'Waiting to depart', unit: 'trips', better: -1, get: (n) => n.stats.backlog, fmt: (v) => v.toFixed(0) },
  ];

  const EXPLAIN = [
    ['Demand beats capacity', 'A freeway lane moves roughly 1,900 to 2,200 vehicles an hour at best, a signalised lane about 1,800 per green hour. Past those flows queues grow faster than they clear, and demand that responds to delay keeps pushing back toward the limit.'],
    ['Phantom jams', 'No crash needed. One driver over-brakes, reaction lag makes the next brake harder, and the disturbance grows into a stop-and-go wave that drifts backwards at 15 to 25 km/h. Look for slanting bands in the highway chart.'],
    ['Merging and exits', 'Ramp cars follow a gap in the right lane and merge at speed; if none opens they wait and eventually force in. Off-ramps are worse when the signal at the bottom cannot clear the queue: it backs onto the highway and blocks every lane. Drivers start moving over for their exit a kilometre ahead.'],
    ['Breakdowns and incidents', 'One blocked lane of three removes far more than a third of capacity, because everyone must change lanes at one spot. Rubbernecking adds to it, and how long it lasts matters as much as how bad it is, so faster clearance is a real lever.'],
    ['Signals, left turns and pedestrians', 'Every red costs a stop and a restart. Left turns wait inside the junction for gaps in oncoming traffic and clear on the yellow, and turning cars yield to people on the crosswalk. A fixed plan tuned to expected flows beats an untuned one; adaptive signals follow actual queues; a green wave helps only the dominant direction.'],
    ['Roundabouts', 'Entering cars yield to traffic already circling, there is no red to wait at, and conflicts are low speed. They do well at moderate flows and with many left turns; U-turns become a lap around the island. A busy single-lane ring is limited by its circulating flow, and a full ring is capped so it cannot lock up. Tap a junction to swap and compare, or make it two lanes.'],
    ['Parking, buses and bikes', 'Drivers who cannot find curb parking circle the block, and every parking manoeuvre stops a lane for several seconds. Buses stop in the right lane unless it is reserved; bus lanes speed buses but take a lane from cars, so check person speed as well as vehicle speed. Bikes slow cars unless they have their own track.'],
    ['Navigation and demand response', 'Live navigation moves traffic to side streets and the highway, but if everyone re-plans at once they all take the same detour. Staggered updates and averaging damp that. When roads get faster some trips switch back to driving, which is why added capacity often fills up again.'],
    ['What the model leaves out', 'Parameters are matched to published stylised facts (freeway capacity near 2,100 veh/h/lane, signal saturation flow near 1,800, backward wave speed 20 km/h), not fitted to a real city or trajectory data. No weather, no trams or trucks beyond the types here, simplified two-phase signals without protected left phases, one trip purpose per period, and no long-run land-use change. Use it to compare options and understand mechanisms, not to forecast a specific road.', true],
  ];

  // --------------------------------------------------------------- state
  const S = { net: null, rend: null, decor: null, playing: true, speed: 2, ema: {}, base: null, diagRun: 0, sel: null, lastChart: 0, ctl: {}, diagData: null, metric: 'speed' };
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
  function allLocalJunctions() {
    const out = [];
    for (const y of MM.AVENUES) for (const x of MM.COLS) if (!MM.INTERCHANGES.includes(x)) out.push(`J${x}_${y}`);
    return out;
  }
  function setRoundabouts(list) {
    const p = params(); p.roundabouts = list;
    setNet(makeNet(p));
  }
  function toggleRoundabout(id, lanes) {
    const cur = new Map((S.net.p.roundabouts || []).map((e) => { const [i, k] = String(e).split('#'); return [i, k === '2' ? 2 : 1]; }));
    if (cur.get(id) === lanes) cur.delete(id); else cur.set(id, lanes);
    setRoundabouts([...cur].map(([i, k]) => (k === 2 ? i + '#2' : i)));
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
    if (c.type === 'head') { w.className = 'chead'; w.textContent = c.label; return w; }
    w.className = 'ctl' + (c.type === 'toggle' ? ' toggle' : '');
    const id = 'ctl-' + c.key, tip = `<div class="tip">${c.tip || ''}</div>`;
    if (c.type === 'toggle') {
      w.innerHTML = `<label class="row" for="${id}"><span>${c.label}</span><input type="checkbox" id="${id}"></label>${tip}`;
      w.querySelector('input').addEventListener('change', (e) => setParam(c.key, e.target.checked));
    } else if (c.type === 'seg') {
      w.innerHTML = `<div class="row"><span>${c.label}</span></div><div class="seg">${c.opts.map(([v, n]) => `<button class="btn sm" data-v="${v}">${n}</button>`).join('')}</div>${tip}`;
      w.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setParam(c.key, b.dataset.v)));
    } else if (c.type === 'rbt') {
      w.innerHTML = `<div class="row"><span>${c.label}</span><span class="val" id="${id}-v"></span></div>
        <div class="acts"><button class="btn sm" data-a="all">1 lane, all local</button><button class="btn sm" data-a="all2">2 lanes, all local</button><button class="btn sm" data-a="none">None</button><button class="btn sm" data-a="def">Default</button></div>${tip}`;
      w.querySelector('[data-a=all]').addEventListener('click', () => setRoundabouts(allLocalJunctions()));
      w.querySelector('[data-a=all2]').addEventListener('click', () => setRoundabouts(allLocalJunctions().map((i) => i + '#2')));
      w.querySelector('[data-a=none]').addEventListener('click', () => setRoundabouts([]));
      w.querySelector('[data-a=def]').addEventListener('click', () => setRoundabouts(MM.DEFAULT_ROUNDABOUTS.slice()));
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
      else if (c.type === 'rbt') el.querySelector('.val').textContent = (p.roundabouts || []).length;
      else {
        const x = c.pct ? Math.round(v * 100) : Math.round(v * 100) / 100;
        el.querySelector('input').value = x;
        el.querySelector('.val').textContent = c.fmt(x);
      }
    }
  }

  function setParam(key, val) {
    S.net.set(key, val);
    if (key === 'busLanes' || key === 'bikeLanes') S.rend.dirty = true;
    clearDiag(); refreshControls();
  }

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
      if (S.base && S.base[k.id] !== undefined && !(k.id === 'bus' && !(v > 0))) {
        const b = S.base[k.id], diff = v - b, rel = Math.abs(b) < 1e-6 ? 0 : diff / Math.abs(b) * 100;
        if (Math.abs(rel) < 1) { d.textContent = 'same as baseline'; d.className = 'd muted'; }
        else { d.textContent = `${diff > 0 ? '▲' : '▼'} ${Math.abs(rel).toFixed(0)}% vs baseline`; d.className = 'd ' + (diff * k.better > 0 ? 'up' : 'down'); }
      } else if (k.id === 'speed') { d.textContent = `${Math.round(v / (13.9 * 3.6) * 100)}% of free flow`; d.className = 'd muted'; }
      else if (k.id === 'hw') { d.textContent = `limit ${S.net.p.limit} km/h`; d.className = 'd muted'; }
      else if (k.id === 'p95') { d.textContent = 'reliability'; d.className = 'd muted'; }
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
    else if (st.cityV < 6.5) { level = 'jam'; text = 'Streets congested: queues at junctions spill back through the grid.'; }
    else if (hwRatio < 0.75 || st.cityV < 9) { level = 'dense'; text = 'Busy: stop-start driving on some roads.'; }
    else { level = 'free'; text = 'Flowing: most cars are moving near the limit.'; }
    const spill = n.links.find((L) => L.kind === 'ramp' && L.to.type !== 'merge' && L.n >= 10 && L.ratio < 0.35);
    if (spill) text += ' An off-ramp queue is backing onto the highway.';
    let inc = 0; for (const L of n.links) if (L.obs && !L.obs.perm) inc++;
    const dis = n.countDisruptions() - inc;
    if (inc) text += ` ${inc} incident${inc > 1 ? 's' : ''} blocking a lane.`;
    if (dis) text += ` ${dis} disruption${dis > 1 ? 's' : ''} on the map.`;
    if (st.backlog > 20) text += ` ${st.backlog} trips cannot depart.`;
    $('#banner').dataset.level = level;
    $('#banner-text').textContent = text;
    const m = n._mult() * n.indMult;
    $('#clock').textContent = `${fmtClock(n.clock)} · demand ${Math.round(m * 100)}%`;
  }

  // ----------------------------------------------------------- selection
  const TYPE_NAME = { h: 'Car', t: 'Truck', c: 'Connected car', b: 'Bus', k: 'Bicycle' };
  function showSel() {
    const el = $('#sel'), s = S.sel;
    if (!s) { el.hidden = true; S.rend.sel = null; return; }
    S.rend.sel = s;
    el.hidden = false;
    if (s.car) {
      const c = s.car;
      el.innerHTML = `<div class="st"><b>${TYPE_NAME[c.type] || 'Car'}</b><button class="x" aria-label="Close">×</button></div>
        <div class="muted" id="sel-info"></div><div class="acts">${c.type === 'k' ? '' : '<button class="btn sm" data-a="brake">Hard brake for 3 s</button>'}</div>`;
      const b = el.querySelector('[data-a=brake]');
      if (b) b.addEventListener('click', () => { c.brakeUntil = S.net.t + 3; c.brakeA = -4.5; });
    } else if (s.node) {
      const n = s.node, isR = n.type === 'round';
      const ok = isR || n.in.every((l) => l.kind === 'art' || l.kind === 'loc');
      const wide = n.in.some((l) => l.lanes >= 2) || isR;
      el.innerHTML = `<div class="st"><b>${isR ? (n.rl === 2 ? 'Two-lane roundabout' : 'Roundabout') : 'Signalised junction'}</b><button class="x" aria-label="Close">×</button></div>
        <div class="muted">${nodeLabel(n)}. ${isR ? 'Cars yield to traffic already circling.' : 'Two-phase traffic signal, permissive left turns, crosswalks.'}</div>
        <div class="acts">${ok ? (isR ? '<button class="btn sm" data-a="sig">Restore signals</button>' + (n.rl === 2 ? '<button class="btn sm" data-a="r1">Make it 1 lane</button>' : '<button class="btn sm" data-a="r2">Make it 2 lanes</button>')
          : '<button class="btn sm" data-a="r1">Roundabout (1 lane)</button>' + (wide ? '<button class="btn sm" data-a="r2">Roundabout (2 lanes)</button>' : '')) : ''}</div>
        ${ok ? '<div class="muted">Rebuilds the road and restarts traffic. Pin a baseline first to compare.</div>' : ''}`;
      const on = (a, fn) => { const b = el.querySelector(`[data-a=${a}]`); if (b) b.addEventListener('click', fn); };
      on('sig', () => { const cur = (S.net.p.roundabouts || []).filter((e) => String(e).split('#')[0] !== n.id); setRoundabouts(cur); });
      on('r1', () => { const cur = (S.net.p.roundabouts || []).filter((e) => String(e).split('#')[0] !== n.id); cur.push(n.id); setRoundabouts(cur); });
      on('r2', () => { const cur = (S.net.p.roundabouts || []).filter((e) => String(e).split('#')[0] !== n.id); cur.push(n.id + '#2'); setRoundabouts(cur); });
    } else {
      const L = s.link;
      const has = !!(L.obs || L.block !== null);
      const canAdd = L.kind !== 'ramp' && L.kind !== 'ring' && !(L.from.type === 'gate' && L.to.type === 'gate');
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
    const s = S.sel; if (!s || s.node) return;
    const el = $('#sel-info'); if (!el) return;
    if (s.car) {
      const c = s.car;
      const alive = !c.dead && (c.sep ? c.link.bikes.includes(c) : c.link.lanesArr[c.lane] && c.link.lanesArr[c.lane].includes(c));
      if (!alive) { el.textContent = 'Left the map.'; return; }
      const d = c.dest;
      const dest = d.node ? gateLabel(d.node) : `a parking spot on ${linkLabel(d.link)}`;
      let mode = `Heading to ${dest}`;
      if (c.stopKind === 'park') mode = `Pulling in to park on ${linkLabel(d.link)}`;
      else if (c.stopKind === 'bus') mode = 'Stopping to pick up passengers';
      else if (c.wander > 0) mode = `Circling for parking, then ${dest}`;
      else if (c.tries > 0) mode = `Returning to ${dest} after missing a space`;
      const nm = c.next ? ({ left: 'turning left', right: 'turning right', straight: 'going straight', u: 'making a U-turn', exit: 'taking the exit', merge: 'merging' })[c.next.kind] : '';
      el.textContent = `${Math.round(c.v * 3.6)} km/h on ${linkLabel(c.link)}. ${mode}${nm ? ', next ' + nm : ''}${c.nav ? '. Uses live navigation' : ''}.`;
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
    $('#land').addEventListener('change', (e) => { S.rend.landUse = e.target.checked; S.rend.dirty = true; });
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
  function clearDiag() { S.diagRun++; S.diagData = null; $('#diag-out').innerHTML = ''; $('#diag-opts').hidden = true; $('#diag').disabled = false; }

  function variants(p) {
    const v = [];
    const add = (name, tag, ch) => v.push({ name, tag, set: ch, p: Object.assign({}, p, ch) });
    const rb = p.roundabouts || [];
    const all = allLocalJunctions();
    if (p.noise > 0) add('No random braking', 'cause', { noise: 0 });
    if (p.cruising > 0) add('Always find curb parking', 'cause', { cruising: 0 });
    if (p.trucks > 0.02) add('Trucks cut to 2%', 'cause', { trucks: 0.02 });
    if (p.incidents > 0) add('No random incidents', 'cause', { incidents: 0 });
    if ((p.obstacles && p.obstacles.length) || (p.blocks && p.blocks.length)) add('Clear your disruptions', 'cause', { obstacles: [], blocks: [] });
    if (p.signal !== 'webster') add('Signals tuned to flows', 'fix', { signal: 'webster' });
    if (p.signal !== 'adaptive') add('Adaptive signals', 'fix', { signal: 'adaptive' });
    if (p.signal !== 'sync') add('Green-wave coordination', 'fix', { signal: 'sync' });
    if (p.signal === 'untuned' && p.cycle > 55) add('Shorter untuned cycle (50 s)', 'fix', { cycle: 50 });
    if (all.some((j) => !rb.includes(j) && !rb.includes(j + '#2'))) add('Roundabouts at local junctions', 'fix', { roundabouts: all });
    add('Two-lane roundabouts at local junctions', 'fix', { roundabouts: all.map((j) => j + '#2') });
    if (rb.length) add('Signals instead of roundabouts', 'fix', { roundabouts: [] });
    if (p.navShare < 0.8) add('80% on live navigation', 'fix', { navShare: 0.8 });
    if (p.navShare > 0) add('No live navigation', 'fix', { navShare: 0 });
    if (!p.metering) add('Ramp metering', 'fix', { metering: true });
    if (!p.vsl) add('Variable speed limits', 'fix', { vsl: true });
    if (p.cacc < 0.3) add('30% connected cars', 'fix', { cacc: 0.3 });
    if (p.limit > 90) add('90 km/h highway limit', 'fix', { limit: 90 });
    if (!p.fastClear && p.incidents > 0) add('Faster incident clearance', 'fix', { fastClear: true });
    if (!p.busLanes) add('Bus lanes on avenues', 'fix', { busLanes: true });
    if (p.busFreq < 12) add('Twice the bus service', 'fix', { busFreq: Math.max(8, p.busFreq * 2) });
    if (!p.bikeLanes) add('Protected bike lanes', 'fix', { bikeLanes: true, bikes: Math.max(p.bikes, 0.08) });
    add('20% shift to transit/carpool', 'fix', { transit: Math.min(0.6, p.transit + 0.2) });
    add('15% staggered / remote', 'fix', { flex: Math.min(0.5, p.flex + 0.15) });
    return v;
  }

  function makePool(n) {
    const workers = [];
    try { for (let i = 0; i < n; i++) workers.push(new Worker('js/worker.js')); } catch (e) { return null; }
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

  const T975 = { 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262 };

  async function runDiagnosis() {
    const token = ++S.diagRun;
    const btn = $('#diag'); btn.disabled = true;
    const out = $('#diag-out');
    const p0 = params();
    const vs = variants(p0), nSeeds = +$('#diag-seeds').value, seeds = [11, 12, 13, 14, 15, 16, 17, 18, 19].slice(0, nSeeds);
    const all = [{ name: 'base', p: p0 }, ...vs];
    const jobs = [];
    for (const v of all) for (const sd of seeds) jobs.push({ params: v.p, seconds: 540, warm: 270, seed: sd });
    out.innerHTML = `<div class="progress"><i></i></div><div class="muted">${jobs.length} runs of 9 minutes, same ${nSeeds} demand patterns for every option.</div>`;
    const bar = out.querySelector('.progress i');
    const res = await runJobs(jobs, (f) => { bar.style.width = (f * 100).toFixed(0) + '%'; }, token);
    if (!res || token !== S.diagRun) return;
    const per = (k) => res.slice(k * seeds.length, (k + 1) * seeds.length);
    S.diagData = { base: per(0), rows: vs.map((v, i) => ({ v, runs: per(i + 1) })), n: seeds.length };
    $('#diag-opts').hidden = false;
    renderDiag();
    btn.disabled = false;
  }

  function stat(arr) {
    const n = arr.length, m = arr.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, n - 1));
    return { m, ci: (T975[n - 1] || 2.3) * sd / Math.sqrt(n) };
  }

  function renderDiag() {
    const D = S.diagData; if (!D) return;
    const key = S.metric === 'person' ? 'pSpeed' : 'speed', out = $('#diag-out');
    const mean = (runs, f) => runs.reduce((a, r) => a + r[f], 0) / runs.length;
    const rows = D.rows.map((r) => {
      const d = r.runs.map((x, i) => x[key] - D.base[i][key]);
      const s = stat(d);
      return { v: r.v, gain: s.m, ci: s.ci, clear: Math.abs(s.m) > s.ci, rel: s.m / Math.max(mean(D.base, key), 1) * 100,
        dh: mean(r.runs, 'delayH') - mean(D.base, 'delayH'), p95: mean(r.runs, 'p95') - mean(D.base, 'p95'),
        hw: mean(r.runs, 'hwV') - mean(D.base, 'hwV'), city: mean(r.runs, 'cityV') - mean(D.base, 'cityV'), bus: mean(r.runs, 'busV') - mean(D.base, 'busV') };
    }).sort((a, b) => b.gain - a.gain);
    const maxAbs = Math.max(1, ...rows.map((x) => Math.abs(x.gain)));
    const label = key === 'pSpeed' ? 'person-weighted speed' : 'vehicle speed';
    out.innerHTML = `<div class="muted">Baseline ${mean(D.base, key).toFixed(1)} km/h ${label}; highway ${mean(D.base, 'hwV').toFixed(0)}, streets ${mean(D.base, 'cityV').toFixed(0)}, ${mean(D.base, 'delayH').toFixed(0)} person-hours lost per hour, worst 1 in 20 trips ${mean(D.base, 'p95').toFixed(1)}× free flow. Bars show the mean gain over ${D.n} paired runs, ± is a 95% interval.</div>`;
    for (const x of rows) {
      const neg = x.gain < 0 && x.clear, row = document.createElement('div');
      row.className = 'drow';
      const sg = (v, d) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
      row.innerHTML = `<div class="name"><b>${x.v.name}</b><span class="tag">${x.v.tag === 'cause' ? 'removes a cause' : 'fix'}</span></div>
        <div class="gain ${neg ? 'neg' : ''}${x.clear ? '' : ' flat'}">${sg(x.gain, 1)} km/h <span class="muted">±${x.ci.toFixed(1)}</span></div>
        <div class="bar"><i class="${neg ? 'neg' : ''}${x.clear ? '' : ' flat'}" style="width:${Math.abs(x.gain) / maxAbs * 100}%"></i></div>
        <div class="muted" style="grid-column:1/-1">${x.clear ? (x.gain > 0 ? 'clear gain' : 'clearly worse') : 'no clear effect'} · highway ${sg(x.hw, 0)}, streets ${sg(x.city, 0)}${x.bus ? `, buses ${sg(x.bus, 0)}` : ''} km/h · ${sg(x.dh, 0)} person-h/h lost · reliability ${sg(x.p95, 2)}×
          <button class="btn sm" style="margin-left:6px">Apply</button></div>`;
      row.querySelector('button').addEventListener('click', () => applyVariant(x.v));
      out.appendChild(row);
    }
  }

  function applyVariant(v) {
    if (v.set.roundabouts) { setRoundabouts(v.set.roundabouts); return; }
    for (const [k, val] of Object.entries(v.set)) {
      if (k === 'obstacles' || k === 'blocks') S.net.clearDisruptions();
      else S.net.set(k, val);
    }
    if ('busLanes' in v.set || 'bikeLanes' in v.set) S.rend.dirty = true;
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
  document.querySelectorAll('[name=dmetric]').forEach((r) => r.addEventListener('change', (e) => { S.metric = e.target.value; renderDiag(); }));
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
      while (acc >= DT && n < 60) { net.step(DT); acc -= DT; n++; }
      if (n === 60) acc = 0;
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
    const theme = () => { readTheme(); S.rend.setTheme(readTheme()); };
    theme();
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', theme);
    setupMap(); buildControls(); buildPresets(); buildKpis(); buildExplain(); renderBaseline();
    document.querySelector('[data-speed="2"]').classList.add('on');
    requestAnimationFrame(frame);
  }
  boot();
})();
