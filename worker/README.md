# Calendar Worker

A small Cloudflare Worker that reads your Google calendars' private iCal links and gives the frame the next six weeks of events, with repeating events expanded and times in Charlotte time.
It also fills the Meals tab from the Meal Plan calendar. Results are cached for 5 minutes; the frame asks every 10.

The code is [`calendar.js`](calendar.js). It needs no build step and fits Cloudflare's free plan.

## Set it up (about 10 minutes)

1. **Get each calendar's secret iCal address.** In Google Calendar on a computer: Settings (gear) → under *Settings for my calendars* click the calendar → *Integrate calendar* → copy **Secret address in iCal format**.
   Do this for Family, your own calendar (erik.m.hoffman@gmail.com), Alex & Erik Nomad Calendar, and Meal Plan.
   Treat these like passwords: anyone with one can read that calendar.
2. **Make the Worker.** Sign up free at <https://dash.cloudflare.com>, then *Workers & Pages* → *Create* → *Create Worker*. Name it `frame-calendar` and click *Deploy*.
3. **Paste the code.** Click *Edit code*, replace everything with the contents of [`calendar.js`](calendar.js), and click *Deploy*.
4. **Add two secrets.** Go to the Worker's *Settings* → *Variables and Secrets* → *Add*, type **Secret**:
   - `KEY`: any long random string, for example 30+ letters and numbers from a password manager.
   - `FEEDS`: this list, with your four secret addresses pasted in:
     ```json
     [
       {"name": "family",   "color": "#f0b35e", "url": "PASTE Family address"},
       {"name": "erik",     "color": "#72b4da", "url": "PASTE your own address"},
       {"name": "nomad",    "color": "#a9c98a", "url": "PASTE Nomad address"},
       {"name": "holidays", "color": "#c9a0dc", "url": "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"},
       {"name": "meals",    "meals": true,      "url": "PASTE Meal Plan address"}
     ]
     ```
   Leave out a line to hide that calendar. Add more lines the same way.
5. **Check it.** Open `https://frame-calendar.<your-subdomain>.workers.dev/<KEY>` in a browser. You should see JSON with your events. If a calendar's address is wrong, it's listed under `errors`. Any other path returns "Not found".
6. **Point the frame at it.** Add it to the kiosk URL along with the Todoist token:
   ```
   adb shell am start -n com.wesbos.homehq/.MainActivity --es url "https://ehoffman66.github.io/frame-dashboard/#todoist=YOUR_TOKEN&calendar=https://frame-calendar.<your-subdomain>.workers.dev/<KEY>"
   ```
   The frame saves both, then removes them from the address. The "Sample data" chip on Home changes to "Live" once both weather and calendar load.

## Notes

- Dinners typed on the frame win over the Meal Plan calendar for that day. Clear the frame's entry to go back to the calendar.
- Events added on the frame still stay on the frame; they are not written to Google Calendar.
- Google can take a few hours to reflect changes in its iCal links. This is a Google limit, not the Worker's.
- Test the date maths with `node worker/test/expand.test.mjs`.

## Spotify for the Music tab (about 5 minutes)

The Music tab plays Spotify on the Sonos speakers. Spotify only allows this on Premium accounts. The Worker keeps the Spotify login, so the tablet and the public page never hold it.

1. **Make a Spotify app.** Go to <https://developer.spotify.com/dashboard> on a computer, log in with your Spotify account, and click *Create app*.
   - App name: `Frame dashboard`. Description: anything.
   - Redirect URI: `https://frame-calendar.<your-subdomain>.workers.dev/spotify/callback` (click *Add*).
   - Tick *Web API*, accept the terms, and click *Save*.
2. **Copy its two values into the Worker.** In the app's *Settings*, copy the **Client ID** and **Client secret** (*View client secret*). In Cloudflare add them as Secrets named `SPOTIFY_ID` and `SPOTIFY_SECRET`, then deploy the latest [`calendar.js`](calendar.js).
3. **Sign in once.** On your computer or phone (not the tablet), open `https://frame-calendar.<your-subdomain>.workers.dev/spotify/login` and approve. The page shows a long value: add it as a Secret named `SPOTIFY_REFRESH`.

That's it: the Music tab uses the calendar address the frame already has. If a Sonos room is missing from the speaker list, play something on it from the Spotify app once and it appears.

## Sonos for the Music tab (recommended)

Spotify often won't show Sonos speakers to apps, so the Music tab can talk to Sonos directly instead. It then lists every room, controls play/pause, skip and volume, and plays your **Sonos Favorites** (tap the heart on a playlist or station in the Sonos app to add one). Once these secrets are set, the tab uses Sonos instead of Spotify.

1. **Make a Sonos integration.** Sign up free at <https://developer.sonos.com>, then *My Account* → *Integrations* → *New Control Integration*. Give it a name (`Frame dashboard`) and add a key.
   - Redirect URI: `https://frame-calendar.<your-subdomain>.workers.dev/sonos/callback`. Save.
2. **Copy its Key and Secret into the Worker** as Secrets named `SONOS_ID` and `SONOS_SECRET`, and deploy the latest [`calendar.js`](calendar.js).
3. **Sign in once.** On your computer or phone, open `https://frame-calendar.<your-subdomain>.workers.dev/sonos/login`, sign in with your Sonos account and allow access. Add the long value it shows as a Secret named `SONOS_REFRESH`.
