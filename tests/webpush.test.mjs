// Checks our Web Push code against independent implementations:
// Mozilla's http_ece decrypts the payload, Node's crypto verifies the VAPID signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { b64u, encryptPayload, vapidAuth, generateVapidKeys } from '../worker/src/webpush.js';
import { fakeSubscription, decrypt } from './helpers/push-fakes.mjs';

test('payload encrypted by us is decrypted by Mozilla http_ece', async () => {
  const f = fakeSubscription();
  const msg = JSON.stringify({ title: '🐢 18:15 Y1 bus is 4 min late', body: 'Now due at Cabot Circus at 18:19.' });
  const body = await encryptPayload(f.sub, msg);
  assert.equal(decrypt(body, f), msg);
  // Header: 16-byte salt, record size 4096, 65-byte sender key.
  assert.equal(body[20], 65);
  assert.deepEqual([...body.slice(16, 20)], [0, 0, 16, 0]);
});

test('each message uses fresh keys, so identical messages look different', async () => {
  const f = fakeSubscription();
  const a = await encryptPayload(f.sub, 'same');
  const b = await encryptPayload(f.sub, 'same');
  assert.notDeepEqual(a, b);
});

test('VAPID header is a valid ES256 JWT for the push service origin', async () => {
  const keys = await generateVapidKeys();
  const subject = 'mailto:alerts@example.com';
  const h = await vapidAuth('https://web.push.apple.com/abc/def', { ...keys, subject });
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, h);
  const [, head, claims, sig, k] = m;
  assert.equal(k, keys.publicKey);
  const c = JSON.parse(Buffer.from(b64u.dec(claims)).toString());
  assert.equal(c.aud, 'https://web.push.apple.com');
  assert.equal(c.sub, subject);
  assert.ok(c.exp > Date.now() / 1000 && c.exp <= Date.now() / 1000 + 24 * 3600);
  const pub = b64u.dec(keys.publicKey);
  const pubKey = nodeCrypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33)) }, format: 'jwk' });
  const ok = nodeCrypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64u.dec(sig)));
  assert.ok(ok, 'signature verifies');
});
