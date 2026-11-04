import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import {
  collectSitemapEntries,
  discoverSitemaps,
  isValidKey,
  parseSitemap,
  partitionByHost,
  selectChanged,
  snapshot,
  submitUrls,
  verifyKeyFile,
} from '../src/indexnow.mjs'

const KEY = 'e3d42ba9d0424749b7f1282f99783c77'
const run = promisify(execFile)
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname

/** Fake fetch serving a fixed map of url -> body (string) or status (number). */
const fakeFetch = (routes) => async (url) => {
  const r = routes[url]
  if (r === undefined) return new Response('not found', { status: 404 })
  if (typeof r === 'number') return new Response('', { status: r })
  return new Response(r, { status: 200 })
}

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.ex.org/sitemap-0.xml</loc></sitemap>
</sitemapindex>`
const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.ex.org/</loc><lastmod>2026-11-01</lastmod></url>
  <url><loc>https://www.ex.org/a?x=1&amp;y=2</loc><changefreq>weekly</changefreq></url>
  <url><loc><![CDATA[https://www.ex.org/b/]]></loc></url>
</urlset>`

describe('parseSitemap', () => {
  it('parses a sitemap index', () => {
    assert.deepEqual(parseSitemap(INDEX), {
      type: 'index',
      entries: [{ loc: 'https://www.ex.org/sitemap-0.xml' }],
    })
  })
  it('parses a urlset with lastmod, entities and CDATA', () => {
    assert.deepEqual(parseSitemap(URLSET), {
      type: 'urlset',
      entries: [
        { loc: 'https://www.ex.org/', lastmod: '2026-11-01' },
        { loc: 'https://www.ex.org/a?x=1&y=2' },
        { loc: 'https://www.ex.org/b/' },
      ],
    })
  })
  it('ignores image, video and alternate-link locations', () => {
    const xml = `<urlset><url>
      <image:image><image:loc>https://x.org/img.jpg</image:loc></image:image>
      <xhtml:link rel="alternate" hreflang="hu" href="https://x.org/hu/"/>
      <video:video><video:content_loc>https://x.org/v.mp4</video:content_loc><video:loc>https://x.org/v</video:loc></video:video>
      <loc>https://x.org/page/</loc><lastmod>2026-01-01</lastmod>
    </url></urlset>`
    assert.deepEqual(parseSitemap(xml).entries, [{ loc: 'https://x.org/page/', lastmod: '2026-01-01' }])
  })
  it('handles namespace prefixes', () => {
    const xml = '<ns:urlset><ns:url><ns:loc>https://x.org/</ns:loc></ns:url></ns:urlset>'
    assert.deepEqual(parseSitemap(xml).entries, [{ loc: 'https://x.org/' }])
  })
})

describe('sitemap discovery and collection', () => {
  it('uses Sitemap lines from robots.txt', async () => {
    const fetch = fakeFetch({
      'https://www.ex.org/robots.txt': 'User-agent: *\nSitemap: https://www.ex.org/sitemap-index.xml\n',
    })
    assert.deepEqual(await discoverSitemaps('https://www.ex.org/', { fetch }), [
      'https://www.ex.org/sitemap-index.xml',
    ])
  })
  it('falls back to /sitemap.xml', async () => {
    const fetch = fakeFetch({ 'https://www.ex.org/sitemap.xml': URLSET })
    assert.deepEqual(await discoverSitemaps('https://www.ex.org/', { fetch }), ['https://www.ex.org/sitemap.xml'])
  })
  it('throws when no sitemap exists', async () => {
    await assert.rejects(discoverSitemaps('https://www.ex.org/', { fetch: fakeFetch({}) }), /No sitemap found/)
  })
  it('follows sitemap indexes and dedupes', async () => {
    const fetch = fakeFetch({
      'https://www.ex.org/sitemap-index.xml': INDEX,
      'https://www.ex.org/sitemap-0.xml': URLSET,
    })
    const entries = await collectSitemapEntries(
      ['https://www.ex.org/sitemap-index.xml', 'https://www.ex.org/sitemap-0.xml'],
      { fetch }
    )
    assert.equal(entries.length, 3)
  })
})

describe('key handling', () => {
  it('validates key format', () => {
    assert.ok(isValidKey(KEY))
    assert.ok(!isValidKey('short'))
    assert.ok(!isValidKey('has space in it'))
    assert.ok(!isValidKey(undefined))
  })
  it('verifies the key file, tolerating BOM and whitespace', async () => {
    const loc = `https://www.ex.org/${KEY}.txt`
    assert.deepEqual(await verifyKeyFile(loc, KEY, { fetch: fakeFetch({ [loc]: `﻿${KEY}\n` }) }), { ok: true })
    assert.equal((await verifyKeyFile(loc, KEY, { fetch: fakeFetch({ [loc]: 'other' }) })).ok, false)
    assert.equal((await verifyKeyFile(loc, KEY, { fetch: fakeFetch({}) })).ok, false)
  })
})

describe('filtering', () => {
  it('partitions by host', () => {
    const { own, foreign } = partitionByHost(
      [{ loc: 'https://www.ex.org/' }, { loc: 'https://ex.org/' }, { loc: 'nope' }],
      'www.ex.org'
    )
    assert.equal(own.length, 1)
    assert.equal(foreign.length, 2)
  })
  it('selects new and changed entries', () => {
    const entries = [
      { loc: 'https://x/a', lastmod: '2' },
      { loc: 'https://x/b' },
      { loc: 'https://x/c', lastmod: '1' },
    ]
    const prev = { 'https://x/a': '1', 'https://x/b': '', 'https://x/c': '1' }
    assert.deepEqual(
      selectChanged(entries, prev).map((e) => e.loc),
      ['https://x/a']
    )
    assert.equal(selectChanged(entries, {}).length, 3)
    assert.deepEqual(snapshot(entries), { 'https://x/a': '2', 'https://x/b': '', 'https://x/c': '1' })
  })
})

describe('submitUrls', () => {
  it('batches by 10,000 and posts the IndexNow payload', async () => {
    const bodies = []
    const fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return new Response('', { status: 200 })
    }
    const urls = Array.from({ length: 10_001 }, (_, i) => `https://www.ex.org/${i}`)
    const results = await submitUrls(
      { host: 'www.ex.org', key: KEY, keyLocation: `https://www.ex.org/${KEY}.txt`, urls },
      { fetch }
    )
    assert.deepEqual(
      results.map((r) => [r.count, r.ok]),
      [
        [10_000, true],
        [1, true],
      ]
    )
    assert.equal(bodies[0].host, 'www.ex.org')
    assert.equal(bodies[0].key, KEY)
    assert.equal(bodies[1].urlList[0], 'https://www.ex.org/10000')
  })
  it('retries 429 then succeeds; reports failures', async () => {
    const statuses = [429, 202]
    let calls = 0
    const fetch = async () => new Response('', { status: statuses[calls++] })
    const [r] = await submitUrls({ host: 'h', key: KEY, keyLocation: 'k', urls: ['u'] }, { fetch, retryDelayMs: 1 })
    assert.equal(calls, 2)
    assert.equal(r.status, 202)
    assert.ok(r.ok)

    const bad = async () => new Response('URL not on host', { status: 422 })
    const [r2] = await submitUrls({ host: 'h', key: KEY, keyLocation: 'k', urls: ['u'] }, { fetch: bad })
    assert.equal(r2.ok, false)
    assert.match(r2.message, /422|Unprocessable/)
    assert.match(r2.message, /URL not on host/)
  })
})

describe('CLI end to end', () => {
  async function withServer(fn) {
    const submissions = []
    const server = createServer((req, res) => {
      const base = `http://127.0.0.1:${server.address().port}`
      if (req.method === 'POST' && req.url === '/indexnow') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          submissions.push(JSON.parse(body))
          res.writeHead(200).end()
        })
        return
      }
      const routes = {
        '/robots.txt': `Sitemap: ${base}/sitemap-index.xml\n`,
        '/sitemap-index.xml': `<sitemapindex><sitemap><loc>${base}/s0.xml</loc></sitemap></sitemapindex>`,
        '/s0.xml': `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/prices/</loc></url><url><loc>https://other.org/x</loc></url></urlset>`,
        [`/${KEY}.txt`]: KEY,
      }
      if (routes[req.url] === undefined) return res.writeHead(404).end()
      res.writeHead(200).end(routes[req.url])
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      await fn(base, submissions)
    } finally {
      server.close()
    }
  }

  it('submits sitemap URLs on the site host and keeps state', async () => {
    await withServer(async (base, submissions) => {
      const dir = await mkdtemp(join(tmpdir(), 'indexnow-'))
      const stateFile = join(dir, 'state.json')
      const args = [CLI, base, '--key', KEY, '--endpoint', `${base}/indexnow`, '--state', stateFile]

      const first = await run(process.execPath, args)
      assert.match(first.stdout, /key file OK/)
      assert.match(first.stdout, /skipping 1 URL/)
      assert.equal(submissions.length, 1)
      assert.deepEqual(submissions[0].urlList, [`${base}/`, `${base}/prices/`])
      assert.equal(submissions[0].host, new URL(base).host)

      const second = await run(process.execPath, args)
      assert.match(second.stdout, /nothing to submit/)
      assert.equal(submissions.length, 1)
      assert.ok(JSON.parse(await readFile(stateFile, 'utf8'))[new URL(base).host])
    })
  })

  it('reads a config file and supports dry runs', async () => {
    await withServer(async (base, submissions) => {
      const dir = await mkdtemp(join(tmpdir(), 'indexnow-'))
      const config = join(dir, 'sites.json')
      await writeFile(config, JSON.stringify({ sites: [{ site: base, key: KEY }] }))
      const { stdout } = await run(process.execPath, [CLI, '--config', config, '--dry-run'])
      assert.match(stdout, /would submit 2 URL/)
      assert.equal(submissions.length, 0)
    })
  })

  it('fails when the key file does not match', async () => {
    await withServer(async (base) => {
      await assert.rejects(run(process.execPath, [CLI, base, '--key', 'ffffffffffffffff']), (err) => {
        assert.equal(err.code, 1)
        assert.match(err.stderr, /key file not reachable/)
        return true
      })
    })
  })
})
