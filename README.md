# Traffic Lab

One interactive metro in a single scheme: a 3-lane highway with three diamond interchanges and a
river bridge, street overpasses, 2-lane avenues and arterials with signalised junctions, U-turns,
single-lane local streets, roundabouts (tap any junction to swap signals for one), parks, buildings and a river crossed by bridges.

Break the traffic with causes (demand, commuter tilt, braking noise, following gap, trucks, parking
cruisers, breakdowns, curbside disruptions, long signal cycles) and test fixes (adaptive or
coordinated signals, live rerouting, ramp metering, variable speed limits, connected cars, speed
limit, transit, staggered hours). **Run diagnosis** re-runs the current setup in web workers over
several seeds and ranks each cause/fix by speed gain.

Run: serve the folder (`python3 -m http.server`) and open `index.html`. No build, no dependencies.
(Diagnosis falls back to the main thread if workers are unavailable, e.g. on `file://`.)

Map: drag to pan, wheel or pinch to zoom, tap a road or car for details and to place a breakdown.

- `js/map.js`: network geometry and topology (links, junction movements, lane masks, decor).
- `js/net.js`: engine: IDM car following with reaction lag, MOBIL lane changes with route-driven
  mandatory changes, signals (fixed / green wave / adaptive), ramp merge gap acceptance and metering,
  U-turns, cost-based routing with optional live rerouting. Headless-capable.
- `js/render.js`: cached static scene + dynamic canvas layer, camera.
- `js/app.js`: UI, charts, diagnosis. `js/worker.js`: diagnosis worker.

The models are deliberately simple (no induced demand, buses, pedestrians or turn conflicts inside
junctions); results show direction and rough size, not forecasts.
