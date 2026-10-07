# Interactive MAM103X

![alt text](<Screenshot 2026-10-16 at 14.27.11.png>)

![alt text](<Screenshot 2026-10-16 at 14.27.00.png>)

One Cloudflare Worker that serves every project under `schmebb.com/Interactive`.

```
public/
  Interactive/
    index.html              → schmebb.com/Interactive          (the hub)
    RowEchelon/index.html   → schmebb.com/Interactive/RowEchelon
    ComplexNumbers/         → schmebb.com/Interactive/ComplexNumbers  (copy your existing site files in here)
```

## Moving an existing project in
1. Make a folder `public/Interactive/<Name>/` and copy the project's files into it. The main page must be `index.html`.
2. If the project links to its own files with absolute paths (`/style.css`, `/app.js`), change them to relative (`style.css`, `./app.js`) so they resolve inside the folder.
3. Add a card for it in `public/Interactive/index.html` (copy an existing `<li>`).
4. Add `<script defer src="/Interactive/track.js"></script>` just before `</body>` so its visits show up on the admin page.

## Admin stats
`schmebb.com/Interactive/Admin` shows visits for the whole site and for each project (password-protected).
Each page loads `/Interactive/track.js`, which reports anonymous visits to `src/worker.js`; they are stored in a
Durable Object that `wrangler deploy` creates automatically. The password is stored as a
Cloudflare secret (only its SHA-256, never in the repo). To set or change it:
`echo -n "newpassword" | shasum -a 256`, then `npx wrangler secret put ADMIN_PASSWORD_SHA256` and paste the hex.
For local `wrangler dev`, put `ADMIN_PASSWORD_SHA256=<hex>` in `.dev.vars` (gitignored).

## Deploy
```
npx wrangler deploy
```
The route in `wrangler.jsonc` sends `schmebb.com/Interactive*` to this Worker; everything else on schmebb.com is untouched.
Folder URLs work with or without a trailing slash (`/Interactive/RowEchelon` redirects to `/Interactive/RowEchelon/`).

## Old addresses
Once a project lives here, you can point its old Cloudflare site at the new URL with a redirect rule
(Rules → Redirect Rules) or, for a Pages project, a `_redirects` file containing:
```
/*  https://schmebb.com/Interactive/ComplexNumbers/  301
```
