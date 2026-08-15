/**
 * dsh-music-player — Host half.
 * 悬浮窗音乐播放器:本地音乐队列(路径索引) + 网易云在线搜索/播放(歌曲ID索引),
 * 配置与队列持久化到 ~/.dsh/dsh-music-config.json。
 * 网络通道:subprocess 直跑 curl.exe(默认 DSH 自带服务,无沙箱依赖,不落盘)。
 * Client 通过 POST /dsh-music/api {method, args} 调用本插件方法。
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

let defineTool = null
{
  const toolsRequire = createRequire(import.meta.url)
  try {
    toolsRequire.resolve('@deepseek-ai/dsh-tools')
    defineTool = toolsRequire('@deepseek-ai/dsh-tools').defineTool
  } catch (e) {
    // 解析不到 dsh-tools 时跳过工具注册,插件其余功能不受影响
  }
}

export const name = 'dsh-music-player'
export const inject = ['webServer', 'tools', 'agents']

export function apply(ctx, config = {}) {
  const fs = ctx.get('fs')
  const webServer = ctx.get('webServer')
  if (!fs || !webServer) return

  const state = {
    iconPath: '',
    glowMode: 'auto',
    glowColor: '#4fc3f7',
    glassEnabled: true,
    glowAbove: true,
    panelTransparent: false,
    iconHidden: false,
    showIcon: true,
    showLyrics: true,
    showNext: true,
    showPlay: true,
    musicDir: '',
    windowSize: 54,
    iconSize: 38,
    glassBlur: 14,
    glassSaturate: 150,
    glassAlpha: 16,
    radius: 16,
    glowAlpha: 55,
    glowSpeed: 3,
    vipCookie: '',
      customCss: '',
      apiPrimary: 'https://music.163.com/api',
      apiFallback: 'https://apis.netstart.cn/music',
      queueEndNotifySession: '',
      playMode: 'loop',
  }
  let iconBytes = null
  let iconError = null
  let reloadSeq = 0
  let configReady = false

  // ---- 持久化:配置存 ~/.dsh/dsh-music-config.json ----
  let configPath = null
  async function detectHome() {
    if (configPath) return
    const home = process.env.USERPROFILE || process.env.HOME || ''
    if (home) {
      configPath = home.replace(/\\+$/, '') + '/.dsh/dsh-music-config.json'
      return
    }
    try {
      const cwdTgt = await fs.resolve('.')
      const cwd = fs.processPath(cwdTgt)
      configPath = cwd + '/dsh-music-config.json'
    } catch (e) {
      configPath = 'dsh-music-config.json'
    }
  }
  async function loadConfig() {
    await detectHome()
    if (!configPath) {
      configReady = true
      return
    }
    try {
      const target = await fs.resolve(configPath)
      const st = await fs.stat(target)
      if (!st || st.type !== 'file') {
        configReady = true
        return
      }
      const text = await fs.readText(target)
      const data = JSON.parse(text)
      if (data && typeof data === 'object') {
        Object.assign(state, data)
      }
    } catch (e) {}
    configReady = true
  }
  async function saveConfig() {
    if (!configReady) return
    await detectHome()
    if (!configPath) return
    try {
      const target = await fs.resolve(configPath)
      await fs.writeText(target, JSON.stringify(state, null, 2))
    } catch (e) {
      console.error('music config save failed', e)
    }
  }
  loadConfig().then(() => {
    reloadIcon()
    if (state.musicDir.trim()) refreshLibrary()
  })

  // ---- query 解析(Host 无 URL/URLSearchParams 全局)----
  function queryParam(url, key) {
    const qi = url.indexOf('?')
    if (qi < 0) return null
    const pairs = url.slice(qi + 1).split('&')
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      const k = eq >= 0 ? pair.slice(0, eq) : pair
      if (k === key) {
        const v = eq >= 0 ? pair.slice(eq + 1) : ''
        try {
          return decodeURIComponent(v)
        } catch (e) {
          return v
        }
      }
    }
    return null
  }

  // ---- 音乐库 ----
  let library = []
  let libraryDirty = true
  let scanChain = Promise.resolve()
  const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.aac']

  function extOf(name) {
    const i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(i).toLowerCase() : ''
  }
  function baseOf(name) {
    const i = name.lastIndexOf('.')
    return i >= 0 ? name.slice(0, i) : name
  }
  function mimeOf(ext) {
    if (ext === '.mp3') return 'audio/mpeg'
    if (ext === '.flac') return 'audio/flac'
    if (ext === '.wav') return 'audio/wav'
    if (ext === '.m4a' || ext === '.aac') return 'audio/mp4'
    if (ext === '.ogg' || ext === '.opus') return 'audio/ogg'
    return 'application/octet-stream'
  }

  async function scanDir(target, prefix, out) {
    let entries = []
    try {
      entries = await fs.listDir(target)
    } catch (e) {
      return
    }
    const dirAbs = fs.processPath(target)
    const sep = dirAbs.indexOf('\\') >= 0 ? '\\' : '/'
    for (const entry of entries) {
      if (entry.type === 'directory') {
        await scanDir(entry.target, prefix + entry.name + '/', out)
      } else if (entry.type === 'file') {
        const ext = extOf(entry.name)
        if (!AUDIO_EXTS.includes(ext)) continue
        const rel = prefix + entry.name
        const id = 'L' + out.length
        let lrcTarget = null
        try {
          lrcTarget = await fs.resolve(dirAbs + sep + baseOf(entry.name) + '.lrc')
          const st = await fs.stat(lrcTarget)
          if (!st || st.type !== 'file') lrcTarget = null
        } catch (e) {
          lrcTarget = null
        }
        out.push({
          id,
          rel,
          ext,
          target: entry.target,
          lrcTarget,
          title: baseOf(entry.name),
          artist: prefix ? prefix.replace(/\/$/, '').split('/').pop() : '',
        })
      }
    }
  }

  async function refreshLibrary() {
    const dir = state.musicDir.trim()
    if (!dir) {
      library = []
      return null
    }
    const run = scanChain.then(function () {
      return (async function () {
        try {
          const root = await fs.resolve(dir)
          const info = await fs.stat(root)
          if (!info || info.type !== 'directory') {
            library = []
            return
          }
          const out = []
          await scanDir(root, '', out)
          library = out
        } catch (e) {
          library = []
        }
      })()
    })
    scanChain = run.catch(function () {})
    await run
    return null
  }

  async function ensureLibrary() {
    if (libraryDirty || (!library.length && state.musicDir.trim())) {
      await refreshLibrary()
      libraryDirty = false
    }
  }
  function findTrack(id) {
    return library.find((t) => t.id === id)
  }

  function numInRange(v, min, max) {
    return typeof v === 'number' && isFinite(v) && v >= min && v <= max
  }

  async function reloadIcon() {
    const seq = ++reloadSeq
    try {
      const target = await fs.resolve(state.iconPath)
      const info = await fs.stat(target)
      if (!info) throw new Error('文件不存在')
      const bytes = await fs.readBytes(target, undefined, 8 * 1024 * 1024)
      if (seq !== reloadSeq) return
      iconBytes = bytes
      iconError = null
    } catch (e) {
      if (seq !== reloadSeq) return
      iconError = String((e && e.message) || e)
    }
  }
  reloadIcon()

  // ---- LRC 解析 ----
  function parseLrc(text) {
    const lines = []
    const re = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?]/g
    const body = String(text || '').split(/\r?\n/)
    for (const raw of body) {
      const matches = []
      let m
      re.lastIndex = 0
      while ((m = re.exec(raw)) !== null) {
        const min = parseInt(m[1], 10)
        const sec = parseInt(m[2], 10)
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0
        matches.push(min * 60 + sec + frac / 1000)
      }
      if (!matches.length) continue
      const text = raw.replace(re, '').trim()
      if (!text) continue
      for (const t of matches) {
        lines.push({ t: Math.round(t * 100) / 100, text })
      }
    }
    lines.sort((a, b) => a.t - b.t)
    return lines
  }

  // ---- ID3v2 APIC 封面提取 ----
  function synchsafe(b0, b1, b2, b3) {
    return ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f)
  }
  function be32(b0, b1, b2, b3) {
    return ((b0 & 0xff) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff)
  }
  function extractCover(bytes) {
    if (bytes.length < 10) return null
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null
    const ver = bytes[3]
    const size = synchsafe(bytes[6], bytes[7], bytes[8], bytes[9])
    const end = Math.min(10 + size, bytes.length)
    let pos = 10
    if (bytes[5] & 0x40) {
      if (pos + 4 <= end) {
        if (ver === 4) {
          const esz = synchsafe(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
          pos += esz
        } else {
          const esz = be32(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
          pos += 4 + esz
        }
      }
    }
    while (pos + 10 <= end) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3])
      if (!/^[A-Z0-9]{4}$/.test(id)) break
      let fsize
      if (ver === 4) {
        fsize = synchsafe(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
      } else {
        fsize = be32(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7])
      }
      if (fsize <= 0) break
      const fstart = pos + 10
      const fend = fstart + fsize
      if (fend > end) break
      if (id === 'APIC') {
        const enc = bytes[fstart]
        let p = fstart + 1
        let mimeStart = p
        while (p < fend && bytes[p] !== 0) p++
        if (p >= fend) break
        let mime = ''
        for (let i = mimeStart; i < p; i++) mime += String.fromCharCode(bytes[i])
        p++
        p++
        if (enc === 1 || enc === 2) {
          if (p + 1 < fend && bytes[p] === 0xff && bytes[p + 1] === 0xfe) p += 2
          else if (p + 1 < fend && bytes[p] === 0xfe && bytes[p + 1] === 0xff) p += 2
          while (p + 1 < fend && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2
          p += 2
        } else {
          while (p < fend && bytes[p] !== 0) p++
          p++
        }
        if (p >= fend) break
        const img = bytes.slice(p, fend)
        if (img.length < 64) break
        return { mime: mime || 'image/jpeg', data: img }
      }
      pos = fend
    }
    return null
  }

  // ---- 资源路由 ----
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-music/icon',
    handler: (req, res) => {
      if (!iconBytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(iconError || 'icon not loaded')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'image/x-icon',
        'Content-Length': String(iconBytes.length),
        'Cache-Control': 'no-store',
      })
      res.end(iconBytes)
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-music/audio',
    handler: async (req, res) => {
      try {
        const id = queryParam(req.url || '', 'id')
        const path = queryParam(req.url || '', 'path')
        let track = id ? findTrack(id) : null
        if (!track && path) track = await resolveTrackFromPath(path)
        if (!track || !track.target) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('track not found')
          return
        }
        const info = await fs.stat(track.target)
        if (!info || info.type !== 'file' || !info.size) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not a file')
          return
        }
        const MAX = 256 * 1024 * 1024
        if (info.size > MAX) {
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('file too large')
          return
        }
        const bytes = await fs.readBytes(track.target, undefined, MAX)
        const total = bytes.length
        const range = req.headers.range
        let start = 0
        let end = total - 1
        let status = 200
        const headers = {
          'Content-Type': mimeOf(track.ext),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        }
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range)
          if (m) {
            if (m[1]) start = parseInt(m[1], 10)
            if (m[2]) end = Math.min(total - 1, parseInt(m[2], 10))
            if (start > end || start >= total) {
              res.writeHead(416, { 'Content-Range': 'bytes */' + total })
              res.end()
              return
            }
            status = 206
            headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
          }
        }
        headers['Content-Length'] = String(end - start + 1)
        res.writeHead(status, headers)
        res.end(bytes.slice(start, end + 1))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('stream error: ' + String((e && e.message) || e))
      }
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-music/cover',
    handler: async (req, res) => {
      try {
        const id = queryParam(req.url || '', 'id')
        const path = queryParam(req.url || '', 'path')
        let track = id ? findTrack(id) : null
        if (!track && path) track = await resolveTrackFromPath(path)
        if (!track || !track.target) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        if (track.ext !== '.mp3') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        const info = await fs.stat(track.target)
        if (!info || info.type !== 'file' || !info.size || info.size > 64 * 1024 * 1024) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        const bytes = await fs.readBytes(track.target, undefined, info.size)
        const cover = extractCover(bytes)
        if (!cover) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('no cover')
          return
        }
        res.writeHead(200, {
          'Content-Type': cover.mime,
          'Content-Length': String(cover.data.length),
          'Cache-Control': 'no-store',
        })
        res.end(cover.data)
      } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no cover')
      }
    },
  }))

  // ---- 播放队列(持久化:配置文件里存音频路径索引/歌曲ID索引) ----
  function normPath(p) {
    return String(p || '').replace(/\\/g, '/')
  }
  async function resolveTrackFromPath(path) {
    if (!path) return null
    try {
      const target = await fs.resolve(path)
      const st = await fs.stat(target)
      if (!st || st.type !== 'file') return null
      const name = String(path).split(/[\\/]/).pop() || ''
      const i = name.lastIndexOf('.')
      return {
        target,
        ext: i > 0 ? name.slice(i).toLowerCase() : '',
        title: i > 0 ? name.slice(0, i) : name,
      }
    } catch (e) {
      return null
    }
  }
  function findLibraryByPath(path) {
    const np = normPath(path)
    for (const t of library) {
      try {
        if (normPath(fs.processPath(t.target)) === np) return t
      } catch (e) {}
    }
    return null
  }
  async function buildQueueItems(items) {
    const out = []
    for (const it of items) {
      // 在线歌曲:存歌曲 ID 索引,播放时实时取地址(不存 CDN 链接)
      if (it && typeof it === 'object' && it.type === 'online') {
        const id = Number(it.id)
        if (!id) continue
        out.push({
          kind: 'online',
          key: 'online:' + id,
          id,
          title: String(it.name || ('歌曲 ' + id)),
          artists: String(it.artists || ''),
          album: String(it.album || ''),
          picUrl: String(it.picUrl || ''),
            uuid: String(it.uuid || ''),
        })
        continue
      }
      // 本地歌曲:文件路径索引
      const p = typeof it === 'string' ? it : (it && typeof it.path === 'string' ? it.path : '')
      if (!p) continue
      const name = String(p).split(/[\\/]/).pop() || ''
      const i = name.lastIndexOf('.')
      const title = i > 0 ? name.slice(0, i) : name
      const ext = i > 0 ? name.slice(i).toLowerCase() : ''
      let exists = false
      let artist = ''
      const lib = findLibraryByPath(p)
      if (lib) {
        exists = true
        artist = lib.artist
      } else {
        try {
          const t = await fs.resolve(p)
          const st = await fs.stat(t)
          exists = !!(st && st.type === 'file')
        } catch (e) {}
      }
      out.push({ kind: 'local', key: p, path: p, title, ext, exists, artist, uuid: String(it.uuid || '') })
    }
    return out
  }
  // ---- 队列规范化(补 UUID,兼容旧纯字符串/无 UUID 格式) ----
  function normalizeQueue() {
    if (!Array.isArray(state.queue)) return
    let changed = false
    const next = []
    for (const it of state.queue) {
      if (typeof it === 'string' && it.trim()) {
        next.push({ type: 'local', path: it, uuid: randomUUID() })
        changed = true
      } else if (it && typeof it === 'object') {
        if (it.type === 'online') {
          const id = Number(it.id)
          if (!id) continue
          next.push({
            type: 'online',
            id,
            name: String(it.name || ''),
            artists: String(it.artists || ''),
            album: String(it.album || ''),
            picUrl: String(it.picUrl || ''),
            uuid: typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID(),
          })
          if (!it.uuid) changed = true
        } else if (typeof it.path === 'string' && it.path.trim()) {
          next.push({
            type: 'local',
            path: it.path,
            uuid: typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID(),
          })
          if (!it.uuid) changed = true
        }
      }
    }
    state.queue = next
    if (changed) saveConfig()
  }

  // ---- Agent 指令通道(Client 轮询取指令并上报播放状态) ----
  let agentCmd = null
  let agentNowPlaying = { trackId: null, playing: false, title: '', artist: '', lyricText: '' }
  function setAgentCmd(cmd) { agentCmd = cmd }
  let settingsRev = 0
  let queueRev = 0

  async function queuePaths() {
    if (!configReady) await loadConfig()
    normalizeQueue()
    if (!Array.isArray(state.queue)) {
      await ensureLibrary()
      if (!library.length && state.musicDir.trim()) {
        await refreshLibrary()
      }
      const paths = []
      for (const t of library) {
        try { paths.push(fs.processPath(t.target)) } catch (e) {}
      }
      state.queue = paths
      normalizeQueue()
    }
    return state.queue
  }

  // ---- RPC 方法注册(Client 经 /dsh-music/api 调用) ----
  const handlers = {}

  handlers['music/queue/get'] = async () => {
    const paths = await queuePaths()
    return { items: await buildQueueItems(paths), notifySession: state.queueEndNotifySession || null }
  }

  handlers['music/queue/set'] = async (args) => {
    const raw = (args && Array.isArray(args.items)) ? args.items : []
    const seen = new Set()
    const clean = []
    for (const it of raw) {
      let k = null
      let entry = null
      if (typeof it === 'string') {
        if (!it.trim()) continue
        k = it
        entry = { type: 'local', path: it, uuid: randomUUID() }
      } else if (it && typeof it === 'object') {
        if (it.type === 'online') {
          const id = Number(it.id)
          if (!id) continue
          k = 'online:' + id
          entry = {
            type: 'online',
            id,
            name: String(it.name || ''),
            artists: String(it.artists || ''),
            album: String(it.album || ''),
            picUrl: String(it.picUrl || ''),
            uuid: typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID(),
          }
        } else if (typeof it.path === 'string' && it.path.trim()) {
          k = it.path
          entry = {
            type: 'local',
            path: it.path,
            uuid: typeof it.uuid === 'string' && it.uuid ? it.uuid : randomUUID(),
          }
        }
      }
      if (k && !seen.has(k)) {
        seen.add(k)
        clean.push(entry)
      }
    }
    state.queue = clean
    queueRev++
    saveConfig()
    return { items: await buildQueueItems(clean) }
  }

  handlers['music/queue/import-all'] = async () => {
    await ensureLibrary()
    const paths = []
    for (const t of library) {
      try { paths.push(fs.processPath(t.target)) } catch (e) {}
    }
    state.queue = paths
    queueRev++
    normalizeQueue()
    return { items: await buildQueueItems(paths) }
  }

  function snapshot() {
    return {
      iconPath: state.iconPath,
      glowMode: state.glowMode,
      glowColor: state.glowColor,
      glassEnabled: state.glassEnabled,
      glowAbove: state.glowAbove,
      panelTransparent: state.panelTransparent,
      iconHidden: state.iconHidden,
      showIcon: state.showIcon,
      showLyrics: state.showLyrics,
      showNext: state.showNext,
      showPlay: state.showPlay,
      musicDir: state.musicDir,
      windowSize: state.windowSize,
      iconSize: state.iconSize,
      glassBlur: state.glassBlur,
      glassSaturate: state.glassSaturate,
      glassAlpha: state.glassAlpha,
      radius: state.radius,
      glowAlpha: state.glowAlpha,
      glowSpeed: state.glowSpeed,
      vipCookie: state.vipCookie,
      iconLoaded: !!iconBytes,
      iconError,
      customCss: state.customCss || '',
      apiPrimary: state.apiPrimary || 'https://music.163.com/api',
      apiFallback: state.apiFallback || 'https://apis.netstart.cn/music',
      playMode: state.playMode || 'loop',
    }
  }

  handlers['music/settings/get'] = async () => {
    await loadConfig()
    return snapshot()
  }

  handlers['music/settings/set'] = async (args) => {
    const patch = (args && typeof args === 'object') ? args : {}
    if (typeof patch.iconPath === 'string' && patch.iconPath.trim()) {
      state.iconPath = patch.iconPath.trim()
    }
    if (patch.glowMode === 'auto' || patch.glowMode === 'custom') {
      state.glowMode = patch.glowMode
    }
    if (typeof patch.glowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.glowColor)) {
      state.glowColor = patch.glowColor
    }
    if (typeof patch.glassEnabled === 'boolean') {
      state.glassEnabled = patch.glassEnabled
    }
    if (typeof patch.glowAbove === 'boolean') {
      state.glowAbove = patch.glowAbove
    }
    if (typeof patch.panelTransparent === 'boolean') {
      state.panelTransparent = patch.panelTransparent
    }
    if (typeof patch.iconHidden === 'boolean') {
      state.iconHidden = patch.iconHidden
    }
    if (typeof patch.showIcon === 'boolean') {
      state.showIcon = patch.showIcon
    }
    if (typeof patch.showLyrics === 'boolean') {
      state.showLyrics = patch.showLyrics
    }
    if (typeof patch.showNext === 'boolean') {
      state.showNext = patch.showNext
    }
    if (typeof patch.showPlay === 'boolean') {
      state.showPlay = patch.showPlay
    }
    if (typeof patch.musicDir === 'string' && patch.musicDir.trim() !== state.musicDir) {
      state.musicDir = patch.musicDir.trim()
      libraryDirty = true
      refreshLibrary()
    }
    if (numInRange(patch.windowSize, 40, 120)) state.windowSize = patch.windowSize
    if (numInRange(patch.iconSize, 16, 96)) state.iconSize = patch.iconSize
    if (numInRange(patch.glassBlur, 0, 40)) state.glassBlur = patch.glassBlur
    if (numInRange(patch.glassSaturate, 100, 250)) state.glassSaturate = patch.glassSaturate
    if (numInRange(patch.glassAlpha, 0, 35)) state.glassAlpha = patch.glassAlpha
    if (numInRange(patch.radius, 0, 48)) state.radius = patch.radius
    if (numInRange(patch.glowAlpha, 10, 100)) state.glowAlpha = patch.glowAlpha
    if (numInRange(patch.glowSpeed, 1, 8)) state.glowSpeed = patch.glowSpeed
    if (typeof patch.vipCookie === 'string') state.vipCookie = patch.vipCookie
      if (typeof patch.apiPrimary === 'string' && patch.apiPrimary.trim()) {
        state.apiPrimary = patch.apiPrimary.trim().replace(/\/+$/, '')
      }
      if (typeof patch.apiFallback === 'string' && patch.apiFallback.trim()) {
        state.apiFallback = patch.apiFallback.trim().replace(/\/+$/, '')
      }
      if (patch.playMode === 'loop' || patch.playMode === 'seq') state.playMode = patch.playMode
    await reloadIcon()
    settingsRev++
    saveConfig()
    return snapshot()
  }

  handlers['music/library'] = async () => {
    await ensureLibrary()
    return library.map((t) => {
      let p = ''
      try { p = fs.processPath(t.target) } catch (e) {}
      return {
        id: t.id,
        title: t.title,
        artist: t.artist,
        ext: t.ext,
        path: p,
      }
    })
  }

  handlers['music/lrc'] = async (args) => {
    const id = args && args.id
    const path = args && args.path
    let track = id ? findTrack(id) : null
    let lrcTarget = track ? track.lrcTarget : null
    if (!lrcTarget && path) {
      try {
        const dot = String(path).lastIndexOf('.')
        const base = dot > 0 ? path.slice(0, dot) : path
        const t = await fs.resolve(base + '.lrc')
        const st = await fs.stat(t)
        if (st && st.type === 'file') lrcTarget = t
      } catch (e) {}
    }
    if (!lrcTarget) return { lines: [] }
    try {
      let text = ''
      try {
        text = await fs.readText(lrcTarget)
      } catch (e) {
        try {
          const raw = await fs.readBytes(lrcTarget, undefined, 4 * 1024 * 1024)
          text = new TextDecoder('gbk').decode(raw)
        } catch (e2) {
          text = ''
        }
      }
      return { lines: parseLrc(text) }
    } catch (e) {
      return { lines: [] }
    }
  }

  // ---- 网易云在线(Host 兜底通道:web.fetch → subprocess 直跑 curl,均不落盘) ----
  // API 分级:官方接口(网易云网页版 music.163.com/api)优先,被限流/异常时自动降级到
  // 备用网关(默认 NeteaseCloudMusicApi 框架公共实例 apis.netstart.cn/music,可在设置中更换)。
  let lastFallbackAt = 0
  const FALLBACK_COOLDOWN = 120000 // 降级后 2 分钟内优先走备用,避免反复触发官方限流

  function apiOfficial(path) {
    return (state.apiPrimary || 'https://music.163.com/api') + path
  }
  function apiGateway(path) {
    return (state.apiFallback || 'https://apis.netstart.cn/music') + path
  }
  // 解析 HTTP 响应为 JSON 并做基础结构校验(HTTP 层 + code 层)
  function parseJsonResp(r) {
    if (!r.ok) return { ok: false, msg: r.msg || '网络请求失败' }
    if (r.status !== 200) return { ok: false, msg: '接口 HTTP ' + r.status }
    let data
    try {
      data = JSON.parse(r.text)
    } catch (e) {
      return { ok: false, msg: '接口响应解析失败(可能被限流)' }
    }
    if (!data || typeof data !== 'object') return { ok: false, msg: '接口响应异常(可能被限流)' }
    if (data.code !== undefined && data.code !== 200) {
      return { ok: false, msg: '接口返回 code=' + data.code + '(可能被限流或接口变动)' }
    }
    return { ok: true, data }
  }
  // 双通道获取:官方优先;官方异常时记下降级时间并走备用;冷却期内备用优先,备用失败再回官方
  async function nmFetchDual(officialUrl, gatewayUrl) {
    const cooled = Date.now() - lastFallbackAt < FALLBACK_COOLDOWN
    if (!cooled) {
      const p1 = parseJsonResp(await nmGet(officialUrl))
      if (p1.ok) return { source: 'official', parsed: p1 }
      lastFallbackAt = Date.now()
      const p2 = parseJsonResp(await nmGet(gatewayUrl))
      if (p2.ok) return { source: 'gateway', parsed: p2 }
      return { source: 'official', parsed: p1 }
    }
    const p2 = parseJsonResp(await nmGet(gatewayUrl))
    if (p2.ok) return { source: 'gateway', parsed: p2 }
    const p1 = parseJsonResp(await nmGet(officialUrl))
    if (p1.ok) return { source: 'official', parsed: p1 }
    return { source: 'gateway', parsed: p2 }
  }
  const NM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  async function nmGet(url) {
    // 1) web.fetch:匿名内存请求
    const webSvc = ctx.get('web')
    if (webSvc) {
      try {
        const r = await webSvc.fetch({ url })
        if (r && typeof r.statusCode === 'number' && r.body && typeof r.body.content === 'string') {
          return { ok: true, status: r.statusCode, text: r.body.content, msg: '' }
        }
      } catch (e) {}
    }
    // 2) subprocess 直接 spawn curl.exe:无沙箱包装、无临时文件、argv 数组无引号问题
    const subprocess = ctx.get('subprocess')
    if (subprocess) {
      try {
        const args = ['-sS', '-L', '--max-time', '25', '-H', 'User-Agent: ' + NM_UA, '-H', 'Referer: https://music.163.com/']
        if (state.vipCookie && state.vipCookie.trim()) {
          args.push('-H', 'Cookie: ' + state.vipCookie.replace(/"/g, ''))
        }
        args.push(url)
        const cwdTgt = await fs.resolve('.')
        const cwd = fs.processPath(cwdTgt)
        const handle = subprocess.spawn({
          argv: ['curl.exe'].concat(args),
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
          graceMs: 30000,
        })
        await handle.done
        const out = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : ''
        return { ok: true, status: 200, text: out, msg: '' }
      } catch (e) {
        return { ok: false, status: 0, text: '', msg: String((e && e.message) || e) }
      }
    }
    return { ok: false, status: 0, text: '', msg: '无可用网络通道' }
  }

  handlers['music/online/raw'] = async (args) => {
    const url = args && typeof args.url === 'string' ? args.url.trim() : ''
    if (!url) return { ok: false, msg: '缺少 url' }
    return await nmGet(url)
  }

  async function nmSearch(q, offset, limit) {
    // 官方优先,限流自动降级备用网关
    const officialUrl = apiOfficial('/search/get/web?s=' + encodeURIComponent(q) + '&type=1&offset=' + (offset || 0) + '&limit=' + (limit || 30))
    const gatewayUrl = apiGateway('/search?keywords=' + encodeURIComponent(q) + '&limit=' + (limit || 30) + '&offset=' + (offset || 0) + '&type=1')
    const { source, parsed } = await nmFetchDual(officialUrl, gatewayUrl)
    if (!parsed.ok) return { ok: false, msg: parsed.msg + '(来源:' + source + ')', source }
    const data = parsed.data
    if (!data.result || typeof data.result !== 'object') return { ok: false, msg: '接口响应异常(缺少 result,可能被限流),请稍后再试(来源:' + source + ')' }
    const songs = (data.result && data.result.songs) || []
    if (!songs.length) return { ok: true, items: [], source }
    // 批量补封面(搜索接口不含 picUrl)
    const pics = {}
    try {
      const ids = songs.map((s) => s.id).join(',')
      const dc = await nmFetchDual(
        apiOfficial('/song/detail?ids=' + encodeURIComponent('[' + ids + ']')),
        apiGateway('/song/detail?ids=' + ids),
      )
      if (dc.parsed.ok && dc.parsed.data && dc.parsed.data.songs) {
        for (const s of dc.parsed.data.songs) {
          const alb = s.album || s.al || null
          pics[s.id] = (alb && alb.picUrl) || ''
        }
      }
    } catch (e) {}
    return {
      ok: true,
      items: songs.map((s) => ({
        id: s.id,
        name: s.name,
        artists: (s.artists || []).map((a) => a.name).join(' / '),
        album: (s.album && s.album.name) || '',
        picUrl: pics[s.id] || ((s.artists && s.artists[0] && s.artists[0].img1v1Url) || ''),
        duration: s.duration || 0,
        fee: s.fee || 0,
      })),
    }
  }

  async function nmLyric(id) {
    const officialUrl = apiOfficial('/song/lyric?id=' + id + '&lv=-1&kv=-1&tv=-1')
    const gatewayUrl = apiGateway('/lyric?id=' + id)
    const { source, parsed } = await nmFetchDual(officialUrl, gatewayUrl)
    if (!parsed.ok) return { ok: false, msg: parsed.msg + '(来源:' + source + ')', source }
    const data = parsed.data
    const lyric = (data && data.lrc && data.lrc.lyric) || ''
    return { ok: true, lines: parseLrc(lyric), source }
  }

  // 播放地址仅用官方接口(备用网关未提供 /song/url,实测 404)
  async function nmPlayUrl(id) {
    const r = await nmGet(apiOfficial('/song/enhance/player/url?ids=' +
      encodeURIComponent('[' + id + ']') + '&br=320000'))
    if (!r.ok) return { ok: false, msg: r.msg || ('网易云接口失败') }
    if (r.status !== 200) return { ok: false, msg: '网易云接口 HTTP ' + r.status }
    try {
      const data = JSON.parse(r.text)
      if (data && data.code !== undefined && data.code !== 200) {
        return { ok: false, msg: '网易云接口返回 code=' + data.code + '(可能被限流),请稍后再试' }
      }
      const d = (data && data.data && data.data[0]) || null
      const raw = (d && d.url) || ''
      return { ok: true, url: raw ? raw.replace(/^http:/, 'https:') : null, br: (d && d.br) || 0 }
    } catch (e) {
      return { ok: false, msg: '播放地址解析失败' }
    }
  }

  handlers['music/search'] = async (args) => {
    const q = args && typeof args.q === 'string' ? args.q.trim() : ''
    if (!q) return { ok: false, msg: '关键词为空' }
    return await nmSearch(q, args.offset || 0, args.limit || 30)
  }

  handlers['music/online/lyric'] = async (args) => {
    const id = args && args.id
    if (!id) return { ok: false, msg: '缺少歌曲 id' }
    return await nmLyric(id)
  }

  handlers['music/online/url'] = async (args) => {
    const id = args && args.id
    if (!id) return { ok: false, msg: '缺少歌曲 id' }
    return await nmPlayUrl(id)
  }

  async function nmDetail(id) {
    const officialUrl = apiOfficial('/song/detail?ids=' + encodeURIComponent('[' + id + ']'))
    const gatewayUrl = apiGateway('/song/detail?ids=' + id)
    const { parsed } = await nmFetchDual(officialUrl, gatewayUrl)
    if (!parsed.ok) return null
    const d = parsed.data
    const s = d && d.songs && d.songs[0]
    if (!s) return null
    const art = s.artists || s.ar || []
    const alb = s.album || s.al || null
    return {
      id: s.id,
      name: s.name,
      artists: (art || []).map((a) => a.name).join(' / '),
      album: (alb && alb.name) || '',
      picUrl: (alb && alb.picUrl) || '',
      fee: s.fee || 0,
    }
  }

  handlers['music/queue/ended'] = async () => {
    const boundSession = state.queueEndNotifySession || ''
    if (!boundSession) return { ok: false, msg: '未开启播完通知' }
    // 队列已消费完毕:清空持久化队列,保证 AI 查询到的队列与"播放完毕"状态一致
    if (Array.isArray(state.queue) && state.queue.length) {
      state.queue = []
      queueRev++
      saveConfig()
    }
    const agentsSvc = ctx.agents || ctx.get('agents')
    const agent = agentsSvc && agentsSvc.get(boundSession)
    if (!agent || typeof agent.followup !== 'function') return { ok: false, msg: '绑定会话不可用(可能已关闭)' }
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: '播放器通知:当前播放队列已播放完毕,队列已清空。请用 music_queue_list 确认(应为空),并用 music_queue_add 添加新歌曲(或用 music_new_play 直接播放新歌)。' }],
      source: { kind: 'plugin', plugin: 'dsh-music-player' },
    }
    agent.followup(message)
    return { ok: true }
  }

  // 网易云歌单导入:按歌单 ID 批量加入队列(支持完整链接,自动提取数字 ID)
  handlers['music/playlist/import'] = async (args) => {
    let id = Number((args && args.id) || 0)
    if (!id && typeof (args && args.id) === 'string') {
      const m = String(args.id).match(/\d{5,}/)
      if (m) id = Number(m[0])
    }
    if (!id) return { ok: false, msg: '缺少有效的歌单 ID' }
    const official = apiOfficial('/api/v6/playlist/detail?id=' + id)
    const gateway = apiGateway('/playlist/detail?id=' + id)
    const { parsed, source } = await nmFetchDual(official, gateway)
    if (!parsed.ok) return { ok: false, msg: parsed.msg }
    const pl = parsed.data && parsed.data.playlist
    if (!pl) return { ok: false, msg: '歌单不存在或不可访问' }
    const songs = []
    if (Array.isArray(pl.tracks) && pl.tracks.length) {
      for (const s of pl.tracks.slice(0, 500)) {
        const art = s.artists || s.ar || []
        const alb = s.album || s.al || null
        songs.push({ id: Number(s.id), name: s.name, artists: (art || []).map((a) => a.name).join(' / '), album: (alb && alb.name) || '', picUrl: (alb && alb.picUrl) || '' })
      }
    } else if (Array.isArray(pl.trackIds) && pl.trackIds.length) {
      const ids = pl.trackIds.map((t) => t.id).filter(Boolean).slice(0, 500)
      if (ids.length) {
        const dc = await nmFetchDual(
          apiOfficial('/song/detail?ids=' + encodeURIComponent('[' + ids.join(',') + ']')),
          apiGateway('/song/detail?ids=' + ids.join(',')),
        )
        if (dc.parsed.ok && dc.parsed.data && dc.parsed.data.songs) {
          for (const s of dc.parsed.data.songs) {
            const art = s.artists || s.ar || []
            const alb = s.album || s.al || null
            songs.push({ id: Number(s.id), name: s.name, artists: (art || []).map((a) => a.name).join(' / '), album: (alb && alb.name) || '', picUrl: (alb && alb.picUrl) || '' })
          }
        }
      }
    }
    if (!songs.length) return { ok: false, msg: '歌单中没有可用的歌曲' }
    if (!configReady) await loadConfig()
    if (!Array.isArray(state.queue)) state.queue = []
    const existing = new Set(state.queue.filter((it) => it && it.type === 'online').map((it) => Number(it.id)))
    let added = 0
    for (const s of songs) {
      if (existing.has(s.id)) continue
      state.queue.push({ type: 'online', id: s.id, name: s.name, artists: s.artists, album: s.album, picUrl: s.picUrl, uuid: randomUUID() })
      existing.add(s.id)
      added++
    }
    queueRev++
    saveConfig()
    return { ok: true, added, total: songs.length, source }
  }

  handlers['music/agent/diag'] = async () => {
    let toolsInfo = 'n/a'
    const ts = ctx.tools || ctx.get('tools')
    if (ts) {
      try {
        const schemas = ts.schemas()
        const names = (schemas || []).map((x) => x.name)
        toolsInfo = 'present total=' + names.length + ' music=' + names.filter((n) => n.indexOf('music_') === 0).length + ' undo=' + names.filter((n) => n.indexOf('undo_') === 0).length
      } catch (e) { toolsInfo = 'error: ' + String((e && e.message) || e) }
    } else toolsInfo = 'NULL'
    return { defineToolOk: !!defineTool, toolsSvc: toolsInfo }
  }

  handlers['music/agent/poll'] = async (args) => {
    const st = args && args.state
    if (st && typeof st === 'object') {
      agentNowPlaying = {
        trackId: st.trackId || null,
        playing: !!st.playing,
        title: String(st.title || ''),
        artist: String(st.artist || ''),
        lyricText: String(st.lyricText || ''),
      }
    }
    const cmd = agentCmd
    agentCmd = null
    return { cmd, settingsRev, queueRev, queueEndNotify: !!state.queueEndNotifySession }
  }

  handlers['music/style/set'] = async (args) => {
    state.customCss = String((args && args.css) || '')
    settingsRev++
    saveConfig()
    return { ok: true }
  }

  handlers['music/style/get'] = async () => {
    return { css: state.customCss || '' }
  }

  handlers['music/ui/config'] = async (args) => {
    const patch = (args && typeof args.patch === 'object') ? args.patch : {}
    return await handlers['music/settings/set'](patch)
  }

  // ---- Agent 工具(供 Agent 控制播放器) ----
  const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
  // 手工构造 ToolDefinition(不依赖 @deepseek-ai/dsh-tools 的 defineTool,避免加载环境解析失败)
  function paramsToSchema(params) {
    const properties = {}
    const required = []
    for (const k of Object.keys(params || {})) {
      const p = params[k] || {}
      const prop = {}
      if (p.type) prop.type = p.type
      if (p.description) prop.description = p.description
      if (p.enum) prop.enum = p.enum
      properties[k] = prop
      if (p.required) required.push(k)
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) }
  }
  function makeTool(def) {
    return {
      name: def.name,
      description: def.description,
      parameters: paramsToSchema(def.parameters),
      output: def.output,
      isConcurrencySafe: def.isConcurrencySafe,
      execute: def.execute,
    }
  }
  // 等待 Agent 指令被播放器确认生效(Client 轮询消费并上报)
  async function waitAgent(predicate, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return predicate()
  }
  const toolsSvc = ctx.tools || ctx.get('tools')
  if (toolsSvc) {
    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_search',
      description: '搜索网易云在线歌曲,返回:歌名 - 作者 (歌曲ID) [是否VIP]。用于 Agent 给用户点歌前先搜索确认歌曲。若返回接口异常/可能被限流的信息,请等待一段时间后再试,不要连续反复搜索。',
      parameters: {
        q: { type: 'string', required: true, description: '搜索关键词(歌名/歌手/专辑)' },
        limit: { type: 'number', description: '返回条数,默认 10,最大 50' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const q = String((args && args.q) || '').trim()
        if (!q) return '缺少搜索关键词'
        const limit = Math.min(50, Math.max(1, Number((args && args.limit) || 10)))
        const r = await nmSearch(q, 0, limit)
        if (!r.ok) return '搜索失败: ' + (r.msg || '未知错误')
        if (!r.items.length) return '没有找到相关歌曲'
        const rows = r.items.map((s, i) => (i + 1) + '. ' + s.name + ' - ' + (s.artists || '未知歌手') + ' (ID: ' + s.id + ')' + (s.fee > 0 ? ' [VIP]' : ''))
        return '搜索结果(' + r.items.length + '):\n' + rows.join('\n')
      },
    })), 'dsh-music-player.tool.search')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_new_play',
      description: '播放一首【新的】网易云在线歌曲(替换当前正在播放的内容并立即开始)。暂停/继续播放【当前】歌曲请用 music_control,不要用本工具。若目标歌曲是 VIP 且没有可用的 VIP Cookie,返回"歌曲不可用 需要可用的VIPcookie"。',
      parameters: {
        id: { type: 'number', required: true, description: '网易云歌曲 ID(来自 music_search)' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const id = Number(args && args.id)
        if (!id) return '缺少有效的歌曲 ID'
        const info = await nmDetail(id)
        const pu = await nmPlayUrl(id)
        if (!pu.ok || !pu.url) {
          if (info && info.fee > 0) return '歌曲不可用 需要可用的VIPcookie'
          return '歌曲不可用:取播放地址失败(' + ((pu && pu.msg) || '未知原因') + ')'
        }
        const song = info || { id, name: '歌曲 ' + id, artists: '', album: '', picUrl: '' }
        setAgentCmd({ type: 'play', song: { id: song.id, name: song.name, artists: song.artists, album: song.album, picUrl: song.picUrl } })
        const confirmed = await waitAgent(() => agentNowPlaying.trackId === 'online:' + id, 6000)
        if (confirmed) return '已开始播放「' + song.name + '」' + (song.artists ? ' - ' + song.artists : '')
        return '播放指令已发送,但播放器未确认生效(请确认 DSH 页面已打开、播放器正常)'
      },
    })), 'dsh-music-player.tool.play')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_queue_add',
      description: '把网易云在线歌曲加入播放队列(提供网易云歌曲 ID,不做 VIP 判断)。返回该歌曲在队列中的唯一 UUID,供 music_queue_remove 使用。',
      parameters: {
        id: { type: 'number', required: true, description: '网易云歌曲 ID(来自 music_search)' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const id = Number(args && args.id)
        if (!id) return '缺少有效的歌曲 ID'
        if (!configReady) await loadConfig()
        if (!Array.isArray(state.queue)) state.queue = []
        const found = state.queue.find((it) => it && it.type === 'online' && Number(it.id) === id)
        if (found) return '该歌曲已在队列中 UUID: ' + (found.uuid || '')
        const info = await nmDetail(id)
        const song = info || { id, name: '歌曲 ' + id, artists: '', album: '', picUrl: '' }
        const entry = {
          type: 'online',
          id,
          name: song.name,
          artists: song.artists,
          album: song.album,
          picUrl: song.picUrl,
          uuid: randomUUID(),
        }
        state.queue.push(entry)
        queueRev++
        saveConfig()
        return '已添加到队列 UUID: ' + entry.uuid
      },
    })), 'dsh-music-player.tool.queue-add')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_now_playing',
      description: '查看当前播放的歌曲信息:歌名、作者、播放状态、歌词。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async () => {
        const np = agentNowPlaying
        if (!np.trackId) return '当前没有在播放歌曲'
        let out = '当前播放: ' + (np.title || '未知') + (np.artist ? ' - ' + np.artist : '')
        out += '\n状态: ' + (np.playing ? '播放中' : '已暂停')
        if (np.lyricText) out += '\n歌词:\n' + np.lyricText
        return out
      },
    })), 'dsh-music-player.tool.now-playing')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_control',
      description: '控制【当前】歌曲的播放状态(不改变歌曲):play=继续/恢复播放当前歌曲, pause=暂停, next=下一首, prev=上一首。播放【新】歌曲请用 music_new_play,不要用本工具。',
      parameters: {
        action: { type: 'string', required: true, description: 'play | pause | next | prev' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const action = String((args && args.action) || '')
        if (!['play', 'pause', 'next', 'prev'].includes(action)) return 'action 必须是 play/pause/next/prev 之一'
        if (!agentNowPlaying.trackId) return '当前没有播放中的歌曲。要播放新歌请用 music_new_play'
        const beforeTrack = agentNowPlaying.trackId
        setAgentCmd({ type: 'control', action })
        let confirmed = false
        if (action === 'play') confirmed = await waitAgent(() => agentNowPlaying.playing === true, 3000)
        else if (action === 'pause') confirmed = await waitAgent(() => agentNowPlaying.playing === false, 3000)
        else confirmed = await waitAgent(() => agentNowPlaying.trackId !== beforeTrack, 3000)
        if (confirmed) {
          if (action === 'play') return '已恢复播放:' + (agentNowPlaying.title || '')
          if (action === 'pause') return '已暂停:' + (agentNowPlaying.title || '')
          return '已切换到: ' + (agentNowPlaying.title || '') + (agentNowPlaying.artist ? ' - ' + agentNowPlaying.artist : '')
        }
        return '控制指令已发送,但播放器未确认生效(请确认 DSH 页面已打开、播放器正常)'
      },
    })), 'dsh-music-player.tool.control')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_queue_remove',
      description: '从播放队列删除指定歌曲(提供该歌曲的队列唯一 UUID,来自 music_queue_list 或 music_queue_add)。',
      parameters: {
        uuid: { type: 'string', required: true, description: '队列中歌曲的唯一 UUID' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const uuid = String((args && args.uuid) || '').trim()
        if (!uuid) return '缺少 UUID'
        if (!configReady) await loadConfig()
        if (!Array.isArray(state.queue)) return '队列为空'
        const before = state.queue.length
        state.queue = state.queue.filter((it) => !(it && it.uuid === uuid))
        if (state.queue.length === before) return '未找到 UUID: ' + uuid
        queueRev++
        saveConfig()
        return '已从队列删除 UUID: ' + uuid
      },
    })), 'dsh-music-player.tool.queue-remove')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_queue_list',
      description: '查看播放队列中的歌曲:返回每首歌的名称、队列唯一 UUID、网易云歌曲 ID(本地歌曲无 ID)。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async () => {
        const paths = await queuePaths()
        const items = await buildQueueItems(paths)
        if (!items.length) return '队列为空'
        const rows = items.map((q, i) => {
          const src = q.kind === 'online' ? ('网易云ID: ' + q.id) : '本地'
          return (i + 1) + '. UUID: ' + (q.uuid || '-') + ' | ' + q.title + (q.artists ? ' - ' + q.artists : '') + ' (' + src + ')'
        })
        return '队列 (' + items.length + ' 首):\n' + rows.join('\n')
      },
    })), 'dsh-music-player.tool.queue-list')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_queue_end_notify',
      description: '开启/关闭"队列播放完毕通知":开启后,本会话播放器的队列播放到最后一首结束时,会向本会话的 Agent 发送一条通知消息(提醒添加新歌)。通知绑定在当前会话,同一时间只能绑定一个会话。on=true 开启,on=false 关闭。',
      parameters: {
        on: { type: 'boolean', required: true, description: 'true 开启通知,false 关闭通知' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const on = !!(args && args.on === true)
        const agentsSvc = ctx.agents || ctx.get('agents')
        const me = agentsSvc && agentsSvc.currentInitiator()
        const mySession = me && (me.session ? me.session.id : me.id)
        if (!mySession) return '无法确定当前会话'
        if (on) {
          if (state.queueEndNotifySession && state.queueEndNotifySession !== mySession) return '通知已绑定到其他会话(' + state.queueEndNotifySession + '),请先在该会话执行 music_queue_end_notify on=false'
          state.queueEndNotifySession = mySession
          queueRev++
          saveConfig()
          return '已开启队列播放完毕通知(绑定本会话 ' + mySession + ',已持久化):队列播放完毕时会通知 Agent 添加新歌'
        }
        if (state.queueEndNotifySession && state.queueEndNotifySession !== mySession) return '通知绑定在其他会话(' + state.queueEndNotifySession + '),无法在此会话关闭'
        state.queueEndNotifySession = ''
        queueRev++
        saveConfig()
        return '已关闭队列播放完毕通知'
      },
    })), 'dsh-music-player.tool.queue-end-notify')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_style_apply',
      description: '应用自定义 CSS 到播放器(悬浮窗/面板/控件)。可覆盖任意 .dsh-music-* 选择器或 --dsh-* 主题变量,实时生效并持久化。传入完整 CSS 文本会替换上一次的自定义样式;用 music_style_clear 恢复默认。示例: ".dsh-music-panel{border-radius:28px}" 或 ".dsh-music-float{--dsh-glow:#ff6b9d}"',
      parameters: {
        css: { type: 'string', required: true, description: '完整的自定义 CSS 文本' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const css = String((args && args.css) || '')
        await handlers['music/style/set']({ css })
        return css ? ('已应用自定义样式(' + css.length + ' 字符),约 1-2 秒内生效。用 music_style_clear 可恢复默认。') : '已清除自定义样式'
      },
    })), 'dsh-music-player.tool.style-apply')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_style_clear',
      description: '清除播放器的自定义 CSS,恢复默认外观。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async () => {
        await handlers['music/style/set']({ css: '' })
        return '已恢复播放器默认样式'
      },
    })), 'dsh-music-player.tool.style-clear')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_style_get',
      description: '查看当前播放器的自定义 CSS 内容。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async () => {
        const css = state.customCss || ''
        return css ? ('当前自定义样式(' + css.length + ' 字符):\n' + css) : '当前没有自定义样式'
      },
    })), 'dsh-music-player.tool.style-get')

    ctx.effect(() => toolsSvc.register(makeTool({
      name: 'music_ui_config',
      description: '修改播放器 UI 配置,实时生效并持久化。可用键:glowMode(auto/custom)、glowColor(#rrggbb)、glassEnabled、glowAbove、panelTransparent、iconHidden、showIcon、showLyrics、showNext、showPlay(布尔值)、windowSize(40-120)、iconSize(16-96)、glassBlur(0-40)、glassSaturate(100-250)、glassAlpha(0-35)、radius(0-48)、glowAlpha(10-100)、glowSpeed(1-8)、iconPath、musicDir、vipCookie。',
      parameters: {
        json: { type: 'string', required: true, description: 'JSON 对象字符串,如 {"showLyrics":false,"glowColor":"#ff6b9d","radius":24}' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args) => {
        let patch = {}
        try { patch = JSON.parse(String((args && args.json) || '{}')) } catch (e) { return 'JSON 解析失败: ' + String((e && e.message) || e) }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'json 必须是对象'
        const snap = await handlers['music/settings/set'](patch)
        const keys = Object.keys(patch)
        return '已应用 ' + keys.length + ' 项配置: ' + keys.join(', ')
      },
    })), 'dsh-music-player.tool.ui-config')
  }

  // ---- JSON RPC 路由(Client 通信) ----
  const readJson = (req) => new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 262144) { req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/dsh-music/api',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        const body = await readJson(req)
        const method = typeof body.method === 'string' ? body.method : ''
        const fn = handlers[method]
        if (!fn) return send(404, { ok: false, error: 'unknown method: ' + method })
        const result = await fn((body && typeof body.args === 'object' && body.args) || {})
        return send(200, { ok: true, result })
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  }))
}
