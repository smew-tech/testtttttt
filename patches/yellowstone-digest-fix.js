// Post-install patch for yellowstone@3.0.1
// Fixes for Hikvision / Dahua / ONVIF cameras with Digest Authentication
//
// Issues fixed:
// 1. ECONNRESET crash — error listener removed after TCP connect, never re-added
// 2. Digest auth URI mismatch — always used this._url instead of actual request URL
// 3. Absolute control URIs — Hikvision returns full rtsp:// in SDP control field
// 4. Global regex lastIndex — WWW_AUTH_REGEX not reset between requests
//
// Run: node patches/yellowstone-digest-fix.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'node_modules', 'yellowstone', 'dist', 'RTSPClient.js');

if (!fs.existsSync(filePath)) {
  console.log('[patch] yellowstone not installed, skipping');
  process.exit(0);
}

let src = fs.readFileSync(filePath, 'utf-8');
let patched = 0;

// ── Fix 1: Keep error listener on socket after TCP connect ──────────────
// Original: removes errorListener and adds nothing
// Fix: replace with a persistent error handler that emits on the client
const oldNetConnect = `            client = net.connect(port, hostname, () => {
                this.isConnected = true;
                this._client = client;
                client.removeListener("error", errorListener);
                this.on("response", responseListener);
                resolve(this);
            });`;

const newNetConnect = `            client = net.connect(port, hostname, () => {
                this.isConnected = true;
                this._client = client;
                client.removeListener("error", errorListener);
                client.on("error", (err) => {
                    this.isConnected = false;
                    this.emit("socketError", err);
                });
                this.on("response", responseListener);
                resolve(this);
            });`;

if (src.includes(oldNetConnect)) {
  src = src.replace(oldNetConnect, newNetConnect);
  patched++;
  console.log('[patch] Fix 1: Added persistent socket error handler');
} else if (src.includes('this.emit("socketError", err)')) {
  console.log('[patch] Fix 1: Already applied');
} else {
  console.warn('[patch] Fix 1: Could not find target code — manual review needed');
}

// ── Fix 2: Digest auth uses actual request URL ──────────────────────────
// Original: always uses this._url for HA2 and uri= field
// Fix: use the `url` parameter passed to request() when available
const oldDigest = `const ha2 = util_1.getMD5Hash(\`\${requestName}:\${this._url}\`);
                            const ha3 = util_1.getMD5Hash(\`\${ha1}:\${nonce}:\${ha2}\`);
                            authString = \`Digest username="\${this.username}",realm="\${realm}",nonce="\${nonce}",uri="\${this._url}",response="\${ha3}"\``;

const newDigest = `const digestUri = url || this._url;
                            const ha2 = util_1.getMD5Hash(\`\${requestName}:\${digestUri}\`);
                            const ha3 = util_1.getMD5Hash(\`\${ha1}:\${nonce}:\${ha2}\`);
                            authString = \`Digest username="\${this.username}",realm="\${realm}",nonce="\${nonce}",uri="\${digestUri}",response="\${ha3}"\``;

if (src.includes(oldDigest)) {
  src = src.replace(oldDigest, newDigest);
  patched++;
  console.log('[patch] Fix 2: Fixed Digest auth URI');
} else if (src.includes('const digestUri = url || this._url')) {
  console.log('[patch] Fix 2: Already applied');
} else {
  console.warn('[patch] Fix 2: Could not find target code — manual review needed');
}

// ── Fix 3: Handle absolute control URIs (Hikvision) ────────────────────
// Original: this._url += `/${mediaSource.control}` — breaks for absolute URIs
// Fix: detect rtsp:// prefix and replace instead of append
const oldControl = `        if (mediaSource.control) {
            this._url += \`/\${mediaSource.control}\`;
        }`;

const newControl = `        if (mediaSource.control) {
            if (mediaSource.control.startsWith("rtsp://") || mediaSource.control.startsWith("rtsps://")) {
                this._url = mediaSource.control;
            } else {
                this._url += \`/\${mediaSource.control}\`;
            }
        }`;

if (src.includes(oldControl)) {
  src = src.replace(oldControl, newControl);
  patched++;
  console.log('[patch] Fix 3: Fixed absolute control URI handling');
} else if (src.includes('mediaSource.control.startsWith("rtsp://")')) {
  console.log('[patch] Fix 3: Already applied');
} else {
  console.warn('[patch] Fix 3: Could not find target code — manual review needed');
}

// ── Fix 4: Reset global regex lastIndex before each use ─────────────────
// The WWW_AUTH_REGEX has "g" flag, so lastIndex persists between calls
const oldRegex = `let match = WWW_AUTH_REGEX.exec(authHeader);`;
const newRegex = `WWW_AUTH_REGEX.lastIndex = 0;
                        let match = WWW_AUTH_REGEX.exec(authHeader);`;

if (src.includes(oldRegex) && !src.includes('WWW_AUTH_REGEX.lastIndex = 0')) {
  src = src.replace(oldRegex, newRegex);
  patched++;
  console.log('[patch] Fix 4: Reset regex lastIndex before auth parsing');
} else if (src.includes('WWW_AUTH_REGEX.lastIndex = 0')) {
  console.log('[patch] Fix 4: Already applied');
}

fs.writeFileSync(filePath, src, 'utf-8');
console.log(`[patch] Done — ${patched} fix(es) applied to yellowstone`);
