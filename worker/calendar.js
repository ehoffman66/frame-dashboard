// Cloudflare Worker: turns Google Calendar's private iCal links into the JSON the frame reads.
//
// Settings (Worker → Settings → Variables and Secrets, both as type "Secret"):
//   KEY    a long random string; the frame's calendar URL is https://<worker>.workers.dev/<KEY>
//   FEEDS  JSON list of calendars, for example
//          [{"name":"family","url":"https://calendar.google.com/calendar/ical/.../basic.ics","color":"#f0b35e"},
//           {"name":"meals","url":"https://calendar.google.com/calendar/ical/.../basic.ics","meals":true}]
//          A feed with "meals": true fills the frame's Meals tab instead of the calendar.
//   TZ     optional, defaults to America/New_York; the zone for floating times and for which day a dinner falls on
//
// Response: { updated, events: [{ title, start, end, allDay, calendar, color, location?, notes?, link? }], meals: { "2026-10-15": "Tacos" } }
// link opens the event in Google Calendar (Google feeds only), so it can be edited on a phone.
// Timed events are UTC instants ("...Z"); all-day events are plain dates, one entry per day they cover.

const DAY = 86400000;
const CACHE_SEC = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Cache-Control': 'no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.KEY || url.pathname !== '/' + env.KEY) return new Response('Not found', { status: 404, headers: cors });

    const cache = caches.default, cacheKey = new Request(url.origin + url.pathname);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/json' } });

    let feeds;
    try { feeds = JSON.parse(env.FEEDS || '[]'); } catch (e) { return json({ error: 'FEEDS is not valid JSON' }, 500, cors); }
    const tz = env.TZ || 'America/New_York';
    const today = Date.parse(dateInZone(Date.now(), tz) + 'T00:00:00Z'); // today's date, as a UTC-midnight number
    const from = today - DAY, to = today + 43 * DAY;

    const results = await Promise.all(feeds.map(async f => {
      try {
        const r = await fetch(f.url, { cf: { cacheTtl: CACHE_SEC } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return { feed: f, events: expand(await r.text(), from, to, tz, googleCalendarId(f.url)) };
      } catch (e) {
        return { feed: f, error: String(e.message || e) };
      }
    }));

    const out = { updated: new Date().toISOString(), events: [], meals: {}, errors: [] };
    for (const { feed, events, error } of results) {
      if (error) { out.errors.push(feed.name + ': ' + error); continue; }
      for (const e of events) {
        if (feed.meals) {
          const day = e.allDay ? e.start : dateInZone(Date.parse(e.start), tz);
          out.meals[day] = out.meals[day] ? out.meals[day] + ' + ' + e.title : e.title;
        } else {
          out.events.push({ ...e, calendar: feed.name, color: feed.color || undefined });
        }
      }
    }
    out.events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (!out.errors.length) delete out.errors;

    const res = json(out, 200, cors);
    if (!out.errors) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'max-age=' + CACHE_SEC } })));
    return res;
  }
};

function json(o, status, headers) {
  return new Response(JSON.stringify(o), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// ---------- iCal ----------

// Returns the events of one .ics file that touch [from, to), with repeating events expanded.
export function expand(ics, from, to, defaultTz, calendarId) {
  const lines = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const calTz = (lines.find(l => l.startsWith('X-WR-TIMEZONE:')) || '').slice(14).trim() || defaultTz;
  const vevents = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) vevents.push(cur); cur = null; }
    else if (cur) {
      const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
      if (!m) continue;
      const [, name, paramStr, value] = m;
      const params = {};
      paramStr.split(';').slice(1).forEach(p => { const i = p.indexOf('='); params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ''); });
      if (name === 'EXDATE') (cur.EXDATE = cur.EXDATE || []).push({ params, value });
      else if (!(name in cur)) cur[name] = { params, value };
    }
  }

  // Moved or edited single instances of a repeating event
  const overridden = new Set();
  for (const v of vevents) if (v['RECURRENCE-ID'] && v.UID) overridden.add(v.UID.value + '|' + parseTime(v['RECURRENCE-ID'], calTz).utc);

  const out = [];
  for (const v of vevents) {
    if (!v.DTSTART || (v.STATUS && v.STATUS.value === 'CANCELLED')) continue;
    const start = parseTime(v.DTSTART, calTz);
    const dur = v.DTEND ? parseTime(v.DTEND, start.tz || calTz).utc - start.utc : v.DURATION ? parseDuration(v.DURATION.value) : (start.allDay ? DAY : 0);
    const title = unescapeText(v.SUMMARY ? v.SUMMARY.value : '(No title)');
    const uid = v.UID ? v.UID.value : '';
    const extra = {};
    if (v.LOCATION && v.LOCATION.value.trim()) extra.location = unescapeText(v.LOCATION.value);
    const notes = v.DESCRIPTION ? cleanNotes(v.DESCRIPTION.value) : '';
    if (notes) extra.notes = notes;

    let starts;
    if (v.RRULE && !v['RECURRENCE-ID']) {
      const ex = new Set();
      (v.EXDATE || []).forEach(x => x.value.split(',').forEach(val => ex.add(parseTime({ params: x.params, value: val }, start.tz || calTz).utc)));
      starts = recur(start, parseRule(v.RRULE.value), from - Math.max(dur, DAY), to).filter(t => !ex.has(t.utc) && !overridden.has(uid + '|' + t.utc));
    } else {
      starts = [start];
    }

    for (const s of starts) {
      const end = s.utc + dur;
      if (end <= from && !(dur === 0 && s.utc >= from)) continue;
      if (s.utc >= to) continue;
      const link = googleLink(uid, calendarId, v.RRULE && !v['RECURRENCE-ID'] ? s : null, start.allDay);
      const more = link ? { ...extra, link } : extra;
      if (start.allDay) {
        // One entry per day so multi-day events show on every day they cover
        for (let d = s.utc, n = 0; d < Math.max(end, s.utc + DAY) && n < 60; d += DAY, n++) {
          if (d < from || d >= to) continue;
          out.push({ title, start: isoDate(d), end: null, allDay: true, ...more });
        }
      } else {
        out.push({ title, start: new Date(s.utc).toISOString(), end: dur ? new Date(end).toISOString() : null, allDay: false, ...more });
      }
    }
  }
  return out;
}

function unescapeText(s) { return s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }

// DESCRIPTION keeps its line breaks; Google sometimes stores it as HTML
function cleanNotes(s) {
  const t = s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
  return t.length > 800 ? t.slice(0, 800).trim() + '…' : t;
}

// The calendar's id from its Google iCal URL (.../calendar/ical/<id>/private-.../basic.ics), or '' for other feeds
function googleCalendarId(url) {
  const m = String(url).match(/calendar\.google\.com\/calendar\/ical\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : '';
}

// Google Calendar's link for an event: eid is base64 of "<event id> <calendar id>"; repeats add _<start> for one occurrence
function googleLink(uid, calendarId, occurrence, allDay) {
  if (!calendarId || !/@google\.com$/.test(uid)) return '';
  let id = uid.replace(/@google\.com$/, '');
  if (occurrence) id += '_' + new Date(occurrence.utc).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').slice(0, allDay ? 8 : 16);
  return 'https://www.google.com/calendar/event?eid=' + btoa(id + ' ' + calendarId).replace(/=+$/, '');
}

// A DTSTART-like property → { utc, allDay, tz, wall } where wall is the local time as a UTC-based number
function parseTime(prop, calTz) {
  const v = prop.value.trim();
  const m = v.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/);
  if (!m) return { utc: NaN, allDay: false };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[4] || prop.params.VALUE === 'DATE') return { utc: wall, wall, allDay: true, tz: null };
  if (m[7]) return { utc: wall, wall, allDay: false, tz: 'UTC' };
  const tz = prop.params.TZID || calTz;
  return { utc: wallToUtc(wall, tz), wall, allDay: false, tz };
}

function parseDuration(s) {
  const m = s.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600000) + ((+m[5] || 0) * 60000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}

function parseRule(s) {
  const r = {};
  s.split(';').forEach(p => { const [k, v] = p.split('='); r[k] = v; });
  return {
    freq: r.FREQ, interval: +(r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null,
    until: r.UNTIL ? parseTime({ params: {}, value: r.UNTIL }, 'UTC').utc + (/T/.test(r.UNTIL) ? 0 : DAY - 1) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map(d => { const m = d.match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/); return m && { n: m[1] ? +m[1] : 0, wd: WD[m[2]] }; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(n => +n - 1) : null,
    bysetpos: r.BYSETPOS ? r.BYSETPOS.split(',').map(Number) : null
  };
}
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Occurrence starts (as {utc}) of a repeating event that begin before `to`, skipping ones that end before `from`.
// Works in the event's own wall time so a 4:30pm event stays at 4:30pm across daylight saving changes.
function recur(start, rule, from, to) {
  const out = [], tz = start.tz, s0 = start.wall;
  const tod = s0 - Math.floor(s0 / DAY) * DAY; // time of day in ms
  const d0 = new Date(s0);
  const toUtc = wall => (start.allDay || tz === 'UTC' ? wall : wallToUtc(wall, tz));
  let n = 0, guard = 0;

  // Without COUNT, jump close to the window instead of walking from a start years ago
  const jumpable = rule.count == null && from > start.utc;
  const ahead = (unit) => jumpable ? Math.max(0, Math.floor((from - s0) / unit / rule.interval) - 1) * rule.interval : 0;

  // Candidate days for one period, as UTC-midnight numbers, sorted
  function daysInMonth(y, mo) {
    const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let days = [];
    if (rule.byday) {
      for (const b of rule.byday) {
        const all = [];
        for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === b.wd) all.push(d);
        if (!b.n) days.push(...all); else { const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n]; if (pick) days.push(pick); }
      }
      if (rule.bymonthday) days = days.filter(d => rule.bymonthday.some(md => (md > 0 ? md : len + md + 1) === d));
    } else if (rule.bymonthday) {
      rule.bymonthday.forEach(md => { const d = md > 0 ? md : len + md + 1; if (d >= 1 && d <= len) days.push(d); });
    } else if (d0.getUTCDate() <= len) days.push(d0.getUTCDate());
    days = [...new Set(days)].sort((a, b) => a - b);
    if (rule.bysetpos) days = rule.bysetpos.map(p => (p > 0 ? days[p - 1] : days[days.length + p])).filter(Boolean);
    return days.map(d => Date.UTC(y, mo, d));
  }

  function* periods() {
    if (rule.freq === 'DAILY') {
      for (let i = ahead(DAY); ; i += rule.interval) yield [Math.floor(s0 / DAY) * DAY + i * DAY];
    } else if (rule.freq === 'WEEKLY') {
      const wk0 = Math.floor(s0 / DAY) * DAY - ((d0.getUTCDay() + 6) % 7) * DAY; // Monday of the first week
      const wds = rule.byday ? rule.byday.map(b => b.wd) : [d0.getUTCDay()];
      for (let i = ahead(7 * DAY); ; i += rule.interval) {
        const base = wk0 + i * 7 * DAY;
        yield wds.map(wd => base + ((wd + 6) % 7) * DAY).sort((a, b) => a - b);
      }
    } else if (rule.freq === 'MONTHLY') {
      const y0 = d0.getUTCFullYear(), m0 = d0.getUTCMonth();
      for (let i = ahead(31 * DAY); ; i += rule.interval) yield daysInMonth(y0 + Math.floor((m0 + i) / 12), (m0 + i) % 12);
    } else if (rule.freq === 'YEARLY') {
      const y0 = d0.getUTCFullYear();
      for (let i = ahead(366 * DAY); ; i += rule.interval) {
        const months = rule.bymonth || [d0.getUTCMonth()];
        let days = [];
        for (const mo of months) {
          if (rule.byday || rule.bymonthday) days.push(...daysInMonth(y0 + i, mo));
          else { const t = Date.UTC(y0 + i, mo, d0.getUTCDate()); if (new Date(t).getUTCMonth() === mo) days.push(t); }
        }
        yield days.sort((a, b) => a - b);
      }
    }
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return [start];

  for (const days of periods()) {
    if (++guard > 3000) break;
    for (const day of days) {
      const wall = day + tod;
      if (wall < s0) continue;
      const utc = toUtc(wall);
      if (rule.until != null && utc > rule.until) return out;
      if (rule.count != null && ++n > rule.count) return out;
      if (utc >= to) return out;
      if (utc >= from) out.push({ utc });
    }
  }
  return out;
}

// ---------- time zones ----------

const fmts = {};
function partsIn(t, tz) {
  const f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = {};
  f.formatToParts(new Date(t)).forEach(x => { p[x.type] = +x.value; });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
}
// Wall time in a zone (as a UTC-based number) → the real instant
function wallToUtc(wall, tz) {
  try {
    let t = wall - (partsIn(wall, tz) - wall);
    t = wall - (partsIn(t, tz) - t);
    return t;
  } catch (e) { return wall; } // unknown zone name: treat as UTC
}
function dateInZone(t, tz) { return isoDate(partsIn(t, tz)); }
function isoDate(t) { return new Date(t).toISOString().slice(0, 10); }
