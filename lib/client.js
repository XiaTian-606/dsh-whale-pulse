/** dsh-whale-pulse 浏览器半边：设置页「鱼的耳机」。手写 __ModuleLoader__ bundle，无构建步骤。 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-pulse',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var STORAGE_KEY = 'dsh.whale-pulse.v1'
    var CONFIG_EVENT = 'dsh-whale-pulse-config'
    var DEFAULTS = {
      enabled: true,
      gain: 1.5,
      mode: 'rainbow',
      color: '#5fb0ff',
      glow: 1,
      speed: 1,
      minLevel: 0.24,
      peakLevel: 1,
      shape: 'wave',
      maxLength: 40,
    }

    function loadConfig() {
      var out = {}
      for (var k in DEFAULTS) out[k] = DEFAULTS[k]
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY)
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

    function saveConfig(next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: next }))
      } catch (e) {
        /* 存不上就算了 */
      }
    }

    var CSS = [
      '.wp-set{padding:2px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e9ef);}',
      '.wp-set-card{border:1px solid var(--dsw-alias-border-l3,#3a3f4a);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:13px;}',
      '.wp-set-row{display:flex;align-items:center;justify-content:space-between;gap:14px;}',
      '.wp-set-title{color:var(--dsw-alias-label-primary,#e6e9ef);}',
      '.wp-set-hint{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:11.5px;line-height:1.5;margin-top:2px;}',
      '.wp-set input[type=range]{width:190px;accent-color:rgb(96,176,255);}',
      '.wp-set input[type=checkbox]{width:16px;height:16px;accent-color:rgb(96,176,255);cursor:pointer;}',
      '.wp-set select{background:var(--dsw-alias-bg-layer-2,#232329);color:inherit;border:1px solid var(--dsw-alias-border-l3,#3a3f4a);border-radius:6px;padding:3px 6px;font:inherit;}',
      '.wp-set input[type=color]{width:46px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l3,#3a3f4a);border-radius:6px;background:none;cursor:pointer;}',
      '.wp-set-val{min-width:48px;text-align:right;color:rgb(120,200,255);font-variant-numeric:tabular-nums;}',
      '.wp-set-swatch{display:inline-flex;align-items:center;gap:8px;}',
      '.wp-set-swatch i{width:18px;height:18px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.2);}',
      '.wp-set-note{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary,#8b93a1);}',
      '.wp-set-sep{height:1px;background:var(--dsw-alias-border-l3,#3a3f4a);opacity:.5;}',
      '.wp-set-warn{border:1px solid rgba(255,140,120,.45);background:rgba(255,120,100,.08);color:#ffb4a8;border-radius:10px;padding:10px 13px;font-size:12px;line-height:1.6;}',
      '.wp-set-btn{border:1px solid var(--dsw-alias-border-l3,#3a3f4a);background:var(--dsw-alias-bg-layer-2,#232329);color:inherit;border-radius:6px;padding:3px 9px;font:inherit;font-size:11.5px;cursor:pointer;}',
      '.wp-set-btn:hover{border-color:rgba(96,176,255,.55);color:rgb(120,200,255);}',
    ].join('')

    function Row(props) {
      return h('div', { className: 'wp-set-row' }, props.children)
    }

    function Label(props) {
      return h(
        'div',
        null,
        h('div', { className: 'wp-set-title' }, props.title),
        props.hint ? h('div', { className: 'wp-set-hint' }, props.hint) : null,
      )
    }

    function Section() {
      var initial = useState(loadConfig())
      var cfg = initial[0]
      var setCfg = initial[1]

      var platformState = useState(null)
      var platform = platformState[0]
      var setPlatform = platformState[1]

      var sourceState = useState({ pid: 0, name: '', list: [] })
      var source = sourceState[0]
      var setSource = sourceState[1]

      /** 重新扫描「正在出声的应用」——跟随电脑当前开着的进程，不是一份预制名单。 */
      function refreshProcesses() {
        fetch('/dsh-whale-pulse/processes', { cache: 'no-store' })
          .then(function (res) {
            return res.json()
          })
          .then(function (data) {
            if (data && Array.isArray(data.processes)) {
              setSource(function (prev) {
                return Object.assign({}, prev, { list: data.processes })
              })
            }
          })
          .catch(function () {
            /* 进程列表拉不到就只显示默认设备 */
          })
      }

      useEffect(function () {
        fetch('/dsh-whale-pulse/level', { cache: 'no-store' })
          .then(function (res) {
            return res.json()
          })
          .then(function (data) {
            if (data && typeof data.supported === 'boolean') {
              setPlatform({ supported: data.supported, platform: data.platform || '', error: data.error || '' })
            }
            if (data && typeof data.pid === 'number') {
              setSource(function (prev) {
                return Object.assign({}, prev, { pid: data.pid, name: data.pidName || '' })
              })
            }
          })
          .catch(function () {
            /* 拿不到就不提示 */
          })

        refreshProcesses()
        // 每 10 秒自动刷新一次，打开/关闭应用会自己跟上
        var timer = setInterval(refreshProcesses, 10000)
        return function () {
          clearInterval(timer)
        }
      }, [])

      function update(patch) {
        var next = Object.assign({}, cfg, patch)
        setCfg(next)
        saveConfig(next)
      }

      var swatchColor =
        cfg.mode === 'rainbow'
          ? 'conic-gradient(#ff5f6d,#ffc371,#47e5bc,#4facfe,#a86bff,#ff5f6d)'
          : cfg.color

      var isMac = platform && platform.platform === 'darwin'
      var platformWarn =
        platform && platform.supported === false
          ? h(
              'div',
              { className: 'wp-set-warn' },
              '当前系统（' + (platform.platform || '非 Windows') + '）不支持音频采集——',
              '音频采集器目前只有 Windows 实现。设置会保留，换到 Windows 上会自动生效。',
            )
          : isMac
            ? h(
                'div',
                { className: 'wp-set-warn' },
                'macOS 采集器需要 ffmpeg + BlackHole 才能工作。',
                '在终端执行：brew install ffmpeg blackhole-2ch，',
                '然后在「音频 MIDI 设置」里把输出接到 BlackHole（或建多输出设备）。',
                platform.error ? '当前状态：' + platform.error : '',
              )
            : null

      return h(
        'div',
        { className: 'wp-set' },
        platformWarn,
        h(
          'div',
          { className: 'wp-set-card' },
          h(
            Row,
            null,
            h(Label, {
              title: '启用律动',
              hint: '让聊天区右侧的轮次轨道跟着电脑正在播放的声音起伏',
            }),
            h('input', {
              type: 'checkbox',
              checked: !!cfg.enabled,
              onChange: function (event) {
                update({ enabled: event.target.checked })
              },
            }),
          ),
          h('div', { className: 'wp-set-sep' }),
          h(
            Row,
            null,
            h(Label, {
              title: '音频来源',
              hint:
                platform && platform.platform === 'darwin'
                  ? 'macOS 暂不支持按应用抓取，固定跟随默认输出设备（需要先装好 BlackHole）'
                  : '默认抓整个输出设备；也可以只抓某个应用的声音（process loopback）',
            }),
            platform && platform.platform === 'darwin'
              ? h('span', { className: 'wp-set-note' }, '仅默认输出设备')
              : h(
                  'select',
                  {
                    value: String(source.pid),
                    onChange: function (event) {
                      var pid = Number(event.target.value)
                      var picked = null
                      for (var i = 0; i < source.list.length; i++) {
                        if (source.list[i].pid === pid) {
                          picked = source.list[i]
                          break
                        }
                      }
                      setSource(Object.assign({}, source, { pid: pid, name: picked ? picked.name : '' }))
                      fetch('/dsh-whale-pulse/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pid: pid, name: picked ? picked.name : '' }),
                      }).catch(function () {
                        /* 切换失败就保持原状 */
                      })
                    },
                  },
                  h('option', { value: '0' }, '默认输出设备'),
                  source.list.map(function (item) {
                    return h(
                      'option',
                      { key: String(item.pid), value: String(item.pid) },
                      item.name + (item.active ? '（出声中）' : '') + ' #' + item.pid,
                    )
                  }),
                ),
            platform && platform.platform === 'darwin'
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'wp-set-btn',
                    title: '重新扫描正在出声的应用',
                    onClick: function () {
                      refreshProcesses()
                    },
                  },
                  '刷新',
                ),
          ),
          h(
            Row,
            null,
            h(Label, { title: '浮动幅度', hint: '刻度长短对音量的响应强度' }),
            h('input', {
              type: 'range',
              min: 0,
              max: 4,
              step: 0.1,
              value: cfg.gain,
              onChange: function (event) {
                update({ gain: parseFloat(event.target.value) || 0 })
              },
            }),
            h('span', { className: 'wp-set-val' }, Math.round(cfg.gain * 100) + '%'),
          ),
          h(
            Row,
            null,
            h(Label, { title: '低谷幅度', hint: '静音/暂停时刻度保留的长度' }),
            h('input', {
              type: 'range',
              min: 0,
              max: 0.6,
              step: 0.01,
              value: cfg.minLevel,
              onChange: function (event) {
                update({ minLevel: parseFloat(event.target.value) || 0 })
              },
            }),
            h('span', { className: 'wp-set-val' }, Math.round(cfg.minLevel * 100) + '%'),
          ),
          h(
            Row,
            null,
            h(Label, { title: '高峰幅度', hint: '最响时刻度能到的最大长度' }),
            h('input', {
              type: 'range',
              min: 0.35,
              max: 1,
              step: 0.01,
              value: cfg.peakLevel,
              onChange: function (event) {
                update({ peakLevel: parseFloat(event.target.value) || 1 })
              },
            }),
            h('span', { className: 'wp-set-val' }, Math.round(cfg.peakLevel * 100) + '%'),
          ),
          h(
            Row,
            null,
            h(Label, { title: '形状', hint: '海浪 = 随时间流动；中间高两边低 = 钟形包络' }),
            h(
              'select',
              {
                value: cfg.shape,
                onChange: function (event) {
                  update({ shape: event.target.value })
                },
              },
              h('option', { value: 'wave' }, '海浪'),
              h('option', { value: 'bell' }, '中间高两边低'),
            ),
          ),
          h(
            Row,
            null,
            h(Label, { title: '最长长度', hint: '刻度向右最多延伸多少像素，没有硬上限' }),
            h('input', {
              type: 'range',
              min: 12,
              max: 300,
              step: 4,
              value: cfg.maxLength,
              onChange: function (event) {
                update({ maxLength: parseInt(event.target.value, 10) || 40 })
              },
            }),
            h('span', { className: 'wp-set-val' }, cfg.maxLength + 'px'),
          ),
          h(
            Row,
            null,
            h(Label, { title: '流速', hint: '波形沿轨道滚动的速度' }),
            h('input', {
              type: 'range',
              min: 0.3,
              max: 3,
              step: 0.1,
              value: cfg.speed,
              onChange: function (event) {
                update({ speed: parseFloat(event.target.value) || 1 })
              },
            }),
            h('span', { className: 'wp-set-val' }, cfg.speed.toFixed(1) + 'x'),
          ),
          h('div', { className: 'wp-set-sep' }),
          h(
            Row,
            null,
            h(Label, { title: '颜色模式', hint: '彩虹流光 / 单色' }),
            h(
              'select',
              {
                value: cfg.mode,
                onChange: function (event) {
                  update({ mode: event.target.value })
                },
              },
              h('option', { value: 'rainbow' }, '彩虹流光'),
              h('option', { value: 'single' }, '单色'),
            ),
          ),
          h(
            Row,
            null,
            h(Label, {
              title: '主色',
              hint: cfg.mode === 'single' ? '单色模式：直接用你选的颜色' : '彩虹模式会从这个颜色开始铺开',
            }),
            h('input', {
              type: 'color',
              className: 'wp-set-color',
              value: cfg.color,
              onChange: function (event) {
                update({ color: event.target.value })
              },
            }),
            h('span', { className: 'wp-set-swatch' }, h('i', { style: { background: swatchColor } })),
          ),
          h(
            Row,
            null,
            h(Label, { title: '外圈泛光', hint: '刻度外面那层包围光晕的强度' }),
            h('input', {
              type: 'range',
              min: 0,
              max: 2,
              step: 0.1,
              value: cfg.glow,
              onChange: function (event) {
                update({ glow: parseFloat(event.target.value) || 0 })
              },
            }),
            h('span', { className: 'wp-set-val' }, Math.round(cfg.glow * 100) + '%'),
          ),
        ),
        h(
          'div',
          { className: 'wp-set-note' },
          '音频由宿主侧 WASAPI loopback 采集（默认输出设备），只取音量与频谱，不录音、不上传。',
          '如果轨道没反应，先在屏幕右下角放点声音试试；声音源要先经过默认播放设备。',
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-whale-pulse-set-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-whale-pulse: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'whale-pulse',
            order: 47,
            label: function () {
              return '鱼的耳机'
            },
          },
          function () {
            return h(Section)
          },
        )
      })
    }

    module.exports = {
      name: 'whale-pulse',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
