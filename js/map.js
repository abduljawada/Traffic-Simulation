'use strict';
/*
 * Metro map: one connected network.
 *   - 3-lane highway (both directions) with three diamond interchanges,
 *     a river bridge and street overpasses
 *   - 2-lane avenues and arterials with signalised junctions, a river bridge
 *     on each avenue, and U-turn permitted junctions
 *   - single-lane local streets
 * Pure data + geometry, no DOM. buildMap() returns a fresh network each call.
 */
(function (root) {
  const LW = 3.5;
  const WORLD = { w: 3200, h: 1350 };
  const HWY = 270;
  const INTERCHANGES = [650, 1400, 2550];
  const AVENUES = [520, 760, 1000];
  const COLS = [250, 650, 1000, 1400, 1700, 2200, 2550, 2850];
  const LOCAL_COLS = [250, 1000, 1700, 2200, 2850];
  const riverX = (y) => 1900 + 25 * Math.sin(y / 260);
  const RIVER_W = 80;

  const KINDS = {
    hw: { lanes: 3, vmax: 30.5, gap: 6 },
    ramp: { lanes: 1, vmax: 20, gap: 0 },
    art: { lanes: 2, vmax: 16.7, gap: 5 },
    loc: { lanes: 1, vmax: 11.1, gap: 2 },
    ring: { lanes: 1, vmax: 8.3, gap: 0 },
  };
  const RING_R = 18, RING_R2 = 27;
  const DEFAULT_ROUNDABOUTS = ['J1000_760', 'J2200_760', 'J250_1000', 'J2850_520', 'J1700_1000'];

  // ---------------------------------------------------------- geometry
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  function cumLen(p) {
    const c = [0];
    for (let i = 1; i < p.length; i++) c.push(c[i - 1] + dist(p[i - 1], p[i]));
    return c;
  }
  function atS(p, c, s) {
    s = Math.max(0, Math.min(c[c.length - 1], s));
    let lo = 0, hi = p.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= s) lo = m; else hi = m - 1; }
    const l = c[lo + 1] - c[lo] || 1, t = (s - c[lo]) / l;
    const dx = p[lo + 1][0] - p[lo][0], dy = p[lo + 1][1] - p[lo][1], d = Math.hypot(dx, dy) || 1;
    return [p[lo][0] + dx * t, p[lo][1] + dy * t, dx / d, dy / d];
  }
  function offsetPoly(p, d) {
    const out = [];
    const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; };
    for (let i = 0; i < p.length; i++) {
      let n;
      if (i === 0) n = nrm(p[0], p[1]);
      else if (i === p.length - 1) n = nrm(p[i - 1], p[i]);
      else {
        const n1 = nrm(p[i - 1], p[i]), n2 = nrm(p[i], p[i + 1]);
        let mx = n1[0] + n2[0], my = n1[1] + n2[1];
        const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
        const k = Math.max(0.5, mx * n1[0] + my * n1[1]);
        n = [mx / k, my / k];
      }
      out.push([p[i][0] + n[0] * d, p[i][1] + n[1] * d]);
    }
    return out;
  }
  function slicePoly(p, c, s0, s1) {
    const out = [atS(p, c, s0).slice(0, 2)];
    for (let i = 1; i < p.length - 1; i++) if (c[i] > s0 + 0.5 && c[i] < s1 - 0.5) out.push(p[i]);
    out.push(atS(p, c, s1).slice(0, 2));
    return out;
  }
  function projectS(p, c, q) {
    let best = 1e18, bs = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], ay = p[i][1], dx = p[i + 1][0] - ax, dy = p[i + 1][1] - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / l2));
      const d = Math.hypot(ax + dx * t - q[0], ay + dy * t - q[1]);
      if (d < best) { best = d; bs = c[i] + t * Math.sqrt(l2); }
    }
    return bs;
  }
  function smooth(pts, n) {
    n = n || 8;
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map((j) => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  // ----------------------------------------------------------- builder
  function buildMap(opts) {
    const rbts = new Set(), rbt2 = new Set();
    for (const e of ((opts && opts.roundabouts) || [])) { const [id, k] = String(e).split('#'); rbts.add(id); if (k === '2') rbt2.add(id); }
    const nodes = {}, nodeList = [], links = [], specs = [];
    const node = (id, x, y, type, o) => {
      const n = Object.assign({ id, x, y, type, hw: 0, box: 0, in: [], out: [], uturn: false, moves: 0, st: [0, 0], ph: 0, tm: 0, off: 0 }, o || {});
      nodes[id] = n; nodeList.push(n); return n;
    };
    const halfWidth = (k) => (KINDS[k].gap / 2 + KINDS[k].lanes * LW);
    const hwOf = (kind, twoWay) => (twoWay ? KINDS[kind].gap / 2 + KINDS[kind].lanes * LW : KINDS[kind].lanes * LW / 2);

    // carriageway: polyline already oriented/offset; stations are node ids with
    // optional explicit arc 's' (otherwise projected from the node position)
    function carriageway(poly, stations, props) {
      specs.push({ poly, stations, props });
    }

    function twoWay(base, ids, kind, extra) {
      const d = KINDS[kind].gap / 2 + KINDS[kind].lanes * LW / 2;
      const fwd = offsetPoly(base, d);
      const bwd = offsetPoly(base.slice().reverse(), d);
      return { fwd, bwd, d };
    }

    // ---------- nodes
    // gates
    const gate = (id, x, y) => node(id, x, y, 'gate');
    gate('gW', 0, HWY); gate('gE', WORLD.w, HWY);
    for (const y of AVENUES) { gate('aW' + y, 0, y); gate('aE' + y, WORLD.w, y); }
    for (const x of INTERCHANGES) gate('gN' + x, x, 0);
    for (const x of COLS) gate('gS' + x, x, WORLD.h);

    // signalised grid
    for (const y of AVENUES) {
      for (const x of COLS) {
        const id = `J${x}_${y}`;
        const eligible = !INTERCHANGES.includes(x) || false;
        if (rbts.has(id) && eligible) node(id, x, y, 'round', { box: rbt2.has(id) ? 42 : 32, rl: rbt2.has(id) ? 2 : 1 });
        else node(id, x, y, 'signal', { uturn: LOCAL_COLS.includes(x) });
      }
    }
    // bridge nodes on avenues
    for (const y of AVENUES) {
      const rx = riverX(y);
      node(`bA${y}a`, rx - 70, y, 'plain');
      node(`bA${y}b`, rx + 70, y, 'plain');
    }
    // interchange terminals and overpass nodes
    for (const X of INTERCHANGES) {
      node(`TN${X}`, X, HWY - 75, 'signal');
      node(`TS${X}`, X, HWY + 75, 'signal');
      node(`pN${X}`, X, HWY - 30, 'plain');
      node(`pS${X}`, X, HWY + 30, 'plain');
    }

    // ---------- highway
    const hwBase = [[0, HWY], [WORLD.w, HWY]];
    const hwd = KINDS.hw.gap / 2 + KINDS.hw.lanes * LW / 2; // 8.25
    const ebPoly = offsetPoly(hwBase, hwd);
    const wbPoly = offsetPoly(hwBase.slice().reverse(), hwd);
    const ebY = HWY + hwd, wbY = HWY - hwd;
    const rcx = (X) => X; // readability
    const bridgeX = [riverX(HWY) - 100, riverX(HWY) + 100];
    const ebSt = [{ id: 'gW', s: 0 }];
    const wbSt = [{ id: 'gE', s: 0 }];
    const ebList = [], wbList = [];
    for (const X of INTERCHANGES) {
      ebList.push([X - 300, `DE${X}`, 'diverge', 25], [X + 340, `ME${X}`, 'merge', 25]);
      wbList.push([X + 300, `DW${X}`, 'diverge', 25], [X - 340, `MW${X}`, 'merge', 25]);
    }
    ebList.push([bridgeX[0], 'bHE0', 'plain', 3], [bridgeX[1], 'bHE1', 'plain', 3]);
    wbList.push([bridgeX[0], 'bHW0', 'plain', 3], [bridgeX[1], 'bHW1', 'plain', 3]);
    ebList.sort((a, b) => a[0] - b[0]);
    wbList.sort((a, b) => b[0] - a[0]);
    for (const [x, id, type, box] of ebList) { node(id, x, ebY, type, { box, hwy: true }); ebSt.push({ id }); }
    for (const [x, id, type, box] of wbList) { node(id, x, wbY, type, { box, hwy: true }); wbSt.push({ id }); }
    ebSt.push({ id: 'gE', s: Infinity }); wbSt.push({ id: 'gW', s: Infinity });
    carriageway(ebPoly, ebSt, { kind: 'hw', bridges: ['bHE0>bHE1'], name: 'Highway EB' });
    carriageway(wbPoly, wbSt, { kind: 'hw', bridges: ['bHW1>bHW0'], name: 'Highway WB' });

    // ---------- interchange ramps (diamond). W side is the 180 degree rotation of E.
    const bT = halfWidth('art') + 4; // terminal box
    const rot = (X, pts) => pts.map(([x, y]) => [2 * X - x, 2 * HWY - y]);
    const ramps = [];
    for (const X of INTERCHANGES) {
      const ry = ebY + 7;
      const ro = ebY + 8.75;
      const off = [[X - 275, ro], [X - 215, ro + 3], [X - 150, ro + 17], [X - 105, ro + 41], [X - 75, ro + 55], [X - 50, HWY + 75], [X - bT, HWY + 75]];
      const on = [[X + bT, HWY + 75], [X + 50, HWY + 75], [X + 85, HWY + 68], [X + 130, ry + 33], [X + 190, ry + 7], [X + 240, ry + 1], [X + 315, ry]];
      ramps.push({ pts: smooth(off, 6), from: `DE${X}`, to: `TS${X}`, id: `offE${X}`, lanes: 2 });
      ramps.push({ pts: smooth(on, 6), from: `TS${X}`, to: `ME${X}`, id: `onE${X}` });
      ramps.push({ pts: smooth(rot(X, off), 6), from: `DW${X}`, to: `TN${X}`, id: `offW${X}`, lanes: 2 });
      ramps.push({ pts: smooth(rot(X, on), 6), from: `TN${X}`, to: `MW${X}`, id: `onW${X}` });
    }

    // ---------- arterials (interchange streets): north gate -> terminals -> grid -> south gate
    for (const X of INTERCHANGES) {
      const base = [[X, 0], [X, WORLD.h]];
      const st = [`gN${X}`, `TN${X}`, `pN${X}`, `pS${X}`, `TS${X}`, ...AVENUES.map((y) => `J${X}_${y}`), `gS${X}`];
      specs.push({ twoWay: true, base, ids: st, props: { kind: 'art', bridges: [`pN${X}>pS${X}`], name: 'Arterial' } });
    }
    // ---------- local streets
    for (const x of COLS) {
      if (INTERCHANGES.includes(x)) continue;
      const base = [[x, AVENUES[0]], [x, WORLD.h]];
      const st = [...AVENUES.map((y) => `J${x}_${y}`), `gS${x}`];
      specs.push({ twoWay: true, base, ids: st, props: { kind: 'loc', name: 'Street' } });
    }
    // ---------- avenues (with river bridge)
    for (const y of AVENUES) {
      const base = [[0, y], [WORLD.w, y]];
      const st = [`aW${y}`];
      for (const x of COLS) {
        if (x > riverX(y) && !st.includes(`bA${y}b`)) { st.push(`bA${y}a`, `bA${y}b`); }
        st.push(`J${x}_${y}`);
      }
      st.push(`aE${y}`);
      specs.push({ twoWay: true, base, ids: st, props: { kind: 'art', bridges: [`bA${y}a>bA${y}b`], name: 'Avenue' } });
    }

    // ---------- node boxes
    const touch = (id, hwv) => { const n = nodes[id]; if (n) n.hw = Math.max(n.hw, hwv); };
    for (const sp of specs) {
      const kind = sp.props.kind;
      const hv = sp.twoWay ? halfWidth(kind) : hwOf(kind, false);
      const ids = sp.stations ? sp.stations.map((s) => s.id) : sp.ids;
      for (const id of ids) touch(id, hv);
    }
    for (const r of ramps) { touch(r.from, 1.75 * (r.lanes || 1)); touch(r.to, 1.75 * (r.lanes || 1)); }
    for (const n of nodeList) {
      if (n.type === 'signal') n.box = n.hw + 5;
      else if (n.type === 'plain' && !n.box) n.box = 3;
      else if (n.type === 'gate') n.box = 0;
    }

    // ---------- link construction
    const rev = {};
    function addLink(from, to, pts, props) {
      const c = cumLen(pts);
      const k = KINDS[props.kind];
      const L = {
        id: links.length, from: nodes[from], to: nodes[to], pts, cum: c, len: c[c.length - 1],
        kind: props.kind, lanes: props.lanes || k.lanes, vmax: props.vmax || k.vmax, bridge: !!props.bridge,
        name: props.name || '', moves: [], lanesArr: null, twoWay: !!props.twoWay,
      };
      L.w = props.width || L.lanes * LW;
      const h0 = atS(pts, c, 0), h1 = atS(pts, c, L.len);
      L.h0 = [h0[2], h0[3]]; L.h1 = [h1[2], h1[3]];
      L.group = Math.abs(L.h1[0]) > Math.abs(L.h1[1]) ? 0 : 1;
      links.push(L);
      L.from.out.push(L); L.to.in.push(L);
      return L;
    }
    function build(poly, stations, props, bridgeSet) {
      const cl = cumLen(poly);
      const arcs = stations.map((s, i) => {
        if (s.s === 0) return 0;
        if (s.s === Infinity) return cl[cl.length - 1];
        return projectS(poly, cl, [nodes[s.id].x, nodes[s.id].y]);
      });
      for (let i = 0; i < stations.length - 1; i++) {
        const a = nodes[stations[i].id], b = nodes[stations[i + 1].id];
        const s0 = arcs[i] + (a.type === 'gate' ? 0 : a.box);
        const s1 = arcs[i + 1] - (b.type === 'gate' ? 0 : b.box);
        if (s1 - s0 < 4) continue;
        const key = `${a.id}>${b.id}`;
        const br = bridgeSet && bridgeSet.has(key);
        addLink(a.id, b.id, slicePoly(poly, cl, s0, s1), Object.assign({}, props, { bridge: br }));
      }
    }
    for (const sp of specs) {
      const bs = new Set(sp.props.bridges || []);
      const rbs = new Set((sp.props.bridges || []).map((k) => k.split('>').reverse().join('>')));
      if (sp.twoWay) {
        const kind = sp.props.kind, d = KINDS[kind].gap / 2 + KINDS[kind].lanes * LW / 2;
        const fwd = offsetPoly(sp.base, d), bwd = offsetPoly(sp.base.slice().reverse(), d);
        const ids = sp.ids;
        // keep node position in sync with base: nodes already sit on base
        build(fwd, ids.map((id) => ({ id })).map((s, i, a) => (i === 0 ? { id: s.id, s: 0 } : i === a.length - 1 ? { id: s.id, s: Infinity } : s)), Object.assign({ twoWay: true }, sp.props), bs);
        const rids = ids.slice().reverse();
        build(bwd, rids.map((id) => ({ id })).map((s, i, a) => (i === 0 ? { id: s.id, s: 0 } : i === a.length - 1 ? { id: s.id, s: Infinity } : s)), Object.assign({ twoWay: true }, sp.props), rbs);
      } else build(sp.poly, sp.stations, sp.props, new Set((sp.props.bridges || [])));
    }
    for (const r of ramps) addLink(r.from, r.to, r.pts, { kind: 'ramp', name: 'Ramp', lanes: r.lanes });

    // ---------- reverse pairs
    for (const L of links) {
      for (const M of links) if (M.from === L.to && M.to === L.from) { L.rev = M; break; }
    }

    // ---------- roundabouts: replace a junction by a one-way ring with yield entries
    const nodeFn = node;
    for (const J of nodeList.filter((n) => n.type === 'round')) {
      const items = [];
      for (const A of J.in) {
        const e = atS(A.pts, A.cum, A.len), w = [e[0] - J.x, e[1] - J.y], wh = w[0] * e[2] + w[1] * e[3];
        const RR = J.rl === 2 ? RING_R2 : RING_R, disc = wh * wh - (w[0] * w[0] + w[1] * w[1] - RR * RR), t = -wh - Math.sqrt(Math.max(0, disc));
        const x = e[0] + e[2] * t, y = e[1] + e[3] * t;
        items.push({ ang: Math.atan2(y - J.y, x - J.x), x, y, link: A, entry: true });
      }
      for (const B of J.out) {
        const q = atS(B.pts, B.cum, 0), w = [q[0] - J.x, q[1] - J.y], wh = w[0] * q[2] + w[1] * q[3];
        const RR = J.rl === 2 ? RING_R2 : RING_R, disc = wh * wh - (w[0] * w[0] + w[1] * w[1] - RR * RR), t = wh - Math.sqrt(Math.max(0, disc));
        const x = q[0] - q[2] * t, y = q[1] - q[3] * t;
        items.push({ ang: Math.atan2(y - J.y, x - J.x), x, y, link: B, entry: false });
      }
      items.sort((a, b) => b.ang - a.ang);
      const RR0 = J.rl === 2 ? RING_R2 : RING_R;
      const ids = items.map((it, k) => {
        const n = nodeFn(`${J.id}r${k}`, it.x, it.y, it.entry ? 'rin' : 'rex', { box: 0, ring: J.id });
        return n;
      });
      J.in = []; J.out = [];
      const ringLinks = [];
      for (let k = 0; k < items.length; k++) {
        const a0 = items[k].ang, a1 = items[(k + 1) % items.length].ang;
        let d = a0 - a1; if (d <= 1e-6) d += 2 * Math.PI;
        const n = Math.max(2, Math.ceil(d / 0.12)), pts = [];
        for (let i = 0; i <= n; i++) { const a = a0 - d * i / n; pts.push([J.x + RR0 * Math.cos(a), J.y + RR0 * Math.sin(a)]); }
        ringLinks.push(addLink(ids[k].id, ids[(k + 1) % items.length].id, pts, { kind: 'ring', lanes: J.rl || 1, width: J.rl === 2 ? 8.6 : 5.6 }));
      }
      items.forEach((it, k) => {
        const n = ids[k];
        if (it.entry) {
          const A = it.link; A.to = n; n.in.push(A);
          n.yieldIn = A; n.mainIn = ringLinks[(k - 1 + items.length) % items.length];
        } else { const B = it.link; B.from = n; n.out.push(B); }
      });
      J.ringIds = ids.map((n) => n.id);
      J.ringLinks = ringLinks;
      for (const n of ids) n.ringNode = J;
    }

    // ---------- movements
    const ang = (a, b) => Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    for (const n of nodeList) {
      if (n.type === 'gate') continue;
      for (const A of n.in) {
        for (const B of n.out) {
          const isU = A.rev === B;
          const th = ang(A.h1, B.h0);
          const ad = Math.abs(th);
          let kind;
          if (isU) kind = 'u'; else if (ad < 0.6) kind = 'straight'; else if (th > 0) kind = 'right'; else kind = 'left';
          if (ad > 2.6 && !isU) continue;
          if (isU && !n.uturn) continue;
          if (A.kind === 'ramp' && B.kind === 'ramp') continue;
          if (n.type !== 'signal' && ad > (n.type === 'rin' || n.type === 'rex' ? 2.0 : 1.2)) continue;
          if (n.type === 'signal' && A.kind === 'hw') continue;
          const mv = { from: A, to: B, kind, node: n };
          if (A.kind === 'hw' && B.kind === 'ramp') mv.kind = 'exit';
          if (A.kind === 'ramp' && B.kind === 'hw') mv.kind = 'merge';
          A.moves.push(mv);
          n.moves++;
        }
      }
    }
    // lane masks, out lanes, connector geometry
    const laneOff = (L, l) => ((L.lanes - 1) / 2 - l) * LW; // lane 0 is rightmost
    for (const L of links) {
      for (const mv of L.moves) {
        const A = mv.from, B = mv.to;
        mv.mask = [];
        mv.outLane = [];
        for (let l = 0; l < A.lanes; l++) {
          let ok = true, ol;
          if (A.kind === 'ring' || B.kind === 'ring') { mv.mask.push(true); mv.outLane.push(Math.min(l, B.lanes - 1)); continue; }
          switch (mv.kind) {
            case 'left': ok = l === A.lanes - 1; ol = B.lanes - 1; break;
            case 'right': ok = l === 0; ol = 0; break;
            case 'u': ok = l === A.lanes - 1; ol = B.lanes - 1; break;
            case 'exit': ok = l === 0; ol = 0; break;
            case 'merge': ok = true; ol = 0; break;
            default: ol = Math.min(l, B.lanes - 1);
          }
          mv.mask.push(ok); mv.outLane.push(ol);
        }
        const p0 = atS(A.pts, A.cum, A.len), p1 = atS(B.pts, B.cum, 0);
        const c0 = [p0[0], p0[1]], c1 = [p1[0], p1[1]];
        const chord = dist(c0, c1);
        mv.h0 = [p0[2], p0[3]]; mv.h1 = [p1[2], p1[3]];
        mv.chord = chord;
        let k = chord * 0.4;
        if (mv.kind === 'u') k = chord * 0.55 + 6;
        mv.k = k;
        // arc length of centre-line connector, sampled
        let len = 0, prev = c0;
        for (let i = 1; i <= 10; i++) {
          const t = i / 10, q = bezier(c0, [c0[0] + mv.h0[0] * k, c0[1] + mv.h0[1] * k], [c1[0] - mv.h1[0] * k, c1[1] - mv.h1[1] * k], c1, t);
          len += dist(prev, q); prev = q;
        }
        mv.len = Math.max(2, len);
        mv.pen = { straight: 0, right: 2, left: 5, u: 22, exit: 0, merge: 0 }[mv.kind] || 0;
      }
    }

    // ---------- merge nodes: main + ramp inputs
    for (const n of nodeList) {
      if (n.type === 'merge') {
        n.mainIn = n.in.find((l) => l.kind === 'hw');
        n.rampIn = n.in.find((l) => l.kind === 'ramp');
        n.yieldIn = n.rampIn;
      }
    }

    // ---------- hw chains for charts / VSL
    for (const L of links) {
      if (L.kind !== 'hw') continue;
      const nxt = L.moves.find((m) => m.to.kind === 'hw' && m.kind === 'straight');
      L.nextMain = nxt ? nxt.to : null;
    }
    const chain = (startId) => {
      const first = links.find((l) => l.kind === 'hw' && l.from.id === startId);
      const out = []; let off = 0, cur = first;
      while (cur) { out.push({ link: cur, off }); off += cur.len + 50; cur = cur.nextMain; }
      return { list: out, total: off };
    };
    const hwChain = chain('gW');

    // ---------- land use zones (trip origins/destinations with curb parking) and bus stops
    const zoneAt = (x, y) => {
      if (x > 1000 && x < 2200 && y > 480 && y < 1010) return 'down';
      if (y <= 770) return 'work';
      return 'res';
    };
    const zones = { res: [], work: [], down: [], shop: [] };
    for (const L of links) {
      if (L.kind !== 'art' && L.kind !== 'loc') continue;
      if (L.bridge || L.len < 90 || (L.from.type === 'gate' && L.to.type === 'gate')) continue;
      const mid = atS(L.pts, L.cum, L.len / 2);
      let z = zoneAt(mid[0], mid[1]);
      if (z === 'down' && L.kind === 'art' && Math.abs(L.h1[0]) > Math.abs(L.h1[1])) z = 'shop';
      L.zone = z;
      zones[z].push(L);
      L.parkable = true;
    }
    for (const L of links) {
      if (L.kind !== 'art' || L.bridge || L.len < 170 || L.from.type === 'gate' && L.to.type === 'gate') continue;
      L.stopS = L.len * 0.55;
      if (Math.abs(L.h1[0]) > Math.abs(L.h1[1]) && L.lanes >= 2) L.busLaneOK = true;
    }
    return { nodes, nodeList, links, hwChain, zones, zoneAt, riverX, RIVER_W, WORLD, KINDS, LW, HWY, INTERCHANGES, AVENUES, COLS, laneOff };
  }

  function bezier(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  }

  // ------------------------------------------------------------ decor
  function buildDecor(map) {
    const { links, WORLD: W } = map;
    // spatial hash of road samples
    const CELL = 60, hash = new Map();
    const put = (x, y, r) => {
      const k = ((x / CELL) | 0) + ',' + ((y / CELL) | 0);
      let a = hash.get(k); if (!a) hash.set(k, (a = [])); a.push([x, y, r]);
    };
    for (const L of links) {
      const r = (L.lanes * LW) / 2 + (L.kind === 'hw' ? 16 : L.twoWay ? 14 : 8);
      for (let s = 0; s <= L.len; s += 10) { const p = atS(L.pts, L.cum, s); put(p[0], p[1], r); }
      for (const mv of L.moves) {
        const A = mv.from, B = mv.to;
        const p0 = atS(A.pts, A.cum, A.len), p1 = atS(B.pts, B.cum, 0);
        put((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, 18);
      }
    }
    for (const n of map.nodeList) put(n.x, n.y, n.box + 12);
    const near = (x, y, rad) => {
      const cx = (x / CELL) | 0, cy = (y / CELL) | 0, reach = Math.ceil((rad + 40) / CELL);
      for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
        const a = hash.get((cx + i) + ',' + (cy + j));
        if (a) for (const q of a) if (Math.hypot(q[0] - x, q[1] - y) < q[2] + rad) return true;
      }
      return false;
    };
    // seeded rng
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const parks = [[690, 800, 340, 170], [1040, 1040, 330, 270], [2250, 790, 280, 170], [90, 560, 130, 160]];
    const inPark = (x, y, w, h) => parks.some((p) => x + w > p[0] && x < p[0] + p[2] && y + h > p[1] && y < p[1] + p[3]);
    const buildings = [];
    const riverGap = (x, y) => Math.abs(x - map.riverX(y)) < map.RIVER_W / 2 + 18;
    for (let gy = 8; gy < W.h - 30; gy += 46) {
      for (let gx = 8; gx < W.w - 30; gx += 46) {
        const w = 24 + rnd() * 22, h = 24 + rnd() * 22;
        const x = gx + rnd() * 6, y = gy + rnd() * 6;
        if (y > 180 && y < 372 && x > 0) continue; // highway corridor stays open
        if (riverGap(x + w / 2, y + h / 2) || riverGap(x, y) || riverGap(x + w, y + h)) continue;
        if (inPark(x, y, w, h)) continue;
        const rad = Math.max(w, h) * 0.62;
        if (near(x + w / 2, y + h / 2, rad)) continue;
        const tall = rnd();
        buildings.push({ x, y, w, h, z: tall < 0.1 ? 3 : tall < 0.4 ? 2 : 1, tone: rnd(), zone: map.zoneAt(x + w / 2, y + h / 2) });
      }
    }
    // trees along the highway corridor and parks
    const trees = [];
    for (let i = 0; i < 520; i++) {
      const x = rnd() * W.w, y = rnd() < 0.5 ? 120 + rnd() * 80 : 330 + rnd() * 40;
      if (riverGap(x, y) || near(x, y, 7)) continue;
      trees.push([x, y, 3 + rnd() * 3]);
    }
    for (const p of parks) for (let i = 0; i < 28; i++) {
      const x = p[0] + 8 + rnd() * (p[2] - 16), y = p[1] + 8 + rnd() * (p[3] - 16);
      trees.push([x, y, 3 + rnd() * 4]);
    }
    // river polyline
    const river = [];
    for (let y = -40; y <= W.h + 40; y += 20) river.push([map.riverX(y), y]);
    return { buildings, trees, parks, river };
  }

  const api = { DEFAULT_ROUNDABOUTS, RING_R, RING_R2, buildMap, buildDecor, bezier, atS, LW, KINDS, WORLD, HWY, riverX, RIVER_W, INTERCHANGES, AVENUES, COLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MetroMap = api;
})(typeof self !== 'undefined' ? self : this);
