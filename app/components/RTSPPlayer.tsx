'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { CameraConfig, ConnectionType } from './CameraConnect';

type Status = 'connecting' | 'live' | 'reconnecting' | 'error' | 'unsupported' | 'idle';
type RecordState = 'idle' | 'recording' | 'saving';

const WS_URL = 'ws://localhost:8765';

const CONNECTION_LABELS: Record<ConnectionType, string> = {
    wifi: 'Wi-Fi',
    ethernet: 'Ethernet',
    onvif: 'ONVIF',
    analog: 'Analog',
};

const CONNECTION_ICONS: Record<ConnectionType, string> = {
    wifi: '📶',
    ethernet: '🔌',
    onvif: '🌐',
    analog: '📡',
};

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

interface Props {
    config: CameraConfig | null;
    onDisconnected?: () => void;
}

export default function RTSPPlayer({ config, onDisconnected }: Props) {
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

    const [status, setStatus] = useState<Status>('idle');
    const [frameCount, setFrameCount] = useState(0);
    const [resolution, setResolution] = useState('');
    const [recordState, setRecordState] = useState<RecordState>('idle');
    const [recordDuration, setRecordDuration] = useState(0);
    const [recordSize, setRecordSize] = useState(0);
    const [lastSaved, setLastSaved] = useState<{ name: string; size: number } | null>(null);
    const [errorMsg, setErrorMsg] = useState('');

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
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                    setResolution(`${frame.displayWidth}×${frame.displayHeight}`);
                }
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                frame.close();
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
        } catch (e) {
            console.error('[VideoDecoder] configure failed:', e);
            try {
                decoderRef.current.configure({ codec: 'avc1.42001f', optimizeForLatency: true });
                configuredRef.current = true;
            } catch (e2) {
                console.error('[VideoDecoder] fallback configure also failed:', e2);
            }
        }
    }, []);

    // Buffer SPS/PPS
    const spsRef = useRef<Uint8Array | null>(null);
    const ppsRef = useRef<Uint8Array | null>(null);

    const handleFrame = useCallback((data: ArrayBuffer) => {
        const buf = new Uint8Array(data);
        if (buf.length < 6) return;

        const nalData = buf.slice(1);
        const nalType = nalData[4] & 0x1f;

        if (nalType === 7) { spsRef.current = nalData; return; }
        if (nalType === 8) { ppsRef.current = nalData; return; }

        if (!decoderRef.current || !configuredRef.current) return;
        if (decoderRef.current.state === 'closed') return;

        try {
            if (nalType === 5 && spsRef.current && ppsRef.current) {
                const combined = new Uint8Array(spsRef.current.length + ppsRef.current.length + nalData.length);
                combined.set(spsRef.current, 0);
                combined.set(ppsRef.current, spsRef.current.length);
                combined.set(nalData, spsRef.current.length + ppsRef.current.length);
                decoderRef.current.decode(new EncodedVideoChunk({
                    type: 'key',
                    timestamp: performance.now() * 1000,
                    data: combined,
                }));
                return;
            }

            decoderRef.current.decode(new EncodedVideoChunk({
                type: nalType === 5 ? 'key' : 'delta',
                timestamp: performance.now() * 1000,
                data: nalData,
            }));
        } catch (e) {
            // ignore stale frames
        }
    }, []);

    // ─── WebSocket connect (sends camera config to server) ───────────────────
    const connectWS = useCallback(() => {
        if (!config) return;

        if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
        configuredRef.current = false;
        spsRef.current = null;
        ppsRef.current = null;
        setStatus('connecting');
        setFrameCount(0);
        setResolution('');
        setErrorMsg('');
        createDecoder();

        const ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
            // Send camera config to server
            ws.send(JSON.stringify({ type: 'connect', config }));
        };

        ws.onmessage = (evt) => {
            if (typeof evt.data === 'string') {
                try {
                    const msg = JSON.parse(evt.data as string);
                    if (msg.type === 'config') {
                        codecRef.current = msg.codec;
                        createDecoder();
                        configureDecoder(msg.codec);
                    } else if (msg.type === 'status') {
                        if (msg.status === 'reconnecting') {
                            configuredRef.current = false;
                            setStatus('reconnecting');
                        } else if (msg.status === 'disconnected') {
                            setStatus('idle');
                        }
                    } else if (msg.type === 'error') {
                        setErrorMsg(msg.error || 'Loi ket noi');
                        setStatus('error');
                    }
                } catch (_) { }
                return;
            }
            handleFrame(evt.data as ArrayBuffer);
        };

        ws.onerror = () => setStatus('error');
        ws.onclose = () => {
            if (config) {
                setStatus('reconnecting');
                reconnTimer.current = setTimeout(connectWS, 3000);
            }
        };
    }, [config, createDecoder, configureDecoder, handleFrame]);

    // ─── Disconnect ──────────────────────────────────────────────────────────
    const disconnect = useCallback(() => {
        if (wsRef.current) {
            try {
                wsRef.current.send(JSON.stringify({ type: 'disconnect' }));
            } catch (_) { }
            wsRef.current.onclose = null;
            wsRef.current.close();
            wsRef.current = null;
        }
        if (reconnTimer.current) clearTimeout(reconnTimer.current);
        if (decoderRef.current && decoderRef.current.state !== 'closed') {
            try { decoderRef.current.close(); } catch (_) { }
        }
        setStatus('idle');
        setFrameCount(0);
        setResolution('');
        setErrorMsg('');
        configuredRef.current = false;
    }, []);

    useEffect(() => {
        if (!isSupported) { setStatus('unsupported'); return; }
        if (!config) { disconnect(); return; }
        connectWS();
        return () => {
            if (reconnTimer.current) clearTimeout(reconnTimer.current);
            if (wsRef.current) { wsRef.current.onclose = null; wsRef.current.close(); }
            if (decoderRef.current && decoderRef.current.state !== 'closed') {
                try { decoderRef.current.close(); } catch (_) { }
            }
        };
    }, [config, connectWS, isSupported, disconnect]);

    // ─── Recording ──────────────────────────────────────────────────────────
    const startRecording = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const mime = [
            'video/mp4;codecs=h264', 'video/mp4;codecs=avc1', 'video/mp4',
            'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm',
        ].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';

        const stream = canvas.captureStream(0);
        const videoTracks = stream.getVideoTracks();
        if (!videoTracks.length) return;
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
            const camName = (config?.name || 'camera').replace(/[^a-zA-Z0-9]/g, '_');
            const fname = `${camName}_${ts}.${ext}`;
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
    }, [config]);

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
        idle: '#52525b', connecting: '#f59e0b', live: '#22c55e', reconnecting: '#f97316',
        error: '#ef4444', unsupported: '#ef4444',
    }[status];

    const statusLabel = {
        idle: 'Chua ket noi', connecting: 'Dang ket noi...', live: 'LIVE',
        reconnecting: 'Dang ket noi lai...', error: 'Loi', unsupported: 'WebCodecs khong ho tro',
    }[status];

    const connType = config?.connectionType;
    const connIcon = connType ? CONNECTION_ICONS[connType] : '';
    const connLabel = connType ? CONNECTION_LABELS[connType] : '';

    return (
        <div className="player-wrapper">
            {/* Header */}
            <div className="player-header">
                <div className="cam-info">
                    <span className="cam-icon">📷</span>
                    <span className="cam-name">{config?.name || 'Camera'}</span>
                    {connType && (
                        <span className="badge conn-type-badge">
                            {connIcon} {connLabel}
                        </span>
                    )}
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

                {status === 'idle' && (
                    <div className="overlay-center">
                        <div className="idle-message">
                            <span className="idle-icon">🎛️</span>
                            <p>Chon loai ket noi va cau hinh camera o phia tren</p>
                        </div>
                    </div>
                )}

                {(status === 'connecting' || status === 'reconnecting') && (
                    <div className="overlay-center">
                        <div className="spinner" style={{ borderTopColor: statusColor }} />
                        <p style={{ color: statusColor }}>{statusLabel}</p>
                    </div>
                )}

                {status === 'error' && (
                    <div className="overlay-center">
                        <p style={{ color: statusColor }}>
                            {errorMsg || 'Khong the ket noi camera'}
                        </p>
                    </div>
                )}

                {status === 'unsupported' && (
                    <div className="overlay-center">
                        <p style={{ color: statusColor }}>
                            Trinh duyet khong ho tro WebCodecs API.<br />
                            Vui long dung Chrome / Edge / Electron.
                        </p>
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
                            disabled={status !== 'live'} title="Bat dau ghi video">
                            <span className="btn-icon">⏺</span> Ghi video
                        </button>
                    )}
                    {recordState === 'recording' && (
                        <button className="btn btn-stop" onClick={stopRecording} title="Dung va luu">
                            <span className="btn-icon">⏹</span> Dung &amp; luu
                        </button>
                    )}
                    {recordState === 'saving' && (
                        <button className="btn btn-saving" disabled>
                            <span className="spinner-sm" /> Dang luu...
                        </button>
                    )}
                </div>
                <div className="control-right">
                    {lastSaved && (
                        <span className="saved-info">
                            ✓ Da luu: <strong>{lastSaved.name}</strong> ({formatFileSize(lastSaved.size)})
                        </span>
                    )}
                </div>
            </div>

            {/* Footer */}
            <div className="player-footer">
                <span>
                    {connType ? `${connIcon} ${connLabel}` : 'Camera'} → RTSP → WebSocket → WebCodecs
                </span>
                <span>No FFmpeg · Multi-protocol · Electron-ready</span>
            </div>
        </div>
    );
}
