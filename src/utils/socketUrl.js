// src/utils/socketUrl.js
// Returns the actual backend URL for Socket.io connections.
// Socket.io cannot go through the Vercel /api rewrite proxy the way
// regular HTTP requests do, so it needs the real backend hostname.
export function getSocketUrl() {
  const envUrl = import.meta.env.VITE_SOCKET_URL;
  if (envUrl) return envUrl;
  if (window.location.hostname === 'localhost') return 'http://localhost:5000';
  // Fallback — update this if you switch Render services
  return 'https://smartdine-annv.onrender.com';
}