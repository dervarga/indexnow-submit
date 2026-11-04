// Core IndexNow logic: sitemap discovery and parsing, key verification,
// change detection, and batched submission. No dependencies; Node >= 20.

export const DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow'
export const MAX_URLS_PER_REQUEST = 10_000
const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/
const MAX_SITEMAP_DEPTH = 5

export function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key)
}

export function defaultKeyLocation(siteUrl, key) {
  return new URL(`/${key}.txt`, siteUrl).href
}

const decodeXml = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()

/**
 * Parse a sitemap or sitemap index.
 * @returns {{ type: 'index' | 'urlset', entries: { loc: string, lastmod?: string }[] }}
 */
export function parseSitemap(xml) {
  const type = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset'
  const tag = type === 'index' ? 'sitemap' : 'url'
  const blockRe = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'gi')
  const field = (block, name) => {
    const m = block.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'))
    return m ? decodeXml(m[1]) : undefined
  }
  // Image/video/news/xhtml extensions carry their own <*:loc>; drop them so
  // only the page's own <loc> and <lastmod> are read.
  const extRe = /<(\w+):(image|video|news)\b[\s\S]*?<\/\1:\2>|<\w+:link\b[^>]*\/?>/gi
  const entries = []
  for (const [, rawBlock] of xml.matchAll(blockRe)) {
    const block = rawBlock.replace(extRe, '')
    const loc = field(block, 'loc')
    if (!loc) continue
    const lastmod = field(block, 'lastmod')
    entries.push(lastmod ? { loc, lastmod } : { loc })
  }
  return { type, entries }
}

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'indexnow-submit' } })
  if (!res.ok) {
    const err = new Error(`GET ${url} -> HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.text()
}

/** Find sitemap URLs for a site: robots.txt `Sitemap:` lines, else common defaults. */
export async function discoverSitemaps(siteUrl, { fetch: fetchImpl = fetch } = {}) {
  try {
    const robots = await fetchText(new URL('/robots.txt', siteUrl).href, fetchImpl)
    const found = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
    if (found.length) return found
  } catch {
    // no robots.txt; fall through to defaults
  }
  for (const path of ['/sitemap-index.xml', '/sitemap.xml']) {
    const url = new URL(path, siteUrl).href
    try {
      await fetchText(url, fetchImpl)
      return [url]
    } catch {
      // try next
    }
  }
  throw new Error(`No sitemap found for ${siteUrl} (checked robots.txt, /sitemap-index.xml, /sitemap.xml)`)
}

/** Fetch sitemaps recursively (following sitemap indexes) and return unique URL entries. */
export async function collectSitemapEntries(sitemapUrls, { fetch: fetchImpl = fetch } = {}) {
  const seenSitemaps = new Set()
  const entries = new Map()
  const visit = async (url, depth) => {
    if (seenSitemaps.has(url) || depth > MAX_SITEMAP_DEPTH) return
    seenSitemaps.add(url)
    const { type, entries: found } = parseSitemap(await fetchText(url, fetchImpl))
    if (type === 'index') {
      for (const e of found) await visit(e.loc, depth + 1)
    } else {
      for (const e of found) if (!entries.has(e.loc)) entries.set(e.loc, e)
    }
  }
  for (const url of sitemapUrls) await visit(url, 0)
  return [...entries.values()]
}

/** Check that the key file is reachable and contains exactly the key. */
export async function verifyKeyFile(keyLocation, key, { fetch: fetchImpl = fetch } = {}) {
  let body
  try {
    body = await fetchText(keyLocation, fetchImpl)
  } catch (err) {
    return { ok: false, reason: `key file not reachable: ${err.message}` }
  }
  const content = body.replace(/^﻿/, '').trim()
  if (content !== key) return { ok: false, reason: `key file at ${keyLocation} does not contain the key` }
  return { ok: true }
}

/** Split entries by whether their host matches `host`. */
export function partitionByHost(entries, host) {
  const own = []
  const foreign = []
  for (const e of entries) {
    let h
    try {
      h = new URL(e.loc).host
    } catch {
      foreign.push(e)
      continue
    }
    ;(h === host ? own : foreign).push(e)
  }
  return { own, foreign }
}

/**
 * Keep entries that are new or whose lastmod changed since the last run.
 * `previous` maps url -> lastmod ('' when the sitemap had no lastmod).
 */
export function selectChanged(entries, previous = {}) {
  return entries.filter((e) => !(e.loc in previous) || (e.lastmod ?? '') !== previous[e.loc])
}

export function snapshot(entries) {
  return Object.fromEntries(entries.map((e) => [e.loc, e.lastmod ?? '']))
}

const STATUS_TEXT = {
  200: 'OK, URLs submitted',
  202: 'Accepted, key validation pending',
  400: 'Bad request (invalid format)',
  403: 'Forbidden (key not valid or key file not found)',
  422: 'Unprocessable (URLs do not belong to the host or key mismatch)',
  429: 'Too many requests',
}

export function describeStatus(status) {
  return STATUS_TEXT[status] ?? `HTTP ${status}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Submit URLs in batches. Retries 429 and 5xx responses.
 * @returns {Promise<{ batch: number, count: number, status: number, ok: boolean, message: string }[]>}
 */
export async function submitUrls(
  { host, key, keyLocation, urls, endpoint = DEFAULT_ENDPOINT },
  { fetch: fetchImpl = fetch, retries = 3, retryDelayMs = 2000 } = {}
) {
  const results = []
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
    const urlList = urls.slice(i, i + MAX_URLS_PER_REQUEST)
    const body = JSON.stringify({ host, key, keyLocation, urlList })
    let res
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body,
      })
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= retries) break
      await sleep(retryDelayMs * 2 ** attempt)
    }
    const ok = res.status === 200 || res.status === 202
    let detail = ''
    if (!ok) detail = (await res.text().catch(() => '')).trim().slice(0, 500)
    results.push({
      batch: results.length + 1,
      count: urlList.length,
      status: res.status,
      ok,
      message: describeStatus(res.status) + (detail ? `: ${detail}` : ''),
    })
  }
  return results
}
