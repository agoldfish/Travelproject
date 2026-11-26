/**
 * Home Time — Cloudflare Worker.
 *
 * 1. Live bus proxy: keeps your Bus Open Data Service (BODS) key secret and returns the
 *    buses on one route as small JSON.
 *      GET  /vehicles?line=Y1&bbox=minLat,maxLat,minLon,maxLon
 * 2. Lock-screen delay alerts (Web Push): your phone registers the buses you're watching;
 *    a once-a-minute timer checks them against BODS and sends a notification when one is
 *    late, early, back on time or has left your stop early, even with the app closed.
 *      GET  /push/key            public key the phone needs to subscribe
 *      POST /push/subscribe      { subscription, legs, min }
 *      POST /push/unsubscribe    { endpoint }
 *      POST /push/test           { endpoint }  sends a test notification
 *
 * Settings (Cloudflare dashboard → your Worker → Settings), see worker/README.md:
 *   BODS_API_KEY       Secret  your key from https://data.bus-data.dft.gov.uk/account/
 *   ALLOWED_ORIGINS    Text    e.g. https://agoldfish.github.io (requests from other sites are refused)
 *   VAPID_PUBLIC_KEY   Text    } made once with worker/make-vapid-keys.mjs
 *   VAPID_PRIVATE_KEY  Secret  }
 *   VAPID_SUBJECT      Text    mailto: address push services can contact about this server
 *   SUBS               KV namespace binding (stores push subscriptions)
 *   Cron trigger       * * * * *
 */
import HomeLive from '../../live.js';
import { fetchVehicles } from './siri.js';
import { sendPush } from './webpush.js';

const CACHE_SECONDS = 10;  // BODS updates roughly every 10–30 s
const MAX_SPAN_DEG = 0.6;  // biggest box we accept (~40 km), keeps responses small
const SUBS_KEY = 'subs';
const MAX_SUBS = 10;
const MAX_LEGS = 6;
const MAX_BODY = 400_000;
const LOOKAHEAD_MIN = 90;  // only track buses due within this time
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!originOk) return json({ error: 'origin not allowed' }, 403, cors);

    try {
      if (request.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/health') {
          return json({ ok: true, keyConfigured: !!env.BODS_API_KEY, pushConfigured: pushReady(env) }, 200, cors);
        }
        if (url.pathname === '/vehicles') return await vehiclesRoute(url, env, ctx, cors);
        if (url.pathname === '/push/key') {
          if (!pushReady(env)) return json({ error: 'push alerts are not set up on this worker' }, 501, cors);
          return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
        }
      }
      if (request.method === 'POST' && url.pathname.startsWith('/push/')) {
        if (!pushReady(env)) return json({ error: 'push alerts are not set up on this worker' }, 501, cors);
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: 'too large' }, 413, cors);
        let body;
        try { body = JSON.parse(text); } catch { return json({ error: 'bad JSON' }, 400, cors); }
        if (url.pathname === '/push/subscribe') return await subscribeRoute(body, env, cors);
        if (url.pathname === '/push/unsubscribe') return await unsubscribeRoute(body, env, cors);
        if (url.pathname === '/push/test') return await testRoute(body, env, cors);
      }
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e.status ? `BODS replied ${e.status}` : 'server error' }, e.status ? 502 : 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env));
  },
};

const pushReady = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.SUBS);
const vapid = (env) => ({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:alerts@example.invalid' });

/* ---------------- /vehicles ---------------- */

async function vehiclesRoute(url, env, ctx, cors) {
  if (!env.BODS_API_KEY) return json({ error: 'BODS_API_KEY is not set on the worker' }, 500, cors);
  const line = (url.searchParams.get('line') || '').trim();
  if (!/^[A-Za-z0-9]{1,8}$/.test(line)) return json({ error: 'line must be a route number like Y1' }, 400, cors);
  const bbox = parseBbox(url.searchParams.get('bbox'));
  if (!bbox) return json({ error: `bbox must be minLat,maxLat,minLon,maxLon inside Great Britain, at most ${MAX_SPAN_DEG}° across` }, 400, cors);

  // Round the box so nearby requests share the cache.
  const r = (v, dir) => (dir < 0 ? Math.floor(v * 50) : Math.ceil(v * 50)) / 50;
  const box = [r(bbox[0], -1), r(bbox[1], 1), r(bbox[2], -1), r(bbox[3], 1)];
  const cacheKey = new Request(`https://bods-cache.invalid/v?line=${line.toUpperCase()}&bbox=${box.join(',')}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, cors);

  let vehicles;
  try {
    vehicles = await fetchVehicles(env.BODS_API_KEY, line, box, { cacheTtl: CACHE_SECONDS });
  } catch (e) {
    return json({ error: e.status ? `BODS replied ${e.status}` : 'could not reach BODS' }, 502, cors);
  }
  const res = json({ vehicles, fetchedAt: new Date().toISOString() }, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withHeaders(res, cors);
}

function parseBbox(s) {
  const n = (s || '').split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [minLat, maxLat, minLon, maxLon] = n;
  if (minLat >= maxLat || minLon >= maxLon) return null;
  if (maxLat - minLat > MAX_SPAN_DEG || maxLon - minLon > MAX_SPAN_DEG) return null;
  if (minLat < 49 || maxLat > 61 || minLon < -9 || maxLon > 2.5) return null;
  return n;
}

/* ---------------- push subscriptions ---------------- */

async function loadSubs(env) {
  return (await env.SUBS.get(SUBS_KEY, 'json')) || {};
}
async function saveSubs(env, subs) {
  await env.SUBS.put(SUBS_KEY, JSON.stringify(subs));
}

function validSubscription(s) {
  if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false;
  let u;
  try { u = new URL(s.endpoint); } catch { return false; }
  return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname) && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

const str = (v, max) => typeof v === 'string' && v.length <= max;
function cleanLeg(l) {
  const p = l && l.profile;
  if (!str(l.key, 300) || !/^[A-Za-z0-9]{1,8}$/.test(l.line || '') || !str(l.name, 60) || !str(l.stop, 120) || !str(l.at, 5)) return null;
  if (!p || !Array.isArray(p.pts) || p.pts.length < 2 || p.pts.length > 3000 || !Array.isArray(p.stops) || !p.stops.length || p.stops.length > 300) return null;
  if (!p.pts.every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) return null;
  if (!p.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.sched) && str(s.name || '', 120))) return null;
  if (!Number.isFinite(p.startSched) || !Number.isFinite(p.boardSched)) return null;
  return {
    key: l.key, line: l.line, name: l.name, stop: l.stop, at: l.at,
    profile: {
      pts: p.pts, startSched: p.startSched, boardSched: p.boardSched, boardStopId: str(p.boardStopId, 120) ? p.boardStopId : null,
      stops: p.stops.map((s) => ({ name: s.name || '', stopId: str(s.stopId, 120) ? s.stopId : null, lat: s.lat, lon: s.lon, sched: s.sched })),
    },
  };
}

async function subscribeRoute(body, env, cors) {
  if (!validSubscription(body.subscription)) return json({ error: 'not a supported push subscription' }, 400, cors);
  const legs = (Array.isArray(body.legs) ? body.legs : []).slice(0, MAX_LEGS).map(cleanLeg).filter(Boolean);
  const min = [1, 2, 3, 5, 10].includes(body.min) ? body.min : 2;
  const subs = await loadSubs(env);
  const { endpoint, keys } = body.subscription;
  const prev = subs[endpoint];
  if (!prev && Object.keys(subs).length >= MAX_SUBS) {
    // Make room by dropping the longest-unused subscription.
    const oldest = Object.values(subs).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    delete subs[oldest.endpoint];
  }
  // Keep what we've already alerted about, so changing the watch list doesn't repeat alerts.
  const keep = new Set(legs.map((l) => l.key));
  const mem = Object.fromEntries(Object.entries(prev?.mem || {}).filter(([k]) => keep.has(k)));
  subs[endpoint] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, min, legs, mem, updatedAt: Date.now() };
  await saveSubs(env, subs);
  return json({ ok: true, watching: legs.length }, 200, cors);
}

async function unsubscribeRoute(body, env, cors) {
  const subs = await loadSubs(env);
  if (body && subs[body.endpoint]) { delete subs[body.endpoint]; await saveSubs(env, subs); }
  return json({ ok: true }, 200, cors);
}

async function testRoute(body, env, cors) {
  const subs = await loadSubs(env);
  const sub = body && subs[body.endpoint];
  if (!sub) return json({ error: 'subscribe first' }, 404, cors);
  const r = await sendPush(sub, { title: '🎉 Home Time alerts are working', body: "You'll get delay alerts here, even with the app closed.", tag: 'test' }, vapid(env), { ttl: 120 });
  if (r.gone) { delete subs[sub.endpoint]; await saveSubs(env, subs); }
  return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, cors);
}

/* ---------------- the once-a-minute check ---------------- */

const fmt = (t) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(new Date(t));

/** Check every watched bus and push alerts. Returns a summary (used by tests and logs). */
export async function runAlerts(env, now = Date.now()) {
  const summary = { subs: 0, tracked: 0, requests: 0, pushed: 0, removed: 0, saved: false };
  if (!pushReady(env) || !env.BODS_API_KEY) return summary;
  const subs = await loadSubs(env);
  let changed = false;

  // Work out which bus legs need checking now.
  const jobs = [];
  for (const sub of Object.values(subs)) {
    summary.subs++;
    const before = sub.legs.length;
    sub.legs = sub.legs.filter((l) => l.profile.boardSched > now - 10 * 60e3); // drop journeys that are over
    if (sub.legs.length !== before) {
      changed = true;
      const keep = new Set(sub.legs.map((l) => l.key));
      for (const k of Object.keys(sub.mem)) if (!keep.has(k)) delete sub.mem[k];
    }
    for (const leg of sub.legs) {
      if (leg.profile.boardSched > now + LOOKAHEAD_MIN * 60e3 || leg.profile.boardSched < now - 2 * 60e3) continue;
      const { profile, boardIdx } = HomeLive.restoreProfile(leg.profile);
      jobs.push({ sub, leg, profile, boardIdx, box: HomeLive.searchBox(profile, boardIdx) });
    }
  }
  summary.tracked = jobs.length;

  // One BODS request per route number when the boxes fit together.
  const groups = new Map();
  for (const j of jobs) {
    const k = j.leg.line.toUpperCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const requests = [];
  for (const [line, js] of groups) {
    const u = HomeLive.unionBox(js.map((j) => j.box));
    if (u[1] - u[0] <= MAX_SPAN_DEG && u[3] - u[2] <= MAX_SPAN_DEG) requests.push({ line, box: u, js });
    else for (const j of js) requests.push({ line, box: j.box, js: [j] });
  }

  const pushes = [];
  for (const r of requests) {
    summary.requests++;
    let vehicles;
    try { vehicles = await fetchVehicles(env.BODS_API_KEY, r.line, r.box); } catch { continue; }
    for (const j of r.js) {
      const v = HomeLive.matchVehicle(vehicles, { routeShortName: j.leg.line }, j.profile);
      if (!v) continue;
      const st = HomeLive.liveStatus(j.profile, j.boardIdx, v, now);
      let cur = null;
      if (st.state === 'gone') cur = now < j.leg.profile.boardSched - 60e3 ? { state: 'gone' } : null;
      else if (st.state === 'coming') cur = { state: 'live', delay: st.delayMin, eta: st.eta };
      if (!cur) continue;
      const prev = j.sub.mem[j.leg.key] || null;
      const { alert, memory } = HomeLive.decideAlert(prev, cur, j.sub.min);
      if (memory !== prev) { j.sub.mem[j.leg.key] = memory; changed = true; }
      if (!alert) continue;
      const m = HomeLive.alertMessage(alert, cur.delay, { name: j.leg.name, at: j.leg.at, stop: j.leg.stop, due: cur.eta ? fmt(cur.eta) : '' });
      pushes.push({ sub: j.sub, message: { title: `${m.icon} ${m.title}`, body: m.body, tag: j.leg.key, type: alert } });
    }
  }

  for (const p of pushes) {
    if (!subs[p.sub.endpoint]) continue;
    try {
      const r = await sendPush(p.sub, p.message, vapid(env), { ttl: 600, topic: p.message.tag });
      if (r.ok) summary.pushed++;
      if (r.gone) { delete subs[p.sub.endpoint]; summary.removed++; changed = true; }
    } catch { /* try again next minute */ }
  }

  if (changed) { await saveSubs(env, subs); summary.saved = true; }
  return summary;
}

/* ---------------- helpers ---------------- */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
