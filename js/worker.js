'use strict';
importScripts('map.js', 'net.js');
self.onmessage = (e) => {
  const { id, params, seconds, warm, seed } = e.data;
  self.postMessage({ id, r: self.NetSim.runNet(params, seconds, warm, seed) });
};
