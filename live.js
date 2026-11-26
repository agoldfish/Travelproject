/* Home Time — live bus tracking maths (no DOM, so it can be unit-tested in Node).
 *
 * Given a bus trip's route shape and timetable (from Transitous /trip) and a GPS report
 * from BODS, work out how late the bus is, how many stops away it is and when it
 * should reach your stop.
 */
(function (root) {
  'use strict';

  const M_PER_DEG_LAT = 110540;
  const ON_ROUTE_M = 120;     // a bus this close to the route line counts as on it
  const STOP_SNAP_M = 40;     // a stop this close to the route snaps to its first pass
  const MATCH_WINDOW_S = 150; // origin departure times must agree within this

  function decodePolyline(str, precision = 6) {
    const f = 10 ** precision, out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (let which = 0; which < 2; which++) {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lon += d;
      }
      out.push([lat / f, lon / f]);
    }
    return out;
  }

  /* Flat-earth projection around the route; plenty accurate over a city. */
  function projector(lat0) {
    const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
    return (lat, lon) => [lon * kx, lat * M_PER_DEG_LAT];
  }

  /** Nearest point on segment AB to P, in projected metres. */
  function onSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    const x = a[0] + t * dx, y = a[1] + t * dy;
    return { t, off: Math.hypot(p[0] - x, p[1] - y) };
  }

  const ms = (s) => (s ? Date.parse(s) : NaN);

  /**
   * Build a route profile from the first leg of a Transitous /trip response.
   * Stops get a distance along the route and a scheduled time.
   */
  function buildProfile(tripLeg) {
    const g = tripLeg.legGeometry;
    const pts = decodePolyline(g.points, g.precision ?? 6);
    const proj = projector(pts[0][0]);
    const xy = pts.map(([la, lo]) => proj(la, lo));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));

    const raw = [tripLeg.from, ...(tripLeg.intermediateStops || []), tripLeg.to];
    const stops = [];
    let seg = 0;
    for (const s of raw) {
      const p = proj(s.lat, s.lon);
      // Walk forward from the previous stop: take the first close pass (handles loop routes),
      // otherwise the nearest point on the rest of the route.
      let best = null;
      for (let i = seg; i < xy.length - 1; i++) {
        const r = onSegment(p, xy[i], xy[i + 1]);
        if (!best || r.off < best.off) best = { ...r, i };
        if (r.off <= STOP_SNAP_M) {
          // First close pass found: slide on to the closest point of this pass, then stop.
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
        sched: ms(s.scheduledDeparture) || ms(s.scheduledArrival) || ms(s.departure) || ms(s.arrival),
        dist: stops.length ? Math.max(dist, stops[stops.length - 1].dist) : dist,
      });
    }
    return { pts, xy, cum, proj, stops, length: cum[cum.length - 1] };
  }

  /** Timetabled time at a distance along the route (interpolated between stops). */
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

  /** Distance along the route where the timetable says the bus should be at time t. */
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

  /**
   * Where along the route is the bus? Routes can pass the same street twice, so among
   * the places it could be, pick the one closest to where the timetable expects it.
   */
  function locateOnRoute(profile, lat, lon, atTime) {
    const p = profile.proj(lat, lon);
    const expected = distAtTime(profile, atTime);
    // Split the route into "passes" (runs of segments near the bus) and take the closest
    // point of each pass; only then use the timetable to choose between passes.
    const passes = [];
    let cur = null, nearest = null;
    for (let i = 0; i < profile.xy.length - 1; i++) {
      const r = onSegment(p, profile.xy[i], profile.xy[i + 1]);
      const d = profile.cum[i] + r.t * (profile.cum[i + 1] - profile.cum[i]);
      if (!nearest || r.off < nearest.off) nearest = { d, off: r.off };
      if (r.off <= ON_ROUTE_M) {
        if (!cur) passes.push((cur = { d, off: r.off }));
        else if (r.off < cur.off) { cur.d = d; cur.off = r.off; }
      } else cur = null;
    }
    let best = null;
    for (const c of passes) if (!best || Math.abs(c.d - expected) < Math.abs(best.d - expected)) best = c;
    return best || (nearest && nearest.off <= ON_ROUTE_M * 3 ? nearest : null);
  }

  /** Index of the stop where you get on. */
  function boardingIndex(profile, leg) {
    const st = profile.stops;
    const want = ms(leg.from.scheduledDeparture) || ms(leg.startTime);
    let byId = st.findIndex((s) => s.stopId && s.stopId === leg.from.stopId && Math.abs(s.sched - want) < 120e3);
    if (byId < 0) byId = st.findIndex((s) => s.stopId && s.stopId === leg.from.stopId);
    if (byId >= 0) return byId;
    let bi = 0;
    st.forEach((s, i) => { if (Math.abs(s.sched - want) < Math.abs(st[bi].sched - want)) bi = i; });
    return bi;
  }

  /** Pick the BODS vehicle running this exact journey (same route + same start time). */
  function matchVehicle(vehicles, leg, profile) {
    const line = String(leg.routeShortName || '').toLowerCase();
    const start = profile.stops[0].sched;
    let best = null;
    for (const v of vehicles || []) {
      if (String(v.line || '').toLowerCase() !== line && String(v.lineRef || '').toLowerCase() !== line) continue;
      const diff = Math.abs(ms(v.originAimedDeparture) - start) / 1000;
      if (!(diff <= MATCH_WINDOW_S)) continue;
      if (!best || diff < best.diff || (diff === best.diff && (v.recordedAt || '') > (best.v.recordedAt || ''))) best = { v, diff };
    }
    return best ? best.v : null;
  }

  /**
   * Live status of the bus for your stop.
   * state: 'coming' | 'gone' | 'unknown'
   */
  function liveStatus(profile, boardIdx, v, now = Date.now()) {
    const seen = ms(v.recordedAt) || now;
    const base = { lat: v.lat, lon: v.lon, bearing: v.bearing, ageSec: Math.max(0, Math.round((now - seen) / 1000)), vehicleRef: v.vehicleRef };
    const where = locateOnRoute(profile, v.lat, v.lon, seen);
    const board = profile.stops[boardIdx];
    if (!where) return { ...base, state: 'unknown' };

    if (where.d > board.dist + 40) return { ...base, state: 'gone', along: where.d };

    let delaySec = (seen - schedAt(profile, where.d)) / 1000;
    // Still waiting at the first stop before its start time: it isn't late, it's early.
    if (where.d <= profile.stops[0].dist + 30 && seen < profile.stops[0].sched) delaySec = 0;
    // If the report is old the bus has kept moving; we can't see that, so only count delay we know.
    const etaMs = Math.max(now, board.sched + Math.max(delaySec, -120) * 1000);
    const stopsAway = profile.stops.slice(0, boardIdx + 1).filter((s) => s.dist > where.d + 15).length;
    return {
      ...base,
      state: 'coming',
      along: where.d,
      delayMin: Math.round(delaySec / 60),
      stopsAway,
      metresAway: Math.max(0, Math.round(board.dist - where.d)),
      eta: etaMs,
    };
  }

  /** Box the bus must be in if it hasn't reached your stop yet: [minLat, maxLat, minLon, maxLon]. */
  function searchBox(profile, boardIdx, maxSpan = 0.5, pad = 0.01) {
    const board = profile.stops[boardIdx];
    const pts = profile.pts.filter((_, i) => profile.cum[i] <= board.dist + 100 && profile.cum[i] >= board.dist - 30000);
    if (!pts.length) pts.push([board.lat, board.lon]);
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const [la, lo] of pts) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo); }
    const clamp = (lo, hi, c) => (hi - lo > maxSpan - 2 * pad ? [c - (maxSpan / 2 - pad), c + (maxSpan / 2 - pad)] : [lo, hi]);
    [minLat, maxLat] = clamp(minLat, maxLat, board.lat);
    [minLon, maxLon] = clamp(minLon, maxLon, board.lon);
    return [minLat - pad, maxLat + pad, minLon - pad, maxLon + pad];
  }

  /** Union of several boxes (same order). */
  function unionBox(boxes) {
    return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])]);
  }

  const api = { decodePolyline, buildProfile, schedAt, distAtTime, locateOnRoute, boardingIndex, matchVehicle, liveStatus, searchBox, unionBox };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HomeLive = api;
})(typeof self !== 'undefined' ? self : this);
