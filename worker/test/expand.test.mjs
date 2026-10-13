// node worker/test/expand.test.mjs — checks iCal expansion against a hand-written calendar
import { readFileSync } from 'fs';
import { expand } from '../calendar.js';
import assert from 'assert/strict';
const ics = readFileSync(new URL('./sample.ics', import.meta.url), 'utf8');
const from = Date.UTC(2026, 9, 12), to = Date.UTC(2026, 10, 25);
const ev = expand(ics, from, to, 'America/New_York');
const et = s => new Date(s).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const of = t => ev.filter(e => e.title === t).map(e => e.allDay ? e.start : et(e.start));
console.log(JSON.stringify(Object.fromEntries([...new Set(ev.map(e => e.title))].map(t => [t, of(t)])), null, 1));
const soccer = of('Soccer practice');
assert.ok(soccer.includes('Oct 13, 4:30 PM') && !soccer.includes('Oct 15, 4:30 PM') && !soccer.includes('Oct 20, 4:30 PM'));
assert.ok(soccer.includes('Nov 3, 4:30 PM'), 'stays 4:30 after DST ends');
assert.deepEqual(of('Soccer practice (moved)'), ['Oct 21, 5:00 PM']);
assert.deepEqual(of('PTA meeting'), ['Oct 13, 7:30 PM', 'Nov 10, 6:30 PM']); // a UTC time, so it shifts an hour when DST ends
assert.deepEqual(of("Alex's birthday"), ['2026-11-02']);
assert.deepEqual(of('Beach trip, Outer Banks'), ['2026-10-23', '2026-10-24', '2026-10-25']);
assert.deepEqual(of('Swim lessons'), ['Oct 13, 9:00 AM', 'Oct 14, 9:00 AM', 'Oct 15, 9:00 AM']);
assert.equal(of('Vitamins').length, 7); // Oct 12..18
assert.equal(of('Cancelled thing').length, 0);
assert.deepEqual(of('Book club'), ['Oct 30, 7:00 PM']);
assert.equal(of('Trash night').length, 3);
console.log('ok');
