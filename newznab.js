// Hayase NZB extension for any Newznab-compatible indexer.
// Self-contained ESM (no imports), so no bundling step is needed.
//
// Hayase hands us the torrent it picked ({ hash, name, file | files }).
// Newznab can't look up by infoHash, so we search by release name and only
// return an NZB whose release name matches the torrent (exact by default),
// because Hayase needs the same bytes it would have gotten from the swarm.

const DEADLINE_MS = 8500
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

// Drop 8-hex CRC32 tags; Usenet reposts frequently omit them.
export const stripNoise = n => n.replace(/\b[0-9a-f]{8}\b/g, ' ').replace(/\s+/g, ' ').trim()

const tokens = s => new Set(normalize(s).split(' ').filter(Boolean))

// Release group from "[Group] Title ...", "Title ... [Group]" or scene-style "Title...-GROUP".
export function releaseGroup (raw = '') {
  const s = raw.split(/[\\/]/).pop().replace(VIDEO_EXT, '').trim()
  const isGroup = g => g && !/\s/.test(g) && !/^[0-9a-f]{8}$/i.test(g) && !/^\d{3,4}p$/i.test(g)
  const lead = s.match(/^\[([^\]]+)\]/)?.[1]
  if (isGroup(lead)) return normalize(lead)
  const trail = s.match(/\[([^\]]+)\]$/)?.[1]
  if (isGroup(trail)) return normalize(trail)
  const scene = s.match(/-([A-Za-z0-9]+)$/)?.[1]
  if (scene && /[A-Za-z]/.test(scene)) return normalize(scene)
  return ''
}

export function seasonEpisode (raw = '') {
  const m = raw.split(/[\\/]/).pop().match(/\bS(\d{1,2})E(\d{1,4})\b/i)
  return m ? `s${m[1].padStart(2, '0')}e${m[2].padStart(2, '0')}` : ''
}

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
      threshold: Number(options.fuzzyThreshold) || 0.85,
      debug: options.debug === true || options.debug === 'true'
    }
  }

  async search (q, c, fetchFn, signal) {
    const params = new URLSearchParams({ t: 'search', q, apikey: c.apiKey, extended: '1', limit: '100' })
    if (c.cat) params.set('cat', c.cat)
    const res = await fetchFn(`${c.apiUrl}?${params}`, signal ? { signal } : undefined)
    if (!res.ok) throw new Error(`Indexer returned HTTP ${res.status}.`)
    return parseItems(await res.text())
  }

  nzbUrl (item, c) {
    if (item.link && /^https?:/i.test(item.link)) return item.link
    if (!item.guid) return undefined
    return `${c.apiUrl}?${new URLSearchParams({ t: 'get', id: item.guid, apikey: c.apiKey })}`
  }

  log (c, ...args) {
    if (c.debug) console.log('[newznab]', ...args)
  }

  // Query ladder from most to least specific. Matching is always against the
  // torrent's own names, so broad queries only widen the candidate pool.
  async find ({ targets, broad }, c, fetchFn) {
    const wanted = targets.filter(Boolean)
    const exact = new Set(wanted.flatMap(t => [normalize(t), stripNoise(normalize(t))]))
    const queries = [...new Set([
      ...wanted.map(normalize),
      ...wanted.map(t => stripNoise(normalize(t))),
      ...broad.filter(Boolean)
    ])].filter(q => q.length > 3)

    this.log(c, 'targets', wanted)
    // Hayase drops NZB results that take longer than 10s, without an error.
    const deadline = Date.now() + DEADLINE_MS
    let best
    for (const q of queries) {
      const remaining = deadline - Date.now()
      if (remaining < 500) { this.log(c, 'out of time, stopping'); break }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), remaining)
      let items
      try {
        items = await this.search(q, c, fetchFn, ctrl.signal)
      } catch (e) {
        if (ctrl.signal.aborted) { this.log(c, `q="${q}" timed out`); break }
        throw e
      } finally {
        clearTimeout(timer)
      }
      this.log(c, `q="${q}" -> ${items.length} results`, items.slice(0, 10).map(i => i.title))
      for (const item of items) {
        const n = normalize(item.title)
        if (exact.has(n) || exact.has(stripNoise(n))) {
          this.log(c, 'exact match', item.title)
          return this.nzbUrl(item, c)
        }
        if (c.fuzzy) {
          const score = Math.max(...wanted.flatMap(t => [
            similarity(t, item.title),
            similarity(stripNoise(normalize(t)), stripNoise(n))
          ]))
          if (score >= c.threshold && (!best || score > best.score)) best = { item, score }
        }
      }
    }
    if (best) this.log(c, `fuzzy match (${best.score.toFixed(2)})`, best.item.title)
    else this.log(c, 'no match')
    return best ? this.nzbUrl(best.item, c) : undefined
  }

  async single ({ name, file, titles = [], episode, fetch: qfetch }, options) {
    const c = this.cfg(options)
    const ts = titles.slice(0, 2).map(normalize)
    const group = releaseGroup(file) || releaseGroup(name)
    const sxe = seasonEpisode(file)
    const ep = episode != null ? String(episode).padStart(2, '0') : ''
    // For single-file torrents name === filename; for packs, file is the episode.
    return this.find({
      targets: [file, name],
      broad: [
        ...ts.map(t => group && `${group} ${t}`),
        ...ts.map(t => sxe && `${t} ${sxe}`),
        ...ts.map(t => ep && `${t} ${ep}`)
      ]
    }, c, qfetch || fetch)
  }

  async batch ({ name, titles = [], fetch: qfetch }, options) {
    const c = this.cfg(options)
    const ts = titles.slice(0, 2).map(normalize)
    const group = releaseGroup(name)
    return this.find({
      targets: [name],
      broad: [...ts.map(t => group && `${group} ${t}`), ...ts]
    }, c, qfetch || fetch)
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