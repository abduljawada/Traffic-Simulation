'use strict';
/*
 * Network traffic engine on the Metro map.
 * IDM car following, MOBIL lane changing with route-driven mandatory changes,
 * signalised junctions (fixed / coordinated / adaptive), ramp merges with
 * gap acceptance and optional metering, U-turns, curbside disruptions,
 * breakdowns, cruising for parking, trucks, cost-based routing with optional
 * live rerouting. No DOM access.
 */
(function (root) {
  const MetroMap = typeof require !== 'undefined' ? require('./map.js') : root.MetroMap;

  const TYPES = {
    h: { a: 1.0, b: 1.6, s0: 2, len: 4.5, T: null },
    t: { a: 0.7, b: 1.5, s0: 2.5, len: 9.5, T: 1.7 },
    c: { a: 1.5, b: 2.0, s0: 2, len: 4.5, T: 0.9 },
  };
  const LAG = { hw: 1.4, ramp: 1.0, art: 0.8, loc: 0.6, ring: 0.6 }, CLAG = 0.15;
  const YELLOW = 3, ALLRED = 1.2, MIN_GREEN = 7, MAX_GREEN = 45;
  const LW = 3.5, LAT_RATE = 1.6; // lane width, lateral speed during a lane change (m/s)
  const BIN = 100; // metres per speed bin (VSL)
  const WBIN = 50; // space-time bin

  const DEFAULTS = {
    demand: 70, hwShare: 0.35, tidal: 0.35, noise: 0.7, headway: 1.5, limit: 110, cruising: 0.15,
    signal: 'fixed', cycle: 70, metering: false, vsl: false, cacc: 0, reroute: false,
    transit: 0, flex: 0, rubber: true, trucks: 0.08,
    roundabouts: MetroMap.DEFAULT_ROUNDABOUTS,
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function idm(v, v0, s, dv, P, T) {
    const q = v / v0, q2 = q * q;
    const free = 1 - q2 * q2;
    if (s === null) return P.a * free;
    const sStar = P.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(P.a * P.b)));
    const r = sStar / Math.max(s, 0.1);
    return P.a * (free - r * r);
  }

  class Net {
    constructor(opts, seed) {
      this.p = Object.assign({}, DEFAULTS, opts || {});
      this.seed = seed || 1;
      this.map = MetroMap.buildMap({ roundabouts: this.p.roundabouts });
      this.links = this.map.links;
      this.nodes = this.map.nodeList;
      this.sources = this.nodes.filter((n) => n.type === 'gate' && n.out.length);
      this.sinks = this.nodes.filter((n) => n.type === 'gate' && n.in.length);
      this.reset();
    }

    // ------------------------------------------------------------ setup
    reset() {
      const p = this.p;
      this.rand = mulberry32(this.seed);
      this.t = 0; this.nextId = 1; this.lastSec = 0; this.moveCount = {};
      this.done = []; this.hist = []; this.wave = []; this.hwCross = [];
      for (const L of this.links) {
        L.lanesArr = Array.from({ length: L.lanes }, () => []);
        L.vmaxBase = L.vmax;
        L.vlim = L.kind === 'hw' ? p.limit / 3.6 : L.vmax;
        L.vAvg = L.vlim; L.ratio = 1; L.obs = null; L.block = null; L.n = 0;
        if (L.kind === 'hw') { L.vsl = new Array(Math.ceil(L.len / BIN)).fill(L.vlim); L.segV = new Array(L.vsl.length).fill(L.vlim); L.segN = new Array(L.vsl.length).fill(0); }
      }
      for (const n of this.nodes) { n.st = [0, 0]; n.ph = 0; n.tm = 0; n.meterNext = 0; n.slow = false; n.r = this.rand(); n.backlog = 0; }
      this.offsets();
      this._weights();
      this.routes0 = this._route(false);
      this.routes = this.routes0;
      this.lastRoute = 0;
      this.stats = { n: 0, hwV: 30, cityV: 12, eff: 12, idle: 0, tpm: 0, delay: 1, backlog: 0, hwFlow: 0, hwN: 0 };
      // detector links for hw flow
      this.det = [this.links.find((l) => l.kind === 'hw' && l.from.id === 'gW'), this.links.find((l) => l.kind === 'hw' && l.from.id === 'gE')];
      for (const [id, s] of (p.obstacles || [])) this.setObstacle(this.links[id], s);
      for (const [id, s] of (p.blocks || [])) this.links[id].block = s;
    }

    offsets() {
      const cyc = this.p.cycle, vprog = 11;
      for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        n.off = this.p.signal === 'sync' ? (((-(n.x + n.y) / vprog) % cyc) + cyc) % cyc : n.r * cyc;
      }
    }

    _weights() {
      const t = this.p.tidal, hs = this.p.hwShare;
      const wo = [], wd = [];
      for (const g of this.sources) {
        const west = g.x < 1 || (g.id[0] === 'g' && g.id[1] === 'N');
        const hw = g.id === 'gW' || g.id === 'gE';
        let o = hw ? 1 : (g.id[0] === 'a' ? 1.2 : 1);
        o *= west || g.y < 1 ? 1 + 1.2 * t : 1 - 0.6 * t;
        wo.push({ g, w: o, hw });
      }
      for (const g of this.sinks) {
        const west = g.x < 1 || g.y < 1;
        let d = (g.id === 'gW' || g.id === 'gE' ? 1.5 : 1);
        d *= west ? 1 - 0.6 * t : 1 + 1.2 * t;
        wd.push({ g, w: d });
      }
      const sumHw = wo.filter((x) => x.hw).reduce((s, x) => s + x.w, 0);
      const sumCity = wo.filter((x) => !x.hw).reduce((s, x) => s + x.w, 0);
      for (const x of wo) x.pr = x.hw ? hs * x.w / sumHw : (1 - hs) * x.w / sumCity;
      this.wo = wo; this.wd = wd; this.wdSum = wd.reduce((s, x) => s + x.w, 0);
    }

    // ---------------------------------------------------------- routing
    _tt(L, dynamic) {
      const v = dynamic ? Math.max(2, Math.min(L.vlim, L.vAvg)) : L.vlim * 0.92;
      return L.len / v + (L.to.type === 'signal' ? 8 : L.to.type === 'rin' ? 3 : 0);
    }

    _route(dynamic) {
      const nl = this.links.length, out = new Map();
      const tt = this.links.map((L) => this._tt(L, dynamic));
      const preds = Array.from({ length: nl }, () => []);
      for (const L of this.links) for (const mv of L.moves) preds[mv.to.id].push([L, mv]);
      for (const g of this.sinks) {
        const dist = new Float64Array(nl).fill(Infinity), done = new Uint8Array(nl);
        for (const L of g.in) dist[L.id] = tt[L.id];
        for (;;) {
          let u = -1, best = Infinity;
          for (let i = 0; i < nl; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
          if (u < 0) break;
          done[u] = 1;
          for (const [P, mv] of preds[u]) {
            const c = tt[P.id] + mv.pen + mv.len / 6 + dist[u];
            if (c < dist[P.id]) dist[P.id] = c;
          }
        }
        out.set(g.id, dist);
      }
      return out;
    }

    _pick(c, L) {
      if (L.to.type === 'gate') { c.next = null; return; }
      const moves = L.moves;
      if (!moves.length) { c.next = null; return; }
      if (c.wander > 0 && L.to.type === 'signal' && L.kind !== 'hw' && L.kind !== 'ramp') {
        c.wander--;
        const opts = moves.filter((m) => m.kind !== 'exit' && m.kind !== 'merge' && m.kind !== 'u');
        if (opts.length) { c.next = opts[(this.rand() * opts.length) | 0]; return; }
      }
      this._choose(c, moves, -1);
    }

    _choose(c, moves, lane) {
      const dist = this.routes.get(c.dest.id);
      let best = null, bc = Infinity;
      const costs = [];
      for (const mv of moves) {
        if (lane >= 0 && !mv.mask[lane]) { costs.push(Infinity); continue; }
        const cost = dist[mv.to.id] + mv.pen + mv.len / 6;
        costs.push(cost);
        if (cost < bc) { bc = cost; best = mv; }
      }
      if (!best) { // no allowed move for this lane: relax the lane rule
        if (lane >= 0) return this._choose(c, moves, -1);
        c.next = moves[0]; return;
      }
      const theta = 6;
      let tot = 0; const w = costs.map((x) => { const v = x === Infinity ? 0 : Math.exp(-(x - bc) / theta); tot += v; return v; });
      let r = this.rand() * tot;
      for (let i = 0; i < moves.length; i++) { r -= w[i]; if (r <= 0) { c.next = moves[i]; return; } }
      c.next = best;
    }

    _replan(c, L) { this._choose(c, L.moves, c.lane); }

    // -------------------------------------------------------- parameters
    set(key, val) {
      if (this.p[key] === val) return;
      this.p[key] = val;
      if (key === 'limit') { for (const L of this.links) if (L.kind === 'hw') L.vlim = val / 3.6; }
      else if (key === 'signal' || key === 'cycle') { this.offsets(); for (const n of this.nodes) { n.ph = 0; n.tm = 0; } }
      else if (key === 'cacc') this.forEachCar((c) => { if (!c.isObs && c.type !== 't') { c.type = this.rand() < val ? 'c' : 'h'; } });
      else if (key === 'tidal' || key === 'hwShare') this._weights();
      else if (key === 'reroute') { this.routes = val ? this._route(true) : this.routes0; this.lastRoute = this.t; }
    }

    forEachCar(fn) {
      for (const L of this.links) for (const arr of L.lanesArr) for (const c of arr) fn(c, L);
    }

    get demandEff() { return this.p.demand * (1 - this.p.transit) * (1 - this.p.flex); }

    // ------------------------------------------------------ disruptions
    setObstacle(L, s) {
      if (L.lanes < 2 || L.obs) return;
      const o = { id: this.nextId++, link: L, lane: 0, s, v: 0, a: 0, at: 0, len: 4.5, isObs: true, type: 'x' };
      L.obs = o;
      const arr = L.lanesArr[0];
      for (let i = arr.length - 1; i >= 0; i--) if (Math.abs(arr[i].s - s) < 12 && !arr[i].isObs) arr.splice(i, 1);
      this._insert(arr, o);
    }
    clearObstacle(L) {
      if (!L.obs) return;
      const arr = L.lanesArr[0], i = arr.indexOf(L.obs);
      if (i >= 0) arr.splice(i, 1);
      L.obs = null;
    }
    toggleDisruption(L, s) {
      if (L.kind === 'ramp' || L.to.type === 'gate' && L.from.type === 'gate') return;
      s = Math.max(20, Math.min(L.len - 25, s));
      if (L.lanes >= 2) { if (L.obs) this.clearObstacle(L); else this.setObstacle(L, s); }
      else L.block = L.block === null ? s : null;
    }
    disruptions() {
      const obstacles = [], blocks = [];
      for (const L of this.links) { if (L.obs) obstacles.push([L.id, L.obs.s]); if (L.block !== null) blocks.push([L.id, L.block]); }
      return { obstacles, blocks };
    }
    clearDisruptions() { for (const L of this.links) { this.clearObstacle(L); L.block = null; } }
    randomDisruptions(k, kinds) {
      const cand = this.links.filter((l) => !l.obs && l.block === null && l.kind !== 'ramp' && l.kind !== 'hw' && l.len > 80 && l.to.type !== 'gate' && l.from.type !== 'gate' && (!kinds || kinds.includes(l.kind)));
      for (let i = 0; i < k && cand.length; i++) {
        const l = cand.splice((this.rand() * cand.length) | 0, 1)[0];
        this.toggleDisruption(l, l.len * (0.35 + 0.3 * this.rand()));
      }
    }
    countDisruptions() { let n = 0; for (const L of this.links) if (L.obs || L.block !== null) n++; return n; }

    _insert(arr, c) {
      let i = arr.length;
      while (i > 0 && arr[i - 1].s < c.s) i--;
      arr.splice(i, 0, c);
    }

    // ---------------------------------------------------------- signals
    _signals(dt) {
      const p = this.p, cyc = p.cycle, lost = YELLOW + ALLRED;
      const g = Math.max(6, (cyc - 2 * lost) / 2);
      for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        if (p.signal === 'adaptive') { this._adaptive(n, dt); continue; }
        const u = (this.t + n.off) % cyc;
        if (u < g) n.st = [2, 0];
        else if (u < g + YELLOW) n.st = [1, 0];
        else if (u < g + lost) n.st = [0, 0];
        else if (u < 2 * g + lost) n.st = [0, 2];
        else if (u < 2 * g + lost + YELLOW) n.st = [0, 1];
        else n.st = [0, 0];
      }
    }

    _pressure(n, group) {
      let k = 0;
      for (const L of n.in) {
        if (L.group !== group) continue;
        for (const arr of L.lanesArr) for (const c of arr) { if (L.len - c.s < 55) k++; else break; }
      }
      return k;
    }

    _adaptive(n, dt) {
      const PH = [[2, 0], [1, 0], [0, 0], [0, 2], [0, 1], [0, 0]];
      n.tm += dt;
      if (n.ph === 0 || n.ph === 3) {
        const cur = n.ph === 0 ? 0 : 1;
        if (n.tm >= MIN_GREEN) {
          const pc = this._pressure(n, cur), po = this._pressure(n, 1 - cur);
          if (po > 0 && (pc === 0 || po >= pc + 3 || n.tm >= MAX_GREEN)) { n.ph++; n.tm = 0; }
        }
      } else if (n.ph === 1 || n.ph === 4) {
        if (n.tm >= YELLOW) { n.ph++; n.tm = 0; }
      } else if (n.tm >= ALLRED) { n.ph = (n.ph + 1) % 6; n.tm = 0; }
      n.st = PH[n.ph];
    }

    // ---------------------------------------------------------- demand
    _spawn(dt) {
      const rate = this.demandEff / 60;
      for (const x of this.wo) {
        const g = x.g, lam = rate * x.pr;
        if (this.rand() < 1 - Math.exp(-lam * dt) && g.backlog < 60) g.backlog++;
        if (g.backlog <= 0) continue;
        const L = g.out[0];
        const r = this.rand();
        const type = r < this.p.trucks ? 't' : (this.rand() < this.p.cacc ? 'c' : 'h');
        const P = TYPES[type];
        let lane = -1, bestSpace = -1;
        for (let l = 0; l < L.lanes; l++) {
          const arr = L.lanesArr[l], rear = arr[arr.length - 1];
          const space = rear ? rear.s - rear.len : 1e9;
          if (space > bestSpace) { bestSpace = space; lane = l; }
        }
        if (bestSpace < P.len + 3) continue;
        let r2 = this.rand() * this.wdSum, dest = null;
        for (const d of this.wd) { r2 -= d.w; if (r2 <= 0) { dest = d.g; break; } }
        if (!dest || dest === g) continue;
        const arr = L.lanesArr[lane], rear = arr[arr.length - 1];
        const v0f = type === 't' ? 0.72 + 0.08 * this.rand() : 0.93 + 0.14 * this.rand();
        const c = {
          id: this.nextId++, link: L, lane, s: 0, v: Math.min(L.vlim * 0.6, rear && !rear.isObs ? rear.v + 2 : 12), a: 0, at: 0, len: P.len, type, v0f,
          next: null, mv: null, dest, t0: this.t, ff: this.routes0.get(dest.id)[L.id],
          wander: !x.hw && this.rand() < this.p.cruising ? 3 + ((this.rand() * 8) | 0) : 0,
          brakeUntil: 0, brakeA: 0, lcCool: 0, lat: 0, waitT: 0, gap: null, virt: false, isObs: false,
        };
        this._pick(c, L);
        arr.push(c);
        g.backlog--;
      }
    }

    // ---------------------------------------------------- lane changing
    _allowed(c, lane) { return !c.next || c.next.mask[lane]; }

    _lanes(dt) {
      const t = this.t;
      for (const L of this.links) {
        if (L.lanes < 2) continue;
        const H = L.kind === 'hw' ? 500 : 150;
        const snap = [];
        for (const arr of L.lanesArr) for (const c of arr) if (!c.isObs && c.s >= 0) snap.push(c);
        for (const c of snap) {
          if (t < c.lcCool || this.rand() > dt / 0.7) continue;
          const d = L.len - c.s;
          if (d < 6) continue;
          const arr = L.lanesArr[c.lane], k = arr.indexOf(c);
          if (k < 0) continue;
          const lead0 = k > 0 ? arr[k - 1] : null, fol0 = arr[k + 1] || null;
          const P = TYPES[c.type], T = c.type === 'h' ? this.p.headway : P.T;
          const v0 = L.vlim * c.v0f;
          const gap0 = lead0 ? lead0.s - lead0.len - c.s : null;
          const aOld = idm(c.v, v0, gap0, lead0 ? c.v - lead0.v : 0, P, T);
          const okNow = this._allowed(c, c.lane);
          let u = Math.max(0, Math.min(1, 1 - d / H));
          // nearest allowed lane direction
          let want = 0;
          if (!okNow && c.next) {
            let bd = 99;
            for (let l = 0; l < L.lanes; l++) if (c.next.mask[l] && Math.abs(l - c.lane) < bd) { bd = Math.abs(l - c.lane); want = Math.sign(l - c.lane); }
          }
          let best = -1, bestGain = 0.3;
          for (const dl of [-1, 1]) {
            const m = c.lane + dl;
            if (m < 0 || m >= L.lanes) continue;
            const arr2 = L.lanesArr[m];
            let i = 0;
            while (i < arr2.length && arr2[i].s > c.s) i++;
            const lead1 = i > 0 ? arr2[i - 1] : null, fol1 = arr2[i] || null;
            const gL = lead1 ? lead1.s - lead1.len - c.s : null;
            const gF = fol1 ? c.s - c.len - fol1.s : null;
            const need = okNow ? 2.5 : 1.5;
            if ((gL !== null && gL < need) || (gF !== null && gF < need)) continue;
            const aNew = idm(c.v, v0, gL, lead1 ? c.v - lead1.v : 0, P, T);
            let dOthers = 0;
            if (fol1 && !fol1.isObs) {
              const Pf = TYPES[fol1.type], Tf = fol1.type === 'h' ? this.p.headway : Pf.T;
              const aF = idm(fol1.v, L.vlim * fol1.v0f, gF, fol1.v - c.v, Pf, Tf);
              if (aF < -(4 + 3 * (okNow ? 0 : u))) continue;
              dOthers += aF - fol1.at;
            }
            if (fol0 && !fol0.isObs) {
              const Pf = TYPES[fol0.type], Tf = fol0.type === 'h' ? this.p.headway : Pf.T;
              const gN = lead0 ? lead0.s - lead0.len - fol0.s : null;
              dOthers += idm(fol0.v, L.vlim * fol0.v0f, gN, lead0 ? fol0.v - lead0.v : 0, Pf, Tf) - fol0.at;
            }
            let gain = (aNew - aOld) + 0.2 * dOthers + (dl < 0 ? (c.type === 't' ? 0.5 : 0.15) : (c.type === 't' ? -0.3 : 0));
            if (!okNow) gain += dl === want ? 1 + 6 * u : -100;
            else if (c.next && !c.next.mask[m] && d < H) gain = -100;
            if (gain > bestGain) { bestGain = gain; best = m; }
          }
          if (best >= 0) {
            arr.splice(k, 1);
            c.lat += (best - c.lane) * LW;
            c.lane = best; c.lcCool = t + (okNow ? 3.5 : 2.2);
            this._insert(L.lanesArr[best], c);
          }
        }
      }
    }

    // --------------------------------------------------------- dynamics
    _accel(dt) {
      const t = this.t, p = this.p;
      const noiseRate = p.noise / 60 * dt;
      for (const L of this.links) {
        const lag = LAG[L.kind];
        const obs = L.obs;
        for (let l = 0; l < L.lanes; l++) {
          const arr = L.lanesArr[l];
          for (let k = 0; k < arr.length; k++) {
            const c = arr[k];
            if (c.isObs) continue;
            const P = TYPES[c.type];
            const T = c.type === 'h' ? p.headway : P.T;
            let gap = null, vl = 0, virt = false, lead = null;
            let m = c.next;
            const d = L.len - c.s;
            // ---- desired speed
            let v0 = L.vlim * c.v0f;
            if (p.vsl && L.kind === 'hw' && c.s >= 0) v0 = Math.min(v0, L.vsl[Math.min(L.vsl.length - 1, (c.s / BIN) | 0)]);
            if (obs && p.rubber && c.type !== 'c' && c.lane !== obs.lane) { const dd = c.s - obs.s; if (dd > -150 && dd < 30) v0 *= 0.7; }
            if (L.block !== null) { const db = L.block - c.s; if (db > -8) v0 = Math.min(v0, Math.sqrt(6.25 + 4 * Math.max(0, db - 6))); }
            if (m) {
              let vt = m.to.vlim;
              if (m.kind === 'left') vt = Math.min(vt, 6.5);
              else if (m.kind === 'right') vt = Math.min(vt, 5.5);
              else if (m.kind === 'u') vt = 4;
              if (vt < v0) v0 = Math.min(v0, Math.sqrt(vt * vt + 4 * Math.max(0, d - 4)));
            }
            // ---- leader
            if (k > 0) {
              lead = arr[k - 1];
              gap = lead.s - lead.len - c.s; vl = lead.v;
            } else if (m) {
              const node = L.to;
              let stop = false;
              if (!m.mask[c.lane] && d < (L.kind === 'hw' ? 140 : 45)) { this._replan(c, L); m = c.next; }
              if (!m.mask[c.lane] && L.kind !== 'hw' && L.kind !== 'ramp' && this._anyAllowed(L, c.lane)) stop = true;
              if (node.type === 'signal') {
                const st = node.st[L.group];
                if (st === 0) stop = true; else if (st === 1) stop = stop || d > (c.v * c.v) / 7 + 1;
              } else if (node.yieldIn === L) {
                const f = node.mainIn.lanesArr[0][0];
                let yieldIt = false;
                if (f && !f.isObs) {
                  const dA = node.mainIn.len - f.s;
                  if (dA < 160) { const tA = dA / Math.max(f.v, 3), tR = d / Math.max(c.v, 3); yieldIt = tA < tR + 2.5 && c.waitT < 3.5; }
                }
                if (p.metering && L.kind === 'ramp' && (t < node.meterNext || node.slow) && c.waitT < 12) yieldIt = true;
                if (yieldIt) stop = true;
                if (d < 14 && c.v < 1.5) c.waitT += dt; else if (c.v > 4) c.waitT = 0;
              }
              if (!stop) {
                const B = m.to, bl = B.lanesArr[m.outLane[c.lane]];
                const rear = bl[bl.length - 1];
                if (rear) {
                  const space = d + m.len + rear.s - rear.len;
                  if (space < c.len + 1.5) stop = true;
                  else { gap = space; vl = rear.v; lead = rear; }
                }
              }
              if (stop) { gap = Math.max(0.1, d - 0.5); vl = 0; virt = true; lead = null; }
            }
            // ---- acceleration
            let a = idm(c.v, v0, gap, c.v - vl, P, T);
            if (c.type === 'c' && lead && k > 1) {
              const l2 = arr[k - 2], g2 = l2.s - l2.len - c.s;
              if (g2 > 0) a = Math.min(a, idm(c.v, v0, g2, c.v - l2.v, P, T));
            }
            if (c.type === 'h' && c.v > 10 && t >= c.brakeUntil && this.rand() < noiseRate) { c.brakeUntil = t + 1.2; c.brakeA = -(1.5 + 2 * this.rand()); }
            if (t < c.brakeUntil) a = Math.min(a, c.brakeA);
            a = Math.max(-9, Math.min(3, a));
            c.at = a;
            const tau = c.type === 'c' ? CLAG : lag;
            c.a = virt ? a : c.a + (a - c.a) * Math.min(1, dt / tau);
            if (c.a < -9) c.a = -9;
            c.gap = gap; c.virt = virt;
          }
        }
      }
    }

    _anyAllowed(L, lane) { for (const mv of L.moves) if (mv.mask[lane]) return true; return false; }

    _move(dt) {
      for (const L of this.links) {
        for (let l = 0; l < L.lanes; l++) {
          const arr = L.lanesArr[l];
          for (let k = 0; k < arr.length; k++) {
            const c = arr[k];
            if (c.isObs) continue;
            c.v = Math.max(0, c.v + c.a * dt);
            if (c.gap !== null && c.v * dt > c.gap - 0.3) c.v = Math.max(0, (c.gap - 0.3) / dt);
            c.s += c.v * dt;
            if (c.lat !== 0) { const st = LAT_RATE * dt; c.lat = Math.abs(c.lat) <= st ? 0 : c.lat - Math.sign(c.lat) * st; }
            if (c.mv && c.s >= 0) c.mv = null;
          }
          const f = arr[0];
          if (f && !f.isObs && f.s >= L.len) this._leave(L, arr, f);
        }
      }
    }

    _leave(L, arr, c) {
      if (L.to.type === 'gate') {
        arr.shift();
        this.done.push([this.t, (this.t - c.t0) / Math.max(c.ff, 1)]);
        return;
      }
      const m = c.next;
      if (!m) { c.s = L.len - 0.05; c.v = 0; return; }
      const over = c.s - L.len, B = m.to, tl = m.outLane[c.lane];
      const bl = B.lanesArr[tl], s2 = -m.len + over, rear = bl[bl.length - 1];
      if (L.to.type === 'signal' && L.to.st[L.group] === 0 && c.v < 6) { c.s = L.len - 0.05; c.v = 0; return; }
      if (rear && rear.s - rear.len - s2 < 0.5) { c.s = L.len - 0.05; c.v = Math.min(c.v, 0.5); return; }
      arr.shift();
      this.moveCount[m.kind] = (this.moveCount[m.kind] || 0) + 1;
      if (L.kind === 'ramp' && L.to.type === 'merge') L.to.meterNext = this.t + 3.5;
      if (L === this.det[0] || L === this.det[1]) this.hwCross.push(this.t);
      c.lane0 = c.lane; c.lat = 0; c.link = B; c.lane = tl; c.s = s2; c.mv = m;
      this._insert(bl, c);
      this._pick(c, B);
    }

    // ------------------------------------------------------------ stats
    _stats() {
      const st = this.stats;
      let n = 0, sv = 0, idle = 0, hwN = 0, hwS = 0, cN = 0, cS = 0;
      for (const L of this.links) {
        const hw = L.kind === 'hw' || L.kind === 'ramp';
        for (const arr of L.lanesArr) for (const c of arr) {
          if (c.isObs) continue;
          n++; sv += c.v; if (c.v < 0.5) idle++;
          if (hw) { hwN++; hwS += c.v; } else { cN++; cS += c.v; }
        }
      }
      let backlog = 0;
      for (const x of this.wo) backlog += x.g.backlog;
      st.n = n; st.backlog = backlog; st.hwN = hwN;
      st.hwV = hwN ? hwS / hwN : this.p.limit / 3.6;
      st.cityV = cN ? cS / cN : 12;
      st.eff = sv / Math.max(1, n + backlog);
      st.idle = (idle + backlog) / Math.max(1, n + backlog);
      while (this.done.length && this.done[0][0] < this.t - 120) this.done.shift();
      while (this.hwCross.length && this.hwCross[0] < this.t - 60) this.hwCross.shift();
      st.tpm = this.done.length / Math.min(120, Math.max(this.t, 10)) * 60;
      st.hwFlow = this.hwCross.length / Math.min(60, Math.max(this.t, 10)) * 3600;
      if (this.done.length) { const last = this.done.slice(-50); st.delay = last.reduce((s, x) => s + x[1], 0) / last.length; }
    }

    _second() {
      const st = this.stats;
      // per-link averages, VSL bins
      for (const L of this.links) {
        let s = 0, n = 0;
        const isHw = L.kind === 'hw';
        if (isHw) { L.segV.fill(0); L.segN.fill(0); }
        for (const arr of L.lanesArr) for (const c of arr) {
          if (c.isObs) continue;
          s += c.v; n++;
          if (isHw && c.s >= 0) { const b = Math.min(L.segV.length - 1, (c.s / BIN) | 0); L.segV[b] += c.v; L.segN[b]++; }
        }
        L.n = n;
        const target = n ? s / n : L.vlim;
        L.vAvg += (target - L.vAvg) * 0.25;
        L.ratio = Math.min(1, L.vAvg / L.vlim);
        if (L.obs) L.ratio = Math.min(L.ratio, 0.2);
      }
      for (const L of this.links) {
        if (L.kind !== 'hw') continue;
        for (let b = 0; b < L.vsl.length; b++) {
          let sum = 0, cnt = 0, bb = b, LL = L;
          for (let j = 1; j <= 3; j++) {
            bb++;
            while (LL && bb >= LL.segV.length) { bb -= LL.segV.length; LL = LL.nextMain; }
            if (!LL) break;
            sum += LL.segV[bb]; cnt += LL.segN[bb];
          }
          const down = cnt ? sum / cnt : L.vlim;
          L.vsl[b] = Math.max(12, Math.min(L.vlim, down + 7));
        }
      }
      for (const n of this.nodes) {
        if (n.type !== 'merge') continue;
        let s = 0, c = 0;
        for (const car of n.mainIn.lanesArr[0]) if (!car.isObs && n.mainIn.len - car.s < 250) { s += car.v; c++; }
        n.slow = c > 0 && s / c < 0.7 * n.mainIn.vlim;
      }
      // space-time on EB chain
      const ch = this.map.hwChain, nb = Math.ceil(ch.total / WBIN);
      const ws = new Float32Array(nb), wn = new Uint16Array(nb);
      for (const e of ch.list) for (const arr of e.link.lanesArr) for (const c of arr) {
        if (c.isObs || c.s < 0) continue;
        const b = Math.min(nb - 1, ((e.off + c.s) / WBIN) | 0); ws[b] += c.v; wn[b]++;
      }
      if (!this.wAcc || this.wAcc.s.length !== nb) this.wAcc = { s: new Float32Array(nb), n: new Float32Array(nb) };
      const row = new Array(nb), acc = this.wAcc;
      for (let i = 0; i < nb; i++) {
        acc.s[i] = acc.s[i] * 0.65 + ws[i]; acc.n[i] = acc.n[i] * 0.65 + wn[i];
        row[i] = acc.n[i] > 0.25 ? acc.s[i] / acc.n[i] : -1;
      }
      this.wave.push(row); if (this.wave.length > 240) this.wave.shift();
      this.hist.push({ t: this.t, hwV: st.hwV, cityV: st.cityV, n: st.n, backlog: st.backlog, idle: st.idle, tpm: st.tpm });
      if (this.hist.length > 300) this.hist.shift();
      if (this.p.reroute && this.t - this.lastRoute >= 20) { this.routes = this._route(true); this.lastRoute = this.t; }
    }

    step(dt) {
      this.t += dt;
      this._signals(dt);
      this._spawn(dt);
      this._lanes(dt);
      this._accel(dt);
      this._move(dt);
      this._stats();
      if (this.t - this.lastSec >= 1) { this.lastSec = this.t; this._second(); }
    }
  }

  function runNet(params, seconds, warm, seed, extra) {
    const net = new Net(Object.assign({}, params), seed);
    const dt = 0.2, steps = Math.round(seconds / dt);
    let sv = 0, hw = 0, city = 0, idle = 0, tpm = 0, delay = 0, n = 0;
    for (let i = 0; i < steps; i++) {
      net.step(dt);
      if (net.t >= warm) {
        const s = net.stats;
        sv += s.eff; hw += s.hwV; city += s.cityV; idle += s.idle; tpm += s.tpm; delay += s.delay; n++;
      }
    }
    return { speed: sv / n * 3.6, hwV: hw / n * 3.6, cityV: city / n * 3.6, idle: idle / n, tpm: tpm / n, delay: delay / n, backlog: net.stats.backlog, cars: net.stats.n, flow: net.stats.hwFlow };
  }

  const api = { Net, runNet, DEFAULTS, TYPES, WBIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetSim = api;
})(typeof self !== 'undefined' ? self : this);
