/**
 * The itinerary the demo falls back to.
 *
 * Same parachute as `lib/llm/offline.ts`, and reached through it: the offline
 * provider answers an `itinerary` call with this, so a run with no key takes the
 * ordinary code path rather than a special case. What it produces is shaped by
 * the destination the room actually agreed on, rather than a hard-coded trip to
 * Puerto Rico that would contradict the plan on the screen behind it.
 *
 * The links it emits are search URLs, not pretend bookings. That is the honest
 * version of "we could not reach the web": a live build names the hotel, this
 * one hands you the search that finds it. Both are real pages, and the second
 * does not claim to be the first.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import { earliestDepartureIn, minutesOf } from "@/lib/itinerary/availability";
import type { ItineraryDraft } from "@/lib/itinerary/prompt";
import type { Offer } from "@/lib/types";

/** The little about a trip that the canned days need to be true of it. */
export interface CannedTrip {
  destination: string;
  region: string;
  nights: number;
  perPerson: number;
  flightNote: string;
  lodgingNote: string;
}

/** Roughly how a trip's spend splits once flights and the bed are paid for. */
const DAY_SHARE = 0.22;

/** The default departure: late enough that nobody sets an alarm. */
const DEFAULT_DEPARTURE = "10:30";

/** How long the flight is assumed to be, for the arrival the check reads. */
const FLIGHT_HOURS = 3.5;

/**
 * A departure that keeps whatever promise the plan made about flight times.
 *
 * The canned draft is checked by exactly the same `checkAvailability` the live
 * one is, so a fixed 10:30 under a plan that promised "nothing before 11" is a
 * self-inflicted failure. Reading the promise out of the flight note costs one
 * regex and means the offline document arrives already true.
 */
function departureFor(flightNote: string): string {
  const floor = earliestDepartureIn([flightNote]);
  const base = minutesOf(DEFAULT_DEPARTURE) ?? 630;
  if (floor === null || floor <= base) return DEFAULT_DEPARTURE;
  // Half an hour past the floor, so the promise is kept with room to spare.
  const minutes = Math.min(floor + 30, 22 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `"10:30"` plus minutes, as `"14:00"`, never past the end of the day. */
function addMinutes(time: string, minutes: number): string {
  const total = Math.min((minutesOf(time) ?? 630) + minutes, 23 * 60 + 30);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** When the plane is down, given when it left. */
function arrivalAfter(departure: string): string {
  return addMinutes(departure, Math.round(FLIGHT_HOURS * 60));
}

export function tripFromOffer(offer: Offer): CannedTrip {
  return {
    destination: offer.destination,
    region: offer.region,
    nights: offer.nights,
    perPerson: offer.perPerson,
    flightNote: offer.flightNote,
    lodgingNote: offer.lodgingNote,
  };
}

function flightSearch(destination: string): string {
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(`flights to ${destination}`)}`;
}

function staySearch(destination: string): string {
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(destination)}`;
}

function thingsToDo(destination: string): string {
  return `https://www.tripadvisor.com/Search?q=${encodeURIComponent(destination)}`;
}

function eatSearch(destination: string, meal: string): string {
  return `https://www.tripadvisor.com/Search?q=${encodeURIComponent(`${meal} ${destination}`)}`;
}

/**
 * The hours fields, filled in the only honest way an offline draft can fill
 * them: empty.
 *
 * Nothing here was searched, so there are no posted hours to state. Empty reads
 * as "unknown" to `checkAvailability`, which then declines to judge the item
 * rather than passing it — the offline document still gets real clock times, it
 * just never claims a place is open at one.
 */
function unchecked(startsAt: string) {
  return { startsAt, opensAt: "", closesAt: "", closedDays: [] as string[] };
}

/**
 * A full draft for this trip's destination and length.
 *
 * Deliberately generic in its wording — "the old town", "the water" — because
 * it has to read as true of anywhere the four of them might have agreed on, and
 * a canned day that names a street the destination does not have is worse than
 * one that names nothing.
 */
export function cannedItinerary(trip: CannedTrip): ItineraryDraft {
  const place = trip.destination;
  const totalDays = Math.max(2, trip.nights + 1);

  // A third to flights, a third to beds, the rest across the days.
  const flightCost = Math.round(trip.perPerson * 0.34);
  const lodgingCost = Math.round(trip.perPerson * 0.33);

  // What is left after the flight and the bed, divided by how much of a day
  // each row is worth. Scaled rather than guessed, because `build.ts` sums the
  // surviving rows and prints that total: a canned draft that ignores the
  // agreed price produces a document contradicting the plan on the screen
  // behind it, which is the one thing the offline path must not do.
  const dayBudget = Math.max(0, trip.perPerson - flightCost - lodgingCost);
  let weights = 0;
  for (let day = 1; day <= totalDays; day += 1) {
    if (day === 1) weights += 1 / 2;
    else if (day === totalDays) weights += 1 / 3;
    else weights += (day % 2 === 0 ? 1 : 0) + 1 / 3 + 1 / 2;
  }
  const perDay = Math.max(9, Math.round(weights > 0 ? dayBudget / weights : DAY_SHARE * 100));

  const departure = departureFor(trip.flightNote);

  const days = Array.from({ length: totalDays }, (_, index) => {
    const day = index + 1;

    if (day === 1) {
      return {
        day,
        date: `Day ${day}`,
        title: `Land in ${place}`,
        photoQuery: place,
        items: [
          {
            time: "Afternoon",
            title: "Arrive and drop bags",
            detail: `Get to the place you're staying in ${place} and put everything down.`,
            costPerPerson: null,
            url: null,
            // An hour after the plane is down, which is the earliest anybody is
            // realistically standing in front of the place they are staying.
            ...unchecked(addMinutes(arrivalAfter(departure), 60)),
          },
          {
            time: "Evening",
            title: "First dinner out",
            detail: "Somewhere walkable. Nobody wants a journey on the first night.",
            costPerPerson: Math.round(perDay / 2),
            url: eatSearch(place, "dinner"),
            ...unchecked(
              // 19:30, unless the plane lands late enough that dinner has to
              // move with it.
              (minutesOf("19:30") ?? 1170) >
              (minutesOf(arrivalAfter(departure)) ?? 0) + 120
                ? "19:30"
                : addMinutes(arrivalAfter(departure), 120),
            ),
          },
        ],
      };
    }

    if (day === totalDays) {
      return {
        day,
        date: `Day ${day}`,
        title: "Last morning, then out",
        photoQuery: `${place} old town`,
        items: [
          {
            time: "Morning",
            title: "Slow breakfast",
            detail: "The one meal nobody has to rush.",
            costPerPerson: Math.round(perDay / 3),
            url: eatSearch(place, "breakfast"),
            ...unchecked("09:00"),
          },
          {
            time: "Midday",
            title: "Head to the airport",
            detail: "Leave more time than you think. You always need it.",
            costPerPerson: null,
            url: null,
            ...unchecked("12:00"),
          },
        ],
      };
    }

    const water = day % 2 === 0;
    return {
      day,
      date: `Day ${day}`,
      title: water ? "The water" : "Walk the old town",
      photoQuery: water ? `${place} beach` : `${place} old town`,
      items: [
        {
          time: "Morning",
          title: water ? "Out on the water" : "Walk the centre",
          detail: water
            ? "The reason everybody agreed to this place."
            : "No plan. See what's there and stop when something looks good.",
          costPerPerson: water ? perDay : null,
          url: thingsToDo(place),
          ...unchecked("10:00"),
        },
        {
          time: "Afternoon",
          title: "Lunch and nothing",
          detail: "Eat somewhere with shade and stay there a while.",
          costPerPerson: Math.round(perDay / 3),
          url: eatSearch(place, "lunch"),
          ...unchecked("13:30"),
        },
        {
          time: "Evening",
          title: "Dinner, everyone together",
          detail: "One table, the four of you, no phones out.",
          costPerPerson: Math.round(perDay / 2),
          url: eatSearch(place, "dinner"),
          ...unchecked("19:30"),
        },
      ],
    };
  });

  return {
    headline: `${trip.nights} nights in ${place}, the way the four of you agreed it.`,
    flights: {
      title: `Flights to ${place}`,
      detail: trip.flightNote,
      costPerPerson: flightCost,
      url: flightSearch(place),
      // Read off the flight note rather than fixed, so the offline document
      // keeps the same promise about departure times the plan made.
      startsAt: departure,
      arrivesAt: arrivalAfter(departure),
      returnsAt: "16:00",
    },
    lodging: {
      title: `${trip.nights} nights, ${trip.region}`,
      detail: trip.lodgingNote,
      costPerPerson: lodgingCost,
      url: staySearch(place),
      startsAt: "15:00",
    },
    days,
  };
}
