# Traffic Lab

One interactive metro in a single scheme: a 3-lane highway with three diamond interchanges and a
river bridge, street overpasses, 2-lane avenues and arterials with signalised junctions and
crosswalks, U-turns, single-lane local streets, 1- and 2-lane roundabouts (tap any junction to swap
signals for one), bus routes, bike lanes, parking, parks, buildings and a river crossed by bridges.

Break the traffic with causes (demand, time-of-day peak, braking noise, following gap, trucks,
parking cruisers, pedestrians, random incidents, breakdowns you place) and test fixes (tuned,
coordinated or adaptive signals, roundabouts, live navigation, ramp metering, variable speed limits,
connected cars, bus lanes, bike lanes, faster incident clearance, transit, staggered hours).
**Run diagnosis** re-runs the current setup in web workers over paired random demand patterns and
ranks each cause/fix by gain with a 95% interval, plus person-hours of delay and trip-time reliability.

Run: serve the folder (`python3 -m http.server`) and open `index.html`. No build, no dependencies.
Diagnosis falls back to the main thread if workers are unavailable (e.g. on `file://`).
Map: drag to pan, wheel or pinch to zoom, tap a road, junction or car for details.

## Files
- `js/map.js` network geometry and topology (links, junction movements, lane masks, roundabouts, zones, decor).
- `js/net.js` engine, headless-capable (see below). `js/worker.js` diagnosis worker.
- `js/render.js` canvas renderer and camera. `js/app.js` UI, charts, diagnosis.
- `tools/calibrate.js` calibration harness (closed 3-lane loop and a signal queue).

## Model
- **Drivers:** IDM with per-driver spread in desired speed, time gap, acceleration, braking and reaction
  lag; trucks, buses, bicycles, connected cars (look two cars ahead, 0.9 s gap).
- **Lanes:** MOBIL with route-driven mandatory changes, exit look-ahead of about 1.5 km on the highway,
  ghost occupancy of the old lane during a change, bus-lane rules, courtesy gaps for merging traffic.
- **Junctions:** two-phase signals (untuned / Webster-tuned from expected flows / green wave / adaptive);
  permissive left turns wait inside the box for gaps and clear on yellow; turning cars yield to
  pedestrians; roundabouts yield to circulating traffic and cap ring occupancy; ramp cars follow a gap in
  the right lane and merge at speed, with optional metering.
- **Demand:** trips between land-use zones (homes, work, downtown, shops) and map edges, curb parking with
  cruising and parking manoeuvres, time-of-day profile, demand elasticity to trip time, random incidents with
  clearance times. Common random numbers keep comparisons paired.
- **Routing:** habit routes from free-flow times; a share of drivers on live navigation, in four cohorts that
  update 5 s apart from successively averaged travel times.

## Calibration
`node tools/calibrate.js` matches published stylised facts, not a specific road:

| Quantity | Model | Target |
|---|---|---|
| Freeway capacity | about 2,100 veh/h/lane (flat from 30 to 40 veh/km/lane) | 1,900-2,200 |
| Backward wave speed | about 22 km/h | 15-25 |
| Signal saturation flow | about 1,800 veh/h of green/lane | 1,800-1,900 |
| Start-up delay of first car | 1.8 s | about 2 |

## Not done
- No fit to real trajectory or sensor data (highD, NGSIM, PeMS need registration). The defaults are matched to
  the table above only.
- SUMO is not integrated; this is an independent simplified engine.
- Still simplified: no protected left phases, no trams, no weather, no long-run land-use change.
