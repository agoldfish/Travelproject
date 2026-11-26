// Run with: node --test tests/
// Exercises the Cloudflare Worker with a fake BODS server and a fake cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../worker/src/index.js';
import { parseSiriVm } from '../worker/src/siri.js';

const xml = fs.readFileSync(new URL('./fixtures/siri-vm-sample.xml', import.meta.url), 'utf8');
const ORIGIN = 'https://agoldfish.github.io';
const env = { BODS_API_KEY: 'test-key', ALLOWED_ORIGINS: ORIGIN };
const ctx = { waitUntil: (p) => p };

let calls = [];
globalThis.caches = { default: { store: new Map(), async match(r) { return this.store.get(r.url)?.clone(); }, async put(r, res) { this.store.set(r.url, res); } } };
// Pretend the sample was recorded just now, so the 30-minute age filter keeps it.
const fresh = xml.replace(/2026-11-26T18:29:(\d\d)\+00:00/g, (_, s) => new Date(Date.now() - (60 - +s) * 1000).toISOString());
globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(fresh, { status: 200 }); };

const get = (path, origin = ORIGIN) => worker.fetch(new Request(`https://w.example${path}`, { headers: origin ? { Origin: origin } : {} }), env, ctx);
const BBOX = '51.40,51.60,-2.70,-2.40';

test('parseSiriVm reads vehicles, tidies names, keeps the newest report per bus', () => {
  const v = parseSiriVm(xml);
  assert.equal(v.length, 2); // duplicate Y1 report merged, no-location entry dropped
  const y1 = v.find((x) => x.line === 'Y1');
  assert.equal(y1.lat, 51.479);
  assert.equal(y1.lon, -2.5531);
  assert.equal(y1.origin, 'The Centre');
  assert.equal(y1.destination, 'Yate & Chipping Sodbury');
  assert.equal(y1.recordedAt, '2026-11-26T18:29:50+00:00');
  assert.equal(y1.bearing, 45);
  assert.equal(y1.journeyRef, '1815');
});

test('returns only the requested route, with CORS for the app', async () => {
  calls = []; caches.default.store.clear();
  const r = await get(`/vehicles?line=y1&bbox=${BBOX}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const body = await r.json();
  assert.deepEqual(body.vehicles.map((v) => v.vehicleRef), ['FBRI-37123']);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /boundingBox=-2\.7,51\.4,-2\.4,51\.6&api_key=test-key$/);
});

test('a second request within the cache time does not hit BODS again', async () => {
  calls = []; caches.default.store.clear();
  await get(`/vehicles?line=Y1&bbox=${BBOX}`);
  const r = await get(`/vehicles?line=Y1&bbox=${BBOX}`);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 1);
});

test('refuses other websites, bad routes and oversized boxes', async () => {
  assert.equal((await get(`/vehicles?line=Y1&bbox=${BBOX}`, 'https://evil.example')).status, 403);
  assert.equal((await get(`/vehicles?line=Y1;drop&bbox=${BBOX}`)).status, 400);
  assert.equal((await get('/vehicles?line=Y1&bbox=50,53,-3,-1')).status, 400);
  assert.equal((await get('/vehicles?line=Y1&bbox=40,40.1,-3,-2.9')).status, 400);
});

test('drops reports older than 30 minutes', async () => {
  caches.default.store.clear();
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(xml, { status: 200 }); // sample times are long past
  const body = await (await get(`/vehicles?line=Y1&bbox=${BBOX}`)).json();
  globalThis.fetch = saved;
  assert.equal(body.vehicles.length, 0);
});

test('never leaks the key in responses', async () => {
  caches.default.store.clear();
  const text = await (await get(`/vehicles?line=Y1&bbox=${BBOX}`)).text();
  assert.ok(!text.includes('test-key'));
  const health = await (await get('/health')).json();
  assert.deepEqual(health, { ok: true, keyConfigured: true, pushConfigured: false });
});
