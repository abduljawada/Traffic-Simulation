'use strict';
/*
 * Network traffic engine on the Metro map (v2).
 *
 * Vehicles: heterogeneous IDM drivers with reaction lag, trucks, buses, bicycles,
 * connected cars. Lanes: MOBIL with route-driven mandatory changes (including exit
 * look-ahead), ghost occupancy of the old lane during a change, bus lanes.
 * Junctions: Webster-tuned fixed-time, untuned, green wave, adaptive signals;
 * permissive left turns with gap acceptance (waiting inside the box), pedestrians
 * on crosswalks, roundabouts with yield entries (1 or 2 lanes), ramp merges with
 * gap-seeking and optional metering.
 * Demand: internal land-use zones with curb parking and cruising, gate trips,
 * time-of-day profile, demand elasticity, random incidents with clearance times.
 * Routing: static habit routes and live-navigation cohorts with staggered updates.
 * No DOM access.
 */
(function (root) {
  const MetroMap = typeof require !== 'undefined' ? require('./map.js') : root.MetroMap;

  const TYPES = {
    h: { len: 4.5, occ: 1.3 }, t: { len: 9.5, occ: 1.1 }, c: { len: 4.5, occ: 1.3 },
    b: { len: 12, occ: 28 }, k: { len: 1.8, occ: 1 },
  };
  const LAG = { hw: 1.2, ramp: 1.0, art: 0.8, loc: 0.6, ring: 0.6 }, CLAG = 0.15;
  const YELLOW = 3, ALLRED = 1.2, MIN_GREEN = 7, MAX_GREEN = 45, LOST = 2 * (YELLOW + ALLRED);
  const LW = 3.5, LAT_RATE = 1.6;
  const BIN = 100, WBIN = 50;
  const LC = { every: 3.0, thresh: 0.6, gapT: 0.7, safe: 2.5, cool: 6 };
  let A_MEAN = 1.6;
  const SAT = 0.5; // saturation flow per lane, veh/s of green

  const DEFAULTS = {
    demand: 55, hwShare: 0.35, tidal: 0.35, internalShare: 0.35, profile: 'steady', period: 'am', clockStart: 7 * 3600,
    elasticity: 0.2, noise: 0.35, headway: 1.1, limit: 110, cruising: 0.25,
    signal: 'webster', cycle: 70, metering: false, vsl: false, cacc: 0, navShare: 0.3,
    lagScale: 0.55, transit: 0, flex: 0, rubber: true, trucks: 0.08, peds: 3,
    busFreq: 4, busLanes: false, bikes: 0.04, bikeLanes: false,
    incidents: 1.5, fastClear: false,
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
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function idm(v, v0, s, dv, P, T) {
    const q = v / v0;
    const free = P.d === 4 || !P.d ? 1 - q * q * q * q : 1 - Math.pow(q, P.d);
    if (s === null) return P.a * free;
    const sStar = P.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(P.a * P.b)));
    const r = sStar / Math.max(s, 0.1);
    return P.a * (free - r * r);
  }

  class Net {
    constructor(opts, seed, mapOverride) {
      const o = Object.assign({}, opts || {});
      if (o.signal === 'fixed') o.signal = 'webster';
      this.p = Object.assign({}, DEFAULTS, o);
      this.seed = seed || 1;
      this.map = mapOverride || MetroMap.buildMap({ roundabouts: this.p.roundabouts });
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
      this.rE = mulberry32(this.seed * 7919 + 13); // exogenous stream: demand, incidents (common random numbers)
      this.t = 0; this.nextId = 1; this.lastSec = 0; this.moveCount = {};
      this.done = []; this.hist = []; this.wave = []; this.hwCross = []; this.ghosts = []; this.toRemove = [];
      this.tripLog = null; this.indMult = 1; this.delayEma = 1.3; this.tuneAt = 0; this.tuneDirty = false;
      this.busNext = {}; this.zq = [];
      for (const L of this.links) {
        L.lanesArr = Array.from({ length: L.lanes }, () => []);
        L.bikes = [];
        L.vlim = L.kind === 'hw' ? p.limit / 3.6 : L.vmax;
        L.vAvg = L.vlim; L.ratio = 1; L.obs = null; L.block = null; L.n = 0; L.pedUntil = 0; L.pedStart = 0; L.pedNext = 0;
        L.ttEst = this._ttStatic(L);
        if (L.kind === 'hw') { L.vsl = new Array(Math.ceil(L.len / BIN)).fill(L.vlim); L.segV = new Array(L.vsl.length).fill(L.vlim); L.segN = new Array(L.vsl.length).fill(0); }
      }
      for (const n of this.nodes) { n.st = [0, 0]; n.ph = 0; n.tm = 0; n.meterNext = 0; n.slow = false; n.r = this.rand(); n.backlog = 0; n.q = []; n.cyc = p.cycle; n.g = [(p.cycle - LOST) / 2, (p.cycle - LOST) / 2]; }
      this._zoneTables();
      this._weights();
      this.rs = new Map();
      this.dyn = [0, 1, 2, 3].map((k) => ({ tt: this.links.map((L) => L.ttEst), cache: new Map(), next: 5 * k }));
      this.stats = { n: 0, hwV: 30, cityV: 12, eff: 12, idle: 0, tpm: 0, delay: 1, backlog: 0, hwFlow: 0, hwN: 0, busV: 0, bikeV: 0, pSpeed: 12, buses: 0, bikes: 0, p95: 1.5 };
      this.det = [this.links.find((l) => l.kind === 'hw' && l.from.id === 'gW'), this.links.find((l) => l.kind === 'hw' && l.from.id === 'gE')];
      this._tune(); this.offsets();
      this._busLanes();
      for (const [id, s] of (p.obstacles || [])) this.setObstacle(this.links[id], s, true);
      for (const [id, s] of (p.blocks || [])) this.links[id].block = s;
    }

    get clock() { return (this.p.clockStart + this.t) % 86400; }
    get isAM() { return this.p.profile === 'peak' ? this.clock < 12 * 3600 : this.p.period === 'am'; }

    _mult() {
      if (this.p.profile !== 'peak') return 1;
      const tm = this.t % 3600;
      return 0.35 + 0.85 * Math.exp(-Math.pow((tm - 1500) / 520, 2));
    }

    // ------------------------------------------------------------ demand
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

    _zoneTables() {
      const z = this.map.zones || { res: [], work: [], down: [], shop: [] };
      this.zcum = {}; this.zcumD = {};
      for (const k of Object.keys(z)) {
        let c = 0; this.zcum[k] = z[k].map((L) => { c += L.len; return [c, L]; });
        this.zcum[k].total = c;
        let c2 = 0; this.zcumD[k] = z[k].filter((L) => L.from.type !== 'gate').map((L) => { c2 += L.len; return [c2, L]; });
        this.zcumD[k].total = c2;
      }
    }

    _zoneClass(kind, rng) {
      if (!this.zcum || !this.map.zones) return 'work';
      const am = this.isAM;
      const o = { res: 0.62, work: 0.08, down: 0.1, shop: 0.2 }, d = { work: 0.42, down: 0.33, shop: 0.2, res: 0.05 };
      const w = kind === 'o' ? (am ? o : d) : (am ? d : o);
      let r = rng() * (w.res + w.work + w.down + w.shop);
      for (const k of ['res', 'work', 'down', 'shop']) { r -= w[k]; if (r <= 0 && this.zcumD[k].total > 0) return k; }
      return 'work';
    }

    _pickZone(kind, rng) {
      const k = this._zoneClass(kind, rng), tab = kind === 'd' ? this.zcumD[k] : this.zcum[k];
      if (!tab || !tab.length) return null;
      let r = rng() * tab.total, L = tab[tab.length - 1][1];
      for (const [c, l] of tab) if (r <= c) { L = l; break; }
      const s = L.len * (0.22 + 0.55 * rng());
      return { L, s, key: 'Z' + L.id };
    }

    _pickGateDest(rng, not) {
      for (let i = 0; i < 8; i++) {
        let r = rng() * this.wdSum;
        for (const d of this.wd) { r -= d.w; if (r <= 0) { if (d.g !== not) return d.g; break; } }
      }
      return this.sinks[0];
    }

    _pickGateOrigin(rng) {
      let r = rng();
      for (const x of this.wo) { r -= x.pr; if (r <= 0) return x; }
      return this.wo[0];
    }

    /** Draw one trip from the demand model. rng must be the exogenous stream (or a private one). */
    _drawTrip(rng) {
      const ints = this.p.internalShare, rest = 1 - ints;
      const u = rng();
      let kind;
      if (u < ints) kind = 'int';
      else { const v = (u - ints) / rest; kind = v < 0.3 ? 'thru' : v < 0.75 ? 'in' : 'out'; }
      const trip = { kind };
      if (kind === 'int') { trip.oz = this._pickZone('o', rng); trip.dz = this._pickZone('d', rng); }
      else if (kind === 'thru') { const o = this._pickGateOrigin(rng); trip.og = o.g; trip.hw = o.hw; trip.dg = this._pickGateDest(rng, o.g); }
      else if (kind === 'in') { const o = this._pickGateOrigin(rng); trip.og = o.g; trip.hw = o.hw; trip.dz = this._pickZone('d', rng); }
      else { trip.oz = this._pickZone('o', rng); trip.dg = this._pickGateDest(rng, null); }
      trip.bike = kind === 'int' && rng() < Math.min(1, this.p.bikes / Math.max(ints, 0.05));
      return trip;
    }

    get demandEff() { return this.p.demand * (1 - this.p.transit) * (1 - this.p.flex); }

    _poisson(mean, rng) {
      if (mean <= 0) return 0;
      const Lm = Math.exp(-mean); let k = 0, pr = 1;
      do { k++; pr *= rng(); } while (pr > Lm && k < 12);
      return k - 1;
    }

    _trips(dt) {
      const lam = this.demandEff / 60 * this._mult() * this.indMult;
      const n = this._poisson(lam * dt, this.rE);
      for (let i = 0; i < n; i++) {
        const trip = this._drawTrip(this.rE);
        if (trip.og) { if (trip.og.q.length < 60) { trip.og.q.push(trip); trip.og.backlog = trip.og.q.length; } }
        else if (this.zq.length < 250) { trip.t = this.t; this.zq.push(trip); }
      }
      // gate departures
      for (const x of this.wo) {
        const g = x.g;
        if (!g.q.length) continue;
        if (this._spawnGate(g, g.q[0])) { g.q.shift(); g.backlog = g.q.length; }
      }
      // internal departures from curb / garage
      for (let i = 0; i < this.zq.length && i < 6; i++) {
        const tr = this.zq[i];
        if (this.t - tr.t > 240) { this.zq.splice(i, 1); i--; continue; }
        if (this._spawnZone(tr)) { this.zq.splice(i, 1); i--; }
      }
      // buses on a timetable
      if (this.p.busFreq > 0) this._buses();
    }

    _vehType(trip) {
      if (trip.bike) return 'k';
      if (this.rand() < this.p.trucks && trip.kind !== 'int') return 't';
      return this.rand() < this.p.cacc ? 'c' : 'h';
    }

    _driver(type) {
      const g = () => { const u = this.rand() || 1e-9, v = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      switch (type) {
        case 'h': return { P: { a: clamp(A_MEAN + 0.3 * g(), 1.0, 2.6), b: clamp(1.8 + 0.3 * g(), 1.2, 2.6), s0: clamp(2 + 0.4 * g(), 1.0, 3.2) }, Tf: clamp(1 + 0.18 * g(), 0.7, 1.4), lagF: clamp(1 + 0.2 * g(), 0.6, 1.5), v0f: clamp(1 + 0.07 * g(), 0.85, 1.12) };
        case 't': return { P: { a: 0.8, b: 1.5, s0: 2.5 }, Tabs: clamp(1.7 + 0.2 * g(), 1.2, 2.2), lagF: 1.1, v0f: clamp(0.76 + 0.04 * g(), 0.68, 0.84) };
        case 'c': return { P: { a: 1.5, b: 2.0, s0: 2 }, Tabs: 0.9, lagF: 1, v0f: clamp(1 + 0.04 * g(), 0.92, 1.06) };
        case 'b': return { P: { a: 0.9, b: 1.6, s0: 3 }, Tabs: 1.5, lagF: 1.1, v0f: 0.88 };
        default: return { P: { a: 1.0, b: 2.0, s0: 1 }, Tabs: 0.8, lagF: 0.8, v0f: clamp(1 + 0.12 * g(), 0.8, 1.25) };
      }
    }

    _T(c) { return c.Tf ? this.p.headway * c.Tf : c.Tabs; }

    _newCar(type, L, lane, s, dest, ff) {
      const dr = this._driver(type);
      const c = Object.assign({
        id: this.nextId++, link: L, lane, s, v: 0, a: 0, at: 0, len: TYPES[type].len, type, v0abs: null,
        next: null, next2: null, mv: null, dest, t0: this.t, ff, wander: 0, tries: 0, stopS: null, stopKind: null, dwellT: null,
        brakeUntil: 0, brakeA: 0, lcCool: 0, lat: 0, waitT: 0, gap: null, virt: false, isObs: false,
        nav: type === 'h' || type === 'c' ? this.rand() < this.p.navShare : false, cohort: this.nextId & 3, seen: null,
      }, dr);
      if (type === 'k') c.v0abs = 5.2 * dr.v0f;
      return c;
    }

    _destOf(trip) {
      if (trip.dg) return { key: trip.dg.id, node: trip.dg };
      return { key: trip.dz.key, link: trip.dz.L, s: trip.dz.s };
    }

    _spawnGate(g, trip) {
      const L = g.out[0];
      const type = this._vehType(trip);
      const len = TYPES[type].len;
      let lane = -1, best = -1;
      const bike = type === 'k';
      for (let l = 0; l < L.lanes; l++) {
        if (L.busBan && l === 0 && type !== 'b') continue;
        const arr = L.lanesArr[l], rear = arr[arr.length - 1];
        const space = rear ? rear.s - rear.len : 1e9;
        if (space > best) { best = space; lane = l; }
      }
      if (lane < 0 || best < len + 3) return false;
      const dest = this._destOf(trip);
      const arr = L.lanesArr[lane], rear = arr[arr.length - 1];
      const ff = this._routeStatic(dest.key, type)[L.id];
      const c = this._newCar(type, L, lane, 0, dest, ff);
      c.v = Math.min(L.vlim * 0.6, rear && !rear.isObs ? rear.v + 2 : 12);
      this._enterLink(c, L);
      if (type === 'k' && this.p.bikeLanes) { c.sep = true; L.bikes.push(c); } else arr.push(c);
      return true;
    }

    _spawnZone(trip) {
      const { L, s } = trip.oz;
      const type = this._vehType(trip);
      const len = TYPES[type].len;
      const dest = this._destOf(trip);
      if (dest.link === L && dest.s > s - 10 && dest.s < s + 25) return true; // pointless trip, drop
      if (type === 'k' && this.p.bikeLanes) {
        for (const b of L.bikes) if (Math.abs(b.s - s) < 5) return false;
        const c = this._newCar(type, L, 0, s, dest, this._routeStatic(dest.key, type)[L.id] - s / (L.vlim * 0.9));
        c.sep = true; c.v = 0; this._enterLink(c, L); L.bikes.push(c); return true;
      }
      const lane = 0, arr = L.lanesArr[lane];
      let lead = null, fol = null;
      for (const q of arr) { if (q.s > s) lead = q; else { fol = q; break; } }
      if (lead && lead.s - lead.len - s < len + 6) return false;
      if (fol && (s - len - fol.s) < 6 + 1.6 * fol.v) return false;
      const ff = this._routeStatic(dest.key, type)[L.id] - s / (L.vlim * 0.9);
      const c = this._newCar(type, L, lane, s, dest, Math.max(ff, 10));
      c.v = 0;
      this._enterLink(c, L);
      this._insert(arr, c);
      return true;
    }

    _buses() {
      for (const R of this.busRoutes()) {
        const next = this.busNext[R.id] === undefined ? (this.busNext[R.id] = this.t + (R.id % 7) * 40 + 20) : this.busNext[R.id];
        if (this.t < next) continue;
        const L = R.g.out[0], arr = L.lanesArr[0], rear = arr[arr.length - 1];
        if (rear && rear.s - rear.len < 16) continue;
        const dest = { key: R.d.id, node: R.d };
        const c = this._newCar('b', L, 0, 0, dest, this._routeStatic(dest.key, 'b')[L.id]);
        c.v = 8; c.seen = {};
        this._enterLink(c, L);
        arr.push(c);
        this.busNext[R.id] = this.t + 3600 / this.p.busFreq * (0.9 + 0.2 * this.rE());
      }
    }

    busRoutes() {
      if (this._busR) return this._busR;
      const R = [], byId = (id) => this.nodes.find((n) => n.id === id);
      let k = 0;
      for (const y of this.map.AVENUES) {
        const w = byId('aW' + y), e = byId('aE' + y);
        R.push({ id: k++, g: w, d: e }, { id: k++, g: e, d: w });
      }
      for (const x of this.map.INTERCHANGES) R.push({ id: k++, g: byId('gN' + x), d: byId('gS' + x) }, { id: k++, g: byId('gS' + x), d: byId('gN' + x) });
      return (this._busR = R.filter((r) => r.g && r.d && r.g.out.length && r.d.in.length));
    }

    // -------------------------------------------------------------- routing
    _ttStatic(L) { return L.len / (L.vlim * 0.92) + (L.to.type === 'signal' ? 8 : L.to.type === 'rin' ? 3 : 0); }
    _ttNow(L) { return L.len / Math.max(2, Math.min(L.vlim, L.vAvg)) + (L.to.type === 'signal' ? 8 : L.to.type === 'rin' ? 3 : 0); }

    _dijkstra(tt, key, nh) {
      const nl = this.links.length, dist = new Float64Array(nl).fill(Infinity), done = new Uint8Array(nl);
      const t = new Float64Array(nl);
      for (let i = 0; i < nl; i++) { const L = this.links[i]; t[i] = nh && (L.kind === 'hw' || L.kind === 'ramp') ? Infinity : tt[i]; }
      if (key[0] === 'Z') {
        const L = this.links[+key.slice(1)];
        dist[L.id] = tt[L.id] * 0.5;
      } else {
        const g = this.nodes.find((n) => n.id === key);
        for (const L of g.in) dist[L.id] = t[L.id];
      }
      if (!this._preds) {
        this._preds = Array.from({ length: nl }, () => []);
        for (const L of this.links) for (const mv of L.moves) this._preds[mv.to.id].push([L, mv]);
      }
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i < nl; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        for (const [P, mv] of this._preds[u]) {
          const c = t[P.id] + mv.pen + mv.len / 6 + dist[u];
          if (c < dist[P.id]) dist[P.id] = c;
        }
      }
      return dist;
    }

    _routeStatic(key, type) {
      const nh = type === 'b' || type === 'k', k = (nh ? 'n:' : 'a:') + key;
      let r = this.rs.get(k);
      if (!r) { r = this._dijkstra(this.links.map((L) => this._ttStatic(L)), key, nh); this.rs.set(k, r); }
      return r;
    }

    _routeFor(c) {
      const nh = c.type === 'b' || c.type === 'k';
      if (nh || !c.nav) return this._routeStatic(c.dest.key, c.type);
      const d = this.dyn[c.cohort];
      let r = d.cache.get(c.dest.key);
      if (!r) { r = this._dijkstra(d.tt, c.dest.key, false); d.cache.set(c.dest.key, r); }
      return r;
    }

    _enterLink(c, L) {
      c.stopS = null; c.stopKind = null; c.dwellT = null;
      const d = c.dest;
      if (d.link === L && c.type !== 'b') {
        const failP = c.tries === 0 ? this.p.cruising : 0.2;
        if (c.type !== 'k' && d.s > c.s + 18 && this.rand() >= failP) { c.stopS = d.s; c.stopKind = 'park'; }
        else if (c.type === 'k' && d.s > c.s + 3) { c.stopS = d.s; c.stopKind = 'park'; }
        else if (c.type !== 'k') { c.tries++; c.wander = 3 + ((this.rand() * 5) | 0); }
      }
      if (c.type === 'b' && L.stopS !== undefined && !(c.seen && c.seen[L.id]) && L.stopS > c.s + 15) { c.stopS = L.stopS; c.stopKind = 'bus'; if (c.seen) c.seen[L.id] = 1; }
      this._pick(c, L);
    }

    _pick(c, L) {
      c.next2 = null;
      if (L.to.type === 'gate') { c.next = null; return; }
      const moves = L.moves;
      if (!moves.length) { c.next = null; return; }
      if (c.wander > 0 && L.to.type === 'signal' && L.kind !== 'hw' && L.kind !== 'ramp') {
        c.wander--;
        const opts = moves.filter((m) => m.kind !== 'exit' && m.kind !== 'merge' && m.kind !== 'u');
        if (opts.length) { c.next = opts[(this.rand() * opts.length) | 0]; return; }
      }
      this._choose(c, moves, -1);
      if (L.kind === 'hw' && c.next && c.next.to.kind === 'hw') {
        const dist = this._routeFor(c);
        let best = null, bc = Infinity;
        for (const mv of c.next.to.moves) { const cost = dist[mv.to.id] + mv.pen; if (cost < bc) { bc = cost; best = mv; } }
        if (best && best.kind === 'exit') c.next2 = best;
      }
    }

    _choose(c, moves, lane) {
      const dist = this._routeFor(c);
      let best = null, bc = Infinity;
      const costs = [];
      for (const mv of moves) {
        if (lane >= 0 && !mv.mask[lane]) { costs.push(Infinity); continue; }
        const cost = dist[mv.to.id] + mv.pen + mv.len / 6;
        costs.push(cost);
        if (cost < bc) { bc = cost; best = mv; }
      }
      if (!best || bc === Infinity) {
        if (lane >= 0) return this._choose(c, moves, -1);
        if (c.dest.node === undefined || c.type === 'h') { const g = this.sinks[(this.rand() * this.sinks.length) | 0]; c.dest = { key: g.id, node: g }; c.stopS = null; }
        c.next = moves.find((m) => m.to.kind !== 'ramp' && m.to.kind !== 'hw') || moves[0]; return;
      }
      const theta = c.nav ? 3 : 6;
      let tot = 0; const w = costs.map((x) => { const v = x === Infinity ? 0 : Math.exp(-(x - bc) / theta); tot += v; return v; });
      let r = this.rand() * tot;
      for (let i = 0; i < moves.length; i++) { r -= w[i]; if (r <= 0) { c.next = moves[i]; return; } }
      c.next = best;
    }

    _replan(c, L) { this._choose(c, L.moves, c.lane); }

    // ------------------------------------------------------ signal tuning
    /** Expected link flows from the demand model, then Webster cycle and splits per junction. */
    _tune() {
      if (!this.sources.length) { this.tuneDirty = false; return; }
      const rng = mulberry32(4242), N = 2500, flow = new Float64Array(this.links.length);
      const rate = this.demandEff / 60 * (this.p.profile === 'peak' ? 0.9 : 1);
      for (let i = 0; i < N; i++) {
        const tr = this._drawTrip(rng);
        if (tr.bike || (!tr.og && !tr.oz) || (!tr.dg && !tr.dz)) continue;
        const L0 = tr.og ? tr.og.out[0] : tr.oz.L;
        const key = tr.dg ? tr.dg.id : tr.dz.key, dist = this._routeStatic(key, 'h');
        let L = L0, guard = 0;
        while (guard++ < 90) {
          flow[L.id] += 1;
          if (L.to.type === 'gate' || (tr.dz && L === tr.dz.L && guard > 1)) break;
          let best = null, bc = Infinity;
          for (const mv of L.moves) { const c = dist[mv.to.id] + mv.pen; if (c < bc) { bc = c; best = mv; } }
          if (!best) break;
          L = best.to;
        }
      }
      for (let i = 0; i < flow.length; i++) flow[i] = flow[i] / N * rate;
      this.flow = flow;
      for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        const y = [0, 0];
        for (const L of n.in) y[L.group] = Math.max(y[L.group], flow[L.id] / (SAT * L.lanes));
        y[0] = Math.max(y[0], 0.03); y[1] = Math.max(y[1], 0.03);
        const Y = Math.min(0.9, y[0] + y[1]);
        const C = clamp((1.5 * LOST + 5) / (1 - Y), 55, 110);
        n.web = { C, g: [Math.max(8, (C - LOST) * y[0] / (y[0] + y[1])), Math.max(8, (C - LOST) * y[1] / (y[0] + y[1]))], y };
        const Cs = this.p.cycle;
        n.sync = { C: Cs, g: [Math.max(8, (Cs - LOST) * y[0] / (y[0] + y[1])), Math.max(8, (Cs - LOST) * y[1] / (y[0] + y[1]))] };
      }
      this.tuneAt = this.t; this.tuneDirty = false;
    }

    offsets() {
      const sig = this.p.signal, vprog = 11;
      for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        const C = sig === 'webster' && n.web ? n.web.C : this.p.cycle;
        n.off = sig === 'sync' ? (((-(n.x + n.y) / vprog) % C) + C) % C : n.r * C;
      }
    }

    // -------------------------------------------------------- parameters
    set(key, val) {
      if (this.p[key] === val) return;
      this.p[key] = val;
      if (key === 'limit') { for (const L of this.links) if (L.kind === 'hw') L.vlim = val / 3.6; this.rs.clear(); }
      else if (key === 'signal' || key === 'cycle') { this._tune(); this.offsets(); for (const n of this.nodes) { n.ph = 0; n.tm = 0; } }
      else if (key === 'cacc') this.forEachCar((c) => { if (!c.isObs && c.type !== 't' && c.type !== 'b' && c.type !== 'k') { const t = this.rand() < val ? 'c' : 'h'; if (t !== c.type) { c.type = t; Object.assign(c, this._driver(t)); } } });
      else if (key === 'tidal' || key === 'hwShare') { this._weights(); this.tuneDirty = true; }
      else if (key === 'demand' || key === 'transit' || key === 'flex' || key === 'internalShare' || key === 'profile' || key === 'period') this.tuneDirty = true;
      else if (key === 'navShare') this.forEachCar((c) => { if (c.type === 'h' || c.type === 'c') c.nav = this.rand() < val; });
      else if (key === 'bikeLanes') this._migrateBikes();
      else if (key === 'busLanes') this._busLanes();
    }

    _busLanes() {
      for (const L of this.links) L.busBan = !!(this.p.busLanes && L.busLaneOK);
    }

    _migrateBikes() {
      const on = this.p.bikeLanes;
      for (const L of this.links) {
        if (on) {
          for (const arr of L.lanesArr) for (let i = arr.length - 1; i >= 0; i--) if (arr[i].type === 'k') { const c = arr.splice(i, 1)[0]; c.sep = true; L.bikes.push(c); }
          L.bikes.sort((a, b) => b.s - a.s);
        } else {
          for (const c of L.bikes) { c.sep = false; c.lane = 0; this._insert(L.lanesArr[0], c); }
          L.bikes = [];
        }
      }
    }

    forEachCar(fn) {
      for (const L of this.links) { for (const arr of L.lanesArr) for (const c of arr) fn(c, L); for (const c of L.bikes) fn(c, L); }
    }

    // ------------------------------------------------------ disruptions
    setObstacle(L, s, perm, until) {
      if (L.lanes < 2 || L.obs) return;
      const o = { id: this.nextId++, link: L, lane: 0, s, v: 0, a: 0, at: 0, len: 4.5, isObs: true, type: 'x', perm: !!perm, until: until || Infinity };
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
      if (L.lanes >= 2) { if (L.obs) this.clearObstacle(L); else this.setObstacle(L, s, true); }
      else L.block = L.block === null ? s : null;
    }
    disruptions() {
      const obstacles = [], blocks = [];
      for (const L of this.links) { if (L.obs && L.obs.perm) obstacles.push([L.id, L.obs.s]); if (L.block !== null) blocks.push([L.id, L.block]); }
      return { obstacles, blocks };
    }
    clearDisruptions() { for (const L of this.links) { this.clearObstacle(L); L.block = null; } }
    randomDisruptions(k, kinds) {
      const cand = this.links.filter((l) => !l.obs && l.block === null && l.kind !== 'ramp' && l.kind !== 'hw' && l.kind !== 'ring' && l.len > 80 && l.to.type !== 'gate' && l.from.type !== 'gate' && (!kinds || kinds.includes(l.kind)));
      for (let i = 0; i < k && cand.length; i++) {
        const l = cand.splice((this.rand() * cand.length) | 0, 1)[0];
        this.toggleDisruption(l, l.len * (0.35 + 0.3 * this.rand()));
      }
    }
    countDisruptions() { let n = 0; for (const L of this.links) if (L.obs || L.block !== null) n++; return n; }

    _incidents(dt) {
      const rate = this.p.incidents / 3600;
      if (rate > 0 && this.rE() < rate * dt) {
        const cand = this.links.filter((l) => !l.obs && l.lanes >= 2 && !l.bridge && l.len > 160 && (l.kind === 'hw' || l.kind === 'art') && l.to.type !== 'gate');
        const L = cand[(this.rE() * cand.length) | 0];
        const med = 600 * (this.p.fastClear ? 0.5 : 1);
        const dur = clamp(med * Math.exp(0.6 * (this.rE() + this.rE() + this.rE() - 1.5) * 1.6), 150, 3000);
        if (L) this.setObstacle(L, L.len * (0.3 + 0.5 * this.rE()), false, this.t + dur);
      }
    }

    _insert(arr, c) {
      let i = arr.length;
      while (i > 0 && arr[i - 1].s < c.s) i--;
      arr.splice(i, 0, c);
    }

    // ---------------------------------------------------------- signals
    _signals(dt) {
      const p = this.p, sig = p.signal;
      for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        if (sig === 'adaptive') { this._adaptive(n, dt); continue; }
        let C, g0, g1;
        if (sig === 'webster' && n.web) { C = n.web.C; g0 = n.web.g[0]; g1 = n.web.g[1]; }
        else if (sig === 'sync' && n.sync) { C = n.sync.C; g0 = n.sync.g[0]; g1 = n.sync.g[1]; }
        else { C = p.cycle; g0 = g1 = Math.max(6, (C - LOST) / 2); }
        const u = (this.t + n.off) % C, lost = YELLOW + ALLRED;
        if (u < g0) n.st = [2, 0];
        else if (u < g0 + YELLOW) n.st = [1, 0];
        else if (u < g0 + lost) n.st = [0, 0];
        else if (u < g0 + lost + g1) n.st = [0, 2];
        else if (u < g0 + lost + g1 + YELLOW) n.st = [0, 1];
        else n.st = [0, 0];
      }
      // pedestrians arrive at crosswalks while the parallel vehicle phase is green
      const pr = this.p.peds / 60 * dt;
      if (pr > 0) for (const n of this.nodes) {
        if (n.type !== 'signal') continue;
        for (const B of n.out) {
          if (B.kind === 'hw' || B.kind === 'ramp' || this.t < B.pedUntil || this.t < B.pedNext) continue;
          if (n.st[1 - B.group] === 2 && this.rE() < pr) { B.pedStart = this.t; B.pedUntil = this.t + 9 + 4 * this.rE(); B.pedNext = B.pedUntil + 4; }
        }
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

    /** Left-turn conflict: an oncoming straight/right-turning car is about to arrive. */
    _oncoming(A) {
      const node = A.to;
      if (node.type !== 'signal') return false;
      if (A._opp === undefined) {
        A._opp = null;
        for (const O of node.in) if (O !== A && O.h1[0] * A.h1[0] + O.h1[1] * A.h1[1] < -0.7) A._opp = O;
      }
      const O = A._opp;
      if (!O) return false;
      for (const arr of O.lanesArr) {
        const f = arr[0];
        if (!f || f.isObs || !f.next || (f.next.kind !== 'straight' && f.next.kind !== 'right')) continue;
        const dO = O.len - f.s;
        if (dO > 90) continue;
        if (dO / Math.max(f.v, 1.5) < 4 || (f.v < 1 && dO < 14)) return true;
      }
      return false;
    }

    // ---------------------------------------------------- lane changing
    _allowed(c, lane) { return !c.next || c.next.mask[lane]; }

    _lanes(dt) {
      const t = this.t, p = this.p;
      for (const L of this.links) {
        if (L.lanes < 2) continue;
        const snap = [];
        for (const arr of L.lanesArr) for (const c of arr) if (!c.isObs && c.s >= 0) snap.push(c);
        for (const c of snap) {
          if (t < c.lcCool || this.rand() > dt / LC.every || c.dwellT !== null) continue;
          let d = L.len - c.s;
          if (d < 6) continue;
          let mask = c.next ? c.next.mask : null, Heff = L.kind === 'hw' ? 1500 : 150;
          if (c.next2 && mask && mask.every((x) => x)) { mask = c.next2.mask; d += c.next.to.len + 60; }
          const arr = L.lanesArr[c.lane], k = arr.indexOf(c);
          if (k < 0) continue;
          const lead0 = k > 0 ? arr[k - 1] : null, fol0 = arr[k + 1] || null;
          const P = c.P, T = this._T(c);
          const v0 = L.vlim * c.v0f;
          const gap0 = lead0 ? lead0.s - lead0.len - c.s : null;
          const aOld = idm(c.v, v0, gap0, lead0 ? c.v - lead0.v : 0, P, T);
          const ban0 = L.busBan && c.type !== 'b' && !(c.s < 40) && !(c.next && c.next.kind === 'right' && L.len - c.s < 45) && c.stopKind !== 'park';
          const wantPark = c.stopKind === 'park' || c.stopKind === 'bus';
          const okNow = (!mask || mask[c.lane]) && !(ban0 && c.lane === 0) && !(wantPark && c.lane !== 0 && c.stopS - c.s < 220);
          const u = Math.max(0, Math.min(1, 1 - d / Heff));
          let want = 0;
          if (!okNow) {
            if (ban0 && c.lane === 0) want = 1;
            else if (wantPark && c.lane !== 0) want = -1;
            else if (mask) { let bd = 99; for (let l = 0; l < L.lanes; l++) if (mask[l] && Math.abs(l - c.lane) < bd) { bd = Math.abs(l - c.lane); want = Math.sign(l - c.lane); } }
          }
          let best = -1, bestGain = LC.thresh;
          for (const dl of [-1, 1]) {
            const m = c.lane + dl;
            if (m < 0 || m >= L.lanes) continue;
            if (m === 0 && ban0) continue;
            const arr2 = L.lanesArr[m];
            let i = 0;
            while (i < arr2.length && arr2[i].s > c.s) i++;
            const lead1 = i > 0 ? arr2[i - 1] : null, fol1 = arr2[i] || null;
            const gL = lead1 ? lead1.s - lead1.len - c.s : null;
            const gF = fol1 ? c.s - c.len - fol1.s : null;
            const needL = (okNow ? 3 + LC.gapT * c.v : 2), needF = (okNow ? 3 + LC.gapT * (fol1 ? fol1.v : 0) : 2 + 0.3 * (fol1 ? fol1.v : 0));
            if ((gL !== null && gL < needL) || (gF !== null && gF < needF)) continue;
            const aNew = idm(c.v, v0, gL, lead1 ? c.v - lead1.v : 0, P, T);
            let dOthers = 0;
            if (fol1 && !fol1.isObs) {
              const aF = idm(fol1.v, L.vlim * fol1.v0f, gF, fol1.v - c.v, fol1.P, this._T(fol1));
              if (aF < -(LC.safe + 3 * (okNow ? 0 : u))) continue;
              dOthers += aF - fol1.at;
            }
            if (fol0 && !fol0.isObs) {
              const gN = lead0 ? lead0.s - lead0.len - fol0.s : null;
              dOthers += idm(fol0.v, L.vlim * fol0.v0f, gN, lead0 ? fol0.v - lead0.v : 0, fol0.P, this._T(fol0)) - fol0.at;
            }
            let gain = (aNew - aOld) + 0.2 * dOthers + (dl < 0 ? (c.type === 't' || c.type === 'b' ? 0.5 : 0.15) : (c.type === 't' ? -0.3 : 0));
            if (!okNow) gain += dl === want ? 1 + 6 * u : -100;
            else if (mask && !mask[m] && d < Heff) gain = -100;
            else if (wantPark && m !== 0 && c.stopS - c.s < 220) gain = -100;
            // courtesy: open a gap for ramp traffic about to merge
            if (dl > 0 && c.lane === 0 && L.to.type === 'merge' && L.to.rampWant && d < 200) gain += 1.2;
            if (gain > bestGain) { bestGain = gain; best = m; }
          }
          if (best >= 0) {
            arr.splice(k, 1);
            c.lat += (best - c.lane) * LW;
            const g = { isObs: true, ghost: true, owner: c, link: L, lane: c.lane, s: c.s, v: c.v, len: c.len, at: 0, until: t + 2.0 };
            this._insert(arr, g); this.ghosts.push(g);
            c.lane = best; c.lcCool = t + (okNow ? LC.cool : 2.5);
            this._insert(L.lanesArr[best], c);
          }
        }
      }
    }

    _updateGhosts() {
      const t = this.t, keep = [];
      for (const g of this.ghosts) {
        const c = g.owner;
        if (t > g.until || c.link !== g.link || c.dead) {
          const arr = g.link.lanesArr[g.lane], i = arr.indexOf(g);
          if (i >= 0) arr.splice(i, 1);
        } else { g.s = c.s; g.v = c.v; keep.push(g); }
      }
      this.ghosts = keep;
    }

    // --------------------------------------------------------- dynamics
    _mainThreat(node, ramp) {
      let f = null, bd = 1e9;
      const M = node.mainIn;
      const lanes = ramp ? [M.lanesArr[0]] : M.lanesArr;
      for (const arr of lanes) { const q = arr[0]; if (q && !(q.isObs && !q.ghost) && q.s > -1) { const dd = M.len - q.s; if (dd < bd) { bd = dd; f = q; } } }
      return f;
    }

    _accel(dt) {
      const t = this.t, p = this.p;
      const noiseRate = p.noise / 60 * dt;
      for (const L of this.links) {
        const lagBase = LAG[L.kind];
        const obs = L.obs;
        for (let l = 0; l < L.lanes; l++) {
          const arr = L.lanesArr[l];
          for (let k = 0; k < arr.length; k++) {
            const c = arr[k];
            if (c.isObs) continue;
            if (c.dwellT !== null) {
              c.dwellT -= dt; c.v = 0; c.a = 0; c.at = 0; c.gap = null;
              if (c.dwellT <= 0) { if (c.stopKind === 'park') { c.dead = true; this.toRemove.push(c); } else { c.dwellT = null; c.stopS = null; c.stopKind = null; } }
              continue;
            }
            const P = c.P, T = this._T(c);
            let gap = null, vl = 0, virt = false, lead = null;
            let m = c.next;
            const d = L.len - c.s;
            // ---- desired speed
            let v0 = (c.v0abs ? Math.min(c.v0abs, L.vlim) : L.vlim * c.v0f);
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
            } else if (m && d < 400) {
              const node = L.to;
              let stop = false;
              if (!m.mask[c.lane] && d < (L.kind === 'hw' ? 140 : 45)) { this._replan(c, L); m = c.next; }
              if (!m.mask[c.lane] && L.kind !== 'hw' && L.kind !== 'ramp' && this._anyAllowed(L, c.lane)) stop = true;
              if (node.type === 'signal') {
                const st = node.st[L.group];
                if (st === 0) stop = true;
                else if (st === 1) stop = stop || d > (c.v * c.v) / 7 + 1;
                else if (d < 80) {
                  if ((m.kind === 'left' || m.kind === 'right') && m.to.pedUntil > t) stop = true;
                  else if (m.kind === 'left' && this._oncoming(L)) {
                    const B = m.to, bl = B.lanesArr[m.outLane[c.lane]], rr = bl[bl.length - 1];
                    if (rr && rr.mv === m && rr.s < 0) stop = true; // someone is already waiting in the box
                  }
                }
              } else if (node.yieldIn === L) {
                const ramp = L.kind === 'ramp';
                const f = this._mainThreat(node, ramp);
                if (ramp) node.rampWantNow = true;
                let yieldStop = false;
                if (f && !f.ghost) {
                  const dA = node.mainIn.len - f.s;
                  if (dA < 220) {
                    const tA = dA / Math.max(f.v, 3), tR = d / Math.max(c.v, 3);
                    if (tA < tR + 2.5 && (c.waitT < 3.5 || !ramp)) {
                      const g2 = d - dA - f.len;
                      if (ramp && g2 > 0.5) { gap = Math.max(0.1, g2); vl = f.v; lead = f; }
                      else if (!ramp) yieldStop = true;
                      else if (g2 <= 0.5 && dA < 20) yieldStop = true;
                    }
                  }
                }
                if (p.metering && ramp && (t < node.meterNext || node.slow) && c.waitT < 12) yieldStop = true;
                if (!ramp && node.ringNode && !yieldStop) {
                  const R = node.ringNode; let occ = 0, cap = 0;
                  for (const rl of R.ringLinks) { cap += rl.len * rl.lanes / 7.5; for (const a of rl.lanesArr) occ += a.length; }
                  if (occ > 0.62 * cap) yieldStop = true;
                }
                if (yieldStop) stop = true;
                if (d < 14 && c.v < 1.5) c.waitT += dt; else if (c.v > 4) c.waitT = 0;
              }
              if (!stop && lead === null) {
                const B = m.to, bl = B.lanesArr[m.outLane[c.lane]];
                const rear = bl[bl.length - 1];
                if (rear) {
                  const space = d + m.len + rear.s - rear.len;
                  if (space < (node.type === 'signal' ? c.len + 1.5 : 0.8)) stop = true;
                  else { gap = space; vl = rear.v; lead = rear; }
                }
              }
              if (stop) { gap = Math.max(0.1, d - 0.5); vl = 0; virt = true; lead = null; }
            }
            // ---- waiting inside the junction to turn left across oncoming traffic
            if (c.mv && c.s < 0 && c.mv.kind === 'left' && c.mv.node.type === 'signal') {
              const A = c.mv.from;
              if (A.to.st[A.group] === 2 && this._oncoming(A) && c.s < -0.42 * c.mv.len) {
                const g2 = Math.max(0.1, -0.45 * c.mv.len - c.s);
                if (gap === null || g2 < gap) { gap = g2; vl = 0; virt = true; lead = null; }
              }
            }
            // ---- curb parking / bus stop
            if (c.stopS !== null && c.s < c.stopS + 0.5) {
              const g2 = Math.max(0.1, c.stopS - c.s - 0.3);
              if (gap === null || g2 < gap) { gap = g2; vl = 0; virt = true; lead = null; }
              if (c.v < 0.3 && c.stopS - c.s < P.s0 + 1.8) c.dwellT = c.stopKind === 'park' ? 5 + 7 * this.rand() : 12 + 14 * this.rand();
            }
            // ---- acceleration
            let a = idm(c.v, v0, gap, c.v - vl, P, T);
            if (c.type === 'c' && lead && k > 1) {
              const l2 = arr[k - 2], g2 = l2.s - l2.len - c.s;
              if (g2 > 0) a = Math.min(a, idm(c.v, v0, g2, c.v - l2.v, P, T));
            }
            if ((c.type === 'h' || c.type === 't' || c.type === 'b') && c.v > 10 && t >= c.brakeUntil && this.rand() < noiseRate) { c.brakeUntil = t + 1.2; c.brakeA = -(1.5 + 2 * this.rand()); }
            if (t < c.brakeUntil) a = Math.min(a, c.brakeA);
            a = Math.max(-9, Math.min(3, a));
            c.at = a;
            const tau = c.type === 'c' ? CLAG : lagBase * c.lagF * p.lagScale;
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
            if (c.isObs || c.dwellT !== null) continue;
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
      if (this.toRemove.length) {
        for (const c of this.toRemove) {
          const arr = c.link.lanesArr[c.lane], i = arr.indexOf(c);
          if (i >= 0) arr.splice(i, 1);
          this._finish(c);
        }
        this.toRemove = [];
      }
    }

    _finish(c) {
      const tt = this.t - c.t0, ratio = tt / Math.max(c.ff, 1);
      this.done.push([this.t, ratio]);
      if (this.tripLog && c.type !== 'b') this.tripLog.push([this.t, ratio, tt - c.ff, TYPES[c.type].occ]);
    }

    _leave(L, arr, c) {
      if (L.to.type === 'gate') { arr.shift(); c.dead = true; this._finish(c); return; }
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
      this._enterLink(c, B);
    }

    /** Separated bicycles: simple kinematics on their own track beside the road. */
    _bikes(dt) {
      for (const L of this.links) {
        const arr = L.bikes;
        if (!arr.length) continue;
        for (let k = 0; k < arr.length; k++) {
          const c = arr[k];
          if (c.dwellT !== null) { c.dwellT -= dt; if (c.dwellT <= 0) { c.dead = true; this._finish(c); arr.splice(k, 1); k--; } continue; }
          let gap = null, vl = 0;
          if (k > 0) { gap = arr[k - 1].s - arr[k - 1].len - c.s; vl = arr[k - 1].v; }
          const d = L.len - c.s;
          if (L.to.type === 'signal' && d < 60) {
            const st = L.to.st[L.group];
            if (st !== 2 && (st === 0 || d > (c.v * c.v) / 5 + 1)) { const g2 = Math.max(0.1, d - 1.5); if (gap === null || g2 < gap) { gap = g2; vl = 0; } }
          }
          if (c.stopS !== null && c.s < c.stopS) { const g2 = Math.max(0.1, c.stopS - c.s); if (gap === null || g2 < gap) { gap = g2; vl = 0; } if (c.v < 0.3 && c.stopS - c.s < 2.5) c.dwellT = 3; }
          const a = Math.max(-5, Math.min(1.5, idm(c.v, Math.min(c.v0abs, L.vlim), gap, c.v - vl, c.P, c.Tabs)));
          c.v = Math.max(0, c.v + a * dt);
          if (gap !== null && c.v * dt > gap - 0.2) c.v = Math.max(0, (gap - 0.2) / dt);
          c.s += c.v * dt;
        }
        const f = arr[0];
        if (f && f.dwellT === null && f.s >= L.len) {
          const m = f.next;
          if (!m || L.to.type === 'gate') { f.dead = true; this._finish(f); arr.shift(); continue; }
          if (L.to.type === 'signal' && L.to.st[L.group] === 0) { f.s = L.len - 0.05; f.v = 0; continue; }
          arr.shift();
          f.link = m.to; f.s = Math.min(1, f.s - L.len);
          m.to.bikes.push(f);
          this._enterLink(f, m.to);
        }
      }
    }

    // ------------------------------------------------------------ stats
    _stats() {
      const st = this.stats;
      let n = 0, sv = 0, idle = 0, hwN = 0, hwS = 0, cN = 0, cS = 0, bN = 0, bS = 0, kN = 0, kS = 0, occ = 0, occv = 0;
      for (const L of this.links) {
        const hw = L.kind === 'hw' || L.kind === 'ramp';
        for (const arr of L.lanesArr) for (const c of arr) {
          if (c.isObs) continue;
          if (c.type === 'k') { kN++; kS += c.v; continue; }
          n++; sv += c.v; if (c.v < 0.5) idle++;
          const o = TYPES[c.type].occ; occ += o; occv += o * c.v;
          if (c.type === 'b') { bN++; bS += c.v; }
          if (hw) { hwN++; hwS += c.v; } else { cN++; cS += c.v; }
        }
        for (const c of L.bikes) { kN++; kS += c.v; }
      }
      let backlog = 0;
      for (const x of this.wo) backlog += x.g.backlog;
      backlog += this.zq.length;
      st.n = n; st.backlog = backlog; st.hwN = hwN; st.buses = bN; st.bikes = kN;
      st.hwV = hwN ? hwS / hwN : this.p.limit / 3.6;
      st.cityV = cN ? cS / cN : 12;
      st.busV = bN ? bS / bN : 0;
      st.bikeV = kN ? kS / kN : 0;
      st.eff = sv / Math.max(1, n + backlog);
      st.pSpeed = occv / Math.max(1, occ + backlog * 1.3);
      st.idle = (idle + backlog) / Math.max(1, n + backlog);
      while (this.done.length && this.done[0][0] < this.t - 120) this.done.shift();
      while (this.hwCross.length && this.hwCross[0] < this.t - 60) this.hwCross.shift();
      st.tpm = this.done.length / Math.min(120, Math.max(this.t, 10)) * 60;
      st.hwFlow = this.hwCross.length / Math.min(60, Math.max(this.t, 10)) * 3600;
      if (this.done.length) { const last = this.done.slice(-50); st.delay = last.reduce((s, x) => s + x[1], 0) / last.length; }
    }

    _second() {
      const st = this.stats;
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
        if (L.obs && L.obs.until < this.t && !L.obs.perm) this.clearObstacle(L);
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
        n.rampWant = !!n.rampWantNow; n.rampWantNow = false;
      }
      // live-navigation snapshots (cohorts staggered by 5 s, successive averaging)
      for (const d of this.dyn) {
        if (this.t >= d.next) {
          d.tt = this.links.map((L, i) => 0.5 * d.tt[i] + 0.5 * this._ttNow(L));
          d.cache.clear(); d.next = this.t + 20;
        }
      }
      // induced / suppressed demand
      if (this.p.elasticity > 0) {
        this.delayEma += (st.delay - this.delayEma) * 0.03;
        this.indMult = clamp(Math.pow(1.3 / Math.max(this.delayEma, 0.9), this.p.elasticity), 0.75, 1.25);
      } else this.indMult = 1;
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
      this.hist.push({ t: this.t, hwV: st.hwV, cityV: st.cityV, n: st.n, backlog: st.backlog, idle: st.idle, tpm: st.tpm, busV: st.busV, mult: this._mult() * this.indMult });
      if (this.hist.length > 300) this.hist.shift();
      if (this.done.length > 8) { const r = this.done.map((x) => x[1]).sort((a, b) => a - b); st.p95 = r[Math.min(r.length - 1, Math.floor(0.95 * r.length))]; }
      if (this.tuneDirty && this.t - this.tuneAt > 3) { this._tune(); this.offsets(); }
    }

    step(dt) {
      this.t += dt;
      this._signals(dt);
      this._trips(dt);
      this._incidents(dt);
      this._updateGhosts();
      this._lanes(dt);
      this._accel(dt);
      this._move(dt);
      this._bikes(dt);
      this._stats();
      if (this.t - this.lastSec >= 1) { this.lastSec = this.t; this._second(); }
    }
  }

  function runNet(params, seconds, warm, seed) {
    const net = new Net(Object.assign({}, params), seed);
    net.tripLog = [];
    const dt = 0.2, steps = Math.round(seconds / dt);
    let sv = 0, ps = 0, hw = 0, city = 0, bus = 0, nb = 0, idle = 0, tpm = 0, n = 0;
    let logFrom = 0;
    for (let i = 0; i < steps; i++) {
      net.step(dt);
      if (net.t >= warm) {
        if (!logFrom) { logFrom = net.tripLog.length; }
        const s = net.stats;
        sv += s.eff; ps += s.pSpeed; hw += s.hwV; city += s.cityV; idle += s.idle; tpm += s.tpm;
        if (s.busV > 0) { bus += s.busV; nb++; }
        n++;
      }
    }
    const trips = net.tripLog.slice(logFrom);
    const ratios = trips.map((x) => x[1]).sort((a, b) => a - b);
    const pct = (q) => (ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))] : 1);
    const hours = (seconds - warm) / 3600;
    const delayH = trips.reduce((s, x) => s + Math.max(0, x[2]) * x[3], 0) / 3600 / hours;
    return {
      speed: sv / n * 3.6, pSpeed: ps / n * 3.6, hwV: hw / n * 3.6, cityV: city / n * 3.6, busV: nb ? bus / nb * 3.6 : 0,
      idle: idle / n, tpm: tpm / n, delay: ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : 1,
      p95: pct(0.95), median: pct(0.5), delayH, trips: trips.length,
      backlog: net.stats.backlog, cars: net.stats.n, flow: net.stats.hwFlow,
    };
  }

  const api = { setAMean: (v) => { A_MEAN = v; }, LC, Net, runNet, DEFAULTS, TYPES, WBIN, mulberry32, idm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NetSim = api;
})(typeof self !== 'undefined' ? self : this);
