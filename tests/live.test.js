// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../live.js');

// A real Y1 trip (The Centre → Yate → The Centre loop) from Transitous /trip.
const trip = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/y1-trip.json'), 'utf8'));
const leg = trip.legs[0];
const profile = L.buildProfile(leg);
const st = profile.stops;
const MIN = 60e3;

// Pretend we're catching the Y1 at the 20th stop along.
const BOARD = 20;
const myLeg = {
  routeShortName: 'Y1',
  startTime: new Date(st[BOARD].sched).toISOString(),
  from: { stopId: leg.intermediateStops[BOARD - 1].stopId, name: st[BOARD].name, scheduledDeparture: new Date(st[BOARD].sched).toISOString() },
};
const vehicleAt = (i, recordedAt, extra = {}) => ({
  line: 'Y1', lat: st[i].lat, lon: st[i].lon, recordedAt: new Date(recordedAt).toISOString(),
  originAimedDeparture: new Date(st[0].sched).toISOString(), vehicleRef: 'BUS1', ...extra,
});

test('profile: every stop has a time and stops run forward along the route', () => {
  assert.equal(st.length, leg.intermediateStops.length + 2);
  assert.ok(profile.length > 10000, `route is ${profile.length} m`);
  for (let i = 1; i < st.length; i++) {
    assert.ok(st[i].dist >= st[i - 1].dist, `stop ${i} goes backwards`);
    assert.ok(Number.isFinite(st[i].sched));
  }
  // It's a loop: the last stop is far along even though it's where it started.
  assert.ok(st[st.length - 1].dist > profile.length * 0.9);
});

test('boarding stop is found by stop id and time', () => {
  assert.equal(L.boardingIndex(profile, myLeg), BOARD);
});

test('bus on time, 5 stops before mine', () => {
  const now = st[BOARD - 5].sched;
  const s = L.liveStatus(profile, BOARD, vehicleAt(BOARD - 5, now), now);
  assert.equal(s.state, 'coming');
  assert.equal(s.delayMin, 0);
  assert.equal(s.stopsAway, 5);
  assert.equal(s.eta, st[BOARD].sched);
});

test('bus 4 minutes late pushes the arrival back 4 minutes', () => {
  const now = st[BOARD - 3].sched + 4 * MIN;
  const s = L.liveStatus(profile, BOARD, vehicleAt(BOARD - 3, now), now);
  assert.equal(s.delayMin, 4);
  assert.equal(s.stopsAway, 3);
  assert.equal(s.eta, st[BOARD].sched + 4 * MIN);
});

test('bus already past my stop is reported as gone', () => {
  const now = st[BOARD + 2].sched;
  const s = L.liveStatus(profile, BOARD, vehicleAt(BOARD + 2, now), now);
  assert.equal(s.state, 'gone');
});

test('bus waiting at the first stop before its start time is not late', () => {
  const now = st[0].sched - 3 * MIN;
  const s = L.liveStatus(profile, BOARD, vehicleAt(0, now), now);
  assert.equal(s.state, 'coming');
  assert.equal(s.delayMin, 0);
  assert.equal(s.stopsAway, BOARD);
});

test('a GPS fix far from the route is unknown, not a wrong guess', () => {
  const now = st[5].sched;
  const s = L.liveStatus(profile, BOARD, { ...vehicleAt(5, now), lat: 51.30, lon: -2.90 }, now);
  assert.equal(s.state, 'unknown');
});

test('loop route: the same street twice is resolved using the timetable', () => {
  // The first stop and the last stop are the same place; at the start of the trip the
  // bus is at the start, not near the end.
  const now = st[0].sched;
  const where = L.locateOnRoute(profile, st[0].lat, st[0].lon, now);
  assert.ok(where.d < 500, `matched ${where.d} m along`);
  const late = L.locateOnRoute(profile, st[0].lat, st[0].lon, st[st.length - 1].sched);
  assert.ok(late.d > profile.length - 500, `matched ${late.d} m along`);
});

test('matchVehicle picks the bus running this journey', () => {
  const start = st[0].sched;
  const iso = (t) => new Date(t).toISOString();
  const vehicles = [
    { line: 'Y1', originAimedDeparture: iso(start - 30 * MIN), vehicleRef: 'earlier' },
    { line: 'm3x', originAimedDeparture: iso(start), vehicleRef: 'other-route' },
    { line: 'y1', originAimedDeparture: iso(start + 60e3), vehicleRef: 'mine', recordedAt: '2026-01-01T00:00:00Z' },
    { line: 'Y1', originAimedDeparture: iso(start + 30 * MIN), vehicleRef: 'later' },
  ];
  assert.equal(L.matchVehicle(vehicles, myLeg, profile).vehicleRef, 'mine');
  assert.equal(L.matchVehicle(vehicles.filter((v) => v.vehicleRef !== 'mine'), myLeg, profile), null);
});

test('search box covers the route before my stop and stays within the proxy limit', () => {
  const b = L.searchBox(profile, BOARD);
  assert.ok(b[1] - b[0] <= 0.6 && b[3] - b[2] <= 0.6);
  for (let i = 0; i <= BOARD; i++) {
    if (st[BOARD].dist - st[i].dist > 30000) continue;
    assert.ok(st[i].lat >= b[0] && st[i].lat <= b[1] && st[i].lon >= b[2] && st[i].lon <= b[3], `stop ${i} outside box`);
  }
});
