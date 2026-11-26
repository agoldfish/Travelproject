# Notes for Claude: Home Time (Travelproject)

A phone web app (PWA) showing live bus and train journeys from wherever you are to the owner's home, near
Bristol. It's graphical and fun: countdown ring, emoji, a sky that changes with the time of day. Live at
https://agoldfish.github.io/Travelproject/ (GitHub Pages).

## Hard rules
- **Never** put the owner's home address or its coordinates in code, commits, tests, fixtures or docs.
  Home is set in the app and stored only on the device (`localStorage`). The repo history was rewritten
  once to remove it.
- Keep keys out of the repo. The BODS API key and VAPID private key are Cloudflare Worker secrets.
  Scratch copies go only in the session scratchpad, and get deleted after use.
- Explain things to the owner in plain English. Say what was tested and what wasn't.

## Layout
- `index.html`, `style.css`, `app.js`: the app. Journey plans come from Transitous; it has a countdown,
  map, tabs, delay alerts (banners, chime, notifications) and the push subscription.
- `live.js`: bus maths shared by the app and the Worker. It matches the BODS vehicle to the trip, gives
  delay, stops away and ETA, decides alerts (`decideAlert`, with hysteresis) and words them (`alertMessage`).
- `sw.js`: offline shell, push handler, notification click. Bump `CACHE` when shell files change.
- `worker/src/`: the Cloudflare Worker. `/vehicles` is the BODS proxy, `/push/*` handles push
  subscriptions, and a once-a-minute cron (`runAlerts`) sends Web Push. `worker/dist/hometime-worker.js` is
  the single paste-ready file; rebuild it with `npm run build:worker` (a test fails if it's stale).
- `tests/`: run `npm install` once, then `npm test`. There are 27 Node tests, with the real Y1 trip as a
  fixture; encryption is cross-checked with Mozilla `http_ece`.

## Data quirks (already learned the hard way)
- Transitous (`api.transitous.org/api/v1`) has mostly timetable data in the UK.
  - Non-browser clients need a non-generic User-Agent.
  - `trip` can chain a whole day of runs, so trim with `tripFrom`/`tripTo`.
  - Polyline precision varies (6 or 7).
- BODS:
  - `boundingBox` order is **minLon,minLat,maxLon,maxLat**.
  - It answers 406 to `Accept: application/xml`.
  - It returns some stale reports; ignore anything over 30 min old.
  - Match buses by route number plus `OriginAimedDepartureTime`.

## Testing tips
- Playwright with Chromium is preinstalled. Load `file:///…/index.html?home=LAT,LON&proxy=https://proxy.test`,
  fake the proxy with `page.route`, and fake geolocation in the context. Use made-up or public places for
  home, never the real one.
- A bus waiting at its first stop before its start time is correctly "on time". Choose test times and
  destinations where buses are already mid-route.

## Status (26 Nov 2026)
- Done and pushed: journey planner UI, live bus tracking, in-app delay alerts, and lock-screen Web Push
  via the Worker.
- Waiting on the owner:
  - Set up the Cloudflare Worker (`worker/README.md`) with a **new** BODS key, because the old one was
    exposed in a chat.
  - Then set `BODS_PROXY` in `app.js`.
- Not yet verified: real push delivery to the owner's iPhone.
- The related native Live Activity app is a separate, dormant project in `agoldfish/iOS-thing`
  (`home-time-live-activity/`).
