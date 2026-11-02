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

2. In **Workers & Pages → huda-store-admin → Settings → Variables and Secrets**, set these production bindings as **Text** variables. `wrangler.jsonc` intentionally has no `vars` block; `keep_vars: true` preserves dashboard variables during `npx wrangler deploy`.

   | Variable | Production value |
   | --- | --- |
   | `GITHUB_OWNER` | `blacknight9` |
   | `GITHUB_REPO` | `huda_store` |
   | `ADMIN_GITHUB_USER_ID` | `22123586` |
   | `GITHUB_APP_ID` | App ID from the GitHub App settings |
   | `GITHUB_APP_CLIENT_ID` | Client ID from the GitHub App settings |
   | `GITHUB_INSTALLATION_ID` | Installation ID for the app installed on this repository |
   | `ALLOWED_ORIGIN` | `https://blacknight9.github.io` (origin only; no repository path) |
   | `PUBLIC_URL` | `https://blacknight9.github.io/huda_store` (no trailing slash) |
   | `OAUTH_CALLBACK_URL` | `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev/auth/callback` |

   Keep all nine values in the **Production** environment. Change the owner/repo and corresponding IDs/URLs there if repository ownership or domains change. Do not restore a `vars` object to `wrangler.jsonc` unless you intentionally want source-controlled values to own those Worker variables. The Worker name stays `huda-store-admin`.

3. Add the following three items in the same **Variables and Secrets** screen, each with type **Secret** in the **Production** environment. Enter values in Cloudflare's secret-value field; do not add values to GitHub Actions variables, `.env` files, `wrangler.jsonc`, or source control.

   | Secret name | Value to enter |
   | --- | --- |
   | `GITHUB_CLIENT_SECRET` | OAuth client secret from the GitHub App settings |
   | `GITHUB_APP_PRIVATE_KEY` | Entire PEM private key generated for the GitHub App, including its `BEGIN` and `END` lines |
   | `SESSION_SECRET` | A new random signing secret; generate one with `openssl rand -hex 32` and enter the output directly into Cloudflare |

   The `secrets.required` list in `wrangler.jsonc` checks that all three names exist before a Wrangler deploy. Cloudflare stores these as encrypted Worker secrets and does not reveal their values after saving. Never commit or paste the values into a public log.

4. Set `public/admin/config.json` `apiBase` to `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev` and make sure the Worker's `ALLOWED_ORIGIN` matches the Pages origin exactly.
5. Deploy only after configuring the GitHub App, production variables, and all three secrets:

   ```sh
   npm run worker:deploy
   ```

6. Check `https://huda-store-admin.<YOUR_WORKERS_DEV_SUBDOMAIN>.workers.dev/health` for `{"ok":true}`. This health route exposes no repository data or write capability.

The OAuth Client Secret, App private key, and session secret names are `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, and `SESSION_SECRET`. Their names are declared in `wrangler.jsonc`; their values and all nine non-secret runtime variables are configured in the Cloudflare dashboard. `keep_vars: true` prevents code deployments from replacing those dashboard variables.

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
