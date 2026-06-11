/**
 * updown-title — parse the duration of a Polymarket crypto "Up or Down" market
 * from its question title. The family runs THREE series simultaneously:
 *   hourly  "Bitcoin Up or Down - June 10, 11PM ET"
 *   15-min  "Bitcoin Up or Down - June 10, 11:15PM-11:30PM ET"
 *   5-min   "Bitcoin Up or Down - June 10, 11:30PM-11:35PM ET"   (back as of 2026-06-10)
 * The strike of an Up/Down market is the OPEN of its candle, so the duration
 * decides WHICH candle — assuming a fixed duration derives the strike from the
 * wrong candle entirely (the bug that poisoned the first night of G2 paper
 * sessions: 5-min markets priced with the 15-min candle's open, fair values off
 * by 40c+ while the market was right).
 */

/**
 * Market duration in minutes from the question title, or null when the title
 * matches neither shape (callers must skip, never guess a strike).
 * Handles: minutes-precision ranges, a range start that inherits the end's
 * AM/PM ("11:15-11:30PM"), and the midnight wrap ("11:55PM-12:00AM" → 5).
 */
export function rangeDurationMinutes(q: string): number | null {
  const range = q.match(/(\d{1,2})(?::(\d{2}))?\s*([AP]M)?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i);
  if (range) {
    const toMin = (hRaw: string, mRaw: string | undefined, ap: string): number => {
      let h = Number(hRaw) % 12;
      if (/pm/i.test(ap)) h += 12;
      return h * 60 + Number(mRaw ?? 0);
    };
    const startAp = range[3] ?? range[6]!;
    const start = toMin(range[1]!, range[2], startAp);
    const end = toMin(range[4]!, range[5], range[6]!);
    let dur = end - start;
    if (dur <= 0) dur += 24 * 60; // midnight wrap
    return dur > 0 && dur <= 24 * 60 ? dur : null;
  }
  if (/\d{1,2}\s*[AP]M\s*ET/i.test(q)) return 60; // hourly series
  return null;
}
