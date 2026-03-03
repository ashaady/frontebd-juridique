import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

const hasClerkKeys = Boolean(
  process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
);

function isNextDataRequest(request: NextRequest): boolean {
  const urlPath = new URL(request.url).pathname;
  const isDataPath = /^\/_next\/data\/[^/]+\/.+\.json$/.test(urlPath);
  const isDataHeader = request.headers.get("x-nextjs-data") === "1";
  return isDataPath || isDataHeader;
}

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (isNextDataRequest(request)) {
    return NextResponse.next();
  }
  if (!hasClerkKeys) {
    return NextResponse.next();
  }
  const withClerkContextMiddleware = clerkMiddleware();
  return withClerkContextMiddleware(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
