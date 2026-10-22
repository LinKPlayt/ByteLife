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

## Social Hub
`social/` is a separate page for planning social media posts: https://linkplayt.github.io/ByteLife/social/

- Add your Instagram, Facebook, TikTok, X, YouTube, LinkedIn, Threads, Bluesky and Pinterest accounts, with quick links to each profile and inbox.
- Write a post once, pick the accounts it goes to, and see each site's length limit as you type.
- Schedule posts on a calendar; drafts, due-now and posted lists keep track of what's left.
- **Post** copies the caption and opens the site (with the text filled in on X, Threads, Bluesky and LinkedIn). Tick each account off once it's up.
- **Trending** shows what's popular right now: Wikipedia's most-read pages in 14 languages, trending hashtags and most-shared news from Mastodon, and Bluesky's trending topics, plus links to Google, TikTok, X, YouTube, Pinterest and Spotify trends by country. Any trend can be turned into a new post.
- Log follower counts to track growth, save reusable hashtag sets, and export a backup.

- **Instagram auto-posting** (optional): connect your Instagram Business or Creator account and photos, carousels and Reels publish automatically at the scheduled time, even with the page closed. This needs a free server of your own on Cloudflare, which a GitHub Action deploys for you. See [server/SETUP.md](server/SETUP.md).

Your plans are stored in your browser. Apart from Instagram accounts you connect to your own server, Social Hub doesn't log in to or post from your accounts.
