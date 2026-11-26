/* Home Time — live bus & train journeys from wherever you are to home.
   Home is set inside the app and saved only on this device (never in the code). */
(() => {
  'use strict';

  const API = 'https://api.transitous.org/api/v1';
  const BRISTOL = { lat: 51.4545, lon: -2.5879 }; // search bias before home is set
  const REFRESH_MS = 60_000;
  const LIVE_MS = 20_000;
  // Your Cloudflare Worker address (see worker/README.md), e.g. 'https://hometime-bods.you.workers.dev'.
  // Leave empty to turn live bus tracking off. Opening the app once with ?proxy=URL also works.
  const BODS_PROXY = '';
  const PROXY_KEY = 'hometime.proxy';
  const STORE_KEY = 'hometime.from';
  const HOME_KEY = 'hometime.home';

  const RAIL = new Set(['RAIL', 'REGIONAL_RAIL', 'REGIONAL_FAST_RAIL', 'LONG_DISTANCE', 'HIGHSPEED_RAIL', 'NIGHT_RAIL', 'SUBURBAN', 'METRO', 'SUBWAY']);
  const MODE = {
    WALK: { e: '🚶', c: 'var(--walk)', label: 'Walk' },
    BIKE: { e: '🚲', c: '#2f9e44', label: 'Cycle' },
    BUS: { e: '🚌', c: 'var(--bus)', label: 'Bus' },
    COACH: { e: '🚍', c: '#7048e8', label: 'Coach' },
    TRAM: { e: '🚊', c: '#1c7ed6', label: 'Tram' },
    FERRY: { e: '⛴️', c: '#1098ad', label: 'Ferry' },
    RAIL: { e: '🚆', c: 'var(--train)', label: 'Train' },
  };
  const modeInfo = (m) => MODE[m] || (RAIL.has(m) ? MODE.RAIL : MODE.BUS);
  const isRail = (m) => RAIL.has(m);
  const isTransit = (m) => m !== 'WALK' && m !== 'BIKE' && m !== 'CAR';

  const $ = (id) => document.getElementById(id);
  const state = {
    from: null,          // {lat, lon, name, source}
    all: [],             // merged itineraries
    filter: 'all',
    selected: 0,
    editing: 'from',   // which place the search box is setting
    lastFetch: 0,
    loading: false,
    live: new Map(),     // "tripId|stopId" → live bus status
  };
  let proxyUrl = BODS_PROXY;
  try { proxyUrl = localStorage.getItem(PROXY_KEY) || BODS_PROXY; } catch { /* ignore */ }

  /* ---------------- helpers ---------------- */
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } },
  };
  function loadHome() {
    try { const h = JSON.parse(localStorage.getItem(HOME_KEY)); return h && isFinite(h.lat) && isFinite(h.lon) ? h : null; } catch { return null; }
  }
  function saveHome(h) {
    HOME = h;
    try { localStorage.setItem(HOME_KEY, JSON.stringify(h)); } catch { /* ignore */ }
    $('homeName').textContent = `🏡 ${h.name}`; $('changeHome').textContent = 'change';
    state.all = []; state.lastFetch = 0;
    if (state.from) refresh(true); else startFromGps();
  }
  let HOME = loadHome();
  const atHome = () => !!(HOME && state.from && distM(state.from, HOME) < 250);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const minsUntil = (d) => (d - Date.now()) / 60000;
  const fmtDur = (sec) => {
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}`;
  };
  const distM = (a, b) => {
    const R = 6371e3, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const textOn = (hex) => {
    const n = parseInt(hex, 16);
    const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.62 ? '#23233f' : '#fff';
  };
  const legColor = (leg) => (leg.routeColor && /^[0-9a-f]{6}$/i.test(leg.routeColor) ? `#${leg.routeColor}` : modeInfo(leg.mode).c);
  const legText = (leg) => (leg.routeColor && /^[0-9a-f]{6}$/i.test(leg.routeColor) ? (leg.routeTextColor ? `#${leg.routeTextColor}` : textOn(leg.routeColor)) : '#fff');
  const legName = (leg) => {
    if (isRail(leg.mode)) return leg.routeShortName && leg.routeShortName.length <= 4 ? leg.routeShortName : (leg.agencyName || 'Train');
    return leg.routeShortName || leg.displayName || modeInfo(leg.mode).label;
  };

  const decodePolyline = HomeLive.decodePolyline;

  async function getJSON(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* ---------------- location ---------------- */
  function locate() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('No GPS on this device'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, name: 'your location', source: 'gps' }),
        (e) => reject(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get your location')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  async function nameFor(p) {
    try {
      const d = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&lat=${p.lat}&lon=${p.lon}`);
      const a = d.address || {};
      const parts = [a.road || a.pedestrian || a.amenity, a.suburb || a.village || a.town || a.city].filter(Boolean);
      return parts.length ? `near ${parts.join(', ')}` : 'your location';
    } catch { return 'your location'; }
  }

  async function startFromGps() {
    setHero('Finding you…', '📍', 'Allow location for live trips');
    try {
      const p = await locate();
      setFrom(p);
      nameFor(p).then((n) => { if (state.from === p) { p.name = n; $('fromName').textContent = n; } });
    } catch (e) {
      const saved = store.get();
      if (saved) { setFrom(saved); status(`${e.message} — using ${saved.name}`); }
      else if (!HOME) { promptForHome(); status(e.message + '. Search for home below.', true); }
      else { openFromForm('from'); setHero('Where are you?', '🤔', 'Type a place below'); status(e.message + '. Type where you are instead.', true); }
    }
  }

  function setFrom(p) {
    state.from = p;
    $('fromName').textContent = p.name;
    if (p.source === 'manual') store.set(p);
    refresh(true);
  }

  /* ---------------- search box ---------------- */
  function openFromForm(mode = 'from') {
    state.editing = mode;
    $('fromForm').hidden = false;
    $('fromInput').placeholder = mode === 'home' ? 'Home address or postcode' : 'Type a place, stop or postcode';
    $('useGps').textContent = mode === 'home' ? "📍 I'm at home now" : '📍 Use GPS';
    $('fromInput').focus();
  }
  let suggestTimer, suggestCtl;
  function onSuggestInput() {
    clearTimeout(suggestTimer);
    const q = $('fromInput').value.trim();
    if (q.length < 3) { $('suggestions').innerHTML = ''; return; }
    suggestTimer = setTimeout(async () => {
      suggestCtl?.abort(); suggestCtl = new AbortController();
      try {
        const list = await getJSON(`${API}/geocode?text=${encodeURIComponent(q)}&place=${(HOME || state.from || BRISTOL).lat},${(HOME || state.from || BRISTOL).lon}&placeBias=4`, suggestCtl.signal);
        const gb = list.filter((x) => x.country === 'GB' || !x.country).slice(0, 6);
        $('suggestions').innerHTML = gb.map((x, i) => {
          const area = (x.areas || []).filter((a) => a.adminLevel >= 6 && a.adminLevel <= 10).map((a) => a.name).slice(0, 2).join(', ');
          const icon = x.type === 'STOP' ? (x.modes || []).some(isRail) ? '🚉' : '🚏' : '📍';
          return `<li data-i="${i}">${icon} ${esc(x.name)}<small>${esc(area)}</small></li>`;
        }).join('');
        $('suggestions').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
          const x = gb[+li.dataset.i];
          pickPlace({ lat: x.lat, lon: x.lon, name: x.name, source: 'manual' });
        }));
      } catch (e) { if (e.name !== 'AbortError') $('suggestions').innerHTML = ''; }
    }, 280);
  }
  function pickPlace(p) {
    $('suggestions').innerHTML = '';
    $('fromInput').value = '';
    $('fromForm').hidden = true;
    if (state.editing === 'home') saveHome({ lat: p.lat, lon: p.lon, name: p.name });
    else setFrom(p);
  }

  /* ---------------- fetching ---------------- */
  let fetchCtl;
  async function refresh(force = false) {
    if (!state.from) return;
    if (!HOME) { promptForHome(); return; }
    if (!force && Date.now() - state.lastFetch < 20_000) return;
    fetchCtl?.abort(); fetchCtl = new AbortController();
    const signal = fetchCtl.signal;
    state.loading = true; $('refreshBtn').classList.add('spin');

    if (atHome()) {
      state.loading = false; $('refreshBtn').classList.remove('spin');
      state.all = []; render(); return;
    }
    if (!state.all.length) $('journeys').innerHTML = '<li class="skeleton"></li><li class="skeleton"></li>';

    const base = `${API}/plan?fromPlace=${state.from.lat},${state.from.lon}&toPlace=${HOME.lat},${HOME.lon}&numItineraries=6&maxPreTransitTime=1500&maxPostTransitTime=1500`;
    try {
      const [any, bus] = await Promise.allSettled([
        getJSON(base, signal),
        getJSON(`${base}&transitModes=BUS,COACH`, signal),
      ]);
      if (signal.aborted) return;
      if (any.status === 'rejected' && bus.status === 'rejected') throw any.reason;
      const its = [];
      const direct = [];
      for (const r of [any, bus]) {
        if (r.status !== 'fulfilled') continue;
        its.push(...(r.value.itineraries || []));
        direct.push(...(r.value.direct || []));
      }
      state.all = dedupe(its);
      state.direct = direct[0] || null;
      state.lastFetch = Date.now();
      status('');
      $('updated').textContent = `Updated ${fmtTime(new Date())}`;
      render();
    } catch (e) {
      if (e.name === 'AbortError') return;
      status(navigator.onLine ? `Couldn't reach the journey planner (${e.message}). Retrying soon…` : 'You are offline 📴', true);
      if (!state.all.length) $('journeys').innerHTML = '';
    } finally {
      if (!signal.aborted) { state.loading = false; $('refreshBtn').classList.remove('spin'); }
    }
  }

  function dedupe(its) {
    const seen = new Map();
    for (const it of its) {
      const key = it.legs.filter((l) => isTransit(l.mode)).map((l) => `${l.tripId}|${l.from.stopId}`).join('>') || `walk${it.startTime}`;
      if (!seen.has(key)) seen.set(key, it);
    }
    const list = [...seen.values()];
    // drop journeys that leave earlier AND arrive later than another (strictly worse)
    const keep = list.filter((a) => !list.some((b) => b !== a && new Date(b.startTime) >= new Date(a.startTime) && new Date(b.endTime) < new Date(a.endTime) && sameKind(a, b)));
    return keep.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }
  const hasRail = (it) => it.legs.some((l) => isRail(l.mode));
  const sameKind = (a, b) => hasRail(a) === hasRail(b);

  function visible() {
    const now = Date.now() - 60_000;
    return state.all
      .filter((it) => new Date(it.endTime) > now)
      .filter((it) => state.filter === 'all' ? true : state.filter === 'train' ? hasRail(it) : !hasRail(it))
      .slice(0, 6);
  }

  /* ---------------- rendering ---------------- */
  function status(msg, err = false) {
    const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!err);
  }

  function setHero(label, big, sub, frac = 0, urgent = false) {
    $('heroLabel').textContent = label;
    $('heroBig').innerHTML = big;
    $('heroSub').textContent = sub || ' ';
    $('ringFg').style.strokeDashoffset = String(326.7 * (1 - Math.max(0, Math.min(1, frac))));
    $('hero').classList.toggle('urgent', urgent);
  }

  function delayInfo(place, kind) {
    const act = place[kind], sch = place['scheduled' + kind[0].toUpperCase() + kind.slice(1)];
    if (!act || !sch) return null;
    return Math.round((new Date(act) - new Date(sch)) / 60000);
  }

  function render() {
    const list = visible();
    const ol = $('journeys');

    if (atHome()) {
      setHero("You're", '🏡', 'home already! Kettle on? ☕', 1);
      $('homeBy').innerHTML = '';
      ol.innerHTML = '<li class="empty"><div class="big">🎉</div><b>Welcome home!</b></li>';
      drawMap(null); return;
    }

    if (!list.length) {
      ol.innerHTML = state.all.length || state.lastFetch
        ? `<li class="empty"><div class="big">🦗</div><b>No ${state.filter === 'train' ? 'train ' : state.filter === 'bus' ? 'bus ' : ''}journeys found right now.</b><br>${state.filter !== 'all' ? 'Try the ✨ Best tab.' : 'Services may have finished for the night — try a taxi 🚕'}</li>`
        : '';
      if (state.lastFetch) setHero('No trips', '😴', 'Nothing running soon');
      $('homeBy').innerHTML = '';
      drawMap(null); return;
    }

    if (state.selected >= list.length) state.selected = 0;
    ol.innerHTML = list.map(cardHTML).join('');
    ol.querySelectorAll('.card').forEach((el, i) => {
      el.style.animationDelay = `${i * 60}ms`;
      el.addEventListener('click', () => { state.selected = i; markSelected(); drawMap(list[i]); });
    });
    markSelected();
    drawMap(list[state.selected]);
    updateLiveUI();
    tick();
    trackLive();
  }

  function markSelected() {
    document.querySelectorAll('.card').forEach((el, i) => el.classList.toggle('selected', i === state.selected));
  }

  function cardHTML(it) {
    const start = new Date(it.startTime), end = new Date(it.endTime);
    const total = (end - start) / 1000;
    const live = it.legs.some((l) => l.realTime);
    const cancelled = it.legs.some((l) => l.cancelled);

    const ribbon = it.legs.map((l) => {
      const w = Math.max(4, (l.duration / total) * 100);
      const m = modeInfo(l.mode);
      if (!isTransit(l.mode)) return `<div class="seg walk" style="flex:${w}" title="${m.label} ${fmtDur(l.duration)}"><span class="e">${m.e}</span></div>`;
      return `<div class="seg" style="flex:${w};background:${legColor(l)};color:${legText(l)}" title="${esc(legName(l))}"><span class="e">${m.e}</span>${w > 14 ? esc(legName(l)) : ''}</div>`;
    }).join('');

    const legs = it.legs.filter((l) => isTransit(l.mode) || l.duration > 180).map((l) => {
      const m = modeInfo(l.mode);
      const dep = new Date(l.startTime);
      if (!isTransit(l.mode)) {
        const dist = l.distance ? ` · ${(l.distance / 1000).toFixed(1)} km` : '';
        return `<li class="leg"><span class="badge walk">${m.e}</span><span class="what">Walk ${fmtDur(l.duration)}${dist}<small>to ${esc(l.to.name === 'END' ? 'home' : l.to.name)}</small></span><span class="when">${fmtTime(dep)}</span></li>`;
      }
      const d = delayInfo(l.from, 'departure');
      let tag;
      if (l.cancelled) tag = '<small class="late cancel-tag">Cancelled</small>';
      else if (l.realTime && d != null) tag = d > 0 ? `<small class="late">+${d} min late</small>` : d < 0 ? `<small class="ontime">${-d} min early</small>` : '<small class="ontime">On time</small>';
      else tag = '<small style="color:var(--muted)">timetable</small>';
      const track = l.from.track ? ` · plat ${esc(l.from.track)}` : '';
      const liveLine = proxyUrl && isBusLeg(l) ? `<span class="live-line" data-key="${esc(liveKey(l))}"><span class="sat">🛰️</span> looking for this bus…</span>` : '';
      return `<li class="leg">
        <span class="badge" style="background:${legColor(l)};color:${legText(l)}">${m.e} ${esc(legName(l))}</span>
        <span class="what"><b>${esc(l.from.name)}</b>${track}<small>→ ${esc(l.headsign || l.to.name)} · get off ${esc(l.to.name)}</small>${liveLine}</span>
        <span class="when ${l.cancelled ? 'cancel' : ''}">${fmtTime(dep)}${tag}</span>
      </li>`;
    }).join('');

    const fb = firstBus(it);
    return `<li class="card" data-start="${start.getTime()}" data-end="${end.getTime()}" data-bus="${fb ? esc(liveKey(fb)) : ''}">
      <div class="card-top">
        <div class="leave"><span class="js-leave">${leaveText(start)}</span><small>Leave ${fmtTime(start)} · ${fmtDur(total)} · ${it.transfers} change${it.transfers === 1 ? '' : 's'}</small></div>
        <div class="arrive"><small>Home by</small><span class="t">${fmtTime(end)}</span>
          <small><span class="chip js-chip"><span class="dot ${live ? 'live' : 'sched'}"></span>${cancelled ? 'disrupted' : live ? 'live' : 'timetable'}</span></small></div>
      </div>
      <div class="ribbon">${ribbon}<div class="progress-dot" hidden></div></div>
      <ul class="legs">${legs}</ul>
    </li>`;
  }

  function leaveText(start) {
    const m = minsUntil(start);
    if (m < -0.5) return 'On the way 🏃';
    if (m < 1) return 'Leave now! 🏃';
    if (m < 60) return `Leave in ${Math.floor(m)} min`;
    return `Leave at ${fmtTime(start)}`;
  }

  /* Per-second updates: countdowns, hero ring, progress dot */
  function tick() {
    const list = visible();
    document.querySelectorAll('.card').forEach((el) => {
      const s = +el.dataset.start + liveShift(el.dataset.bus), e = +el.dataset.end + liveShift(el.dataset.bus);
      el.querySelector('.js-leave').textContent = state.live.get(el.dataset.bus)?.state === 'gone' && Date.now() < s ? 'Bus has gone 😬' : leaveText(new Date(s));
      const dot = el.querySelector('.progress-dot');
      const now = Date.now();
      if (now > s && now < e) { dot.hidden = false; dot.style.left = `calc(${((now - s) / (e - s)) * 100}% - 2px)`; }
      else dot.hidden = true;
    });

    if (!list.length || !state.from || !HOME || atHome()) return;
    const shiftOf = (it) => { const b = firstBus(it); return b ? liveShift(liveKey(b)) : 0; };
    const gone = (it) => { const b = firstBus(it); return b && state.live.get(liveKey(b))?.state === 'gone'; };
    const next = list.find((it) => !gone(it) && minsUntil(new Date(+new Date(it.startTime) + shiftOf(it))) > -0.5) || list[0];
    const sh = shiftOf(next);
    const start = new Date(+new Date(next.startTime) + sh), end = new Date(+new Date(next.endTime) + sh);
    const m = minsUntil(start);
    const firstT = next.legs.find((l) => isTransit(l.mode));
    const em = firstT ? modeInfo(firstT.mode).e : '🚶';
    const ls = firstT && isBusLeg(firstT) ? state.live.get(liveKey(firstT)) : null;
    const liveTxt = ls?.state === 'coming' ? (ls.delayMin > 0 ? ` · running ${ls.delayMin} min late` : ' · on time') : '';
    const catchTxt = firstT ? `for the ${legName(firstT)} ${modeInfo(firstT.mode).label.toLowerCase()}${liveTxt}` : 'walk home';
    $('driver').textContent = em;

    if (m <= 0.5) {
      setHero('Go go go!', em, `${catchTxt} from ${firstT ? firstT.from.name : 'here'}`, 1, true);
    } else if (m < 60) {
      const mm = Math.floor(m), ss = Math.floor((m - mm) * 60);
      const big = m < 10 ? `${mm}:${String(ss).padStart(2, '0')}` : `${mm}<small>min</small>`;
      setHero('Leave in', big, catchTxt, 1 - m / 30, m < 3);
    } else {
      setHero('Next trip', fmtTime(start), catchTxt, 0);
    }
    $('homeBy').innerHTML = `<span>🏡 Home by ${fmtTime(end)}</span>`;
  }

  /* ---------------- sky ---------------- */
  function paintSky() {
    const h = +new Date().toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' });
    const sky = $('sky');
    sky.classList.remove('night', 'dawn', 'day', 'dusk');
    sky.classList.add(h < 6 || h >= 20 ? 'night' : h < 9 ? 'dawn' : h < 17 ? 'day' : 'dusk');
  }

  /* ---------------- map ---------------- */
  let map, layer;
  function drawMap(it, keepView = false) {
    if (!window.L) return;
    if (!map) {
      map = L.map('map', { zoomControl: false, attributionControl: false }).setView([BRISTOL.lat, BRISTOL.lon], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    const pin = (e) => L.divIcon({ html: `<div class="pin">${e}</div>`, className: '', iconSize: [30, 30], iconAnchor: [15, 28] });
    const pts = [];
    if (HOME) { L.marker([HOME.lat, HOME.lon], { icon: pin('🏡') }).addTo(layer); pts.push([HOME.lat, HOME.lon]); }
    if (state.from) { L.marker([state.from.lat, state.from.lon], { icon: pin('📍') }).addTo(layer); pts.push([state.from.lat, state.from.lon]); }
    if (it) {
      for (const l of it.legs) {
        if (!l.legGeometry?.points) continue;
        const line = decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 6);
        const transit = isTransit(l.mode);
        L.polyline(line, { color: '#fff', weight: transit ? 9 : 6, opacity: 0.9 }).addTo(layer);
        L.polyline(line, { color: transit ? legColor(l).replace('var(--bus)', '#e4007c').replace('var(--train)', '#0a493e') : '#7a7f99', weight: transit ? 5 : 3, dashArray: transit ? null : '4 7' }).addTo(layer);
        if (transit) {
          L.marker([l.from.lat, l.from.lon], { icon: pin(modeInfo(l.mode).e) }).bindTooltip(`${legName(l)} from ${l.from.name} · ${fmtTime(new Date(l.startTime))}`).addTo(layer);
        }
        pts.push(...line);
        const ls = isBusLeg(l) ? state.live.get(liveKey(l)) : null;
        if (ls && ls.state === 'coming') {
          const icon = L.divIcon({ html: `<div class="live-bus">🚌<span>${esc(legName(l))}</span></div>`, className: '', iconSize: [44, 44], iconAnchor: [22, 22] });
          L.marker([ls.lat, ls.lon], { icon, zIndexOffset: 1000 }).bindTooltip(liveText(ls, true)).addTo(layer);
          pts.push([ls.lat, ls.lon]);
        }
      }
    }
    if (pts.length && !keepView) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 15 });
  }

  /* ---------------- live bus tracking (BODS via your worker) ---------------- */
  const isBusLeg = (l) => (l.mode === 'BUS' || l.mode === 'COACH') && !!l.tripId && !!l.routeShortName;
  const liveKey = (l) => `${l.tripId}|${l.from.stopId}`;
  const firstBus = (it) => { const t = it.legs.find((l) => isTransit(l.mode)); return t && isBusLeg(t) ? t : null; };
  /** How much later than planned you can leave because your first bus is running late. */
  function liveShift(key) {
    const ls = key && state.live.get(key);
    return ls && ls.state === 'coming' && ls.shift > 0 ? ls.shift : 0;
  }

  const profiles = new Map(); // tripId → Promise<profile>
  function getProfile(tripId) {
    if (!profiles.has(tripId)) {
      const p = getJSON(`${API}/trip?tripId=${encodeURIComponent(tripId)}`).then((t) => HomeLive.buildProfile(t.legs.find((l) => l.mode !== 'WALK')));
      p.catch(() => profiles.delete(tripId));
      profiles.set(tripId, p);
    }
    return profiles.get(tripId);
  }

  let liveBusy = false;
  async function trackLive() {
    if (!proxyUrl || liveBusy || document.hidden || !HOME) return;
    liveBusy = true;
    try {
      const now = Date.now();
      const legs = [];
      const seen = new Set();
      for (const it of visible()) {
        for (const l of it.legs) {
          if (!isBusLeg(l) || seen.has(liveKey(l))) continue;
          const dep = +new Date(l.from.scheduledDeparture || l.startTime);
          if (dep < now - 10 * 60e3 || dep > now + 90 * 60e3) continue;
          seen.add(liveKey(l)); legs.push(l);
        }
      }
      const jobs = (await Promise.allSettled(legs.map(async (l) => {
        const profile = await getProfile(l.tripId);
        const boardIdx = HomeLive.boardingIndex(profile, l);
        return { l, profile, boardIdx, box: HomeLive.searchBox(profile, boardIdx) };
      }))).filter((r) => r.status === 'fulfilled').map((r) => r.value);

      // One request per route number when the boxes fit together; otherwise one per leg.
      const groups = new Map();
      for (const j of jobs) {
        const k = j.l.routeShortName.toUpperCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(j);
      }
      const requests = [];
      for (const [line, js] of groups) {
        const u = HomeLive.unionBox(js.map((j) => j.box));
        if (u[1] - u[0] <= 0.58 && u[3] - u[2] <= 0.58) requests.push({ line, box: u, js });
        else js.forEach((j) => requests.push({ line, box: j.box, js: [j] }));
      }
      await Promise.all(requests.map(async (r) => {
        let vehicles = null;
        try {
          const bbox = r.box.map((x) => x.toFixed(4)).join(',');
          vehicles = (await getJSON(`${proxyUrl.replace(/\/$/, '')}/vehicles?line=${encodeURIComponent(r.line)}&bbox=${bbox}`)).vehicles;
        } catch { /* leave as no signal */ }
        for (const j of r.js) {
          const key = liveKey(j.l);
          const start = j.profile.stops[0].sched;
          if (!vehicles) { state.live.set(key, { state: 'error' }); continue; }
          const v = HomeLive.matchVehicle(vehicles, j.l, j.profile);
          if (!v) { state.live.set(key, { state: Date.now() < start ? 'notyet' : 'nosignal' }); continue; }
          const st = HomeLive.liveStatus(j.profile, j.boardIdx, v);
          if (st.state === 'coming') st.shift = Math.max(0, st.eta - j.profile.stops[j.boardIdx].sched - 60e3); // keep a minute in hand
          state.live.set(key, st);
        }
      }));
      updateLiveUI();
      const list = visible();
      if (window.L && list[state.selected]) drawMap(list[state.selected], true);
    } finally { liveBusy = false; }
  }

  function liveText(ls, plain = false) {
    const b = (t) => (plain ? t : `<b>${t}</b>`);
    switch (ls?.state) {
      case 'coming': {
        const late = ls.delayMin > 0 ? `<span class="late">${ls.delayMin} min late</span>` : ls.delayMin < 0 ? `<span class="ontime">${-ls.delayMin} min early</span>` : '<span class="ontime">on time</span>';
        const away = ls.stopsAway === 0 ? 'at your stop now!' : ls.stopsAway === 1 ? '1 stop away' : `${ls.stopsAway} stops away`;
        const age = ls.ageSec > 120 ? ` · seen ${Math.round(ls.ageSec / 60)} min ago` : '';
        const txt = `${b('Live')} · ${away} · ${late} · due ${fmtTime(new Date(ls.eta))}${age}`;
        return plain ? txt.replace(/<[^>]+>/g, '') : txt;
      }
      case 'gone': return 'This bus has already left your stop';
      case 'notyet': return 'Not on the road yet. Tracking starts when it sets off';
      case 'nosignal': return 'No live signal from this bus';
      case 'unknown': return 'Bus is off its usual route (diversion?)';
      case 'error': return 'Live tracking unavailable right now';
      default: return 'looking for this bus…';
    }
  }

  function updateLiveUI() {
    document.querySelectorAll('.card').forEach((card) => {
      const ls = state.live.get(card.dataset.bus);
      const chip = card.querySelector('.js-chip');
      if (ls?.state === 'coming' && chip && !chip.textContent.includes('disrupted')) chip.innerHTML = '<span class="dot live"></span>live';
    });
    document.querySelectorAll('.live-line').forEach((el) => {
      const ls = state.live.get(el.dataset.key);
      el.className = `live-line ${ls?.state || ''}`;
      const tag = el.closest('.leg')?.querySelector('.when small');
      if (tag && ls?.state === 'coming' && !tag.classList.contains('cancel-tag')) {
        tag.className = ls.delayMin > 0 ? 'late' : 'ontime';
        tag.textContent = ls.delayMin > 0 ? `+${ls.delayMin} min` : 'on time';
      }
      el.innerHTML = `<span class="sat">🛰️</span> ${liveText(ls)}`;
    });
  }

  function promptForHome() {
    setHero("Where's home?", '🏡', 'Set it once below. It stays on this phone.');
    $('homeBy').innerHTML = '';
    $('journeys').innerHTML = '<li class="empty"><div class="big">🗺️</div><b>Tell me where home is</b><br>Tap “I\'m at home now” when you\'re there, or search for your address.</li>';
    status('');
    if ($('fromForm').hidden || state.editing !== 'home') openFromForm('home');
  }

  /* ---------------- boot ---------------- */
  function boot() {
    paintSky();
    $('refreshBtn').addEventListener('click', () => { state.from?.source === 'gps' ? startFromGps() : refresh(true); });
    $('changeFrom').addEventListener('click', () => { const f = $('fromForm'); !f.hidden && state.editing === 'from' ? (f.hidden = true) : openFromForm('from'); });
    $('changeHome').addEventListener('click', () => { const f = $('fromForm'); !f.hidden && state.editing === 'home' ? (f.hidden = true) : openFromForm('home'); });
    if (HOME) { $('homeName').textContent = `🏡 ${HOME.name}`; $('changeHome').textContent = 'change'; }
    $('fromInput').addEventListener('input', onSuggestInput);
    $('fromForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const first = $('suggestions').querySelector('li');
      if (first) first.click(); else onSuggestInput();
    });
    $('useGps').addEventListener('click', async () => {
      if (state.editing === 'home') {
        try {
          const p = await locate();
          $('fromForm').hidden = true;
          state.from = p; $('fromName').textContent = 'home';
          saveHome({ lat: p.lat, lon: p.lon, name: 'Home' });
          status('Home saved on this phone 🏡');
        } catch (e) { status(e.message, true); }
        return;
      }
      store.set(null); $('fromForm').hidden = true; startFromGps();
    });
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      state.filter = t.dataset.filter; state.selected = 0; render();
    }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { paintSky(); state.from?.source === 'gps' ? startFromGps() : refresh(); } });
    setInterval(tick, 1000);
    setInterval(() => { paintSky(); if (!document.hidden) refresh(true); }, REFRESH_MS);

    // ?proxy=URL remembers your live-bus worker on this device (?proxy=off forgets it).
    const pq = new URLSearchParams(location.search).get('proxy');
    if (pq === 'off') { proxyUrl = BODS_PROXY; try { localStorage.removeItem(PROXY_KEY); } catch { /* ignore */ } }
    else if (pq && /^https:\/\/[^\s/]+(\/\S*)?$/.test(pq)) { proxyUrl = pq; try { localStorage.setItem(PROXY_KEY, pq); } catch { /* ignore */ } }
    setInterval(trackLive, LIVE_MS);

    // ?home=lat,lon sets home (handy for a Shortcut); it's saved on this device only.
    const hq = new URLSearchParams(location.search).get('home');
    const hm = hq && hq.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (hm) { HOME = { lat: +hm[1], lon: +hm[2], name: 'Home' }; try { localStorage.setItem(HOME_KEY, JSON.stringify(HOME)); } catch { /* ignore */ } $('homeName').textContent = '🏡 Home'; $('changeHome').textContent = 'change'; }

    // ?from=lat,lon lets an iOS Shortcut pass in the current location directly.
    const q = new URLSearchParams(location.search).get('from');
    const m = q && q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const p = { lat: +m[1], lon: +m[2], name: 'your location', source: 'url' };
      setFrom(p);
      nameFor(p).then((n) => { if (state.from === p) { p.name = n; $('fromName').textContent = n; } });
    } else {
      startFromGps();
    }

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
