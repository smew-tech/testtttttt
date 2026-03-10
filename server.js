// server.js — Next.js + RTSP→WebSocket bridge with multi-protocol camera support
const { createServer } = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');
const { RTSPClient, H264Transport } = require('yellowstone');

// Prevent uncaught ECONNRESET from crashing the process
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
    console.warn('[Process] Caught socket error:', err.code);
    return;
  }
  console.error('[Process] Uncaught exception:', err);
});

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, hostname: 'localhost', port: 3000 });
const handle = app.getRequestHandler();

const WS_PORT = 8765;
const HTTP_PORT = 3000;

// ─── NAL helpers ────────────────────────────────────────────────────────────
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function nalType(buf) {
  let off = 0;
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) off = 4;
  else if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1) off = 3;
  return (buf[off] || 0) & 0x1f;
}

function codecFromSPS(sps) {
  const p = sps[1], c = sps[2], l = sps[3];
  if (!p || !l) return 'avc1.42001f';
  return `avc1.${p.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}${l.toString(16).padStart(2, '0')}`;
}

// ─── ONVIF Discovery ────────────────────────────────────────────────────────
let onvifLib = null;
try {
  onvifLib = require('onvif');
} catch (e) {
  console.warn('[ONVIF] Library not available:', e.message);
}

function discoverOnvifDevices(timeout = 5000) {
  return new Promise((resolve) => {
    if (!onvifLib || !onvifLib.Discovery) {
      resolve([]);
      return;
    }
    const devices = [];
    onvifLib.Discovery.probe({ timeout }, (err, cams) => {
      if (err || !cams) {
        resolve([]);
        return;
      }
      for (const cam of cams) {
        devices.push({
          name: cam.name || cam.hostname || 'ONVIF Camera',
          hostname: cam.hostname || '',
          port: cam.port || 80,
          path: cam.path || '',
          xaddrs: cam.xaddrs || [],
          types: cam.types || [],
          manufacturer: cam.manufacturer || '',
          model: cam.model || '',
        });
      }
      resolve(devices);
    });
  });
}

function getOnvifStreamUrl(config) {
  return new Promise((resolve, reject) => {
    if (!onvifLib || !onvifLib.Cam) {
      reject(new Error('ONVIF library not available'));
      return;
    }
    const cam = new onvifLib.Cam({
      hostname: config.hostname,
      port: config.port || 80,
      username: config.username || 'admin',
      password: config.password || '',
    }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      cam.getStreamUri({ protocol: 'RTSP' }, (err2, stream) => {
        if (err2) {
          reject(err2);
          return;
        }
        resolve({
          rtspUrl: stream.uri,
          name: cam.deviceInformation?.model || config.hostname,
        });
      });
    });
  });
}

// ─── Build RTSP URL from camera config ──────────────────────────────────────
function buildRtspUrl(config) {
  switch (config.connectionType) {
    case 'wifi':
    case 'ethernet': {
      // Direct RTSP URL or build from parts
      if (config.rtspUrl) return config.rtspUrl;
      const proto = 'rtsp://';
      // Don't embed credentials in URL — yellowstone handles auth separately
      // (required for Digest authentication)
      const host = config.host || 'localhost';
      const port = config.port ? `:${config.port}` : ':554';
      const path = config.path || '/';
      return `${proto}${host}${port}${path}`;
    }
    case 'onvif':
      // ONVIF URL will be resolved dynamically
      return config.rtspUrl || '';
    case 'analog':
      // Analog cameras need a capture card — use RTSP from a local encoder
      if (config.rtspUrl) return config.rtspUrl;
      return `rtsp://localhost:${config.port || 554}/${config.path || 'analog'}`;
    default:
      return config.rtspUrl || '';
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
function start(onReady) {
  app.prepare().then(() => {
    // Next.js HTTP server with API routes
    const httpServer = createServer((req, res) => {
      const parsedUrl = require('url').parse(req.url, true);

      // ── API: ONVIF Discovery ──
      if (parsedUrl.pathname === '/api/onvif/discover' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        const timeout = parseInt(parsedUrl.query.timeout) || 5000;
        discoverOnvifDevices(timeout)
          .then((devices) => {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, devices }));
          })
          .catch((err) => {
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
          });
        return;
      }

      // ── API: ONVIF Get Stream URL ──
      if (parsedUrl.pathname === '/api/onvif/stream-url' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const config = JSON.parse(body);
            getOnvifStreamUrl(config)
              .then((result) => {
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, ...result }));
              })
              .catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: err.message }));
              });
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }

      // ── API: Test RTSP connection ──
      if (parsedUrl.pathname === '/api/camera/test' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          try {
            const config = JSON.parse(body);
            const rtspUrl = buildRtspUrl(config);
            const testClient = new RTSPClient(config.username || '', config.password || '');
            // Catch early socket errors
            const earlyPoll = setInterval(() => {
              if (testClient._client) {
                clearInterval(earlyPoll);
                testClient._client.on('error', () => {});
              }
            }, 50);
            const timeoutId = setTimeout(() => {
              clearInterval(earlyPoll);
              try { testClient.close(true).catch(() => {}); } catch(_) {}
              res.writeHead(408);
              res.end(JSON.stringify({ success: false, error: 'Connection timeout' }));
            }, 10000);

            testClient.connect(rtspUrl, { connection: 'tcp' })
              .then((details) => {
                clearTimeout(timeoutId);
                clearInterval(earlyPoll);
                testClient.close(true).catch(() => {});
                res.writeHead(200);
                res.end(JSON.stringify({
                  success: true,
                  codec: details.codec,
                  rtspUrl,
                }));
              })
              .catch((err) => {
                clearTimeout(timeoutId);
                clearInterval(earlyPoll);
                res.writeHead(200);
                res.end(JSON.stringify({ success: false, error: err.message }));
              });
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
          }
        });
        return;
      }

      handle(req, res, parsedUrl);
    });
    httpServer.listen(HTTP_PORT, () => {
      console.log(`[Next.js] Ready → http://localhost:${HTTP_PORT}`);
      onReady && onReady(HTTP_PORT);
    });

    // WebSocket server
    const wss = new WebSocketServer({ port: WS_PORT });
    console.log(`[WS] Listening → ws://localhost:${WS_PORT}`);

    wss.on('connection', (ws) => {
      console.log('[WS] Client connected');

      let rtspClient = null;
      let destroyed = false;
      let reconnTimer = null;
      let currentConfig = null;

      // ── helpers ──────────────────────────────────────────────────────────
      function send(buf) {
        if (ws.readyState === ws.OPEN)
          ws.send(buf, { binary: true }, (e) => e && console.error('[WS] send:', e.message));
      }
      function sendJSON(obj) {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify(obj), { binary: false });
      }
      function makeFrame(nalBuf, isKey) {
        const flag = Buffer.alloc(1);
        flag[0] = isKey ? 0x01 : 0x00;
        return Buffer.concat([flag, nalBuf]);
      }

      // ── RTSP connect ─────────────────────────────────────────────────────
      function startStream(config) {
        if (destroyed) return;
        currentConfig = config;

        const rtspUrl = buildRtspUrl(config);
        const username = config.username || '';
        const password = config.password || '';

        console.log(`[RTSP] Connecting to: ${rtspUrl} (type: ${config.connectionType})`);
        sendJSON({ type: 'status', status: 'connecting', connectionType: config.connectionType });

        const client = new RTSPClient(username, password);
        rtspClient = client;

        // Attach error handler on underlying socket as early as possible
        // yellowstone exposes _client after _netConnect; poll until available
        const earlyErrorPoll = setInterval(() => {
          if (client._client) {
            clearInterval(earlyErrorPoll);
            client._client.on('error', (err) => {
              console.warn('[RTSP socket] Error:', err.code || err.message);
              if (!destroyed) scheduleReconnect();
            });
          }
        }, 50);
        // Stop polling after 10s regardless
        setTimeout(() => clearInterval(earlyErrorPoll), 10000);

        let configured = false;
        let spsRaw = null;

        client.connect(rtspUrl, { connection: 'tcp' })
          .then((details) => {
            console.log('[RTSP] Connected, codec:', details.codec);
            clearInterval(earlyErrorPoll);

            // Extract SPS/PPS from SDP
            try {
              const fmtp = details.mediaSource?.fmtp?.[0];
              if (fmtp) {
                const match = fmtp.config.match(/sprop-parameter-sets=([^;\s]+)/i);
                if (match) {
                  const [spsB64, ppsB64] = match[1].split(',');
                  spsRaw = Buffer.from(spsB64, 'base64');
                  const ppsRaw = Buffer.from(ppsB64, 'base64');
                  const codec = codecFromSPS(spsRaw);
                  console.log('[RTSP] Codec from SDP SPS:', codec);
                  sendJSON({ type: 'config', codec, connectionType: config.connectionType });
                  send(makeFrame(Buffer.concat([START_CODE, spsRaw]), true));
                  send(makeFrame(Buffer.concat([START_CODE, ppsRaw]), true));
                  configured = true;
                }
              }
            } catch (e) {
              console.warn('[RTSP] Cannot parse SDP fmtp:', e.message);
            }

            // RTP data → de-packetize, classify, forward
            client.on('data', (_ch, _payload, packet) => {
              if (destroyed || ws.readyState !== ws.OPEN) return;
              try {
                const nals = depacketizeH264(packet.payload);
                for (const nal of nals) {
                  const type = (nal[0] || 0) & 0x1f;
                  const isKey = type === 5 || type === 7 || type === 8;

                  if (type === 7 && !configured) {
                    spsRaw = nal;
                    sendJSON({ type: 'config', codec: codecFromSPS(nal), connectionType: config.connectionType });
                  }

                  const annexB = Buffer.concat([START_CODE, nal]);
                  if (configured || type === 5 || type === 7 || type === 8) {
                    send(makeFrame(annexB, isKey));
                  }
                  if (type === 5) configured = true;
                }
              } catch (e) {
                // ignore bad RTP packets
              }
            });

            client.play().catch((e) => {
              console.error('[RTSP] play failed:', e.message);
              scheduleReconnect();
            });
          })
          .catch((err) => {
            console.error('[RTSP] Connect failed:', err.message || err);
            sendJSON({ type: 'error', error: `Không thể kết nối: ${err.message || err}` });
            scheduleReconnect();
          });

        const aliveCheck = setInterval(() => {
          if (!client.isConnected && !destroyed) {
            clearInterval(aliveCheck);
            scheduleReconnect();
          }
        }, 5000);

        client._aliveCheck = aliveCheck;
      }

      function stopStream() {
        try {
          if (rtspClient) {
            clearInterval(rtspClient._aliveCheck);
            rtspClient.close(true).catch(() => {});
          }
        } catch (_) {}
        rtspClient = null;
        if (reconnTimer) {
          clearTimeout(reconnTimer);
          reconnTimer = null;
        }
      }

      function scheduleReconnect() {
        if (destroyed) return;
        stopStream();
        sendJSON({ type: 'status', status: 'reconnecting' });
        console.log('[RTSP] Reconnecting in 3s…');
        reconnTimer = setTimeout(() => {
          if (currentConfig) startStream(currentConfig);
        }, 3000);
      }

      // ── Handle client messages (camera config) ───────────────────────────
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'connect') {
            // Stop existing stream and start new one
            stopStream();
            startStream(msg.config);
          } else if (msg.type === 'disconnect') {
            stopStream();
            sendJSON({ type: 'status', status: 'disconnected' });
          }
        } catch (e) {
          console.warn('[WS] Invalid message:', e.message);
        }
      });

      ws.on('close', () => {
        console.log('[WS] Client disconnected');
        destroyed = true;
        stopStream();
      });

      ws.on('error', (e) => console.error('[WS] Error:', e.message));
    });
  });

  // ─── H.264 RTP De-packetizer ────────────────────────────────────────────────
  const fuaMap = new Map();

  function depacketizeH264(payload) {
    if (!payload || payload.length < 1) return [];
    const type = payload[0] & 0x1f;
    const nri = (payload[0] >> 5) & 0x03;

    if (type >= 1 && type <= 23) {
      return [Buffer.from(payload)];
    }

    if (type === 24) {
      const nals = [];
      let ptr = 1;
      while (ptr + 2 <= payload.length) {
        const size = (payload[ptr] << 8) | payload[ptr + 1];
        ptr += 2;
        if (ptr + size <= payload.length) {
          nals.push(Buffer.from(payload.slice(ptr, ptr + size)));
          ptr += size;
        } else break;
      }
      return nals;
    }

    if (type === 28) {
      const fuHeader = payload[1];
      const start = (fuHeader >> 7) & 1;
      const end = (fuHeader >> 6) & 1;
      const fuType = fuHeader & 0x1f;
      const nalHeader = (nri << 5) | fuType;

      const key = 'fua';
      if (start) {
        const buf = [nalHeader];
        for (let i = 2; i < payload.length; i++) buf.push(payload[i]);
        fuaMap.set(key, buf);
      } else if (fuaMap.has(key)) {
        const arr = fuaMap.get(key);
        for (let i = 2; i < payload.length; i++) arr.push(payload[i]);
        fuaMap.set(key, arr);
      }

      if (end && fuaMap.has(key)) {
        const complete = Buffer.from(fuaMap.get(key));
        fuaMap.delete(key);
        return [complete];
      }
      return [];
    }

    return [];
  }
}

// Allow running standalone or from Electron
if (require.main === module) {
  start();
}

module.exports = { start };
