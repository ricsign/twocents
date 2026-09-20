/**
 * Does the day actually work?
 *
 * The model searches, and what it comes back with is a plausible-looking
 * schedule. Plausible is not the same as real: a museum the plan visits at
 * 7pm, a restaurant it books on the day that restaurant is shut, a snorkelling
 * tour that leaves before the flight lands, a "6am departure" under a plan
 * whose whole point was that nobody flies before 8. Every one of those is a
 * thing a person finds out by standing in front of a locked door.
 *
 * So the draft carries the opening hours it found, and this module checks the
 * schedule against them here, in code, where the check is the same every run
 * and can be read: a model asked "is this right?" will usually say yes.
 *
 * What it does *not* do is decide what to say about a failure. It returns
 * issues; `build.ts` takes them back to the web for one repair pass and then
 * decides what survives. The split is deliberate — this file is arithmetic and
 * calendars, and it has no opinions.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import type { ItineraryDraft } from "@/lib/itinerary/prompt";
import type { Plan } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Clock and calendar                                                          */
/* -------------------------------------------------------------------------- */

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Minutes past midnight from "09:30", "9:30", "9:30am", "7pm". Null if unreadable. */
export function minutesOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;

  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;

  let hour = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (!Number.isFinite(hour) || !Number.isFinite(minutes)) return null;
  if (minutes > 59) return null;
  if (meridiem === "pm") hour = (hour % 12) + 12;
  else if (meridiem === "am") hour = hour % 12;
  if (hour > 23) return null;

  return hour * 60 + minutes;
}

/** "14:05" -> "2:05 PM". What the document prints. */
export function clockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const meridiem = hour24 < 12 ? "AM" : "PM";
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

/**
 * The first date in a plan's own date string, as a calendar date.
 *
 * Deliberately built from the plan rather than from the model's per-day `date`
 * field: the weekday is what decides whether a place is open, so it has to come
 * from the dates the four of them agreed to, not from a line a model wrote.
 * Returns null for anything it cannot read ("next spring"), and every weekday
 * check then declines to run rather than guessing.
 */
export function tripStart(dates: string, now: Date = new Date()): Date | null {
  const text = dates.toLowerCase();
  const match = /\b([a-z]{3,9})\.?\s+(\d{1,2})\b/.exec(text);
  if (!match) return null;

  const month = MONTHS[(match[1] ?? "").slice(0, 3)];
  const day = Number(match[2]);
  if (month === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null;

  // No year is ever written on a trip like this, so it is the next one that has
  // not happened yet: a plan made in December for "Mar 14" is next March.
  const year = now.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate.getTime() < now.getTime() - 14 * 24 * 60 * 60 * 1000) {
    return new Date(year + 1, month, day);
  }
  return candidate;
}

/** The weekday of day N of the trip, lowercase, or null when the start is unknown. */
export function weekdayOfDay(start: Date | null, dayNumber: number): string | null {
  if (!start) return null;
  const date = new Date(start.getTime());
  date.setDate(date.getDate() + Math.max(0, dayNumber - 1));
  return WEEKDAYS[date.getDay()] ?? null;
}

/** True when "Mondays" or "Mon" names the day this item falls on. */
function closedOn(closedDays: readonly string[], weekday: string | null): boolean {
  if (!weekday) return false;
  return closedDays.some((entry) => {
    const text = entry.trim().toLowerCase();
    if (!text) return false;
    return weekday.startsWith(text.slice(0, 3));
  });
}

/* -------------------------------------------------------------------------- */
/* The plan's own time constraints                                             */
/* -------------------------------------------------------------------------- */

/**
 * The earliest a flight may leave, in minutes, if the plan promised one.
 *
 * "No flights before 8am" is the single most common constraint people give
 * their agent, it is one the plan screen prints as kept, and it is exactly the
 * sort of promise a document quietly breaks by booking the cheap 6am seat. It
 * is read here from the plan's own public text, so nothing private is involved.
 */
export function earliestDeparture(plan: Plan): number | null {
  return earliestDepartureIn([
    plan.offer.flightNote,
    ...plan.keptWants,
    ...plan.offer.highlights,
  ]);
}

/**
 * The same reading, over any sentences that might carry the promise.
 *
 * Split out from `earliestDeparture` so the canned draft — which has the
 * flight note and no `Plan` — can honour the same constraint it is about to be
 * checked against, rather than booking a 10:30 departure under a plan that
 * promised 11.
 */
export function earliestDepartureIn(sentences: readonly string[]): number | null {
  let floor: number | null = null;

  for (const sentence of sentences) {
    const text = sentence.toLowerCase();
    // "no flights before 8am", "nothing leaves before 9", "no 6am departures"
    const before = /\b(?:no|nothing|not?)\b[^.]*?\bbefore\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/.exec(text);
    if (before) {
      const minutes = minutesOf(before[1] ?? "");
      if (minutes !== null) floor = floor === null ? minutes : Math.max(floor, minutes);
      continue;
    }
    const noEarly = /\bno\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+(?:flight|departure|start)/.exec(text);
    if (noEarly) {
      const minutes = minutesOf(noEarly[1] ?? "");
      // "No 6am departures" forbids 6am itself, so the floor is the minute after.
      if (minutes !== null) floor = floor === null ? minutes + 1 : Math.max(floor, minutes + 1);
    }
  }

  return floor;
}

/* -------------------------------------------------------------------------- */
/* Issues                                                                      */
/* -------------------------------------------------------------------------- */

export type IssueCode =
  | "no-time"
  | "out-of-hours"
  | "closed-that-day"
  | "out-of-order"
  | "before-arrival"
  | "after-departure"
  | "flight-too-early"
  | "over-budget";

export interface AvailabilityIssue {
  code: IssueCode;
  /** 1-based day this is about, or null for the trip-wide ones. */
  day: number | null;
  /** Position within that day's items, or null. */
  item: number | null;
  /** What the item is called, for the repair prompt and the log. */
  title: string;
  /** One sentence, written to be handed back to the model. */
  message: string;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                   */
/* -------------------------------------------------------------------------- */

/** How far over the agreed price the document may land before it is a problem. */
export const BUDGET_TOLERANCE = 1.1;

/** Everything drafted that does not survive contact with a calendar. */
export function checkAvailability(
  draft: ItineraryDraft,
  plan: Plan,
  now: Date = new Date(),
): AvailabilityIssue[] {
  const issues: AvailabilityIssue[] = [];
  const start = tripStart(plan.offer.dates, now);
  const floor = earliestDeparture(plan);

  const departure = minutesOf(draft.flights.startsAt);
  if (floor !== null && departure !== null && departure < floor) {
    issues.push({
      code: "flight-too-early",
      day: null,
      item: null,
      title: draft.flights.title,
      message: `The outbound flight leaves at ${clockLabel(departure)}, but the plan promises nothing before ${clockLabel(floor)}. Find a later flight.`,
    });
  }

  for (const day of draft.days) {
    const weekday = weekdayOfDay(start, day.day);
    let previous: number | null = null;

    day.items.forEach((item, index) => {
      const at = minutesOf(item.startsAt);
      const common = { day: day.day, item: index, title: item.title };

      if (at === null) {
        issues.push({
          ...common,
          code: "no-time",
          message: `"${item.title}" on day ${day.day} has no usable start time. Give it one in 24-hour HH:MM, or say plainly that it has no fixed time.`,
        });
        return;
      }

      if (previous !== null && at < previous) {
        issues.push({
          ...common,
          code: "out-of-order",
          message: `"${item.title}" on day ${day.day} starts at ${clockLabel(at)}, before the thing above it. Put the day in order.`,
        });
      }
      previous = at;

      if (closedOn(item.closedDays, weekday)) {
        issues.push({
          ...common,
          code: "closed-that-day",
          message: `Day ${day.day} is a ${weekday}, and "${item.title}" is closed on ${item.closedDays.join(", ")}. Move it to another day or replace it.`,
        });
        return;
      }

      const opens = minutesOf(item.opensAt);
      const closes = minutesOf(item.closesAt);
      if (opens !== null && at < opens) {
        issues.push({
          ...common,
          code: "out-of-hours",
          message: `"${item.title}" is scheduled at ${clockLabel(at)} but does not open until ${clockLabel(opens)}. Move it later or swap it.`,
        });
      } else if (closes !== null && at >= closes) {
        issues.push({
          ...common,
          code: "out-of-hours",
          message: `"${item.title}" is scheduled at ${clockLabel(at)} but closes at ${clockLabel(closes)}. Move it earlier or swap it.`,
        });
      }
    });
  }

  // Day one cannot start before the plane lands, and the last day cannot run
  // past the flight home. Both are the mistakes that strand somebody.
  const arrival = minutesOf(draft.flights.arrivesAt);
  const firstDay = draft.days[0];
  if (arrival !== null && firstDay) {
    firstDay.items.forEach((item, index) => {
      const at = minutesOf(item.startsAt);
      if (at !== null && at < arrival) {
        issues.push({
          code: "before-arrival",
          day: firstDay.day,
          item: index,
          title: item.title,
          message: `"${item.title}" starts at ${clockLabel(at)}, before the flight lands at ${clockLabel(arrival)}. Move it later.`,
        });
      }
    });
  }

  const home = minutesOf(draft.flights.returnsAt);
  const lastDay = draft.days[draft.days.length - 1];
  if (home !== null && lastDay && lastDay !== firstDay) {
    lastDay.items.forEach((item, index) => {
      const at = minutesOf(item.startsAt);
      if (at !== null && at > home) {
        issues.push({
          code: "after-departure",
          day: lastDay.day,
          item: index,
          title: item.title,
          message: `"${item.title}" starts at ${clockLabel(at)}, after the flight home leaves at ${clockLabel(home)}. Drop it or move it earlier.`,
        });
      }
    });
  }

  return issues;
}

/**
 * The other half of "is this plan real": does it still cost what they agreed?
 *
 * Separate from the schedule checks because it is checked against a different
 * thing — the agreed per-person price, which four people approved — but it goes
 * into the same repair pass, because both are the document contradicting the
 * plan it was built from.
 */
export function budgetIssue(perPerson: number, plan: Plan): AvailabilityIssue | null {
  const agreed = plan.offer.perPerson;
  if (agreed <= 0 || perPerson <= agreed * BUDGET_TOLERANCE) return null;
  return {
    code: "over-budget",
    day: null,
    item: null,
    title: "The total",
    message: `The days add up to $${Math.round(perPerson)} a person, but they agreed $${agreed}. Bring it back to roughly the agreed figure: cheaper lodging, fewer paid activities, or free alternatives.`,
  };
}
