/**
 * Home Time — BODS live bus proxy (Cloudflare Worker).
 *
 * Keeps your Bus Open Data Service API key secret, and turns BODS's large SIRI-VM
 * XML feed into a small JSON list of buses on one route.
 *
 *   GET /vehicles?line=Y1&bbox=minLat,maxLat,minLon,maxLon
 *   → { vehicles: [{ line, direction, operator, origin, destination,
 *                    originAimedDeparture, lat, lon, bearing, recordedAt, vehicleRef, journeyRef }],
 *       fetchedAt }
 *
 * Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
 *   BODS_API_KEY     (Secret)  your key from https://data.bus-data.dft.gov.uk/account/
 *   ALLOWED_ORIGINS  (Text)    e.g. https://agoldfish.github.io — comma-separate several.
 *                              Requests from other websites are refused.
 */

const BODS = 'https://data.bus-data.dft.gov.uk/api/v1/datafeed/';
const CACHE_SECONDS = 10; // BODS updates roughly every 10–30 s
const MAX_SPAN_DEG = 0.6; // biggest box we accept (~40 km), keeps responses small

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);
    if (!originOk) return json({ error: 'origin not allowed' }, 403, cors);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, keyConfigured: !!env.BODS_API_KEY }, 200, cors);
    if (url.pathname !== '/vehicles') return json({ error: 'not found' }, 404, cors);
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

    let xml;
    try {
      const upstream = await fetch(`${BODS}?boundingBox=${box.join(',')}&api_key=${encodeURIComponent(env.BODS_API_KEY)}`, {
        headers: { Accept: 'application/xml' },
        cf: { cacheTtl: CACHE_SECONDS },
      });
      if (!upstream.ok) return json({ error: `BODS replied ${upstream.status}` }, 502, cors);
      xml = await upstream.text();
    } catch (e) {
      return json({ error: 'could not reach BODS' }, 502, cors);
    }

    const want = line.toLowerCase();
    const vehicles = parseSiriVm(xml).filter((v) => v.line.toLowerCase() === want);
    const res = json({ vehicles, fetchedAt: new Date().toISOString() }, 200, { 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return withHeaders(res, cors);
  },
};

function parseBbox(s) {
  const n = (s || '').split(',').map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [minLat, maxLat, minLon, maxLon] = n;
  if (minLat >= maxLat || minLon >= maxLon) return null;
  if (maxLat - minLat > MAX_SPAN_DEG || maxLon - minLon > MAX_SPAN_DEG) return null;
  if (minLat < 49 || maxLat > 61 || minLon < -9 || maxLon > 2.5) return null;
  return n;
}

/** Extracts the useful bits of every <VehicleActivity> in a SIRI-VM document. */
export function parseSiriVm(xml) {
  const out = [];
  const blocks = xml.match(/<(?:\w+:)?VehicleActivity\b[^>]*>[\s\S]*?<\/(?:\w+:)?VehicleActivity>/g) || [];
  for (const b of blocks) {
    const lat = num(tag(b, 'Latitude'));
    const lon = num(tag(b, 'Longitude'));
    if (lat == null || lon == null || (lat === 0 && lon === 0)) continue;
    const line = tag(b, 'PublishedLineName') || tag(b, 'LineRef') || '';
    out.push({
      line,
      lineRef: tag(b, 'LineRef'),
      direction: tag(b, 'DirectionRef'),
      operator: tag(b, 'OperatorRef'),
      origin: clean(tag(b, 'OriginName')),
      destination: clean(tag(b, 'DestinationName')),
      originAimedDeparture: tag(b, 'OriginAimedDepartureTime'),
      lat,
      lon,
      bearing: num(tag(b, 'Bearing')),
      recordedAt: tag(b, 'RecordedAtTime'),
      vehicleRef: tag(b, 'VehicleRef'),
      journeyRef: tag(b, 'DatedVehicleJourneyRef') || tag(b, 'VehicleJourneyRef'),
    });
  }
  // BODS sometimes repeats a vehicle; keep its newest report.
  const latest = new Map();
  for (const v of out) {
    const k = `${v.operator}|${v.vehicleRef}|${v.originAimedDeparture}`;
    const prev = latest.get(k);
    if (!prev || (v.recordedAt || '') > (prev.recordedAt || '')) latest.set(k, v);
  }
  return [...latest.values()];
}

function tag(s, name) {
  const m = s.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? decode(m[1].trim()) : null;
}
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const clean = (v) => (v ? v.replace(/_/g, ' ') : v);
const decode = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
