param([int]$TargetPid = 0)

# 音频采集器：TargetPid=0 抓默认输出设备，>0 只抓该进程（process loopback）。
# 每 50ms 向 stdout 输出一行 {"peak":..,"rms":..,"bands":[16 段]}。
# 依赖 %TEMP%\whale-pulse-lib 下的 NAudio.dll 与 ApplicationLoopback.dll。

$ErrorActionPreference = 'Stop'

$libDir = Join-Path $env:TEMP 'whale-pulse-lib'
$naudio = Join-Path $libDir 'NAudio.dll'
$appLoop = Join-Path $libDir 'ApplicationLoopback.dll'

if (-not (Test-Path $naudio)) {
  Write-Output '{"error":"naudio-missing"}'
  exit 1
}

try {
  [System.Reflection.Assembly]::LoadFrom($naudio) | Out-Null
} catch {
  Write-Output ('{"error":"naudio-load-failed","message":"' + ($_.Exception.Message -replace '"', "'") + '"}')
  exit 1
}

# DllImport("ApplicationLoopback.dll") 找这个 DLL：光改 PATH 不一定生效，
# 用 SetDllDirectory 把临时库目录加进原生 DLL 搜索路径最稳。
$env:PATH = $libDir + ';' + $env:PATH
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class WhaleNativeLoader {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetDllDirectory(string path);
}
'@
[WhaleNativeLoader]::SetDllDirectory($libDir) | Out-Null

$cs = @'
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.CoreAudioApi;
using NAudio.Dsp;

public static class WhalePulseProbe
{
    private const int FftSize = 1024;
    private const int FftLog = 10;
    private const int Bands = 16;

    // 父进程（DSH 宿主）死了就自杀，避免变成孤儿进程挂住宿主的关闭流程
    private static int _parentPid = 0;

    private static readonly object Gate = new object();
    private static double _peak;
    private static double _energy;
    private static long _n;
    private static readonly float[] _samples = new float[FftSize];
    private static int _samplePos;

    // ── 应用级捕获（ApplicationLoopback.dll） ──────────────────
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void AudioCallback(IntPtr instance, IntPtr data, uint length);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void AudioEvent(IntPtr instance);

    [DllImport("ApplicationLoopback.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern IntPtr InitializeCapture(ushort channels, uint sampleRate, ushort bitsPerSample, AudioCallback callback, AudioEvent audioCaptureStopped);
    [DllImport("ApplicationLoopback.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern int StartCaptureAsync(IntPtr capture, uint processId, bool includeProcessTree);
    [DllImport("ApplicationLoopback.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern int StopCaptureAsync(IntPtr capture);
    [DllImport("ApplicationLoopback.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern void FreeCapture(IntPtr capture);

    // 委托必须被静态字段引用，否则会被 GC 回收、native 回调悬空
    private static AudioCallback _appOnData;
    private static AudioEvent _appOnStopped;

    public static void RunForever(int pid, int parentPid)
    {
        _parentPid = parentPid;
        if (pid > 0) RunApp(pid);
        else RunDevice();
    }

    private static bool HasActiveSession(MMDevice dev)
    {
        try
        {
            var sessions = dev.AudioSessionManager.Sessions;
            for (int i = 0; i < sessions.Count; i++)
            {
                if ((int)sessions[i].State == 1) return true;
            }
        }
        catch { }
        return false;
    }

    /** 虚拟声卡（FxSound / Voicemeeter / VB-Audio 等）通常是中转端点，抓它会得到静音或回声。 */
    private static bool IsVirtualDevice(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        var n = name.ToLowerInvariant();
        if (n.Contains("virtual")) return true;
        if (n.Contains("虚拟")) return true;
        if (n.Contains("fxsound")) return true;
        if (n.Contains("voicemeeter")) return true;
        if (n.Contains("vb-audio")) return true;
        if (n.Contains("vb audio")) return true;
        if (n.Contains("cable input")) return true;
        if (n.Contains("cable output")) return true;
        if (n.Contains("stereo mix")) return true;
        return false;
    }

    private static void RunDevice()
    {
        // 多声卡 / 虚拟声卡机器上，默认端点可能是静音的「假端点」。
        // 选择顺序：默认设备（若在出声）→ 有声且非虚拟的端点 → 任意有声端点 → 默认设备。
        WasapiLoopbackCapture cap = null;
        string pickedName = "(default)";
        try
        {
            using (var en = new MMDeviceEnumerator())
            {
                MMDevice defaultDev = null;
                try
                {
                    defaultDev = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
                }
                catch
                {
                    defaultDev = null;
                }

                MMDevice activityDev = null;
                MMDevice realDev = null;
                foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
                {
                    bool active = HasActiveSession(dev);
                    if (!active) continue;
                    if (activityDev == null) activityDev = dev;
                    if (realDev == null && !IsVirtualDevice(dev.FriendlyName)) realDev = dev;
                }

                MMDevice best = null;
                if (defaultDev != null && HasActiveSession(defaultDev)) best = defaultDev;
                else if (realDev != null) best = realDev;
                else if (activityDev != null) best = activityDev;
                else best = defaultDev;

                if (best != null)
                {
                    cap = new WasapiLoopbackCapture(best);
                    pickedName = best.FriendlyName;
                }
            }
        }
        catch
        {
            cap = null;
        }
        if (cap == null)
        {
            cap = new WasapiLoopbackCapture();
        }
        cap.DataAvailable += OnFloatData;
        cap.StartRecording();
        Console.WriteLine("{\"ready\":true,\"mode\":\"device\",\"device\":\"" + pickedName.Replace("\"", "'") + "\"}");
        Loop();
    }

    private static void RunApp(int pid)
    {
        _appOnData = new AudioCallback(OnShortData);
        _appOnStopped = new AudioEvent(OnStopped);
        IntPtr cap = InitializeCapture(2, 48000, 16, _appOnData, _appOnStopped);
        if (cap == IntPtr.Zero)
        {
            Console.WriteLine("{\"error\":\"app-init-failed\"}");
            return;
        }
        int started = StartCaptureAsync(cap, (uint)pid, true);
        if (started < 0)
        {
            Console.WriteLine("{\"error\":\"app-start-failed\",\"code\":" + started + "}");
            return;
        }
        Console.WriteLine("{\"ready\":true,\"mode\":\"app\",\"pid\":" + pid + "}");
        Loop();
        StopCaptureAsync(cap);
        FreeCapture(cap);
    }

    private static void Loop()
    {
        var bands = new double[Bands];
        while (true)
        {
            Thread.Sleep(50);
            if (_parentPid > 0 && !ParentAlive()) return;
            double p, rms;
            lock (Gate)
            {
                p = _peak;
                rms = Math.Sqrt(_n > 0 ? _energy / _n : 0);
                _peak = 0;
                _energy = 0;
                _n = 0;
            }
            ComputeBands(bands);
            Console.WriteLine(
                "{\"peak\":" + p.ToString("F4") +
                ",\"rms\":" + rms.ToString("F4") +
                ",\"bands\":" + BandsJson(bands) + "}");
        }
    }

    private static bool ParentAlive()
    {
        try
        {
            using (var proc = Process.GetProcessById(_parentPid))
            {
                return !proc.HasExited;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void OnFloatData(object sender, WaveInEventArgs e)
    {
        int cnt = e.BytesRecorded / 4;
        double peak = 0, energy = 0;
        lock (Gate)
        {
            for (int i = 0; i < cnt; i++)
            {
                float f = BitConverter.ToSingle(e.Buffer, i * 4);
                PushSample(f);
                double v = Math.Abs(f);
                if (v > peak) peak = v;
                energy += v * v;
            }
            if (peak > _peak) _peak = peak;
            _energy += energy;
            _n += cnt;
        }
    }

    private static void OnShortData(IntPtr instance, IntPtr data, uint length)
    {
        int cnt = (int)(length / 2);
        var arr = new short[cnt];
        Marshal.Copy(data, arr, 0, cnt);
        double peak = 0, energy = 0;
        lock (Gate)
        {
            for (int i = 0; i < cnt; i++)
            {
                float f = arr[i] / 32768f;
                PushSample(f);
                double v = Math.Abs(f);
                if (v > peak) peak = v;
                energy += v * v;
            }
            if (peak > _peak) _peak = peak;
            _energy += energy;
            _n += cnt;
        }
    }

    private static void PushSample(float f)
    {
        _samples[_samplePos] = f;
        _samplePos++;
        if (_samplePos >= FftSize) _samplePos = 0;
    }

    private static void OnStopped(IntPtr instance) { }

    private static void ComputeBands(double[] bands)
    {
        var c = new Complex[FftSize];
        lock (Gate)
        {
            for (int i = 0; i < FftSize; i++)
            {
                int idx = (_samplePos + i) % FftSize;
                double win = 0.54 - 0.46 * Math.Cos(2.0 * Math.PI * i / (FftSize - 1));
                c[i].X = (float)(_samples[idx] * win);
                c[i].Y = 0f;
            }
        }
        try
        {
            FastFourierTransform.FFT(true, FftLog, c);
        }
        catch
        {
            for (int b = 0; b < Bands; b++) bands[b] = 0;
            return;
        }
        int lo = 1;
        int hi = FftSize / 2;
        for (int b = 0; b < Bands; b++)
        {
            int a = lo + (hi - lo) * b / Bands;
            int z = lo + (hi - lo) * (b + 1) / Bands;
            double sum = 0;
            int n = 0;
            for (int i = a; i < z; i++)
            {
                double mag = Math.Sqrt((double)c[i].X * c[i].X + (double)c[i].Y * c[i].Y);
                sum += mag;
                n++;
            }
            double avg = n > 0 ? sum / n : 0;
            bands[b] = Math.Min(1.0, Math.Sqrt(avg) * 3.0);
        }
    }

    private static string BandsJson(double[] bands)
    {
        var sb = new StringBuilder();
        sb.Append('[');
        for (int b = 0; b < Bands; b++)
        {
            if (b > 0) sb.Append(',');
            sb.Append(bands[b].ToString("F3"));
        }
        sb.Append(']');
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies @($naudio, 'System.dll')

# 父进程 PID：宿主退出时采集器跟着退，别留下孤儿进程挂住关闭流程
$parentPid = 0
try {
  $parentPid = [int](Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
} catch {
  $parentPid = 0
}
[WhalePulseProbe]::RunForever($TargetPid, $parentPid)
