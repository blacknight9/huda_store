# Huda Store

Huda Store is a standalone bilingual English/Arabic product catalog. The public storefront is a static React + TypeScript site for GitHub Pages. The graphical online admin lives at `/admin`; a Cloudflare Worker handles GitHub sign-in, short-lived sessions, authorization, and repository writes. Product data, branding, and optimized images live in this repository. There is no database or local administration server.

## Run and verify locally

Requirements: Node.js 20.9+ and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

The admin UI is included in the static build at `/admin/`. It becomes operational after the Worker and OAuth configuration below are deployed. In development, `public/admin/config.json` must point to the Worker URL and its configured `ALLOWED_ORIGIN` must match the page origin.

## Online admin security model

The **Sign in with GitHub** flow uses GitHub App OAuth authorization code plus PKCE and state. The Worker exchanges the code, verifies GitHub's numeric account ID (`22123586` for `blacknight9`), then discards the OAuth user token. Each repository operation uses a short-lived GitHub App installation token minted inside the Worker from its private key. The browser receives only a signed, two-hour HttpOnly session cookie and a CSRF token held in page memory. The Worker validates the session, exact allowed Origin, and CSRF token on every write. A stale catalog commit SHA returns a conflict, and the Git ref update is non-forced.

No GitHub credential belongs in `public/`, browser storage, or committed config. The Worker rate limits requests per isolate on a best-effort basis; Cloudflare may run multiple isolates, so these in-memory limits are not a global quota. Do not enable preview environments with production secrets.

Sessions are stateless, so logout clears the browser cookie and access ends after the two-hour expiry. A copied session cookie cannot be revoked centrally before expiry without adding shared storage; protect the signed-in device and use the GitHub account's security controls if it is lost.

### GitHub App setup

1. At <https://github.com/settings/apps/new>, create a GitHub App named **Huda Store Admin**. Set the homepage to the catalog URL. Leave webhooks disabled. Enable **Request user authorization (OAuth) during installation**.
2. Set the callback URL to `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev/auth/callback`. The Worker URL is fixed by its name and your Cloudflare `workers.dev` subdomain. Use that identical callback in `wrangler.jsonc` and the GitHub App settings.
3. Grant repository permissions: **Contents: Read and write**. Metadata remains read-only. Do not grant Actions, Administration, or other permissions. Install the App only on `blacknight9/huda_store`.
4. Record the App ID and Client ID. Create a client secret. Under the App installation, get its installation ID (for example, `gh api /user/installations --jq '.installations[] | select(.app_slug=="huda-store-admin") | .id'`). Keep the App private key downloaded securely; do not commit it.
5. The allowlisted account is pinned in Worker config by immutable GitHub user ID `22123586`. If the authorized human changes, verify the replacement account's numeric ID before changing `ADMIN_GITHUB_USER_ID`.

### Cloudflare Worker setup

1. Install Wrangler 4 (the project commands use `npx wrangler@4`) and authenticate:

   ```sh
   npx wrangler@4 login
   npx wrangler@4 whoami
   ```

2. Edit `wrangler.jsonc`: replace the App ID, App Client ID, installation ID, Worker callback URL, and public catalog URL placeholders. Keep `GITHUB_OWNER`, `GITHUB_REPO`, and `ADMIN_GITHUB_USER_ID` as ordinary configuration (change them deliberately if ownership changes). The Worker is configured as `huda-store-admin`.
3. Set Worker-only secrets interactively; never put secret values in shell history, source, or `wrangler.jsonc`:

   ```sh
   npx wrangler@4 secret put GITHUB_CLIENT_SECRET
   npx wrangler@4 secret put GITHUB_APP_PRIVATE_KEY
   npx wrangler@4 secret put SESSION_SECRET
   ```

   `GITHUB_APP_PRIVATE_KEY` is the full PEM private key. Generate a random session signing secret locally with `openssl rand -hex 32` and paste it at Wrangler's prompt.
4. Set `public/admin/config.json` `apiBase` to `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev` and make sure its `ALLOWED_ORIGIN` matches the Pages origin exactly.
5. Deploy only after configuring the GitHub App and secrets:

   ```sh
   npm run worker:deploy
   ```

6. Check `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev/health` for `{"ok":true}`. This health route exposes no repository data or write capability.

The OAuth Client Secret, App private key, and session secret names are `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `SESSION_SECRET`. Non-secret Worker vars are declared in `wrangler.jsonc`: `GITHUB_OWNER`, `GITHUB_REPO`, `ADMIN_GITHUB_USER_ID`, `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_INSTALLATION_ID`, `ALLOWED_ORIGIN`, `PUBLIC_URL`, and `OAUTH_CALLBACK_URL`.

### GitHub Pages setup and publishing

Keep the existing `.github/workflows/deploy.yml`. In the repository, set **Settings → Pages → Build and deployment → Source → GitHub Actions**. The workflow builds the static site and deploys on commits to `main`. Every admin save is one commit through the Worker GitHub API, so it triggers the same workflow. Product data remains in `src/data/`; product variants are stored under `public/images/<reference>/`, and the logo under `public/images/brand/logo.webp`.

**Current repository limitation:** this repository was previously verified as private, and GitHub rejected Pages activation because the current account plan does not allow Pages for private repositories. To use free Pages, make the repository public, or keep it private and use an eligible GitHub plan. This project has not changed repository visibility or Pages settings, and nothing has been deployed by this setup. Resolve this plan constraint before enabling publication.

The Pages URL for the current repository name is `https://blacknight9.github.io/huda_store/`. It will serve only once Pages is eligible and enabled.

### Browser cookie limitation

GitHub Pages on `github.io` and a Worker on `workers.dev` are different sites. The session cookie uses `SameSite=None; Secure; HttpOnly` so credentialed cross-origin admin requests can carry it. Some browsers and privacy modes block third-party cookies, so online login may not persist there. For broad browser compatibility, configure a custom domain for Pages and route the Worker through a sibling subdomain of that same site (then update `PUBLIC_URL`, `ALLOWED_ORIGIN`, `OAUTH_CALLBACK_URL`, `apiBase`, and the GitHub App callback URL). The Pages path and Worker API must still use HTTPS.

### Free-tier and operating limits

The Worker uses no database, and makes a few GitHub API calls per read or write. It uses Cloudflare's free Workers allowance (currently 100,000 requests/day and a 10 ms CPU limit per invocation; verify current limits in your Cloudflare dashboard). Large catalog trees and large image batches can approach CPU, request-body, GitHub API, or Pages build limits. Image files are converted in the browser to WebP variants; the Worker checks WebP signatures, caps each variant at 3 MB, each save at 8 source images, and total optimized variants at 16 MB. Cloudflare's CPU allowance is not configurable on the free plan; if image commits hit CPU limits, reduce the batch size. There is no globally shared rate-limit state without durable storage, intentionally omitted to avoid a database.

## Features and catalog data

The online admin supports adding/editing/renaming products, permanent unique numeric references, hide/restore/delete, optimized multi-image uploads, bilingual categories, availability, store name/tagline/logo/accent/contact settings, and a preview step before each product commit. Deletion permanently reserves its reference. Product edits use optimistic commit checks to avoid stale overwrites. The storefront keeps search, filters, product details, favorites, recent views, sharing, inquiry links, and Arabic RTL support.

- `src/data/products.json`: catalog records.
- `src/data/used-refs.json`: permanent reference registry.
- `src/data/settings.json`: store, contact, and category settings.
- `worker/index.js`: OAuth, sessions, validation, and GitHub API operations.
- `public/admin/`: static admin interface; it contains no credentials.
- `wrangler.jsonc`: Worker bindings and non-secret configuration.

## Do not publish from this checkout yet

This checkout has no configured GitHub OAuth App or Cloudflare secrets. Repository authentication alone is not enough to verify the online OAuth flow or deploy the Worker. The Worker and UI can be built and tested with mocks locally; live OAuth, Cloudflare deployment, and Pages deployment must be verified after the required account setup. Do not push until those credentials and the Pages eligibility issue are resolved.
