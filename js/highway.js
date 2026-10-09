'use strict';
/*
 * Highway engine: closed multi-lane ring with an on/off-ramp pair and an
 * optional breakdown. Longitudinal: IDM. Lane changes: MOBIL.
 * No DOM access, so it can be run headless for the diagnosis feature.
 */
(function (root) {
  const CAR_LEN = 4.5;
  const LAG_H = { v: 1.4 }, LAG_C = 0.15; // actuation/reaction lag
  const NSEG = 10;
  const WBINS = 40; // 25 m bins for the space-time diagram // 100 m control segments (VSL + wave heat-map)
  const HUMAN = { a: 1.0, b: 1.6, s0: 2, delta: 4 };
  const CACC = { a: 1.5, b: 2.0, s0: 2, delta: 4, T: 0.9 };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function idm(v, v0, s, dv, P, T) {
    const q = v / v0;
    const free = 1 - q * q * q * q;
    if (s === null) return P.a * free;
    const sStar = P.s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(P.a * P.b)));
    const r = sStar / Math.max(s, 0.1);
    return P.a * (free - r * r);
  }

  const DEFAULTS = {
    lanes: 3, L: 1000, density: 30, limit: 110, headway: 1.5, noise: 0.7,
    laneChange: true, rampRate: 0, metering: false, incident: false,
    rubber: true, cacc: 0, vsl: false,
  };

  class Highway {
    constructor(opts, seed) {
      this.p = Object.assign({}, DEFAULTS, opts || {});
      this.seed = seed || 1;
      this.rand = mulberry32(this.seed);
      this.reset();
    }

    get v0() { return this.p.limit / 3.6; }
    get onX() { return this.p.L * 0.25; }
    get offX() { return this.p.L * 0.9; }
    get incX() { return this.p.L * 0.62; }

    reset() {
      const p = this.p;
      this.rand = mulberry32(this.seed);
      this.t = 0; this.nextId = 1;
      this.cars = [];
      this.lanes = Array.from({ length: p.lanes }, () => []);
      this.crossings = [];
      this.rampQ = 0; this.rampNext = 0; this.meterNext = 0; this.rampWait = 0; this.debt = 0;
      this.segMean = new Array(NSEG).fill(this.v0);
      this.segLimit = new Array(NSEG).fill(this.v0);
      this.hist = []; this.wave = []; this.scatter = [];
      this.lastSample = 0; this.lastScatter = 0;
      this.stats = { meanV: this.v0, jam: 0, flow: 0, density: 0, q: 0, rampQ: 0, n: 0 };
      const n = Math.round(p.density * p.lanes * p.L / 1000);
      this.obstacle = null;
      this._populate(n);
      if (p.incident) this._addObstacle();
    }

    _newCar(lane, x, v) {
      const isC = this.rand() < this.p.cacc;
      const c = {
        id: this.nextId++, lane, x, v, a: 0, len: CAR_LEN, type: isC ? 'c' : 'h',
        v0f: 0.93 + 0.14 * this.rand(), brakeUntil: 0, brakeA: 0, lcAt: 0, lcCool: 0,
        isObs: false, dead: false, gap: null,
      };
      return c;
    }

    _populate(n) {
      const { lanes, L } = this.p;
      const per = Math.floor(n / lanes);
      let extra = n - per * lanes;
      for (let l = 0; l < lanes; l++) {
        const k = per + (extra-- > 0 ? 1 : 0);
        const spacing = L / Math.max(k, 1);
        const v = Math.min(this.v0 * 0.9, Math.max(spacing - CAR_LEN, 0) / 1.5);
        for (let i = 0; i < k; i++) {
          const c = this._newCar(l, (i * spacing + this.rand() * 2) % L, v);
          this.cars.push(c); this.lanes[l].push(c);
        }
      }
    }

    count() { return this.cars.reduce((s, c) => s + (c.isObs ? 0 : 1), 0); }

    _addObstacle() {
      if (this.obstacle) return;
      const x = this.incX;
      for (const c of this.cars) {
        if (!c.isObs && c.lane === 0 && Math.abs(c.x - x) < 10) c.dead = true;
      }
      this._sweep();
      const o = this._newCar(0, x, 0);
      o.isObs = true; o.type = 'x';
      this.obstacle = o;
      this.cars.push(o); this.lanes[0].push(o);
    }

    _removeObstacle() {
      if (!this.obstacle) return;
      this.obstacle.dead = true; this.obstacle = null; this._sweep();
    }

    _sweep() {
      this.cars = this.cars.filter((c) => !c.dead);
      for (let l = 0; l < this.lanes.length; l++) this.lanes[l] = this.lanes[l].filter((c) => !c.dead);
    }

    /** Apply a parameter change on a running sim. */
    set(key, val) {
      const old = this.p[key];
      if (old === val) return;
      this.p[key] = val;
      if (key === 'density') this._setCount(Math.round(val * this.p.lanes * this.p.L / 1000));
      else if (key === 'incident') (val ? this._addObstacle() : this._removeObstacle());
      else if (key === 'cacc') {
        for (const c of this.cars) if (!c.isObs) c.type = this.rand() < val ? 'c' : 'h';
      }
    }

    _setCount(n) {
      let cur = this.count();
      while (cur > n) {
        const c = this.cars[(this.rand() * this.cars.length) | 0];
        if (c.isObs || c.dead) continue;
        c.dead = true; cur--;
      }
      this._sweep();
      let tries = 0;
      while (cur < n && tries++ < 400) {
        const lane = (this.rand() * this.p.lanes) | 0;
        const x = this.rand() * this.p.L;
        const [lead, fol] = this._neighbors(this.lanes[lane], x, null);
        const gL = lead ? ((lead.x - x + this.p.L) % this.p.L) - CAR_LEN : 1e9;
        const gF = fol ? ((x - fol.x + this.p.L) % this.p.L) - CAR_LEN : 1e9;
        if (gL < 12 || gF < 12) continue;
        const c = this._newCar(lane, x, Math.min(lead ? lead.v : this.v0, this.v0 * 0.8));
        this.cars.push(c); this.lanes[lane].push(c); cur++;
      }
    }

    brakeCar(c) { c.brakeUntil = this.t + 3; c.brakeA = -4; }

    _neighbors(arr, x, self) {
      const L = this.p.L;
      let lead = null, fol = null, bl = 1e9, bf = 1e9;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c === self) continue;
        const d = (c.x - x + L) % L;
        if (d < bl) { bl = d; lead = c; }
        const e = (L - d) % L;
        if (e < bf) { bf = e; fol = c; }
      }
      return [lead, fol];
    }

    _gapTo(lead, x) {
      return ((lead.x - x + this.p.L) % this.p.L) - lead.len;
    }

    _params(c) { return c.type === 'c' ? CACC : HUMAN; }
    _T(c) { return c.type === 'c' ? CACC.T : this.p.headway; }

    _v0eff(c) {
      let v0 = this.v0 * c.v0f;
      const p = this.p;
      if (p.vsl) {
        const k = Math.min(NSEG - 1, (c.x / (p.L / NSEG)) | 0);
        v0 = Math.min(v0, this.segLimit[k]);
      }
      if (p.incident && p.rubber && c.type !== 'c' && c.lane !== 0) {
        const d = c.x - this.incX;
        if (d > -120 && d < 30) v0 *= 0.7;
      }
      return v0;
    }

    _accel(c, lead, lead2, gap, v0) {
      const P = this._params(c), T = this._T(c);
      let a;
      if (lead) {
        a = idm(c.v, v0, gap, c.v - lead.v, P, T);
        if (c.type === 'c' && lead2 && lead2 !== c) {
          const g2 = this._gapTo(lead2, c.x);
          if (g2 > 0) a = Math.min(a, idm(c.v, v0, g2, c.v - lead2.v, P, T));
        }
      } else a = idm(c.v, v0, null, 0, P, T);
      if (this.t < c.brakeUntil) a = Math.min(a, c.brakeA);
      return a;
    }

    _updateSegments() {
      const sum = new Array(NSEG).fill(0), cnt = new Array(NSEG).fill(0);
      const w = this.p.L / NSEG;
      for (const c of this.cars) {
        if (c.isObs) continue;
        const k = Math.min(NSEG - 1, (c.x / w) | 0);
        sum[k] += c.v; cnt[k]++;
      }
      for (let k = 0; k < NSEG; k++) this.segMean[k] = cnt[k] ? sum[k] / cnt[k] : this.v0;
      // dynamic limit from the traffic 100-400 m downstream
      for (let k = 0; k < NSEG; k++) {
        let s = 0, n = 0;
        for (let j = 1; j <= 3; j++) {
          const kk = (k + j) % NSEG;
          s += sum[kk]; n += cnt[kk];
        }
        const down = n ? s / n : this.v0;
        this.segLimit[k] = Math.max(12, Math.min(this.v0, down + 7));
      }
    }

    _rampStep(dt) {
      const p = this.p, L = p.L;
      if (p.rampRate > 0) {
        const lam = p.rampRate / 60 * dt;
        if (this.rand() < lam && this.rampQ < 60) this.rampQ++;
      } else this.rampQ = Math.max(0, this.rampQ - dt * 0.5);
      if (this.rampQ < 1 || this.t < this.rampNext) { this.rampWait = 0; return; }
      const lane0 = this.lanes[0];
      const [lead, fol] = this._neighbors(lane0, this.onX, null);
      if (p.metering) {
        if (this.t < this.meterNext) return;
        let s = 0, n = 0;
        for (const c of lane0) {
          const d = this.onX - c.x;
          if (d > 0 && d < 250 && !c.isObs) { s += c.v; n++; }
        }
        if (n && s / n < 0.7 * this.v0) return;
      }
      this.rampWait += dt;
      const vm = Math.min(this.v0 * 0.85, lead ? lead.v + 3 : 1e9);
      const gL = lead ? this._gapTo(lead, this.onX) : 1e9;
      const gF = fol ? ((this.onX - fol.x + L) % L) - CAR_LEN : 1e9;
      const closing = fol ? Math.max(0, fol.v - vm) : 0;
      const comfy = gL > 6 + 0.8 * vm && gF > 10 + 1.2 * closing;
      const forced = this.rampWait > 4 && gL > 4 && gF > 5;
      if (!(comfy || forced)) return;
      const c = this._newCar(0, this.onX, vm);
      this.cars.push(c); lane0.push(c);
      this.rampQ -= 1; this.rampWait = 0; this.debt++;
      this.rampNext = this.t + 1.8;
      this.meterNext = this.t + 3.5;
    }

    _lanes(dt) {
      const p = this.p;
      if (!p.laneChange || p.lanes < 2) return;
      for (const c of this.cars) {
        if (c.isObs) continue;
        if (this.t < c.lcCool) continue;
        if (this.rand() > dt / 0.8) continue;
        const arr = this.lanes[c.lane];
        const [lead0, fol0] = this._neighbors(arr, c.x, c);
        const P = this._params(c), T = this._T(c), v0 = this._v0eff(c);
        const g0 = lead0 ? this._gapTo(lead0, c.x) : null;
        const aOld = idm(c.v, v0, g0, lead0 ? c.v - lead0.v : 0, P, T);
        let best = null, bestGain = 0.25;
        for (const dl of [-1, 1]) {
          const m = c.lane + dl;
          if (m < 0 || m >= p.lanes) continue;
          const [nl, nf] = this._neighbors(this.lanes[m], c.x, c);
          const gNL = nl ? this._gapTo(nl, c.x) : null;
          const gNF = nf ? ((c.x - nf.x + p.L) % p.L) - CAR_LEN : null;
          if (gNL !== null && gNL < 3) continue;
          if (gNF !== null && gNF < 3) continue;
          const aNew = idm(c.v, v0, gNL, nl ? c.v - nl.v : 0, P, T);
          let dOthers = 0;
          if (nf) {
            const nfLead = this._neighbors(this.lanes[m], nf.x, nf)[0];
            const pf = this._params(nf), tf = this._T(nf);
            const gOld = nfLead ? this._gapTo(nfLead, nf.x) : null;
            const aFolOld = idm(nf.v, this._v0eff(nf), gOld, nfLead ? nf.v - nfLead.v : 0, pf, tf);
            const aFolNew = idm(nf.v, this._v0eff(nf), gNF, nf.v - c.v, pf, tf);
            if (aFolNew < -4) continue; // safety
            dOthers += aFolNew - aFolOld;
          }
          if (fol0) {
            const pf = this._params(fol0), tf = this._T(fol0);
            const gW = this._gapTo(c, fol0.x);
            const aWas = idm(fol0.v, this._v0eff(fol0), gW, fol0.v - c.v, pf, tf);
            const gN = lead0 ? this._gapTo(lead0, fol0.x) : null;
            const aNow = idm(fol0.v, this._v0eff(fol0), gN, lead0 ? fol0.v - lead0.v : 0, pf, tf);
            dOthers += aNow - aWas;
          }
          const bias = dl < 0 ? 0.15 : 0; // keep right
          const gain = (aNew - aOld) + 0.2 * dOthers + bias;
          if (gain > bestGain) { bestGain = gain; best = m; }
        }
        if (best !== null) {
          arr.splice(arr.indexOf(c), 1);
          c.lane = best; c.lcCool = this.t + 2.5;
          this.lanes[best].push(c);
        }
      }
    }

    step(dt) {
      const p = this.p, L = p.L;
      this.t += dt;
      for (const arr of this.lanes) arr.sort((a, b) => a.x - b.x);
      this._updateSegments();
      this._rampStep(dt);
      for (const arr of this.lanes) arr.sort((a, b) => a.x - b.x);
      this._lanes(dt);
      for (const arr of this.lanes) arr.sort((a, b) => a.x - b.x);

      const noiseRate = p.noise / 60 * dt;
      for (const arr of this.lanes) {
        const n = arr.length;
        for (let k = 0; k < n; k++) {
          const c = arr[k];
          if (c.isObs) continue;
          const lead = n > 1 ? arr[(k + 1) % n] : null;
          const lead2 = n > 2 ? arr[(k + 2) % n] : null;
          const gap = lead ? Math.max(0.1, this._gapTo(lead, c.x)) : null;
          c.gap = gap;
          if (c.type === 'h' && c.v > 10 && this.t >= c.brakeUntil && this.rand() < noiseRate) {
            c.brakeUntil = this.t + 1.2; c.brakeA = -(1.5 + 2 * this.rand());
          }
          const a = this._accel(c, lead, lead2, gap, this._v0eff(c));
          const tgt = Math.max(-9, Math.min(3, a));
          const lag = c.type === 'c' ? LAG_C : LAG_H.v;
          c.a += (tgt - c.a) * Math.min(1, dt / lag);
        }
      }

      let dead = false;
      for (const c of this.cars) {
        if (c.isObs) continue;
        c.v = Math.max(0, c.v + c.a * dt);
        if (c.gap !== null && c.v * dt > c.gap - 0.4) c.v = Math.max(0, (c.gap - 0.4) / dt);
        const px = c.x;
        c.x += c.v * dt;
        if (c.x >= L) { c.x -= L; this.crossings.push(this.t); }
        if (this.debt > 0 && px < this.offX && c.x >= this.offX && c.x - px < 50 &&
            (c.lane === 0 || (this.debt > 4 && c.lane === 1))) {
          c.dead = true; dead = true; this.debt--;
        }
      }
      if (dead) this._sweep();
      while (this.crossings.length && this.crossings[0] < this.t - 60) this.crossings.shift();
      this._measure();
    }

    _measure() {
      let s = 0, n = 0, jam = 0, rampS = 0;
      for (const c of this.cars) {
        if (c.isObs) continue;
        s += c.v; n++; if (c.v < 7) jam++;
      }
      const st = this.stats, p = this.p;
      st.n = n;
      st.meanV = n ? s / n : this.v0;
      st.jam = n ? jam / n : 0;
      st.density = n / p.lanes / p.L * 1000; // veh/km/lane
      st.q = st.density * st.meanV * 3.6;    // veh/h/lane (Edie)
      const win = Math.min(60, Math.max(this.t, 5));
      st.flow = this.crossings.length / win * 3600;
      st.rampQ = this.rampQ;
      if (this.t - this.lastSample >= 1) {
        this.lastSample = this.t;
        this.hist.push({ t: this.t, v: st.meanV, flow: st.flow, jam: st.jam });
        if (this.hist.length > 300) this.hist.shift();
        const ws = new Array(WBINS).fill(0), wn = new Array(WBINS).fill(0);
        for (const c of this.cars) {
          if (c.isObs) continue;
          const k = Math.min(WBINS - 1, (c.x / (p.L / WBINS)) | 0);
          ws[k] += c.v; wn[k]++;
        }
        this.wave.push(ws.map((x, k) => (wn[k] ? x / wn[k] : -1)));
        if (this.wave.length > 240) this.wave.shift();
      }
      if (this.t - this.lastScatter >= 4) {
        this.lastScatter = this.t;
        this.scatter.push([st.density, st.q]);
        if (this.scatter.length > 150) this.scatter.shift();
      }
    }
  }

  /** Headless run for the diagnosis: returns time-averaged metrics. */
  function runHighway(params, seconds, warm, seed) {
    const h = new Highway(params, seed);
    const dt = 0.2;
    let sumV = 0, sumJam = 0, sumQ = 0, n = 0, c0 = 0, c1 = 0, tWarm = -1;
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      h.step(dt);
      if (h.t >= warm) {
        if (tWarm < 0) { tWarm = h.t; c0 = h.crossings.length; }
        sumV += h.stats.meanV; sumJam += h.stats.jam; sumQ += h.stats.rampQ; n++;
      }
    }
    return { speed: sumV / n * 3.6, jam: sumJam / n, rampQ: sumQ / n, flow: h.crossings.length / 60 * 3600 };
  }

  const api = { Highway, runHighway, NSEG, WBINS, CAR_LEN, DEFAULTS, HUMAN, CACC, LAG_H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HighwaySim = api;
})(typeof self !== 'undefined' ? self : this);
