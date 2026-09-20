/**
 * The gate between what a model claimed and what goes in the document.
 *
 * Two jobs, both of them the same job: nothing reaches the PDF that has not
 * been fetched and found to exist.
 *
 * - **Links.** A model asked for a booking URL will sometimes produce one that
 *   is shaped exactly right and returns a 404, and the person who finds that
 *   out is the one who clicks it at the table. So every URL is requested before
 *   it is printed, and a link that does not answer is dropped rather than
 *   shown. The document says less and lies none.
 * - **Photos.** A remote image that 404s during PDF generation fails the whole
 *   render, which would turn one bad URL into a blank page. So photos are
 *   fetched here, checked for being actual JPEG or PNG bytes, and embedded as
 *   data URIs — which also makes the finished PDF self-contained, so it still
 *   shows its pictures on a laptop with no wifi.
 *
 * Every function here is best-effort by construction: the failure of any one
 * asset costs that asset and nothing else.
 *
 * Server-only. No React, no DOM.
 */

import type { ItineraryDay, ItineraryLink } from "@/lib/types";

/** Nothing here is worth stalling the page for. */
const FETCH_TIMEOUT_MS = 6000;

/** Beyond this a photo is costing more than it is adding. */
const MAX_PHOTO_BYTES = 2_000_000;

/** The two formats `@react-pdf/renderer` can actually draw. */
const DRAWABLE = new Set(["image/jpeg", "image/png"]);

/** A browser-shaped identity. Commons and most booking sites refuse a bare bot. */
const USER_AGENT =
  "twocents.ai/0.1 (hackathon demo; contact: hello@twocents.invalid)";

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** `https://www.expedia.com/x` -> `expedia.com`. Null when it is not a URL at all. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Whether this URL answers.
 *
 * HEAD first because it is cheap, then GET, because a surprising number of
 * booking sites answer HEAD with a 405 while serving the page perfectly well —
 * and rejecting a real link for that would defeat the point. Anything that
 * answers at all, including a redirect, counts: this is checking that a page
 * exists, not auditing it.
 */
async function resolves(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        headers: { "user-agent": USER_AGENT },
        signal,
      });
      if (res.ok) return true;
      // 405 means "not this verb", which is a live server. Anything else is a no.
      if (res.status !== 405 && method === "GET") return false;
    } catch {
      // Network error or timeout. Fall through to the next verb, then give up.
    } finally {
      done();
    }
  }
  return false;
}

/**
 * Turns a claimed URL into a link, or into nothing.
 *
 * `label` is what the document prints when there is no better name; the host is
 * what it prints underneath, because that is the part a person reads before
 * deciding whether to trust the click.
 */
export async function verifyLink(
  url: string | null,
  label: string,
): Promise<ItineraryLink | null> {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  if (!(await resolves(url))) return null;
  return { label, url, host };
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                      */
/* -------------------------------------------------------------------------- */

interface CommonsHit {
  thumbUrl: string;
  pageUrl: string;
  title: string;
}

/**
 * Asks Wikimedia Commons for a photograph of a place.
 *
 * Commons rather than an image search engine, for three reasons that all point
 * the same way: it needs no key, everything on it is licensed for reuse, and it
 * serves hotlinked thumbnails without objecting — which the major image search
 * engines do not, and a document full of hotlink-blocked boxes is worse than
 * one with no pictures. The photos are real photographs of the real place,
 * which is the property that actually matters here.
 */
async function searchCommons(query: string): Promise<CommonsHit | null> {
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  // Namespace 6 is File:. Without it the search returns talk pages.
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrlimit", "3");
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|mime");
  api.searchParams.set("iiurlwidth", "1000");

  const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(api, { headers: { "user-agent": USER_AGENT }, signal });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      query?: { pages?: Record<string, {
        title?: string;
        imageinfo?: { thumburl?: string; descriptionurl?: string; mime?: string }[];
      }> };
    };

    for (const page of Object.values(body.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl || !info.mime || !DRAWABLE.has(info.mime)) continue;
      return {
        thumbUrl: info.thumburl,
        pageUrl: info.descriptionurl ?? "https://commons.wikimedia.org",
        title: (page.title ?? "").replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    done();
  }
}

/** Downloads the bytes and proves they are an image before anyone draws them. */
async function fetchAsDataUri(url: string): Promise<string | null> {
  const { signal, done } = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal });
    if (!res.ok) return null;

    const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!DRAWABLE.has(mime)) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return null;

    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  } finally {
    done();
  }
}

/**
 * One day's photograph, fetched and embedded, or null.
 *
 * Null is a supported outcome all the way to the page: the PDF draws a plain
 * coloured band in its place, which looks deliberate, where a broken image box
 * would look like the thing it is.
 */
export async function fetchDayPhoto(query: string): Promise<ItineraryDay["photo"]> {
  const hit = await searchCommons(query);
  if (!hit) return null;

  const dataUri = await fetchAsDataUri(hit.thumbUrl);
  if (!dataUri) return null;

  return {
    dataUri,
    creditUrl: hit.pageUrl,
    credit: `${hit.title} · Wikimedia Commons`,
  };
}
