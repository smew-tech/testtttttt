# RTSP Camera Viewer — Next.js (No FFmpeg)

Stream an IP camera's RTSP feed directly in the browser using **pure Node.js** and a **WASM H.264 decoder** — zero FFmpeg dependency.

## Stack

| Layer | Technology |
|-------|-----------|
| RTSP client (server) | [`yellowstone`](https://github.com/BreeeZe/rpos/tree/master/src/lib/yellowstone) — pure Node.js |
| WebSocket bridge | `ws` |
| H.264 decoder (browser) | [Broadway.js](https://github.com/mbebenita/Broadway) (WASM) |
| Framework | Next.js 14 (App Router) |

## Quick Start

```bash
# Build the Next.js app first
npm run build

# Then run the custom server (Next.js + WebSocket RTSP bridge)
node server.js
```

Open **http://localhost:3000** — the camera stream will appear automatically.

## Ports

| Port | Purpose |
|------|---------|
| `3000` | Next.js web UI |
| `8765` | WebSocket server (RTSP raw H.264 NAL units) |

## Camera

```
rtsp://admin:abcd1234@localhost:554/cam/realmonitor?channel=1&subtype=0
```

Edit `RTSP_URL` in `server.js` to change the camera.

## How It Works

```
Camera (RTSP/RTP) ─→ yellowstone (Node.js)
                        │  binary frames over WS
                        ▼
               browser (Broadway.js WASM)
                        │  decoded YUV frames
                        ▼
                   <canvas> element
```

1. `server.js` starts Next.js and a separate WebSocket server on port `8765`.
2. On WS connection, it opens an RTSP session via `yellowstone`, no FFmpeg spawn.
3. Raw H.264 NAL units are forwarded over the WebSocket as binary messages.
4. The browser loads Broadway.js from CDN, connects to the WS, and decodes each NAL unit directly into a `<canvas>`.
