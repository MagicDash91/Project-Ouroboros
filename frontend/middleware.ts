import { NextResponse, type NextRequest } from "next/server";

// The workspace needs an account: without a session cookie, /app goes to the log-in page first.
// (The cookie is only checked for presence here; the backend validates it on every API call.)
export function middleware(req: NextRequest) {
  if (!req.cookies.get("ouro_session")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/app", "/app/:path*"] };
