# Huda Store

A standalone, mobile-first English and Arabic product catalog with an on-device graphical admin. The public storefront is a static React + TypeScript site; GitHub Pages hosts it for free. The admin is a local Node.js utility that edits catalog files on this computer. It has no online write endpoint, database, or hosted backend.

The included products and illustrations are development samples. Replace them with products and images you have permission to publish before launch. Contact information starts blank.

## Requirements

- Node.js 20.9 or newer
- Git installed and configured with your name/email
- For publishing: a GitHub repository and GitHub CLI credentials or another Git credential helper configured for Git pushes

## Run the storefront

```sh
npm ci
npm run dev
```

Validate and build a production version with `npm run validate` and `npm run build`. The generated static site is in `dist/`. The GitHub Pages workflow builds and deploys on each push to `main`, or when manually started from GitHub Actions.

## Open the graphical admin

From this project directory run:

```sh
npm run admin
```

Open the local URL printed by the command (default `http://127.0.0.1:4179/admin`) and leave the process running while you work. Stop it with Ctrl+C. The server binds only to loopback, requires a random per-run session token and same-origin requests for write actions, and serves no remote access. Do not forward the port to the internet. Close and restart the process if the admin session needs to be reset.

The admin can add, edit, rename, hide, restore, and delete products; manage bilingual categories; update product availability; change store name, tagline, logo, accent color and contact links; and preview product copy before saving it locally. IDs are permanent numeric references, generated above every reference ever used. Deleting a product leaves its ID reserved. Hidden items are excluded from the public catalog; unavailable items remain visible with their availability label.

Edits are written to the local project files. They are not public until you use **Publish to GitHub** in the admin. Product images are validated and optimized to WebP with medium and thumbnail variants under `public/images/<reference>/`; store logo images are optimized to `public/images/brand/logo.webp`.

## Configure GitHub publishing

The project folder is not initialized as a Git repository. To set it up, create a new empty GitHub repository, then run these commands from this directory (replace the repository address):

```sh
git init
git branch -M main
git add .
git commit -m "Set up Huda Store"
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

If you use GitHub CLI, sign in and connect its credential helper for Git with `gh auth login` followed by `gh auth setup-git`. Alternatively, configure your usual Git credential manager. The admin never reads or stores the credential itself.

In GitHub, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Future admin publishing uses the local `git` command and the Git credentials already configured on this computer. It stages project changes, creates a commit, and pushes `main` to `origin`. That push triggers the existing `.github/workflows/deploy.yml` workflow; GitHub Actions builds and deploys to Pages. Publishing does not happen until you press the button.

The workflow uses the repository's built-in Pages deployment permissions and contains no personal access token. For a custom domain, set the repository Actions variable `HUDA_SITE_URL` to the site's full HTTPS origin; otherwise SEO URLs are generated from GitHub repository context.

### Security limitations

GitHub Pages is static hosting and does not provide a trusted server that can write to the source repository. Browser-only administration cannot safely hold a GitHub credential: any token delivered to public browser code can be copied by visitors. This project therefore keeps administration on the operator's computer and delegates authentication to Git's configured credential helper. Do not add a GitHub token to frontend code, localStorage, or committed config. Public visitors have no catalog write endpoint. Anyone with access to the administrator's computer and its Git credentials can publish changes.

## Product data and images

- `src/data/products.json` stores product records.
- `src/data/used-refs.json` permanently reserves assigned reference numbers, including deleted items.
- `src/data/settings.json` stores store identity, contact information and bilingual categories.
- Existing catalog features include search, category filters, product details, favorites, recent views, sharing and WhatsApp/email inquiry links.
- English and Arabic remain available with RTL layout.

You can still use `npm run add-product -- ...` as a command-line alternative. The GUI is the recommended product management interface.

## SEO and site metadata

The page metadata and default title use Huda Store. On GitHub Pages, sitemap and robots URLs are generated from the Actions repository context. For a custom domain, configure `HUDA_SITE_URL` as described above. `https://example.com/` is used only as a safe local build fallback when no site URL is configured.
