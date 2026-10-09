'use strict';
/*
 * City engine: signalised grid, one lane per direction, IDM car-following,
 * queue spillback, curbside disruptions, cruising for parking.
 * Simplification: two-phase signals, no turning conflicts inside the box.
 */
(function (root) {
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E S W N
  const CAR_LEN = 4.5, VFREE = 13.9, YELLOW = 3, ALLRED = 1.2;
  const IDM = { a: 1.4, b: 2.0, s0: 2, T: 1.2 };
  const MIN_GREEN = 7, MAX_GREEN = 45;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function idm(v, v0, s, dv) {
    const q = v / v0;
    const free = 1 - q * q * q * q;
    if (s === null) return IDM.a * free;
    const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    const r = sStar / Math.max(s, 0.1);
    return IDM.a * (free - r * r);
  }

  const DEFAULTS = {
    cols: 6, rows: 4, block: 130, gate: 70,
    demand: 80, tidal: 0.7, transit: 0, flex: 0, cruising: 0.2,
    cycle: 70, signal: 'fixed', // fixed | sync | adaptive
  };

  class City {
    constructor(opts, seed) {
      this.p = Object.assign({}, DEFAULTS, opts || {});
      this.seed = seed || 1;
      this._build();
      this.reset();
      for (const [id, pos] of (this.p.blocks || [])) this.links[id].block = pos;
    }

    _build() {
      const { cols: C, rows: R, block: B, gate: G } = this.p;
      this.nodes = []; this.links = []; this.gates = [];
      const map = new Map();
      const key = (i, j) => i + ',' + j;
      const mk = (i, j, gate) => {
        const n = {
          i, j, gate, out: [null, null, null, null], inLinks: [], st: [0, 0],
          ph: 0, tm: 0, off: 0, r: 0,
          x: i < 0 ? -G : i >= C ? (C - 1) * B + G : i * B,
          y: j < 0 ? -G : j >= R ? (R - 1) * B + G : j * B,
        };
        map.set(key(i, j), n); this.nodes.push(n); if (gate) this.gates.push(n);
        return n;
      };
      for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) mk(i, j, false);
      for (let j = 0; j < R; j++) { mk(-1, j, true); mk(C, j, true); }
      for (let i = 0; i < C; i++) { mk(i, -1, true); mk(i, R, true); }
      for (const a of this.nodes) {
        for (let d = 0; d < 4; d++) {
          const b = map.get(key(a.i + DIRS[d][0], a.j + DIRS[d][1]));
          if (!b || (a.gate && b.gate)) continue;
          const len = Math.hypot(b.x - a.x, b.y - a.y);
          const link = { id: this.links.length, a, b, dir: d, len, group: d % 2, cars: [], block: null };
          a.out[d] = link; b.inLinks.push(link); this.links.push(link);
        }
      }
      this.interior = this.nodes.filter((n) => !n.gate);
      for (const g of this.gates) g.inbound = g.i < 0 || g.j < 0; // W/N gates feed the commute
    }

    reset() {
      this.rand = mulberry32(this.seed);
      this.t = 0; this.nextId = 1; this.cars = 0;
      for (const l of this.links) { l.cars = []; }
      for (const g of this.gates) { g.backlog = 0; }
      for (const n of this.interior) { n.r = this.rand(); n.ph = 0; n.tm = 0; }
      this.applyOffsets();
      this.done = []; // [time, ratio]
      this.hist = []; this.lastSample = 0;
      this.stats = { speed: 0, ratio: 1, n: 0, idle: 0, backlog: 0, tpm: 0, delay: 1 };
      this._tick();
    }

    applyOffsets() {
      const cyc = this.p.cycle;
      const tt = this.p.block / (this.p.progSpeed || 11);
      for (const n of this.interior) {
        n.off = this.p.signal === 'sync' ? (((-(n.i + n.j) * tt) % cyc) + cyc) % cyc : n.r * cyc;
      }
    }

    set(key, val) {
      if (this.p[key] === val) return;
      this.p[key] = val;
      if (key === 'signal' || key === 'cycle') {
        this.applyOffsets();
        for (const n of this.interior) { n.ph = 0; n.tm = 0; }
      }
    }

    get demandEff() { return this.p.demand * (1 - this.p.transit) * (1 - this.p.flex); }

    disruptionCount() { return this.links.reduce((s, l) => s + (l.block !== null ? 1 : 0), 0); }

    toggleBlock(link, s) {
      if (link.b.gate && link.a.gate) return;
      link.block = link.block === null ? Math.max(25, Math.min(link.len - 30, s)) : null;
    }

    randomBlocks(k) {
      const cand = this.links.filter((l) => !l.a.gate && !l.b.gate && l.block === null);
      for (let i = 0; i < k && cand.length; i++) {
        const l = cand.splice((this.rand() * cand.length) | 0, 1)[0];
        l.block = l.len * (0.4 + 0.3 * this.rand());
      }
    }

    clearBlocks() { for (const l of this.links) l.block = null; }

    // ---------- signals ----------
    _signals(dt) {
      const p = this.p, cyc = p.cycle;
      if (p.signal === 'adaptive') {
        for (const n of this.interior) this._adaptive(n, dt);
        return;
      }
      const lost = YELLOW + ALLRED;
      const g = Math.max(6, (cyc - 2 * lost) / 2);
      for (const n of this.interior) {
        const u = (this.t + n.off) % cyc;
        let s;
        if (u < g) s = [2, 0];
        else if (u < g + YELLOW) s = [1, 0];
        else if (u < g + lost) s = [0, 0];
        else if (u < 2 * g + lost) s = [0, 2];
        else if (u < 2 * g + lost + YELLOW) s = [0, 1];
        else s = [0, 0];
        n.st = s;
      }
    }

    _pressure(n, group) {
      let k = 0;
      for (const l of n.inLinks) {
        if (l.group !== group) continue;
        for (const c of l.cars) if (l.len - c.s < 55) k++; else break;
      }
      return k;
    }

    _adaptive(n, dt) {
      n.tm += dt;
      const PH = [[2, 0], [1, 0], [0, 0], [0, 2], [0, 1], [0, 0]];
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

    // ---------- routing ----------
    _dist(n, d) { return Math.abs(n.i - d.i) + Math.abs(n.j - d.j); }

    _pickNext(c, link) {
      const node = link.b;
      if (node.gate) { c.next = null; return; }
      const opts = [];
      for (let d = 0; d < 4; d++) {
        const o = node.out[d];
        if (!o || d === (link.dir + 2) % 4) continue;
        if (o.b.gate && o.b !== c.dest) continue;
        opts.push(o);
      }
      if (c.wander > 0) {
        const free = opts.filter((o) => !o.b.gate);
        c.wander--;
        if (free.length) { c.next = free[(this.rand() * free.length) | 0]; return; }
      }
      const here = this._dist(node, c.dest);
      const good = opts.filter((o) => this._dist(o.b, c.dest) < here);
      const pool = good.length ? good : opts;
      if (pool.length) c.next = pool[(this.rand() * pool.length) | 0];
      else c.next = node.out[(link.dir + 2) % 4];
    }

    // ---------- demand ----------
    _weights() {
      const t = this.p.tidal;
      const wo = this.gates.map((g) => (g.inbound ? 1 + 1.5 * t : 1 - 0.7 * t));
      const wd = this.gates.map((g) => (g.inbound ? 1 - 0.7 * t : 1 + 1.5 * t));
      const so = wo.reduce((x, y) => x + y, 0);
      return { wo, wd, so, sd: wd.reduce((x, y) => x + y, 0) };
    }

    _spawn(dt) {
      const w = this._weights();
      const rate = this.demandEff / 60;
      for (let k = 0; k < this.gates.length; k++) {
        const g = this.gates[k];
        const lam = rate * w.wo[k] / w.so;
        if (this.rand() < 1 - Math.exp(-lam * dt) && g.backlog < 40) g.backlog++;
        if (g.backlog <= 0) continue;
        const link = g.out.find(Boolean);
        const rear = link.cars[link.cars.length - 1];
        if (rear && rear.s - CAR_LEN < 4) continue;
        let dest = g;
        while (dest === g) {
          let r = this.rand() * w.sd;
          for (let q = 0; q < this.gates.length; q++) { r -= w.wd[q]; if (r <= 0) { dest = this.gates[q]; break; } }
        }
        const hops = Math.abs(g.i - dest.i) + Math.abs(g.j - dest.j);
        const length = Math.max(0, hops - 2) * this.p.block + 2 * this.p.gate;
        const c = {
          id: this.nextId++, s: 0, v: rear ? Math.min(8, rear.v) : 8, link, next: null, dest,
          v0f: 0.85 + 0.3 * this.rand(), t0: this.t, ff: length / VFREE,
          wander: this.rand() < this.p.cruising ? 3 + ((this.rand() * 8) | 0) : 0, gap: null,
        };
        this._pickNext(c, link);
        link.cars.push(c);
        g.backlog--;
      }
    }

    // ---------- dynamics ----------
    _updateLink(link, dt) {
      const cars = link.cars;
      const toGate = link.b.gate;
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        const d = link.len - c.s;
        let gap = null, vl = 0;
        if (k > 0) {
          const lead = cars[k - 1];
          gap = lead.s - c.s - CAR_LEN; vl = lead.v;
        } else if (!toGate) {
          const st = link.b.st[link.group];
          let stop = st === 0;
          if (st === 1) stop = d > (c.v * c.v) / 7 + 1;
          if (!stop && c.next) {
            const rear = c.next.cars[c.next.cars.length - 1];
            if (rear) {
              if (rear.s - CAR_LEN < 2) stop = true;
              else { gap = d + rear.s - CAR_LEN; vl = rear.v; }
            }
          }
          if (stop) { gap = d - 0.5; vl = 0; }
        }
        let v0 = VFREE * c.v0f;
        if (link.block !== null) {
          const db = link.block - c.s;
          if (db > -8) v0 = Math.min(v0, Math.sqrt(6.25 + 4 * Math.max(0, db - 6)));
        }
        if (c.next && c.next.dir !== link.dir) {
          v0 = Math.min(v0, Math.sqrt(49 + 4 * Math.max(0, d - 4)));
        }
        let a = idm(c.v, v0, gap, c.v - vl);
        a = Math.max(-9, Math.min(2, a));
        c.v = Math.max(0, c.v + a * dt);
        if (gap !== null && c.v * dt > gap - 0.3) c.v = Math.max(0, (gap - 0.3) / dt);
        c.s += c.v * dt;
      }
      // front car may leave the link
      const f = cars[0];
      if (!f || f.s < link.len) return;
      if (toGate) {
        cars.shift();
        this.done.push([this.t, (this.t - f.t0) / Math.max(f.ff, 1)]);
        return;
      }
      const nl = f.next;
      const over = f.s - link.len;
      const rear = nl.cars[nl.cars.length - 1];
      if (link.b.st[link.group] === 0 && f.v < 6) { f.s = link.len - 0.05; f.v = 0; return; }
      if (rear && rear.s - CAR_LEN - over < 0.3) { f.s = link.len - 0.05; f.v = 0; return; }
      cars.shift();
      f.s = over; f.link = nl;
      nl.cars.push(f);
      this._pickNext(f, nl);
    }

    step(dt) {
      this.t += dt;
      this._signals(dt);
      this._spawn(dt);
      for (const l of this.links) this._updateLink(l, dt);
      this._tick();
    }

    _tick() {
      let n = 0, sv = 0, idle = 0;
      for (const l of this.links) for (const c of l.cars) { n++; sv += c.v; if (c.v < 0.5) idle++; }
      let backlog = 0;
      for (const g of this.gates) backlog += g.backlog;
      const st = this.stats;
      st.n = n; st.backlog = backlog;
      st.speed = n ? sv / n : VFREE;
      // vehicles still waiting outside count as stationary
      st.eff = (sv) / Math.max(1, n + backlog);
      st.ratio = st.speed / VFREE;
      st.idle = (idle + backlog) / Math.max(1, n + backlog);
      while (this.done.length && this.done[0][0] < this.t - 120) this.done.shift();
      st.tpm = this.done.length / Math.min(120, Math.max(this.t, 10)) * 60;
      if (this.done.length) {
        const last = this.done.slice(-40);
        st.delay = last.reduce((s, x) => s + x[1], 0) / last.length;
      }
      if (this.t - this.lastSample >= 1) {
        this.lastSample = this.t;
        this.hist.push({ t: this.t, ratio: st.ratio, n, backlog, idle: st.idle, tpm: st.tpm });
        if (this.hist.length > 300) this.hist.shift();
      }
    }
  }

  function runCity(params, seconds, warm, seed) {
    const c = new City(params, seed);
    const dt = 0.25, steps = Math.round(seconds / dt);
    let sv = 0, n = 0, idle = 0, delay = 0, nd = 0, tpm = 0;
    for (let i = 0; i < steps; i++) {
      c.step(dt);
      if (c.t >= warm) {
        sv += c.stats.eff; idle += c.stats.idle; tpm += c.stats.tpm; n++;
        if (c.stats.delay) { delay += c.stats.delay; nd++; }
      }
    }
    return { speed: sv / n * 3.6, idle: idle / n, tpm: tpm / n, delay: nd ? delay / nd : 1, backlog: c.stats.backlog };
  }

  const api = { City, runCity, VFREE, CAR_LEN, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CitySim = api;
})(typeof self !== 'undefined' ? self : this);
