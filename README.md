# Home Time 🏡

A small, colourful web app that shows **live bus and train journeys from wherever you are to home**. You can add it to your iPhone home screen like an app,
or open it from Siri with a Shortcut.

- A big countdown ring shows when to **leave**, along with what you're catching and when you'll be **home**.
- Journey cards have a coloured route ribbon (🚶 🚌 🚆), live delays and platforms where they're published.
  A red marker moves along the ribbon while you're travelling.
- Tabs show **✨ Best**, **🚌 Bus only** or **🚆 With train** journeys.
- A map draws the selected route.
- **Live bus tracking (optional):** follows the exact bus you're catching using the government's Bus Open
  Data Service: *3 stops away · 2 min late · due 18:22*, plus a pulsing 🚌 on the map.
  Setup takes about 10 minutes; see [`worker/README.md`](worker/README.md).
- The sky changes with the time of day (day, dusk, night).
- It refreshes every minute and again when you reopen it. If GPS is off, type a starting place instead.

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
| `worker/` | Cloudflare Worker that keeps your BODS key secret, plus setup guide |
| `tests/` | Run `node --test tests/*.test.js tests/*.test.mjs` |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home-screen app support and offline shell |

To change home, tap **change** next to *To* in the app.
You can also open the app with `?home=LAT,LON` in the link, which saves that point on the device.
