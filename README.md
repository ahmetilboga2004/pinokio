# Pinokio

A Chrome extension that pins comments to page elements. You can save comments locally, or sync them with a team through Supabase.

- **Local comments**: work right away, no backend needed.
- **Team comments**: need a Supabase project. Sign-in is Google or GitHub only. There is no anonymous sign-in.

## What you need

- Node.js 22.12 or newer
- Chrome (or another Chromium browser)
- A free Supabase account — only for team features
- A Google account and a GitHub account — only for sign-in

## Step 1 — Install and build

```bash
npm ci
npm run build
```

The finished extension is now in the `dist/` folder. (Bun also works: `bun install --frozen-lockfile` and `bun run build`.)

For development: `npm run dev`.

## Step 2 — Create a Supabase project

> **Warning**: the setup SQL deletes all data and all users in the project it runs in. Use a new project only for Pinokio.

1. Go to <https://supabase.com> and sign in.
2. Click **New project**.
3. Pick a name, a strong database password (save it somewhere safe), and a region.
4. Wait until the project is ready.

## Step 3 — Load the database schema

1. In the Supabase dashboard, open **SQL Editor**.
2. Open the `supabase.sql` file from this repo. Copy the whole file.
3. Paste it into SQL Editor and click **Run**. Run the whole file as one run.

This creates the five Pinokio tables and the security rules. Running it again deletes all Pinokio data and all users.

## Step 4 — Turn off anonymous sign-in

1. In Supabase, open **Authentication → Sign In / Providers**.
2. Set **Allow anonymous sign-ins** to **OFF**.
3. Keep **Allow new users to sign up** **ON**.

## Step 5 — Get Google OAuth credentials

The Google Cloud Console now uses the **Google Auth Platform** screens. (Older consoles call this "APIs & Services → OAuth consent screen".)

First, register your app once:

1. Go to <https://console.cloud.google.com>. Create a project or pick one at the top.
2. Open **Google Auth Platform**: <https://console.cloud.google.com/auth/overview>.
3. Click **Get started**.
4. Fill in an app name and your user support email.
5. Pick **External** as the audience.
6. Add your email as the contact, accept the policy, and finish.

Then, create the OAuth client:

1. Open the **Clients** page: <https://console.cloud.google.com/auth/clients>.
2. Click **Create client**.
3. Choose **Web application** and give it a name.
4. Under **Authorized redirect URIs**, add the callback URL from **Supabase → Authentication → Providers → Google**. It looks like `https://PROJECT_REF.supabase.co/auth/v1/callback`.
5. Click **Create**.

Finally, connect it to Supabase:

1. Copy the **Client ID** and **Client Secret** right away. The secret is shown only once — after that, only its last 4 characters are visible.
2. In Supabase, open **Authentication → Providers → Google**, enable it, and paste both values.

## Step 6 — Get GitHub OAuth credentials

You get these from GitHub. The direct link is <https://github.com/settings/developers>.

First, find the callback URL:

1. In Supabase, open **Authentication → Sign In / Providers**.
2. Click **GitHub** in the list to expand it.
3. Copy the **Callback URL** shown there. It looks like `https://PROJECT_REF.supabase.co/auth/v1/callback` (same URL as in Step 5).

Then, create the OAuth app on GitHub:

1. On GitHub, click your profile picture (top right) → **Settings**.
2. In the left sidebar (bottom), click **Developer settings**.
3. Click **OAuth Apps** → **New OAuth App**. (First time ever, the button says **Register a new application**.)
4. Fill in:
   - **Application name**: for example `Pinokio`
   - **Homepage URL**: your repository or project page URL
   - **Authorization callback URL**: the Supabase callback URL you copied above
5. Leave **Enable Device Flow** unchecked.
6. Click **Register application**.

Finally, connect it to Supabase:

1. On the app page, copy the **Client ID**.
2. Click **Generate a new client secret** and copy the secret.
3. In Supabase, open **Authentication → Providers → GitHub**, enable it, and paste both values.

## Step 7 — Create your .env file

1. In Supabase, open **Project Settings → API Keys**.
2. Copy the **Project URL** and the **publishable key**.
3. Copy `.env.example` to `.env` and fill it in:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_public_key
```

The publishable key is safe for the browser. Never put a service-role key or a client secret in this file. `.env` is ignored by Git.

Then rebuild so the values go into the extension:

```bash
npm run build
```

## Step 8 — Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Open a normal website and click the Pinokio toolbar icon.

## Step 9 — Add the extension redirect URL

1. On the extension card in `chrome://extensions/`, copy the **ID** from the **Identity** section (a 32-character string). Chrome never shows a full URL anywhere — you build it yourself from the ID.
2. In Supabase, open **Authentication → URL Configuration**.
3. Click **Add URL** under **Redirect URLs** (the list, not the Site URL field) and add:

```
https://EXTENSION_ID.chromiumapp.org/pinokio
```

Replace `EXTENSION_ID` with your ID. Example: ID `abcdefghijklmnopabcdefghijklmnop` becomes `https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/pinokio`.

Tip: also add `https://*.chromiumapp.org/pinokio` as a wildcard entry. Then sign-in keeps working when the unpacked extension ID changes on another machine or folder.

Sign-in works after this step. A different computer can get a different unpacked extension ID, so without the wildcard entry, add each new ID here.

## Step 10 — After a code change

1. Run `npm run build`.
2. Click **Reload** on the extension card.
3. Reload your website tabs too.

Removing and loading the extension again clears its saved session and team selection.

## Troubleshooting sign-in

**"Error: Authorization page could not be loaded"**

This error means the sign-in popup could not finish the redirect chain. Work through this list in order:

1. **Redirect URL missing (most common).** The sign-in window opens, you pick your account and continue, then the popup closes with this error. Cause: Supabase does not recognize the extension's redirect URL, so it falls back to the Site URL (`http://localhost:3000`) instead. Fix: add the exact URL from Step 9 to **Authentication → URL Configuration → Redirect URLs** (the list, not the Site URL field).
2. **Provider callback URL points to an old project.** This happens after switching to a new Supabase project. Fix the provider's callback on the provider's own site:
   - Google: <https://console.cloud.google.com/auth/clients> → your client → **Authorized redirect URIs** → `https://PROJECT_REF.supabase.co/auth/v1/callback` (your new project's callback).
   - GitHub: <https://github.com/settings/developers> → your OAuth app → **Authorization callback URL** → same address.
3. **Provider not enabled in Supabase.** Check **Authentication → Providers** and make sure the provider is on with a valid client ID and secret.

**How to test without the extension:** open this URL in a normal browser tab and follow the sign-in:

```
https://PROJECT_REF.supabase.co/auth/v1/authorize?provider=github&redirect_to=https://EXTENSION_ID.chromiumapp.org/pinokio
```

- You end on `...chromiumapp.org/pinokio?code=...` with "site can't be reached" → the whole chain works. This is the expected end point; only the extension can open that address.
- You end on `http://localhost:3000` or your Site URL → the redirect URL from Step 9 is missing or does not match exactly.
- You see a provider error page → check item 2 above.

## Everyday use

- **Browse mode**: normal page use. Open **Comments** and pick one to go back to it.
- **Edit mode**: click a page element to select it. Hold **Shift** and click to select a parent element.
- Save with **Save**, **Ctrl+Enter**, or **Cmd+Enter**.
- **Escape** closes a Pinokio dialog.
- Drag the toolbar to move it.
- Click the toolbar icon again to turn Pinokio off for that tab.

## Limits

Some pages stay out of reach: Chrome system pages, closed shadow roots, iframes, canvas, and not-yet-mounted virtual lists. If a saved element is gone or changed, attach the comment again.

## Run the tests

```bash
npx playwright install chromium
npm test
npx tsc --project tests/tsconfig.json
```

## Security notes

- Only Google and GitHub sign-in. The database refuses anonymous and all other providers.
- The extension only holds the publishable key. All private rules run on the Supabase server.
- `supabase.sql` contains schema only, no secrets.

## Code map

- `src/content/PinokioOverlay.ts` — overlay UI, element selection, navigation
- `src/content/pageBridge.ts` — link clicks inside the page
- `src/content/TeamUI.ts` — team panel and sign-in
- `src/core/supabase.ts` — team data and OAuth sign-in
- `src/core/selectorResolver.ts` — element selectors and fallbacks
- `src/core/storage.ts` — extension storage
- `src/background/serviceWorker.ts` — tab state and saved comments
