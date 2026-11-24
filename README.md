<div align="center">

# ❤️ HR Watch

**Live heart rate from your Polar H10 (or any Bluetooth heart rate strap), right in your browser.**

[**▶ Try it live**](https://YOUR-USERNAME.github.io/YOUR-REPO/)

![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)
![Free](https://img.shields.io/badge/price-free-brightgreen)
![No backend](https://img.shields.io/badge/backend-none-lightgrey)
![No tracking](https://img.shields.io/badge/tracking-none-lightgrey)

<img src="docs/screenshot.jpg" alt="HR Watch heart rate zones view: Zone 3 highlighted at 135 bpm, with time spent in each of the five zones" width="480">

</div>

## Why

You already own the sensor, so you shouldn't need a vendor app or an account to read your own heartbeat, and your health data shouldn't be sent back to its maker.

HR Watch is **free and open source**. It runs **entirely in your browser**: no install, no account, no server. Your data is **never sent anywhere**. The current session is saved only in your browser so it survives a reload (you can turn this off), and it leaves your device only if you export it yourself.

## Features

- **Graph Mode** — big BPM readout, max / average / min, session timer, chart of the last 1–30 minutes
- **Zone Mode** — the 5 standard training zones from your age or your own max heart rate, shown as columns with a cursor moving through the current zone, plus time spent in each zone
- **Explore** — zoom and drag through a whole session, with stats for the visible part and an overview strip
- **Export / import** — save sessions as JSON (re-importable) or CSV (spreadsheets), all as local files
- **Reliable** — reconnects automatically if the signal drops, and a page reload doesn't lose your session
- **Settings** — light and dark mode, max heart rate formula or override, CSV separator for Excel, screen-awake and more, remembered in your browser
- **Background recording (experimental, off by default)** — keeps recording when you switch to another app on your phone; see the note below
- **Demo mode** — try everything without a strap

> **About the zones:** max heart rate is estimated from your age (10–100) with `220 − age` or `208 − 0.7 × age`. These formulas are averages from studies of adults and can be off by 10+ bpm, and they don't suit young children. If you know your real max heart rate, enter it as an override in Settings (100–240 bpm) and the age is ignored.

> **About background recording (experimental):** phones normally pause a web page soon after you switch to another app, which stops the readings. To prevent that, HR Watch plays an **inaudible 15 Hz tone** while recording (below human hearing and below what phone speakers can reproduce). It is **off by default**: turn it on in **⚙ Settings → Experimental**. While active it shows a **♪ keep-alive** badge, and your phone may also show it as media playing. It works on Android Chrome and on iPhone in Safari with the WebBLE extension; other browsers are untested. It uses a bit more battery.

## Browser support

| Browser | Works? |
|---|---|
| Chrome, Edge (Windows, Mac, Android) | ✅ Out of the box |
| Brave | ⚙️ Enable `brave://flags/#brave-web-bluetooth-api` |
| Firefox, Safari | ❌ No Web Bluetooth |
| iPhone / iPad | ⚙️ Safari with the [WebBLE](https://apps.apple.com/app/id6761301368) extension, or the free [Bluefy](https://apps.apple.com/app/id1492822055) browser |

The in-app **Help** button has step-by-step instructions for each one.

## Install as an app

HR Watch can be installed like an app: its own icon, a full-screen window, and it opens offline.

- **Android, Windows, Mac (Chrome / Edge):** use **Install app** in the browser menu or the install icon in the address bar.
- **iPhone / iPad:** Share → **Add to Home Screen**. ⚠️ Bluetooth most likely **won't work** in the Home Screen app, because Safari extensions like WebBLE don't run there. Keep recording in Safari + WebBLE (or Bluefy); the installed app is still handy for **Explore**.

Installing changes nothing about privacy: it's the same page, still with no server and nothing sent anywhere.

## Run it yourself

No build step and no dependencies, just static files. Clone the repo, then serve the folder locally (Web Bluetooth needs `localhost` or `https`):

```sh
python -m http.server 8000
```

Open <http://localhost:8000>, press **Connect** and pick your strap. Any static host works too, e.g. GitHub Pages. The offline/install support is switched off on `localhost` so your edits show up immediately; open <http://localhost:8000/?sw> to test it.

## Releasing

To release, change `APP_VERSION` at the top of [`index.html`](index.html) to match the new tag, then commit and tag as usual. The version is shown in ⚙ Settings and added to the CSS/JS links, so browsers download fresh files instead of mixing old cached ones with a new release. The installed app's offline copy updates from the same number.

## License

[GNU GPL v3](LICENSE). Free to use, study, change and share.
