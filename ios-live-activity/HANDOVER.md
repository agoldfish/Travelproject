# Handover: Home Time native iPhone app with a Live Activity

**Status: DORMANT.** Nothing here is built yet. This document holds everything needed to start,
written on 26 Nov 2026 alongside the Home Time web app in this repository. Read the latest
`README.md` and `worker/README.md` first, because the web project will have moved on since.

---

## 1. Goal

Show the user's next journey home in the iPhone's **Live Activity** areas: the **lock screen** and
the **Dynamic Island**. It should update live while the phone is locked.

- **Lock screen:** a route badge (for example a pink **Y1**), "Leave in 6 min" or "Due 18:22", a progress
  bar of the bus approaching the boarding stop ("3 stops away"), the delay ("2 min late"), and "Home by 18:53".
- **Dynamic Island**
  - Compact: `🚌 Y1 · 4 min`
  - Expanded: as on the lock screen
  - Minimal: the route badge
- **Alerts:** a delay, early running, cancellation or "your bus left early" lights up the screen with
  an alert. This replaces the web app's push notifications for buses.
- **Start and end:** it starts when the user picks a journey, or automatically for the next one, and
  ends on arrival or when the journey is over.

**Why native:** Live Activities exist only for native apps (ActivityKit + WidgetKit). Web apps, even
when added to the home screen, can't create them. The user said they're on **iOS 27**. I haven't checked
whether iOS 27 changed this, so check the iOS 27 release notes first. If web apps can now do it, most
of this plan is unnecessary.

## 2. The person and their preferences

- The app takes them home from wherever they are in the Bristol area, by bus and train.
- **Privacy:** the home address must **never** be in code, commits, fixtures or documents. The web
  app stores home only on the device. The repo's history was rewritten once to remove it. Keep it that way.
- **Style:** graphical and fun.
  - Emoji, rounded cards, a sky that changes with the time of day.
  - Colours: accent `#ff6b4a`, yellow `#ffc542`, bus pink `#e4007c`, GWR green `#0a493e`,
    ink `#23233f`, cream `#fff8ef`.
  - Fonts: Baloo 2 for headings, Nunito for body text.
  - Light and dark modes.
- **Equipment:** an iPhone (iOS 27) and a Mac with development tools, including Xcode.
- **Local models:** they asked to use local LLMs on the Mac for suitable work. See section 9.
- **Ways of working:** they prefer plain-English explanations, honest notes on what's been tested
  and what hasn't, and small steps they can check.

## 3. What already exists (reuse it)

All of this is in this repository on branch `claude/brave-curie-91dm4a`, unless it has since been merged.

| Piece | Where | Notes |
| --- | --- | --- |
| Web app (PWA) | `index.html`, `app.js`, `style.css`, `sw.js` | Journey planning, countdown, map, delay alerts, Web Push |
| Bus maths | `live.js` | No DOM and well tested. Matches the BODS vehicle to the planned trip, places it on the route and works out delay, stops away, ETA and "gone". Also has the alert decision logic (`decideAlert`, with hysteresis) and shared alert wording (`alertMessage`). **Port this to Swift, or keep it server-side.** |
| Cloudflare Worker | `worker/src/` | `/vehicles` BODS proxy, Web Push subscriptions in KV, and a once-a-minute cron (`runAlerts`) that already computes each watched bus's status |
| Tests | `tests/` | `npm install && npm test` (27 tests). The fixtures include a real Y1 trip. |

### Data sources and quirks we've already found the hard way
- **Transitous** (`https://api.transitous.org/api/v1/`) is a free, open journey planner covering UK buses
  and National Rail.
  - Endpoints used: `plan`, `trip?tripId=`, `geocode`.
  - Its UK data is mostly timetable only (`realTime: false`), so live bus data comes from BODS.
  - Requests that don't come from a browser need a **non-generic `User-Agent`** (a generic one is
    refused). See <https://transitous.org/api/>.
  - `trip` sometimes returns **a whole day of runs chained together** (for example the m1: 284 stops,
    07:10 to 02:34). Trim to the planned run using the plan leg's `tripFrom`/`tripTo`, as
    `live.js` `trimToRun` does.
  - Route shapes are encoded polylines, and their **precision varies (6 or 7)**, so always read
    `legGeometry.precision`.
- **BODS** (`https://data.bus-data.dft.gov.uk/api/v1/datafeed/`) gives SIRI-VM XML of bus positions.
  - `boundingBox` is **minLon,minLat,maxLon,maxLat (longitude first)**. With the wrong order it silently
    returns every bus in the country (about 10 MB).
  - It answers **406** to `Accept: application/xml`, so send `text/xml`.
  - Some reports are hours old; ignore anything over 30 minutes.
  - Match a bus to a trip by route number plus **`OriginAimedDepartureTime`** (within ±150 s).
  - The key is personal and must stay server-side. The original key was pasted into a chat, and the
    user was advised to regenerate it.
- Verified on 26 Nov 2026 against live data: 5 of 9 upcoming Bristol buses matched. The other 4 hadn't
  started their run yet.

## 4. Proposed architecture

```
 iPhone app (SwiftUI)                    Cloudflare Worker (existing, extend)
 ├─ WKWebView showing the PWA ──JS→Swift──▶ start/stop Live Activity
 ├─ ActivityKit: Activity<JourneyAttributes>
 │    pushTokenUpdates ───────────────────▶ POST /la/register {token, legs}
 └─ Widget extension                       cron (every minute, already exists):
      ActivityConfiguration                  status per watched bus (live.js)
      lock screen + Dynamic Island            └─▶ APNs push type "liveactivity"
                                                   content-state update (+ alert on changes)
```

- **Phase 1: a thin native shell.** A SwiftUI app hosting the existing PWA in a `WKWebView`. The page calls
  `window.webkit.messageHandlers.liveActivity.postMessage({...})` to start, update or end the activity.
  This reuses all the UI and logic and gets a Live Activity showing quickly. Updates only arrive while
  the app is running.
- **Phase 2: updates from the server.**
  - On start, send the activity's **push token** (`Activity.pushTokenUpdates`) to a new Worker
    endpoint.
  - Extend the Worker's cron (`runAlerts`) to send **ActivityKit push updates** through APNs:
    - headers `apns-push-type: liveactivity` and `apns-topic: <bundle-id>.push-type.liveactivity`
    - a payload with `aps.event: "update"`, `content-state`, `timestamp`, `stale-date`, and an
      `alert` for important changes
  - Use `apns-priority: 5` for routine updates and `10` only for alerts. Apple limits how often
    high-priority updates can be sent.
- **Phase 3 (optional):**
  - **Push-to-start** (iOS 17.2+) so the server can start the activity shortly before the next
    journey, without opening the app.
  - Then decide whether to replace the WebView with native SwiftUI screens.

### Suggested data model
```swift
struct JourneyAttributes: ActivityAttributes {
    let line: String          // "Y1"
    let lineColorHex: String  // "e4007c"
    let mode: String          // "bus" | "train"
    let boardStop: String     // "Cabot Circus"
    struct ContentState: Codable, Hashable {
        var status: String    // "coming" | "notyet" | "gone" | "cancelled" | "nosignal"
        var leaveAt: Date?
        var dueAt: Date       // live ETA at boarding stop
        var delayMin: Int
        var stopsAway: Int?
        var progress: Double  // 0…1 along the route towards the boarding stop
        var homeBy: Date
    }
}
```
Never put the home address in the attributes; use "Home".

## 5. Risks and open questions (check these first)
1. **Does iOS 27 allow web Live Activities?** If so, adapt the plan.
2. **Can Cloudflare Workers talk to APNs?** APNs requires HTTP/2 and token auth (an ES256 JWT signed with
   the `.p8` key; the JWT code in `worker/src/webpush.js` is a starting point). Check whether a Worker's
   `fetch` to `api.push.apple.com` works. If it doesn't, use a small relay elsewhere, for example a tiny
   server or a hosted push provider.
3. **Apple update budget:** keep routine updates sparing. Every minute at priority 5 should be OK, but
   confirm against Apple's current guidance.
4. **Free-plan CPU:** the cron must stay within the free plan's 10 ms per run. Adding APNs signing per
   update may push it over, in which case Workers Paid costs $5/month.
5. **Distribution:** decide between installing it on their own phone through Xcode and using TestFlight.

## 6. Prerequisites (the person needs to do these)
- An **Apple Developer Program** membership (£79/$99 a year). Push and Live Activity updates need it.
- A **Mac with Xcode**, a version that includes the iOS 27 SDK.
- In the developer account:
  - Create an App ID (bundle id, for example `uk.<yourname>.hometime`) with the **Push Notifications**
    capability.
  - Create an **APNs auth key (.p8)**, and note its **Key ID** and **Team ID**. Store the key as a Worker
    secret, never in the repo.
- The iPhone connected to the Mac, with **Developer Mode** on.

## 7. Plan with "done" checks
1. **Spike (½ day):**
   - Create an Xcode project with a SwiftUI app and a widget extension, and a hard-coded Live Activity
     with fake data.
   - Done when it shows on the lock screen and in the Dynamic Island on the device.
2. **Shell:**
   - Show the PWA in a WebView and add the JS bridge. Tapping 🔔 or "Track this journey" starts an
     activity with real data, which updates while the app is open.
3. **Server updates:**
   - Add Worker endpoint `/la/register` and APNs sending in the cron.
   - Done when the activity updates with the phone locked and the app closed. Check against a real
     late bus.
4. **Polish:**
   - Styling to match the web app, stale-date handling, ending on arrival, and alert wording via
     `alertMessage`.
5. **Tests:**
   - Port the `live.js` tests if the maths moves to Swift.
   - Unit-test the APNs payload builder in the Worker.

## 8. How to resume (checklist for the next session)
1. Pull this repo and read `README.md`, `worker/README.md` and this file. Run `npm install && npm test`.
2. Ask the person to connect their Mac:
   - In the Claude desktop app, **Settings → Claude Code → Remote Control**, share a folder (for example
     `~/Developer/HomeTimeLive`).
   - Then request that folder from the session.
   - When this handover was written, no folder had been shared yet.
3. On the Mac, check:
   - `xcodebuild -version`, `xcrun simctl list devices`, and `swift --version`
   - whether the developer account is signed in to Xcode
4. Check the open questions in section 5 before writing much code.
5. Decide whether this lives in this repo (`ios-live-activity/`) or in its own repository. The person
   described it as a **separate project**. If they create an empty repo, move this folder there and keep
   a link back.

## 9. Using local LLMs on the Mac
The person asked for suitable tasks to be offloaded to local models on their Mac. When the Mac is
connected, check for tools such as **Ollama** (`ollama list`), **LM Studio** or **llama.cpp**, and their
installed models.

Good tasks for a local model:
- generating test fixtures and sample SwiftUI previews
- drafting alert-wording variants
- summarising long build logs
- boilerplate, such as Codable structs from JSON samples

Keep these off local models:
- architecture decisions and security-sensitive code (APNs/JWT signing)
- anything that handles keys
- anything involving the home address

Always review local-model output before using it.
