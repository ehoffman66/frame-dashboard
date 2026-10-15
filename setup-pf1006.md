# Setting up the Aimor PF1006

Wes Bos's guides cover the BIUFRAME (Rockchip) and the Aimor PF1007L (Allwinner A33). The PF1006 isn't in the article, in his repo's device list or in the docs we could read.
It's probably a close cousin of the PF1007L, but that isn't confirmed. So the first job is to find out which board it really has, using checks that only read and never write.

## Before you start

- **Keep the frame off Wi-Fi.** On the PF1007L the stock Aimor app lets the vendor's server run any command as root (`imsconnect.efercro.com`, port 7806). Assume the PF1006 does too until we know otherwise.
- **Cable:** a **USB-A to USB-C data cable**, plugged straight into the computer (no USB 3 hub). On the PF1007L, USB-C to USB-C gave no power and no data, and the cable in the box may be charge-only.
- **On your computer:** Android platform tools (`adb`). On a Mac: `brew install android-platform-tools`.

## Step 1: identify the board (read-only)

1. On the frame: **Settings → About**. Note the model, Android version and the full build or firmware string, and take a photo of the screen.
   - Contains `A33` (like `...-A33-...-PF1007L-...-AIMOR...`): Allwinner, the PF1007L family.
   - Contains `rk312x`: Rockchip, the BIUFRAME family.
2. Plug in the cable and run:
   ```
   adb devices -l
   ```
   On a Mac, also run this to see the USB IDs even if adb lists nothing:
   ```
   system_profiler SPUSBDataType | grep -i -B4 -A8 'frame\|1f3a\|2207\|android'
   ```
   - `1f3a` is Allwinner, `2207` is Rockchip.
   - If adb lists the frame, look at the frame's screen for an "Allow USB debugging" prompt and tap Allow.

Send the About photo and both outputs back in the thread.

## Step 2: if adb sees the frame

Run these. All of them only read:
```
adb shell id
adb shell getprop ro.build.fingerprint
adb shell getprop ro.hardware
adb shell getprop ro.product.model
adb shell wm size
adb shell wm density
adb shell dumpsys package com.android.webview | grep versionName
adb shell pm list packages | grep -i -E 'aimor|efercro|yhk|devicetest|homehq'
```
- `uid=0(root)` from the first line means the shell is already root, as on the PF1007L.
- The PF1007L's values are `ro.hardware` = `sun8i` and a fingerprint starting `AEEZO/astar_m86_8723cs`.

Then **back up before any change**, as the guide for the matching board says.

## Step 3: if adb doesn't see the frame

This is the usual stock state on the PF1007L (it shows up as `1f3a:1000`, which is storage only). Wes's routes for the PF1007L, in order, are:
1. Network ADB on port 5555. First block outbound TCP 7806 on the router, then join Wi-Fi briefly and run `adb connect <frame-ip>:5555`.
2. A temporary root ADB trick through the Aimor app. It only works on one PF1007L firmware.
3. An SD-card boot patch. This writes to the frame, and it checks the boot image's hash, so a PF1006 would almost certainly be refused.

Don't run 2 or 3 until we've compared your firmware with the PF1007L's. Wes's repo asks owners of untested units to open an issue with the read-only results first: <https://github.com/wesbos/photo-frame-dashboard/issues>

## After root ADB works

Follow Wes's guide for the matching board. For an A33 that's `docs/allwinner-a33-pf1007l.md` in his repo. In order:
1. Back up.
2. Block the vendor ports.
3. Upgrade WebView 44 to 106. This swaps files under `/system`; `adb install` alone isn't enough.
4. Install a spare launcher.
5. Build and install the kiosk app (`com.wesbos.homehq`), make it the Home app, then disable the Aimor app and its updater.

**Don't disable the Aimor app until** the kiosk works and you can reach Settings from it. One PF1007L got locked out that way.

Then point the kiosk at the dashboard:
```
adb shell am start -n com.wesbos.homehq/.MainActivity --es url "https://ehoffman66.github.io/frame-dashboard/#todoist=YOUR_TOKEN&calendar=https://frame-calendar.<your-subdomain>.workers.dev/<KEY>"
```

Known WebView 106 catch: it lacks the Let's Encrypt root certificate, so sites using it fail to load. If Todoist or the calendar Worker show as unreachable on the frame, that's the first thing to check.
