// server.js — Next.js + RTSP→WebSocket bridge (no ffmpeg, no third-party runtime)
const { createServer } = require('http');
const next = require('next');
const { WebSocketServer } = require('ws');
const { RTSPClient, H264Transport } = require('yellowstone');

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, hostname: 'localhost', port: 3000 });
const handle = app.getRequestHandler();

// ─── Camera credentials & config ───────────────────────────────────────────
const RTSP_URL = 'rtsp://localhost:5554/cam/realmonitor?channel=1&subtype=0';
const CAM_USER = 'admin';
const CAM_PASS = 'abcd1234';
const WS_PORT = 8765;
const HTTP_PORT = 3000;

// ─── NAL helpers ────────────────────────────────────────────────────────────
const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function nalType(buf) {
  // buf may start with start-code or NAL header directly
  let off = 0;
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 1) off = 4;
  else if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1) off = 3;
  return (buf[off] || 0) & 0x1f;
}

function codecFromSPS(sps) {
  // sps is a raw NAL (no start code), starts with NAL header byte
  const p = sps[1], c = sps[2], l = sps[3];
  if (!p || !l) return 'avc1.42001f';
  return `avc1.${p.toString(16).padStart(2, '0')}${c.toString(16).padStart(2, '0')}${l.toString(16).padStart(2, '0')}`;
}

// ─── Boot ───────────────────────────────────────────────────────────────────


function start(onReady) {
  app.prepare().then(() => {
    // Next.js HTTP server
    const httpServer = createServer((req, res) => {
      const parsedUrl = require('url').parse(req.url, true);
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
      function startStream() {
        if (destroyed) return;

        // FIX 1: pass credentials to constructor
        const client = new RTSPClient(CAM_USER, CAM_PASS);
        rtspClient = client;

        let configured = false;
        let spsRaw = null;

        // FIX 2: correct connection option name
        client.connect(RTSP_URL, { connection: 'tcp' })
          .then((details) => {
            console.log('[RTSP] Connected, codec:', details.codec);

            // Attach error handler to underlying TCP socket to prevent ECONNRESET
            // from becoming an uncaughtException (yellowstone removes it after connect)
            if (client._client) {
              client._client.on('error', (err) => {
                console.warn('[RTSP socket] Error:', err.code || err.message);
                if (!destroyed) scheduleReconnect();
              });
            }

            // Extract SPS/PPS from SDP sprop-parameter-sets
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
                  sendJSON({ type: 'config', codec });
                  // Send SPS + PPS as keyframes so decoder has parameter sets
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
                  const isKey = type === 5 || type === 7 || type === 8; // IDR, SPS, PPS

                  // If we see SPS in-band, send fresh config
                  if (type === 7 && !configured) {
                    spsRaw = nal;
                    sendJSON({ type: 'config', codec: codecFromSPS(nal) });
                  }

                  const annexB = Buffer.concat([START_CODE, nal]);
                  if (configured || type === 5 || type === 7 || type === 8) {
                    send(makeFrame(annexB, isKey));
                  }
                  if (type === 5) configured = true; // IDR seen, fully configured
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
            scheduleReconnect();
          });

        // yellowstone doesn't emit 'close' on RTSPClient, but the underlying
        // socket ECONNRESET is swallowed above; detect via keepAlive heartbeat
        const aliveCheck = setInterval(() => {
          if (!client.isConnected && !destroyed) {
            clearInterval(aliveCheck);
            scheduleReconnect();
          }
        }, 5000);

        client._aliveCheck = aliveCheck; // store ref for cleanup
      }

      function scheduleReconnect() {
        if (destroyed) return;
        try {
          if (rtspClient) {
            clearInterval(rtspClient._aliveCheck);
            rtspClient.close(true).catch(() => { });
          }
        } catch (_) { }
        rtspClient = null;
        sendJSON({ type: 'status', status: 'reconnecting' });
        console.log('[RTSP] Reconnecting in 3s…');
        reconnTimer = setTimeout(startStream, 3000);
      }

      startStream();

      ws.on('close', () => {
        console.log('[WS] Client disconnected');
        destroyed = true;
        clearTimeout(reconnTimer);
        try {
          if (rtspClient) {
            clearInterval(rtspClient._aliveCheck);
            rtspClient.close(true).catch(() => { });
          }
        } catch (_) { }
      });

      ws.on('error', (e) => console.error('[WS] Error:', e.message));
    });
  });

  // ─── H.264 RTP De-packetizer ────────────────────────────────────────────────
  // Handles: Single NAL (type 1-23), STAP-A (24), FU-A (28)
  const fuaMap = new Map(); // ssrc → partial NAL buffer

  function depacketizeH264(payload) {
    if (!payload || payload.length < 1) return [];
    const type = payload[0] & 0x1f;
    const nri = (payload[0] >> 5) & 0x03;

    // Single NAL unit
    if (type >= 1 && type <= 23) {
      return [Buffer.from(payload)];
    }

    // STAP-A (aggregation)
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

    // FU-A (fragmentation)
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
