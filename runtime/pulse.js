/* dsh-whale-pulse 页面运行时：定位轮次轨道，轮询宿主电平并写成 CSS 变量。 */
;(function (global) {
  'use strict'

  if (global === null || typeof global !== 'object') return
  var doc = global.document
  if (!doc || typeof doc.createElement !== 'function') return
  if (global.__DSH_WHALE_PULSE__ && global.__DSH_WHALE_PULSE__.started) return

  var VERSION = '1.8.5'
  var STORAGE_KEY = 'dsh.whale-pulse.v1'
  var CONFIG_EVENT = 'dsh-whale-pulse-config'
  var LEVEL_URL = '/dsh-whale-pulse/level'
  var REPORT_URL = '/dsh-whale-pulse/report'
  var POLL_MS = 90
  var COLLECT_DEBOUNCE_MS = 500

  var DEFAULTS = {
    enabled: true,
    gain: 1.5,
    mode: 'rainbow',
    color: '#5fb0ff',
    glow: 1,
    speed: 1,
    /** 低谷：静音/暂停时保留的刻度长度（0~1）。 */
    minLevel: 0.24,
    /** 高峰：最响时刻度的最大长度（0~1）。 */
    peakLevel: 1,
    /** 形状：wave = 海浪（时间流动）；bell = 中间高两边低（钟形包络）。 */
    shape: 'wave',
    /** 刻度最长能画多少像素——决定右侧延伸多远，没有硬上限。 */
    maxLength: 40,
  }

  var api = {
    version: VERSION,
    started: true,
    state: {
      enabled: false,
      phase: 'idle',
      detail: '',
      marks: 0,
    },
  }
  global.__DSH_WHALE_PULSE__ = api


  function loadConfig() {
    var out = {}
    for (var k in DEFAULTS) out[k] = DEFAULTS[k]
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY)
      if (raw) {
        var parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          for (var key in DEFAULTS) {
            if (typeof parsed[key] === typeof DEFAULTS[key]) out[key] = parsed[key]
          }
        }
      }
    } catch (e) {
      /* 坏配置就用默认 */
    }
    return out
  }

  var config = loadConfig()

  /** 从 #rrggbb 里取色相；单色模式直接用原色，彩虹模式从它的色相开始铺。 */
  function hexToHue(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!match) return 210
    var n = parseInt(match[1], 16)
    var r = ((n >> 16) & 255) / 255
    var g = ((n >> 8) & 255) / 255
    var b = (n & 255) / 255
    var max = Math.max(r, g, b)
    var min = Math.min(r, g, b)
    var d = max - min
    if (d === 0) return 210
    var hue
    if (max === r) hue = ((g - b) / d) % 6
    else if (max === g) hue = (b - r) / d + 2
    else hue = (r - g) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
    return Math.round(hue)
  }

  /** 把「最长长度 / 低谷」换算成 CSS 变量和容器宽度，配置一变立刻应用。 */
  function applyLengths() {
    if (!railFrame) return
    var low = clamp(typeof config.minLevel === 'number' ? config.minLevel : IDLE_WAVE, 0, 1)
    var maxLen = typeof config.maxLength === 'number' ? Math.max(12, config.maxLength) : 40
    var scaleMax = maxLen / 20
    try {
      railFrame.style.setProperty('--wp-scale-min', (scaleMax * low).toFixed(3))
      railFrame.style.setProperty('--wp-scale-range', (scaleMax * (1 - low)).toFixed(3))
      // 容器跟着最长长度走，彻底取消旧宽度限制
      railFrame.style.width = Math.ceil(maxLen + 20) + 'px'
    } catch (e) {
      /* 忽略 */
    }
  }

  function applyConfig() {
    try {
      var root = doc.documentElement
      root.style.setProperty('--wp-color', config.color)
      root.style.setProperty('--wp-hue-base', String(hexToHue(config.color)))
      root.style.setProperty('--wp-glow', String(config.glow))
      root.style.setProperty('--wp-speed', String(config.speed))
      root.setAttribute('data-wp-mode', config.mode)
    } catch (e) {
      /* 忽略 */
    }
    applyLengths()
    if (config.enabled) startPolling()
    else stopPolling()
  }


  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n
  }

  /** 往宿主上报状态，宿主写进 whale-pulse-host.log。 */
  function report(kind, data) {
    try {
      if (typeof global.fetch !== 'function') return
      global
        .fetch(REPORT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ v: VERSION, kind: kind, data: data || null, at: Date.now() }),
          keepalive: true,
        })
        .catch(function () {
          /* 上报失败不影响功能 */
        })
    } catch (e) {
      /* 忽略 */
    }
  }


  var pollTimer = 0
  var pollBusy = false
  var rafId = 0
  var targetLevel = 0
  var currentLevel = 0
  var targetBands = []
  var smoothBands = []
  var bandOffset = 0
  /** 静音门限：实测底噪 0.0005~0.0009，贴着它走。 */
  var NOISE_FLOOR = 0.0007
  /** 最近一次听到声音的时间。 */
  var lastLoudAt = 0
  /** 这么久没声音才算暂停。 */
  var PLAYING_HOLD_MS = 60000
  /** 静音/暂停时保留的底波浪。 */
  var IDLE_WAVE = 0.24

  function normalize(rms) {
    var scaled = clamp(rms * 30, 0, 1)
    return clamp(Math.pow(scaled, 0.8) * config.gain, 0, 1)
  }

  function poll() {
    if (pollBusy) return
    pollBusy = true
    global
      .fetch(LEVEL_URL, { cache: 'no-store' })
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        pollBusy = false
        if (!api.state.enabled) return
        if (data && data.error) {
          api.state.phase = 'error'
          api.state.detail = String(data.error)
          return
        }
        if (data && data.ready) {
          var raw = data.rms || 0
          if (raw >= NOISE_FLOOR) lastLoudAt = Date.now()
          var playing = Date.now() - lastLoudAt < PLAYING_HOLD_MS
          if (raw < NOISE_FLOOR) {
            // 播放中偶尔的瞬间静音（换气、空拍）保持一个基础值，
            // 不要让电平直接掉到 0；真停了才归零。
            targetLevel = playing ? 0.16 : 0
          } else {
            targetLevel = normalize(raw)
          }
          targetBands = Array.isArray(data.bands) ? data.bands : []
          if (api.state.phase !== 'live') api.state.phase = 'live'
        }
      })
      .catch(function () {
        pollBusy = false
      })
  }

  /** 每帧向目标值插值，上冲快、回落慢。 */
  function tick() {
    rafId = global.requestAnimationFrame(tick)
    if (!api.state.enabled) return

    var rising = targetLevel > currentLevel
    // 上冲快、回落更慢：像音乐软件那样，鼓点之间不会整条掉下去
    currentLevel += (targetLevel - currentLevel) * (rising ? 0.32 : 0.032)
    if (currentLevel < 0.01) currentLevel = Math.max(0, currentLevel - 0.002)

    if (smoothBands.length !== targetBands.length) {
      smoothBands = targetBands.slice()
    } else {
      for (var s = 0; s < targetBands.length; s++) {
        var up = targetBands[s] > smoothBands[s]
        smoothBands[s] += (targetBands[s] - smoothBands[s]) * (up ? 0.32 : 0.06)
      }
    }

    applyLevel(currentLevel)
  }

  function applyLevel(v) {
    var marks = marksCache
    var n = marks.length

    // 「在播放」看的是最近一段时间有没有声音，而不是此刻有没有：
    // 这样间奏、换气、鼓点空拍时轨道不会掉下去。
    var playingNow = Date.now() - lastLoudAt < PLAYING_HOLD_MS
    var now = Date.now() / 1000
    var bassValue = playingNow ? 0.12 + v * 0.55 : IDLE_WAVE
    var bassText = bassValue.toFixed(3)
    try {
      if (railFrame) railFrame.style.setProperty('--wp-bass', bassText)
    } catch (e) {
      /* 忽略 */
    }
    if (!n) return

    var nb = smoothBands.length
    if (nb > 0) bandOffset = (bandOffset + 0.035 * config.speed) % nb

    // 低谷 / 高峰都由设置页给：静音时不低于低谷，最响时不超过高峰
    var low = clamp(typeof config.minLevel === 'number' ? config.minLevel : IDLE_WAVE, 0, 1)
    var high = clamp(typeof config.peakLevel === 'number' ? config.peakLevel : 1, low + 0.01, 1)

    // 相对归一：找出这一帧里最强的频段，把它当 1，其余按比例。
    // 这样大浪时也是「低频高、高频低」的层次，不会所有刻度一起顶到底。
    var maxBand = 0
    for (var mx = 0; mx < nb; mx++) {
      if (smoothBands[mx] > maxBand) maxBand = smoothBands[mx]
    }
    var norm = maxBand > 0.02 ? 1 / maxBand : 0

    // 形状：海浪（随时间流动）或山峰（静止的钟形，中间高两边低）
    var wantBell = config.shape === 'bell'

    for (var i = 0; i < n; i++) {
      var value
      if (nb > 0) {
        // 山峰模式固定映射（不流动），海浪模式才让频段沿轨道滑动
        var bi = wantBell
          ? Math.min(nb - 1, Math.floor(i * nb / n))
          : Math.floor((((i + bandOffset) % nb) + nb) % nb)
        // 相对值：本段在「本帧最大频段」里的占比（0~1）
        var rel = norm > 0 ? clamp(smoothBands[bi] * norm, 0, 1) : 0
        // 播放中给一层底波浪；暂停后也保留一层，避免缩回原生小横线
        var baseline = playingNow
          ? 0.08 + 0.08 * (0.5 + 0.5 * Math.sin(i * 0.9 - now * 2.2))
          : low * (0.85 + 0.3 * (0.5 + 0.5 * Math.sin(i * 0.6 - now * 1.2)))
        if (wantBell) {
          // 山峰：静态山脊（中间高、两端低），波动按坡度缩放——
          // 中间波动大，两侧几乎没有波动，而且形状不会流动。
          var pos = (i + 0.5) / n
          var bell = Math.sin(Math.PI * pos)
          var ridge = 0.25 + 0.75 * bell
          var waveAmt = rel * bell * (0.3 + 0.7 * v)
          var shapeValue = clamp(ridge * 0.7 + waveAmt * 0.5, 0, 1)
          value = clamp(low + shapeValue * (high - low), 0, 1)
        } else {
          // 相对频谱 + 总能量共同决定高度：大浪时层次保留，小浪时也推得起来
          var energy = rel * (0.25 + 0.75 * v)
          var raw = baseline * 0.5 + energy * config.gain
          var shapeValue = 1 - Math.exp(-raw * 1.7)
          // 映射到 [低谷, 高峰]
          value = clamp(low + shapeValue * (high - low), 0, 1)
        }
      } else {
        var weight = 0.55 + (0.45 * (i + 1)) / n
        value = clamp(v * weight, 0, 1)
      }
      var el = marks[i]
      if (el) el.style.setProperty('--wp-v', value.toFixed(3))
    }
  }

  function startPolling() {
    if (pollTimer) return
    api.state.enabled = true
    try {
      doc.documentElement.setAttribute('data-wp-pulse', 'on')
    } catch (e) {
      /* 忽略 */
    }
    collectRail()
    pollTimer = global.setInterval(poll, POLL_MS)
    poll()
    rafId = global.requestAnimationFrame(tick)
    report('poll-start', { marks: marksCache.length })
  }

  function stopPolling() {
    if (pollTimer) {
      global.clearInterval(pollTimer)
      pollTimer = 0
    }
    if (rafId) {
      global.cancelAnimationFrame(rafId)
      rafId = 0
    }
    api.state.enabled = false
    targetLevel = 0
    currentLevel = 0
    targetBands = []
    smoothBands = []
    try {
      if (doc.documentElement) doc.documentElement.removeAttribute('data-wp-pulse')
      if (railFrame) railFrame.style.removeProperty('--wp-bass')
    } catch (e) {
      /* 忽略 */
    }
    clearMarks()
  }


  var marksCache = []
  var railFrame = null
  var collectTimer = 0

  function clearMarks() {
    for (var i = 0; i < marksCache.length; i++) {
      var el = marksCache[i]
      try {
        el.classList.remove('wp-mark')
        el.style.removeProperty('--wp-v')
        el.style.removeProperty('--wp-i')
      } catch (e) {
        /* 忽略 */
      }
    }
    marksCache = []
    if (railFrame) {
      try {
        railFrame.classList.remove('wp-rail')
      } catch (e) {
        /* 忽略 */
      }
      railFrame = null
    }
    api.state.marks = 0
  }

  function collectRail() {
    if (!doc.body) return
    if (!api.state.enabled) {
      clearMarks()
      return
    }
    var vw = global.innerWidth || doc.documentElement.clientWidth || 0
    var nodes = doc.querySelectorAll('button[data-index][type="button"]')
    var found = []
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var rect
      try {
        rect = el.getBoundingClientRect()
      } catch (e) {
        continue
      }
      if (rect.width > 0 && rect.width <= 34 && rect.height >= 6 && rect.right >= vw - 64) {
        found.push({ el: el, top: rect.top })
      }
    }
    found.sort(function (x, y) {
      return x.top - y.top
    })

    var next = []
    for (var m = 0; m < found.length; m++) next.push(found[m].el)
    // 只清理已经离开 DOM 的刻度，避免虚拟滚动瞬间误删 class 导致样式闪回原生。
    for (var old = 0; old < marksCache.length; old++) {
      var prevEl = marksCache[old]
      if (next.indexOf(prevEl) < 0) {
        var stillInDoc = false
        try {
          stillInDoc = doc.documentElement.contains(prevEl)
        } catch (e) {
          stillInDoc = false
        }
        if (!stillInDoc) {
          try {
            prevEl.classList.remove('wp-mark')
            prevEl.style.removeProperty('--wp-v')
            prevEl.style.removeProperty('--wp-i')
          } catch (e) {
            /* 忽略 */
          }
        }
      }
    }
    for (var n2 = 0; n2 < next.length; n2++) {
      if (next[n2].classList) {
        next[n2].classList.add('wp-mark')
        next[n2].style.setProperty('--wp-i', String(n2))
      }
    }
    // 即使这一轮没扫到（轨道暂时不可见），也保留上一轮的引用，
    // 这样 class 与 --wp-i 不会丢，恢复可见时立刻生效。
    if (next.length > 0) {
      marksCache = next
      api.state.marks = next.length
    }

    var frame = null
    if (next.length) {
      var p = next[0].parentElement
      var depth = 0
      while (p && p !== doc.body && depth < 6) {
        var cls = typeof p.className === 'string' ? p.className : ''
        if (/(^|\s)[^\s]*frame[^\s]*(\s|$)/i.test(cls)) {
          frame = p
          break
        }
        p = p.parentElement
        depth++
      }
    }
    if (railFrame && railFrame !== frame) {
      try {
        railFrame.classList.remove('wp-rail')
      } catch (e) {
        /* 忽略 */
      }
    }
    railFrame = frame
    if (railFrame) {
      railFrame.classList.add('wp-rail')
      var scroller = railFrame.querySelector('div')
      if (scroller) scroller.classList.add('wp-scroller')
      // 新找到的 frame 要立刻应用当前长度设置，不然要等下一轮配置变更
      applyLengths()
    }
  }

  function scheduleCollect() {
    if (collectTimer) return
    collectTimer = global.setTimeout(function () {
      collectTimer = 0
      collectRail()
    }, COLLECT_DEBOUNCE_MS)
  }

  function watchDom() {
    if (!doc.body) return
    try {
      var mo = new global.MutationObserver(function () {
        if (api.state.enabled) scheduleCollect()
      })
      mo.observe(doc.body, { childList: true, subtree: true })
    } catch (e) {
      /* 忽略 */
    }
    global.addEventListener('resize', scheduleCollect)
    global.setInterval(function () {
      if (api.state.enabled) collectRail()
    }, 1800)
  }


  function boot() {
    try {
      console.info('[whale-pulse] runtime v' + VERSION)
      watchDom()
      applyConfig()
      global.__whalePulseDiag = function () {
        return {
          version: VERSION,
          phase: api.state.phase,
          enabled: api.state.enabled,
          marks: marksCache.length,
          config: config,
        }
      }
      global.addEventListener(CONFIG_EVENT, function (event) {
        var detail = event && event.detail
        if (detail && typeof detail === 'object') {
          for (var key in DEFAULTS) {
            if (typeof detail[key] === typeof DEFAULTS[key]) config[key] = detail[key]
          }
        } else {
          config = loadConfig()
        }
        applyConfig()
        report('config-change', {
          shape: config.shape,
          maxLength: config.maxLength,
          minLevel: config.minLevel,
          peakLevel: config.peakLevel,
        })
      })
      report('boot', { marks: marksCache.length })
    } catch (error) {
      try {
        console.error('[whale-pulse] boot failed', error)
      } catch (e) {
        /* 忽略 */
      }
      report('boot-error', { message: String((error && error.message) || error) })
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})(typeof window !== 'undefined' ? window : this)
