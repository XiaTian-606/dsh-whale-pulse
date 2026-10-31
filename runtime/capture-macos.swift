// 鱼的耳机 —— macOS 原生音频采集器（ScreenCaptureKit）
// 编译：swiftc -O capture.swift -o capture
// 运行：./capture
// 输出：每 50ms 一行 JSON {"peak":..,"rms":..}
//
// 首次运行会弹「屏幕录制」权限，允许后要重启这个程序。

import ScreenCaptureKit
import AVFoundation
import Foundation

final class AudioGrabber: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let lock = NSLock()
    private var peak: Float = 0
    private var energy: Float = 0
    private var count: Int = 0
    private var printTick: Timer?

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            fputs("{\"error\":\"no-display\"}\n", stderr)
            exit(1)
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 1
        // 最小视频流（音频采集也要求有个视频流配置）
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInitiated))
        try await s.startCapture()
        stream = s

        // 每 50ms 输出一次
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            self?.dump()
        }
        RunLoop.main.add(timer, forMode: .common)
        printTick = timer
        print("{\"ready\":true,\"mode\":\"scstream\"}")
        fflush(stdout)
    }

    private func dump() {
        lock.lock()
        let p = peak
        let e = energy
        let n = count
        peak = 0
        energy = 0
        count = 0
        lock.unlock()

        let rms = n > 0 ? sqrt(e / Float(n)) : 0
        print(String(format: "{\"peak\":%.4f,\"rms\":%.4f}", p, rms))
        fflush(stdout)
    }

    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var dataPtr: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &length,
            dataPointerOut: &dataPtr
        )
        guard status == kCMBlockBufferNoErr, let ptr = dataPtr, length > 0 else { return }

        // ScreenCaptureKit 音频默认是 Float32 交错格式
        let sampleCount = length / MemoryLayout<Float>.size
        let floats = UnsafeRawPointer(ptr).bindMemory(to: Float.self, capacity: sampleCount)
        var localPeak: Float = 0
        var localEnergy: Float = 0
        for i in 0..<sampleCount {
            let v = abs(floats[i])
            if v > localPeak { localPeak = v }
            localEnergy += v * v
        }

        lock.lock()
        if localPeak > peak { peak = localPeak }
        energy += localEnergy
        count += sampleCount
        lock.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("{\"error\":\"stream-stopped\",\"message\":\"\(error.localizedDescription)\"}")
        fflush(stdout)
        exit(1)
    }
}

@main
struct Main {
    static func main() async {
        let grabber = AudioGrabber()
        do {
            try await grabber.start()
            // 一直跑
            while true {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
        } catch {
            print("{\"error\":\"start-failed\",\"message\":\"\(error.localizedDescription)\"}")
            fflush(stdout)
            exit(1)
        }
    }
}
