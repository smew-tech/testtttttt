import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RTSP Camera Viewer',
  description: 'Live RTSP camera stream in browser — no FFmpeg',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
