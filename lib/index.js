/** dsh-whale-pulse 宿主半边：启动音频采集器、注入页面脚本、提供电平与诊断路由。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Cordis 诊断用的插件名。 */
export const name = 'whale-pulse'

/** 没有必需服务：只用事件席位，apply 必须立刻跑。 */
export const inject = []

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '1.8.5'

/** 页面轮询电平的路由。 */
export const LEVEL_ROUTE = '/dsh-whale-pulse/level'
/** 页面诊断上报的路由。 */
export const REPORT_ROUTE = '/dsh-whale-pulse/report'
/** 列出正在出声的应用。 */
export const PROCESSES_ROUTE = '/dsh-whale-pulse/processes'
/** 切换音源（默认设备 / 指定进程）。 */
export const CONFIG_ROUTE = '/dsh-whale-pulse/config'

/** 最近一次采集到的电平。 */
const level = { ready: false, peak: 0, rms: 0, bands: [], error: null, updatedAt: 0 }

let probeProcess = null
let probeBuffer = ''
let restartTimer = null
/** 宿主正在关闭：不再拉起新的探针，也不再自动重启。 */
let stopping = false
/** 临时子进程（sessions.ps1 等），关闭时要一起收掉。 */
const tempChildren = new Set()
/** 0 = 抓默认输出设备；>0 = 只抓这个进程（process loopback）。 */
let currentPid = 0
let currentPidName = ''

const CONFIG_FILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'whale-pulse-config.json')

function loadPidConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.pid === 'number' && parsed.pid >= 0) currentPid = parsed.pid
    if (parsed && typeof parsed.name === 'string') currentPidName = parsed.name
  } catch {
    /* 没有配置就用默认设备 */
  }
}

function savePidConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ pid: currentPid, name: currentPidName }, null, 2))
  } catch {
    /* 存不上不影响当前会话 */
  }
}

/** 诊断日志：绝不影响主流程；超过 1MB 自动截断，避免无限增长。 */
function trace(line) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const file = path.join(home, 'whale-pulse-host.log')
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.writeFileSync(file, '')
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 写不进去就算了 */
  }
}

/** 把 DLL 复制到临时目录；已经复制过且大小一致就跳过，避免旧探针占用导致失败。 */
function ensureLib() {
  const dir = path.join(os.tmpdir(), 'whale-pulse-lib')
  fs.mkdirSync(dir, { recursive: true })
  const copyIfNeeded = (srcUrl, name) => {
    const src = fileURLToPath(srcUrl)
    const dst = path.join(dir, name)
    try {
      if (fs.statSync(dst).size === fs.statSync(src).size) return
    } catch {
      /* 目标不存在 */
    }
    fs.copyFileSync(src, dst)
  }
  copyIfNeeded(new URL('../runtime/NAudio.dll', import.meta.url), 'NAudio.dll')
  copyIfNeeded(new URL('../runtime/ApplicationLoopback.dll', import.meta.url), 'ApplicationLoopback.dll')
  return dir
}

/** 采集器：Windows 用 PowerShell + NAudio；macOS 用 ffmpeg + BlackHole；其它平台优雅降级。 */
const PLATFORM = process.platform
const PLATFORM_SUPPORTED = PLATFORM === 'win32' || PLATFORM === 'darwin'

let macProbe = null
let macTimer = null
let macBuffer = []
let macReady = false

/** 找 BlackHole 的 avfoundation 音频设备索引。 */
function findBlackHoleIndex() {
  return new Promise((resolve, reject) => {
    const list = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    list.stderr.on('data', (chunk) => {
      text += String(chunk)
    })
    list.on('error', () => reject(new Error('找不到 ffmpeg，先执行：brew install ffmpeg')))
    list.on('exit', () => {
      if (/AVFoundation audio devices/i.test(text) === false) {
        reject(new Error('ffmpeg 没有列出音频设备，请确认 macOS 版本与 ffmpeg 安装正常'))
        return
      }
      const audioPart = text.split(/AVFoundation audio devices/i).pop() || ''
      let index = null
      const lineRe = /\[(\d+)\]\s+(.+)$/gm
      let match
      while ((match = lineRe.exec(audioPart)) !== null) {
        const name = match[2].trim()
        if (/blackhole/i.test(name)) {
          index = match[1]
          trace('mac: found BlackHole device ' + name + ' index=' + index)
          break
        }
      }
      if (index === null) {
        reject(
          new Error(
            '没有找到 BlackHole 虚拟声卡，先安装它：brew install blackhole-2ch，然后在「音频 MIDI 设置」里把输出接到 BlackHole（或建多输出设备）',
          ),
        )
        return
      }
      resolve(index)
    })
  })
}

function startMacFfmpeg(deviceIndex) {
  if (macProbe) return
  macProbe = spawn(
    'ffmpeg',
    ['-f', 'avfoundation', '-i', ':' + deviceIndex, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  macBuffer = []
  macReady = false
  trace('mac: ffmpeg capture started pid=' + macProbe.pid)

  macProbe.stdout.on('data', (chunk) => {
    const count = Math.floor(chunk.length / 4)
    for (let i = 0; i < count; i++) {
      macBuffer.push(chunk.readFloatLE(i * 4))
    }
    // 只留最近约 0.5 秒，防止内存膨胀
    if (macBuffer.length > 8000) macBuffer = macBuffer.slice(-8000)
  })

  macProbe.stderr.on('data', (chunk) => {
    trace('mac ffmpeg stderr: ' + String(chunk).slice(0, 300))
  })

  macProbe.on('exit', (code) => {
    trace('mac ffmpeg exit code=' + code)
    macProbe = null
    macReady = false
    level.ready = false
    if (restartTimer) clearTimeout(restartTimer)
    // 采集器挂了就退回去重新找设备，别把错误静默吞掉
    restartTimer = setTimeout(() => {
      if (stopping) return
      if (PLATFORM === 'darwin') {
        level.error = 'macOS 采集器已退出（code ' + code + '），3 秒后重试'
        startProbe()
      }
    }, 3000)
  })

  if (macTimer) clearInterval(macTimer)
  macTimer = setInterval(() => {
    if (!macBuffer.length) return
    let sum = 0
    let peak = 0
    for (let i = 0; i < macBuffer.length; i++) {
      const v = Math.abs(macBuffer[i])
      if (v > peak) peak = v
      sum += v * v
    }
    const rms = Math.sqrt(sum / macBuffer.length)
    macBuffer = []
    level.peak = peak
    level.rms = rms
    // 暂不打频谱：macOS 版先给总能量，前端会自动回退成整体律动
    level.bands = []
    level.updatedAt = Date.now()
    if (!macReady) {
      macReady = true
      level.ready = true
      level.error = null
      trace('mac: level ready')
    }
  }, 50)
}

/** 编译（或复用）macOS 原生采集器：返回可执行文件路径，失败返回 null。 */
function ensureMacCapture() {
  return new Promise((resolve) => {
    let src
    try {
      src = fileURLToPath(new URL('../runtime/capture-macos.swift', import.meta.url))
    } catch {
      resolve(null)
      return
    }
    if (!fs.existsSync(src)) {
      resolve(null)
      return
    }
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'whale-pulse-bin')
    const bin = path.join(dir, 'capture-macos')

    try {
      const srcMtime = fs.statSync(src).mtimeMs
      if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= srcMtime) {
        resolve(bin)
        return
      }
    } catch {
      /* 继续编译 */
    }

    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 目录建不了就放弃原生 */
    }
    trace('mac: compiling native capture with swiftc')
    const child = spawn('swiftc', ['-O', '-parse-as-library', src, '-o', bin], { stdio: ['ignore', 'pipe', 'pipe'] })
    let errText = ''
    child.stderr.on('data', (chunk) => {
      if (errText.length < 4000) errText += String(chunk)
    })
    child.on('error', () => {
      level.error = '找不到 swiftc，先执行：xcode-select --install'
      trace('mac: swiftc missing')
      resolve(null)
    })
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(bin)) {
        trace('mac: swiftc ok -> ' + bin)
        resolve(bin)
        return
      }
      level.error = 'swiftc 编译失败：' + errText.slice(0, 300)
      trace('mac: swiftc failed ' + errText.slice(0, 300))
      resolve(null)
    })
  })
}

/** 跑原生采集器：它自己按 50ms 输出 JSON 行。 */
function startMacNative(bin) {
  if (macProbe) return
  try {
    macProbe = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    level.error = '原生采集器启动失败：' + String(error && error.message ? error.message : error)
    trace(level.error)
    return
  }
  let jsonBuf = ''
  trace('mac: native capture started pid=' + macProbe.pid)

  macProbe.stdout.setEncoding('utf8')
  macProbe.stdout.on('data', (chunk) => {
    jsonBuf += chunk
    let idx
    while ((idx = jsonBuf.indexOf('\n')) >= 0) {
      const line = jsonBuf.slice(0, idx).trim()
      jsonBuf = jsonBuf.slice(idx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.error) {
          level.error = String(parsed.error) + (parsed.message ? ': ' + parsed.message : '')
          trace('mac native error: ' + line)
        } else if (parsed.ready) {
          macReady = true
          level.ready = true
          level.error = null
          trace('mac: native ready')
        } else if (typeof parsed.rms === 'number') {
          level.peak = parsed.peak || 0
          level.rms = parsed.rms || 0
          level.bands = []
          level.updatedAt = Date.now()
        }
      } catch {
        /* 坏行忽略 */
      }
    }
  })

  macProbe.stderr.on('data', (chunk) => {
    trace('mac native stderr: ' + String(chunk).slice(0, 300))
  })

  macProbe.on('exit', (code) => {
    trace('mac native exit code=' + code)
    macProbe = null
    macReady = false
    level.ready = false
    if (stopping) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (!stopping && PLATFORM === 'darwin') startProbe()
    }, 3000)
  })
}

function startMacProbe() {
  if (macProbe) return
  trace('mac: try native capture first')
  ensureMacCapture()
    .then((bin) => {
      if (stopping) return
      if (bin) {
        startMacNative(bin)
        return
      }
      // 原生不可用时回退到 ffmpeg + BlackHole
      trace('mac: fallback to ffmpeg + BlackHole')
      findBlackHoleIndex()
        .then((index) => startMacFfmpeg(index))
        .catch((error) => {
          level.ready = false
          level.error = error && error.message ? error.message : String(error)
          trace('mac probe failed: ' + level.error)
        })
    })
    .catch((error) => {
      level.ready = false
      level.error = String(error && error.message ? error.message : error)
      trace('mac probe failed: ' + level.error)
    })
}

function stopMacProbe() {
  if (macTimer) {
    clearInterval(macTimer)
    macTimer = null
  }
  macBuffer = []
  macReady = false
  if (macProbe) {
    try {
      macProbe.kill()
    } catch {
      /* 忽略 */
    }
    macProbe = null
  }
}

function startProbe() {
  if (stopping) return
  if (probeProcess || macProbe) return
  if (!PLATFORM_SUPPORTED) {
    level.ready = false
    level.error = '当前系统暂不支持音律采集器（仅 Windows / macOS 已实现）'
    trace('probe skipped: unsupported platform ' + PLATFORM)
    return
  }
  if (PLATFORM === 'darwin') {
    startMacProbe()
    return
  }
  try {
    ensureLib()
  } catch (error) {
    level.error = 'lib: ' + String(error && error.message ? error.message : error)
    trace(level.error)
    return
  }
  const script = fileURLToPath(new URL('../runtime/probe.ps1', import.meta.url))
  try {
    probeProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(currentPid)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    level.error = 'spawn: ' + String(error && error.message ? error.message : error)
    trace(level.error)
    return
  }
  probeBuffer = ''
  trace('probe spawned pid=' + probeProcess.pid)

  probeProcess.stdout.setEncoding('utf8')
  probeProcess.stdout.on('data', (chunk) => {
    probeBuffer += chunk
    let idx
    while ((idx = probeBuffer.indexOf('\n')) >= 0) {
      const line = probeBuffer.slice(0, idx).trim()
      probeBuffer = probeBuffer.slice(idx + 1)
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.error) {
          level.error = String(parsed.error) + (parsed.message ? ': ' + parsed.message : '')
          trace('probe error: ' + line)
        } else if (parsed.ready) {
          level.ready = true
          level.error = null
          trace('probe ready')
        } else if (typeof parsed.rms === 'number') {
          level.peak = parsed.peak || 0
          level.rms = parsed.rms || 0
          level.bands = Array.isArray(parsed.bands) ? parsed.bands : []
          level.updatedAt = Date.now()
        }
      } catch {
        /* 坏行忽略 */
      }
    }
  })

  probeProcess.stderr.on('data', (chunk) => {
    trace('probe stderr: ' + String(chunk).slice(0, 300))
  })

  probeProcess.on('exit', (code) => {
    trace('probe exit code=' + code)
    probeProcess = null
    level.ready = false
    // 宿主正在关闭时不要再拉起新的探针
    if (stopping) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(startProbe, 3000)
  })
}

/**
 * 收掉采集器。
 * @param {boolean} final 是否真的关闭（true 后不再自动重启；切换音源时传 false）
 */
function stopProbe(final = false) {
  if (final) stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (probeProcess) {
    try {
      // SIGKILL 在 Windows 上走 TerminateProcess，确保 PowerShell 立刻退出
      probeProcess.kill('SIGKILL')
    } catch {
      /* 已经退出了就忽略 */
    }
    probeProcess = null
  }
  for (const child of tempChildren) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
  tempChildren.clear()
  stopMacProbe()
}

/** 读本包内的运行时文件；只允许包目录内的相对路径。 */
function readRuntime(relPath) {
  const url = new URL(`../runtime/${relPath}`, import.meta.url)
  return fs.readFileSync(url, 'utf8')
}

function json(res, status, payload) {
  try {
    // 页面已经断开时再写会抛异常，不能让它冒到宿主
    if (res.writableEnded || res.destroyed) return
    const text = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch {
    /* 客户端已断开 */
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  trace(`apply() v${VERSION} called`)
  stopping = false
  loadPidConfig()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志都不该成为失败原因 */
    }
    trace(`warn: ${message}`)
  }

  // 用 effect 注册清理：插件卸载/宿主退出时一定会执行，把常驻子进程收掉，
  // 否则 probe 的 stdio 管道会让宿主的事件循环一直不空，关闭时卡到超时。
  ctx.effect(() => {
    startProbe()
    return () => {
      trace('effect dispose: stopping probe')
      stopProbe(true)
    }
  })

  // 宿主只在启动时收集一次注入表，必须同步注册
  ctx.on('webserver/index-inject', (table) => {
    trace(`index-inject fired: table=${Array.isArray(table) ? 'array(' + table.length + ')' : typeof table}`)
    if (!Array.isArray(table)) return
    try {
      const css = readRuntime('pulse.css')
      const js = readRuntime('pulse.js')
      trace(`runtime read: css=${css.length}B js=${js.length}B`)
      table.push({ kind: 'style', text: css }, { kind: 'script', placement: 'body', text: js })
      trace(`pushed; table now ${table.length}`)
    } catch (error) {
      warn(`注入行生成失败，页面将回落到原生外观：${String(error && error.message ? error.message : error)}`)
    }
  })

  // 路由：电平查询、诊断上报、应用列表、音源切换
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposeLevel = child.webServer.register({
        kind: 'exact',
        path: LEVEL_ROUTE,
        handler: (req, res) => {
          json(res, 200, {
            ready: level.ready,
            peak: level.peak,
            rms: level.rms,
            bands: level.bands,
            error: level.error,
            supported: PLATFORM_SUPPORTED,
            platform: PLATFORM,
            pid: currentPid,
            pidName: currentPidName,
            age: level.updatedAt ? Date.now() - level.updatedAt : -1,
            version: VERSION,
          })
        },
      })

      const disposeReport = child.webServer.register({
        kind: 'exact',
        path: REPORT_ROUTE,
        handler: (req, res) => {
          let body = ''
          req.on('data', (chunk) => {
            if (body.length < 8000) body += chunk
          })
          req.on('end', () => {
            trace(`page-report: ${body.slice(0, 2000)}`)
            try {
              res.writeHead(204)
              res.end()
            } catch {
              /* 客户端已断开 */
            }
          })
        },
      })

      // 应用列表：跑 sessions.ps1
      const disposeProcesses = child.webServer.register({
        kind: 'exact',
        path: PROCESSES_ROUTE,
        handler: (req, res) => {
          if (PLATFORM !== 'win32') {
            json(res, 200, { processes: [], error: 'only-windows' })
            return
          }
          const sessionsScript = fileURLToPath(new URL('../runtime/sessions.ps1', import.meta.url))
          let out = ''
          let child2
          try {
            child2 = spawn(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sessionsScript],
              { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
            )
          } catch {
            json(res, 500, { processes: [], error: 'spawn-failed' })
            return
          }
          tempChildren.add(child2)
          child2.stdout.on('data', (chunk) => {
            out += String(chunk)
          })
          child2.on('exit', () => {
            tempChildren.delete(child2)
            try {
              const parsed = JSON.parse(out)
              json(res, 200, { processes: Array.isArray(parsed) ? parsed : [parsed] })
            } catch {
              json(res, 500, { processes: [], error: 'parse-failed', raw: out.slice(0, 300) })
            }
          })
        },
      })

      // 切换音源：pid=0 抓默认设备，>0 只抓该进程
      const disposeConfig = child.webServer.register({
        kind: 'exact',
        path: CONFIG_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { error: 'method-not-allowed' })
            return
          }
          let body = ''
          req.on('data', (chunk) => {
            if (body.length < 4000) body += chunk
          })
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}')
              const pid = typeof parsed.pid === 'number' && parsed.pid >= 0 ? Math.floor(parsed.pid) : 0
              currentPid = pid
              currentPidName = typeof parsed.name === 'string' ? parsed.name : ''
              savePidConfig()
              trace(`config: pid=${currentPid} name=${currentPidName}`)
              stopProbe()
              setTimeout(startProbe, 120)
              json(res, 200, { ok: true, pid: currentPid, name: currentPidName })
            } catch {
              json(res, 400, { error: 'bad-json' })
            }
          })
        },
      })

      trace(`routes registered: ${LEVEL_ROUTE} ${REPORT_ROUTE} ${PROCESSES_ROUTE} ${CONFIG_ROUTE}`)
      return () => {
        disposeLevel()
        disposeReport()
        disposeProcesses()
        disposeConfig()
      }
    })
  })
}
