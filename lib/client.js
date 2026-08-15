window.__ModuleLoader__.load({
	id: "dsh-music-player",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const React = react;
		var timer = {
		  timeout: function (fn, ms) { var id = setTimeout(fn, ms); return function () { clearTimeout(id) } },
		  debounce: function (fn, ms) { var t = null; return function () { if (t) clearTimeout(t); t = setTimeout(fn, ms) } },
		  interval: function (fn, ms) { var id = setInterval(fn, ms); return function () { clearInterval(id) } },
		};
		var cssBuf = '';
		function injectStyle(css) { cssBuf += css }
		function rpc(method, args) {
		  return fetch('/dsh-music/api', {
		    method: 'POST',
		    headers: { 'Content-Type': 'application/json' },
		    body: JSON.stringify({ method: method, args: args || {} }),
		  }).then(function (r) { return r.json() }).then(function (j) {
		    if (!j || !j.ok) { var e = new Error((j && j.error) || 'rpc failed: ' + method); e.rpcError = (j && j.error) || ''; throw e }
		    return j.result
		  })
		}
		function flushCss() {
		  if (typeof document === 'undefined' || !cssBuf) return
		  var tagId = 'dsh-music-player'
		  if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
		  var tag = document.createElement('style')
		  tag.dataset.plugin = 'dsh-music-player'
		  tag.dataset.pluginCss = tagId
		  tag.textContent = cssBuf
		  document.head.appendChild(tag)
		}
		function apply(ctx) {
		  var slots = ctx.slots

    const PANEL_W = 340
    const PANEL_H = 190
    const LYRIC_LINE_H = 26
    const LYRIC_VIEW_H = 78

    // ---- 共享配置 store(Client 进程内) ----
    let current = {
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
      iconLoaded: false,
      iconError: null,
    }
    const listeners = new Set()
    var settingsError = ''
    var customStyleTag = null
    function applyCustomCss(css) {
      if (typeof document === 'undefined') return
      if (!customStyleTag) {
        customStyleTag = document.createElement('style')
        customStyleTag.dataset.plugin = 'dsh-music-player'
        customStyleTag.dataset.pluginCss = 'dsh-music-player-custom'
        document.head.appendChild(customStyleTag)
      }
      customStyleTag.textContent = css || ''
    }
    function setSettings(next) {
      current = next
      settingsError = ''
      applyCustomCss(next.customCss || '')
      listeners.forEach(function (fn) { fn(current) })
    }
    function notifySettingsError(msg) {
      settingsError = msg
      listeners.forEach(function (fn) { fn(current) })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    rpc('music/settings/get').then(function (s) {
      if (s) setSettings(s)
    }).catch(function () {})

    // ---- 实时保存(防抖 350ms)----
    var pending = null
    var saveTimer = timer ? timer.debounce(function () { flush() }, 350) : null
    function flush() {
      if (!pending) return
      var req = pending
      pending = null
      rpc('music/settings/set', req).then(function (next) {
        if (next && next.error) {
          notifySettingsError(String(next.error))
        } else if (next) {
          setSettings(next)
        }
      }).catch(function () {})
    }
    function requestSave(patch) {
      pending = Object.assign({}, pending || {}, patch)
      if (saveTimer) saveTimer()
      else flush()
    }

    // ---- 滑块分组配置 ----
    var sliderGroups = [
      {
        key: 'glass',
        title: '毛玻璃',
        items: [
          { key: 'glassBlur', label: '模糊强度', min: 0, max: 40, step: 1, unit: 'px' },
          { key: 'glassSaturate', label: '色彩饱和度', min: 100, max: 250, step: 5, unit: '%' },
          { key: 'glassAlpha', label: '背景透明度', min: 0, max: 35, step: 1, unit: '%' },
        ],
      },
      {
        key: 'glow',
        title: '发光',
        items: [
          { key: 'glowAlpha', label: '发光强度', min: 10, max: 100, step: 5, unit: '%' },
          { key: 'glowSpeed', label: '发光速度', min: 1, max: 8, step: 1, unit: 's' },
        ],
      },
      {
        key: 'size',
        title: '尺寸',
        items: [
          { key: 'windowSize', label: '窗口大小', min: 40, max: 120, step: 2, unit: 'px' },
          { key: 'iconSize', label: '图标大小', min: 16, max: 96, step: 2, unit: 'px' },
          { key: 'radius', label: '圆角大小', min: 0, max: 48, step: 2, unit: 'px' },
        ],
      },
    ]

    // ---- 本地库状态(音乐文件夹 = 缓存扫描) ----
    var library = []
    var libLoading = false
    function refreshLibrary() {
      if (libLoading) return
      libLoading = true
      rpc('music/library').then(function (tracks) {
        if (Array.isArray(tracks)) library = tracks
        libLoading = false
        listeners.forEach(function (fn) { fn(current) })
      }).catch(function () {
        libLoading = false
      })
    }
    var lastDir = null
    if (timer) {
      timer.interval(function () {
        if (current.musicDir !== lastDir) {
          lastDir = current.musicDir
          refreshLibrary()
          refreshQueue()
        }
      }, 2000)
    }
    refreshLibrary()

    // ---- 播放队列状态(Client 进程内镜像,权威在 Host 配置文件) ----
    var queueItems = []
    var queueLoading = false
    var queueLoaded = false
    var notifySession = null
    var queueListeners = new Set()
    // 队列项转持久化形式(本地=路径+UUID,在线=歌曲ID对象+UUID)
    function toPersistQueue(q) {
      return q.kind === 'online'
        ? { type: 'online', id: q.id, name: q.title, artists: q.artists, album: q.album, picUrl: q.picUrl, uuid: q.uuid }
        : { type: 'local', path: q.path, uuid: q.uuid }
    }
    function queueSubscribe(fn) {
      queueListeners.add(fn)
      return function () { queueListeners.delete(fn) }
    }
    function refreshQueue() {
      if (queueLoading) return
      queueLoading = true
      rpc('music/queue/get').then(function (r) {
        queueLoading = false
        if (r && Array.isArray(r.items)) {
          queueItems = r.items
          queueLoaded = true
          notifySession = r.notifySession || null
          queueListeners.forEach(function (fn) { fn(queueItems) })
          listeners.forEach(function (fn) { fn(current) })
        }
      }).catch(function () {
        queueLoading = false
      })
    }
    refreshQueue()

    // ---- 在线播放状态(网易云单曲,播放即替换当前源) ----
    var onlineTrack = null
    var onlineListeners = new Set()
    function onlineSubscribe(fn) {
      onlineListeners.add(fn)
      return function () { onlineListeners.delete(fn) }
    }
    function setOnline(track) {
      onlineTrack = track
      onlineListeners.forEach(function (fn) { fn(track) })
      listeners.forEach(function (fn) { fn(current) })
    }
    // 下载中状态(搜索点击播放后、地址就绪前);序号用于取消上一个任务
    var pendingOnline = null
    var onlineFetchSeq = 0
    // 播放意图:搜索点击播放后,地址就绪时强制进入播放态
    var wantPlay = false
    function setPending(track) {
      pendingOnline = track
      onlineListeners.forEach(function (fn) { fn(track) })
      listeners.forEach(function (fn) { fn(current) })
    }
    function beginFetchOnline(s) {
      var seq = ++onlineFetchSeq
      wantPlay = true
      setOnline(null)
      setPending({ id: s.id, name: s.name, artists: s.artists, album: s.album, picUrl: s.picUrl })
      rpc('music/online/url', { id: s.id }).then(function (r) {
        if (seq !== onlineFetchSeq) return // 已切换歌曲,取消本次下载
        setPending(null)
        if (r && r.ok && r.url) {
          setOnline({ id: s.id, name: s.name, artists: s.artists, album: s.album, picUrl: s.picUrl, url: r.url })
        } else {
          listeners.forEach(function (fn) { fn(current) })
        }
      }).catch(function () {
        if (seq !== onlineFetchSeq) return
        setPending(null)
      })
    }

    // ---- 全局播放状态(供搜索列表等同步显示) ----
    var nowKey = null
    var nowPlayingFlag = false
    var playControls = null
    var playStateListeners = new Set()
    function playStateSubscribe(fn) {
      playStateListeners.add(fn)
      return function () { playStateListeners.delete(fn) }
    }
    function notifyPlayState() {
      playStateListeners.forEach(function (fn) { fn() })
    }
    function setNowKey(k) {
      if (nowKey !== k) {
        nowKey = k
        notifyPlayState()
      }
    }
    function setNowFlag(f) {
      if (nowPlayingFlag !== f) {
        nowPlayingFlag = f
        notifyPlayState()
      }
    }
    function registerPlayControls(c) {
      playControls = c
      return function () { if (playControls === c) playControls = null }
    }

    // ---- Toast 提示(右上角弹框,自动消失) ----
    var toasts = []
    var toastListeners = new Set()
    function toastSubscribe(fn) {
      toastListeners.add(fn)
      return function () { toastListeners.delete(fn) }
    }
    function showToast(text, ms) {
      var id = Date.now() + '-' + Math.random()
      toasts.push({ id: id, text: text })
      toastListeners.forEach(function (fn) { fn(toasts) })
      setTimeout(function () {
        toasts = toasts.filter(function (t) { return t.id !== id })
        toastListeners.forEach(function (fn) { fn(toasts) })
      }, ms || 2600)
    }

    // ---- Agent 指令轮询(上报播放状态,接收 Host 指令执行) ----
    var agentState = { trackId: null, playing: false, title: '', artist: '', lyricText: '' }
    var agentSettingsRev = 0
    var agentQueueRev = 0
    var queueEndNotify = false
    function handleAgentCmd(cmd) {
      if (!cmd) return
      if (cmd.type === 'play' && cmd.song) {
        beginFetchOnline(cmd.song)
      } else if (cmd.type === 'control' && playControls) {
        if (cmd.action === 'next') playControls.next()
        else if (cmd.action === 'prev') playControls.prev()
        else if (cmd.action === 'play') playControls.play()
        else if (cmd.action === 'pause') playControls.pause()
      }
    }
    setInterval(function () {
      rpc('music/agent/poll', {
        state: {
          trackId: agentState.trackId,
          playing: agentState.playing,
          title: agentState.title,
          artist: agentState.artist,
          lyricText: agentState.lyricText,
        },
      }).then(function (res) {
        if (res && res.cmd) handleAgentCmd(res.cmd)
        // Host 端配置/样式被 Agent 修改后,拉取最新配置同步 UI
        if (res && typeof res.settingsRev === 'number' && res.settingsRev !== agentSettingsRev) {
          agentSettingsRev = res.settingsRev
          rpc('music/settings/get').then(function (s) {
            if (s) setSettings(s)
          }).catch(function () {})
        }
        // 队列被 Agent 工具修改后,刷新队列镜像同步 UI
        if (res && typeof res.queueRev === 'number' && res.queueRev !== agentQueueRev) {
          agentQueueRev = res.queueRev
          rpc('music/queue/get').then(function (r) {
            if (r && Array.isArray(r.items)) {
              queueItems = r.items
              queueLoaded = true
              notifySession = r.notifySession || null
              queueListeners.forEach(function (fn) { fn(queueItems) })
              listeners.forEach(function (fn) { fn(current) })
            }
          }).catch(function () {})
        }
        // 播完通知开关状态
        if (res && typeof res.queueEndNotify === 'boolean') queueEndNotify = res.queueEndNotify
      }).catch(function () {})
    }, 1500)

    function hexToRgba(hex, alpha) {
      var h = String(hex || '#000000').replace('#', '')
      if (h.length !== 6) return 'rgba(0,0,0,' + alpha + ')'
      var r = parseInt(h.slice(0, 2), 16)
      var g = parseInt(h.slice(2, 4), 16)
      var b = parseInt(h.slice(4, 6), 16)
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
    }

    function pickThemeColor(img, canvas) {
      if (!img || !canvas) return null
      var w = img.naturalWidth
      var h = img.naturalHeight
      if (!w || !h) return null
      canvas.width = w
      canvas.height = h
      var g = canvas.getContext('2d')
      if (!g) return null
      g.drawImage(img, 0, 0)
      var data = null
      try { data = g.getImageData(0, 0, w, h).data } catch (e) { return null }
      var r = 0, gg = 0, b = 0, n = 0
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 40) continue
        r += data[i]
        gg += data[i + 1]
        b += data[i + 2]
        n++
      }
      if (!n) return null
      function ch(v) {
        var s = Math.round(v / n).toString(16)
        return s.length === 1 ? '0' + s : s
      }
      return '#' + ch(r) + ch(gg) + ch(b)
    }

    // ---- 样式 ----
    injectStyle('[data-shell-overlay]{z-index:1001 !important}')
    injectStyle('.dsh-music-float{position:fixed;right:24px;bottom:24px;z-index:2147483647 !important;pointer-events:auto;cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none}.dsh-music-float.dragging{cursor:grabbing}.dsh-music-glow{position:absolute;left:50%;top:50%;width:260%;height:260%;transform:translate(-50%,-50%);pointer-events:none;background:radial-gradient(circle,var(--dsh-glow,rgba(0,0,0,.5)) 0%,transparent 70%);border-radius:50%;animation:dshMusicGlow var(--dsh-glow-speed,3s) ease-in-out infinite;z-index:2}.dsh-music-float:hover .dsh-music-glow{animation:dshMusicGlowBurst 2.5s ease-in-out infinite}.dsh-music-glow.fadeout,.dsh-music-float:hover .dsh-music-glow.fadeout{animation:dshMusicGlowShrink .5s ease-in forwards}.dsh-music-icon{position:relative;width:var(--dsh-window-size,54px);height:var(--dsh-window-size,54px);border-radius:var(--dsh-radius,16px);display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid rgba(255,255,255,.18);z-index:1;perspective:400px}.dsh-music-icon.glass{background:rgba(255,255,255,var(--dsh-glass-alpha,.09));backdrop-filter:blur(var(--dsh-glass-blur,14px)) saturate(var(--dsh-glass-saturate,150%));-webkit-backdrop-filter:blur(var(--dsh-glass-blur,14px)) saturate(var(--dsh-glass-saturate,150%))}.dsh-music-icon.transparent{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none}.dsh-music-flip{position:relative;width:100%;height:100%;transform-style:preserve-3d;transition:transform .55s ease}.dsh-music-flip.open{transform:rotateY(180deg)}.dsh-music-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;display:flex;align-items:center;justify-content:center}.dsh-music-face.front{transform:rotateY(0deg)}.dsh-music-face.back{transform:rotateY(180deg);font-size:calc(var(--dsh-window-size,54px)*0.4);color:rgba(255,255,255,.9);text-shadow:0 0 8px var(--dsh-glow,rgba(0,0,0,.5))}.dsh-music-face img{width:var(--dsh-icon-size,38px);height:var(--dsh-icon-size,38px);object-fit:contain;pointer-events:none;transition:transform 1s ease}.dsh-music-float:hover .dsh-music-face img{transform:scale(1.25)}.dsh-music-icon .dsh-music-placeholder{font-size:calc(var(--dsh-icon-size,38px)*0.6);color:rgba(255,255,255,.85);pointer-events:none}.dsh-music-canvas{display:none}@keyframes dshMusicGlow{0%,100%{opacity:.3;transform:translate(-50%,-50%) scale(.8)}50%{opacity:.5;transform:translate(-50%,-50%) scale(1)}}@keyframes dshMusicGlowBurst{0%{opacity:.4;transform:translate(-50%,-50%) scale(.8)}30%{opacity:.12;transform:translate(-50%,-50%) scale(.35)}65%{opacity:.95;transform:translate(-50%,-50%) scale(1.05)}100%{opacity:.7;transform:translate(-50%,-50%) scale(1.28)}}@keyframes dshMusicGlowShrink{0%{opacity:.5;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(.15)}}@keyframes dshMusicPanelIn{0%{opacity:0}100%{opacity:1}}@keyframes dshMusicPanelOut{0%{opacity:1}100%{opacity:0}}.dsh-music-panel-wrap{position:absolute;inset:0;pointer-events:none;visibility:hidden;opacity:0}.dsh-music-panel-wrap.open{visibility:visible;opacity:1;pointer-events:auto;animation:dshMusicPanelIn .4s ease-out}.dsh-music-panel-wrap.closing{visibility:visible;pointer-events:none;animation:dshMusicPanelOut .3s ease-in}.dsh-music-panel-wrap.closing .dsh-music-panel{pointer-events:none}.dsh-music-panel{position:absolute;left:var(--dsh-panel-dx,0px);top:var(--dsh-panel-dy,0px);width:340px;height:190px;border-radius:var(--dsh-radius,20px);background:rgba(255,255,255,var(--dsh-glass-alpha,.16));backdrop-filter:blur(var(--dsh-glass-blur,14px)) saturate(var(--dsh-glass-saturate,150%));-webkit-backdrop-filter:blur(var(--dsh-glass-blur,14px)) saturate(var(--dsh-glass-saturate,150%));border:1px solid rgba(255,255,255,.18);pointer-events:auto;transition:left .45s ease,top .45s ease;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;padding:14px 16px 12px;gap:10px;color:rgba(255,255,255,.85);font-size:12px;user-select:none;-webkit-user-select:none;cursor:default}.dsh-music-panel.transparent{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;border:none;color:rgba(255,255,255,.9)}.dsh-music-top{display:flex;align-items:center;gap:12px;flex:none}.dsh-music-cover{position:relative;width:48px;height:48px;border-radius:13px;overflow:hidden;flex:none;cursor:pointer;border:1px solid rgba(255,255,255,.22);box-shadow:0 2px 12px rgba(0,0,0,.28);transition:transform .3s ease,box-shadow .6s ease}.dsh-music-cover:hover{transform:scale(1.06)}.dsh-music-cover.playing{animation:dshCoverPulse 3s ease-in-out infinite}.dsh-music-cover img{width:100%;height:100%;object-fit:cover;pointer-events:none}.dsh-music-cover .dsh-music-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:20px;color:rgba(255,255,255,.85)}@keyframes dshCoverPulse{0%,100%{box-shadow:0 2px 12px rgba(0,0,0,.28),0 0 10px 2px var(--dsh-glow,rgba(0,0,0,.5))}50%{box-shadow:0 2px 12px rgba(0,0,0,.28),0 0 20px 7px var(--dsh-glow,rgba(0,0,0,.5))}}.dsh-music-progress{flex:1;height:5px;border-radius:3px;background:rgba(255,255,255,.16);cursor:pointer;position:relative;transition:height .2s ease;touch-action:none}.dsh-music-progress:hover{height:7px}.dsh-music-progress .fill{position:absolute;left:0;top:0;bottom:0;width:var(--dsh-progress,0%);border-radius:3px;background:var(--dsh-glow,rgba(79,195,247,.8));transition:width .5s linear}.dsh-music-progress.dragging .fill{transition:none}.dsh-music-progress .thumb{position:absolute;left:var(--dsh-progress,0%);top:50%;width:10px;height:10px;border-radius:50%;background:#fff;box-shadow:0 0 5px rgba(0,0,0,.4);pointer-events:none;transform:translate(-50%,-50%);transition:transform .25s ease;z-index:2}.dsh-music-progress:hover .thumb,.dsh-music-progress.dragging .thumb{transform:translate(-50%,-50%) scale(1.3)}.dsh-music-btn{display:flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:inherit;cursor:pointer;padding:0;transition:transform .25s ease,box-shadow .4s ease,background .25s ease}.dsh-music-btn:hover{transform:scale(1.1);background:rgba(255,255,255,.18);box-shadow:0 0 14px 2px var(--dsh-glow,rgba(0,0,0,.5))}.dsh-music-btn:active{transform:scale(.93)}.dsh-music-btn.play{width:38px;height:38px;font-size:14px;flex:none}.dsh-music-btn.next{width:30px;height:30px;font-size:11px;opacity:.9;flex:none}.dsh-music-vol-wrap{position:relative;flex:none}.dsh-music-vol-pop{position:absolute;bottom:calc(100% + 10px);right:-2px;width:112px;padding:6px 8px;border-radius:10px;background:rgba(28,30,36,.94);border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 24px rgba(0,0,0,.45);display:flex;align-items:center;gap:7px;z-index:6}.dsh-music-vol-pop input[type=range]{flex:1;min-width:0;accent-color:var(--dsh-glow,#4fc3f7);height:4px;margin:0}.dsh-music-vol-pop .vol-mute{width:22px;height:22px;border-radius:7px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.1);color:inherit;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;flex:none;line-height:1}.dsh-music-vol-pop .vol-mute:hover{background:rgba(128,128,128,.22)}.dsh-music-vol-pop .v{font-size:10px;opacity:.75;min-width:30px;text-align:right;font-variant-numeric:tabular-nums;flex:none}.dsh-music-meta{flex:none;text-align:center;line-height:1.3;padding:0 4px;display:flex;align-items:baseline;justify-content:center;gap:8px}.dsh-music-meta .t{font-size:13px;font-weight:600;letter-spacing:.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}.dsh-music-meta .a{font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}.dsh-music-lyrics{position:relative;flex:1;min-height:0;overflow:hidden}.dsh-music-lyrics .track{position:absolute;left:0;right:0;top:0;transition:transform .6s ease;will-change:transform}.dsh-music-lyrics .line{height:26px;line-height:26px;text-align:center;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 12px;transition:opacity .6s ease,font-size .6s ease;color:rgba(255,255,255,.85)}.dsh-music-lyrics .line.current{font-size:15px;font-weight:600;letter-spacing:1px}.dsh-music-lyrics .line .ch{display:inline-block;font-size:15px;color:rgba(255,255,255,.72);opacity:1;transition:font-size .25s ease,color .25s ease,opacity .25s ease,text-shadow .25s ease}.dsh-music-lyrics .line .ch.lit{font-size:17px;color:#fff;text-shadow:0 0 8px var(--dsh-glow,rgba(0,0,0,.5))}.dsh-music-settings{display:flex;flex-direction:column;gap:12px;max-width:560px}.dsh-music-settings .row{display:flex;align-items:center;gap:10px}.dsh-music-settings .row label{min-width:92px;opacity:.75;flex:none}.dsh-music-settings input[type=text]{flex:1;padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.12);color:inherit}.dsh-music-settings input[type=range]{flex:1;accent-color:var(--dsh-acc, #4fc3f7)}.dsh-music-settings .val{min-width:44px;text-align:right;opacity:.8;font-size:12px;flex:none}.dsh-music-settings .preview{width:44px;height:44px;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(128,128,128,.15);flex:none}.dsh-music-settings .preview img{width:100%;height:100%;object-fit:contain}.dsh-music-settings .hint{font-size:12px;opacity:.55;line-height:1.6}.dsh-music-settings .msg{font-size:12px;opacity:.8;min-height:16px;color:var(--dsh-msg-color, rgba(255,255,255,.8))}.dsh-music-adv-head{display:flex;align-items:center;gap:8px;cursor:pointer;opacity:.85;padding:6px 0;border-top:1px solid rgba(128,128,128,.18);user-select:none;font-size:13px}.dsh-music-adv-head:hover{opacity:1}.dsh-music-adv-head .arrow{display:inline-block;transition:transform .18s ease;font-size:10px;opacity:.7}.dsh-music-adv-head .arrow.open{transform:rotate(90deg)}.dsh-music-adv-body{display:flex;flex-direction:column;gap:12px;padding-top:2px}.dsh-music-group-head{display:flex;align-items:center;gap:8px;cursor:pointer;opacity:.8;padding:4px 0 4px 8px;user-select:none;font-size:12px;color:inherit}.dsh-music-group-head:hover{opacity:1}.dsh-music-group-head .arrow{display:inline-block;transition:transform .18s ease;font-size:9px;opacity:.6}.dsh-music-group-head .arrow.open{transform:rotate(90deg)}.dsh-music-group-body{display:flex;flex-direction:column;gap:12px;padding:4px 0 4px 12px}')
    injectStyle('.dsh-music-tabs{display:flex;gap:8px;border-bottom:1px solid rgba(128,128,128,.22);padding-bottom:10px;margin-bottom:4px}.dsh-music-tab{flex:1;text-align:center;padding:7px 0;border-radius:9px;cursor:pointer;font-size:13px;opacity:.55;transition:all .2s ease;border:1px solid transparent;user-select:none}.dsh-music-tab:hover{opacity:.85}.dsh-music-tab.active{opacity:1;background:rgba(128,128,128,.16);border-color:rgba(128,128,128,.28);color:#fff;font-weight:600}.dsh-music-queue{display:flex;gap:14px;align-items:stretch}.dsh-music-qwrap{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}.dsh-music-playmode{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85;flex:none;padding:0 2px}.dsh-music-playmode .lbl{opacity:.75}.dsh-music-playmode select{flex:none;padding:4px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:rgba(28,30,36,.95);color:#fff;font-size:12px}.dsh-music-qcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}.dsh-music-qhead{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.85;flex:none}.dsh-music-qhead .cnt{opacity:.55;font-size:11px}.dsh-music-qhead .spacer{flex:1}.dsh-music-qlist{flex:1;min-height:300px;max-height:300px;overflow-y:auto;border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:6px;background:rgba(128,128,128,.07);display:flex;flex-direction:column;gap:2px}.dsh-music-qitem{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;font-size:12px;cursor:pointer;transition:background .15s ease}.dsh-music-qitem:hover{background:rgba(255,255,255,.08)}.dsh-music-qitem.dim{opacity:.55}.dsh-music-qitem .idx{opacity:.45;font-size:10px;min-width:20px;text-align:right;flex:none;font-variant-numeric:tabular-nums}.dsh-music-qitem .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-music-qitem .tag{font-size:10px;opacity:.65;flex:none;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.1)}.dsh-music-qitem .tag.miss{color:#ff9d9d;background:rgba(255,80,80,.16)}.dsh-music-qitem .tag.inq{color:#9dffb0;background:rgba(80,255,120,.13)}.dsh-music-qitem .mini{flex:none;width:22px;height:22px;border-radius:6px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.1);color:inherit;cursor:pointer;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;opacity:.75;padding:0}.dsh-music-qitem .mini:hover:not(:disabled){opacity:1;background:rgba(128,128,128,.22)}.dsh-music-qitem .mini:disabled{opacity:.25;cursor:not-allowed}.dsh-music-qitem .mini.danger:hover:not(:disabled){background:rgba(255,80,80,.25);border-color:rgba(255,120,120,.4)}.dsh-music-qfoot{display:flex;gap:8px;align-items:center;flex:none}.dsh-music-qfoot .mini-btn{padding:5px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.1);color:inherit;cursor:pointer;font-size:12px;opacity:.85;transition:all .15s ease}.dsh-music-qfoot .mini-btn:hover:not(:disabled){opacity:1;background:rgba(128,128,128,.2)}.dsh-music-qfoot .mini-btn:disabled{opacity:.35;cursor:not-allowed}.dsh-music-qfoot .mini-btn.primary{background:rgba(79,195,247,.16);border-color:rgba(79,195,247,.45)}.dsh-music-qfoot .mini-btn.danger{background:rgba(255,80,80,.13);border-color:rgba(255,120,120,.4)}.dsh-music-qcol .empty{flex:1;display:flex;align-items:center;justify-content:center;opacity:.4;font-size:12px;padding:20px 0}')
    injectStyle('.dsh-music-qitem .grip{flex:none;color:rgba(255,255,255,.35);font-size:12px;cursor:grab;padding:0 2px;user-select:none;-webkit-user-select:none}.dsh-music-qitem.drop-target{background:rgba(79,195,247,.18);box-shadow:inset 0 0 0 1px rgba(79,195,247,.55)}.dsh-music-qhead .manage-btn{padding:3px 10px;border-radius:7px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.1);color:inherit;cursor:pointer;font-size:11px;opacity:.8;flex:none;transition:all .15s ease}.dsh-music-qhead .manage-btn:hover{opacity:1}.dsh-music-qhead .manage-btn.active{background:rgba(79,195,247,.2);border-color:rgba(79,195,247,.5);opacity:1}.dsh-music-qnotify{font-size:11px;opacity:.6;flex:none;padding:0 2px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.5}.dsh-music-plimport{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;padding:0 2px;margin-top:10px;border-top:1px solid rgba(128,128,128,.18);padding-top:10px}.dsh-music-plimport .lbl{opacity:.75;flex:none}.dsh-music-plimport input[type=text]{flex:1;min-width:0;padding:5px 9px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.12);color:inherit;font-size:12px}.dsh-music-plimport .plmsg{font-size:11px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-music-ctx-backdrop{position:fixed;inset:0;z-index:2147483646;background:transparent}.dsh-music-ctx{position:fixed;min-width:150px;background:rgba(28,30,36,.97);border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:5px;box-shadow:0 10px 34px rgba(0,0,0,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:2147483647;user-select:none;-webkit-user-select:none}.dsh-music-ctx-item{padding:7px 14px;border-radius:7px;font-size:12.5px;cursor:pointer;color:rgba(255,255,255,.85);white-space:nowrap}.dsh-music-ctx-item:hover{background:rgba(255,255,255,.1)}.dsh-music-ctx-item.danger{color:#ff9d9d}.dsh-music-ctx-item.danger:hover{background:rgba(255,80,80,.22)}.dsh-music-ctx-item.disabled{opacity:.5;cursor:not-allowed}.dsh-music-ctx-item.disabled:hover{background:transparent}')
    injectStyle('.dsh-music-search{display:flex;flex-direction:column;gap:10px}.dsh-music-search .bar{display:flex;gap:8px}.dsh-music-search input[type=text]{flex:1;padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.12);color:inherit}.dsh-music-slist{display:flex;flex-direction:column;gap:3px;max-height:400px;overflow-y:auto;padding:2px}.dsh-music-sitem{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:9px;cursor:pointer;transition:background .15s ease}.dsh-music-sitem:hover{background:rgba(255,255,255,.08)}.dsh-music-sitem.playing{background:rgba(79,195,247,.14)}.dsh-music-sitem .thumb{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none;background:rgba(128,128,128,.15)}.dsh-music-sitem .thumb.ph{display:flex;align-items:center;justify-content:center;font-size:16px;color:rgba(255,255,255,.5)}.dsh-music-sitem .meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsh-music-sitem .meta .name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-music-sitem .meta .sub{font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-music-sitem .dur{font-size:11px;opacity:.5;flex:none;font-variant-numeric:tabular-nums}.dsh-music-sitem .play-ico{flex:none;font-size:12px;opacity:.7;min-width:14px;text-align:center}.dsh-music-sitem .acts{display:flex;gap:6px;flex:none;align-items:center}.dsh-music-sitem .sbtn{width:28px;height:28px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.12);color:inherit;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:all .15s ease;padding:0;line-height:1}.dsh-music-sitem .sbtn:hover{background:rgba(128,128,128,.25)}.dsh-music-sitem .sbtn.play.active{background:rgba(79,195,247,.25);border-color:rgba(79,195,247,.6);color:#fff}.dsh-music-sitem .sbtn.add{color:#9dffb0}.dsh-music-sitem .sbtn.add:hover{background:rgba(80,255,120,.18);border-color:rgba(80,255,120,.4)}.dsh-music-search .hint{font-size:12px;opacity:.5;padding:14px 6px;text-align:center;line-height:1.7}')
    injectStyle('.dsh-music-toasts{position:fixed;top:18px;right:18px;display:flex;flex-direction:column;gap:8px;z-index:2147483647;pointer-events:none;max-width:340px}.dsh-music-toast{padding:9px 15px;border-radius:10px;background:rgba(28,30,36,.95);border:1px solid rgba(255,120,120,.45);color:#ffb4b4;font-size:13px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.45);animation:dshToastIn .25s ease-out;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@keyframes dshToastIn{0%{opacity:0;transform:translateX(14px)}100%{opacity:1;transform:translateX(0)}}')

    // ---- 播放器面板内容(播放队列) ----
    function NowPlayingPanel() {
      var s = current
      var trackIdxPair = React.useState(0)
      var playingPair = React.useState(false)
      var timePair = React.useState(0)
      var durPair = React.useState(0)
      var lyricsPair = React.useState(null)
      var lastCtxPair = React.useState(0)
      var audioRef = React.useRef(null)
      var coverFailPair = React.useState(false)
      var lastClickRef = React.useRef(0)
      var clickTimerRef = React.useRef(null)
      var curPathRef = React.useRef(null)
      var playingRef = React.useRef(false)
      var onlineTickPair = React.useState(0)
      var onlineReadyPair = React.useState(false)
      var dragProgressPair = React.useState(false)
      var volPair = React.useState(100)
      var mutedPair = React.useState(false)
      var volOpenPair = React.useState(false)
      var playFailPair = React.useState(false)
      var skipCountRef = React.useRef(0)
      var endedPair = React.useState(false)

      var trackIdx = trackIdxPair[0]
      var playing = playingPair[0]
      var curTime = timePair[0]
      var duration = durPair[0]
      var lyrics = lyricsPair[0]
      var coverFail = coverFailPair[0]
      var onlineReady = onlineReadyPair[0]
      var dragProgress = dragProgressPair[0]
      var vol = volPair[0]
      var muted = mutedPair[0]
      var volOpen = volOpenPair[0]
      var playFail = playFailPair[0]
      var ended = endedPair[0]

      var online = onlineTrack
      var isOnline = !!online
      var isPending = !!pendingOnline && !isOnline
      // 队列播放完毕(ended)时进入无歌曲状态
      var track = (isOnline || ended) ? online : (queueItems.length ? queueItems[trackIdx % queueItems.length] : null)
      var trackId = null
      if (track) {
        if (isOnline) trackId = 'online:' + online.id
        else if (track.kind === 'online') trackId = 'online:' + track.id
        else trackId = track.path
      }

      // 在线歌曲变化时触发重渲染
      React.useEffect(function () {
        return onlineSubscribe(function () {
          onlineTickPair[1](function (t) { return t + 1 })
        })
      }, [])

      // 全局播放状态同步(搜索列表按钮/播放器按钮一致)
      React.useEffect(function () {
        setNowKey(trackId)
      }, [trackId])
      React.useEffect(function () {
        setNowFlag(playing)
      }, [playing])
      React.useEffect(function () {
        return registerPlayControls({
          toggle: togglePlay,
          next: function () { nextTrack() },
          prev: function () { prevTrack() },
          play: function () { if (!playingRef.current) playingPair[1](true) },
          pause: function () { if (playingRef.current) playingPair[1](false) },
        })
      })

      React.useEffect(function () {
        if (!trackId) return
        lyricsPair[1](null)
        coverFailPair[1](false)
        if (isOnline || (track && track.kind === 'online')) {
          rpc('music/online/lyric', { id: isOnline ? online.id : track.id }).then(function (res) {
            if (res && res.ok && Array.isArray(res.lines) && res.lines.length) {
              lyricsPair[1](res.lines)
            } else {
              lyricsPair[1]([])
            }
          }).catch(function () {
            lyricsPair[1]([])
          })
        } else {
          rpc('music/lrc', { path: trackId }).then(function (res) {
            if (res && Array.isArray(res.lines) && res.lines.length) {
              lyricsPair[1](res.lines)
            } else {
              lyricsPair[1]([])
            }
          }).catch(function () {
            lyricsPair[1]([])
          })
        }
      }, [trackId])

      var curTrackIdRef = React.useRef(null)
      React.useEffect(function () {
        curTrackIdRef.current = trackId
        timePair[1](0)
        durPair[1](0)
        playFailPair[1](false)
        var el = audioRef.current
        if (!el) return
        if (!trackId) {
          // 无曲目(下载中/清空):立即中止当前加载
          el.pause()
          el.removeAttribute('src')
          el.load()
          onlineReadyPair[1](false)
          return
        }
        var isOnlineNow = trackId.indexOf('online:') === 0
        if (isOnlineNow) {
          // 在线曲目:搜索单曲直接复用已取到的地址,队列在线项播放时实时获取(不缓存 CDN 链接)
          onlineReadyPair[1](false)
          var oid = trackId.slice(7)
          var direct = (onlineTrack && String(onlineTrack.id) === oid && onlineTrack.url) ? onlineTrack.url : null
          function applyOnlineSrc(src) {
            el.src = src
            el.load()
            onlineReadyPair[1](true)
            skipCountRef.current = 0
            if (wantPlay) {
              // 搜索点击播放:地址就绪后强制进入播放态
              wantPlay = false
              playingRef.current = true
              playingPair[1](true)
            }
            if (playingRef.current) el.play().catch(function () {})
          }
          if (direct) {
            applyOnlineSrc(direct)
          } else {
            rpc('music/online/url', { id: oid }).then(function (r) {
              // 已切换歌曲:丢弃本次结果,取消下载
              if (!el || curTrackIdRef.current !== trackId) return
              if (r && r.ok && r.url) applyOnlineSrc(r.url)
              else onPlayFail()
            }).catch(function () {
              if (!el || curTrackIdRef.current !== trackId) return
              onPlayFail()
            })
          }
        } else {
          onlineReadyPair[1](true)
          el.src = '/dsh-music/audio?path=' + encodeURIComponent(trackId)
          el.load()
          skipCountRef.current = 0
          // 切歌/自动连播后恢复播放(playing 未变化时 play() 不会自动触发)
          if (playingRef.current) el.play().catch(function () {})
        }
      }, [trackId])

      React.useEffect(function () {
        playingRef.current = playing
        var el = audioRef.current
        if (!el || !trackId) return
        if (playing) {
          el.play().catch(function () {})
        } else {
          el.pause()
        }
      }, [playing])

      // 记录当前播放路径;队列变化时保持当前曲目,被移除则夹紧索引
      React.useEffect(function () {
        if (trackId) curPathRef.current = trackId
      }, [trackId])

      React.useEffect(function () {
        if (isOnline) return
        if (!queueItems.length) {
          trackIdxPair[1](0)
          return
        }
        if (ended) {
          // 队列播放完毕后有新歌曲加入:自动开始播放
          endedPair[1](false)
          trackIdxPair[1](0)
          playingPair[1](true)
          playingRef.current = true
          return
        }
        var idx = -1
        for (var i = 0; i < queueItems.length; i++) {
          if (queueItems[i].key === curPathRef.current) { idx = i; break }
        }
        if (idx < 0) idx = Math.max(0, Math.min(trackIdx, queueItems.length - 1))
        trackIdxPair[1](idx)
      }, [queueItems])

      function onTimeUpdate() {
        var el = audioRef.current
        if (el) {
          timePair[1](el.currentTime)
          if (el.duration && isFinite(el.duration)) durPair[1](el.duration)
        }
      }
      function onEnded() {
        // 在线单曲播完:回队列(若有歌则自动继续);队列为空且开启通知 → 通知
        if (isOnline) {
          if (queueEndNotify && queueItems.length === 0) {
            var el0 = audioRef.current
            if (el0) { el0.pause(); el0.currentTime = 0 }
            playingPair[1](false)
            rpc('music/queue/ended', {}).catch(function () {})
            return
          }
          setOnline(null)
          return
        }
        if (!queueItems.length) return
        // 顺序播放:播完当前曲目即从队列移除;队列清空后进入无歌曲状态并(可选)通知
        if (current.playMode === 'seq') {
          var seqKey = track.key
          var seqRaw = queueItems.filter(function (q) { return q.key !== seqKey }).map(toPersistQueue)
          rpc('music/queue/set', { items: seqRaw }).then(function (r) {
            if (r && Array.isArray(r.items)) {
              queueItems = r.items
              queueLoaded = true
              queueListeners.forEach(function (fn) { fn(queueItems) })
              listeners.forEach(function (fn) { fn(current) })
              if (r.items.length === 0) {
                var el = audioRef.current
                if (el) { el.pause(); el.currentTime = 0 }
                playingPair[1](false)
                endedPair[1](true)
                if (queueEndNotify) rpc('music/queue/ended', {}).catch(function () {})
              }
            }
          }).catch(function () {})
          return
        }
        // 循环播放:最后一首播完从头开始(不通知、不清空)
        if (trackIdx >= queueItems.length - 1) {
          trackIdxPair[1](0)
          return
        }
        trackIdxPair[1](function (t) { return t + 1 })
      }
      function onLoadedMeta() {
        var el = audioRef.current
        if (el && el.duration && isFinite(el.duration)) durPair[1](el.duration)
      }

      function togglePlay() {
        if (!track) {
          // 播完状态(无歌曲)下点播放:从队列第一首重新开始
          if (ended && queueItems.length) {
            endedPair[1](false)
            trackIdxPair[1](0)
            playingPair[1](true)
            playingRef.current = true
          }
          return
        }
        playingPair[1](function (p) { return !p })
      }
      function nextTrack() {
        if (ended) endedPair[1](false)
        if (isOnline) {
          setOnline(null)
          return
        }
        if (!queueItems.length) return
        trackIdxPair[1](function (t) { return (t + 1) % queueItems.length })
      }
      function prevTrack() {
        if (ended) endedPair[1](false)
        if (isOnline) {
          setOnline(null)
          return
        }
        if (!queueItems.length) return
        trackIdxPair[1](function (t) { return (t - 1 + queueItems.length) % queueItems.length })
      }
      function seekFromEvent(e) {
        var el = audioRef.current
        if (!el || !duration) return
        var rect = e.currentTarget.getBoundingClientRect()
        var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        el.currentTime = pct * duration
        timePair[1](el.currentTime)
      }
      function onProgressDown(e) {
        var el = audioRef.current
        if (!el) return
        e.currentTarget.setPointerCapture(e.pointerId)
        dragProgressPair[1](true)
        seekFromEvent(e)
      }
      function onProgressMove(e) {
        if (!dragProgress) return
        seekFromEvent(e)
      }
      function onProgressUp() {
        dragProgressPair[1](false)
      }
      function toggleMute() {
        var el = audioRef.current
        if (muted || vol <= 0) {
          mutedPair[1](false)
          if (vol <= 0) {
            volPair[1](100)
            if (el) el.volume = 1
          }
          if (el) el.muted = false
        } else {
          mutedPair[1](true)
          if (el) el.muted = true
        }
      }
      function onVolChange(e) {
        var v = Number(e.target.value)
        volPair[1](v)
        mutedPair[1](false)
        var el = audioRef.current
        if (el) { el.volume = v / 100; el.muted = false }
      }
      // 播放失败防呆:队列中的歌曲(在线取地址失败/本地播放失败)轮到它时自动跳过,
      // 并在右上角弹提示;整轮都失败则停在当前并提示,避免无限循环
      function onPlayFail() {
        playFailPair[1](true)
        var ql = queueItems.length
        var isQueueItem = !isOnline && track && (track.kind === 'online' || track.kind === 'local')
        if (isQueueItem && ql > 1) {
          skipCountRef.current = skipCountRef.current + 1
          if (skipCountRef.current < ql) {
            showToast('歌曲不可用,已自动跳过「' + track.title + '」')
            nextTrack()
          } else {
            skipCountRef.current = 0
            showToast('歌曲不可用:「' + track.title + '」')
          }
        } else {
          showToast('歌曲不可用' + (track ? ':「' + track.title + '」' : ''))
        }
      }

      function onCoverClick() {
        var now = Date.now()
        if (now - lastClickRef.current < 300) {
          lastClickRef.current = 0
          if (clickTimerRef.current) {
            clickTimerRef.current()
            clickTimerRef.current = null
          }
          nextTrack()
          return
        }
        lastClickRef.current = now
        if (timer) {
          clickTimerRef.current = timer.timeout(function () {
            clickTimerRef.current = null
            togglePlay()
          }, 300)
        } else {
          togglePlay()
        }
      }
      function onCoverDoubleClick() {
        var now = Date.now()
        lastClickRef.current = now
        if (clickTimerRef.current) {
          clickTimerRef.current()
          clickTimerRef.current = null
        }
        nextTrack()
      }
      function onCoverContextMenu(e) {
        e.preventDefault()
        var now = Date.now()
        var last = lastCtxPair[0]
        lastCtxPair[1](now)
        if (last && now - last < 400) {
          prevTrack()
          lastCtxPair[1](0)
        }
      }

      var noQueue = !queueItems.length && !isOnline && !isPending
      var downloading = isPending
      var loadingAudio = (isOnline || (track && track.kind === 'online')) && !onlineReady
      var progress = duration > 0 ? (curTime / duration) * 100 : 0

      var lyricLen = lyrics ? lyrics.length : 0
      var offset = 0
      if (lyricLen) {
        for (var i = 0; i < lyricLen; i++) {
          if (curTime >= lyrics[i].t) offset = i
        }
      }
      var line = lyricLen ? lyrics[offset] : null
      var text = line ? line.text : ''
      var chars = Array.from(text || '')
      var len = Math.max(1, chars.length)
      var nextT = (line && offset < lyricLen - 1) ? lyrics[offset + 1].t : duration
      var perChar = (line && nextT > line.t) ? (nextT - line.t) / len : 1
      var charIdx = line ? Math.min(len, Math.max(0, Math.floor((curTime - line.t) / perChar))) : 0
      var translateY = -(offset * LYRIC_LINE_H) + (LYRIC_VIEW_H - LYRIC_LINE_H) / 2

      var lineViews
      if (downloading) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.6 } }, '正在下载 ' + (pendingOnline.name || '歌曲') + ' …')
      } else if (playFail) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.5 } }, '加载失败,请换一首或稍后重试')
      } else if (loadingAudio) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.5 } }, '加载中...')
      } else if (ended) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.5 } }, '队列已播放完毕,添加歌曲后将自动播放')
      } else if (noQueue) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.5 } }, '队列为空,请到 设置→队列 添加歌曲')
      } else if (!lyricLen) {
        lineViews = React.createElement('div', { className: 'line', style: { opacity: 0.5 } }, '暂无歌词')
      } else {
        lineViews = lyrics.map(function (ly, i) {
          var dist = Math.abs(i - offset)
          var cls = 'line' + (i === offset ? ' current' : '')
          var op = dist === 0 ? 1 : dist === 1 ? 0.5 : 0.16
          var content
          if (i === offset) {
            content = chars.map(function (c, j) {
              // 空格单独成字时会被 CSS 折叠掉,改用不换行空格保留
              var ch = (c === ' ' || c === '\u3000') ? '\u00A0' : c
              return React.createElement('span', { key: j, className: 'ch' + (j < charIdx ? ' lit' : '') }, ch)
            })
          } else {
            content = ly.text
          }
          return React.createElement('div', { key: i, className: cls, style: { opacity: op } }, content)
        })
      }

      var title = downloading
        ? (pendingOnline.name || '未在播放')
        : (track ? ((isOnline || track.kind === 'online') ? (track.name || track.title) : track.title) : '未在播放')
      var artist = downloading
        ? (pendingOnline.artists || '')
        : (track ? ((isOnline || track.kind === 'online') ? (track.artists || '') : track.artist) : '')
      // 上报当前播放状态(Agent 轮询读取)
      agentState.trackId = trackId
      agentState.playing = playing
      agentState.title = title
      agentState.artist = artist
      agentState.lyricText = (lyrics || []).map(function (l) { return l.text }).join('\n')
      // 封面:下载/加载中显示默认图标;在线用网易云封面图,本地 mp3 用内嵌封面;失败回退悬浮窗图标
      var coverSrc = null
      if (!downloading && !loadingAudio && track) {
        if ((isOnline || track.kind === 'online') && track.picUrl && !coverFail) {
          coverSrc = track.picUrl
        } else if (track.ext === '.mp3' && !coverFail) {
          coverSrc = '/dsh-music/cover?path=' + encodeURIComponent(track.path)
        }
      }
      if (!coverSrc) coverSrc = s.iconLoaded ? '/dsh-music/icon?p=' + Date.now() : null

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 8 } },
        React.createElement('audio', {
          ref: audioRef,
          preload: 'metadata',
          volume: vol / 100,
          muted: muted,
          onTimeUpdate: onTimeUpdate,
          onEnded: onEnded,
          onLoadedMetadata: onLoadedMeta,
          onError: function () {
            // 仅当错误发生在当前曲目的 src 上时才触发防呆(切歌时旧请求中止不应误判)
            var el = audioRef.current
            if (!el || !trackId) return
            var cur = el.getAttribute('src') || ''
            if (trackId.indexOf('online:') === 0) {
              onPlayFail()
            } else if (cur.indexOf(encodeURIComponent(trackId)) >= 0) {
              onPlayFail()
            }
          },
          style: { display: 'none' },
        }),
        React.createElement('div', { className: 'dsh-music-top' },
          s.showIcon
            ? React.createElement('div', {
              className: 'dsh-music-cover' + (playing ? ' playing' : ''),
              onClick: onCoverClick,
              onDoubleClick: onCoverDoubleClick,
              onContextMenu: onCoverContextMenu,
              title: '单击 播放/暂停 · 双击 下一首 · 右键双击 上一首',
            },
              coverSrc
                ? React.createElement('img', {
                  src: coverSrc,
                  draggable: false,
                  onError: function () {
                    if (!coverFail) coverFailPair[1](true)
                  },
                })
                : React.createElement('span', { className: 'dsh-music-placeholder' }, '♪'),
            )
            : null,
          React.createElement('div', {
            className: 'dsh-music-progress' + (dragProgress ? ' dragging' : ''),
            onPointerDown: onProgressDown,
            onPointerMove: onProgressMove,
            onPointerUp: onProgressUp,
            style: { '--dsh-progress': progress + '%' },
          },
            React.createElement('div', { className: 'fill' }),
            React.createElement('div', { className: 'thumb' }),
          ),
          s.showNext
            ? React.createElement('button', { className: 'dsh-music-btn next', onClick: function (e) { e.stopPropagation(); nextTrack() } }, '⏭')
            : null,
          s.showPlay
            ? React.createElement('button', { className: 'dsh-music-btn play', onClick: function (e) { e.stopPropagation(); togglePlay() } }, playing ? '❚❚' : '▶')
            : null,
          React.createElement('div', { className: 'dsh-music-vol-wrap' },
            React.createElement('button', {
              className: 'dsh-music-btn next',
              onClick: function (e) { e.stopPropagation(); volOpenPair[1](!volOpen) },
              title: '音量',
            }, (muted || vol <= 0) ? '🔇' : '🔊'),
            volOpen
              ? React.createElement('div', { className: 'dsh-music-vol-pop', onClick: function (e) { e.stopPropagation() } },
                React.createElement('button', {
                  className: 'vol-mute',
                  onClick: function (e) { e.stopPropagation(); toggleMute() },
                  title: '静音/恢复',
                }, (muted || vol <= 0) ? '🔇' : '🔊'),
                React.createElement('input', { type: 'range', min: 0, max: 100, step: 1, value: muted ? 0 : vol, onChange: onVolChange }),
                React.createElement('span', { className: 'v' }, (muted ? 0 : vol) + '%'),
              )
              : null,
          ),
        ),
        React.createElement('div', { className: 'dsh-music-meta' },
          React.createElement('span', { className: 't' }, title),
          React.createElement('span', { className: 'a' }, artist),
        ),
        s.showLyrics
          ? React.createElement('div', { className: 'dsh-music-lyrics' },
            React.createElement('div', { className: 'track', style: { transform: 'translateY(' + translateY + 'px)' } }, lineViews),
          )
          : null,
      )
    }

    // ---- 悬浮窗 ----
    function FloatWindow() {
      var s = current
      var tickPair = React.useState(0)
      var posPair = React.useState(null)
      var dragPair = React.useState(null)
      var movedPair = React.useState(false)
      var openPair = React.useState(false)
      var closingPair = React.useState(false)
      var sidePair = React.useState('left')
      var dyPair = React.useState(0)
      var extractedPair = React.useState(null)
      var retryPair = React.useState(0)
      var toastListPair = React.useState([])
      var imgRef = React.useRef(null)
      var canvasRef = React.useRef(null)
      var floatRef = React.useRef(null)

      var pos = posPair[0]
      var drag = dragPair[0]
      var moved = movedPair[0]
      var open = openPair[0]
      var closing = closingPair[0]
      var side = sidePair[0]
      var dy = dyPair[0]
      var extracted = extractedPair[0]
      var retry = retryPair[0]
      var toastList = toastListPair[0]

      React.useEffect(function () {
        return toastSubscribe(function (list) { toastListPair[1](list.slice()) })
      }, [])

      React.useEffect(function () {
        return subscribe(function () {
          tickPair[1](function (t) { return t + 1 })
        })
      }, [])

      React.useEffect(function () {
        extractedPair[1](null)
      }, [s.iconPath, retry])

      React.useEffect(function () {
        if (!open && !s.iconHidden) return
        var el = floatRef.current
        if (!el) return
        var rect = el.getBoundingClientRect()
        var doc = el.ownerDocument
        var vw = doc.documentElement.clientWidth
        var vh = doc.documentElement.clientHeight
        var gap = 12, pad = 8
        sidePair[1](rect.right + PANEL_W + gap <= vw ? 'right' : 'left')
        var d = 0
        if (rect.top + d + PANEL_H > vh - pad) d = vh - pad - rect.top - PANEL_H
        dyPair[1](d)
      }, [open, pos, s.windowSize, s.iconHidden])

      function onImgLoad() {
        var c = pickThemeColor(imgRef.current, canvasRef.current)
        if (c) extractedPair[1](c)
      }
      function onImgError() {
        if (!s.iconLoaded && retry < 4) {
          if (timer) {
            timer.timeout(function () { retryPair[1](retry + 1) }, 600)
          } else {
            retryPair[1](retry + 1)
          }
        }
      }

      var glow = s.glowMode === 'custom' ? s.glowColor : (extracted || s.glowColor || '#4fc3f7')
      var glowAlpha = (s.glowAlpha || 55) / 100
      var iconUrl = '/dsh-music/icon?r=' + retry
      var ws = s.windowSize || 54
      var style = {
        '--dsh-glow': hexToRgba(glow, glowAlpha),
        '--dsh-glow-strong': hexToRgba(glow, Math.min(glowAlpha * 2, 1)),
        '--dsh-window-size': ws + 'px',
        '--dsh-icon-size': (s.iconSize || 38) + 'px',
        '--dsh-glass-blur': (s.glassBlur || 14) + 'px',
        '--dsh-glass-saturate': (s.glassSaturate || 150) + '%',
        '--dsh-glass-alpha': (s.glassAlpha === undefined ? 9 : s.glassAlpha) / 100,
        '--dsh-radius': (s.radius || 16) + 'px',
        '--dsh-glow-speed': (s.glowSpeed || 3) + 's',
      }
      var dx = side === 'right' ? ws + 12 : -(PANEL_W + 12)
      style['--dsh-panel-dx'] = dx + 'px'
      style['--dsh-panel-dy'] = dy + 'px'
      if (pos) {
        style.left = pos.x + 'px'
        style.top = pos.y + 'px'
        style.right = 'auto'
        style.bottom = 'auto'
      }
      style.cursor = drag ? 'grabbing' : 'grab'

      function isInteractive(el) {
        if (el && el.closest && el.closest('.dsh-music-btn, .dsh-music-progress, .dsh-music-cover')) return true
        if (!s.iconHidden && el && el.closest && el.closest('.dsh-music-panel')) return true
        return false
      }
      function onPointerDown(e) {
        if (isInteractive(e.target)) return
        e.currentTarget.setPointerCapture(e.pointerId)
        dragPair[1]({ sx: e.clientX, sy: e.clientY })
        movedPair[1](false)
      }
      function onPointerMove(e) {
        if (!drag) return
        var mdx = Math.abs(e.clientX - drag.sx)
        var mdy = Math.abs(e.clientY - drag.sy)
        if (mdx + mdy > 5) movedPair[1](true)
        var rect = e.currentTarget.getBoundingClientRect()
        var doc = e.currentTarget.ownerDocument
        var vw = doc.documentElement.clientWidth
        var vh = doc.documentElement.clientHeight
        var ws = s.windowSize || 54
        var hasCard = s.iconHidden || open
        var nx = (pos ? pos.x : rect.left) + (e.clientX - drag.sx)
        var ny = (pos ? pos.y : rect.top) + (e.clientY - drag.sy)
        var minX, maxX, minY, maxY
        if (s.iconHidden) {
          minX = -dx
          maxX = vw - PANEL_W - dx
          minY = -dy
          maxY = vh - PANEL_H - dy
        } else if (hasCard) {
          minX = Math.max(0, -dx)
          maxX = Math.min(vw - ws, vw - PANEL_W - dx)
          minY = Math.max(0, -dy)
          maxY = Math.min(vh - ws, vh - PANEL_H - dy)
        } else {
          minX = 0
          maxX = vw - ws
          minY = 0
          maxY = vh - ws
        }
        nx = Math.max(minX, Math.min(maxX, nx))
        ny = Math.max(minY, Math.min(maxY, ny))
        posPair[1]({ x: nx, y: ny })
        dragPair[1]({ sx: e.clientX, sy: e.clientY })
      }
      function onPointerUp() {
        dragPair[1](null)
      }
      function onClick() {
        if (moved) {
          movedPair[1](false)
          return
        }
        if (open) {
          closingPair[1](true)
          openPair[1](false)
          if (timer) {
            timer.timeout(function () {
              closingPair[1](false)
            }, 340)
          } else {
            closingPair[1](false)
          }
        } else {
          closingPair[1](false)
          openPair[1](true)
        }
      }
      function onPanelClick(e) {
        e.stopPropagation()
      }

      // 面板透明条件:开启"面板透明",或关闭"毛玻璃背景"时,卡片都不带毛玻璃
      var panelCls = 'dsh-music-panel' + ((s.panelTransparent || !s.glassEnabled) ? ' transparent' : '')
      var panelInner = React.createElement(NowPlayingPanel)
      var toastView = React.createElement('div', { className: 'dsh-music-toasts' },
        toastList.map(function (t) {
          return React.createElement('div', { key: t.id, className: 'dsh-music-toast' }, t.text)
        })
      )

      if (s.iconHidden) {
        return React.createElement('div', {
          ref: floatRef,
          className: 'dsh-music-float' + (drag ? ' dragging' : ''),
          style: style,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
        },
          React.createElement('div', { className: 'dsh-music-panel-wrap open' },
            React.createElement('div', { className: panelCls, onClick: onPanelClick }, panelInner),
          ),
          toastView,
        )
      }

      return React.createElement('div', {
        ref: floatRef,
        className: 'dsh-music-float' + (drag ? ' dragging' : ''),
        style: style,
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onClick: onClick,
      },
        React.createElement('div', {
          className: 'dsh-music-glow' + (s.glowAbove ? ' above' : '') + (open ? ' fadeout' : ''),
        }),
        React.createElement('div', {
          className: 'dsh-music-icon ' + (s.glassEnabled ? 'glass' : 'transparent'),
        },
          React.createElement('div', { className: 'dsh-music-flip' + (open ? ' open' : '') },
            React.createElement('div', { className: 'dsh-music-face front' },
              s.iconLoaded
                ? React.createElement('img', { ref: imgRef, src: iconUrl, onLoad: onImgLoad, onError: onImgError, draggable: false })
                : React.createElement('span', { className: 'dsh-music-placeholder' }, '♪'),
            ),
            React.createElement('div', { className: 'dsh-music-face back' },
              React.createElement('span', null, '←'),
            ),
          ),
          React.createElement('canvas', { ref: canvasRef, className: 'dsh-music-canvas' }),
        ),
        React.createElement('div', { className: 'dsh-music-panel-wrap' + (open ? ' open' : '') + (closing ? ' closing' : '') },
          React.createElement('div', { className: panelCls, onClick: onPanelClick }, panelInner),
        ),
        toastView,
      )
    }

    // ---- 滑块行 ----
    function SliderRow(props) {
      return React.createElement('div', { className: 'row' },
        React.createElement('label', null, props.label),
        React.createElement('input', {
          type: 'range',
          min: props.min,
          max: props.max,
          step: props.step,
          value: props.value,
          onChange: props.onChange,
        }),
        React.createElement('span', { className: 'val' }, props.value + props.unit),
      )
    }

    // ---- 设置页:三个子夹(设置 / 队列 / 搜索,默认队列) ----
    // 子夹与搜索状态提升到模块级:切换子夹/关闭设置页再回来不丢失
    var musicTab = 'queue'
    var searchState = { q: '', results: null, err: '' }
    function MusicSettings() {
      var tabPair = React.useState(musicTab)
      var tab = tabPair[0]
      function setTab(t) {
        musicTab = t
        tabPair[1](t)
      }
      // 网易云歌单导入(整面板底部)
      var plIdPair = React.useState('')
      var plMsgPair = React.useState('')
      var plBusyPair = React.useState(false)
      var plId = plIdPair[0]
      var plMsg = plMsgPair[0]
      var plBusy = plBusyPair[0]
      function importPlaylist() {
        var id = plId.trim()
        if (!id || plBusy) return
        plBusyPair[1](true)
        plMsgPair[1]('')
        rpc('music/playlist/import', { id: id }).then(function (r) {
          plBusyPair[1](false)
          if (r && r.ok) {
            plMsgPair[1]('成功导入 ' + r.added + ' 首(歌单共 ' + r.total + ' 首' + (r.source ? ',来源:' + r.source : '') + ')')
            plIdPair[1]('')
          } else {
            plMsgPair[1]((r && r.msg) || '导入失败')
          }
        }).catch(function () {
          plBusyPair[1](false)
          plMsgPair[1]('导入失败:网络错误')
        })
      }
      return React.createElement('div', { className: 'dsh-music-settings' },
        React.createElement('div', { className: 'dsh-music-tabs' },
          React.createElement('div', { className: 'dsh-music-tab' + (tab === 'settings' ? ' active' : ''), onClick: function () { setTab('settings') } }, '设置'),
          React.createElement('div', { className: 'dsh-music-tab' + (tab === 'queue' ? ' active' : ''), onClick: function () { setTab('queue') } }, '队列'),
          React.createElement('div', { className: 'dsh-music-tab' + (tab === 'search' ? ' active' : ''), onClick: function () { setTab('search') } }, '搜索'),
        ),
        tab === 'queue' ? React.createElement(QueuePanel) : (tab === 'search' ? React.createElement(SearchPanel) : React.createElement(SettingsBody)),
        React.createElement('div', { className: 'dsh-music-plimport' },
          React.createElement('span', { className: 'lbl' }, '网易云歌单ID:'),
          React.createElement('input', { type: 'text', value: plId, onChange: function (e) { plIdPair[1](e.target.value) }, placeholder: '歌单链接或纯数字 ID' }),
          React.createElement('button', { className: 'mini-btn primary', disabled: plBusy || !plId.trim(), onClick: importPlaylist }, plBusy ? '导入中…' : '导入'),
          plMsg ? React.createElement('span', { className: 'plmsg' }, plMsg) : null,
        ),
      )
    }

    // ---- 设置内容(原设置页,实时保存) ----
    function SettingsBody() {
      var s = current
      var tickPair = React.useState(0)
      var pathPair = React.useState(current.iconPath)
      var dirPair = React.useState(current.musicDir)
      var modePair = React.useState(current.glowMode)
      var colorPair = React.useState(current.glowColor)
      var glassPair = React.useState(current.glassEnabled)
      var abovePair = React.useState(current.glowAbove)
      var panelPair = React.useState(current.panelTransparent)
      var hidePair = React.useState(current.iconHidden)
      var showIconPair = React.useState(current.showIcon)
      var showLyricsPair = React.useState(current.showLyrics)
      var showNextPair = React.useState(current.showNext)
      var showPlayPair = React.useState(current.showPlay)
      var draftPair = React.useState({})
      var openPair = React.useState(false)
      var openMapPair = React.useState({})
      var msgPair = React.useState('')
      var cookiePair = React.useState(current.vipCookie || '')
      var apiPrimaryPair = React.useState(current.apiPrimary || 'https://music.163.com/api')
      var apiFallbackPair = React.useState(current.apiFallback || 'https://apis.netstart.cn/music')

      var pathInput = pathPair[0]
      var setPathInput = pathPair[1]
      var dirInput = dirPair[0]
      var setDirInput = dirPair[1]
      var glowMode = modePair[0]
      var setGlowMode = modePair[1]
      var glowColor = colorPair[0]
      var setGlowColor = colorPair[1]
      var glassEnabled = glassPair[0]
      var setGlassEnabled = glassPair[1]
      var glowAbove = abovePair[0]
      var setGlowAbove = abovePair[1]
      var panelTransparent = panelPair[0]
      var setPanelTransparent = panelPair[1]
      var iconHidden = hidePair[0]
      var setIconHidden = hidePair[1]
      var showIcon = showIconPair[0]
      var setShowIcon = showIconPair[1]
      var showLyrics = showLyricsPair[0]
      var setShowLyrics = showLyricsPair[1]
      var showNext = showNextPair[0]
      var setShowNext = showNextPair[1]
      var showPlay = showPlayPair[0]
      var setShowPlay = showPlayPair[1]
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var advOpen = openPair[0]
      var setAdvOpen = openPair[1]
      var openMap = openMapPair[0]
      var setOpenMap = openMapPair[1]
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      var cookieInput = cookiePair[0]
      var setCookieInput = cookiePair[1]
      var apiPrimaryInput = apiPrimaryPair[0]
      var setApiPrimaryInput = apiPrimaryPair[1]
      var apiFallbackInput = apiFallbackPair[0]
      var setApiFallbackInput = apiFallbackPair[1]

      React.useEffect(function () {
        return subscribe(function () {
          pathPair[1](current.iconPath)
          dirPair[1](current.musicDir)
          modePair[1](current.glowMode)
          colorPair[1](current.glowColor)
          glassPair[1](current.glassEnabled)
          abovePair[1](current.glowAbove)
          panelPair[1](current.panelTransparent)
          hidePair[1](current.iconHidden)
          showIconPair[1](current.showIcon)
          showLyricsPair[1](current.showLyrics)
          showNextPair[1](current.showNext)
          showPlayPair[1](current.showPlay)
          cookiePair[1](current.vipCookie || '')
          apiPrimaryPair[1](current.apiPrimary || 'https://music.163.com/api')
          apiFallbackPair[1](current.apiFallback || 'https://apis.netstart.cn/music')
          draftPair[1]({})
          msgPair[1](settingsError || (current.iconError ? '图标加载失败: ' + current.iconError : ''))
          tickPair[1](function (t) { return t + 1 })
        })
      }, [])

      function onPathChange(e) {
        setPathInput(e.target.value)
        requestSave({ iconPath: e.target.value })
      }
      function onDirChange(e) {
        setDirInput(e.target.value)
        requestSave({ musicDir: e.target.value })
      }
      function onCookieChange(e) {
        setCookieInput(e.target.value)
        requestSave({ vipCookie: e.target.value })
      }
      function onApiPrimaryChange(e) {
        setApiPrimaryInput(e.target.value)
        requestSave({ apiPrimary: e.target.value })
      }
      function onApiFallbackChange(e) {
        setApiFallbackInput(e.target.value)
        requestSave({ apiFallback: e.target.value })
      }
      function onModeChange(e) {
        setGlowMode(e.target.value)
        requestSave({ glowMode: e.target.value })
      }
      function onColorChange(e) {
        setGlowColor(e.target.value)
        requestSave({ glowColor: e.target.value })
      }
      function onGlassChange(e) {
        setGlassEnabled(e.target.value === 'on')
        requestSave({ glassEnabled: e.target.value === 'on' })
      }
      function onAboveChange(e) {
        setGlowAbove(e.target.value === 'on')
        requestSave({ glowAbove: e.target.value === 'on' })
      }
      function onPanelChange(e) {
        setPanelTransparent(e.target.value === 'on')
        requestSave({ panelTransparent: e.target.value === 'on' })
      }
      function onHideChange(e) {
        setIconHidden(e.target.value === 'on')
        requestSave({ iconHidden: e.target.value === 'on' })
      }
      function onShowIconChange(e) {
        setShowIcon(e.target.value === 'on')
        requestSave({ showIcon: e.target.value === 'on' })
      }
      function onShowLyricsChange(e) {
        setShowLyrics(e.target.value === 'on')
        requestSave({ showLyrics: e.target.value === 'on' })
      }
      function onShowNextChange(e) {
        setShowNext(e.target.value === 'on')
        requestSave({ showNext: e.target.value === 'on' })
      }
      function onShowPlayChange(e) {
        setShowPlay(e.target.value === 'on')
        requestSave({ showPlay: e.target.value === 'on' })
      }
      function onSliderChange(key) {
        return function (e) {
          var v = Number(e.target.value)
          var d = Object.assign({}, draft, {})
          d[key] = v
          setDraft(d)
          var patch = {}
          patch[key] = v
          requestSave(patch)
        }
      }
      function sliderValue(key) {
        return draft[key] !== undefined ? draft[key] : s[key]
      }
      function toggleGroup(gkey) {
        var m = Object.assign({}, openMap, {})
        m[gkey] = !m[gkey]
        setOpenMap(m)
      }

      var groupViews = sliderGroups.map(function (grp) {
        var items = grp.items.map(function (sl) {
          return React.createElement(SliderRow, {
            key: sl.key,
            label: sl.label,
            min: sl.min,
            max: sl.max,
            step: sl.step,
            unit: sl.unit,
            value: sliderValue(sl.key),
            onChange: onSliderChange(sl.key),
          })
        })
        return React.createElement('div', { key: grp.key },
          React.createElement('div', {
            className: 'dsh-music-group-head',
            onClick: function () { toggleGroup(grp.key) },
          },
            React.createElement('span', { className: 'arrow' + (openMap[grp.key] ? ' open' : '') }, '▶'),
            React.createElement('span', null, grp.title),
          ),
          openMap[grp.key]
            ? React.createElement('div', { className: 'dsh-music-group-body' }, items)
            : null,
        )
      })

      return React.createElement('div', null,
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '当前图标'),
          React.createElement('div', { className: 'preview' },
            s.iconLoaded
              ? React.createElement('img', { src: '/dsh-music/icon?p=' + Date.now() })
              : React.createElement('span', null, '♪'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '图标路径'),
          React.createElement('input', { type: 'text', value: pathInput, onChange: onPathChange, placeholder: 'C:\\path\\icon.ico' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '音乐文件夹'),
          React.createElement('input', { type: 'text', value: dirInput, onChange: onDirChange, placeholder: 'C:\\Music\\扫描子目录(缓存)' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '网易云Cookie'),
          React.createElement('input', { type: 'text', value: cookieInput, onChange: onCookieChange, placeholder: '可选:登录 music.163.com 后复制 Cookie(VIP 歌曲/音质)' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '主API地址'),
          React.createElement('input', { type: 'text', value: apiPrimaryInput, onChange: onApiPrimaryChange, placeholder: 'https://music.163.com/api (网易云官方接口,优先使用)' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '备用API地址'),
          React.createElement('input', { type: 'text', value: apiFallbackInput, onChange: onApiFallbackChange, placeholder: 'https://apis.netstart.cn/music (NeteaseCloudMusicApi框架,被限流时自动降级)' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '发光颜色'),
          React.createElement('select', { value: glowMode, onChange: onModeChange },
            React.createElement('option', { value: 'auto' }, '自动(取图标主题色)'),
            React.createElement('option', { value: 'custom' }, '手动指定'),
          ),
          React.createElement('input', { type: 'color', value: /^#[0-9a-fA-F]{6}$/.test(glowColor) ? glowColor : '#4fc3f7', onChange: onColorChange, disabled: glowMode !== 'custom' }),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '毛玻璃背景'),
          React.createElement('select', { value: glassEnabled ? 'on' : 'off', onChange: onGlassChange },
            React.createElement('option', { value: 'on' }, '开启(悬浮窗+卡片毛玻璃)'),
            React.createElement('option', { value: 'off' }, '关闭(全部透明)'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '面板透明'),
          React.createElement('select', { value: panelTransparent ? 'on' : 'off', onChange: onPanelChange },
            React.createElement('option', { value: 'off' }, '毛玻璃+边框'),
            React.createElement('option', { value: 'on' }, '透明无边框(控件悬浮)'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '隐藏悬浮窗'),
          React.createElement('select', { value: iconHidden ? 'on' : 'off', onChange: onHideChange },
            React.createElement('option', { value: 'off' }, '显示(默认)'),
            React.createElement('option', { value: 'on' }, '隐藏(纯播放器UI)'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '音乐图标'),
          React.createElement('select', { value: showIcon ? 'on' : 'off', onChange: onShowIconChange },
            React.createElement('option', { value: 'on' }, '显示'),
            React.createElement('option', { value: 'off' }, '隐藏'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '歌词'),
          React.createElement('select', { value: showLyrics ? 'on' : 'off', onChange: onShowLyricsChange },
            React.createElement('option', { value: 'on' }, '显示'),
            React.createElement('option', { value: 'off' }, '隐藏'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '下一首按钮'),
          React.createElement('select', { value: showNext ? 'on' : 'off', onChange: onShowNextChange },
            React.createElement('option', { value: 'on' }, '显示'),
            React.createElement('option', { value: 'off' }, '隐藏'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '播放/暂停按钮'),
          React.createElement('select', { value: showPlay ? 'on' : 'off', onChange: onShowPlayChange },
            React.createElement('option', { value: 'on' }, '显示'),
            React.createElement('option', { value: 'off' }, '隐藏'),
          ),
        ),
        React.createElement('div', { className: 'row' },
          React.createElement('label', null, '光晕层级'),
          React.createElement('select', { value: glowAbove ? 'on' : 'off', onChange: onAboveChange },
            React.createElement('option', { value: 'on' }, '毛玻璃之上(光穿过毛玻璃)'),
            React.createElement('option', { value: 'off' }, '毛玻璃之下(被模糊的底光)'),
          ),
        ),
        React.createElement('div', {
          className: 'dsh-music-adv-head',
          onClick: function () { setAdvOpen(!advOpen) },
        },
          React.createElement('span', { className: 'arrow' + (advOpen ? ' open' : '') }, '▶'),
          React.createElement('span', null, '详细自定义'),
        ),
        advOpen
          ? React.createElement('div', { className: 'dsh-music-adv-body' }, groupViews)
          : null,
        React.createElement('div', { className: 'msg', style: { '--dsh-msg-color': s.iconError ? '#ff8080' : 'rgba(128,255,160,.75)' } }, msg || (s.iconError ? '' : '所有设置实时保存')),
        React.createElement('div', { className: 'hint' }, '本地播放:播放顺序由 队列 子夹中的列表控制,队列保存在配置文件里(音频路径索引)。左侧列表来自音乐文件夹缓存扫描;同名 .lrc 自动加载歌词,mp3 内嵌封面自动显示。'),
      )
    }

    // ---- 音乐队列页(左:音乐文件夹缓存,右:播放队列) ----
    function QueuePanel() {
      var itemsPair = React.useState(queueItems)
      var libPair = React.useState(library)
      var qSelPair = React.useState({})
      var lSelPair = React.useState({})
      var busyPair = React.useState(false)
      var managePair = React.useState(false)
      var ctxPair = React.useState(null)
      var dragOverPair = React.useState(-1)
      var dragIdxRef = React.useRef(-1)
      var playModePair = React.useState(current.playMode || 'loop')

      var items = itemsPair[0]
      var lib = libPair[0]
      var qSel = qSelPair[0]
      var lSel = lSelPair[0]
      var busy = busyPair[0]
      var manage = managePair[0]
      var ctxMenu = ctxPair[0]
      var dragOver = dragOverPair[0]
      var playMode = playModePair[0]

      React.useEffect(function () {
        return queueSubscribe(function (it) { itemsPair[1](it) })
      }, [])
      React.useEffect(function () {
        return subscribe(function () {
          libPair[1](library)
          playModePair[1](current.playMode || 'loop')
        })
      }, [])

      // 队列变化后,剪掉已不存在的选中项
      React.useEffect(function () {
        var next = {}
        for (var k in qSel) {
          if (!qSel[k]) continue
          for (var i = 0; i < items.length; i++) {
            if (items[i].key === k) { next[k] = true; break }
          }
        }
        qSelPair[1](next)
      }, [items])

      function commitQueue(r) {
        if (r && Array.isArray(r.items)) {
          queueItems = r.items
          queueListeners.forEach(function (fn) { fn(queueItems) })
          listeners.forEach(function (fn) { fn(current) })
        }
      }
      // 队列项转持久化形式:本地=路径+UUID,在线=歌曲ID对象+UUID
      function toPersist(q) {
        return q.kind === 'online'
          ? { type: 'online', id: q.id, name: q.title, artists: q.artists, album: q.album, picUrl: q.picUrl, uuid: q.uuid }
          : { type: 'local', path: q.path, uuid: q.uuid }
      }
      function applyItems(raw) {
        busyPair[1](true)
        rpc('music/queue/set', { items: raw }).then(function (r) {
          busyPair[1](false)
          commitQueue(r)
        }).catch(function () {
          busyPair[1](false)
        })
      }
      function addSelected() {
        var add = lib.filter(function (t) { return lSel[t.id] })
        if (!add.length) return
        var inQ = {}
        for (var i = 0; i < items.length; i++) inQ[items[i].key] = true
        var raw = items.map(toPersist)
        for (var j = 0; j < add.length; j++) {
          if (add[j].path && !inQ[add[j].path]) raw.push(add[j].path)
        }
        applyItems(raw)
        lSelPair[1]({})
      }
      function importAll() {
        busyPair[1](true)
        rpc('music/queue/import-all').then(function (r) {
          busyPair[1](false)
          commitQueue(r)
        }).catch(function () {
          busyPair[1](false)
        })
      }
      function removeSelected() {
        var keep = []
        for (var i = 0; i < items.length; i++) {
          if (!qSel[items[i].key]) keep.push(toPersist(items[i]))
        }
        applyItems(keep)
        qSelPair[1]({})
      }
      function removeItem(i) {
        var raw = items.map(toPersist)
        raw.splice(i, 1)
        applyItems(raw)
      }
      function removeItemByKey(key) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].key === key) { removeItem(i); return }
        }
      }
      function addPersist(entry) {
        if (!entry) return
        var key = typeof entry === 'string' ? entry : ('online:' + entry.id)
        for (var i = 0; i < items.length; i++) {
          if (items[i].key === key) return
        }
        var raw = items.map(toPersist)
        raw.push(entry)
        applyItems(raw)
      }
      function toggleManage() {
        var next = !manage
        managePair[1](next)
        if (!next) {
          qSelPair[1]({})
          lSelPair[1]({})
        }
      }

      // ---- 右键菜单 ----
      function openCtx(e, key) {
        e.preventDefault()
        e.stopPropagation()
        ctxPair[1]({ x: e.clientX, y: e.clientY, path: key, target: 'queue' })
      }
      function openCtxLib(e, path) {
        e.preventDefault()
        e.stopPropagation()
        ctxPair[1]({ x: e.clientX, y: e.clientY, path: path, target: 'library' })
      }
      function closeCtx() {
        ctxPair[1](null)
      }

      // ---- 拖拽排序(替代上下箭头) ----
      function onDragStart(e, i) {
        dragIdxRef.current = i
        try { e.dataTransfer.setData('text/plain', String(i)) } catch (err) {}
        e.dataTransfer.effectAllowed = 'move'
      }
      function onDragOverRow(e, i) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (dragOver !== i) dragOverPair[1](i)
      }
      function onDropRow(e, i) {
        e.preventDefault()
        e.stopPropagation()
        var from = dragIdxRef.current
        dragIdxRef.current = -1
        dragOverPair[1](-1)
        if (from < 0 || from === i) return
        var raw = items.map(toPersist)
        var moved = raw.splice(from, 1)[0]
        raw.splice(i, 0, moved)
        applyItems(raw)
      }
      function onListDragOver(e) {
        e.preventDefault()
      }
      function onListDrop(e) {
        var from = dragIdxRef.current
        dragIdxRef.current = -1
        dragOverPair[1](-1)
        if (from < 0) return
        // 落在行上时由行的 onDrop 处理,这里只处理列表空白区(拖到末尾)
        if (e.target && e.target.closest && e.target.closest('.dsh-music-qitem')) return
        var raw = items.map(toPersist)
        var moved = raw.splice(from, 1)[0]
        raw.push(moved)
        applyItems(raw)
      }
      function onDragEnd() {
        dragIdxRef.current = -1
        dragOverPair[1](-1)
      }

      function qAllChecked() {
        return items.length > 0 && items.every(function (q) { return qSel[q.key] })
      }
      function toggleQAll() {
        var on = !qAllChecked()
        var next = {}
        if (on) {
          for (var i = 0; i < items.length; i++) next[items[i].key] = true
        }
        qSelPair[1](next)
      }
      function toggleQ(key) {
        var next = Object.assign({}, qSel, {})
        if (next[key]) delete next[key]
        else next[key] = true
        qSelPair[1](next)
      }
      function toggleL(id) {
        var next = Object.assign({}, lSel, {})
        if (next[id]) delete next[id]
        else next[id] = true
        lSelPair[1](next)
      }
      function toggleLAll() {
        var all = lib.length > 0 && lib.every(function (t) { return lSel[t.id] })
        var next = {}
        if (!all) {
          for (var i = 0; i < lib.length; i++) next[lib[i].id] = true
        }
        lSelPair[1](next)
      }

      var inQSet = {}
      for (var qi = 0; qi < items.length; qi++) inQSet[items[qi].key] = true
      var selCount = 0
      for (var sk in qSel) if (qSel[sk]) selCount++
      var lSelCount = 0
      for (var lk in lSel) if (lSel[lk]) lSelCount++

      var libRows = lib.map(function (t) {
        var inQ = t.path && inQSet[t.path]
        return React.createElement('div', {
          key: t.id,
          className: 'dsh-music-qitem' + (inQ ? ' dim' : ''),
          title: t.path + (inQ ? '' : '(双击添加到队列,右键更多操作)'),
          onDoubleClick: function () { addPersist(t.path) },
          onContextMenu: function (e) { openCtxLib(e, t.path) },
        },
          manage
            ? React.createElement('input', { type: 'checkbox', checked: !!lSel[t.id], onChange: function () { toggleL(t.id) } })
            : null,
          React.createElement('span', { className: 'name' }, t.title),
          inQ ? React.createElement('span', { className: 'tag inq' }, '已加入') : null,
        )
      })

      var qRows = items.map(function (q, i) {
        return React.createElement('div', {
          key: q.key,
          className: 'dsh-music-qitem' + (dragOver === i ? ' drop-target' : ''),
          title: q.kind === 'online' ? (q.title + ' - ' + (q.artists || '')) : q.path,
          draggable: true,
          onDragStart: function (e) { onDragStart(e, i) },
          onDragOver: function (e) { onDragOverRow(e, i) },
          onDrop: function (e) { onDropRow(e, i) },
          onDragEnd: onDragEnd,
          onContextMenu: function (e) { openCtx(e, q.key) },
        },
          manage
            ? React.createElement('input', { type: 'checkbox', checked: !!qSel[q.key], onChange: function () { toggleQ(q.key) } })
            : null,
          React.createElement('span', { className: 'grip' }, '≡'),
          React.createElement('span', { className: 'idx' }, (i + 1)),
          React.createElement('span', { className: 'name' }, q.title),
          q.kind === 'online'
            ? React.createElement('span', { className: 'tag inq' }, '☁ 在线')
            : (q.exists ? null : React.createElement('span', { className: 'tag miss' }, '缺失')),
        )
      })

      var ctxView = null
      if (ctxMenu) {
        var ctxItems = []
        if (ctxMenu.target === 'library') {
          var inQ = false
          for (var ci = 0; ci < items.length; ci++) {
            if (items[ci].key === ctxMenu.path) { inQ = true; break }
          }
          ctxItems.push(React.createElement('div', {
            className: 'dsh-music-ctx-item' + (inQ ? ' disabled' : ''),
            onClick: inQ ? null : function () { addPersist(ctxMenu.path); closeCtx() },
          }, inQ ? '已在队列中' : '添加到队列'))
        } else {
          ctxItems.push(React.createElement('div', { className: 'dsh-music-ctx-item danger', onClick: function () { removeItemByKey(ctxMenu.path); closeCtx() } }, '删除'))
          if (manage && selCount > 0) {
            ctxItems.push(React.createElement('div', { className: 'dsh-music-ctx-item danger', onClick: function () { removeSelected(); closeCtx() } }, '删除选中 (' + selCount + ')'))
          }
        }
        ctxView = React.createElement('div', {
          className: 'dsh-music-ctx-backdrop',
          onClick: closeCtx,
          onContextMenu: function (e) { e.preventDefault(); closeCtx() },
        },
          React.createElement('div', {
            className: 'dsh-music-ctx',
            style: { left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' },
            onClick: function (e) { e.stopPropagation() },
          }, ctxItems),
        )
      }

      return React.createElement('div', { className: 'dsh-music-qwrap' },
        React.createElement('div', { className: 'dsh-music-playmode' },
          React.createElement('span', { className: 'lbl' }, '播放模式:'),
          React.createElement('select', { value: playMode, onChange: function (e) { playModePair[1](e.target.value); requestSave({ playMode: e.target.value }) } },
            React.createElement('option', { value: 'loop' }, '循环(播完从头轮询,队列不变)'),
            React.createElement('option', { value: 'seq' }, '顺序(播完一首删一首,播完清空)'),
          ),
        ),
        React.createElement('div', { className: 'dsh-music-queue' },
        React.createElement('div', { className: 'dsh-music-qcol' },
          React.createElement('div', { className: 'dsh-music-qhead' },
            manage
              ? React.createElement('input', { type: 'checkbox', checked: lib.length > 0 && lib.every(function (t) { return lSel[t.id] }), onChange: function () { toggleLAll() } })
              : null,
            React.createElement('span', null, '音乐文件夹'),
            React.createElement('span', { className: 'cnt' }, '(' + lib.length + ')'),
            React.createElement('span', { className: 'spacer' }),
          ),
          React.createElement('div', { className: 'dsh-music-qlist' },
            libRows.length ? libRows : React.createElement('div', { className: 'empty' }, '未设置音乐文件夹或文件夹为空'),
          ),
          React.createElement('div', { className: 'dsh-music-qfoot' },
            manage
              ? React.createElement('button', { className: 'mini-btn primary', disabled: busy || lSelCount === 0, onClick: addSelected }, '添加选中 (' + lSelCount + ')')
              : null,
            React.createElement('button', { className: 'mini-btn', disabled: busy, onClick: importAll }, '全部导入'),
          ),
        ),
        React.createElement('div', { className: 'dsh-music-qcol' },
          React.createElement('div', { className: 'dsh-music-qhead' },
            manage
              ? React.createElement('input', { type: 'checkbox', checked: qAllChecked(), onChange: function () { toggleQAll() } })
              : null,
            React.createElement('span', null, '播放队列'),
            React.createElement('span', { className: 'cnt' }, '(' + items.length + ')'),
            React.createElement('span', { className: 'spacer' }),
            React.createElement('button', { className: 'manage-btn' + (manage ? ' active' : ''), onClick: toggleManage }, manage ? '完成' : '管理'),
          ),
          React.createElement('div', { className: 'dsh-music-qlist', onDragOver: onListDragOver, onDrop: onListDrop },
            qRows.length ? qRows : React.createElement('div', { className: 'empty' }, '队列为空,从左侧添加歌曲'),
          ),
          React.createElement('div', { className: 'dsh-music-qnotify' },
            notifySession ? ('播完通知:已绑定到会话 ' + notifySession) : '播完通知:未开启(Agent 可用 music_queue_end_notify 开启)',
          ),
          React.createElement('div', { className: 'dsh-music-qfoot' },
            manage
              ? React.createElement('button', { className: 'mini-btn danger', disabled: busy || selCount === 0, onClick: removeSelected }, '删除选中 (' + selCount + ')')
              : null,
          ),
        ),
        ),
        ctxView,
      )
    }

    // ---- 网易云搜索页 ----
    function SearchPanel() {
      var qPair = React.useState(searchState.q)
      var resultsPair = React.useState(searchState.results)
      var loadingPair = React.useState(false)
      var errPair = React.useState(searchState.err)
      var busyPair = React.useState(0)
      var debounceRef = React.useRef(null)
      var tickPair = React.useState(0)

      var q = qPair[0]
      var results = resultsPair[0]
      var loading = loadingPair[0]
      var err = errPair[0]
      var busyId = busyPair[0]

      React.useEffect(function () {
        return playStateSubscribe(function () {
          tickPair[1](function (t) { return t + 1 })
        })
      }, [])

      React.useEffect(function () {
        return function () {
          if (debounceRef.current) {
            debounceRef.current()
            debounceRef.current = null
          }
        }
      }, [])

      function doSearch() {
        var kw = q.trim()
        if (!kw) return
        if (debounceRef.current) {
          debounceRef.current()
          debounceRef.current = null
        }
        loadingPair[1](true)
        errPair[1]('')
        searchState.err = ''
        rpc('music/search', { q: kw, limit: 30 }).then(function (r) {
          loadingPair[1](false)
          if (r && r.ok) {
            searchState.results = r.items || []
            resultsPair[1](searchState.results)
          } else {
            searchState.err = (r && r.msg) || '搜索失败'
            errPair[1](searchState.err)
          }
        }).catch(function () {
          loadingPair[1](false)
          searchState.err = '搜索失败:网络请求异常'
          errPair[1](searchState.err)
        })
      }
      function onInput(e) {
        var v = e.target.value
        searchState.q = v
        qPair[1](v)
        if (debounceRef.current) {
          debounceRef.current()
          debounceRef.current = null
        }
        if (v.trim()) {
          if (timer) {
            debounceRef.current = timer.timeout(function () {
              debounceRef.current = null
              doSearch()
            }, 500)
          } else {
            doSearch()
          }
        } else {
          searchState.results = null
          searchState.err = ''
          resultsPair[1](null)
          errPair[1]('')
        }
      }
      function onKey(e) {
        if (e.key === 'Enter') doSearch()
      }
      function playSong(s) {
        beginFetchOnline(s)
      }
      // 播放按钮:正在播该曲则暂停,否则播放
      function toggleRow(s) {
        if (nowKey === 'online:' + s.id && nowPlayingFlag) {
          if (playControls) playControls.toggle()
        } else {
          playSong(s)
        }
      }
      // 加入播放队列(按歌曲 ID 索引);若队列镜像尚未加载,先拉取再追加,避免覆盖持久化队列
      function addToQueue(s) {
        var entry = { type: 'online', id: s.id, name: s.name, artists: s.artists, album: s.album, picUrl: s.picUrl }
        function doAdd() {
          var raw = queueItems.map(function (q) {
            return q.kind === 'online'
              ? { type: 'online', id: q.id, name: q.title, artists: q.artists, album: q.album, picUrl: q.picUrl, uuid: q.uuid }
              : { type: 'local', path: q.path, uuid: q.uuid }
          })
          var dup = raw.some(function (it) {
            return it && typeof it === 'object' && it.type === 'online' && Number(it.id) === Number(entry.id)
          })
          if (dup) {
            errPair[1]('已在队列中')
            searchState.err = '已在队列中'
            return
          }
          raw.push(entry)
          rpc('music/queue/set', { items: raw }).then(function (r) {
            if (r && Array.isArray(r.items)) {
              queueItems = r.items
              queueLoaded = true
              queueListeners.forEach(function (fn) { fn(queueItems) })
              listeners.forEach(function (fn) { fn(current) })
            }
            errPair[1]('')
            searchState.err = ''
          }).catch(function () {
            searchState.err = '加入队列失败'
            errPair[1](searchState.err)
          })
        }
        if (!queueLoaded) {
          rpc('music/queue/get').then(function (r) {
            if (r && Array.isArray(r.items)) {
              queueItems = r.items
              queueLoaded = true
              queueListeners.forEach(function (fn) { fn(queueItems) })
            }
            doAdd()
          }).catch(function () {
            doAdd()
          })
        } else {
          doAdd()
        }
      }
      function fmt(ms) {
        if (!ms) return ''
        var s = Math.floor(ms / 1000)
        var m = Math.floor(s / 60)
        s = s % 60
        return m + ':' + (s < 10 ? '0' + s : s)
      }

      var rows = (results || []).map(function (s) {
        var thumb = s.picUrl ? s.picUrl + '?param=80y80' : null
        var rowPlaying = nowKey === 'online:' + s.id && nowPlayingFlag
        return React.createElement('div', {
          key: s.id,
          className: 'dsh-music-sitem' + (rowPlaying ? ' playing' : ''),
          onClick: function () { toggleRow(s) },
          title: '点击播放',
        },
          thumb
            ? React.createElement('img', {
              className: 'thumb',
              src: thumb,
              onError: function (e) { e.currentTarget.style.display = 'none' },
            })
            : React.createElement('span', { className: 'thumb ph' }, '♪'),
          React.createElement('div', { className: 'meta' },
            React.createElement('div', { className: 'name' }, s.name + (s.fee > 0 ? ' 🔒' : '')),
            React.createElement('div', { className: 'sub' }, (s.artists || '未知歌手') + ' · ' + (s.album || '未知专辑')),
          ),
          React.createElement('span', { className: 'dur' }, fmt(s.duration)),
          React.createElement('div', { className: 'acts' },
            React.createElement('button', {
              className: 'sbtn play' + (rowPlaying ? ' active' : ''),
              onClick: function (e) { e.stopPropagation(); toggleRow(s) },
              title: rowPlaying ? '暂停' : '播放',
            }, busyId === s.id ? '…' : (rowPlaying ? '❚❚' : '▶')),
            React.createElement('button', {
              className: 'sbtn add',
              onClick: function (e) { e.stopPropagation(); addToQueue(s) },
              title: '加入队列',
            }, '＋'),
          ),
        )
      })

      return React.createElement('div', { className: 'dsh-music-search' },
        React.createElement('div', { className: 'bar' },
          React.createElement('input', {
            type: 'text',
            value: q,
            onChange: onInput,
            onKeyDown: onKey,
            placeholder: '搜索网易云音乐,回车或自动搜索…',
          }),
          React.createElement('button', { className: 'mini-btn primary', disabled: loading || !q.trim(), onClick: doSearch }, loading ? '搜索中…' : '搜索'),
        ),
        err ? React.createElement('div', { className: 'msg', style: { '--dsh-msg-color': '#ff9d9d' } }, err) : null,
        results === null
          ? React.createElement('div', { className: 'hint' }, '输入歌名/歌手/专辑搜索,点击结果直接在线播放;VIP 歌曲需在 设置 里填写网易云 Cookie')
          : (results.length
            ? React.createElement('div', { className: 'dsh-music-slist' }, rows)
            : React.createElement('div', { className: 'hint' }, '没有找到相关歌曲')),
      )
    }

    // ---- 注册 ----
    slots.inject('shell.overlay', function () {
      return slots.register(
        { name: 'shell.overlay', id: 'dsh-music-float', order: 100 },
        function () { return React.createElement(FloatWindow) },
      )
    })
    slots.inject('settings.section', function () {
      return slots.register(
        { name: 'settings.section', id: 'dsh-music-settings', order: 30, label: '音乐' },
        function () { return React.createElement(MusicSettings) },
      )
    })

    flushCss()
  }
	exports.apply = apply;
	exports.inject = ["slots"];
	return module.exports;
	}
});
