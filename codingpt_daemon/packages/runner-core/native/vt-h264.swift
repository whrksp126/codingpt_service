// vt-h264 — stdin 의 원시 BGRA 프레임을 VideoToolbox(H.264, 하드웨어)로 인코딩해 stdout 으로 흘린다.
//  에이전트 PC(게스트 macOS)의 VNC 프레임버퍼를 라이브 영상으로 보내기 위한 것. serve-sim 의 인코더는
//  SimulatorKit 프레임버퍼에 묶여 있어 임의 픽셀을 못 받는다 — 이 100여 줄이 그 자리를 대신한다.
//
//  입력: 첫 줄 "W H FPS\n", 그 뒤 프레임마다 정확히 W*H*4 바이트(BGRA). 크기가 바뀌면 새 프로세스를 띄운다.
//  출력: 조각마다 [u32 BE 길이][u8 플래그][바이트]. 플래그 1=config(SPS/PPS, Annex-B), 2=키프레임, 0=델타.
//        프레임 바이트는 **Annex-B**(start code) — 데몬 emulator-stream 의 계약(scrcpy·serve-sim 과 같다).
import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox

setvbuf(stdout, nil, _IOFBF, 1 << 20)
let out = FileHandle.standardOutput
let outLock = NSLock()

func emit(_ flags: UInt8, _ data: Data) {
    var head = Data(count: 5)
    let n = UInt32(data.count)
    head[0] = UInt8(n >> 24); head[1] = UInt8((n >> 16) & 0xff); head[2] = UInt8((n >> 8) & 0xff); head[3] = UInt8(n & 0xff)
    head[4] = flags
    outLock.lock(); defer { outLock.unlock() }
    out.write(head); out.write(data)
}

func readLine() -> String? {
    var bytes = [UInt8]()
    while true {
        var b: UInt8 = 0
        let n = read(0, &b, 1)
        if n <= 0 { return bytes.isEmpty ? nil : String(decoding: bytes, as: UTF8.self) }
        if b == 10 { return String(decoding: bytes, as: UTF8.self) }
        bytes.append(b)
    }
}
func readFull(_ p: UnsafeMutableRawPointer, _ len: Int) -> Bool {
    var got = 0
    while got < len {
        let n = read(0, p + got, len - got)
        if n <= 0 { return false }
        got += n
    }
    return true
}

guard let head = readLine() else { exit(2) }
let parts = head.split(separator: " ").compactMap { Int($0) }
guard parts.count >= 2, parts[0] > 0, parts[1] > 0 else { FileHandle.standardError.write("bad header\n".data(using: .utf8)!); exit(2) }
let W = parts[0], H = parts[1], FPS = parts.count > 2 ? max(1, parts[2]) : 20
let bitrate = parts.count > 3 ? parts[3] : 4_000_000

var session: VTCompressionSession?
var sentConfig = false
let startCode = Data([0, 0, 0, 1])

// AVCC(길이 접두) → Annex-B(start code). 길이 필드는 4바이트로 고정해 달라고 세션에 요구하지 않는다 — 포맷 설명에서 읽는다.
func annexB(from sample: CMSampleBuffer, lengthSize: Int) -> Data? {
    guard let bb = CMSampleBufferGetDataBuffer(sample) else { return nil }
    var total = 0; var ptr: UnsafeMutablePointer<Int8>? = nil
    guard CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &ptr) == noErr, let base = ptr else { return nil }
    var o = Data(); o.reserveCapacity(total + 16)
    var i = 0
    while i + lengthSize <= total {
        var len = 0
        for k in 0..<lengthSize { len = (len << 8) | Int(UInt8(bitPattern: base[i + k])) }
        i += lengthSize
        if len <= 0 || i + len > total { break }
        o.append(startCode); o.append(Data(bytes: base + i, count: len))
        i += len
    }
    return o
}

let callback: VTCompressionOutputCallback = { _, _, status, flags, sampleBuffer in
    guard status == noErr, let sb = sampleBuffer, CMSampleBufferDataIsReady(sb) else { return }
    if flags.contains(.frameDropped) { return }
    var key = true
    if let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]], let first = arr.first {
        if let ns = first[kCMSampleAttachmentKey_NotSync] as? Bool, ns { key = false }
    }
    var lengthSize = 4
    if let fmt = CMSampleBufferGetFormatDescription(sb) {
        var count = 0; var nalLen: Int32 = 4
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLen) == noErr { lengthSize = Int(nalLen) }
        if key && (!sentConfig) {
            var cfg = Data()
            for idx in 0..<count {
                var p: UnsafePointer<UInt8>? = nil; var sz = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: idx, parameterSetPointerOut: &p, parameterSetSizeOut: &sz, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pp = p {
                    cfg.append(startCode); cfg.append(Data(bytes: pp, count: sz))
                }
            }
            if !cfg.isEmpty { emit(1, cfg); sentConfig = true }
        }
    }
    if let d = annexB(from: sb, lengthSize: lengthSize) { emit(key ? 2 : 0, d) }
}

var s: VTCompressionSession?
let enc: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA]
let st = VTCompressionSessionCreate(allocator: nil, width: Int32(W), height: Int32(H), codecType: kCMVideoCodecType_H264,
                                    encoderSpecification: nil, imageBufferAttributes: enc as CFDictionary,
                                    compressedDataAllocator: nil, outputCallback: callback, refcon: nil, compressionSessionOut: &s)
guard st == noErr, let sess = s else { FileHandle.standardError.write("VTCompressionSessionCreate \(st)\n".data(using: .utf8)!); exit(3) }
session = sess
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)   // B 프레임 없음 = 지연 최소
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: FPS as CFNumber)
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: (FPS * 4) as CFNumber)
VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 4 as CFNumber)
VTCompressionSessionPrepareToEncodeFrames(sess)

let frameBytes = W * H * 4
var pool: CVPixelBufferPool?
let poolAttrs: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey: W, kCVPixelBufferHeightKey: H, kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
CVPixelBufferPoolCreate(nil, nil, poolAttrs as CFDictionary, &pool)
guard let pbPool = pool else { exit(4) }

var n: Int64 = 0
let raw = UnsafeMutableRawPointer.allocate(byteCount: frameBytes, alignment: 16)
while readFull(raw, frameBytes) {
    var pb: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pbPool, &pb) == kCVReturnSuccess, let buf = pb else { continue }
    CVPixelBufferLockBaseAddress(buf, [])
    let dst = CVPixelBufferGetBaseAddress(buf)!
    let stride = CVPixelBufferGetBytesPerRow(buf)
    if stride == W * 4 { memcpy(dst, raw, frameBytes) }
    else { for y in 0..<H { memcpy(dst + y * stride, raw + y * W * 4, W * 4) } }
    CVPixelBufferUnlockBaseAddress(buf, [])
    n += 1
    //  첫 프레임과 'K' 요청(별도 채널 없음 — 4초 주기 키프레임에 맡긴다)
    let pts = CMTime(value: n, timescale: Int32(FPS))
    let props: CFDictionary? = n == 1 ? ([kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!] as CFDictionary) : nil
    VTCompressionSessionEncodeFrame(sess, imageBuffer: buf, presentationTimeStamp: pts, duration: CMTime(value: 1, timescale: Int32(FPS)), frameProperties: props, sourceFrameRefcon: nil, infoFlagsOut: nil)
}
VTCompressionSessionCompleteFrames(sess, untilPresentationTimeStamp: .invalid)
VTCompressionSessionInvalidate(sess)
exit(0)
