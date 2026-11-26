// Fake phone push subscription + decryption via Mozilla's http_ece (an independent implementation).
import nodeCrypto from 'node:crypto';
import { createRequire } from 'node:module';
import { b64u } from '../../worker/src/webpush.js';
const require = createRequire(import.meta.url);
const ece = require('http_ece');

/** A fake browser push subscription with its private key, as a phone would make. */
export function fakeSubscription(endpoint = 'https://web.push.apple.com/QGuQyavXutnMQ') {
  const ua = nodeCrypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { sub: { endpoint, keys: { p256dh: b64u.enc(ua.getPublicKey()), auth: b64u.enc(auth) } }, ua, auth };
}
export function decrypt(body, { ua, auth }) {
  return ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: auth }).toString('utf8');
}

