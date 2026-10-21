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
//
// Spotify (optional, for the Music tab): three more secrets, set up as described in the README
//   SPOTIFY_ID, SPOTIFY_SECRET   from your app at developer.spotify.com
//   SPOTIFY_REFRESH              shown once by https://<worker>.workers.dev/spotify/login after you sign in
// The frame then calls https://<worker>.workers.dev/<KEY>/spotify/... and never sees a Spotify login.
//
// Sonos (optional, preferred for the Music tab: Spotify often won't show Sonos speakers to apps): three more secrets
//   SONOS_ID, SONOS_SECRET       the Key and Secret of your control integration at developer.sonos.com
//   SONOS_REFRESH                shown once by https://<worker>.workers.dev/sonos/login after you sign in
// With these set, /<KEY>/music/... controls the Sonos rooms and plays your Sonos Favorites; without them it uses Spotify.

const DAY = 86400000;
const CACHE_SEC = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    // Sign-in needs no KEY: it only ever shows a login to the person who just signed in, and the Worker uses
    // nothing until that value is saved as the SPOTIFY_REFRESH secret
    if (env.KEY && url.pathname === '/spotify/login') return spotifyLogin(url, env);
    if (env.KEY && url.pathname === '/spotify/callback') return spotifyCallback(url, env);
    if (env.KEY && url.pathname === '/sonos/login') return sonosLogin(url, env);
    if (env.KEY && url.pathname === '/sonos/callback') return sonosCallback(url, env);
    if (env.KEY && url.pathname.startsWith('/' + env.KEY + '/spotify/')) return spotify(request, url, env, cors, env.KEY.length + 10);
    if (env.KEY && url.pathname.startsWith('/' + env.KEY + '/music/'))
      return (env.SONOS_REFRESH ? sonos : spotify)(request, url, env, cors, env.KEY.length + 8);
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

// ---------- Spotify ----------

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read';

function redirectUri(url) { return url.origin + '/spotify/callback'; }
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
function page(body, status) {
  return new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:17px system-ui;max-width:640px;margin:40px auto;padding:0 16px">' + body,
    { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function spotifyToken(env) {
  if (globalThis.spToken && globalThis.spToken.exp > Date.now()) return globalThis.spToken.value;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.SPOTIFY_ID + ':' + env.SPOTIFY_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.SPOTIFY_REFRESH })
  });
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + '); sign in again at /spotify/login');
  const j = await r.json();
  globalThis.spToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function sp(env, method, path, body) {
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method, headers: { Authorization: 'Bearer ' + await spotifyToken(env), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text(), j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((j && j.error && j.error.message) || 'Spotify error ' + r.status);
  return j;
}

function slimTrack(item) {
  if (!item) return null;
  const imgs = (item.album || item.show || {}).images || item.images || [];
  return { name: item.name, by: (item.artists || []).map(a => a.name).join(', ') || (item.show && item.show.name) || '',
    album: item.album ? item.album.name : '', art: imgs.length ? imgs[0].url : '', ms: item.duration_ms };
}
function slimList(p) { return p && { name: p.name, uri: p.uri, art: p.images && p.images.length ? p.images[p.images.length > 1 ? 1 : 0].url : '', by: p.owner ? p.owner.display_name : (p.artists || []).map(a => a.name).join(', ') }; }

async function spotifyLists(env) {
  const j = await sp(env, 'GET', '/me/playlists?limit=50');
  return (j.items || []).filter(Boolean).map(slimList);
}
// The songs in a Spotify playlist or album, or an artist's top songs
async function spotifyTracks(env, uri) {
  const [, type, id] = uri.split(':');
  const song = (t, art) => t && { name: t.name, by: (t.artists || []).map(a => a.name).join(', '), ms: t.duration_ms, uri: t.uri,
    art: art || ((t.album && t.album.images && t.album.images.length) ? t.album.images[t.album.images.length - 1].url : '') };
  if (type === 'playlist') {
    // Spotify renamed /tracks to /items in 2026 and, for apps in development mode, only lists songs of playlists you own or collaborate on
    const p = await sp(env, 'GET', '/playlists/' + id + '?fields=name,images,owner(display_name)');
    let t = null;
    try { t = await sp(env, 'GET', '/playlists/' + id + '/items?limit=50'); } catch (e) { t = null; }
    if (!t || !t.items) try { t = await sp(env, 'GET', '/playlists/' + id + '/tracks?limit=50'); } catch (e) { t = null; }
    const items = ((t && t.items) || []).map(x => song(x.item || x.track)).filter(x => x && x.uri);
    return { name: p.name, art: p.images && p.images.length ? p.images[0].url : '', by: p.owner ? p.owner.display_name : '', fromIndex: true,
      items, note: items.length ? '' : 'Spotify only shares the song list for playlists you made. Tap Play to play it.' };
  }
  if (type === 'album') {
    const a = await sp(env, 'GET', '/albums/' + id);
    const art = a.images && a.images.length ? a.images[a.images.length - 1].url : '';
    return { name: a.name, art: a.images && a.images.length ? a.images[0].url : '', by: (a.artists || []).map(x => x.name).join(', '), fromIndex: true,
      items: ((a.tracks && a.tracks.items) || []).map(x => song(x, art)) };
  }
  if (type === 'artist') {
    // Spotify removed artist top tracks for development-mode apps, so search the artist's songs instead
    const a = await sp(env, 'GET', '/artists/' + id);
    const t = await sp(env, 'GET', '/search?type=track&limit=10&q=' + encodeURIComponent('artist:"' + a.name + '"'));
    return { name: a.name, art: a.images && a.images.length ? a.images[0].url : '', by: 'Songs', fromIndex: false, items: ((t.tracks && t.tracks.items) || []).filter(Boolean).map(x => song(x)) };
  }
  return { name: '', items: [] };
}
async function spotifySearch(env, q) {
  const j = await sp(env, 'GET', '/search?type=playlist,album,artist&limit=8&q=' + encodeURIComponent(q));
  return [].concat((j.playlists && j.playlists.items) || [], (j.albums && j.albums.items) || [], (j.artists && j.artists.items) || []).filter(Boolean).map(slimList);
}

// /spotify/login and /spotify/callback: the one-time sign-in that produces SPOTIFY_REFRESH
async function spotifyCallback(url, env) {
  if (url.searchParams.get('state') !== await sha('frame-spotify:' + env.KEY)) return page('This sign-in link has expired. Start again at /spotify/login.', 400);
  if (url.searchParams.get('error')) return page('Spotify said: ' + url.searchParams.get('error').replace(/[<&]/g, ''), 400);
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.SPOTIFY_ID + ':' + env.SPOTIFY_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: redirectUri(url) })
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) return page('Spotify didn\'t accept the sign-in (' + String(j.error_description || j.error || r.status).replace(/[<&]/g, '') + '). Check SPOTIFY_ID and SPOTIFY_SECRET.', 400);
  return page('<h2>Signed in to Spotify</h2><p>Copy this value, then in Cloudflare add a Secret named <b>SPOTIFY_REFRESH</b> with it and click Deploy. Keep it private: it controls your Spotify account.</p>' +
    '<textarea readonly onclick="this.select()" style="width:100%;height:120px;font:14px monospace">' + j.refresh_token + '</textarea>');
}

async function spotifyLogin(url, env) {
  if (!env.SPOTIFY_ID || !env.SPOTIFY_SECRET) return page('Add the SPOTIFY_ID and SPOTIFY_SECRET secrets first, then reload this page.', 400);
  return Response.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: env.SPOTIFY_ID, scope: SCOPES, redirect_uri: redirectUri(url), state: await sha('frame-spotify:' + env.KEY)
  }), 302);
}

async function spotify(request, url, env, cors, skip) {
  const action = url.pathname.slice(skip); // after /<KEY>/spotify/ or /<KEY>/music/
  if (!env.SPOTIFY_ID || !env.SPOTIFY_SECRET || !env.SPOTIFY_REFRESH) return json({ error: 'setup', message: 'Spotify isn\'t set up in the Worker yet' }, 200, cors);
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const dev = body.device ? '?device_id=' + encodeURIComponent(body.device) : '';
    switch (action) {
      case 'state': {
        const [p, d] = await Promise.all([sp(env, 'GET', '/me/player?additional_types=episode'), sp(env, 'GET', '/me/player/devices')]);
        return json({
          provider: 'spotify', playing: !!(p && p.is_playing), track: slimTrack(p && p.item), progress: p ? p.progress_ms : 0,
          shuffle: !!(p && p.shuffle_state), device: p && p.device ? p.device.id : null,
          devices: ((d && d.devices) || []).map(x => ({ id: x.id, name: x.name, type: x.type, active: x.is_active, volume: x.volume_percent, canVolume: x.supports_volume !== false }))
        }, 200, cors);
      }
      case 'playlists': return json({ items: await spotifyLists(env) }, 200, cors);
      case 'search': return json({ items: await spotifySearch(env, url.searchParams.get('q') || '') }, 200, cors);
      case 'tracks': return json(await spotifyTracks(env, url.searchParams.get('uri') || ''), 200, cors);
      case 'play': {
        const u = body.uri, play = !u ? undefined : /^spotify:track:/.test(u) ? { uris: [u] } : body.index ? { context_uri: u, offset: { position: +body.index } } : { context_uri: u };
        return json(await sp(env, 'PUT', '/me/player/play' + dev, play) || {}, 200, cors);
      }
      case 'queue': return json(await sp(env, 'POST', '/me/player/queue?uri=' + encodeURIComponent(body.uri || '') + (body.device ? '&device_id=' + encodeURIComponent(body.device) : '')) || {}, 200, cors);
      case 'pause': return json(await sp(env, 'PUT', '/me/player/pause' + dev) || {}, 200, cors);
      case 'next': return json(await sp(env, 'POST', '/me/player/next' + dev) || {}, 200, cors);
      case 'previous': return json(await sp(env, 'POST', '/me/player/previous' + dev) || {}, 200, cors);
      case 'volume': return json(await sp(env, 'PUT', '/me/player/volume?volume_percent=' + Math.max(0, Math.min(100, Math.round(+body.percent || 0))) + (body.device ? '&device_id=' + encodeURIComponent(body.device) : '')) || {}, 200, cors);
      case 'shuffle': return json(await sp(env, 'PUT', '/me/player/shuffle?state=' + (body.on ? 'true' : 'false')) || {}, 200, cors);
      case 'transfer': return json(await sp(env, 'PUT', '/me/player', { device_ids: [body.device], play: !!body.play }) || {}, 200, cors);
    }
    return json({ error: 'unknown' }, 404, cors);
  } catch (e) {
    return json({ error: 'spotify', message: String(e.message || e) }, 200, cors);
  }
}

// ---------- Sonos ----------
// Sonos's cloud control API: rooms (groups), playback, volume and the household's Sonos Favorites.

async function sonosOauth(env, params) {
  const r = await fetch('https://api.sonos.com/login/v3/oauth/access', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.SONOS_ID + ':' + env.SONOS_SECRET), 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params)
  });
  return { r, j: await r.json().catch(() => ({})) };
}
async function sonosToken(env) {
  if (globalThis.soToken && globalThis.soToken.exp > Date.now()) return globalThis.soToken.value;
  const { r, j } = await sonosOauth(env, { grant_type: 'refresh_token', refresh_token: env.SONOS_REFRESH });
  if (!r.ok) throw new Error('Sonos login failed (' + r.status + '); sign in again at /sonos/login');
  globalThis.soToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}
async function so(env, method, path, body, retried) {
  const r = await fetch('https://api.ws.sonos.com/control/api/v1' + path, {
    method, headers: { Authorization: 'Bearer ' + await sonosToken(env), 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined
  });
  // Sonos can drop an access token before it says it expires; get a fresh one and try once more
  if (r.status === 401 && !retried) { globalThis.soToken = null; return so(env, method, path, body, true); }
  const text = await r.text(), j = text ? JSON.parse(text) : null;
  if (r.status === 401) throw new Error('Sonos refused the dashboard\'s access (401). Sign in again at /sonos/login and save the new SONOS_REFRESH');
  if (!r.ok) throw new Error((j && (j.reason || j.errorCode)) || 'Sonos error ' + r.status);
  return j;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const sameName = (a, b) => { a = String(a || '').toLowerCase().trim(); b = String(b || '').toLowerCase().trim(); return !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a)); };
async function nowName(env, g) {
  const m = await so(env, 'GET', g + '/playbackMetadata').catch(() => null);
  return m && m.currentItem && m.currentItem.track ? m.currentItem.track.name : '';
}
// Skip from the first song to song number `index`, then nudge until the speaker reports the song that was tapped
async function skipTo(env, g, index, name, first) {
  // let the new queue start (until the playlist's first song shows, when we know it)
  for (let n = 0; n < 6; n++) { const now = await nowName(env, g); if (first ? sameName(now, first) : now) break; await wait(500); }
  const blind = name ? Math.max(0, index - 3) : index;
  for (let n = 0; n < blind; n++) { await so(env, 'POST', g + '/playback/skipToNextTrack'); await wait(350); }
  if (!name) return;
  for (let n = 0; n < 6; n++) {
    await wait(500);
    if (sameName(await nowName(env, g), name)) return;
    await so(env, 'POST', g + '/playback/skipToNextTrack');
  }
}
// A Spotify link (spotify:playlist:ID and the like) from anything that mentions one, even URL-encoded
function spotifyUri(text) {
  const m = String(text).match(/spotify(?::|%3a)(playlist|album|track|artist)(?::|%3a)([A-Za-z0-9]{22})/i);
  return m ? 'spotify:' + m[1].toLowerCase() + ':' + m[2] : '';
}
async function spotifyArt(env, tr) {
  const id = spotifyUri(JSON.stringify(tr.id || ''));
  const key = id || (tr.name || '') + '|' + ((tr.artist && tr.artist.name) || '');
  const cache = globalThis.spArt || (globalThis.spArt = {});
  if (key in cache) return cache[key];
  if (!id && !tr.name) return '';
  let t = null;
  if (/^spotify:track:/.test(id)) t = await sp(env, 'GET', '/tracks/' + id.split(':')[2]);
  else {
    const j = await sp(env, 'GET', '/search?type=track&limit=1&q=' + encodeURIComponent('track:' + tr.name + (tr.artist && tr.artist.name ? ' artist:' + tr.artist.name : '')));
    t = j.tracks && j.tracks.items && j.tracks.items[0];
  }
  const imgs = (t && t.album && t.album.images) || [];
  return (cache[key] = imgs.length ? imgs[0].url : '');
}
// Sonos sometimes leaves out the song name (often for songs it was handed from here); look it up on Spotify by the track id
async function fillTrack(env, tr) {
  if (tr && !tr.name && tr.title) tr.name = tr.title;
  if (tr && typeof tr.artist === 'string') tr.artist = { name: tr.artist };
  if (!tr || tr.name || !spotifyOn(env)) return;
  const id = spotifyUri(JSON.stringify(tr.id || ''));
  if (!/^spotify:track:/.test(id)) return;
  const cache = globalThis.spTrack || (globalThis.spTrack = {});
  const t = cache[id] || (cache[id] = await sp(env, 'GET', '/tracks/' + id.split(':')[2]).catch(() => null));
  if (!t) { delete cache[id]; return; }
  tr.name = t.name;
  if (!tr.artist || !tr.artist.name) tr.artist = { name: (t.artists || []).map(a => a.name).join(', ') };
  if (!tr.album || !tr.album.name) tr.album = { name: t.album ? t.album.name : '' };
  if (!tr.durationMillis) tr.durationMillis = t.duration_ms;
}
function spotifyOn(env) { return !!(env.SPOTIFY_ID && env.SPOTIFY_SECRET && env.SPOTIFY_REFRESH); }
// The Spotify account Sonos uses, from any favorite that came from Spotify
function spotifyAccount(items) {
  const f = (items || []).find(x => x.resource && x.resource.id && /spotify/i.test(String(x.resource.id.objectId || '') + (x.service && x.service.name)));
  return f ? { serviceId: f.resource.id.serviceId, accountId: f.resource.id.accountId } : null;
}
// Load Spotify content on a room. With no known account, try the usual Sonos ids for a linked Spotify account (service 12 or 9, sn_1, sn_2...) and keep the one that works.
async function loadSpotify(env, g, acct, c) {
  const send = a => so(env, 'POST', g + '/playback/content', { type: c.type, id: { objectId: c.objectId, serviceId: a.serviceId, accountId: a.accountId },
    queueAction: c.queueAction, playbackAction: c.playbackAction, playModes: c.playModes });
  if (acct) { await send(acct); globalThis.soSpotify = acct; return; }
  let err = null;
  for (const sid of ['12', '9']) for (let n = 1; n <= 6; n++) {
    const a = { serviceId: sid, accountId: 'sn_' + n };
    try { await send(a); globalThis.soSpotify = a; return; } catch (e) { err = err || e; }
  }
  throw new Error('Play something from Spotify on a Sonos once (or heart a Spotify playlist in the Sonos app), so Sonos knows which Spotify account to use. Sonos said: ' + (err ? err.message : 'nothing'));
}
// ...or from the copy the tablet kept from an earlier answer
function savedAcct(body) {
  const a = body && body.acct;
  return a && /^[\w.:-]{1,64}$/.test(String(a.serviceId)) && /^[\w.:-]{1,64}$/.test(String(a.accountId)) ? { serviceId: String(a.serviceId), accountId: String(a.accountId) } : null;
}
// ...or from whatever a room is playing from Spotify right now
async function playingSpotify(env, hh) {
  const gr = await so(env, 'GET', '/households/' + hh + '/groups');
  for (const x of gr.groups || []) {
    if (x.playbackState !== 'PLAYBACK_STATE_PLAYING' && x.playbackState !== 'PLAYBACK_STATE_PAUSED') continue;
    const m = await so(env, 'GET', '/groups/' + x.id + '/playbackMetadata').catch(() => null);
    const ids = [m && m.container && m.container.id, m && m.currentItem && m.currentItem.track && m.currentItem.track.id];
    const id = ids.find(i => i && i.accountId && /spotify/i.test(String(i.objectId || '') + JSON.stringify(m.container && m.container.service || '')));
    if (id) return { serviceId: id.serviceId, accountId: id.accountId };
  }
  return null;
}
async function household(env) {
  if (globalThis.soHousehold) return globalThis.soHousehold;
  const j = await so(env, 'GET', '/households');
  if (!j.households || !j.households.length) throw new Error('No Sonos system found on this account');
  return (globalThis.soHousehold = j.households[0].id);
}

async function sonosLogin(url, env) {
  if (!env.SONOS_ID || !env.SONOS_SECRET) return page('Add the SONOS_ID and SONOS_SECRET secrets first, then reload this page.', 400);
  return Response.redirect('https://api.sonos.com/login/v3/oauth?' + new URLSearchParams({
    client_id: env.SONOS_ID, response_type: 'code', scope: 'playback-control-all',
    redirect_uri: url.origin + '/sonos/callback', state: await sha('frame-sonos:' + env.KEY)
  }), 302);
}
async function sonosCallback(url, env) {
  if (url.searchParams.get('state') !== await sha('frame-sonos:' + env.KEY)) return page('This sign-in link has expired. Start again at /sonos/login.', 400);
  if (url.searchParams.get('error')) return page('Sonos said: ' + url.searchParams.get('error').replace(/[<&]/g, ''), 400);
  const { r, j } = await sonosOauth(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: url.origin + '/sonos/callback' });
  if (!r.ok || !j.refresh_token) return page('Sonos didn\'t accept the sign-in (' + String(j.error_description || j.error || r.status).replace(/[<&]/g, '') + '). Check SONOS_ID and SONOS_SECRET.', 400);
  return page('<h2>Signed in to Sonos</h2><p>Copy this value, then in Cloudflare add a Secret named <b>SONOS_REFRESH</b> with it and click Deploy. Keep it private: it controls your speakers.</p>' +
    '<textarea readonly onclick="this.select()" style="width:100%;height:120px;font:14px monospace">' + j.refresh_token + '</textarea>');
}

// Same answers as the Spotify version, so the Music tab works with either. Speakers are Sonos rooms (groups).
async function sonos(request, url, env, cors, skip) {
  const action = url.pathname.slice(skip);
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const hh = await household(env);
    const g = body.device ? '/groups/' + encodeURIComponent(body.device) : null;
    const need = () => { if (!g) throw new Error('Pick a speaker first'); return g; };
    switch (action) {
      case 'state': {
        const gr = await so(env, 'GET', '/households/' + hh + '/groups');
        const groups = gr.groups || [];
        const info = await Promise.all(groups.map(x => Promise.all([
          so(env, 'GET', '/groups/' + x.id + '/groupVolume').catch(() => null),
          x.playbackState === 'PLAYBACK_STATE_PLAYING' || x.playbackState === 'PLAYBACK_STATE_PAUSED' ? so(env, 'GET', '/groups/' + x.id + '/playbackMetadata').catch(() => null) : null,
          x.playbackState === 'PLAYBACK_STATE_PLAYING' ? so(env, 'GET', '/groups/' + x.id + '/playback').catch(() => null) : null
        ])));
        // What's on screen: the room picked on the frame if given, else the first one playing
        const want = url.searchParams.get('device');
        let i = groups.findIndex(x => x.id === want);
        if (i < 0) i = groups.findIndex(x => x.playbackState === 'PLAYBACK_STATE_PLAYING');
        const cur = i >= 0 ? groups[i] : null, meta = cur && info[i][1], pb = cur && info[i][2];
        const tr = meta && meta.currentItem && meta.currentItem.track;
        const nx = meta && meta.nextItem && meta.nextItem.track;
        await Promise.all([fillTrack(env, tr), fillTrack(env, nx)]);
        // Sonos often hands back album art on the speaker's own home address, which the https page can't load; ask Spotify instead
        let art = [tr && tr.imageUrl, meta && meta.container && meta.container.imageUrl].find(u => u && /^https:/.test(u)) || '';
        if (tr && !art && spotifyOn(env)) art = await spotifyArt(env, tr).catch(() => '');
        // Remember which Spotify account Sonos plays from; the tablet keeps a copy and sends it back, since this Worker forgets on restart
        const ids = [meta && meta.container && meta.container.id, tr && tr.id];
        const sid = ids.find(i => i && i.accountId && i.serviceId && /spotify/i.test(String(i.objectId || '') + JSON.stringify(meta.container && meta.container.service || '')));
        if (sid) globalThis.soSpotify = { serviceId: sid.serviceId, accountId: sid.accountId };
        return json({
          acct: globalThis.soSpotify || null,
          provider: 'sonos', search: spotifyOn(env), playing: !!cur && cur.playbackState === 'PLAYBACK_STATE_PLAYING',
          track: tr ? { name: tr.name || (meta.container && meta.container.name) || '', by: (tr.artist && tr.artist.name) || '', album: (tr.album && tr.album.name) || '',
            art, ms: tr.durationMillis || 0 } : null,
          context: meta && meta.container ? spotifyUri(JSON.stringify(meta.container.id || '')) : '',
          next: nx && nx.name ? { name: nx.name, by: (nx.artist && nx.artist.name) || '' } : null,
          progress: pb ? pb.positionMillis || 0 : 0, device: cur ? cur.id : null,
          devices: groups.map((x, k) => ({ id: x.id, name: x.name, active: x.playbackState === 'PLAYBACK_STATE_PLAYING', volume: info[k][0] ? info[k][0].volume : null, canVolume: true }))
        }, 200, cors);
      }
      case 'playlists': {
        // Sonos Favorites first, then playlists saved in the Sonos app, then the Spotify account's own playlists
        const [f, pl, sp] = await Promise.all([
          so(env, 'GET', '/households/' + hh + '/favorites'),
          so(env, 'GET', '/households/' + hh + '/playlists').catch(() => null),
          spotifyOn(env) ? spotifyLists(env).catch(() => []) : []
        ]);
        globalThis.soSpotify = spotifyAccount(f.items) || globalThis.soSpotify;
        const items = (f.items || []).map(x => ({ name: x.name, uri: 'fav:' + x.id, open: spotifyUri(JSON.stringify((x.resource && x.resource.id) || '')),
            art: x.imageUrl || '', by: x.description || (x.service && x.service.name) || 'Favorite' }))
          .concat(((pl && pl.playlists) || []).map(x => ({ name: x.name, uri: 'sonospl:' + x.id, art: '', by: 'Sonos playlist' })))
          .concat(sp.map(x => ({ ...x, by: 'Spotify' + (x.by ? ' · ' + x.by : '') })));
        return json({ items }, 200, cors);
      }
      case 'tracks': return json(await spotifyTracks(env, url.searchParams.get('uri') || ''), 200, cors);
      case 'search': {
        if (!spotifyOn(env)) return json({ items: [] }, 200, cors);
        return json({ items: await spotifySearch(env, url.searchParams.get('q') || '') }, 200, cors);
      }
      case 'play': {
        const u = body.uri || '';
        if (u.startsWith('sonospl:')) await so(env, 'POST', need() + '/playlists', { playlistId: u.slice(8), playOnCompletion: true, action: 'REPLACE' });
        else if (u.startsWith('spotify:')) {
          // Spotify items play through the Spotify account linked in the Sonos app, learnt from a Spotify favorite
          const acct = globalThis.soSpotify || savedAcct(body) || spotifyAccount((await so(env, 'GET', '/households/' + hh + '/favorites')).items) || await playingSpotify(env, hh);
          const index = Math.max(0, +body.index || 0), far = index > 25; // past ~25 skips Cloudflare's request budget runs out, so play just that song
          const target = far && body.track ? body.track : u, type = target.split(':')[1].toUpperCase();
          await loadSpotify(env, need(), acct, {
            type: type === 'ARTIST' ? 'ARTIST' : type === 'ALBUM' ? 'ALBUM' : type === 'TRACK' ? 'TRACK' : 'PLAYLIST',
            objectId: target, queueAction: 'REPLACE', playbackAction: 'PLAY',
            playModes: body.index !== undefined ? { shuffle: false } : {}
          }).catch(e => { throw /^Play something/.test(e.message) ? e : new Error('Sonos wouldn\'t play that from here (' + e.message + '). Add it to Sonos Favorites to play it'); });
          // Start partway into a playlist or album: Sonos has no "jump to song" here, so wait for it to load, then skip forward and check where it landed
          if (index && !far) await skipTo(env, g, index, body.name || '', body.first || '');
        }
        else if (u) await so(env, 'POST', need() + '/favorites', { favoriteId: u.replace(/^fav:/, ''), playOnCompletion: true, action: 'REPLACE' });
        else await so(env, 'POST', need() + '/playback/play');
        return json({ acct: globalThis.soSpotify || null }, 200, cors);
      }
      case 'queue': {
        // Play next (after the current song) or add to the end of the queue
        const u = body.uri || '', acct = globalThis.soSpotify || savedAcct(body) || spotifyAccount((await so(env, 'GET', '/households/' + hh + '/favorites')).items) || await playingSpotify(env, hh);
        if (!/^spotify:track:/.test(u)) throw new Error('Only Spotify songs can be queued from here');
        await loadSpotify(env, need(), acct, { type: 'TRACK', objectId: u, queueAction: body.next ? 'INSERT_NEXT' : 'APPEND' });
        return json({}, 200, cors);
      }
      case 'pause': await so(env, 'POST', need() + '/playback/pause'); return json({}, 200, cors);
      case 'next': await so(env, 'POST', need() + '/playback/skipToNextTrack'); return json({}, 200, cors);
      case 'previous': await so(env, 'POST', need() + '/playback/skipToPreviousTrack'); return json({}, 200, cors);
      case 'volume': await so(env, 'POST', need() + '/groupVolume', { volume: Math.max(0, Math.min(100, Math.round(+body.percent || 0))) }); return json({}, 200, cors);
      case 'transfer': return json({}, 200, cors); // each room plays on its own; picking one just changes what the tab controls
    }
    return json({ error: 'unknown' }, 404, cors);
  } catch (e) {
    globalThis.soHousehold = null;
    return json({ error: 'sonos', message: String(e.message || e) }, 200, cors);
  }
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
