/**
 * The PDF itself, as a URL.
 *
 * A URL rather than a Blob built in the browser, for two reasons that both
 * decide the same way. The photos are already bytes on this side (`verify.ts`
 * embedded them), so rendering here needs no network at all, where the browser
 * would need CORS grants the photo hosts do not give. And a plain URL is the
 * one thing every PDF viewer in the world can open: the page points an iframe
 * at it, the download button points an anchor at it, and Safari, Chrome and a
 * judge's phone all handle it without a viewer library between them.
 *
 * `?download=1` is the only difference between viewing and saving, and it is
 * one header.
 */

import { renderToBuffer } from "@react-pdf/renderer";
import { ItineraryDocument } from "@/lib/itinerary/document";
import { DEFAULT_SESSION_ID, getOrCreateDefault, getSession } from "@/lib/session";
import type { DemoSession } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sessionFor(id: string): DemoSession | undefined {
  return id === DEFAULT_SESSION_ID ? getOrCreateDefault() : getSession(id);
}

/** `puerto-rico-itinerary.pdf`. What lands in someone's Downloads folder. */
function fileName(destination: string): string {
  const slug =
    destination
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "trip";
  return `${slug}-itinerary.pdf`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId") ?? DEFAULT_SESSION_ID;
  const wantsDownload = url.searchParams.get("download") === "1";

  const session = sessionFor(sessionId);
  if (!session) {
    return Response.json({ error: "unknown session", sessionId }, { status: 404 });
  }

  // Never built here: building is a POST to `/api/itinerary`, which is the one
  // place that checks the four approvals. A GET that could build would be a way
  // around that check.
  const itinerary = session.itinerary;
  if (!itinerary) {
    return Response.json({ error: "no itinerary yet", sessionId }, { status: 404 });
  }

  const buffer = await renderToBuffer(
    <ItineraryDocument itinerary={itinerary} tripName={session.tripName} />,
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `${wantsDownload ? "attachment" : "inline"}; filename="${fileName(itinerary.destination)}"`,
      // The document is a function of a session that can be reset between
      // judges, so it must never come out of a cache.
      "Cache-Control": "no-store",
    },
  });
}
