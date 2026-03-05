'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

type Status = 'connecting' | 'live' | 'reconnecting' | 'error' | 'unsupported';
type RecordState = 'idle' | 'recording' | 'saving';

const WS_URL = 'ws://localhost:8765';

function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RTSPPlayer() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const decoderRef = useRef<VideoDecoder | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const codecRef = useRef<string>('avc1.42001f');
    const configuredRef = useRef(false);

    // Recording
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordedChunksRef = useRef<Blob[]>([]);
    const recordStartRef = useRef<number>(0);
    const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const captureTrackRef = useRef<CanvasCaptureMediaStreamTrack | null>(null);

    const [status, setStatus] = useState<Status>('connecting');
    const [frameCount, setFrameCount] = useState(0);
    const [resolution, setResolution] = useState('');
    const [recordState, setRecordState] = useState<RecordState>('idle');
    const [recordDuration, setRecordDuration] = useState(0);
    const [recordSize, setRecordSize] = useState(0);
    const [lastSaved, setLastSaved] = useState<{ name: string; size: number } | null>(null);

    // ─── Check WebCodecs support ──────────────────────────────────────────────
    const isSupported = typeof window !== 'undefined' && 'VideoDecoder' in window;

    // ─── Create / reset VideoDecoder ─────────────────────────────────────────
    const createDecoder = useCallback(() => {
        if (!isSupported) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (decoderRef.current && decoderRef.current.state !== 'closed') {
            try { decoderRef.current.close(); } catch (_) { }
        }

        decoderRef.current = new VideoDecoder({
            output(frame) {
                // Resize canvas to match video dimensions on first frame
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                    setResolution(`${frame.displayWidth}×${frame.displayHeight}`);
                }
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                frame.close();
                // Notify captureStream that a new frame was drawn
                if (captureTrackRef.current) {
                    try { captureTrackRef.current.requestFrame(); } catch (_) { }
                }
                setFrameCount((c) => c + 1);
                setStatus('live');
            },
            error(e) {
                console.error('[VideoDecoder] error:', e);
            },
        });
    }, [isSupported]);

    const configureDecoder = useCallback((codec: string) => {
        if (!decoderRef.current) return;
        try {
            decoderRef.current.configure({
                codec,
                hardwareAcceleration: 'prefer-hardware',
                optimizeForLatency: true,
            });
            configuredRef.current = true;
            console.log('[VideoDecoder] configured with codec:', codec);
        } catch (e) {
            console.error('[VideoDecoder] configure failed:', e, '— falling back to avc1.42001f');
            try {
                decoderRef.current.configure({ codec: 'avc1.42001f', optimizeForLatency: true });
                configuredRef.current = true;
            } catch (e2) {
                console.error('[VideoDecoder] fallback configure also failed:', e2);
            }
        }
    }, []);

    const handleFrame = useCallback((data: ArrayBuffer) => {
        const buf = new Uint8Array(data);
        if (buf.length < 2) return;

        const isKey = buf[0] === 0x01;
        const nal = buf.slice(1);

        if (!decoderRef.current || !configuredRef.current) return;
        if (decoderRef.current.state === 'closed') return;

        try {
            const chunk = new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: performance.now() * 1000, // microseconds
                data: nal,
            });
            decoderRef.current.decode(chunk);
        } catch (e) {
            // ignore stale frames after reconfigure
        }
    }, []);

    // ─── WebSocket connect ────────────────────────────────────────────────────
    const connectWS = useCallback(() => {
        if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
        configuredRef.current = false;
        setStatus('connecting');
        createDecoder();

        const ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => console.log('[WS] Connected');

        ws.onmessage = (evt) => {
            if (typeof evt.data === 'string') {
                try {
                    const msg = JSON.parse(evt.data as string);
                    if (msg.type === 'config') {
                        // Re-create decoder and configure with detected codec
                        codecRef.current = msg.codec;
                        createDecoder();
                        configureDecoder(msg.codec);
                    } else if (msg.type === 'status' && msg.status === 'reconnecting') {
                        configuredRef.current = false;
                        setStatus('reconnecting');
                    }
                } catch (_) { }
                return;
            }
            handleFrame(evt.data as ArrayBuffer);
        };

        ws.onerror = () => setStatus('error');
        ws.onclose = () => {
            setStatus('reconnecting');
            reconnTimer.current = setTimeout(connectWS, 3000);
        };
    }, [createDecoder, configureDecoder, handleFrame]);

    useEffect(() => {
        if (!isSupported) { setStatus('unsupported'); return; }
        connectWS();
        return () => {
            if (reconnTimer.current) clearTimeout(reconnTimer.current);
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
            if (decoderRef.current && decoderRef.current.state !== 'closed') {
                try { decoderRef.current.close(); } catch (_) { }
            }
        };
    }, [connectWS, isSupported]);

    // ─── Recording (canvas → MediaRecorder) ──────────────────────────────────
    const startRecording = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) { alert('Canvas chưa sẵn sàng.'); return; }

        const mime = [
            'video/mp4;codecs=h264',
            'video/mp4;codecs=avc1',
            'video/mp4',
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm',
        ].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

        // captureStream(0) = manual mode, we call requestFrame() after each canvas draw
        const stream = canvas.captureStream(0);
        const videoTracks = stream.getVideoTracks();
        if (!videoTracks.length) { alert('Không thể capture canvas stream.'); return; }
        captureTrackRef.current = videoTracks[0] as CanvasCaptureMediaStreamTrack;
        const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
        recordedChunksRef.current = [];
        recordStartRef.current = Date.now();

        mr.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                recordedChunksRef.current.push(e.data);
                setRecordSize(recordedChunksRef.current.reduce((a, b) => a + b.size, 0));
            }
        };

        mr.onstop = () => {
            captureTrackRef.current = null;
            setRecordState('saving');
            if (recordTimerRef.current) clearInterval(recordTimerRef.current);
            const blob = new Blob(recordedChunksRef.current, { type: mime });
            const url = URL.createObjectURL(blob);
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const ext = mime.includes('mp4') ? 'mp4' : 'webm';
            const fname = `camera_${ts}.${ext}`;
            const a = document.createElement('a');
            a.href = url; a.download = fname; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            setLastSaved({ name: fname, size: blob.size });
            setRecordDuration(0); setRecordSize(0); setRecordState('idle');
        };

        mr.start(500);
        mediaRecorderRef.current = mr;
        setRecordState('recording');
        recordTimerRef.current = setInterval(
            () => setRecordDuration(Date.now() - recordStartRef.current), 1000
        );
    }, []);

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive')
            mediaRecorderRef.current.stop();
    }, []);

    useEffect(() => () => {
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive')
            mediaRecorderRef.current.stop();
    }, []);

    // ─── UI ──────────────────────────────────────────────────────────────────
    const statusColor = {
        connecting: '#f59e0b', live: '#22c55e', reconnecting: '#f97316',
        error: '#ef4444', unsupported: '#ef4444',
    }[status];

    const statusLabel = {
        connecting: '⏳ Connecting…', live: '● LIVE', reconnecting: '↺ Reconnecting…',
        error: '✕ Error', unsupported: '✕ WebCodecs not supported',
    }[status];

    return (
        <div className="player-wrapper">
            {/* Header */}
            <div className="player-header">
                <div className="cam-info">
                    <span className="cam-icon">📷</span>
                    <span className="cam-name">localhost:5554</span>
                </div>
                <div className="status-group">
                    {resolution && <span className="badge resolution">{resolution}</span>}
                    {status === 'live' && frameCount > 0 && (
                        <span className="badge frame-count">{frameCount.toLocaleString()} frames</span>
                    )}
                    <span className="badge status-badge" style={{ '--dot-color': statusColor } as React.CSSProperties}>
                        {statusLabel}
                    </span>
                </div>
            </div>

            {/* Canvas */}
            <div className="canvas-area">
                <canvas ref={canvasRef} width={1280} height={720} />

                {status !== 'live' && (
                    <div className="overlay-center">
                        {status === 'unsupported' ? (
                            <p style={{ color: statusColor }}>
                                Trình duyệt không hỗ trợ WebCodecs API.<br />
                                Vui lòng dùng Chrome / Edge / Electron.
                            </p>
                        ) : (
                            <>
                                <div className="spinner" style={{ borderTopColor: statusColor }} />
                                <p style={{ color: statusColor }}>{statusLabel}</p>
                            </>
                        )}
                    </div>
                )}

                {recordState === 'recording' && (
                    <div className="rec-indicator">
                        <span className="rec-dot" />
                        <span className="rec-text">REC {formatDuration(recordDuration)}</span>
                        {recordSize > 0 && <span className="rec-size">{formatFileSize(recordSize)}</span>}
                    </div>
                )}
            </div>

            {/* Controls */}
            <div className="control-bar">
                <div className="control-left">
                    {recordState === 'idle' && (
                        <button className="btn btn-record" onClick={startRecording}
                            disabled={status !== 'live'} title="Bắt đầu ghi video">
                            <span className="btn-icon">⏺</span> Ghi video
                        </button>
                    )}
                    {recordState === 'recording' && (
                        <button className="btn btn-stop" onClick={stopRecording} title="Dừng và lưu">
                            <span className="btn-icon">⏹</span> Dừng &amp; lưu
                        </button>
                    )}
                    {recordState === 'saving' && (
                        <button className="btn btn-saving" disabled>
                            <span className="spinner-sm" /> Đang lưu…
                        </button>
                    )}
                </div>
                <div className="control-right">
                    {lastSaved && (
                        <span className="saved-info">
                            ✓ Đã lưu: <strong>{lastSaved.name}</strong> ({formatFileSize(lastSaved.size)})
                        </span>
                    )}
                </div>
            </div>

            {/* Footer */}
            <div className="player-footer">
                <span>RTSP → WebSocket → WebCodecs VideoDecoder</span>
                <span>No FFmpeg · No third-party runtime · Electron-ready</span>
            </div>
        </div>
    );
}
