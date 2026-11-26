var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// live.js
var require_live = __commonJS({
  "live.js"(exports, module) {
    (function(root) {
      "use strict";
      const M_PER_DEG_LAT = 110540;
      const ON_ROUTE_M = 120;
      const STOP_SNAP_M = 40;
      const MATCH_WINDOW_S = 150;
      function decodePolyline(str2, precision = 6) {
        const f = 10 ** precision, out = [];
        let i = 0, lat = 0, lon = 0;
        while (i < str2.length) {
          for (let which = 0; which < 2; which++) {
            let shift = 0, result = 0, b;
            do {
              b = str2.charCodeAt(i++) - 63;
              result |= (b & 31) << shift;
              shift += 5;
            } while (b >= 32);
            const d = result & 1 ? ~(result >> 1) : result >> 1;
            if (which === 0) lat += d;
            else lon += d;
          }
          out.push([lat / f, lon / f]);
        }
        return out;
      }
      function projector(lat0) {
        const kx = Math.cos(lat0 * Math.PI / 180) * 111320;
        return (lat, lon) => [lon * kx, lat * M_PER_DEG_LAT];
      }
      function onSegment(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
        const x = a[0] + t * dx, y = a[1] + t * dy;
        return { t, off: Math.hypot(p[0] - x, p[1] - y) };
      }
      const ms = (s) => s ? Date.parse(s) : NaN;
      function buildProfile(tripLeg, planLeg) {
        const g = tripLeg.legGeometry;
        const pts = decodePolyline(g.points, g.precision ?? 6);
        const raw = [tripLeg.from, ...tripLeg.intermediateStops || [], tripLeg.to].map((s) => ({
          name: s.name,
          stopId: s.stopId,
          lat: s.lat,
          lon: s.lon,
          sched: ms(s.scheduledDeparture) || ms(s.scheduledArrival) || ms(s.departure) || ms(s.arrival)
        }));
        const profile = profileFromPoints(pts, raw);
        return planLeg ? trimToRun(profile, planLeg) : profile;
      }
      function profileFromPoints(pts, raw) {
        const proj = projector(pts[0][0]);
        const xy = pts.map(([la, lo]) => proj(la, lo));
        const cum = [0];
        for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
        const stops = [];
        let seg = 0;
        for (const s of raw) {
          const p = proj(s.lat, s.lon);
          let best = null;
          for (let i = seg; i < xy.length - 1; i++) {
            const r = onSegment(p, xy[i], xy[i + 1]);
            if (!best || r.off < best.off) best = { ...r, i };
            if (r.off <= STOP_SNAP_M) {
              best = { ...r, i };
              for (let j = i + 1; j < xy.length - 1; j++) {
                const n = onSegment(p, xy[j], xy[j + 1]);
                if (n.off > best.off + 1) break;
                if (n.off <= best.off) best = { ...n, i: j };
              }
              break;
            }
          }
          if (!best) best = { i: Math.max(0, xy.length - 2), t: 1, off: 0 };
          seg = best.i;
          const dist = cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i] || 0);
          stops.push({
            name: s.name,
            stopId: s.stopId,
            lat: s.lat,
            lon: s.lon,
            sched: s.sched,
            dist: stops.length ? Math.max(dist, stops[stops.length - 1].dist) : dist
          });
        }
        return { pts, xy, cum, proj, stops, startSched: stops.length ? stops[0].sched : NaN, length: cum[cum.length - 1] };
      }
      function compactProfile(profile, boardIdx) {
        const board = profile.stops[boardIdx];
        const lo = board.dist - 3e4, hi = board.dist + 1500;
        const pts = [];
        let last = -Infinity;
        profile.pts.forEach((p, i) => {
          const d = profile.cum[i];
          if (d < lo || d > hi) return;
          if (d - last >= 25 || i === profile.pts.length - 1) {
            pts.push([+p[0].toFixed(5), +p[1].toFixed(5)]);
            last = d;
          }
        });
        const stops = profile.stops.map((s, i) => ({ s, i })).filter(({ s, i }) => i <= boardIdx + 3 && s.dist >= lo && s.dist <= hi).map(({ s }) => ({ name: s.name, stopId: s.stopId, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), sched: s.sched }));
        return { pts, stops, startSched: profile.startSched, boardStopId: board.stopId, boardSched: board.sched };
      }
      function restoreProfile(c) {
        const profile = profileFromPoints(c.pts, c.stops);
        profile.startSched = c.startSched;
        let boardIdx = profile.stops.findIndex((s) => s.stopId === c.boardStopId && s.sched === c.boardSched);
        if (boardIdx < 0) boardIdx = profile.stops.findIndex((s) => s.sched === c.boardSched);
        return { profile, boardIdx: Math.max(0, boardIdx) };
      }
      function trimToRun(profile, planLeg) {
        const st = profile.stops;
        const find = (place, from = 0) => {
          if (!place) return -1;
          const t = ms(place.scheduledDeparture) || ms(place.scheduledArrival);
          for (let i = from; i < st.length; i++) {
            if (Math.abs(st[i].sched - t) <= 6e4 && (st[i].stopId === place.stopId || st[i].name === place.name)) return i;
          }
          return -1;
        };
        const a = find(planLeg.tripFrom);
        if (a < 0) return profile;
        let b = find(planLeg.tripTo, a + 1);
        if (b < 0) b = st.length - 1;
        if (a === 0 && b === st.length - 1) return profile;
        return { ...profile, stops: st.slice(a, b + 1), startSched: st[a].sched };
      }
      function schedAt(profile, d) {
        const st = profile.stops;
        if (d <= st[0].dist) return st[0].sched;
        for (let i = 1; i < st.length; i++) {
          if (d <= st[i].dist) {
            const a = st[i - 1], b = st[i];
            const f = b.dist > a.dist ? (d - a.dist) / (b.dist - a.dist) : 1;
            return a.sched + f * (b.sched - a.sched);
          }
        }
        return st[st.length - 1].sched;
      }
      function distAtTime(profile, t) {
        const st = profile.stops;
        if (t <= st[0].sched) return st[0].dist;
        for (let i = 1; i < st.length; i++) {
          if (t <= st[i].sched) {
            const a = st[i - 1], b = st[i];
            const f = b.sched > a.sched ? (t - a.sched) / (b.sched - a.sched) : 1;
            return a.dist + f * (b.dist - a.dist);
          }
        }
        return st[st.length - 1].dist;
      }
      function locateOnRoute(profile, lat, lon, atTime) {
        const p = profile.proj(lat, lon);
        const expected = distAtTime(profile, atTime);
        const passes = [];
        let cur = null, nearest = null;
        for (let i = 0; i < profile.xy.length - 1; i++) {
          const r = onSegment(p, profile.xy[i], profile.xy[i + 1]);
          const d = profile.cum[i] + r.t * (profile.cum[i + 1] - profile.cum[i]);
          if (!nearest || r.off < nearest.off) nearest = { d, off: r.off };
          if (r.off <= ON_ROUTE_M) {
            if (!cur) passes.push(cur = { d, off: r.off });
            else if (r.off < cur.off) {
              cur.d = d;
              cur.off = r.off;
            }
          } else cur = null;
        }
        let best = null;
        for (const c of passes) if (!best || Math.abs(c.d - expected) < Math.abs(best.d - expected)) best = c;
        return best || (nearest && nearest.off <= ON_ROUTE_M * 3 ? nearest : null);
      }
      function boardingIndex(profile, leg) {
        const st = profile.stops;
        const want = ms(leg.from.scheduledDeparture) || ms(leg.startTime);
        let byId = st.findIndex((s) => s.stopId && s.stopId === leg.from.stopId && Math.abs(s.sched - want) < 12e4);
        if (byId < 0) byId = st.findIndex((s) => s.stopId && s.stopId === leg.from.stopId);
        if (byId >= 0) return byId;
        let bi = 0;
        st.forEach((s, i) => {
          if (Math.abs(s.sched - want) < Math.abs(st[bi].sched - want)) bi = i;
        });
        return bi;
      }
      function matchVehicle(vehicles, leg, profile) {
        const line = String(leg.routeShortName || "").toLowerCase();
        const start = profile.startSched ?? profile.stops[0].sched;
        let best = null;
        for (const v of vehicles || []) {
          if (String(v.line || "").toLowerCase() !== line && String(v.lineRef || "").toLowerCase() !== line) continue;
          const diff = Math.abs(ms(v.originAimedDeparture) - start) / 1e3;
          if (!(diff <= MATCH_WINDOW_S)) continue;
          if (!best || diff < best.diff || diff === best.diff && (v.recordedAt || "") > (best.v.recordedAt || "")) best = { v, diff };
        }
        return best ? best.v : null;
      }
      function liveStatus(profile, boardIdx, v, now = Date.now()) {
        const seen = ms(v.recordedAt) || now;
        const base = { lat: v.lat, lon: v.lon, bearing: v.bearing, ageSec: Math.max(0, Math.round((now - seen) / 1e3)), vehicleRef: v.vehicleRef };
        const where = locateOnRoute(profile, v.lat, v.lon, seen);
        const board = profile.stops[boardIdx];
        if (!where) return { ...base, state: "unknown" };
        if (where.d > board.dist + 40) return { ...base, state: "gone", along: where.d };
        let delaySec = (seen - schedAt(profile, where.d)) / 1e3;
        if (profile.stops[0].sched === profile.startSched && where.d <= profile.stops[0].dist + 30 && seen < profile.stops[0].sched) delaySec = 0;
        const etaMs = Math.max(now, board.sched + Math.max(delaySec, -120) * 1e3);
        const stopsAway = profile.stops.slice(0, boardIdx + 1).filter((s) => s.dist > where.d + 15).length;
        return {
          ...base,
          state: "coming",
          along: where.d,
          delayMin: Math.round(delaySec / 60),
          stopsAway,
          metresAway: Math.max(0, Math.round(board.dist - where.d)),
          eta: etaMs
        };
      }
      function searchBox(profile, boardIdx, maxSpan = 0.5, pad = 0.01) {
        const board = profile.stops[boardIdx];
        const pts = profile.pts.filter((_, i) => profile.cum[i] <= board.dist + 100 && profile.cum[i] >= board.dist - 3e4);
        if (!pts.length) pts.push([board.lat, board.lon]);
        let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (const [la, lo] of pts) {
          minLat = Math.min(minLat, la);
          maxLat = Math.max(maxLat, la);
          minLon = Math.min(minLon, lo);
          maxLon = Math.max(maxLon, lo);
        }
        const clamp = (lo, hi, c) => hi - lo > maxSpan - 2 * pad ? [c - (maxSpan / 2 - pad), c + (maxSpan / 2 - pad)] : [lo, hi];
        [minLat, maxLat] = clamp(minLat, maxLat, board.lat);
        [minLon, maxLon] = clamp(minLon, maxLon, board.lon);
        return [minLat - pad, maxLat + pad, minLon - pad, maxLon + pad];
      }
      function unionBox(boxes) {
        return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])]);
      }
      function decideAlert(prev, cur, min = 2) {
        const was = prev ? prev.type : "ontime";
        if (cur.state === "cancelled") return was === "cancelled" ? { alert: null, memory: prev } : { alert: "cancelled", memory: { type: "cancelled" } };
        if (cur.state === "gone") return was === "gone" ? { alert: null, memory: prev } : { alert: "gone", memory: { type: "gone" } };
        if (was === "cancelled" || was === "gone") return { alert: null, memory: prev };
        const d = cur.delay;
        if (!Number.isFinite(d)) return { alert: null, memory: prev };
        if (d >= min) {
          if (was !== "late") return { alert: "late", memory: { type: "late", delay: d } };
          if (d >= prev.delay + 2) return { alert: "later", memory: { type: "late", delay: d } };
          return { alert: null, memory: prev };
        }
        if (d <= -min) return was === "early" ? { alert: null, memory: prev } : { alert: "early", memory: { type: "early", delay: d } };
        if ((was === "late" || was === "early") && Math.abs(d) <= Math.max(0, min - 2)) return { alert: "recovered", memory: { type: "ontime", delay: d } };
        return { alert: null, memory: prev };
      }
      function alertMessage(type, delay, info) {
        const leave = info.leaveAt ? ` You can leave at ${info.leaveAt}.` : "";
        const alt = info.alt ? ` Next option: ${info.alt}.` : "";
        const t = `${info.at} ${info.name}`;
        switch (type) {
          case "late":
            return { icon: "\u{1F422}", title: `${t} is ${delay} min late`, body: `Now due at ${info.stop} at ${info.due}.${leave}` };
          case "later":
            return { icon: "\u{1F40C}", title: `${t} is now ${delay} min late`, body: `Now due at ${info.stop} at ${info.due}.${leave}` };
          case "early":
            return { icon: "\u26A1", title: `${t} is ${-delay} min early!`, body: `Now due at ${info.stop} at ${info.due}. Don't miss it!` };
          case "recovered":
            return { icon: "\u2705", title: `${t} is back on time`, body: `Due at ${info.stop} at ${info.due || info.at}.` };
          case "gone":
            return { icon: "\u{1F62C}", title: `${t} has already left ${info.stop}`, body: `It left early.${alt}` };
          case "cancelled":
            return { icon: "\u274C", title: `${t} is cancelled`, body: `It was due from ${info.stop}.${alt}` };
          default:
            return null;
        }
      }
      const api = { alertMessage, compactProfile, restoreProfile, profileFromPoints, decideAlert, decodePolyline, buildProfile, schedAt, distAtTime, locateOnRoute, boardingIndex, matchVehicle, liveStatus, searchBox, unionBox };
      if (typeof module !== "undefined" && module.exports) module.exports = api;
      else root.HomeLive = api;
    })(typeof self !== "undefined" ? self : exports);
  }
});

// worker/src/index.js
var import_live = __toESM(require_live(), 1);

// worker/src/siri.js
var BODS = "https://data.bus-data.dft.gov.uk/api/v1/datafeed/";
var MAX_AGE_MIN = 30;
async function fetchVehicles(apiKey, line, box, { cacheTtl } = {}) {
  const [minLat, maxLat, minLon, maxLon] = box;
  const res = await fetch(`${BODS}?boundingBox=${minLon},${minLat},${maxLon},${maxLat}&api_key=${encodeURIComponent(apiKey)}`, {
    headers: { Accept: "text/xml, */*" },
    // BODS answers 406 to application/xml
    ...cacheTtl ? { cf: { cacheTtl } } : {}
  });
  if (!res.ok) {
    const e = new Error(`BODS replied ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const want = String(line).toLowerCase();
  const oldest = Date.now() - MAX_AGE_MIN * 6e4;
  return parseSiriVm(await res.text()).filter((v) => v.line.toLowerCase() === want && !(Date.parse(v.recordedAt) < oldest));
}
function parseSiriVm(xml) {
  const out = [];
  const blocks = xml.match(/<(?:\w+:)?VehicleActivity\b[^>]*>[\s\S]*?<\/(?:\w+:)?VehicleActivity>/g) || [];
  for (const b of blocks) {
    const lat = num(tag(b, "Latitude"));
    const lon = num(tag(b, "Longitude"));
    if (lat == null || lon == null || lat === 0 && lon === 0) continue;
    const line = tag(b, "PublishedLineName") || tag(b, "LineRef") || "";
    out.push({
      line,
      lineRef: tag(b, "LineRef"),
      direction: tag(b, "DirectionRef"),
      operator: tag(b, "OperatorRef"),
      origin: clean(tag(b, "OriginName")),
      destination: clean(tag(b, "DestinationName")),
      originAimedDeparture: tag(b, "OriginAimedDepartureTime"),
      lat,
      lon,
      bearing: num(tag(b, "Bearing")),
      recordedAt: tag(b, "RecordedAtTime"),
      vehicleRef: tag(b, "VehicleRef"),
      journeyRef: tag(b, "DatedVehicleJourneyRef") || tag(b, "VehicleJourneyRef")
    });
  }
  const latest = /* @__PURE__ */ new Map();
  for (const v of out) {
    const k = `${v.operator}|${v.vehicleRef}|${v.originAimedDeparture}`;
    const prev = latest.get(k);
    if (!prev || (v.recordedAt || "") > (prev.recordedAt || "")) latest.set(k, v);
  }
  return [...latest.values()];
}
function tag(s, name) {
  const m = s.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? decode(m[1].trim()) : null;
}
var num = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
var clean = (v) => v ? v.replace(/_/g, " ") : v;
var decode = (v) => v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// worker/src/webpush.js
var te = new TextEncoder();
var b64u = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str2) {
    const s = atob(str2.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str2.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
};
var concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function vapidAuth(endpoint, { publicKey, privateKey, subject }) {
  const header = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: subject };
  const payload = b64u.enc(te.encode(JSON.stringify(claims)));
  const pub = b64u.dec(publicKey);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)), d: privateKey, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64u.enc(sig)}, k=${publicKey}`;
}
async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64u.dec(subscription.keys.p256dh);
  const authSecret = b64u.dec(subscription.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const data = typeof plaintext === "string" ? te.encode(plaintext) : plaintext;
  const record = concat(data, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}
async function sendPush(subscription, message, vapid2, { ttl = 600, urgency = "high", topic } = {}) {
  const body = await encryptPayload(subscription, JSON.stringify(message));
  const headers = {
    Authorization: await vapidAuth(subscription.endpoint, vapid2),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: urgency
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const res = await fetch(subscription.endpoint, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// worker/src/index.js
var CACHE_SECONDS = 10;
var MAX_SPAN_DEG = 0.6;
var SUBS_KEY = "subs";
var MAX_SUBS = 10;
var MAX_LEGS = 6;
var MAX_BODY = 4e5;
var LOOKAHEAD_MIN = 90;
var PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const originOk = allowed.length === 0 || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk && origin ? origin : allowed[0] || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!originOk) return json({ error: "origin not allowed" }, 403, cors);
    try {
      if (request.method === "GET") {
        if (url.pathname === "/" || url.pathname === "/health") {
          return json({ ok: true, keyConfigured: !!env.BODS_API_KEY, pushConfigured: pushReady(env) }, 200, cors);
        }
        if (url.pathname === "/vehicles") return await vehiclesRoute(url, env, ctx, cors);
        if (url.pathname === "/push/key") {
          if (!pushReady(env)) return json({ error: "push alerts are not set up on this worker" }, 501, cors);
          return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors);
        }
      }
      if (request.method === "POST" && url.pathname.startsWith("/push/")) {
        if (!pushReady(env)) return json({ error: "push alerts are not set up on this worker" }, 501, cors);
        const text = await request.text();
        if (text.length > MAX_BODY) return json({ error: "too large" }, 413, cors);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return json({ error: "bad JSON" }, 400, cors);
        }
        if (url.pathname === "/push/subscribe") return await subscribeRoute(body, env, cors);
        if (url.pathname === "/push/unsubscribe") return await unsubscribeRoute(body, env, cors);
        if (url.pathname === "/push/test") return await testRoute(body, env, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.status ? `BODS replied ${e.status}` : "server error" }, e.status ? 502 : 500, cors);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlerts(env));
  }
};
var pushReady = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.SUBS);
var vapid = (env) => ({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:alerts@example.invalid" });
async function vehiclesRoute(url, env, ctx, cors) {
  if (!env.BODS_API_KEY) return json({ error: "BODS_API_KEY is not set on the worker" }, 500, cors);
  const line = (url.searchParams.get("line") || "").trim();
  if (!/^[A-Za-z0-9]{1,8}$/.test(line)) return json({ error: "line must be a route number like Y1" }, 400, cors);
  const bbox = parseBbox(url.searchParams.get("bbox"));
  if (!bbox) return json({ error: `bbox must be minLat,maxLat,minLon,maxLon inside Great Britain, at most ${MAX_SPAN_DEG}\xB0 across` }, 400, cors);
  const r = (v, dir) => (dir < 0 ? Math.floor(v * 50) : Math.ceil(v * 50)) / 50;
  const box = [r(bbox[0], -1), r(bbox[1], 1), r(bbox[2], -1), r(bbox[3], 1)];
  const cacheKey = new Request(`https://bods-cache.invalid/v?line=${line.toUpperCase()}&bbox=${box.join(",")}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, cors);
  let vehicles;
  try {
    vehicles = await fetchVehicles(env.BODS_API_KEY, line, box, { cacheTtl: CACHE_SECONDS });
  } catch (e) {
    return json({ error: e.status ? `BODS replied ${e.status}` : "could not reach BODS" }, 502, cors);
  }
  const res = json({ vehicles, fetchedAt: (/* @__PURE__ */ new Date()).toISOString() }, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return withHeaders(res, cors);
}
function parseBbox(s) {
  const n = (s || "").split(",").map(Number);
  if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return null;
  const [minLat, maxLat, minLon, maxLon] = n;
  if (minLat >= maxLat || minLon >= maxLon) return null;
  if (maxLat - minLat > MAX_SPAN_DEG || maxLon - minLon > MAX_SPAN_DEG) return null;
  if (minLat < 49 || maxLat > 61 || minLon < -9 || maxLon > 2.5) return null;
  return n;
}
async function loadSubs(env) {
  return await env.SUBS.get(SUBS_KEY, "json") || {};
}
async function saveSubs(env, subs) {
  await env.SUBS.put(SUBS_KEY, JSON.stringify(subs));
}
function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string") return false;
  let u;
  try {
    u = new URL(s.endpoint);
  } catch {
    return false;
  }
  return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}
var str = (v, max) => typeof v === "string" && v.length <= max;
function cleanLeg(l) {
  const p = l && l.profile;
  if (!str(l.key, 300) || !/^[A-Za-z0-9]{1,8}$/.test(l.line || "") || !str(l.name, 60) || !str(l.stop, 120) || !str(l.at, 5)) return null;
  if (!p || !Array.isArray(p.pts) || p.pts.length < 2 || p.pts.length > 3e3 || !Array.isArray(p.stops) || !p.stops.length || p.stops.length > 300) return null;
  if (!p.pts.every((q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) return null;
  if (!p.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.sched) && str(s.name || "", 120))) return null;
  if (!Number.isFinite(p.startSched) || !Number.isFinite(p.boardSched)) return null;
  return {
    key: l.key,
    line: l.line,
    name: l.name,
    stop: l.stop,
    at: l.at,
    profile: {
      pts: p.pts,
      startSched: p.startSched,
      boardSched: p.boardSched,
      boardStopId: str(p.boardStopId, 120) ? p.boardStopId : null,
      stops: p.stops.map((s) => ({ name: s.name || "", stopId: str(s.stopId, 120) ? s.stopId : null, lat: s.lat, lon: s.lon, sched: s.sched }))
    }
  };
}
async function subscribeRoute(body, env, cors) {
  if (!validSubscription(body.subscription)) return json({ error: "not a supported push subscription" }, 400, cors);
  const legs = (Array.isArray(body.legs) ? body.legs : []).slice(0, MAX_LEGS).map(cleanLeg).filter(Boolean);
  const min = [1, 2, 3, 5, 10].includes(body.min) ? body.min : 2;
  const subs = await loadSubs(env);
  const { endpoint, keys } = body.subscription;
  const prev = subs[endpoint];
  if (!prev && Object.keys(subs).length >= MAX_SUBS) {
    const oldest = Object.values(subs).sort((a, b) => a.updatedAt - b.updatedAt)[0];
    delete subs[oldest.endpoint];
  }
  const keep = new Set(legs.map((l) => l.key));
  const mem = Object.fromEntries(Object.entries(prev?.mem || {}).filter(([k]) => keep.has(k)));
  subs[endpoint] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, min, legs, mem, updatedAt: Date.now() };
  await saveSubs(env, subs);
  return json({ ok: true, watching: legs.length }, 200, cors);
}
async function unsubscribeRoute(body, env, cors) {
  const subs = await loadSubs(env);
  if (body && subs[body.endpoint]) {
    delete subs[body.endpoint];
    await saveSubs(env, subs);
  }
  return json({ ok: true }, 200, cors);
}
async function testRoute(body, env, cors) {
  const subs = await loadSubs(env);
  const sub = body && subs[body.endpoint];
  if (!sub) return json({ error: "subscribe first" }, 404, cors);
  const r = await sendPush(sub, { title: "\u{1F389} Home Time alerts are working", body: "You'll get delay alerts here, even with the app closed.", tag: "test" }, vapid(env), { ttl: 120 });
  if (r.gone) {
    delete subs[sub.endpoint];
    await saveSubs(env, subs);
  }
  return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, cors);
}
var fmt = (t) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(t));
async function runAlerts(env, now = Date.now()) {
  const summary = { subs: 0, tracked: 0, requests: 0, pushed: 0, removed: 0, saved: false };
  if (!pushReady(env) || !env.BODS_API_KEY) return summary;
  const subs = await loadSubs(env);
  let changed = false;
  const jobs = [];
  for (const sub of Object.values(subs)) {
    summary.subs++;
    const before = sub.legs.length;
    sub.legs = sub.legs.filter((l) => l.profile.boardSched > now - 10 * 6e4);
    if (sub.legs.length !== before) {
      changed = true;
      const keep = new Set(sub.legs.map((l) => l.key));
      for (const k of Object.keys(sub.mem)) if (!keep.has(k)) delete sub.mem[k];
    }
    for (const leg of sub.legs) {
      if (leg.profile.boardSched > now + LOOKAHEAD_MIN * 6e4 || leg.profile.boardSched < now - 2 * 6e4) continue;
      const { profile, boardIdx } = import_live.default.restoreProfile(leg.profile);
      jobs.push({ sub, leg, profile, boardIdx, box: import_live.default.searchBox(profile, boardIdx) });
    }
  }
  summary.tracked = jobs.length;
  const groups = /* @__PURE__ */ new Map();
  for (const j of jobs) {
    const k = j.leg.line.toUpperCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const requests = [];
  for (const [line, js] of groups) {
    const u = import_live.default.unionBox(js.map((j) => j.box));
    if (u[1] - u[0] <= MAX_SPAN_DEG && u[3] - u[2] <= MAX_SPAN_DEG) requests.push({ line, box: u, js });
    else for (const j of js) requests.push({ line, box: j.box, js: [j] });
  }
  const pushes = [];
  for (const r of requests) {
    summary.requests++;
    let vehicles;
    try {
      vehicles = await fetchVehicles(env.BODS_API_KEY, r.line, r.box);
    } catch {
      continue;
    }
    for (const j of r.js) {
      const v = import_live.default.matchVehicle(vehicles, { routeShortName: j.leg.line }, j.profile);
      if (!v) continue;
      const st = import_live.default.liveStatus(j.profile, j.boardIdx, v, now);
      let cur = null;
      if (st.state === "gone") cur = now < j.leg.profile.boardSched - 6e4 ? { state: "gone" } : null;
      else if (st.state === "coming") cur = { state: "live", delay: st.delayMin, eta: st.eta };
      if (!cur) continue;
      const prev = j.sub.mem[j.leg.key] || null;
      const { alert, memory } = import_live.default.decideAlert(prev, cur, j.sub.min);
      if (memory !== prev) {
        j.sub.mem[j.leg.key] = memory;
        changed = true;
      }
      if (!alert) continue;
      const m = import_live.default.alertMessage(alert, cur.delay, { name: j.leg.name, at: j.leg.at, stop: j.leg.stop, due: cur.eta ? fmt(cur.eta) : "" });
      pushes.push({ sub: j.sub, message: { title: `${m.icon} ${m.title}`, body: m.body, tag: j.leg.key, type: alert } });
    }
  }
  for (const p of pushes) {
    if (!subs[p.sub.endpoint]) continue;
    try {
      const r = await sendPush(p.sub, p.message, vapid(env), { ttl: 600, topic: p.message.tag });
      if (r.ok) summary.pushed++;
      if (r.gone) {
        delete subs[p.sub.endpoint];
        summary.removed++;
        changed = true;
      }
    } catch {
    }
  }
  if (changed) {
    await saveSubs(env, subs);
    summary.saved = true;
  }
  return summary;
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
export {
  index_default as default,
  runAlerts
};
