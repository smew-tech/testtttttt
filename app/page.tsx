import type { Metadata } from 'next';
import RTSPPlayer from './components/RTSPPlayer';
import './globals.css';

export const metadata: Metadata = {
  title: 'RTSP Camera Viewer',
  description: 'Live RTSP camera stream in the browser — no FFmpeg',
};

export default function Home() {
  return (
    <main className="main">
      <div className="page-header">
        <h1 className="page-title">
          <span className="title-icon">🎥</span> RTSP Camera Viewer
        </h1>
        <p className="page-sub">Live stream · No FFmpeg · Broadway H.264</p>
      </div>
      <RTSPPlayer />
    </main>
  );
}
