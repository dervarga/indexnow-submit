#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  DEFAULT_ENDPOINT,
  collectSitemapEntries,
  defaultKeyLocation,
  discoverSitemaps,
  isValidKey,
  partitionByHost,
  selectChanged,
  snapshot,
  submitUrls,
  verifyKeyFile,
} from './indexnow.mjs'

const HELP = `Submit a site's URLs to IndexNow (Bing, Yandex, Seznam, Naver, ...).

Usage:
  indexnow <site-url> [options]
  indexnow --config sites.json [options]

URLs come from the site's sitemap (found via robots.txt, /sitemap-index.xml
or /sitemap.xml) unless --url is given.

Options:
  -k, --key <key>           IndexNow key (default: $INDEXNOW_KEY)
      --key-location <url>  Key file URL (default: <site>/<key>.txt)
  -s, --sitemap <url>       Sitemap URL; repeatable (default: auto-discover)
  -u, --url <url>           Submit this URL instead of reading the sitemap; repeatable
  -c, --config <file>       JSON file listing several sites (see README)
      --state <file>        Only submit URLs that are new or whose <lastmod>
                            changed since the last successful run; updates the file
      --endpoint <url>      IndexNow endpoint (default: ${DEFAULT_ENDPOINT})
      --no-verify-key       Skip checking that the key file is live
  -n, --dry-run             Show what would be submitted, send nothing
  -h, --help                Show this help
`

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    key: { type: 'string', short: 'k' },
    'key-location': { type: 'string' },
    sitemap: { type: 'string', short: 's', multiple: true },
    url: { type: 'string', short: 'u', multiple: true },
    config: { type: 'string', short: 'c' },
    state: { type: 'string' },
    endpoint: { type: 'string' },
    'no-verify-key': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', short: 'n', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

if (opts.help || (!positionals.length && !opts.config)) {
  process.stdout.write(HELP)
  process.exit(opts.help ? 0 : 2)
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback
    throw new Error(`Cannot read ${file}: ${err.message}`)
  }
}

async function buildJobs() {
  const envKey = process.env.INDEXNOW_KEY
  const jobs = positionals.map((site) => ({
    site,
    key: opts.key ?? envKey,
    keyLocation: opts['key-location'],
    sitemaps: opts.sitemap,
    urls: opts.url,
  }))
  if (opts.config) {
    const config = await readJson(opts.config)
    const sites = Array.isArray(config) ? config : config.sites
    if (!Array.isArray(sites)) throw new Error(`${opts.config}: expected an array or { "sites": [...] }`)
    for (const s of sites) {
      jobs.push({
        site: s.site,
        key: s.key ?? opts.key ?? envKey,
        keyLocation: s.keyLocation,
        sitemaps: s.sitemaps ?? (s.sitemap ? [s.sitemap] : undefined),
        urls: opts.url,
      })
    }
    if (!opts.endpoint && config.endpoint) opts.endpoint = config.endpoint
  }
  return jobs
}

async function runJob(job, state) {
  const site = new URL(job.site).href
  const host = new URL(site).host
  const log = (msg) => console.log(`[${host}] ${msg}`)

  if (!isValidKey(job.key)) {
    throw new Error('missing or invalid key (8-128 chars of a-z, A-Z, 0-9, -). Use --key or INDEXNOW_KEY')
  }
  const keyLocation = job.keyLocation ?? defaultKeyLocation(site, job.key)

  if (!opts['no-verify-key']) {
    const check = await verifyKeyFile(keyLocation, job.key)
    if (!check.ok) throw new Error(check.reason)
    log(`key file OK: ${keyLocation}`)
  }

  const fromSitemap = !job.urls?.length
  let entries
  if (fromSitemap) {
    const sitemaps = job.sitemaps?.length ? job.sitemaps : await discoverSitemaps(site)
    entries = await collectSitemapEntries(sitemaps)
    log(`${entries.length} URL(s) in ${sitemaps.join(', ')}`)
  } else {
    entries = job.urls.map((loc) => ({ loc }))
  }

  const { own, foreign } = partitionByHost(entries, host)
  if (foreign.length) log(`skipping ${foreign.length} URL(s) not on ${host}, e.g. ${foreign[0].loc}`)

  let toSubmit = own
  if (state && fromSitemap) {
    toSubmit = selectChanged(own, state[host])
    log(`${toSubmit.length} new or changed since last run`)
  }

  if (!toSubmit.length) {
    log('nothing to submit')
    if (state && fromSitemap) state[host] = snapshot(own)
    return true
  }

  if (opts['dry-run']) {
    log(`dry run, would submit ${toSubmit.length} URL(s):`)
    for (const e of toSubmit) console.log(`  ${e.loc}`)
    return true
  }

  const results = await submitUrls({
    host,
    key: job.key,
    keyLocation,
    urls: toSubmit.map((e) => e.loc),
    endpoint: opts.endpoint ?? DEFAULT_ENDPOINT,
  })
  for (const r of results) log(`batch ${r.batch}: ${r.count} URL(s) -> ${r.status} ${r.message}`)

  const ok = results.every((r) => r.ok)
  if (ok && state && fromSitemap) state[host] = snapshot(own)
  return ok
}

async function main() {
  const jobs = await buildJobs()
  const state = opts.state ? await readJson(opts.state, {}) : null
  let failed = 0
  for (const job of jobs) {
    try {
      if (!(await runJob(job, state))) failed++
    } catch (err) {
      failed++
      let host = job.site
      try {
        host = new URL(job.site).host
      } catch {}
      console.error(`[${host}] ERROR: ${err.message}`)
    }
  }
  if (state && !opts['dry-run']) await writeFile(opts.state, JSON.stringify(state, null, 2) + '\n')
  if (failed) {
    console.error(`${failed} of ${jobs.length} site(s) failed`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
})
