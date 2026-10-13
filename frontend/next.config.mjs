// The FastAPI backend (main.py) serves the API on :8002. Requests to /api and /outputs are
// proxied so charts, reports and posters keep their relative URLs. The live log stream is
// opened directly against the backend (see lib/api.ts) because proxies can buffer SSE.
const BACKEND = process.env.BACKEND_URL || "http://localhost:8002";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // LLM-backed endpoints (chat, drivers, NL→SQL, document Q&A) often take longer than
  // the proxy's 30 s default, which surfaces as a bare 500.
  experimental: { proxyTimeout: 300_000 },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND}/api/:path*` },
      { source: "/outputs/:path*", destination: `${BACKEND}/outputs/:path*` },
    ];
  },
};

export default nextConfig;
