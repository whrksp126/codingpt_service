// cpt-stt — 채팅 컴포저의 음성 입력(받아쓰기) 엔진. macOS 전용, Swift 한 파일.
//
// 왜 따로 도는 프로세스인가: 마이크·음성 인식(TCC)을 잘못 건드리면 **프로세스가 그 자리에서 죽는다**
//  (사용 사유 문구가 없을 때). 앱 본체에서 죽으면 창이 통째로 사라지지만 여기서 죽으면 마이크 버튼만
//  "시작할 수 없어요"가 된다. 권한 대화상자와 허용 기록은 부모(CodingPT)의 것으로 묶인다.
//
// 계약(표준출력 = 한 줄에 JSON 하나, 표준입력 = 명령):
//   → {"t":"ready"}                         듣기 시작(마이크가 실제로 열렸다)
//   → {"t":"text","text":"…","final":bool}  지금까지 들은 **전체 문장**(매번 통째로 — 받는 쪽은 갈아 끼운다)
//   → {"t":"level","v":0~1}                 입력 크기(초당 ~12회)
//   → {"t":"error","code":"mic_denied|speech_denied|unavailable|failed","msg":"…"}  이후 종료
//   → {"t":"end"}                           정상 종료(마지막 text 가 최종)
//   ← "stop\n" 또는 EOF                      그만 듣는다 → 남은 소리를 마저 인식한 뒤 end
//
// 쓰기: cpt-stt [--locale ko-KR]   /   cpt-stt --probe (권한 상태만 찍고 끝 — 대화상자를 띄우지 않는다)
import AVFoundation
import Foundation
import Speech

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  outLock.lock()
  FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
  outLock.unlock()
}
func fail(_ code: String, _ msg: String) -> Never {
  emit(["t": "error", "code": code, "msg": msg])
  exit(1)
}

var localeId = Locale.current.identifier
var probe = false
do {
  var it = CommandLine.arguments.dropFirst().makeIterator()
  while let a = it.next() {
    if a == "--locale", let v = it.next() { localeId = v } else if a == "--probe" { probe = true }
  }
}

if probe {
  emit(["t": "probe",
        "speech": SFSpeechRecognizer.authorizationStatus().rawValue,
        "mic": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
        "recognizer": SFSpeechRecognizer(locale: Locale(identifier: localeId)) != nil])
  exit(0)
}

final class Session {
  let recognizer: SFSpeechRecognizer
  let engine = AVAudioEngine()
  var request: SFSpeechAudioBufferRecognitionRequest?
  var task: SFSpeechRecognitionTask?
  /// 끝난 구간들의 글(서버 인식은 한 요청이 1분 남짓에서 끝난다 → 이어 붙이며 새 요청을 연다).
  var committed = ""
  var current = ""
  var stopping = false
  var ended = false
  var lastLevelAt = 0.0
  let q = DispatchQueue(label: "cpt-stt")

  init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  func joined() -> String {
    if committed.isEmpty { return current }
    if current.isEmpty { return committed }
    return committed + " " + current
  }

  func start() {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { fail("unavailable", "no audio input") }
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buf, _ in
      guard let self = self else { return }
      self.q.async {
        self.request?.append(buf)
        self.level(buf)
      }
    }
    engine.prepare()
    do { try engine.start() } catch { fail("unavailable", "\(error.localizedDescription)") }
    q.async { self.openRequest() }
    emit(["t": "ready"])
  }

  func level(_ buf: AVAudioPCMBuffer) {
    let now = Date().timeIntervalSince1970
    if now - lastLevelAt < 0.08 { return }
    lastLevelAt = now
    guard let ch = buf.floatChannelData?[0] else { return }
    let n = Int(buf.frameLength)
    if n == 0 { return }
    var sum: Float = 0
    for i in 0..<n { sum += ch[i] * ch[i] }
    let rms = sqrt(sum / Float(n))
    // -50dB~-10dB 를 0~1 로(말소리가 눈에 보이는 폭으로 움직이게).
    let db = 20 * log10(max(rms, 0.000_01))
    let v = max(0, min(1, (db + 50) / 40))
    emit(["t": "level", "v": Double((v * 100).rounded() / 100)])
  }

  // q 위에서만 부른다.
  func openRequest() {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 13.0, *) { req.addsPunctuation = true }
    request = req
    current = ""
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      self.q.async {
        guard self.request === req else { return }   // 지난 요청의 늦은 콜백
        if let r = result {
          self.current = r.bestTranscription.formattedString
          emit(["t": "text", "text": self.joined(), "final": false])
        }
        let done = (result?.isFinal ?? false) || error != nil
        if !done { return }
        self.committed = self.joined()
        self.current = ""
        self.request = nil
        self.task = nil
        if self.stopping { self.finish() } else { self.openRequest() }   // 구간이 끝났을 뿐 — 계속 듣는다
      }
    }
  }

  func stop() {
    q.async {
      if self.stopping { return }
      self.stopping = true
      self.engine.inputNode.removeTap(onBus: 0)
      self.engine.stop()
      if let req = self.request {
        req.endAudio()
        // 마지막 결과가 안 오는 경우(무음으로 끝남)에도 끝은 난다.
        self.q.asyncAfter(deadline: .now() + 2.0) { self.finish() }
      } else {
        self.finish()
      }
    }
  }

  // q 위에서만 부른다.
  func finish() {
    if ended { return }
    ended = true
    task?.cancel()
    emit(["t": "text", "text": joined(), "final": true])
    emit(["t": "end"])
    exit(0)
  }
}

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) ?? SFSpeechRecognizer() else {
  fail("unavailable", "no recognizer for \(localeId)")
}

var session: Session?

func begin() {
  guard recognizer.isAvailable else { fail("unavailable", "recognizer not available") }
  let s = Session(recognizer: recognizer)
  session = s
  s.start()
}

func askMicThenBegin() {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: begin()
  case .notDetermined:
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      DispatchQueue.main.async { if ok { begin() } else { fail("mic_denied", "microphone access denied") } }
    }
  default: fail("mic_denied", "microphone access denied")
  }
}

SFSpeechRecognizer.requestAuthorization { st in
  DispatchQueue.main.async {
    if st == .authorized { askMicThenBegin() } else { fail("speech_denied", "speech recognition not authorized (\(st.rawValue))") }
  }
}

// 표준입력: "stop" 또는 EOF(부모가 닫았거나 죽었다) → 그만 듣는다.
Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
  }
  if let s = session { s.stop() } else { exit(0) }
}
signal(SIGTERM) { _ in exit(0) }

RunLoop.main.run()
