'use client';

import { useState, useCallback } from 'react';
import CameraConnect, { type CameraConfig } from './components/CameraConnect';
import RTSPPlayer from './components/RTSPPlayer';
export default function Home() {
  const [cameraConfig, setCameraConfig] = useState<CameraConfig | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const handleConnect = useCallback((config: CameraConfig) => {
    setCameraConfig(config);
    setIsConnected(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setCameraConfig(null);
    setIsConnected(false);
  }, []);

  return (
    <main className="main">
      <div className="page-header">
        <h1 className="page-title">
          <span className="title-icon">🎥</span> Camera Viewer
        </h1>
        <p className="page-sub">Wi-Fi · Ethernet (PoE) · Analog (BNC) · ONVIF · No FFmpeg</p>
      </div>
      <CameraConnect
        onConnect={handleConnect}
        isConnected={isConnected}
        onDisconnect={handleDisconnect}
      />
      <RTSPPlayer config={cameraConfig} onDisconnected={handleDisconnect} />
    </main>
  );
}
