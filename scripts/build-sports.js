#!/usr/bin/env node
// Builds docs/sports.json from saved copies of Erik's two sports boards:
//   node scripts/build-sports.js <charlotte-fc.html> <checkers.html> [out.json]
// The boards keep their data as literals in the page script; this pulls those out
// (evaluated in an empty sandbox) and reshapes them into the format in sports-feed.md.
'use strict';
const fs = require('fs');
const vm = require('vm');

const [cltPath, chkPath, outPath = 'docs/sports.json'] = process.argv.slice(2);
if (!cltPath || !chkPath) { console.error('usage: build-sports.js <charlotte-fc.html> <checkers.html> [out.json]'); process.exit(2); }

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th','st','nd','rd'][n % 10] || 'th');
const pad = n => String(n).padStart(2, '0');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
function literal(src, name) {
  const m = src.match(new RegExp('(?:var|const|let)\\s+' + name + '\\s*=\\s*'));
  if (!m) throw new Error('missing ' + name);
  // Walk to the matching close bracket of the literal that starts here
  let i = m.index + m[0].length, depth = 0, start = i, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) break; }
  }
  return vm.runInNewContext('(' + src.slice(start, i + 1) + ')', Object.create(null), { timeout: 1000 });
}
// "Wed, Oct 14" + "7:30 PM ET" -> "2026-10-14T19:30" (year from today, rolling into next year if needed)
function wallTime(day, time) {
  const m = day.match(/([A-Z][a-z]{2})\w* (\d+)/);
  const mon = MONTHS.indexOf(m[1]), now = new Date();
  let year = now.getFullYear();
  if (mon < now.getMonth() - 6) year++;
  let out = `${year}-${pad(mon + 1)}-${pad(+m[2])}`;
  const t = time && time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (t) out += `T${pad((+t[1] % 12) + (/pm/i.test(t[3]) ? 12 : 0))}:${t[2]}`;
  return out;
}
const shortDate = iso => { const [, m, d] = iso.split('-'); return `${MONTHS[+m - 1]} ${+d}`; };

// ---- Charlotte FC Stretch Run ----
function buildClt(html) {
  const CLT = literal(html, 'CLT'), CLTP = literal(html, 'CLTP'), FX = literal(html, 'FX'), DEF = literal(html, 'DEF');
  const L = html.match(/var L\s*=\s*([\d.]+)\s*\/\s*2/);
  const through = (html.match(/Standings through ([A-Z][a-z]+ \d+)/) || [])[1];
  const place = (html.match(/(\d+(?:st|nd|rd|th) in the (?:East|West))/) || [])[1];
  const SHORT = { 'Nashville SC': 'Nashville', 'Chicago Fire': 'Chicago', 'Charlotte FC': 'Charlotte', 'New England Revolution': 'New England', 'Columbus Crew': 'Columbus', 'Philadelphia Union': 'Philadelphia', 'New York City FC': 'NYCFC', 'New York Red Bulls': 'NY Red Bulls', 'Orlando City': 'Orlando', 'FC Cincinnati': 'Cincinnati', 'Atlanta United': 'Atlanta', 'D.C. United': 'D.C. United', 'Toronto FC': 'Toronto', 'CF Montréal': 'Montréal' };
  const stTable = (html.match(/<table class="st">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const table = [...stTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => {
    const td = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => stripTags(x[1]));
    return [SHORT[td[1]] || td[1].replace(/ (SC|FC)$/, ''), +td[4]];
  });
  // "Last result: Charlotte 3, Dallas 2" and the lede's "Sat, Oct 10"
  let last = '';
  const lr = html.match(/Last result: ([^<]+?) (\d+), ([^<]+?) (\d+)<\/h2>\s*<p[^>]*>[^<]*?([A-Z][a-z]{2}, [A-Z][a-z]{2} \d+)/);
  if (lr) {
    const [, a, as, b, bs, when] = lr, usFirst = /Charlotte/.test(a);
    const us = +(usFirst ? as : bs), them = +(usFirst ? bs : as), opp = usFirst ? b : a;
    const date = when.replace(/^\w+, /, '');
    last = us > them ? `Beat ${opp} ${us}-${them}, ${date}` : us < them ? `Lost ${them}-${us} to ${opp}, ${date}` : `Drew ${opp} ${us}-${them}, ${date}`;
  }
  const [sName, sNum] = CLTP.topS.split(/,\s*/), [aName, aNum] = CLTP.topA.split(/,\s*/);
  const leaders = sName === aName ? `${sName} ${plural(+sNum, 'goal')}, ${plural(+aNum, 'assist')}` : `${sName} ${plural(+sNum, 'goal')} · ${aName} ${plural(+aNum, 'assist')}`;
  return {
    asof: through ? `MLS standings through ${through}` : 'MLS standings',
    rec: CLTP.rec.replace(/–/g, '-'), pts: CLTP.pts, place: place || '', last, leaders,
    form: DEF.fw, homeAdv: DEF.hfa, leagueGoals: L ? +L[1] : 3.2,
    season: { gf: CLT.season[0], ga: CLT.season[1], gp: CLT.season[2] },
    post: { gf: CLT.post[0], ga: CLT.post[1], gp: CLT.post[2] },
    games: FX.map(f => ({ at: wallTime(f.d, f.t), opp: f.s, home: f.v === 'H', gf: f.gf, ga: f.ga, gp: f.gp })),
    table
  };
}

// ---- Checkers Stats Board ----
function buildChk(html) {
  const D = literal(html, 'DATA');
  const short = n => n.replace(/ (Bears|Bruins|Thunderbirds|Wolf Pack|Penguins|Phantoms|Monsters|Islanders|Comets|Americans|Crunch|Rocket|Senators|Marlies|Checkers|Admirals|IceHogs|Wild|Griffins|Firebirds|Gulls|Reign|Condors|Barracuda|Eagles|Silver Knights|Stars|Moose|Roadrunners|Canucks|Heat|Wranglers|Rampage|Wolves)$/, '');
  const played = D.games.filter(g => g.played);
  const w = played.filter(g => g.res === 'W').length, l = played.filter(g => g.res === 'L').length, o = played.filter(g => g.res === 'OTL').length;
  const st = D.standings || [];
  const rank = st.findIndex(t => /Charlotte/.test(t.team)) + 1;
  const lg = played[played.length - 1];
  const last = lg ? `${lg.res === 'W' ? 'Won' : 'Lost'} ${Math.max(lg.gf, lg.ga)}-${Math.min(lg.gf, lg.ga)}${lg.ot ? ' in OT/SO' : ''} ${lg.home ? 'vs' : 'at'} ${short(lg.opp)}, ${shortDate(lg.date)}` : '';
  const top = [...D.skaters].sort((a, b) => b.p - a.p || b.g - a.g || a.name.localeCompare(b.name)).slice(0, 2);
  const leaders = top.map(s => s.name + ' ' + [s.g ? plural(s.g, 'goal') : '', s.a ? plural(s.a, 'assist') : ''].filter(Boolean).join(', ')).join(' · ');
  const pickLine = (g, p) => {
    const score = `${Math.max(p.pf, p.pa)}-${Math.min(p.pf, p.pa)}${p.ot ? ' in OT' : ''}`;
    if (p.pf > p.pa) return `Checkers win ${score}`;
    const opp = short(g.opp);
    return `${opp} ${/s$/.test(opp) ? 'win' : 'wins'} ${score}`;
  };
  const asof = (st[0] && st[0].asof) || (lg && lg.date);
  return {
    asof: asof ? `AHL stats through ${shortDate(asof)}` : 'AHL stats',
    rec: `${w}-${l}-${o}`, pts: 2 * w + o, place: rank ? `${ordinal(rank)} in the Atlantic` : '',
    last, leaders,
    games: (D.upcoming || []).slice(0, 5).map(g => ({ at: g.date, opp: short(g.opp), home: g.home, pick: g.pick ? pickLine(g, g.pick) : null, why: g.pick ? g.pick.why || '' : '' })),
    table: st.map(t => [short(t.team), t.gp ? (t.pts / (2 * t.gp)).toFixed(3).replace(/^0/, '') : '.000'])
  };
}

const out = {
  updated: new Date().toISOString(),
  clt: buildClt(fs.readFileSync(cltPath, 'utf8')),
  chk: buildChk(fs.readFileSync(chkPath, 'utf8'))
};
for (const k of ['clt', 'chk']) {
  const t = out[k];
  if (!t.rec || !t.games.length || !t.table.some(r => r[0] === 'Charlotte')) throw new Error(`${k}: missing record, games or Charlotte's table row`);
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${outPath}: Charlotte FC ${out.clt.rec} (${out.clt.games.length} games left), Checkers ${out.chk.rec} (${out.chk.games.length} upcoming)`);
