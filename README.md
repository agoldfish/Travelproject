# Home Time 🏡

A small, colourful web app that shows **live bus and train journeys from wherever you are to home**. You can add it to your iPhone home screen like an app,
or open it from Siri with a Shortcut.

- A big countdown ring shows when to **leave**, along with what you're catching and when you'll be **home**.
- Journey cards have a coloured route ribbon (🚶 🚌 🚆), live delays and platforms where they're published.
  A red marker moves along the ribbon while you're travelling.
- Tabs show **✨ Best**, **🚌 Bus only** or **🚆 With train** journeys.
- A map draws the selected route.
- **Delay alerts:** tap *Delay alerts* and the app watches your next journey, plus any you tap 🔔 on.
  It alerts you when a bus or train is late (and again if it gets later), early, back on time, cancelled,
  or has left your stop early. You choose the threshold (1–10 min).
- **Lock-screen alerts:** once the Worker is set up, bus alerts arrive as iPhone notifications even
  with the app closed. Setup is in [`worker/README.md`](worker/README.md).

The journey planner needs no API key or account. Data comes from [Transitous](https://transitous.org), a free
open journey planner that uses UK bus open data and National Rail timetables. A journey is marked
**live** when that operator is sending real-time data. Otherwise it shows **timetable** times.

## Put it on your phone

1. Host the folder with GitHub Pages: open the repo's **Settings → Pages**, choose
   *Deploy from a branch*, pick the branch, and use the `/ (root)` folder. After a minute it's live at
   `https://agoldfish.github.io/Travelproject/`.
2. On your iPhone, open that link in **Safari**, tap **Share → Add to Home Screen**, and allow location
   when it asks.
3. Open the app from the home screen and set home: tap **I'm at home now** while you're there,
   or search for your address. Home is saved only on that phone and isn't in the code.
   iOS keeps the home-screen app's data separate from Safari, so set it inside the installed app.

## "Hey Siri, get me home" Shortcut

Shortcuts can send your location straight to the app, so it won't ask for location permission:

1. Open **Shortcuts → +**.
2. Add **Get Current Location**.
3. Add **Text** containing
   `https://agoldfish.github.io/Travelproject/?from=` then insert *Current Location → Latitude*, a comma,
   and *Current Location → Longitude*.
4. Add **Open URLs** (input: the Text).
5. Name it **Get me home**. Say "Hey Siri, get me home", or add it to your home screen or Action button.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Look, animations, light and dark mode |
| `app.js` | Location, journey fetching, countdowns, map |
| `live.js` | Live bus maths: match your bus, work out delay, stops away and arrival |
| `worker/` | Cloudflare Worker: live bus proxy and lock-screen alerts, plus setup guide |
| `tests/` | Run `npm install` once, then `npm test` |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home-screen app support and offline shell |

To change home, tap **change** next to *To* in the app.
You can also open the app with `?home=LAT,LON` in the link, which saves that point on the device.

## Native iPhone app (dormant)
A native version showing the journey as a Live Activity (lock screen and Dynamic Island) is planned in
[`agoldfish/iOS-thing`](https://github.com/agoldfish/iOS-thing), in the folder `home-time-live-activity/`.
Start with its `HANDOVER.md`.
