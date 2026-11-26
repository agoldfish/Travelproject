// The whole lock-screen alert flow, with fakes for BODS, Cloudflare KV and Apple's push service:
// phone subscribes → timer runs each "minute" → encrypted notifications arrive and decrypt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import worker, { runAlerts } from '../worker/src/index.js';
import { generateVapidKeys } from '../worker/src/webpush.js';
import { fakeSubscription, decrypt } from './helpers/push-fakes.mjs';
const require = createRequire(import.meta.url);
const L = require('../live.js');

const ORIGIN = 'https://agoldfish.github.io';
const MIN = 60e3;

// Real Y1 trip, shifted so that our stop (the 20th) is due 12 minutes from now.
const trip = JSON.parse(fs.readFileSync(new URL('./fixtures/y1-trip.json', import.meta.url), 'utf8')).legs[0];
const BOARD = 20;
const base = L.buildProfile(trip);
const shift = Date.now() + 12 * MIN - base.stops[BOARD].sched;
const profile = { ...base, stops: base.stops.map((s) => ({ ...s, sched: s.sched + shift })), startSched: base.startSched + shift };
const st = profile.stops;
const leg = { key: 'trip-y1|stop20', line: 'Y1', name: 'Y1 bus', stop: st[BOARD].name, at: '18:15', profile: L.compactProfile(profile, BOARD) };

// Fakes.
const kv = { data: new Map(), writes: 0, async get(k, t) { const v = this.data.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { this.writes++; this.data.set(k, v); } };
let delayMin = 0;       // where the fake bus is relative to its timetable
let pushStatus = 201;   // what the fake push service answers
const pushed = [];
const vapid = await generateVapidKeys();
const phone = fakeSubscription('https://web.push.apple.com/QGuQyavXutnMQ');
const env = { BODS_API_KEY: 'k', ALLOWED_ORIGINS: ORIGIN, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:alerts@example.com', SUBS: kv };
globalThis.caches = { default: { async match() {}, async put() {} } };

function busXml() {
  // Put the bus where the timetable had it `delayMin` minutes ago.
  const t = Date.now() - delayMin * MIN;
  let i = 0; st.forEach((s, k) => { if (s.sched <= t) i = k; });
  const a = st[i], b = st[Math.min(i + 1, st.length - 1)];
  const f = b.sched > a.sched ? Math.min(1, Math.max(0, (t - a.sched) / (b.sched - a.sched))) : 0;
  const lat = a.lat + f * (b.lat - a.lat), lon = a.lon + f * (b.lon - a.lon);
  return `<Siri xmlns="http://www.siri.org.uk/siri"><ServiceDelivery><VehicleMonitoringDelivery>
    <VehicleActivity><RecordedAtTime>${new Date().toISOString()}</RecordedAtTime><MonitoredVehicleJourney>
      <LineRef>y1</LineRef><PublishedLineName>Y1</PublishedLineName><OperatorRef>FBRI</OperatorRef>
      <OriginAimedDepartureTime>${new Date(profile.startSched).toISOString()}</OriginAimedDepartureTime>
      <VehicleLocation><Longitude>${lon}</Longitude><Latitude>${lat}</Latitude></VehicleLocation><VehicleRef>FBRI-1</VehicleRef>
    </MonitoredVehicleJourney></VehicleActivity></VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
}
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://data.bus-data.dft.gov.uk/')) return new Response(busXml(), { status: 200 });
  if (url.startsWith('https://web.push.apple.com/')) {
    pushed.push({ headers: opts.headers, message: JSON.parse(decrypt(opts.body, phone)) });
    return new Response('', { status: pushStatus });
  }
  throw new Error('unexpected fetch ' + url);
};
const post = (path, body, origin = ORIGIN) => worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, {});
const titles = () => pushed.map((p) => p.message.title);

test('phone gets the public key and subscribes with the bus it is watching', async () => {
  const key = await (await worker.fetch(new Request('https://w.example/push/key', { headers: { Origin: ORIGIN } }), env, {})).json();
  assert.equal(key.publicKey, vapid.publicKey);
  const r = await post('/push/subscribe', { subscription: phone.sub, legs: [leg], min: 2 });
  assert.deepEqual(await r.json(), { ok: true, watching: 1 });
  assert.ok(JSON.stringify(leg).length < 60_000, `compact leg is ${JSON.stringify(leg).length} bytes`);
});

test('refuses non-push endpoints, other websites and junk', async () => {
  assert.equal((await post('/push/subscribe', { subscription: { ...phone.sub, endpoint: 'https://evil.example/x' }, legs: [] })).status, 400);
  assert.equal((await post('/push/subscribe', { subscription: phone.sub, legs: [] }, 'https://evil.example')).status, 403);
  const bad = await post('/push/subscribe', { subscription: phone.sub, legs: [{ ...leg, line: 'Y1;rm' }, { nope: 1 }, leg] });
  assert.deepEqual(await bad.json(), { ok: true, watching: 1 });
});

test('on time: nothing is sent, and nothing is written to storage', async () => {
  delayMin = 0;
  const writes = kv.writes;
  const s = await runAlerts(env);
  assert.equal(s.tracked, 1);
  assert.equal(s.pushed, 0);
  assert.equal(kv.writes, writes);
});

test('late, later, back on time: one encrypted notification each, no repeats', async () => {
  delayMin = 5;
  await runAlerts(env);
  await runAlerts(env); // same again: no repeat
  assert.deepEqual(titles(), ['🐢 18:15 Y1 bus is 5 min late']);
  assert.match(pushed[0].message.body, new RegExp(`^Now due at ${st[BOARD].name} at \\d\\d:\\d\\d\\.$`));
  assert.equal(pushed[0].headers.Urgency, 'high');
  assert.match(pushed[0].headers.Authorization, /^vapid t=.+, k=/);

  delayMin = 8; await runAlerts(env);
  delayMin = 0; await runAlerts(env);
  // The fake bus moves at a steady speed between stops, so allow a minute of rounding.
  assert.equal(titles().length, 3);
  assert.match(titles()[1], /^🐌 18:15 Y1 bus is now [89] min late$/);
  assert.equal(titles()[2], '✅ 18:15 Y1 bus is back on time');
});

test('test notification, and an expired phone subscription is removed', async () => {
  const r = await post('/push/test', { endpoint: phone.sub.endpoint });
  assert.equal(r.status, 200);
  assert.match(titles().at(-1), /alerts are working/);
  pushStatus = 410; delayMin = 6;
  const s = await runAlerts(env);
  assert.equal(s.removed, 1);
  assert.deepEqual(await kv.get('subs', 'json'), {});
});
