'use client';

import { useState, useCallback } from 'react';

export type ConnectionType = 'wifi' | 'ethernet' | 'onvif' | 'analog';

export interface CameraConfig {
  connectionType: ConnectionType;
  name: string;
  host: string;
  port: number;
  path: string;
  username: string;
  password: string;
  rtspUrl: string;
}

interface OnvifDevice {
  name: string;
  hostname: string;
  port: number;
  manufacturer: string;
  model: string;
}

const CONNECTION_TYPES: { value: ConnectionType; label: string; icon: string; desc: string }[] = [
  { value: 'wifi', label: 'Wi-Fi', icon: '📶', desc: 'Camera IP không dây (RTSP/HTTP)' },
  { value: 'ethernet', label: 'Ethernet', icon: '🔌', desc: 'Camera IP có dây RJ45/PoE' },
  { value: 'onvif', label: 'ONVIF', icon: '🌐', desc: 'Tự động dò tìm camera (đa hãng)' },
  { value: 'analog', label: 'Analog (BNC)', icon: '📡', desc: 'Camera analog qua capture card' },
];

const RTSP_PRESETS: { label: string; path: string }[] = [
  { label: 'Dahua / Amcrest', path: '/cam/realmonitor?channel=1&subtype=0' },
  { label: 'Hikvision', path: '/Streaming/Channels/101' },
  { label: 'Reolink', path: '/h264Preview_01_main' },
  { label: 'Generic ONVIF', path: '/stream1' },
  { label: 'RTSP Test', path: '/test' },
];

interface Props {
  onConnect: (config: CameraConfig) => void;
  isConnected: boolean;
  onDisconnect: () => void;
}

export default function CameraConnect({ onConnect, isConnected, onDisconnect }: Props) {
  const [connectionType, setConnectionType] = useState<ConnectionType>('ethernet');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('554');
  const [path, setPath] = useState('/cam/realmonitor?channel=1&subtype=0');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [rtspUrl, setRtspUrl] = useState('');
  const [useDirectUrl, setUseDirectUrl] = useState(false);
  const [cameraName, setCameraName] = useState('');

  // ONVIF state
  const [discovering, setDiscovering] = useState(false);
  const [onvifDevices, setOnvifDevices] = useState<OnvifDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<OnvifDevice | null>(null);
  const [resolvingOnvif, setResolvingOnvif] = useState(false);

  // Testing
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const [expanded, setExpanded] = useState(true);

  // ── ONVIF Discovery ──
  const discoverDevices = useCallback(async () => {
    setDiscovering(true);
    setOnvifDevices([]);
    setTestResult(null);
    try {
      const res = await fetch('/api/onvif/discover?timeout=5000');
      const data = await res.json();
      if (data.success && data.devices.length > 0) {
        setOnvifDevices(data.devices);
        setTestResult({ success: true, message: `Tim thay ${data.devices.length} camera ONVIF` });
      } else {
        setTestResult({ success: false, message: 'Khong tim thay camera ONVIF nao trong mang' });
      }
    } catch (e) {
      setTestResult({ success: false, message: 'Loi ket noi server' });
    }
    setDiscovering(false);
  }, []);

  // ── Select ONVIF Device ──
  const selectOnvifDevice = useCallback(async (device: OnvifDevice) => {
    setSelectedDevice(device);
    setHost(device.hostname);
    setPort(String(device.port));
    setCameraName(device.name || `${device.manufacturer} ${device.model}`);
    setResolvingOnvif(true);
    setTestResult(null);

    try {
      const res = await fetch('/api/onvif/stream-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostname: device.hostname,
          port: device.port,
          username,
          password,
        }),
      });
      const data = await res.json();
      if (data.success && data.rtspUrl) {
        setRtspUrl(data.rtspUrl);
        setTestResult({ success: true, message: `RTSP URL: ${data.rtspUrl}` });
      } else {
        setTestResult({ success: false, message: `Khong lay duoc RTSP URL: ${data.error || 'Unknown'}` });
      }
    } catch (e) {
      setTestResult({ success: false, message: 'Loi ket noi server khi lay RTSP URL' });
    }
    setResolvingOnvif(false);
  }, [username, password]);

  // ── Test Connection ──
  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const config = buildConfig();
    try {
      const res = await fetch('/api/camera/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setTestResult({ success: true, message: `Ket noi thanh cong! Codec: ${data.codec || 'H.264'}` });
      } else {
        setTestResult({ success: false, message: `Khong the ket noi: ${data.error}` });
      }
    } catch (e) {
      setTestResult({ success: false, message: 'Loi ket noi server' });
    }
    setTesting(false);
  }, [host, port, path, username, password, rtspUrl, useDirectUrl, connectionType]);

  // ── Build config ──
  function buildConfig(): CameraConfig {
    const name = cameraName || host || 'Camera';
    if (useDirectUrl && rtspUrl) {
      return { connectionType, name, host: '', port: 554, path: '', username, password, rtspUrl };
    }
    if (connectionType === 'onvif' && rtspUrl) {
      return { connectionType, name, host, port: parseInt(port) || 80, path: '', username, password, rtspUrl };
    }
    return {
      connectionType,
      name,
      host,
      port: parseInt(port) || 554,
      path,
      username,
      password,
      rtspUrl: useDirectUrl ? rtspUrl : '',
    };
  }

  // ── Connect ──
  const handleConnect = () => {
    const config = buildConfig();
    if (!config.rtspUrl && !config.host) {
      setTestResult({ success: false, message: 'Vui long nhap dia chi camera' });
      return;
    }
    setExpanded(false);
    onConnect(config);
  };

  const handleDisconnect = () => {
    setExpanded(true);
    onDisconnect();
  };

  // ── Render ──
  return (
    <div className="connect-panel">
      {/* Panel Header */}
      <div className="connect-header" onClick={() => !isConnected && setExpanded(!expanded)}>
        <div className="connect-title-group">
          <span className="connect-icon">🎛️</span>
          <span className="connect-title">Ket noi Camera</span>
          {isConnected && <span className="badge connect-badge-live">Da ket noi</span>}
        </div>
        {isConnected ? (
          <button className="btn btn-disconnect" onClick={handleDisconnect}>
            Ngat ket noi
          </button>
        ) : (
          <span className={`connect-chevron ${expanded ? 'open' : ''}`}>▾</span>
        )}
      </div>

      {/* Expandable body */}
      {expanded && !isConnected && (
        <div className="connect-body">
          {/* Connection Type Selector */}
          <div className="conn-type-grid">
            {CONNECTION_TYPES.map((ct) => (
              <button
                key={ct.value}
                className={`conn-type-card ${connectionType === ct.value ? 'active' : ''}`}
                onClick={() => {
                  setConnectionType(ct.value);
                  setTestResult(null);
                  // Set default port per type
                  if (ct.value === 'onvif') setPort('80');
                  else if (ct.value === 'analog') setPort('554');
                  else setPort('554');
                }}
              >
                <span className="conn-type-icon">{ct.icon}</span>
                <span className="conn-type-label">{ct.label}</span>
                <span className="conn-type-desc">{ct.desc}</span>
              </button>
            ))}
          </div>

          {/* ONVIF Discovery */}
          {connectionType === 'onvif' && (
            <div className="form-section">
              <div className="form-section-title">ONVIF Discovery</div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Username</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin" />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••" />
                </div>
                <div className="form-group" style={{ flex: 'none' }}>
                  <label>&nbsp;</label>
                  <button className="btn btn-discover" onClick={discoverDevices} disabled={discovering}>
                    {discovering ? (
                      <><span className="spinner-sm" /> Dang do tim...</>
                    ) : (
                      <>🔍 Tim camera</>
                    )}
                  </button>
                </div>
              </div>

              {/* Device List */}
              {onvifDevices.length > 0 && (
                <div className="onvif-devices">
                  {onvifDevices.map((dev, i) => (
                    <div
                      key={i}
                      className={`onvif-device ${selectedDevice === dev ? 'selected' : ''}`}
                      onClick={() => selectOnvifDevice(dev)}
                    >
                      <div className="onvif-device-name">
                        {dev.manufacturer} {dev.model || dev.name}
                      </div>
                      <div className="onvif-device-info">
                        {dev.hostname}:{dev.port}
                      </div>
                      {selectedDevice === dev && resolvingOnvif && (
                        <span className="spinner-sm" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* IP Camera Config (Wi-Fi / Ethernet) */}
          {(connectionType === 'wifi' || connectionType === 'ethernet') && (
            <div className="form-section">
              <div className="form-section-title">
                {connectionType === 'wifi' ? 'Camera IP Wi-Fi' : 'Camera IP Ethernet (RJ45/PoE)'}
              </div>

              {/* Direct URL toggle */}
              <div className="form-row">
                <label className="toggle-label">
                  <input type="checkbox" checked={useDirectUrl} onChange={(e) => setUseDirectUrl(e.target.checked)} />
                  <span>Nhap truc tiep RTSP URL</span>
                </label>
              </div>

              {useDirectUrl ? (
                <div className="form-group">
                  <label>RTSP URL</label>
                  <input type="text" value={rtspUrl} onChange={(e) => setRtspUrl(e.target.value)}
                    placeholder="rtsp://admin:password@192.168.1.100:554/stream" />
                </div>
              ) : (
                <>
                  <div className="form-row">
                    <div className="form-group" style={{ flex: 2 }}>
                      <label>Dia chi IP</label>
                      <input type="text" value={host} onChange={(e) => setHost(e.target.value)}
                        placeholder="192.168.1.100" />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Port</label>
                      <input type="number" value={port} onChange={(e) => setPort(e.target.value)}
                        placeholder="554" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Duong dan (path)</label>
                    <div className="form-row">
                      <input type="text" value={path} onChange={(e) => setPath(e.target.value)}
                        placeholder="/cam/realmonitor?channel=1&subtype=0" style={{ flex: 2 }} />
                      <select
                        className="preset-select"
                        value=""
                        onChange={(e) => { if (e.target.value) setPath(e.target.value); }}
                        style={{ flex: 1 }}
                      >
                        <option value="">-- Mau co san --</option>
                        {RTSP_PRESETS.map((p) => (
                          <option key={p.path} value={p.path}>{p.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Username</label>
                      <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                        placeholder="admin" />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Password</label>
                      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••" />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Analog Camera Config */}
          {connectionType === 'analog' && (
            <div className="form-section">
              <div className="form-section-title">Camera Analog (BNC) qua Capture Card</div>
              <div className="analog-info">
                <p>Camera analog (BNC/Coaxial) can ket noi qua:</p>
                <ul>
                  <li><strong>Capture Card USB/PCIe</strong> — Chuyen doi tin hieu analog sang digital</li>
                  <li><strong>DVR co RTSP</strong> — DVR ho tro xuat RTSP stream qua mang</li>
                  <li><strong>Video Encoder</strong> — Bo ma hoa video analog sang IP (H.264)</li>
                </ul>
                <p>Nhap dia chi RTSP cua thiet bi chuyen doi:</p>
              </div>

              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label>Dia chi IP (DVR/Encoder)</label>
                  <input type="text" value={host} onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.200" />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Port</label>
                  <input type="number" value={port} onChange={(e) => setPort(e.target.value)}
                    placeholder="554" />
                </div>
              </div>
              <div className="form-group">
                <label>Duong dan (path)</label>
                <input type="text" value={path} onChange={(e) => setPath(e.target.value)}
                  placeholder="/cam/realmonitor?channel=1&subtype=0" />
              </div>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Username</label>
                  <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin" />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••" />
                </div>
              </div>
            </div>
          )}

          {/* Camera Name (optional) */}
          <div className="form-group">
            <label>Ten camera (tuy chon)</label>
            <input type="text" value={cameraName} onChange={(e) => setCameraName(e.target.value)}
              placeholder="VD: San truoc, Kho hang..." />
          </div>

          {/* Test Result */}
          {testResult && (
            <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
              {testResult.success ? '✓' : '✕'} {testResult.message}
            </div>
          )}

          {/* Action Buttons */}
          <div className="connect-actions">
            <button className="btn btn-test" onClick={testConnection} disabled={testing}>
              {testing ? (
                <><span className="spinner-sm" /> Dang thu...</>
              ) : (
                <>🔗 Thu ket noi</>
              )}
            </button>
            <button className="btn btn-connect" onClick={handleConnect}>
              ▶ Ket noi & Xem
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
