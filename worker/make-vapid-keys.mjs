// Makes the key pair your Worker uses to sign push notifications.
// Run once:  node worker/make-vapid-keys.mjs
// Then add both values in Cloudflare (see worker/README.md). Keep the private key secret.
import { generateVapidKeys } from './src/webpush.js';

const { publicKey, privateKey } = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY  (Text)   ${publicKey}`);
console.log(`VAPID_PRIVATE_KEY (Secret) ${privateKey}`);
