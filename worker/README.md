# Home Time Worker: live buses and lock-screen alerts

A small free **Cloudflare Worker** does two jobs for the app:

1. **Live bus tracking.** It asks the government's **Bus Open Data Service (BODS)** where buses are,
   keeping your BODS key secret. The app then shows *3 stops away · 2 min late · due 18:22* and a
   moving 🚌 on the map.
2. **Lock-screen delay alerts.** Your phone tells the Worker which buses you're watching. Once a
   minute the Worker checks them itself and sends a notification when one is late, gets later, is
   early, is back on time or has left your stop early. **This works even when the app is closed.**

Setup takes about 15 minutes in the Cloudflare dashboard, and nothing needs installing apart from
running one Node command on your Mac.

## 1. Get a BODS API key (free)
1. Register at <https://data.bus-data.dft.gov.uk/> as a **data consumer**.
2. Sign in, open **Account settings**, and copy your **API key**.

## 2. Make push keys (once)
These let your Worker sign notifications. On your Mac, in this repo, run:

```
node worker/make-vapid-keys.mjs
```

It prints a `VAPID_PUBLIC_KEY` and a `VAPID_PRIVATE_KEY`. Keep the private one secret.
Don't paste it into chats or commit it.

## 3. Create the Worker (free)
1. Log in at <https://dash.cloudflare.com/> and go to **Workers & Pages → Create → Create Worker**.
   Name it `hometime-bods` and click **Deploy**.
2. Click **Edit code**. Replace everything with the contents of
   **`worker/dist/hometime-worker.js`**, then **Deploy**.
3. **Storage for subscriptions:** go to **Storage & Databases → KV → Create** and name it `hometime-subs`.
   Back on the Worker, go to **Settings → Bindings → Add → KV namespace**. Set the variable name to
   `SUBS` and pick `hometime-subs`.
4. **Once-a-minute timer:** on the Worker, go to **Settings → Trigger events → Add → Cron trigger**,
   choose *every minute* (`* * * * *`) and save.
5. **Settings → Variables and Secrets.** Add:

   | Name | Type | Value |
   | --- | --- | --- |
   | `BODS_API_KEY` | Secret | your BODS key |
   | `VAPID_PRIVATE_KEY` | Secret | from step 2 |
   | `VAPID_PUBLIC_KEY` | Text | from step 2 |
   | `VAPID_SUBJECT` | Text | `mailto:` followed by an email address push services can contact about this server |
   | `ALLOWED_ORIGINS` | Text | `https://agoldfish.github.io` |

6. Check it: open `https://hometime-bods.YOURNAME.workers.dev/health` in a browser. You should see
   `{"ok":true,"keyConfigured":true,"pushConfigured":true}`.

To use the command line instead (`npx wrangler deploy`), see `wrangler.toml`.

## 4. Tell the app where the Worker is
Set `BODS_PROXY` near the top of `app.js` to your Worker address and push. The address isn't secret.
Alternatively, open the app once as `…/Travelproject/?proxy=https://hometime-bods.YOURNAME.workers.dev`
and the phone will remember it.

## 5. Turn on lock-screen alerts on your iPhone
1. Open the app in **Safari**, tap **Share → Add to Home Screen**, then **open it from the home screen**.
   iPhones only allow notifications for web apps opened this way.
2. Tap **Delay alerts** and choose **Allow** when asked about notifications.
3. The line under the button should say *🔒 Bus alerts reach your lock screen*. Tap
   **Send a test alert** to check.

The app always watches your next journey. Tap 🔔 on other journeys to watch them too (up to 6 buses).
Train alerts still need the app open, because only buses have live positions on the server.

## How it works
- **Live tracking:** the journey planner (Transitous) gives the trip's route shape and timetable. The
  Worker returns the buses on that route near you, and the app picks the bus whose first-stop departure
  time matches your trip. It places that bus on the route and compares its position with the timetable
  to get the delay.
- **Alerts:** when the watch list changes, the app sends a slimmed-down copy of each watched route (about
  2 KB) with your phone's push address. Every minute the Worker does the same maths and decides whether
  anything is worth telling you; small wobbles around your threshold don't trigger repeats. It then
  sends an encrypted Web Push message (RFC 8291) through Apple's push service.

## Free-plan limits
- **Requests:** the timer uses about 1,440 of the 100,000 free requests a day.
- **Storage writes:** the Worker only writes to storage when something changes (a new watch list or an
  alert), which stays well inside the 1,000 free writes a day.
- **CPU time:** each run must finish within the free plan's 10 ms of CPU time. If the Worker's logs
  show "exceeded CPU" errors (for example while watching several routes at once), the $5-a-month
  Workers Paid plan removes the problem.

## Code
- `src/index.js`: routes and the once-a-minute check
- `src/siri.js`: BODS fetching and parsing
- `src/webpush.js`: Web Push encryption and signing
- `../live.js`: the bus maths, shared with the app
- `dist/hometime-worker.js`: all of the above in one file for pasting. Rebuild with
  `npm run build:worker`; a test fails if it's out of date.
