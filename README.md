# Frame dashboard

A one-page home dashboard sized for the 10.1" photo frame from Wes Bos's article
(<https://wesbos.com/hacking-smart-photo-frames>, code at `wesbos/photo-frame-dashboard`).

## What the frame is

The Amazon listing from the article ships one of two boards. Check **Settings → About** when it arrives.

| | BIUFRAME / Synergy 10X1 (the one in the video) | PF1007L / AiMOR (what the listing now often ships) |
| --- | --- | --- |
| Firmware string | `rk312x` | contains `A33` and `PF1007L` |
| Chip, RAM | Rockchip RK3126, 1 GB | Allwinner A33, 1 GB, Mali-400 |
| Android | 6.0.1 | 6.0.1 |
| Screen | 1280×800 landscape (800×1280 panel, rotated), 160 dpi, touch | same |
| Getting in | ADB over USB, accept the prompt; ships with `su` | Usually no ADB. Try USB, then network, then an SD-card boot patch |
| Wi-Fi | | 2.4 GHz only; MAC changes each boot, so reserve its IP by hand |

Either way the screen is **1280×800 landscape**, so the layout targets that.

## The approach

The article's route, which this follows:

1. Get root ADB on the frame (route depends on the board, above).
2. Replace the stock WebView 44 with **WebView 106**, the newest that runs on Android 6.
3. Install Wes's small **kiosk app** (`dashboard/kiosk/` in his repo), point it at our URL, and make it the Home app so the frame boots into the dashboard.
4. Host this page somewhere the frame can reach over HTTPS. It's served by GitHub Pages from `docs/` at https://ehoffman66.github.io/frame-dashboard/.

The page is plain HTML, CSS and JS with no build step, kept to what Chromium 106 supports.
Colors avoid 8-digit hex because Wes found the frame's WebView rejects it. No blur or heavy animation, since the GPU is a Mali-400.

## What's on it

A tab rail on the right edge switches between six screens. After two minutes without a touch it goes back to Home.

- **Home:** clock and date, weather now and a 5-day forecast (Open-Meteo, no API key), "Next up" with a countdown, tonight's dinner, and an agenda for today, tomorrow and later this week.
- **Calendar:** the next 7 days in columns, with arrows to page forward. "Add event" or the + under any day opens a form: title, day, time or all day, and which calendar.
- **Groceries:** tap to check off, type to add, or use the quick-add chips. "Clear checked" empties what's been bought. Once connected, the list is the **Groceries** project in Todoist (see below).
- **Meals:** dinner for each of the next 7 days. Tap a day to type one or pick from suggestions.
- **Cocktails:** your Cocktail Journal app (CONFIG.cocktailsUrl) inside the dashboard, loaded when the tab first opens; waits 15 min before going back Home.
- **To-do:** the household to-do list with who does each item. Checks reset each morning; tap and hold to remove one.
- **Sports:** Charlotte FC and the Checkers side by side: record, next game, the next three after it, and the conference table. Charlotte FC shows win/draw/loss odds from the same model as the Charlotte FC Stretch Run board; the Checkers show the picks from the Checkers Stats Board. The numbers come from `sports.json` next to the page, which the frame re-reads every 15 minutes; the two routines that refresh those boards will write it (format in [sports-feed.md](sports-feed.md)). Until the file is reachable, the page uses the copy built into `SPORTS` in the script.

The screen dims from 10pm to 6:30am (a touch brightens it for a minute) and reloads itself at 3am to clear memory.

**Where added items live:** groceries live in Todoist once it's connected. Everything else (events, meals, to-dos) is in the frame's own browser storage for now, so it survives reboots but only shows on the frame.
Events added on the frame are not written back to your real calendar yet; that needs the small server described under Calendar feed.

## Groceries in Todoist

The Groceries tab shows the open tasks in the Todoist project named in `CONFIG.groceriesProject` ("Groceries"; the frame creates it if it's missing).
Add items from the Todoist app on your phone and the frame picks them up within a minute while the tab is open, or within 5 minutes otherwise.
Checking an item on the frame completes it in Todoist, and tapping it again reopens it. "Clear checked" only tidies the frame.

To connect, the frame needs your Todoist API token (Todoist on the web: Settings → Integrations → Developer). Either:
- tap "Connect Todoist" at the bottom of the Groceries tab and paste it, or
- pass it once in the kiosk URL, so it needn't be typed on the frame:
  `adb shell am start -n com.wesbos.homehq/.MainActivity --es url "https://ehoffman66.github.io/frame-dashboard/#todoist=YOUR_TOKEN"`

The token is saved only in the frame's browser storage, never in this repo. The page reads it from the `#` part of the URL, which browsers don't send to GitHub, then removes it from the address.
If Todoist can't be reached, the tab keeps showing the last copy and says so at the bottom.

**Typing on the frame:** adding items needs an on-screen keyboard. Some PF1007L units ship without the usual Android system screens, so check that a keyboard appears when you tap a text box. Quick-add chips and meal suggestions work without one.

## Settings

Edit `CONFIG` at the top of the script in `src/dashboard.html`. It's set to Charlotte, NC: weather for Charlotte, and the clock and calendar pinned to Eastern time (`America/New_York`) even if the frame's own clock zone is wrong. Also there: °F or °C, 12 or 24-hour clock,
the calendar feed URL, and the night hours. Then run `sh build.sh` to produce `docs/index.html`, which GitHub Pages serves at https://ehoffman66.github.io/frame-dashboard/.

## Calendar feed

The Calendar tab, Home's agenda and the Meals tab read from a small Cloudflare Worker that turns your Google calendars' private iCal links into JSON.
Setup steps are in [worker/README.md](worker/README.md). The Worker's URL holds a secret, so it's passed to the frame once in the kiosk URL (`#calendar=...`) rather than written into this public page.
Until it's connected, the page shows sample events and the corner chip on Home says so.

Any URL returning this JSON also works, set as `CONFIG.calendarUrl`:

```json
{ "events": [{ "title": "Soccer practice", "start": "2026-10-15T20:30:00Z", "end": "2026-10-15T22:00:00Z", "allDay": false, "calendar": "family", "color": "#f0b35e" },
             { "title": "Picture day", "start": "2026-10-16", "allDay": true, "calendar": "family" }],
  "meals": { "2026-10-15": "Tacos" } }
```

## Day one checklist

0. **Got a PF1006?** Start with [setup-pf1006.md](setup-pf1006.md); Wes's guides don't cover it yet.
1. **Don't put the frame on Wi-Fi yet.** On the PF1007L the stock app gives the vendor's server a root shell. Read `docs/aimor-remote-root-shell.md` in Wes's repo first.
2. Settings → About: note the model and firmware string. That picks the guide:
   - `rk312x`: `docs/biuframe-setup-guide.md`
   - `PF1007L` / `A33`: `docs/pf1007l-start-here.md`
3. Use a **USB-A to USB-C data cable**. USB-C to USB-C gives the PF1007L no power or data.
4. Install the Android platform tools on your computer (`adb`), plug in, run `adb devices`.
5. Back up before any write, then follow the guide through WebView 106 and the kiosk app.
6. Point the kiosk at the dashboard, with the Todoist token and calendar Worker URL in the `#` part:
   `adb shell am start -n com.wesbos.homehq/.MainActivity --es url "https://ehoffman66.github.io/frame-dashboard/#todoist=YOUR_TOKEN&calendar=https://frame-calendar.<your-subdomain>.workers.dev/<KEY>"`
7. Touch on the PF1007L may merge two fingers into one, so the kiosk's two-finger menu may not open. Keep ADB available as the way back in.
