// Post-install patch for yellowstone@3.0.1
// Fixes:
// 1. Absolute control URIs (Hikvision cameras) — prevents double-URL
// 2. Digest auth uses actual request URL instead of always this._url
//
// Run: node patches/yellowstone-digest-fix.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'node_modules', 'yellowstone', 'dist', 'RTSPClient.js');

let content = fs.readFileSync(filePath, 'utf-8');

// Fix 1: Handle absolute control URIs
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

if (content.includes(oldControl)) {
  content = content.replace(oldControl, newControl);
  console.log('[patch] Fixed absolute control URI handling');
}

// Fix 2: Digest auth uses actual request URL
const oldDigest = 'const ha2 = util_1.getMD5Hash(`${requestName}:${this._url}`);\n                            const ha3 = util_1.getMD5Hash(`${ha1}:${nonce}:${ha2}`);\n                            authString = `Digest username="${this.username}",realm="${realm}",nonce="${nonce}",uri="${this._url}",response="${ha3}"`;';
const newDigest = 'const digestUri = url || this._url;\n                            const ha2 = util_1.getMD5Hash(`${requestName}:${digestUri}`);\n                            const ha3 = util_1.getMD5Hash(`${ha1}:${nonce}:${ha2}`);\n                            authString = `Digest username="${this.username}",realm="${realm}",nonce="${nonce}",uri="${digestUri}",response="${ha3}"`;';

if (content.includes('const ha2 = util_1.getMD5Hash(`${requestName}:${this._url}`)')) {
  content = content.replace(
    /const ha2 = util_1\.getMD5Hash\(`\$\{requestName\}:\$\{this\._url\}`\);\s*const ha3 = util_1\.getMD5Hash\(`\$\{ha1\}:\$\{nonce\}:\$\{ha2\}`\);\s*authString = `Digest username="\$\{this\.username\}",realm="\$\{realm\}",nonce="\$\{nonce\}",uri="\$\{this\._url\}",response="\$\{ha3\}"`;/,
    newDigest
  );
  console.log('[patch] Fixed Digest auth URI');
}

fs.writeFileSync(filePath, content, 'utf-8');
console.log('[patch] yellowstone patched successfully');
