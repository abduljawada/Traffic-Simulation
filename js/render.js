'use strict';
/*
 * Canvas renderer: cached static scene (ground, river, buildings, roads,
 * markings) plus a per-frame dynamic layer (traffic colours, cars, bridges,
 * signals, disruptions). Camera = world centre + pixels per metre.
 */
(function (root) {
  const MM = root.MetroMap;
  const LW = MM.LW;

  const PAL = {
    dark: {
      ground: '#171c22', park: '#1d3526', tree: '#2c5d3d', water: '#1c4a70', bank: '#2a3a46', waterHi: '#2f6f9e',
      walk: '#39414b', asphalt: '#2c3239', hw: '#262b32', shoulder: '#3d444e', line: 'rgba(235,240,246,.75)', dash: 'rgba(235,240,246,.45)',
      stop: '#f2a33a', yellow: '#d9ab32', median: '#2d4a33', barrier: '#6a727d', deck: '#4a525c', rail: '#9aa3af', shadow: 'rgba(0,0,0,.38)',
      land: { res: ['#3f5f86', '#4d739f'], work: ['#6b4f86', '#7d5d9a'], down: ['#8a6a2f', '#a07b37'], shop: ['#2f7a62', '#3b9277'] },
      bld: ['#394251', '#434e60', '#2f3744'], roof: ['#4a5567', '#56637a', '#3b4455'], label: '#cdd6e0', halo: 'rgba(15,19,24,.85)',
    },
    light: {
      ground: '#e5e8eb', park: '#cde3c6', tree: '#8bbd86', water: '#9ec9e6', bank: '#d9d2bd', waterHi: '#bddaee',
      walk: '#d3d7dc', asphalt: '#7d858f', hw: '#6f7782', shoulder: '#9aa1aa', line: 'rgba(255,255,255,.9)', dash: 'rgba(255,255,255,.6)',
      stop: '#d9871c', yellow: '#e3b73c', median: '#a9c9a0', barrier: '#bfc4cb', deck: '#9199a3', rail: '#5d6671', shadow: 'rgba(40,50,60,.28)',
      land: { res: ['#9db8d9', '#b4cae3'], work: ['#c3aedb', '#d3c2e6'], down: ['#e1c58c', '#ebd7a9'], shop: ['#9ad3bd', '#b3e0cf'] },
      bld: ['#c4cad3', '#d3d8df', '#b6bdc8'], roof: ['#d6dbe2', '#e4e8ed', '#c8ced8'], label: '#2a3440', halo: 'rgba(240,243,246,.85)',
    }
  };

  const STOPS = [[255, 77, 77], [255, 194, 51], [62, 230, 193]];
  const LUT = [];
  for (let i = 0; i <= 64; i++) {
    const r = i / 64, seg = r < 0.5 ? 0 : 1, f = r < 0.5 ? r * 2 : (r - 0.5) * 2;
    const a = STOPS[seg], b = STOPS[seg + 1];
    LUT.push(`rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`);
  }
  const speedColor = (r) => LUT[Math.round(Math.max(0, Math.min(1, r)) * 64)];

  const laneOff = (L, l) => ((L.lanes - 1) / 2 - l) * LW;

  class Renderer {
    constructor(canvas, net, decor) {
      this.cv = canvas; this.net = net; this.decor = decor;
      this.cam = { x: 1600, y: 600, z: 0.3 };
      this.stat = document.createElement('canvas');
      this.dirty = true; this.moved = false;
      this.theme = 'dark'; this.pal = PAL.dark;
      this.traffic = true; this.hits = [];
      this.sel = null; this.size = [0, 0, 1];
      this._prep(net);
    }

    setNet(net) { this.net = net; this._prep(net); this.dirty = true; }

    _prep(net) {
      const { atS } = MM;
      this.samples = net.links.map((L) => {
        const pts = [];
        for (let s = 0; s <= L.len; s += 15) { const p = atS(L.pts, L.cum, s); pts.push([p[0], p[1], s]); }
        return pts;
      });
    }

    setTheme(t) { if (t !== this.theme) { this.theme = t; this.pal = PAL[t]; this.dirty = true; } }

    // ------------------------------------------------------------ camera
    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (this.size[0] !== w || this.size[1] !== h || this.size[2] !== dpr) {
        this.size = [w, h, dpr];
        this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
        this.stat.width = this.cv.width; this.stat.height = this.cv.height;
        this.dirty = true;
        if (!this.moved) this.fit();
      }
    }
    fitAll() {
      const [w, h] = this.size, W = MM.WORLD;
      this.cam.z = Math.min(w / (W.w + 120), h / (W.h + 120));
      this.cam.x = W.w / 2; this.cam.y = W.h / 2; this.dirty = true; this.moved = true;
    }
    fit() {
      const [w, h] = this.size, W = MM.WORLD;
      if (w < 600) { this.cam.z = w / 1500; this.cam.x = 1400; this.cam.y = 520; this.dirty = true; this.moved = false; return; }
      this.fitAll(); this.moved = false;
    }
    view(x, y, z) { this.cam.x = x; this.cam.y = y; this.cam.z = z; this.dirty = true; this.moved = true; }
    zoomAt(px, py, f) {
      const c = this.cam, [w, h] = this.size;
      const wx = (px - w / 2) / c.z + c.x, wy = (py - h / 2) / c.z + c.y;
      const minZ = Math.min(w / (MM.WORLD.w + 120), h / (MM.WORLD.h + 120)) * 0.9;
      c.z = Math.max(minZ, Math.min(6, c.z * f));
      c.x = wx - (px - w / 2) / c.z; c.y = wy - (py - h / 2) / c.z;
      this.dirty = true; this.moved = true;
    }
    pan(dx, dy) { this.cam.x -= dx / this.cam.z; this.cam.y -= dy / this.cam.z; this.dirty = true; this.moved = true; }
    toWorld(px, py) { const c = this.cam, [w, h] = this.size; return [(px - w / 2) / c.z + c.x, (py - h / 2) / c.z + c.y]; }

    _xf(ctx) {
      const c = this.cam, [w, h, dpr] = this.size;
      ctx.setTransform(dpr * c.z, 0, 0, dpr * c.z, dpr * (w / 2 - c.x * c.z), dpr * (h / 2 - c.y * c.z));
    }
    _bounds(pad) {
      const c = this.cam, [w, h] = this.size;
      return [c.x - w / 2 / c.z - pad, c.y - h / 2 / c.z - pad, c.x + w / 2 / c.z + pad, c.y + h / 2 / c.z + pad];
    }

    // ------------------------------------------------------------ helpers
    _stroke(ctx, pts, width, color, cap) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineWidth = width; ctx.strokeStyle = color; ctx.lineCap = cap || 'butt'; ctx.lineJoin = 'round'; ctx.stroke();
    }
    _offset(L, d) {
      const key = 'o' + d;
      L._off = L._off || {};
      if (!L._off[key]) {
        const p = L.pts, out = [];
        for (let i = 0; i < p.length; i++) {
          const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
          const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
          out.push([p[i][0] - dy / l * d, p[i][1] + dx / l * d]);
        }
        L._off[key] = out;
      }
      return L._off[key];
    }
    _conn(mv, laneA, laneB, n) {
      const A = mv.from, B = mv.to, { atS, bezier } = MM;
      const a = atS(A.pts, A.cum, A.len), b = atS(B.pts, B.cum, 0);
      const oa = laneOff(A, laneA), ob = laneOff(B, laneB);
      const p0 = [a[0] - a[3] * oa, a[1] + a[2] * oa], p3 = [b[0] - b[3] * ob, b[1] + b[2] * ob];
      const k = mv.k;
      const p1 = [p0[0] + a[2] * k, p0[1] + a[3] * k], p2 = [p3[0] - b[2] * k, p3[1] - b[3] * k];
      return [p0, p1, p2, p3];
    }

    // ------------------------------------------------------------- static
    _drawStatic() {
      const ctx = this.stat.getContext('2d'), P = this.pal, net = this.net, z = this.cam.z;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = P.ground; ctx.fillRect(0, 0, this.stat.width, this.stat.height);
      this._xf(ctx);
      const B = this._bounds(60);
      const vis = (x0, y0, x1, y1) => x1 > B[0] && x0 < B[2] && y1 > B[1] && y0 < B[3];
      const D = this.decor;
      // parks
      ctx.fillStyle = P.park;
      for (const p of D.parks) if (vis(p[0], p[1], p[0] + p[2], p[1] + p[3])) { ctx.beginPath(); ctx.roundRect(p[0], p[1], p[2], p[3], 14); ctx.fill(); }
      // river
      this._stroke(ctx, D.river, MM.RIVER_W + 22, P.bank, 'round');
      this._stroke(ctx, D.river, MM.RIVER_W, P.water, 'round');
      if (z > 0.2) this._stroke(ctx, D.river.map((q, i) => [q[0] + 10 * Math.sin(i * 0.9), q[1]]), 3, P.waterHi, 'round');
      // buildings
      const detail = z > 0.28;
      for (const b of D.buildings) {
        if (!vis(b.x, b.y, b.x + b.w, b.y + b.h)) continue;
        const k = b.tone < 0.34 ? 0 : b.tone < 0.67 ? 1 : 2;
        const lu = this.landUse ? P.land[b.zone] : null;
        if (detail) { ctx.fillStyle = P.shadow; ctx.fillRect(b.x + b.z * 2.2, b.y + b.z * 2.8, b.w, b.h); }
        ctx.fillStyle = lu ? lu[0] : P.bld[k]; ctx.fillRect(b.x, b.y, b.w, b.h);
        if (detail) { ctx.fillStyle = lu ? lu[1] : P.roof[k]; ctx.fillRect(b.x + 2, b.y + 2, b.w - 4 - b.z, b.h - 4 - b.z); }
      }
      if (z > 0.3) {
        ctx.fillStyle = P.tree;
        for (const t of D.trees) if (t[0] > B[0] && t[0] < B[2] && t[1] > B[1] && t[1] < B[3]) { ctx.beginPath(); ctx.arc(t[0], t[1], t[2], 0, 7); ctx.fill(); }
      }
      // sidewalks / shoulders
      for (const L of net.links) {
        if (L.bridge) continue;
        if (L.kind === 'hw') this._stroke(ctx, L.pts, L.w + 5, P.shoulder);
        else if (L.kind === 'ramp') this._stroke(ctx, L.pts, L.lanes * LW + 2.2, P.shoulder);
        else this._stroke(ctx, L.pts, L.w + 5, P.walk);
      }
      // median fill (between the two carriageways)
      for (const L of net.links) {
        if (L.bridge || !L.twoWay || !L.rev || L.id > L.rev.id) continue;
        const kind = L.kind;
        const gap = MM.KINDS[kind].gap;
        const d = gap / 2 + L.lanes * LW / 2;
        const mid = this._offset(L, -d);
        if (kind === 'hw') { this._stroke(ctx, mid, gap + 2, P.shoulder); }
        else if (kind === 'art') this._stroke(ctx, mid, gap + 1, P.median);
      }
      // asphalt
      for (const L of net.links) {
        if (L.bridge) continue;
        this._stroke(ctx, L.pts, L.w, L.kind === 'hw' || L.kind === 'ramp' ? P.hw : P.asphalt);
      }
      // connectors at non-signal nodes
      for (const n of net.nodes) {
        if (n.type === 'signal' || n.type === 'gate') continue;
        for (const A of n.in) for (const mv of A.moves) {
          const B = mv.to;
          if (A.bridge || B.bridge) continue;
          const ramp = mv.kind === 'exit' || mv.kind === 'merge';
          const la = ramp ? 0 : (A.lanes - 1) >> 1, lb = ramp ? mv.outLane[0] : (B.lanes - 1) >> 1;
          const c = this._conn(mv, ramp ? (mv.kind === 'merge' ? 0 : 0) : la, lb);
          const wd = ramp ? LW * 1.05 : Math.max(A.lanes, B.lanes) * LW;
          const hwc = A.kind === 'hw' || B.kind === 'hw' || A.kind === 'ramp';
          const ringc = A.kind === 'ring' || B.kind === 'ring';
          const wr = ringc ? (A.kind === 'ring' ? B.w : A.w) : wd;
          const layers = ramp ? [[wd, P.hw]] : ringc ? [[wr + 2.2, P.walk], [wr, P.asphalt]] : [[wd + 5, hwc ? P.shoulder : P.walk], [wd, hwc ? P.hw : P.asphalt]];
          for (const [lw2, col] of layers) {
            ctx.beginPath(); ctx.moveTo(c[0][0], c[0][1]); ctx.bezierCurveTo(c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
            ctx.lineWidth = lw2; ctx.strokeStyle = col; ctx.lineCap = 'butt'; ctx.stroke();
          }
        }
      }
      // junction patches
      for (const n of net.nodes) {
        if (n.type !== 'signal') continue;
        const h = n.box - 0.5;
        ctx.fillStyle = P.walk; ctx.fillRect(n.x - h - 2.5, n.y - h - 2.5, 2 * h + 5, 2 * h + 5);
      }
      for (const n of net.nodes) {
        if (n.type !== 'signal') continue;
        const h = n.box - 0.5;
        ctx.fillStyle = P.asphalt; ctx.fillRect(n.x - h, n.y - h, 2 * h, 2 * h);
      }
      // roundabout islands
      for (const n of net.nodes) {
        if (n.type !== 'round') continue;
        const R = n.rl === 2 ? MM.RING_R2 : MM.RING_R, hw = n.rl === 2 ? 4.9 : 2.8;
        ctx.fillStyle = P.walk; ctx.beginPath(); ctx.arc(n.x, n.y, R - hw, 0, 7); ctx.fill();
        ctx.fillStyle = P.park; ctx.beginPath(); ctx.arc(n.x, n.y, R - hw - 1.2, 0, 7); ctx.fill();
        if (z > 0.3) { ctx.fillStyle = P.tree; ctx.beginPath(); ctx.arc(n.x - 3, n.y + 2, 4.5, 0, 7); ctx.arc(n.x + 4, n.y - 3, 3.5, 0, 7); ctx.fill(); }
      }
      // hw barrier (median)
      for (const L of net.links) {
        if (L.bridge || L.kind !== 'hw' || L.id > (L.rev ? L.rev.id : 1e9)) continue;
        const d = MM.KINDS.hw.gap / 2 + L.lanes * LW / 2;
        this._stroke(ctx, this._offset(L, -d), 1.1, P.barrier);
      }
      // markings
      if (z > 0.22) {
        for (const n of net.nodes) {
          if (n.type === 'signal' || n.type === 'gate') continue;
          for (const A of n.in) for (const mv of A.moves) {
            if (mv.kind !== 'straight' || A.lanes < 2 || mv.to.lanes < 2 || A.bridge || mv.to.bridge) continue;
            ctx.setLineDash([3, 6]);
            for (let i = 1; i < A.lanes; i++) {
              const d = ((A.lanes - 1) / 2 - (i - 0.5)) * LW;
              const c = this._conn(mv, 0, 0);
              const a = MM.atS(A.pts, A.cum, A.len), b = MM.atS(mv.to.pts, mv.to.cum, 0);
              const p0 = [a[0] - a[3] * d, a[1] + a[2] * d], p1 = [b[0] - b[3] * d, b[1] + b[2] * d];
              this._stroke(ctx, [p0, p1], Math.max(0.2, 1 / z), P.dash);
            }
            ctx.setLineDash([]);
          }
        }
        for (const L of net.links) {
          if (L.bridge) continue;
          this._markings(ctx, L, z);
        }
        if (z > 0.5) this._junctionMarks(ctx, net, z);
        if (z > 0.35) {
          for (const L of net.links) {
            if (L.stopS === undefined || L.bridge) continue;
            const p = MM.atS(L.pts, L.cum, L.stopS), o = L.w / 2 + 3.2;
            ctx.save(); ctx.translate(p[0] - p[3] * o, p[1] + p[2] * o); ctx.rotate(Math.atan2(p[3], p[2]));
            ctx.fillStyle = P.stop; ctx.fillRect(-3, -0.9, 6, 1.8); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(-2.6, -0.5, 5.2, 0.5);
            ctx.restore();
          }
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    _markings(ctx, L, z) {
      const P = this.pal, w = Math.max(0.25, 0.18);
      // lane dividers
      if (L.lanes > 1) {
        ctx.setLineDash([3, 6]);
        for (let i = 1; i < L.lanes; i++) {
          const d = ((L.lanes - 1) / 2 - (i - 0.5)) * LW;
          this._stroke(ctx, this._offset(L, d), Math.max(0.2, 1 / z), P.dash);
        }
        ctx.setLineDash([]);
      }
      // edge lines
      if (L.kind === 'hw' || L.kind === 'ramp') {
        this._stroke(ctx, this._offset(L, L.lanes * LW / 2 - 0.3), Math.max(0.28, 1.2 / z), P.line);
        if (L.kind === 'hw') this._stroke(ctx, this._offset(L, -L.lanes * LW / 2 + 0.3), Math.max(0.28, 1.2 / z), P.line);
      }
      // centre line on two-way local streets
      if (L.kind === 'loc' && L.twoWay && L.rev && L.id < L.rev.id) {
        const d = 1 + L.lanes * LW / 2;
        this._stroke(ctx, this._offset(L, -d), Math.max(0.3, 1 / z), P.yellow);
      }
      if (L.kind === 'art' && L.twoWay && L.rev && L.id < L.rev.id) {
        const d = 2.5 + L.lanes * LW / 2;
        ctx.setLineDash([]);
        this._stroke(ctx, this._offset(L, -d + 0.25), Math.max(0.22, 0.9 / z), P.yellow);
        this._stroke(ctx, this._offset(L, -d - 0.25), Math.max(0.22, 0.9 / z), P.yellow);
      }
    }

    _junctionMarks(ctx, net, z) {
      const P = this.pal;
      for (const n of net.nodes) {
        if (n.type !== 'rin') continue;
        const L = n.yieldIn, e = MM.atS(L.pts, L.cum, L.len), hx = e[2], hy = e[3], px = -hy, py = hx, wdt = L.w;
        ctx.setLineDash([0.9, 0.9]);
        ctx.beginPath(); ctx.moveTo(e[0] - hx * 1.5 - px * wdt / 2, e[1] - hy * 1.5 - py * wdt / 2); ctx.lineTo(e[0] - hx * 1.5 + px * wdt / 2, e[1] - hy * 1.5 + py * wdt / 2);
        ctx.lineWidth = Math.max(0.7, 1.8 / z); ctx.strokeStyle = P.line; ctx.stroke(); ctx.setLineDash([]);
        const cx = e[0] - hx * 5, cy = e[1] - hy * 5; ctx.lineWidth = Math.max(0.6, 1.6 / z);
        for (let t = -wdt / 2 + 0.9; t < wdt / 2; t += 1.8) { ctx.beginPath(); ctx.moveTo(cx + px * t - hx * 1.4, cy + py * t - hy * 1.4); ctx.lineTo(cx + px * t + hx * 1.4, cy + py * t + hy * 1.4); ctx.stroke(); }
      }
      for (const n of net.nodes) {
        if (n.type !== 'signal') continue;
        for (const L of n.in) {
          const e = MM.atS(L.pts, L.cum, L.len), hx = e[2], hy = e[3];
          const px = -hy, py = hx; // right normal
          const wdt = L.lanes * LW;
          // stop line
          const sx = e[0] - hx * 1.2, sy = e[1] - hy * 1.2;
          ctx.beginPath(); ctx.moveTo(sx - px * wdt / 2, sy - py * wdt / 2); ctx.lineTo(sx + px * wdt / 2, sy + py * wdt / 2);
          ctx.lineWidth = Math.max(0.6, 1.8 / z); ctx.strokeStyle = P.line; ctx.lineCap = 'butt'; ctx.stroke();
          // crosswalk
          const cx = e[0] - hx * 3.6, cy = e[1] - hy * 3.6;
          ctx.strokeStyle = P.line; ctx.lineWidth = Math.max(0.6, 1.6 / z);
          for (let t = -wdt / 2 + 0.9; t < wdt / 2; t += 1.8) {
            ctx.beginPath();
            ctx.moveTo(cx + px * t - hx * 1.4, cy + py * t - hy * 1.4); ctx.lineTo(cx + px * t + hx * 1.4, cy + py * t + hy * 1.4); ctx.stroke();
          }
          // turn arrows at high zoom
          if (z > 1.2 && L.len > 40) {
            for (let l = 0; l < L.lanes; l++) {
              const off = laneOff(L, l);
              const ax = e[0] - hx * 16 - hy * off, ay = e[1] - hy * 16 + hx * off;
              const kinds = new Set(L.moves.filter((m) => m.mask[l]).map((m) => m.kind));
              this._arrow(ctx, ax, ay, hx, hy, kinds);
            }
          }
        }
      }
    }

    _arrow(ctx, x, y, hx, hy, kinds) {
      const P = this.pal;
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(hy, hx));
      ctx.strokeStyle = P.line; ctx.fillStyle = P.line; ctx.lineWidth = 0.3; ctx.lineCap = 'round';
      // arrow points along +x
      const head = (px, py, ang) => { ctx.save(); ctx.translate(px, py); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(-0.2, 0.7); ctx.lineTo(-0.2, -0.7); ctx.fill(); ctx.restore(); };
      ctx.beginPath(); ctx.moveTo(-2.4, 0); ctx.lineTo(0.2, 0); ctx.stroke();
      if (kinds.has('straight') || kinds.size === 0) head(0.9, 0, 0);
      if (kinds.has('left') || kinds.has('u')) { ctx.beginPath(); ctx.moveTo(-0.6, 0); ctx.lineTo(-0.6, -1.4); ctx.lineTo(0, -1.4); ctx.stroke(); head(0.6, -1.4, 0); }
      if (kinds.has('right')) { ctx.beginPath(); ctx.moveTo(-0.6, 0); ctx.lineTo(-0.6, 1.4); ctx.lineTo(0, 1.4); ctx.stroke(); head(0.6, 1.4, 0); }
      ctx.restore();
    }

    // ---------------------------------------------------------- dynamic
    carPos(c) {
      const L = c.link, off = c.sep ? L.w / 2 + 1.3 : laneOff(L, c.lane);
      if (c.mv && c.s < 0 && !c.sep) {
        const mv = c.mv, t = Math.max(0, Math.min(1, (c.s + mv.len) / mv.len));
        const k = this._conn(mv, c.lane0 === undefined ? c.lane : c.lane0, c.lane);
        const b = MM.bezier(k[0], k[1], k[2], k[3], t), b2 = MM.bezier(k[0], k[1], k[2], k[3], Math.min(1, t + 0.02));
        const ang = t < 0.98 ? Math.atan2(b2[1] - b[1], b2[0] - b[0]) : Math.atan2(k[3][1] - k[2][1], k[3][0] - k[2][0]);
        return [b[0], b[1], ang];
      }
      const p = MM.atS(L.pts, L.cum, c.s), o = off + (c.lat || 0);
      let ang = Math.atan2(p[3], p[2]);
      if (c.lat) ang += Math.atan2(-Math.sign(c.lat) * 1.6, Math.max(c.v, 2));
      return [p[0] - p[3] * o, p[1] + p[2] * o, ang];
    }

    draw(now) {
      this.resize();
      const cv = this.cv, ctx = cv.getContext('2d'), net = this.net, P = this.pal, z = this.cam.z;
      if (this.dirty) { this._drawStatic(); this.dirty = false; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.stat, 0, 0);
      this._xf(ctx);
      const B = this._bounds(40);
      const inView = (x, y) => x > B[0] && x < B[2] && y > B[1] && y < B[3];

      // traffic colours
      if (this.traffic) {
        const a = z < 0.5 ? 0.85 : z < 1 ? 0.45 : z < 2 ? 0.14 : 0.06;
        ctx.globalAlpha = a;
        for (const L of net.links) {
          if (L.bridge && z > 0.5) continue;
          const col = speedColor(L.ratio * 1.0);
          this._stroke(ctx, L.pts, Math.max(L.w, 5 / z) * (z < 0.5 ? 1.0 : 0.9), col);
        }
        ctx.globalAlpha = 1;
      }

      // bus lanes (painted) and pedestrians
      if (net.p.busLanes) for (const L of net.links) {
        if (!L.busBan || L.bridge) continue;
        this._stroke(ctx, this._offset(L, ((L.lanes - 1) / 2) * LW), LW * 0.98, 'rgba(206,64,60,.55)');
      }
      this._peds(ctx, z);
      // cars on ground-level links
      this.hits = [];
      this._cars(ctx, false, z, inView, now);
      // bridges
      for (const L of net.links) {
        if (!L.bridge) continue;
        const w = L.w;
        this._stroke(ctx, L.pts.map((q) => [q[0] + 3, q[1] + 4]), w + 5, P.shadow);
      }
      for (const L of net.links) {
        if (!L.bridge) continue;
        const w = L.w;
        this._stroke(ctx, L.pts, w + 2.6, P.rail);
        this._stroke(ctx, L.pts, w + 1.2, P.deck);
        this._stroke(ctx, L.pts, w, L.kind === 'hw' ? P.hw : P.asphalt);
        if (z > 0.22) {
          if (L.lanes > 1) { ctx.setLineDash([3, 6]); for (let i = 1; i < L.lanes; i++) this._stroke(ctx, this._offset(L, ((L.lanes - 1) / 2 - (i - 0.5)) * LW), 0.2, P.dash); ctx.setLineDash([]); }
        }
        if (this.traffic) { ctx.globalAlpha = z < 0.5 ? 0.85 : z < 1 ? 0.45 : z < 2 ? 0.14 : 0.06; this._stroke(ctx, L.pts, Math.max(w, 5 / z), speedColor(L.ratio)); ctx.globalAlpha = 1; }
      }
      // bridge median connecting both decks
      for (const L of net.links) {
        if (!L.bridge || !L.rev || L.id > L.rev.id) continue;
        const gap = MM.KINDS[L.kind].gap, d = gap / 2 + L.lanes * LW / 2;
        this._stroke(ctx, this._offset(L, -d), gap + 0.6, P.deck);
        if (L.kind === 'hw') this._stroke(ctx, this._offset(L, -d), 1.0, P.barrier);
      }
      this._cars(ctx, true, z, inView, now);
      this._signals(ctx, z);
      this._markers(ctx, z, now);
      this._labels(ctx, z);
      if (this.sel) this._selection(ctx, z, now);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    _cars(ctx, bridgePass, z, inView, now) {
      const net = this.net, P = this.pal;
      const px = 1 / z;
      for (const L of net.links) {
        if (!!L.bridge !== bridgePass) continue;
        const all = L.bikes.length ? [...L.lanesArr, L.bikes] : L.lanesArr;
        for (const arr of all) for (const c of arr) {
          if (c.isObs) continue;
          const [x, y, ang] = this.carPos(c);
          if (!inView(x, y)) continue;
          const len = Math.max(c.len, (c.type === 'k' ? 2.6 : 4.2) * px), wid = Math.max(c.type === 't' || c.type === 'b' ? 2.5 : c.type === 'k' ? 0.8 : 1.9, (c.type === 'k' ? 1.4 : 2.1) * px);
          this.hits.push([x, y, c]);
          ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
          const col = speedColor(c.v / Math.max(8, c.link.vlim * 0.95));
          if (c.type === 'k') {
            ctx.fillStyle = '#35c27a'; ctx.fillRect(-len / 2, -wid / 2, len, wid);
          } else if (c.type === 'b') {
            ctx.fillStyle = '#f2a33a'; ctx.fillRect(-len / 2, -wid / 2, len, wid);
            ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillRect(-len / 2 + 1, -wid / 2 + 0.35, len - 2, 0.55); ctx.fillRect(-len / 2 + 1, wid / 2 - 0.9, len - 2, 0.55);
            ctx.fillStyle = col; ctx.fillRect(len / 2 - 2.2, -wid / 2, 2.2, wid);
          } else if (c.type === 't') {
            ctx.fillStyle = '#c9ced6'; ctx.fillRect(-len / 2, -wid / 2, len * 0.72, wid);
            ctx.fillStyle = col; ctx.fillRect(len * 0.2, -wid / 2, len * 0.3, wid);
          } else {
            ctx.fillStyle = col; ctx.fillRect(-len / 2, -wid / 2, len, wid);
          }
          if (len * z > 7) {
            ctx.fillStyle = 'rgba(10,15,22,.55)';
            if (c.type === 't') ctx.fillRect(len * 0.34, -wid / 2 + 0.2, len * 0.12, wid - 0.4);
            else ctx.fillRect(len * 0.12, -wid / 2 + 0.25, len * 0.22, wid - 0.5);
            if (c.at < -0.8) { ctx.fillStyle = '#ff2b2b'; ctx.fillRect(-len / 2, -wid / 2, 0.45, 0.6); ctx.fillRect(-len / 2, wid / 2 - 0.6, 0.45, 0.6); }
          }
          if (c.type === 'c') { ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = Math.max(0.3, px * 1.1); ctx.strokeRect(-len / 2, -wid / 2, len, wid); }
          else if (c.wander > 0) { ctx.strokeStyle = '#c77dff'; ctx.lineWidth = Math.max(0.3, px * 1.1); ctx.strokeRect(-len / 2, -wid / 2, len, wid); }
          ctx.restore();
          if (this.sel && this.sel.car === c) this.sel.pos = [x, y];
        }
      }
    }

    _peds(ctx, z) {
      if (z < 0.5) return;
      const t = this.net.t, px = 1 / z;
      for (const B of this.net.links) {
        if (!(B.pedUntil > t) || B.kind === 'hw' || B.kind === 'ramp') continue;
        const f = (t - B.pedStart) / (B.pedUntil - B.pedStart), dir = (Math.floor(B.pedStart) & 1) ? 1 : -1;
        const p = MM.atS(B.pts, B.cum, 3.6), half = B.w / 2 + 2.2;
        const lat = dir * (-half + 2 * half * f);
        ctx.fillStyle = '#ffd36b';
        for (let i = 0; i < 3; i++) {
          const o = lat + dir * i * 1.1, along = (i - 1) * 0.9;
          ctx.beginPath(); ctx.arc(p[0] - p[3] * o + p[2] * along, p[1] + p[2] * o + p[3] * along, Math.max(0.45, 2 * px), 0, 7); ctx.fill();
        }
      }
    }

    _signals(ctx, z) {
      const net = this.net;
      if (z < 0.4) return;
      for (const n of net.nodes) {
        if (n.type !== 'signal') continue;
        for (const L of n.in) {
          const st = n.st[L.group], e = MM.atS(L.pts, L.cum, L.len);
          const off = L.lanes * LW / 2 + 1.6;
          const x = e[0] - e[3] * off - e[2] * 0.8, y = e[1] + e[2] * off - e[3] * 0.8;
          const col = st === 2 ? '#37e08a' : st === 1 ? '#ffc233' : '#ff4d4d';
          ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, 3.2 / z), 0, 7); ctx.fill();
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, Math.max(1.1, 2.4 / z), 0, 7); ctx.fill();
        }
      }
    }

    _markers(ctx, z, now) {
      const net = this.net, pulse = 0.5 + 0.5 * Math.sin(now / 250);
      for (const L of net.links) {
        let s = null;
        if (L.obs) s = L.obs.s; else if (L.block !== null) s = L.block;
        if (s === null) continue;
        const p = MM.atS(L.pts, L.cum, s), off = L.obs ? laneOff(L, 0) : L.lanes * LW / 2 + 1.2;
        const x = p[0] - p[3] * off, y = p[1] + p[2] * off;
        const px = 1 / z;
        if (L.obs) {
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(p[3], p[2]));
          ctx.fillStyle = '#9e2020'; ctx.fillRect(-2.3, -1.1, 4.6, 2.2);
          ctx.fillStyle = '#ffd24a'; ctx.fillRect(-2.3, -1.1, 0.6, 2.2);
          ctx.restore();
          // cones upstream
          ctx.fillStyle = '#ff7a1a';
          for (let i = 1; i <= 3; i++) { const q = MM.atS(L.pts, L.cum, s - i * 6); ctx.beginPath(); ctx.arc(q[0] - q[3] * (off + (i - 2) * 0.4), q[1] + q[2] * (off + (i - 2) * 0.4), 0.6 + 0.6 * px, 0, 7); ctx.fill(); }
        } else {
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(p[3], p[2]));
          ctx.fillStyle = '#ff9f1c'; ctx.fillRect(-3.4, -1.3, 6.8, 2.6);
          ctx.fillStyle = '#222'; ctx.fillRect(1.2, -1.3, 0.5, 2.6);
          ctx.restore();
        }
        // pulsing halo so it is visible when zoomed out
        ctx.strokeStyle = `rgba(255,90,60,${0.35 + 0.5 * pulse})`; ctx.lineWidth = 1.6 * px;
        ctx.beginPath(); ctx.arc(x, y, (7 + 3 * pulse) * Math.max(1, px * 0.9), 0, 7); ctx.stroke();
      }
    }

    _labels(ctx, z) {
      const P = this.pal;
      const labels = [
        ['Highway 1', 1500, 232, 0], ['Highway 1', 400, 232, 0], ['Harbor Rd', 1400, 40, 1], ['Market St', 650, 40, 1], ['Eastside Blvd', 2550, 40, 1],
        ['1st Avenue', 420, 505, 0], ['2nd Avenue', 420, 745, 0], ['3rd Avenue', 420, 985, 0], ['River Run', 1905, 1230, 1],
      ];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = Math.max(10 / z, Math.min(26, 13 / z * 1.4));
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      for (const [t, x, y, vert] of labels) {
        if (z > 1.4) continue;
        ctx.save(); ctx.translate(x, y); if (vert) ctx.rotate(-Math.PI / 2);
        ctx.lineWidth = fs * 0.25; ctx.strokeStyle = P.halo; ctx.strokeText(t, 0, 0);
        ctx.fillStyle = P.label; ctx.fillText(t, 0, 0); ctx.restore();
      }
    }

    _selection(ctx, z, now) {
      const s = this.sel, px = 1 / z;
      ctx.lineWidth = 2 * px;
      if (s.car && s.pos) {
        ctx.strokeStyle = '#4aa8ff'; ctx.beginPath(); ctx.arc(s.pos[0], s.pos[1], 9 * px, 0, 7); ctx.stroke();
      } else if (s.node) {
        ctx.strokeStyle = '#4aa8ff'; ctx.beginPath(); ctx.arc(s.node.x, s.node.y, Math.max(s.node.box + 4, 12 * px), 0, 7); ctx.stroke();
      } else if (s.link) {
        ctx.strokeStyle = '#4aa8ff'; ctx.globalAlpha = 0.75;
        this._stroke(ctx, s.link.pts, s.link.w + 1.5, 'rgba(74,168,255,.35)');
        ctx.globalAlpha = 1;
        const p = MM.atS(s.link.pts, s.link.cum, s.at);
        ctx.beginPath(); ctx.arc(p[0], p[1], 7 * px, 0, 7); ctx.stroke();
      }
    }

    // -------------------------------------------------------- hit tests
    pick(px, py) {
      const [wx, wy] = this.toWorld(px, py), z = this.cam.z;
      let best = null, bd = (14 / z) ** 2;
      for (const h of this.hits) { const d = (h[0] - wx) ** 2 + (h[1] - wy) ** 2; if (d < bd) { bd = d; best = h[2]; } }
      if (best) return { car: best };
      for (const n of this.net.nodes) {
        if ((n.type !== 'signal' && n.type !== 'round') || n.box < 8) continue;
        if (Math.hypot(n.x - wx, n.y - wy) < Math.max(n.box * 0.85, 12 / z)) return { node: n };
      }
      let bl = null, bs = 0, bd2 = (Math.max(12 / z, 8)) ** 2;
      this.net.links.forEach((L, i) => {
        for (const q of this.samples[i]) {
          const d = (q[0] - wx) ** 2 + (q[1] - wy) ** 2;
          if (d < bd2) { bd2 = d; bl = L; bs = q[2]; }
        }
      });
      return bl ? { link: bl, at: bs } : null;
    }
  };

  Renderer.speedColor = speedColor;
  root.MetroRender = { Renderer, speedColor, PAL };
})(typeof self !== 'undefined' ? self : this);
