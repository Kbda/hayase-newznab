// Hayase NZB extension for any Newznab-compatible indexer.
// Self-contained ESM (no imports), so no bundling step is needed.
//
// Hayase hands us the torrent it picked ({ hash, name, file | files }).
// Newznab can't look up by infoHash, so we search by release name and only
// return an NZB whose release name matches the torrent (exact by default),
// because Hayase needs the same bytes it would have gotten from the swarm.

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|webm|ts|m2ts|wmv|mov)$/i

class NZBSourceBase {
  async test () { throw new Error('test not implemented') }
  async single () { return undefined }
  async batch () { return undefined }
}

// ---------- helpers ----------

export function normalize (str = '') {
  return str
    .split(/[\\/]/).pop()                 // basename only
    .replace(VIDEO_EXT, '')
    .toLowerCase()
    .replace(/[[\](){}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const tokens = s => new Set(normalize(s).split(' ').filter(Boolean))

export function similarity (a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .trim()

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decode(m[1]) : undefined
}

// Web Workers have no DOMParser, so parse the RSS with regexes.
export function parseItems (xml) {
  const err = xml.match(/<error\b[^>]*description="([^"]*)"/i)
  if (err) throw new Error(`Indexer error: ${decode(err[1])}`)

  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, body]) => {
    const attrs = {}
    for (const [, k, v] of body.matchAll(/<(?:newznab|torznab):attr\s+name="([^"]+)"\s+value="([^"]*)"/gi)) {
      attrs[k.toLowerCase()] = decode(v)
    }
    const enclosure = body.match(/<enclosure\b[^>]*url="([^"]+)"/i)
    const guid = attrs.guid || tag(body, 'guid')?.split('/').pop()
    return {
      title: tag(body, 'title') || '',
      guid,
      link: enclosure ? decode(enclosure[1]) : tag(body, 'link'),
      size: Number(attrs.size) || 0
    }
  })
}

// ---------- extension ----------

export default new class Newznab extends NZBSourceBase {
  cfg (options = {}) {
    const apiUrl = (options.apiUrl || 'https://nzbfinder.ws/api').replace(/\/+$/, '')
    if (!options.apiKey) throw new Error('Set your indexer API key in the extension settings.')
    return {
      apiUrl,
      apiKey: options.apiKey,
      cat: (options.categories || '').trim(),
      fuzzy: options.fuzzy === true || options.fuzzy === 'true',
      threshold: Number(options.fuzzyThreshold) || 0.85
    }
  }

  async search (q, c, fetchFn) {
    const params = new URLSearchParams({ t: 'search', q, apikey: c.apiKey, extended: '1', limit: '100' })
    if (c.cat) params.set('cat', c.cat)
    const res = await fetchFn(`${c.apiUrl}?${params}`)
    if (!res.ok) throw new Error(`Indexer returned HTTP ${res.status}.`)
    return parseItems(await res.text())
  }

  nzbUrl (item, c) {
    if (item.link && /^https?:/i.test(item.link)) return item.link
    if (!item.guid) return undefined
    return `${c.apiUrl}?${new URLSearchParams({ t: 'get', id: item.guid, apikey: c.apiKey })}`
  }

  // Search queries from most to least specific, stop at first acceptable hit.
  async find (targets, c, fetchFn) {
    const wanted = targets.filter(Boolean)
    const exact = new Set(wanted.map(normalize))
    const queries = [...new Set(wanted.map(normalize))].filter(q => q.length > 3)

    let best
    for (const q of queries) {
      const items = await this.search(q, c, fetchFn)
      for (const item of items) {
        if (exact.has(normalize(item.title))) return this.nzbUrl(item, c)
        if (c.fuzzy) {
          const score = Math.max(...wanted.map(t => similarity(t, item.title)))
          if (score >= c.threshold && (!best || score > best.score)) best = { item, score }
        }
      }
    }
    return best ? this.nzbUrl(best.item, c) : undefined
  }

  async single ({ name, file, fetch: qfetch }, options) {
    const c = this.cfg(options)
    // For single-file torrents name === filename; for packs, file is the episode.
    return this.find([file, name], c, qfetch || fetch)
  }

  async batch ({ name, fetch: qfetch }, options) {
    const c = this.cfg(options)
    return this.find([name], c, qfetch || fetch)
  }

  // The wiki doesn't say whether Hayase passes options to test(). If it does,
  // validate the configured indexer + key; otherwise there's nothing to check
  // against, and config errors surface on the first search instead.
  async test (...args) {
    const options = args.find(a => a && typeof a === 'object' && 'apiKey' in a)
    if (!options) return true
    const c = this.cfg(options)
    const params = new URLSearchParams({ t: 'search', q: 'test', apikey: c.apiKey, limit: '1' })
    const res = await fetch(`${c.apiUrl}?${params}`)
    if (!res.ok) throw new Error(`Indexer unreachable (HTTP ${res.status}). Check the API endpoint setting.`)
    parseItems(await res.text()) // throws a readable error on a bad key
    return true
  }
}()
