# indexnow-submit

Submit a site's URLs to [IndexNow](https://www.indexnow.org) (Bing, Yandex, Seznam, Naver and others) straight from its sitemap. Works as a CLI and as a GitHub Action. No dependencies, Node 20+.

What it does for each site:

1. Checks that the key file (`https://<host>/<key>.txt`) is live and contains the key.
2. Finds the sitemap via `robots.txt`, `/sitemap-index.xml` or `/sitemap.xml`, and follows sitemap indexes.
3. Keeps only URLs on the site's host (IndexNow rejects mixed hosts).
4. Optionally keeps only URLs that are new or whose `<lastmod>` changed (`--state`).
5. Posts them to `https://api.indexnow.org/indexnow` in batches of 10,000, retrying on 429 and 5xx.

## Setup per site

1. Generate a key, e.g. `openssl rand -hex 16`.
2. Publish it as `/<key>.txt` at the site root, containing only the key (in Astro: `public/<key>.txt`).
3. Make sure the sitemap uses the same host you submit (`www` vs apex).

## CLI

```sh
npm link            # once, from this repo; installs the `indexnow` command

indexnow https://www.example.org --key <key> --dry-run
indexnow https://www.example.org --key <key>
INDEXNOW_KEY=<key> indexnow https://www.example.org
indexnow https://www.example.org --key <key> --url https://www.example.org/new-page/
```

Run `indexnow --help` for all options.

### Many sites

`sites.json`:

```json
{
  "sites": [
    { "site": "https://www.drainfixbudapest.hu", "key": "e3d42ba9d0424749b7f1282f99783c77" },
    { "site": "https://www.other-site.com", "key": "…", "sitemap": "https://www.other-site.com/sitemap.xml" }
  ]
}
```

```sh
indexnow --config sites.json --state indexnow-state.json
```

`--state` remembers what was submitted, so the next run sends only new URLs and URLs whose `<lastmod>` changed. Without `<lastmod>` in the sitemap, only new URLs count as changed.

Exit code is 1 if any site fails.

### Response codes

| Code | Meaning |
|---|---|
| 200 | Submitted |
| 202 | Accepted, key validation pending (normal for a new key) |
| 400 | Bad request |
| 403 | Key not valid or key file not found |
| 422 | URLs don't belong to the host, or key mismatch |
| 429 | Too many requests (submitting too often) |

## GitHub Action

```yaml
- uses: dervarga/indexnow-submit@v1.1.0
  with:
    site: https://www.example.org
    key: ${{ secrets.INDEXNOW_KEY }}
    state: true   # optional: only send new/changed URLs
```

Inputs: `site`, `key`, `config`, `sitemap`, `state`, `dry-run`, `args` (extra CLI flags).

### `state: true`

Keeps the last submitted sitemap in the GitHub Actions cache and sends only URLs that are new or whose `<lastmod>` changed. The first run sends everything. Needs accurate `<lastmod>` values; without them only new URLs are detected.

GitHub evicts caches unused for 7 days. When that happens the next run sends the whole sitemap once, which is harmless. A schedule that runs at least twice a week keeps the cache alive.

Caches are per branch, so use triggers that run on the default branch (`schedule`, `workflow_dispatch`, `check_run`). Don't combine `state: true` with `deployment_status`.

### When to run

Pick the example that matches how the site is hosted and where its content lives, and copy it to `.github/workflows/indexnow.yml`:

| Example | Trigger | Use for |
|---|---|---|
| [`indexnow-on-vercel-deploy.yml`](examples/indexnow-on-vercel-deploy.yml) | Vercel production deployment succeeded | Small sites on Vercel; submits the whole sitemap each deploy |
| [`indexnow-on-cloudflare-pages.yml`](examples/indexnow-on-cloudflare-pages.yml) | "Cloudflare Pages" check run succeeded on the default branch, plus twice weekly | Sites on Cloudflare Pages whose content lives in the repo |
| [`indexnow-scheduled.yml`](examples/indexnow-scheduled.yml) | Every 6 hours | Sites whose content changes without a deploy (database-driven) |

Private repos: each run bills at least 1 Actions minute, and the free tier is 2,000 minutes a month across all private repos. Every 6 hours is about 120 minutes a month; hourly is about 720.

If this repo is private, allow other repos to use it: **Settings → Actions → General → Access → Accessible from repositories owned by the user**.

## Development

```sh
npm test
```

## Releasing

Workflows reference `@v1`. After changes, move the tag:

```sh
git tag -fa v1 -m v1 && git push -f origin v1
```
