# Traffic Lab

Interactive traffic simulation: a multi-lane highway loop and a signalised city grid.
Break the traffic with causes (volume, braking noise, merging, breakdowns, parking cruisers,
curbside disruptions, bad signals) and test fixes (more lanes, automated cars, variable speed
limits, ramp metering, adaptive signals, transit, staggered hours). **Run diagnosis** re-runs
the current setup headlessly over several seeds and ranks each cause/fix by speed gain.

Run: open `index.html` in a browser (no build, no dependencies).

- `js/highway.js`: IDM car-following + reaction lag, MOBIL lane changing, ramp merge, breakdown.
- `js/city.js`: IDM on a grid, two-phase fixed / coordinated / adaptive signals, spillback.
- `js/app.js`: UI, rendering, charts, diagnosis.

The models are deliberately simple (no induced demand, rerouting, turn conflicts or pedestrians);
results show direction and rough size, not forecasts.
