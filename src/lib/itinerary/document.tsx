/**
 * The itinerary as a PDF.
 *
 * Rendered on the server, never in the browser, and that is the decision this
 * file is built around. A PDF assembled in the browser has to fetch its own
 * images through the browser's CORS rules, which the photo hosts do not grant —
 * so the pictures would be missing on exactly the document a person downloads
 * and shows somebody. Built here, the bytes are already in hand (`verify.ts`
 * embeds every photo as a data URI) and the file is self-contained: it renders
 * the same on a plane with no wifi as it does on the laptop that made it.
 *
 * The look follows `docs/DESIGN.md` as far as paper allows. Hard 3px rules, no
 * rounded corners, the parchment and ink palette. What does not survive is the
 * pixel typeface: Press Start 2P has no lowercase worth reading at 9pt and a
 * document is a thing people read, so the display face is used only for the
 * micro-labels it was specified for, and Helvetica carries the sentences.
 *
 * Server-only. This module is a React tree, but it is never mounted in a DOM.
 */

import {
  Document,
  Image,
  Link,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";
import type { Itinerary, ItineraryDay, ItineraryItem } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Palette, lifted from globals.css                                            */
/* -------------------------------------------------------------------------- */

const INK = "#2B1E14";
const PARCHMENT = "#F4E9D0";
const CARD = "#FFF9EC";
const BARK = "#7A5A3A";
const RUST = "#B8432B";
const LEAF = "#3D7A34";
const GOLD = "#F2B84B";
const TRACK = "#E5D6B4";

function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: PARCHMENT,
    color: INK,
    paddingTop: 34,
    paddingBottom: 46,
    paddingHorizontal: 38,
    fontFamily: "Helvetica",
    fontSize: 10,
  },

  /* Cover ------------------------------------------------------------------ */
  bar: {
    backgroundColor: INK,
    color: PARCHMENT,
    paddingVertical: 9,
    paddingHorizontal: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  barMark: { fontSize: 9, letterSpacing: 1.4, color: GOLD, fontFamily: "Courier-Bold" },
  barTrip: { fontSize: 9, letterSpacing: 1.1, color: PARCHMENT, fontFamily: "Courier" },

  title: { fontSize: 34, fontFamily: "Helvetica-Bold", marginTop: 22 },
  region: { fontSize: 13, color: BARK, marginTop: 4, fontFamily: "Helvetica-Bold" },
  headline: { fontSize: 11, marginTop: 12, lineHeight: 1.5, maxWidth: 400 },

  /* Shared panel ----------------------------------------------------------- */
  panel: { borderWidth: 3, borderColor: INK, backgroundColor: CARD, padding: 12 },
  label: {
    fontSize: 7,
    letterSpacing: 1.3,
    color: BARK,
    fontFamily: "Courier-Bold",
    marginBottom: 6,
  },

  /* The money strip -------------------------------------------------------- */
  totals: { flexDirection: "row", gap: 10, marginTop: 18 },
  totalBox: {
    flex: 1,
    borderWidth: 3,
    borderColor: INK,
    backgroundColor: CARD,
    paddingVertical: 10,
    paddingHorizontal: 11,
  },
  totalFigure: { fontSize: 21, fontFamily: "Helvetica-Bold", marginTop: 3 },

  /* Booking rows ----------------------------------------------------------- */
  bookingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: TRACK,
    paddingTop: 8,
    marginTop: 8,
  },

  /* Days ------------------------------------------------------------------- */
  dayHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: INK,
    color: PARCHMENT,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  dayNumber: { fontSize: 9, letterSpacing: 1.2, color: GOLD, fontFamily: "Courier-Bold" },
  dayTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", color: PARCHMENT, marginLeft: 10 },
  dayCost: { fontSize: 10, color: PARCHMENT, marginLeft: "auto", fontFamily: "Helvetica-Bold" },

  photo: { width: "100%", height: 132, objectFit: "cover" },
  photoBlank: { width: "100%", height: 46, backgroundColor: TRACK },
  credit: { fontSize: 6, color: BARK, paddingTop: 3, paddingHorizontal: 2 },

  itemRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: TRACK,
    paddingVertical: 7,
  },
  itemTime: { width: 62, fontSize: 8, color: BARK, fontFamily: "Courier-Bold", paddingTop: 1 },
  itemBody: { flex: 1, paddingRight: 8 },
  itemTitle: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },
  itemDetail: { fontSize: 9, color: BARK, marginTop: 2, lineHeight: 1.4 },
  itemLink: { fontSize: 8, color: RUST, marginTop: 3, textDecoration: "underline" },
  itemCost: { width: 54, fontSize: 10, fontFamily: "Helvetica-Bold", textAlign: "right" },
  itemFree: { width: 54, fontSize: 8, color: LEAF, textAlign: "right", paddingTop: 2 },

  /* Footer ----------------------------------------------------------------- */
  footer: {
    position: "absolute",
    bottom: 20,
    left: 38,
    right: 38,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 3,
    borderTopColor: INK,
    paddingTop: 6,
  },
  footerText: { fontSize: 7, color: BARK, letterSpacing: 0.8, fontFamily: "Courier" },
});

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row of a day.
 *
 * The link prints its host rather than its URL. A booking URL is ninety
 * characters of tracking parameters and would wrap over three lines; the host
 * is the part a person actually checks, and the whole thing is still clickable.
 */
function Row({ item }: { item: ItineraryItem }) {
  return (
    <View style={styles.itemRow} wrap={false}>
      <Text style={styles.itemTime}>{item.time.toUpperCase()}</Text>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle}>{item.title}</Text>
        <Text style={styles.itemDetail}>{item.detail}</Text>
        {item.link ? (
          <Link src={item.link.url} style={styles.itemLink}>
            {item.link.label} · {item.link.host}
          </Link>
        ) : null}
      </View>
      {item.costPerPerson === null ? (
        <Text style={styles.itemFree}>free</Text>
      ) : (
        <Text style={styles.itemCost}>{money(item.costPerPerson)}</Text>
      )}
    </View>
  );
}

function Day({ day }: { day: ItineraryDay }) {
  return (
    <View style={{ marginTop: 16 }} break={day.day > 1 && day.day % 2 === 1}>
      <View style={styles.dayHeader}>
        <Text style={styles.dayNumber}>DAY {day.day}</Text>
        <Text style={styles.dayTitle}>{day.title}</Text>
        <Text style={styles.dayCost}>
          {day.subtotalPerPerson > 0 ? `${money(day.subtotalPerPerson)} pp` : "nothing to pay"}
        </Text>
      </View>

      <View style={{ borderWidth: 3, borderTopWidth: 0, borderColor: INK, backgroundColor: CARD }}>
        {day.photo ? (
          <View>
            {/* A data URI, embedded by `verify.ts`. Nothing here fetches.
                This `Image` is a PDF primitive, not an `img`: it has no alt
                prop to take, and the caption below it carries the description
                into the document's text layer. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={day.photo.dataUri} style={styles.photo} />
            <Text style={styles.credit}>{day.photo.credit}</Text>
          </View>
        ) : (
          <View style={styles.photoBlank} />
        )}

        <View style={{ paddingHorizontal: 10, paddingBottom: 6 }}>
          <Text style={[styles.label, { marginTop: 8 }]}>{day.date.toUpperCase()}</Text>
          {day.items.map((item, i) => (
            <Row key={`${day.day}-${i}`} item={item} />
          ))}
        </View>
      </View>
    </View>
  );
}

function Booking({ label, item }: { label: string; item: ItineraryItem }) {
  return (
    <View style={styles.bookingRow} wrap={false}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.itemTitle}>{item.title}</Text>
        <Text style={styles.itemDetail}>{item.detail}</Text>
        {item.link ? (
          <Link src={item.link.url} style={styles.itemLink}>
            {item.link.label} · {item.link.host}
          </Link>
        ) : (
          <Text style={[styles.itemDetail, { color: RUST }]}>
            No live link for this one — search it when you book.
          </Text>
        )}
      </View>
      <Text style={styles.itemCost}>
        {item.costPerPerson === null ? "—" : money(item.costPerPerson)}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export function ItineraryDocument({
  itinerary,
  tripName,
}: {
  itinerary: Itinerary;
  tripName: string;
}) {
  const built = new Date(itinerary.builtAt);

  return (
    <Document
      title={`${itinerary.destination} — ${tripName}`}
      author="twocents.ai"
      subject={itinerary.headline}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.bar} fixed={false}>
          <Text style={styles.barMark}>TWOCENTS.AI</Text>
          <Text style={styles.barTrip}>{tripName.toUpperCase()}</Text>
        </View>

        <Text style={styles.title}>{itinerary.destination}</Text>
        <Text style={styles.region}>
          {itinerary.region} · {itinerary.dates} · {itinerary.nights} nights
        </Text>
        <Text style={styles.headline}>{itinerary.headline}</Text>

        <View style={styles.totals}>
          <View style={styles.totalBox}>
            <Text style={styles.label}>EACH OF YOU</Text>
            <Text style={styles.totalFigure}>{money(itinerary.perPerson)}</Text>
          </View>
          <View style={styles.totalBox}>
            <Text style={styles.label}>ALL FOUR</Text>
            <Text style={styles.totalFigure}>{money(itinerary.groupTotal)}</Text>
          </View>
          <View style={styles.totalBox}>
            <Text style={styles.label}>APPROVED BY</Text>
            <Text style={styles.totalFigure}>4 of 4</Text>
          </View>
        </View>

        <View style={[styles.panel, { marginTop: 16 }]}>
          <Text style={[styles.label, { marginBottom: 0 }]}>THE TWO BIG BOOKINGS</Text>
          <Booking label="FLIGHTS" item={itinerary.flights} />
          <Booking label="WHERE YOU STAY" item={itinerary.lodging} />
        </View>

        {itinerary.days.map((day) => (
          <Day key={day.day} day={day} />
        ))}

        {itinerary.sources.length > 0 ? (
          <View style={[styles.panel, { marginTop: 18 }]} wrap={false}>
            <Text style={styles.label}>EVERY SOURCE THIS WAS BUILT FROM</Text>
            <Text style={{ fontSize: 8.5, color: BARK, lineHeight: 1.5 }}>
              {itinerary.sources.join(" · ")}
            </Text>
          </View>
        ) : null}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {itinerary.live ? "BUILT FROM LIVE SEARCH" : "BUILT OFFLINE · LINKS ARE SEARCHES"} ·{" "}
            {/* The times are the part of this document somebody stands in
                front of a door for, so the footer says whether they were
                checked rather than leaving it implied. */}
            {itinerary.checks
              ? `${itinerary.checks.itemsChecked} TIMES CHECKED AGAINST POSTED HOURS · `
              : ""}
            {built.toLocaleDateString("en-US")}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
