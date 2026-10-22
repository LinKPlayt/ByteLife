# Instagram auto-posting: setup guide

Social Hub can publish to Instagram automatically at the time you schedule, even with the page closed. To do that it needs a small server of your own that holds your Instagram sign-in and posts for you. This guide sets one up for free. It takes about 20–30 minutes, and you won't need to install anything or write any code.

You'll do four things:

1. Make your Instagram account a professional account (2 min)
2. Create a Meta developer app so Instagram lets your server post (10 min)
3. Create a free Cloudflare account and let GitHub deploy the server to it (10 min)
4. Connect everything in Social Hub (3 min)

> Meta's and Cloudflare's websites change their wording from time to time. If a button has a slightly different name, look for the closest match.

---

## 1. Switch Instagram to a professional account

Instagram only allows automatic posting to **Business** or **Creator** accounts. Switching is free and you can switch back.

In the Instagram app: **Profile → ☰ menu → Settings and privacy → Account type and tools → Switch to professional account**. Pick **Creator** or **Business**.

---

## 2. Create a Meta developer app

1. Go to **[developers.facebook.com](https://developers.facebook.com/)** and log in with Facebook. If it's your first time, click **Get started** and verify your account.
2. Click **My Apps → Create app**.
   - **App name:** `Social Hub` (anything works).
   - **Use case:** choose **Manage messaging & content on Instagram**.
   - If it asks about a business portfolio, choose **I don't want to connect a business portfolio yet**.
   - Finish creating the app.
3. In the app's dashboard, open **Use cases**, then **Customize** next to the Instagram use case, then **API setup with Instagram login**.
4. Copy the **Instagram app ID** and **Instagram app secret** (click *Show*). Keep them somewhere safe for step 3.
   - These are **not** the "App ID" shown at the top of the page. Use the ones labelled *Instagram*.
5. Add yourself as a tester:
   - In the left menu go to **App roles → Roles → Add People → Instagram Tester** and enter your Instagram username.
   - Accept the invite: open **[instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)** in a browser, go to the **Tester invites** tab, and click **Accept**.
   - Repeat for any other Instagram account you want to post to.

Leave the app in **Development** mode. That's all you need to post to your own accounts, and there's no app review to go through. You'll add one more setting to this app in step 4.

---

## 3. Deploy the server to Cloudflare (from GitHub)

### Cloudflare account

1. Sign up for free at **[dash.cloudflare.com](https://dash.cloudflare.com/sign-up)**. You won't need a card.
2. In the left menu, open **Compute (Workers) → Workers & Pages** once. If it asks you to pick a `workers.dev` subdomain, choose any name. Your server's address will end in it.
3. Copy your **Account ID**. It's shown on the Workers & Pages overview page, or on your account's home page under *Account ID*. You can also find it in the URL: `dash.cloudflare.com/<account id>/...`.
4. Create an API token so GitHub can deploy for you:
   - Click your profile icon → **My Profile → API Tokens → Create Token**.
   - Next to **Edit Cloudflare Workers**, click **Use template**.
   - Under **Permissions**, click **+ Add more** and add: **Account → D1 → Edit**.
   - Under **Account Resources**, pick your account. Under **Zone Resources**, leave **All zones**.
   - Click **Continue to summary → Create Token** and copy the token. Cloudflare only shows it once.

### Passcode

Your server is protected by a passcode, so only you can schedule posts on it. To get one, open **Social Hub → Settings → Instagram auto-posting → Generate passcode** and copy it.

### GitHub secrets

1. Open the repository on GitHub: **[github.com/LinKPlayt/ByteLife](https://github.com/LinKPlayt/ByteLife)**.
2. Go to **Settings → Secrets and variables → Actions → New repository secret**, and add these five, one at a time:

   | Name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the Cloudflare token from above |
   | `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare Account ID |
   | `IG_APP_ID` | the Instagram app ID from step 2 |
   | `IG_APP_SECRET` | the Instagram app secret from step 2 |
   | `ADMIN_PASSCODE` | the passcode you generated |

3. Go to the **Actions** tab, choose **Deploy Social Hub server** on the left, and click **Run workflow → Run workflow**.
4. After a minute or two it turns green ✅. Click the run. The summary at the bottom shows two things you'll need next:
   - **Server address**, like `https://social-hub-server.yourname.workers.dev`
   - **Redirect URL**, the same address with `/auth/callback` on the end

---

## 4. Connect it all

1. **In your Meta app:** go back to **API setup with Instagram login**. Under **Set up Instagram business login**, open **Business login settings**, paste the **Redirect URL** into **OAuth redirect URIs**, and click **Save**.
2. **In Social Hub:** open **Settings → Instagram auto-posting**, paste the **Server address** and your **passcode**, and click **Connect to server**.
3. Click **+ Connect Instagram account**, log in to Instagram, and allow access. You'll come back to Social Hub with the account connected and marked **⚡ Auto**.

That's it. In a new post, tick the ⚡ account, add a photo or video, pick a time and save. It goes out automatically within a minute of that time, and the post shows **✓ Posted ↗** with a link once it's live.

---

## What it can post

| | |
|---|---|
| **Photos** | Converted to JPEG and cropped to fit Instagram's shapes (4:5 tall to 1.91:1 wide) before uploading. |
| **Carousels** | 2–20 photos and/or videos. Instagram crops every item to the shape of the first one. |
| **Reels** | One MP4 or MOV video, up to 25 MB here (Instagram allows 3 seconds to 15 minutes). Vertical 9:16 looks best. |
| **Captions** | Up to 2,200 characters, 30 hashtags and 20 @mentions. Links in captions aren't clickable on Instagram. |
| **Limit** | Instagram allows 100 automatic posts per account per day. |

It **can't** do Stories, text-only posts, music, people tags, collaborators or locations. Instagram doesn't let apps do these, or doesn't let them without its app review.

**Sign-in:** Instagram sign-ins last 60 days. The server renews them automatically while it's running, so you shouldn't need to reconnect. If you change your Instagram password, or remove the app in Instagram, reconnect the account in Settings.

**Cost:** everything here fits inside Cloudflare's free plan for personal use. That covers 100,000 requests a day, 1 GB for waiting photos and videos, and 5 GB of database. Uploads are deleted once they've been posted.

---

## Troubleshooting

**Instagram says the app isn't available, or "Insufficient developer role"**
Your Instagram account isn't an accepted tester yet. Redo step 2.5 and make sure you clicked **Accept** under *Tester invites*.

**"Invalid redirect_uri" or "URL blocked" when connecting**
The Redirect URL in your Meta app doesn't exactly match the one in Social Hub (Settings shows it under the connected-server details). Copy it again, with no extra spaces or slashes.

**"Wrong passcode"**
The passcode in Social Hub must match the `ADMIN_PASSCODE` secret. To change it, update the secret on GitHub, run the **Deploy Social Hub server** workflow again, then enter the new one in Social Hub.

**"Couldn't reach your Social Hub server"**
Check the server address in Settings. Opening it in a browser should show "Social Hub server is running."

**The GitHub workflow failed**
Open the failed run to read the error.
- *Authentication error*: the API token is missing the **D1 → Edit** permission, or `CLOUDFLARE_ACCOUNT_ID` is wrong.
- *workers.dev subdomain*: open **Workers & Pages** in Cloudflare once to set one up, then run the workflow again.

**A post shows "Failed"**
Hover over or tap the chip to see Instagram's reason, fix it (for example, edit the post), then press **Retry**. Short glitches are retried automatically.

---

## Security

- The **passcode** is the key to your server: anyone who has it can post to your connected accounts. Keep it private. Social Hub leaves it out of exported backups.
- Your Instagram sign-in tokens are stored only in your own Cloudflare account and are never sent to the browser.
- Uploaded photos and videos are stored at long random addresses that only Instagram is given. They're deleted after posting, and leftovers expire after 180 days.
- Disconnecting an account in Settings deletes its sign-in from the server and cancels its scheduled posts.

---

## For developers

The server is a single Cloudflare Worker (`src/worker.js`). It uses D1 for accounts and jobs, KV for uploads, and a once-a-minute cron trigger that moves each due post through Instagram's create-container → wait-until-processed → publish steps. Each step is saved, so a crash picks up where it left off.

```sh
cd server
npm install
npm test        # runs the worker locally against a fake Instagram API
npx wrangler dev --test-scheduled   # local server; trigger the cron at /__scheduled
```

Pushing changes under `server/` to `main` redeploys automatically once the secrets above are set.
