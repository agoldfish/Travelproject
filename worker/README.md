# Live bus tracking setup (BODS + Cloudflare Worker)

Live tracking uses the government's **Bus Open Data Service (BODS)** to follow the exact bus you're
planning to catch: how many stops away it is, how late it's running and when it reaches your stop.

Your BODS key must stay secret, so the app never calls BODS directly. A small free
**Cloudflare Worker** (`bods-proxy.js`) holds the key and only answers requests from your app's website.

This takes about 10 minutes, and nothing needs to be installed.

## 1. Get a BODS API key (free)
1. Register at <https://data.bus-data.dft.gov.uk/> as a **data consumer**.
2. Sign in, open **Account settings**, and copy your **API key**.

## 2. Create the Worker (free)
1. Sign up or log in at <https://dash.cloudflare.com/>.
2. Go to **Workers & Pages → Create → Create Worker**. Name it `hometime-bods` and click **Deploy**.
3. Click **Edit code**. Delete what's there, paste in the whole of `worker/bods-proxy.js`, then **Deploy**.
4. Go back to the Worker and open **Settings → Variables and Secrets**. Add:
   - `BODS_API_KEY` as a **Secret**, set to your key from step 1
   - `ALLOWED_ORIGINS` as **Text**, set to `https://agoldfish.github.io`
5. Copy the Worker's address, for example `https://hometime-bods.YOURNAME.workers.dev`.
6. Check it: open `https://hometime-bods.YOURNAME.workers.dev/health` in a browser. You should see
   `{"ok":true,"keyConfigured":true}`.

To use the command line instead, run this inside this folder:
`npx wrangler deploy` and then `npx wrangler secret put BODS_API_KEY`.

## 3. Tell the app where the Worker is
Pick one:
- **Recommended:** set `BODS_PROXY` near the top of `app.js` to your Worker address and push. The address isn't secret; the key stays in Cloudflare.
- **Just on your phone:** open the app once as
  `https://agoldfish.github.io/Travelproject/?proxy=https://hometime-bods.YOURNAME.workers.dev`.
  The phone remembers it. Use `?proxy=off` to forget it.

Bus journeys then show a 🛰️ line, for example *Live · 3 stops away · 2 min late · due 18:22*. A pulsing 🚌
also appears on the map. If your first bus is running late, the "Leave in" countdown gives you the extra
time, minus a minute's safety margin.

## How it works
1. The journey planner (Transitous) gives the trip's full route shape and timetable for every stop, and
   the time it set off from its first stop.
2. The Worker asks BODS for buses inside a box around the route up to your stop, and keeps the ones on
   your route number.
3. The app picks the bus whose *first-stop departure time* matches your trip. It places that bus on the
   route line and compares its position with the timetable to get the delay. It then adds the delay to
   the scheduled time at your stop.

What the messages mean:
- **Not on the road yet**: the trip hasn't started.
- **No live signal**: the operator isn't sending this bus's position right now.
- **Has already left your stop**: the bus has passed your stop; the app moves on to the next journey.

BODS gives positions, not predictions, so the arrival time is an estimate. It's usually within a minute
or two. The Worker caches each answer for 10 seconds, so the free Cloudflare plan is more than enough.
