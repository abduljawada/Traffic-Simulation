'use strict';
/*
 * Calibration harness. Runs the car-following model on (1) a closed 3-lane loop to get the
 * fundamental diagram and (2) a single-lane signal queue to get saturation flow and start-up lost
 * time, and prints them next to published stylised facts (HCM / Treiber & Kesting):
 *   freeway capacity 1900-2200 veh/h/lane, critical density 20-30 veh/km/lane,
 *   jam density 110-140 veh/km/lane, signal saturation flow 1800-1900 veh/h/lane, start-up lost ~2 s.
 * Usage: node tools/calibrate.js [headway]
 */
const { Net } = require('../js/net.js');
const MM = require('../js/map.js');

function mkMap(kind) {
  const nodes = {}, nodeList = [], links = [];
  const node = (id, type) => { const n = { id, x: 0, y: 0, type, in: [], out: [], box: 0, moves: 0, st: [2, 0], q: [], uturn: false }; nodes[id] = n; nodeList.push(n); return n; };
  const link = (from, to, len, lanes, kindL, vmax) => {
    const pts = [[0, 0], [len, 0]];
    const L = { id: links.length, from, to, pts, cum: [0, len], len, kind: kindL, lanes, vmax, w: lanes * 3.5, bridge: false, moves: [], h0: [1, 0], h1: [1, 0], group: 0, twoWay: false };
    links.push(L); from.out.push(L); to.in.push(L); return L;
  };
  const mv = (A, B, node) => { const m = { from: A, to: B, kind: 'straight', node, mask: new Array(A.lanes).fill(true), outLane: Array.from({ length: A.lanes }, (_, i) => Math.min(i, B.lanes - 1)), len: 2, pen: 0, h0: [1, 0], h1: [1, 0], k: 1, chord: 1 }; A.moves.push(m); };
  if (kind === 'ring') {
    const n0 = node('n0', 'plain'), L = link(n0, n0, 2000, 3, 'hw', 33.3);
    mv(L, L, n0); L.nextMain = L;
    return { links, nodes, nodeList, hwChain: { list: [{ link: L, off: 0 }], total: 2000 }, zones: { res: [], work: [], down: [], shop: [] }, zoneAt: () => 'res', AVENUES: [], INTERCHANGES: [], LW: 3.5 };
  }
  const g0 = node('g0', 'gate'), s = node('s', 'signal'), g1 = node('g1', 'gate');
  const L1 = link(g0, s, 600, 1, 'art', 16.7), L2 = link(s, g1, 600, 1, 'art', 16.7);
  mv(L1, L2, s);
  return { links, nodes, nodeList, hwChain: { list: [], total: 0 }, zones: { res: [], work: [], down: [], shop: [] }, zoneAt: () => 'res', AVENUES: [], INTERCHANGES: [], LW: 3.5 };
}

function mkNet(kind, p, seed) {
  const net = new Net(Object.assign({ demand: 0, busFreq: 0, incidents: 0, bikes: 0, peds: 0, roundabouts: [] }, p), seed || 1, mkMap(kind));
  net._enterLink = (c, L) => { c.stopS = null; c.next = L.moves[0] || null; };
  net._signals = () => {};
  return net;
}

function ring(k, p, seed) {
  const net = mkNet('ring', p, seed), L = net.links[0];
  const N = Math.round(k * 3 * 2); // k veh/km/lane * 3 lanes * 2 km
  for (let i = 0; i < N; i++) {
    const lane = i % 3, slot = (i / 3) | 0, per = N / 3;
    const c = net._newCar('h', L, lane, (slot + 0.3 * net.rand()) * 2000 / per, { key: 'x' }, 100);
    c.v = Math.min(25, Math.max(0, 2000 / per - 5) / 1.4); c.next = L.moves[0];
    net._insert(L.lanesArr[lane], c);
  }
  net.det = [L, L];
  const dt = 0.2; let sv = 0, n = 0;
  for (let i = 0; i < 1500; i++) net.step(dt);
  const t0 = net.t, c0 = net.moveCount.straight || 0;
  for (let i = 0; i < 3000; i++) { net.step(dt); sv += net.stats.n ? net.stats.hwV : 0; n++; }
  const flow = ((net.moveCount.straight || 0) - c0) / (net.t - t0) * 3600 / 3;
  return { k, flow, v: sv / n * 3.6 };
}

function queue(p, seed) {
  const net = mkNet('sig', p, seed), L = net.links[0], s = net.map.nodes.s;
  s.st = [0, 0];
  for (let i = 0; i < 25; i++) {
    const c = net._newCar('h', L, 0, 598 - i * 7.5, { key: 'x' }, 100);
    c.v = 0; c.next = L.moves[0]; net._insert(L.lanesArr[0], c);
  }
  for (let i = 0; i < 100; i++) net.step(0.2);
  s.st = [2, 0];
  const times = [];
  let last = net.moveCount.straight || 0;
  for (let i = 0; i < 400; i++) {
    net.step(0.2);
    const now = net.moveCount.straight || 0;
    for (let k = last; k < now; k++) times.push(net.t - 20);
    last = now;
  }
  const n = times.length;
  const hdw = times.slice(1).map((t, i) => t - times[i]);
  const sat = hdw.slice(4, 16).reduce((a, b) => a + b, 0) / Math.max(1, hdw.slice(4, 16).length);
  const lost = times[4] - 5 * sat;
  return { first: times[0], sat: 3600 / sat, lost: Math.max(0, lost), n };
}

module.exports = { ring, queue };
if (require.main === module) main();
function main() {
const headway = process.argv[2] ? +process.argv[2] : undefined;
const p = headway ? { headway } : {};
console.log('headway', headway || 'default', '\nFundamental diagram (3-lane loop, noise on):');
console.log('dens veh/km/lane | flow veh/h/lane | speed km/h');
const rows = [];
for (const k of [10, 15, 20, 25, 30, 35, 40, 50, 60, 80, 100, 120]) {
  const r = ring(k, p, 3); rows.push(r);
  console.log(String(k).padStart(8), String(Math.round(r.flow)).padStart(16), r.v.toFixed(0).padStart(14));
}
const cap = rows.reduce((b, r) => (r.flow > b.flow ? r : b), rows[0]);
console.log(`capacity ${Math.round(cap.flow)} veh/h/lane at ${cap.k} veh/km/lane  (target 1900-2200 at 20-30)`);
let q; try { q = queue(p, 3); } catch (e) { console.log("queue test failed:", e.message); process.exit(0); }
console.log(`signal queue: first car crosses ${q.first.toFixed(1)} s after green, saturation ${Math.round(q.sat)} veh/h/lane, lost time ${q.lost.toFixed(1)} s (target 1800-1900, ~2 s)`);
}
