/** BODS (Bus Open Data Service) live bus positions: fetching and SIRI-VM parsing. */

const BODS = 'https://data.bus-data.dft.gov.uk/api/v1/datafeed/';
export const MAX_AGE_MIN = 30; // ignore reports older than this (BODS keeps some for hours)

/**
 * Buses on one route inside a box. box = [minLat, maxLat, minLon, maxLon].
 * Throws on network/HTTP errors.
 */
export async function fetchVehicles(apiKey, line, box, { cacheTtl } = {}) {
  const [minLat, maxLat, minLon, maxLon] = box;
  // BODS wants minLon,minLat,maxLon,maxLat (longitude first).
  const res = await fetch(`${BODS}?boundingBox=${minLon},${minLat},${maxLon},${maxLat}&api_key=${encodeURIComponent(apiKey)}`, {
    headers: { Accept: 'text/xml, */*' }, // BODS answers 406 to application/xml
    ...(cacheTtl ? { cf: { cacheTtl } } : {}),
  });
  if (!res.ok) { const e = new Error(`BODS replied ${res.status}`); e.status = res.status; throw e; }
  const want = String(line).toLowerCase();
  const oldest = Date.now() - MAX_AGE_MIN * 60e3;
  return parseSiriVm(await res.text()).filter((v) => v.line.toLowerCase() === want && !(Date.parse(v.recordedAt) < oldest));
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
