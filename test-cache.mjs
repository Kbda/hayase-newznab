// Cache tests: node test-cache.mjs (needs `npm i` for fake-indexeddb)
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import ext, { ResultCache } from './newznab.js'

const name = '[SubsPlease] Tensei Shitara Ken Deshita S2 - 01 (1080p) [EA337770].mkv'
const opts = { apiKey: 'SECRETKEY', apiUrl: 'https://nzbfinder.ws/api' }
const hitXml = `<rss><channel><item><title>[SubsPlease] Tensei Shitara Ken Deshita S2 - 01 (1080p) [EA337770]</title>
<guid>https://nzbfinder.ws/details/abc</guid>
<enclosure url="https://nzbfinder.ws/getnzb/abc.nzb&amp;r=SECRETKEY" type="application/x-nzb"/>
<newznab:attr name="size" value="1"/></item></channel></rss>`

const counting = (body) => {
  const fn = async () => { fn.n++; return { ok: true, status: 200, text: async () => body } }
  fn.n = 0
  return fn
}

// Hayase's add-then-play double call: second lookup costs no API hit
{
  const f = counting(hitXml)
  const a = await ext.batch({ hash: 'h1', name, files: [name], fetch: f }, opts)
  const b = await ext.single({ hash: 'h1', name, file: name, fetch: f }, opts)
  assert.equal(a, 'https://nzbfinder.ws/getnzb/abc.nzb&r=SECRETKEY')
  assert.equal(b, a)
  assert.equal(f.n, 1)
}

// concurrent identical lookups share one request
{
  const f = counting(hitXml.replaceAll('EA337770', 'BB000001'))
  const n2 = name.replace('EA337770', 'BB000001')
  const [a, b] = await Promise.all([
    ext.single({ hash: 'h2', name: n2, file: n2, fetch: f }, opts),
    ext.single({ hash: 'h2', name: n2, file: n2, fetch: f }, opts)
  ])
  assert.ok(a && a === b)
  assert.equal(f.n, 1)
}

// API key never stored; restored with the *current* key on read
{
  const db = await ext.cache.db
  const stored = await new Promise(resolve => {
    const req = db.transaction('q').objectStore('q').getAll()
    req.onsuccess = () => resolve(req.result)
  })
  const dump = JSON.stringify(stored)
  assert.ok(stored.length > 0)
  assert.ok(!dump.includes('SECRETKEY'), dump)
  assert.ok(dump.includes('{{APIKEY}}'))

  const f = counting('<rss/>')
  const url = await ext.single({ hash: 'h1', name, file: name, fetch: f }, { ...opts, apiKey: 'NEWKEY' })
  // new key -> different cache key? No: cache keys exclude the API key, so this is a hit with the new key restored
  assert.equal(f.n, 0)
  assert.equal(url, 'https://nzbfinder.ws/getnzb/abc.nzb&r=NEWKEY')
}

// persists across instances (i.e. across worker restarts)
{
  const fresh = new ResultCache()
  const [k] = [...ext.cache.mem.keys()]
  assert.ok(await fresh.get(k))
}

// misses are cached too (shorter TTL), expired entries refetch
{
  const c = new ResultCache()
  await c.set('x', [], 50)
  assert.deepEqual(await c.get('x'), [])
  await new Promise(r => setTimeout(r, 80))
  assert.equal(await c.get('x'), undefined)
}

// failures (timeouts, HTTP errors) are not cached
{
  const bad = async () => ({ ok: false, status: 503, text: async () => '' })
  const n3 = name.replace('EA337770', 'CC000002')
  await assert.rejects(ext.single({ hash: 'h3', name: n3, file: n3, fetch: bad }, opts), /503/)
  const f = counting('<rss/>')
  await ext.single({ hash: 'h3', name: n3, file: n3, fetch: f }, opts)
  assert.ok(f.n > 0)
}

// cache: false bypasses entirely
{
  const f = counting(hitXml)
  await ext.single({ hash: 'h1', name, file: name, fetch: f }, { ...opts, cache: false })
  assert.equal(f.n, 1)
}

console.log('cache tests passed')
