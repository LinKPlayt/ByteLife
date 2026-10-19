# ByteLife — Ledger: A Life

A life simulation game that runs in the browser and installs as an app.

**Play:** https://linkplayt.github.io/ByteLife/

## Install it like an app
- **iPhone/iPad (Safari):** Share → *Add to Home Screen*
- **Android (Chrome):** menu ⋮ → *Install app* / *Add to Home screen*
- **Desktop (Chrome/Edge):** click the install icon in the address bar

Once installed it works offline. Your game saves automatically on the device and picks up where you left off when you reopen it (Start a new life is in the sound menu).

## Updating the game
Edit `index.html`, bump `CACHE` in `sw.js` (e.g. `ledger-v2`), and push to `main`.
GitHub Actions redeploys automatically.
