import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Camera Viewer — Multi-Protocol',
  description: 'Live camera stream — Wi-Fi, Ethernet, Analog (BNC), ONVIF — no FFmpeg',
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
