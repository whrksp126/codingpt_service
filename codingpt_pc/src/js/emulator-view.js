// emulator-view — PC 의 "모바일 화면" pane. 이 PC 에 붙어 있는 안드로이드 에뮬레이터/실기기와
//  iOS 시뮬레이터의 화면을 그리고, 클릭·드래그를 그대로 기기에 보낸다.
//
// ⚠ 앱(codingpt_app/src/workspace/EmulatorBody.tsx)에 같은 규율의 화면이 있다. 규칙 두 가지는
//   반드시 같아야 한다:
//   ① 프레임은 **당겨** 온다(한 장 받고 다음 장 요청). 밀면 느린 회선에서 지연이 눈덩이가 된다.
//   ② 좌표는 **0~1 비율**로 보낸다. 픽셀은 기기만 안다 — 여기서 환산하면 배율·회전에 어긋난다.
//
// ★ 2026-08-05 — 안드로이드는 **라이브 H.264**(scrcpy)를 받아 <canvas> 에 그린다. 프레임 폴링은
//  iOS 시뮬레이터와, 스트리밍이 안 되는 상황의 폴백으로만 남는다. 왜 바꿨는지는 데몬
//  scrcpy-protocol.js 머리주석에 실측과 함께 있다(요약: 폴링 3.4fps/300ms 지연 → 20fps/6KB·s 유휴).
//
// 프리뷰와 달리 네이티브 웹뷰를 안 쓴다(그냥 <img>/<canvas> 다) — 겹침·좌표 보정 문제가 통째로 없다.
import { api } from "./api.js";
import { icons } from "./icons.js";
import { insertAttachment, attachName, shq, toast } from "./attach-insert.js";
import { setDesktopOs } from "./desktop-os.js";
import * as i18n from "./i18n/index.js";

function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/** 아무도 안 만진 채 이만큼 지나면 쉰다 — 배경에서 계속 도는 화면이 제일 나쁘다. */
const IDLE_AFTER_MS = 60_000;

/**
 * 프레임 사이 **최소 간격**. 없으면 응답이 빠를 때 루프가 끝없이 돌아 CPU 를 태우고 데몬을 두드린다.
 *  ★ 실기기(1.3초/프레임)에서는 절대 안 보이는 결함이다 — 브라우저 하네스에서 응답이 즉시
 *   돌아오자 탭이 통째로 멈춰서 잡았다. 빠른 에뮬레이터·캐시·오류 즉시반환 모두 같은 길이다.
 */
const MIN_FRAME_GAP_MS = 120;

/** 에뮬레이터 콜드 부팅을 기다리는 상한. 1분을 넘기는 기기가 흔해서 넉넉히 잡는다. */
const BOOT_WAIT_MS = 150_000;

/** "아직 조작할 수 없는" 기기를 다시 물어보는 횟수 상한(4초 간격 = 약 1분). */
const CAP_RETRY_MAX = 15;

/**
 * H.264 Annex-B 로 디코딩한다. `description` 없이 configure 하면 WebCodecs 가 Annex-B 로 읽고,
 *  첫 키프레임 앞에 SPS/PPS(config 패킷)를 붙여 주면 된다.
 */
const H264_CODEC = 'avc1.640028';
/** 데몬이 프레임 앞에 붙이는 1바이트 머리(emulator-stream.js 와 같은 값). */
const FLAG_CONFIG = 1;
const FLAG_KEY = 2;
/** 4 = 따라잡기용 조각(디코딩만 하고 **그리지 않는다**) — 데몬 emulator-stream.js 의 같은 이름 주석. */
const FLAG_CATCHUP = 4;

/**
 * 기기 조작 버튼의 **그림과 이름**. 어떤 버튼을 그릴지는 기기가 정한다(`caps.keys`) —
 *  여기 없는 키가 오면 그냥 안 그린다(모르는 걸 그려 놓고 눌리면 오류만 난다).
 */
const EMU_KEYS = {
  back: { icon: 'navBack', title: '뒤로' },
  //  ★ 같은 이름이라도 **OS 마다 그림이 다르다** — 안드로이드 홈은 내비바의 ○, 아이폰 홈은 집이다.
  //   두 OS 에 ○ 를 함께 쓰던 앞 버전은 iOS 에서 무슨 버튼인지 알 수 없었다(2026-08-06 지적).
  home: { icon: 'navHome', iosIcon: 'homeIos', title: '홈' },
  recents: { icon: 'navRecents', title: '최근 앱' },
  rotate: { icon: 'rotate', title: '세로/가로 회전' },
  volumeUp: { icon: 'volumeUp', title: '볼륨 올리기' },
  volumeDown: { icon: 'volumeDown', title: '볼륨 내리기' },
  lock: { icon: 'lockScreen', title: '화면 잠금/깨우기' },
  //  구 데몬 호환 — 예전 목록에는 화면 전원이 `power` 라는 이름으로 들어 있었다.
  power: { icon: 'lockScreen', title: '화면 잠금/깨우기' },
};

/** 이 웹뷰가 H.264 를 풀 수 있는가 — 없으면 조용히 폴링으로 돌아간다(빈 화면 금지). */
function canDecodeVideo() {
  return typeof globalThis.VideoDecoder === 'function' && typeof globalThis.EncodedVideoChunk === 'function';
}

export class EmulatorView {
  /**
   * @param {HTMLElement} host  본문 컨테이너
   * @param {{ deviceId: string|null, onDeviceChange: (id: string|null, name: string) => void }} opts
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.deviceId = opts.deviceId || null;
    this.onDeviceChange = opts.onDeviceChange || (() => {});
    this.devices = null;
    this.tools = null;
    this.err = null;
    this.frameUrl = null;
    this.frameAspect = null;
    this.lastTouch = Date.now();
    this.disposed = false;
    this.running = false;
    //  가려진 탭(혼합 탭에서 다른 탭이 앞에 있음)은 프레임을 당기지 않는다. 한 장이 수십 KB 라
    //   "안 보이는데 계속 받는" 상태는 그 자체로 결함이다. 독립 pane 은 늘 보이므로 기본 true.
    this.visible = true;
    /**
     * 켜는 중인 AVD 이름 — **id 가 바뀌기 때문에** 필요하다(2026-08-05 실사고).
     *  꺼진 AVD 는 `avd:Pixel_9a`, 켜지면 `android:emulator-5554` 다. 켜기를 누른 뒤 들고 있던
     *  id 는 목록에서 사라지고, 화면은 그 죽은 id 를 붙든 채 영원히 '꺼짐' 으로 남았다.
     *  이 이름이 남아 있는 동안 목록을 다시 읽을 때마다 같은 이름의 새 행을 찾아 **따라간다**.
     */
    this.bootingAvd = null;
    /** 라이브 스트림(있으면 폴링을 안 돈다) */
    this.stream = null;      // { streamId, url }
    this.ws = null;
    this.decoder = null;
    this.canvasEl = null;
    this.configBytes = null;
    this.sawKeyFrame = false;
    this.videoOn = false;    // 지금 영상으로 보고 있는가(폴링과 배타)
    /**
     * 지금 기기를 **가로로 눕혀 놓았는가**(회전 버튼이 오가는 두 상태). null = 아직 모름 →
     *  첫 프레임을 보고 "지금 보이는 그대로" 로 정한다(가로가 자연스러운 태블릿도 안 돌아간다).
     */
    this.wantLandscape = null;
    /**
     * 보여 줄 때 돌려야 하는 각도(0 또는 90). 규칙은 딱 한 줄이다:
     *  **보이는 프레임이 원하는 방향과 다르면 90도 돌려 그린다.**
     *
     *  · iOS 는 눕혀도 프레임버퍼가 세로 그대로라(내용만 돈다) → 늘 90도가 정답이다.
     *  · 안드로이드는 OS 가 회전을 받아들이면 프레임 자체가 가로가 된다 → 우리가 돌릴 게 없다(0도).
     *  · 두 OS 모두 **거부하는 화면이 있다**(아이폰 홈 화면·안드로이드 런처는 세로 고정이다).
     *    그때는 프레임이 세로 그대로니 우리가 90도 돌린다 = 기기를 손에 들고 돌린 모습.
     *    Orca 도 같은 그림을 보여 준다(홈 화면 아이콘 글자까지 옆으로 눕는다).
     *  ⚠ 그림을 돌리면 **입력 좌표도 같이 돌려야 한다**(안 그러면 회전 뒤 엉뚱한 데가 눌린다).
     */
    this.visualRot = 0;

    //  pane 안 알림함(2026-09-21) — 화면 아래 안내줄(영상/조작 사유·오류·개입 사유)이 화면을 깎던 걸 없애고
    //   조작 줄/상태 바의 종 버튼으로 모은다. 새로 뜨거나 바뀌면 로그에 쌓고 잠깐 토스트로 띄운다.
    this.notices = [];
    this.noticeSeq = 0;
    this.seenId = 0;
    this.lastBySrc = {};
    this.toast = null;
    this._toastTimer = null;
    this.noticeOpen = false;

    this.el = document.createElement("div");
    this.el.className = "emu";
    this.host.appendChild(this.el);
    this.render();
    this.loadDevices();
    //  ★ 복원된 pane(기기 id 를 이미 아는 채로 생성)도 라이브 영상을 붙인다(2026-09-19 실사고: 재시작 뒤 복원된
    //   모바일 화면·에이전트 PC 가 전부 폴링으로만 돌았다 — startVideo 는 select/setVisible 에서만 불렸고,
    //   pane.js 의 setVisible(true) 는 기본값과 같아 아무것도 안 했다). 실패하면 loadDevices 의 폴링이 그대로 돈다.
    if (this.deviceId) void this.startVideo().catch(() => false);
  }

  dispose() {
    this.disposed = true;
    this._disposedDesk = true;
    this.stopDeskPoll();
    this.stopVideo();
    clearTimeout(this._capTimer);
    try { this.el.remove(); } catch (_) { /* noop */ }
  }

  /** 탭 전환 — 보이면 루프 재개, 가려지면 다음 장부터 멈춘다(받는 중이던 한 장은 그냥 버린다). */
  setVisible(on) {
    const next = !!on;
    if (next === this.visible) return;
    this.visible = next;
    if (next) {
      this.lastTouch = Date.now();
      //  ★ 돌아올 때마다 기기 목록을 다시 읽는다(2026-08-06 폰 실사고와 같은 이유): 기기의 조작 능력
      //   (caps.input/keys)은 목록을 읽은 그 순간의 상태다. 시뮬레이터가 아직 안 떠 있을 때 읽으면
      //   "조작 불가" 로 굳어 다 뜬 뒤에도 영영 버튼이 안 나온다.
      void this.loadDevices();
      //  숨어 있는 동안 데몬이 유휴 정리로 스트림을 접었을 수 있다 — 다시 붙여 본다.
      if (this.deviceId && !this.videoOn) void this.startVideo().then((ok) => { if (!ok) this.ensureLoop(); });
      else this.ensureLoop();
    } else {
      //  가려졌으면 인코더도 끈다(안 보이는 화면을 계속 인코딩하는 건 그 자체로 결함이다).
      this.stopVideo();
    }
  }

  async loadDevices() {
    try {
      const r = await api.emulatorList();
      if (this.disposed) return;
      this.devices = (r && r.devices) || [];
      //  에이전트 PC의 멈춤 상태는 기기 행에 실려 온다 — 폰이 풀었으면 여기 버튼도 따라간다.
      const desk = this.devices.find((d) => d.kind === "desktop");
      if (desk && desk.desktop) this.deskPaused = !!desk.desktop.paused;
      this.tools = (r && r.tools) || {};
      this.err = null;
    } catch (e) {
      if (this.disposed) return;
      this.devices = [];
      this.err = e && e.message ? e.message : String(e);
    }
    // 켜는 중이던 AVD 가 떴으면 **새 id 로 갈아탄다**(id 가 바뀌므로 여기서 안 따라가면 영원히 '꺼짐').
    if (this.bootingAvd) {
      const hit = (this.devices || []).find((d) => d.avdName === this.bootingAvd && d.state === "booted");
      if (hit) {
        this.bootingAvd = null;
        if (hit.id !== this.deviceId) { this.select(hit.id); return; }
      }
    }
    //  ★ 복원 직후에는 id 만 있고 이름은 목록을 받아야 안다 — 알게 된 그 순간 탭 제목에 올린다.
    if (this.deviceId && this.deviceName()) this.onDeviceChange(this.deviceId, this.deviceName());
    this.render();
    this.ensureLoop();
    this.retryCaps();
  }

  /**
   * 아직 조작할 수 없는 기기를 보고 있으면 잠깐씩 다시 물어본다(부팅 중·serve-sim 준비 중).
   *  상한을 둔다 — 정말 조작을 지원하지 않는 기기도 있고, 그때 무한 폴링은 그냥 낭비다.
   */
  retryCaps() {
    if (this.disposed || !this.visible || !this.deviceId) return;
    const d = this.device();
    if (d && d.caps && d.caps.input) { this.capRetry = 0; return; }
    if ((this.capRetry || 0) >= CAP_RETRY_MAX) return;
    clearTimeout(this._capTimer);
    this._capTimer = setTimeout(() => {
      if (this.disposed || !this.visible) return;
      this.capRetry = (this.capRetry || 0) + 1;
      void this.loadDevices();
    }, 4000);
  }

  /**
   * 켜질 때까지 목록을 다시 읽는다. 콜드 부팅은 1분을 넘기기도 해서 고정 타이머 몇 개로는 늘 놓친다
   *  (그게 '꺼짐' 으로 굳던 이유다).
   */
  watchBoot(avdName) {
    this.bootingAvd = avdName || null;
    if (!this.bootingAvd) return;
    const started = Date.now();
    const tick = async () => {
      if (this.disposed || !this.bootingAvd) return;
      if (Date.now() - started > BOOT_WAIT_MS) { this.bootingAvd = null; this.render(); return; }
      await this.loadDevices();
      if (!this.disposed && this.bootingAvd) setTimeout(tick, 2500);
    };
    setTimeout(tick, 2500);
  }

  device() { return (this.devices || []).find((d) => d.id === this.deviceId) || null; }

  /** 사람이 읽는 기기 이름. 목록을 아직 못 받았으면 빈 문자열(추측한 이름을 탭에 박지 않는다). */
  deviceName() { const d = this.device(); return d ? d.name : ""; }

  select(id) {
    this.stopVideo();               // 기기를 바꾸면 이전 기기의 인코더를 반드시 끈다
    this.deviceId = id;
    this.frameUrl = null;
    this.frameAspect = null;
    this.videoNote = '';
    this.visualRot = 0;             // 기기를 바꾸면 표시 회전도 처음으로
    this.wantLandscape = null;      //  (다음 기기의 첫 프레임을 보고 다시 정한다)
    this.capRetry = 0;              // 새 기기는 조작 준비 재시도도 처음부터
    this.lastTouch = Date.now();
    //  ★ 이름까지 같이 올린다 — 탭 제목이 기기명이 되어야 어느 탭이 어느 기기인지 한눈에 보인다
    //   (id 는 `ios:8B21…` 라 사람이 읽을 수 없다). 목록을 아직 못 받았으면 빈 문자열 →
    //   목록이 들어온 뒤 render 에서 다시 올린다.
    this.onDeviceChange(id, this.deviceName());
    this.render();
    //  영상이 붙으면 폴링은 시작도 안 한다. 안 붙으면 그때 폴링을 돈다.
    if (id) void this.startVideo().then((ok) => { if (!ok && !this.disposed) this.ensureLoop(); });
  }

  /**
   * 라이브 영상 붙이기. 되면 폴링을 아예 안 돈다.
   *  ⚠ 실패는 **조용히** 폴링으로 돌아간다 — 안드로이드 SDK 는 있는데 인터넷이 없어 도우미를 못
   *   받는 상황 등에서 화면이 통째로 비면 안 된다. 대신 왜 느린지는 아래 힌트 줄에 적는다.
   */
  async startVideo() {
    if (this.videoOn || this.disposed || !this.deviceId) return false;
    //  안드로이드=scrcpy · iOS=serve-sim. 둘 다 같은 바이트를 주므로 여기서 갈라질 이유가 없다.
    //  (해당 PC 에 경로가 없으면 stream.start 가 실패하고 아래에서 조용히 폴링으로 돌아간다.)
    if (!/^(android|ios|desktop):/.test(this.deviceId)) return false;
    //  꺼진 에이전트 PC 에 스트림을 열면 데몬이 거절한다 — 켜지면 loadDevices → select 경로가 다시 연다.
    const dv0 = this.device();
    if (dv0 && dv0.kind === "desktop" && dv0.state !== "booted") return false;
    if (!canDecodeVideo()) { this.videoNote = i18n.t('이 창은 영상 디코딩을 지원하지 않아 화면을 한 장씩 받아요.'); return false; }
    let info;
    try { info = await api.emulatorStreamStart(this.deviceId); }
    catch (e) { this.videoNote = e && e.message ? e.message : String(e); return false; }
    if (this.disposed || !this.deviceId) { void api.emulatorStreamStop(info.streamId).catch(() => {}); return false; }
    this.stream = info;
    this.videoNote = '';
    this.videoOn = true;
    //  ★ 이미 눕혀 놓은 기기에 붙었을 수도 있다 — 데몬이 아는 방향이 있으면 그걸 출발점으로 삼는다
    //   (iOS 는 붙는 순간 세로로 맞춰지므로 대개 'portrait' 다).
    if (typeof info.orientation === 'string') this.wantLandscape = /^landscape/.test(info.orientation);
    this.frameAspect = info.width && info.height ? info.width / info.height : this.frameAspect;
    this.render();                       // <img> → <canvas> 로 갈아끼운다
    this.openVideoSocket();
    return true;
  }

  openVideoSocket() {
    /**
     * 디코더에 넣어 놓고 아직 안 나온 프레임 수. **밀려 있으면 그리지 않는다**(마지막 것만 그린다).
     *  왜: 화면에 새로 붙으면 데몬이 **지금 GOP 를 통째로 되감아** 준다(키프레임부터 지금까지 —
     *  안 그러면 다음 키프레임까지 검은 화면이다). 그걸 순서대로 다 그리면 방금 지나간 몇 초가
     *  빨리감기로 재생된다(폰에서 "탭 갔다 오면 화면이 저절로 움직인다" 로 보고된 그 움직임).
     *  디코딩은 다 해야 한다(델타가 앞 프레임을 참조한다) — **그리기만** 건너뛴다.
     */
    let queued = 0;
    this._lastPaintAt = 0;
    /** 디코더에 넣은 순서대로 "그릴 것인가" — 따라잡기용 조각은 false 다(위 FLAG_CATCHUP). */
    const skipQ = [];
    const decoder = new globalThis.VideoDecoder({
      output: (frame) => {
        if (queued > 0) queued--;
        const skip = skipQ.length ? skipQ.shift() : false;
        const cv = this.canvasEl;
        if (!this.disposed && cv) {
          //  캔버스 크기를 매 프레임 만지면 백스토어가 다시 잡히고 리플로우가 난다 — 바뀔 때만.
          if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) {
            const wasLandscape = this.frameIsLandscape();
            cv.width = frame.displayWidth;
            cv.height = frame.displayHeight;
            this.frameAspect = frame.displayWidth / frame.displayHeight;
            //  ★ 세로↔가로가 바뀌었다 = 기기가 실제로 돌았다(안드로이드는 인코딩 크기가 바뀐다).
            //   회전 표시를 다시 계산한다 — 이게 없으면 기기가 돈 뒤에도 우리가 덧돌려 그린다.
            if (this.frameIsLandscape() !== wasLandscape) this.onFrameShapeChange();
          }
          //  따라잡기·밀린 것은 안 그린다 — 단 250ms 넘게 안 그렸으면 그린다(폰 EmulatorVideo 와 같은 규칙: 하드웨어
          //   디코더가 프레임을 쥐고 내놓으면 queued 가 0 이 되는 순간이 없다, 2026-09-20).
          const nowMs = Date.now();
          if (!skip && (queued === 0 || nowMs - this._lastPaintAt > 250)) { this._lastPaintAt = nowMs; cv.getContext('2d')?.drawImage(frame, 0, 0); }
          if (this.errEl && this.err) { this.err = null; this.errEl.textContent = ''; }
        }
        frame.close();
      },
      error: () => this.fallbackToPolling(i18n.t('영상을 그리지 못해 한 장씩 받는 방식으로 돌아갔어요.')),
    });
    decoder.configure({ codec: H264_CODEC, optimizeForLatency: true });
    this.decoder = decoder;

    const ws = new WebSocket(this.stream.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    //  10초 안에 한 장도 못 받으면 뭔가 잘못된 것이다 — 검은 화면으로 두지 않고 폴링으로 돌아간다.
    let firstTimer = setTimeout(() => this.fallbackToPolling(i18n.t('화면이 오지 않아 한 장씩 받는 방식으로 돌아갔어요.')), 10000);
    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      const flags = buf[0];
      const body = buf.subarray(1);
      if (flags & FLAG_CONFIG) { this.configBytes = body.slice(); return; }
      const isKey = !!(flags & FLAG_KEY);
      //  Annex-B 는 첫 IDR 앞에 SPS/PPS 가 있어야 한다 — 첫 키프레임에 붙여 준다.
      if (!this.sawKeyFrame) {
        if (!isKey) return;                       // 키프레임 전의 델타는 풀 수 없다(버린다)
        this.sawKeyFrame = true;
      }
      let data = body;
      if (isKey && this.configBytes) {
        data = new Uint8Array(this.configBytes.length + body.length);
        data.set(this.configBytes, 0);
        data.set(body, this.configBytes.length);
      }
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      try {
        queued++;
        skipQ.push(!!(flags & FLAG_CATCHUP));
        this.decoder.decode(new globalThis.EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: (this.vpts = (this.vpts || 0) + 1000),
          data,
        }));
      } catch (_) { /* 한 장 못 풀어도 다음 키프레임에서 복구된다 */ }
    };
    ws.onerror = () => { /* close 에서 처리 */ };
    ws.onclose = () => {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      if (this.disposed || !this.videoOn) return;
      this.fallbackToPolling(i18n.t('영상 연결이 끊겨 한 장씩 받는 방식으로 돌아갔어요.'));
    };
  }

  /** 영상을 접고 폴링으로 — 화면이 비는 것보다 느린 게 낫다. */
  fallbackToPolling(note) {
    if (!this.videoOn) return;
    this.stopVideo();
    this.videoNote = note || '';
    if (this.disposed) return;
    this.render();
    this.ensureLoop();
  }

  stopVideo() {
    this.videoOn = false;
    this.sawKeyFrame = false;
    this.configBytes = null;
    const { ws, decoder, stream } = this;
    this.ws = null; this.decoder = null; this.stream = null; this.canvasEl = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch (_) { /* noop */ } }
    if (decoder) { try { decoder.close(); } catch (_) { /* noop */ } }
    if (stream) api.emulatorStreamStop(stream.streamId).catch(() => {});
  }

  /** 프레임 루프 — **한 장을 받고 나서** 다음 장을 요청한다(겹쳐 쏘지 않는다). */
  ensureLoop() {
    if (this.running || !this.deviceId || this.disposed || !this.visible || this.videoOn) return;
    this.running = true;
    (async () => {
      while (!this.disposed && this.deviceId && this.visible && !this.videoOn) {
        const dv = this.device();
        const isDesk = !!(dv && dv.kind === "desktop");
        //  ★ 에이전트 PC 는 쉬지 않는다 — 사용자는 손을 안 대고 **에이전트가 하는 걸 지켜본다**(그게 이 pane 의 용도).
        //   60초 유휴 정지는 폰 화면(사용자가 만지는 물건) 규칙이다. 안 보이면 setVisible 이 이미 루프를 세운다.
        //   (2026-09-19 실사고: 켜고 로그인까지 60초 넘게 걸려 첫 프레임 전에 잠들어 영영 빈 화면)
        if (!isDesk && Date.now() - this.lastTouch > IDLE_AFTER_MS) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        //  꺼진 에이전트 PC 에는 프레임을 묻지 않는다 — 켜지면 pollDesk 가 기기 목록을 새로 읽어 state 가 바뀐다.
        if (isDesk && dv.state !== "booted") {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const t0 = Date.now();
        try {
          const f = await api.emulatorFrame(this.deviceId, { maxWidth: this.wantWidth(), quality: 72 });
          if (this.disposed) break;
          this.frameUrl = `data:${f.mime};base64,${f.base64}`;
          if (f.width && f.height) {
            const wasLandscape = this.frameIsLandscape();
            this.frameAspect = f.width / f.height;
            this.lastFrameSize = { w: f.width, h: f.height };
            if (this.frameIsLandscape() !== wasLandscape) this.onFrameShapeChange();   // 영상과 같은 규율
          }
          this.err = null;
          this.paintFrame();
        } catch (e) {
          if (this.disposed) break;
          this.err = e && e.message ? e.message : String(e);
          this.paintError();
          await new Promise((r) => setTimeout(r, 2000));   // 실패했는데 계속 두드리지 않는다
          continue;
        }
        const spent = Date.now() - t0;
        if (spent < MIN_FRAME_GAP_MS) await new Promise((r) => setTimeout(r, MIN_FRAME_GAP_MS - spent));
      }
      this.running = false;
    })();
  }

  /**
   * 그릴 버튼 목록 — 기기가 알려 준 것(`caps.keys`)만, 우리가 그림을 아는 것만.
   *  구 데몬은 목록을 안 준다 → 그때만 안드로이드 3버튼으로 폴백한다(그 시절 동작 유지).
   */
  keyRow(dev) {
    const ks = dev && dev.caps && Array.isArray(dev.caps.keys) && dev.caps.keys.length
      ? dev.caps.keys : ["recents", "home", "back"];
    return ks.filter((k) => EMU_KEYS[k]);
  }

  /**
   * 받을 프레임의 가로 픽셀 수.
   *
   * ★ 480 고정이었다(2026-08-06 실사고). 3배 밀도 아이폰(1179px)을 480 으로 줄여 보내고 레티나
   *  화면에서 다시 늘려 그리니 **두 번 뭉개져** 글씨가 안 읽혔다. 보이는 폭 x 화면 배율,
   *  즉 "실제로 찍히는 점의 수" 만큼만 받는다 — 그보다 크면 낭비, 작으면 뿌옇다.
   */
  wantWidth() {
    const el = this.canvasEl || this.imgEl;
    const css = el && el.clientWidth ? el.clientWidth : 0;
    const dpr = window.devicePixelRatio || 1;
    return Math.max(360, Math.min(1200, Math.round(css * dpr) || 480));
  }

  /** 지금 받고 있는 프레임이 가로 모양인가(모르면 null). */
  frameIsLandscape() {
    const cv = this.canvasEl;
    if (cv && cv.width && cv.height) return cv.width > cv.height;
    if (this.frameAspect) return this.frameAspect > 1;
    return null;
  }

  /**
   * 프레임 모양이 바뀔 때마다·회전 버튼을 누를 때마다 각도를 다시 계산한다(위 visualRot 주석).
   *
   * ★ 프레임이 **스스로** 우리가 아는 방향과 다르게 바뀌었으면 그건 기기 쪽에서 돌린 것이다
   *  (에뮬레이터 창의 회전 버튼·기기 자동회전). 우리 상태를 그쪽에 맞춘다 — 안 맞추면 그 뒤로
   *  계속 90도 어긋난 그림을 그린다.
   */
  syncRotation() {
    const fl = this.frameIsLandscape();
    if (fl === null) return;
    if (this.wantLandscape === null) this.wantLandscape = fl;      // 처음 본 모습을 기준으로 삼는다
    const deg = this.wantLandscape === fl ? 0 : 90;
    if (deg === this.visualRot) return;
    this.visualRot = deg;
    this.applyLayout();
  }

  /**
   * 프레임 **모양이 바뀌었다**. 우리가 요청한 방향으로 바뀌었으면 기기가 받아들인 것이고(각도만
   *  다시 세면 된다), 우리가 모르는 방향으로 바뀌었으면 기기 쪽에서 돌린 것이다 → 그쪽에 맞춘다.
   */
  onFrameShapeChange() {
    const fl = this.frameIsLandscape();
    if (fl !== null && this.wantLandscape !== null && this.wantLandscape !== fl) this.wantLandscape = fl;
    this.syncRotation();
  }

  /**
   * 버튼 스트립을 **여백이 생기는 쪽**에 붙인다.
   *  · 액자가 화면보다 가로로 넓다 → 좌우가 남는다 → 오른쪽 세로줄
   *  · 그 반대 → 위아래가 남는다 → 아래 가로줄
   *  세로 기기든 가로 기기든, 회전했든 아니든 같은 규칙 하나로 정해진다.
   */
  applyLayout() {
    const wrap = this.mainEl;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    //  지금 **보이는** 화면 비율(회전을 반영한 값). 모르면 세로로 가정한다(대부분 세로 기기다).
    const raw = this.frameAspect || 0.46;
    const deg = ((this.visualRot % 360) + 360) % 360;
    const shown = (deg === 90 || deg === 270) ? 1 / raw : raw;
    //  스트립이 차지할 폭/높이를 빼고 견줘야 왔다갔다(레이아웃 진동)하지 않는다(= .emu-key + padding).
    const side = this.keysEl ? 46 : 0;
    const roomIfRight = (r.width - side) / Math.max(1, r.height);
    const right = roomIfRight > shown;      // 옆에 세워도 화면이 안 줄어드는가
    wrap.classList.toggle("keys-right", right);
    wrap.classList.toggle("keys-bottom", !right);
    this.applyVisualRot();
  }

  /** 표시 회전을 화면에 반영한다(그림 + 액자 비율). */
  applyVisualRot() {
    const el = this.canvasEl || this.imgEl;
    if (!el) return;
    const deg = this.visualRot % 360;
    el.style.transform = deg ? `rotate(${deg}deg)` : "";
    //  90/270 도면 액자의 가로세로가 바뀐다 — 안 바꾸면 돌린 그림이 액자 밖으로 나간다.
    el.style.width = "100%";
    el.style.height = "100%";
    if (deg === 90 || deg === 270) {
      const st = this.el.querySelector(".emu-stage");
      if (st) {
        const r = st.getBoundingClientRect();
        //  회전 전 기준으로 폭/높이를 맞바꿔 둔다(transform 은 레이아웃을 안 바꾼다).
        el.style.width = r.height + "px";
        el.style.height = r.width + "px";
        el.style.position = "absolute";
        el.style.left = `${(r.width - r.height) / 2}px`;
        el.style.top = `${(r.height - r.width) / 2}px`;
      }
    } else {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
    }
  }

  /** 화면 좌표 → 0~1. `object-fit: contain` 의 **여백을 빼고** 계산한다. */
  ratioOf(ev) {
    const img = this.imgEl || this.canvasEl;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const deg = ((this.visualRot % 360) + 360) % 360;
    /**
     * 여백을 뺄 때 쓰는 비율은 **지금 눈에 보이는** 비율이다 — 90/270 도로 돌려 그리고 있으면
     *  가로세로가 뒤집힌다.
     *  ★ 여기가 틀리면 회전 뒤 화면 한복판을 눌러도 "기기 밖" 으로 판정돼 **아무 일도 안 일어난다**
     *   (2026-08-06 실측: 세로 폰을 눕혀 놓고 크롬 아이콘을 눌렀는데 ratioOf 가 null 을 돌려줬다.
     *   오류도 안 나고 조용히 무시되니, 겉보기엔 "회전하면 조작이 죽는다" 로 보인다).
     */
    const raw = this.frameAspect;
    const ar = raw && (deg === 90 || deg === 270) ? 1 / raw : raw;
    let dw = r.width;
    let dh = r.height;
    if (ar) {
      if (r.width / r.height > ar) dw = r.height * ar; else dh = r.width / ar;
    }
    const ox = r.left + (r.width - dw) / 2;
    const oy = r.top + (r.height - dh) / 2;
    const x = (ev.clientX - ox) / dw;
    const y = (ev.clientY - oy) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;   // 여백을 눌렀다 — 기기 밖이다
    //  ★ 그림을 돌려 보여 주고 있으면 **좌표도 같은 만큼 되돌려** 기기 좌표계로 옮긴다.
    //   안 하면 회전 직후부터 누르는 곳과 눌리는 곳이 어긋난다(그리고 그건 조용한 실패다).
    if (deg === 90) return { x: y, y: 1 - x };
    if (deg === 180) return { x: 1 - x, y: 1 - y };
    if (deg === 270) return { x: 1 - y, y: x };
    return { x, y };
  }

  async send(body) {
    if (!this.deviceId) return;
    this.lastTouch = Date.now();
    //  ★ 라이브 영상일 때는 **지금 보고 있는 영상 크기**를 같이 보낸다. scrcpy 는 클라이언트가 말한
    //   화면 크기가 인코딩 중인 영상 크기와 다르면 그 입력을 조용히 버린다(기기 픽셀을 보내면
    //   눌러도 아무 일도 안 일어난다 — 2026-08-05 실측). 회전하면 캔버스 크기가 따라 바뀌므로
    //   여기서 읽는 값이 항상 정답이다.
    const cv = this.canvasEl;
    const vs = this.videoOn && cv && cv.width && cv.height
      ? { videoWidth: cv.width, videoHeight: cv.height } : {};
    try {
      const r = await api.emulatorInput({ id: this.deviceId, ...vs, ...body });
      this.err = null;
      return r || true;
    } catch (e) { this.err = e && e.message ? e.message : String(e); this.paintError(); return false; }
  }

  /**
   * 세로 ↔ 가로. **우리 그림을 먼저 돌리고** 기기에도 회전을 요청한다.
   *
   * ★ 기기가 받아 줬는지 기다리지 않는 게 핵심이다(2026-08-06 재설계). 아이폰 홈 화면·안드로이드
   *  런처는 세로 고정이라 회전을 무시한다 — 기기의 대답을 기다렸다가 돌리던 앞 버전은 사용자가
   *  버튼을 처음 누르는 그 자리에서 **아무 일도 안 일어났다**. 기기를 손에 들고 돌리면 화면이
   *  다시 그려지든 말든 눕는다. 그 모습을 그대로 보여 준다(Orca 도 같다).
   */
  async rotate() {
    const cur = this.wantLandscape === null ? (this.frameIsLandscape() || false) : this.wantLandscape;
    this.wantLandscape = !cur;
    this.syncRotation();
    const ok = await this.send({ type: "rotate", orientation: !cur ? "landscape" : "portrait" });
    //  보낼 수 없는 기기(회전을 못 하는 폴백 경로)면 돌린 그림을 되돌린다 — 오류만 나고 화면은
    //   돌아간 채로 두면 사용자는 조작이 어긋난 줄 안다.
    if (!ok) { this.wantLandscape = cur; this.syncRotation(); }
  }

  /**
   * 지금 화면을 캡처해 에이전트에게 첨부한다.
   *  · 라이브 영상이 돌고 있어도 **데몬에게 한 장 다시 달라고 한다** — 캔버스에서 긁으면 우리가 이미
   *   줄여 놓은 해상도(wantWidth)로 굳고, 회전해 그린 경우엔 돌아간 그림이 나간다. 원본이 정답이다.
   *  · 저장 위치·삽입 규칙은 프리뷰 요소 캡처(design-pick)와 **같은 길**을 쓴다.
   */
  /** 데스크톱 상태 바. 상태·해상도·에이전트 상태를 한 줄로, 오른쪽에 버튼. */
  buildDeskBar(dev, booted) {
    const bar = document.createElement("div");
    bar.className = "emu-deskbar";
    const st = this.deskStatus || (dev && dev.desktop) || {};
    const handoff = st.handoff || null;
    const paused = !!st.paused;
    const left = document.createElement("div");
    left.className = "emu-deskbar-l";
    //  글자는 **에이전트가 남긴 개입 사유**뿐(다국어 UI — 상태 문구는 버튼 모양이 말한다, 사용자 결정 2026-09-19).
    left.innerHTML = booted && handoff ? `${icons.handoffIn({ size: 14 })}<span>${escapeHtml(handoff.reason || "")}</span>` : "";
    bar.appendChild(left);
    const right = document.createElement("div");
    right.className = "emu-deskbar-r";
    const btn = (label, title, onClick, cls, html) => {
      const b = document.createElement("button");
      b.className = "emu-deskbtn" + (cls ? " " + cls : "");
      if (html) b.innerHTML = html; else b.textContent = label;
      if (title) b.title = title;
      b.addEventListener("click", onClick);
      right.appendChild(b);
      return b;
    };
    if (booted) {
      //  멈춤↔재개 = 일시정지/재생 아이콘 하나(멈춰 있으면 눌린 모양 + 재생 아이콘).
      btn("", paused ? i18n.t('에이전트 재개') : i18n.t('에이전트 멈춤'), async () => {
        try { await api.desktopPause(!paused); this.deskPaused = !paused; await this.pollDesk(true); }
        catch (e) { this.err = e && e.message ? e.message : String(e); this.paintError(); }
      }, "icon" + (paused ? " on" : ""), (paused ? icons.play : icons.pause)({ size: 14 }));
      btn("", i18n.t('이 화면을 캡처해 에이전트에게 첨부'), (ev) => void this.capture(ev.currentTarget), "icon", icons.camera({ size: 14 }));
      if (handoff) {
        //  개입 끝 = 에이전트에게 돌려준다(handoffOut). 주 동작이라 채운 모양.
        btn("", i18n.t('개입을 끝내고 에이전트를 재개합니다'), async () => {
          try { await api.desktopPause(false); await this.pollDesk(true); }
          catch (e) { this.err = e && e.message ? e.message : String(e); this.paintError(); }
        }, "icon primary", icons.handoffOut({ size: 14 }));
      }
    }
    //  전원 = 아이콘 하나(켜짐이면 눌린 모양). 켜는 중엔 잠근다 — 두 번 누르면 start 가 겹친다.
    const starting = st.phase === "starting" || this._powering;
    const pw = btn("", booted ? i18n.t('끄기') : i18n.t('켜기'), async () => {
      if (this._powering) return;
      this._powering = true;
      try { await this.power(booted ? "shutdown" : "boot"); } finally { this._powering = false; }
    }, "icon" + (booted ? " on" : ""), icons.power({ size: 14 }));
    if (starting) pw.disabled = true;
    //  알림 종 — 화면 아래 안내줄 대신. 상태 바 오른쪽(설정 ··· 옆).
    right.appendChild(this.bellButton("emu-deskbtn icon", 14));
    btn("···", i18n.t('더 보기'), (ev) => {
      const r = ev.currentTarget.getBoundingClientRect();
      import("./sidebar.js").then((m) => m.showPopupMenu(r.right - 180, r.bottom + 4, [
        { icon: icons.sliders({ size: 14 }), label: i18n.t('에이전트 PC 설정…'), onClick: () => import("./desktop-sheet.js").then((d) => d.openDesktopSheet()).catch(() => {}) },
      ])).catch(() => {});
    }, "icon");
    bar.appendChild(right);
    this.deskBarEl = bar;
    return bar;
  }

  /** 데스크톱 상태(멈춤·개입 대기)는 폰이나 cpt 가 바꿀 수 있다 — 탭이 보이는 동안 3초마다 확인해 바를 다시 그린다. */
  startDeskPoll() {
    this.stopDeskPoll();
    this._deskTimer = setInterval(() => void this.pollDesk(false), 3000);
    void this.pollDesk(false);
  }
  stopDeskPoll() { if (this._deskTimer) { clearInterval(this._deskTimer); this._deskTimer = null; } }
  /** 꺼져 있을 때 화면 한가운데 한 줄 — 켜는 단계(step)를 데몬이 알려 준다(첫 켜기는 설정+재시작이 붙어 1~2분). */
  deskOffText() {
    const st = this.deskStatus || {};
    if (st.phase !== "starting") return i18n.t('에이전트 PC 가 꺼져 있어요');
    if (st.step === "provision") return i18n.t('처음 켜는 거라 설정하는 중이에요 (1~2분)');
    if (st.step === "reboot" || st.step === "ax") return i18n.t('설정을 적용하려고 다시 켜는 중…');
    return i18n.t('켜는 중…');
  }
  async pollDesk(force) {
    if (this._disposedDesk) return;
    let st = null;
    try { st = await api.desktopStatus(); } catch (_) { return; }
    const prev = this.deskStatus;
    this.deskStatus = st;
    this.deskPaused = !!(st && st.paused);
    //  게스트 OS 를 알게 되면(또는 바뀌면) 탭 파비콘·이름을 그 OS 로 갱신한다(onDeviceChange → buildHead).
    if (setDesktopOs(st && st.osKind) && this.deviceId) this.onDeviceChange(this.deviceId, this.deviceName());
    const sig = (x) => x ? `${x.phase}|${x.step || ""}|${x.paused}|${x.handoff ? x.handoff.reason : ""}` : "";
    if (force || sig(prev) !== sig(st)) {
      const off = this.el.querySelector(".emu-off");
      if (off) off.textContent = this.deskOffText();
      //  바만 갈아 끼운다 — 화면(<img>)을 다시 만들면 프레임 루프가 끊긴다.
      const dev = this.device();
      const booted = st && st.phase === "running";
      const nb = this.buildDeskBar(dev, booted);
      if (this.deskBarEl && this.deskBarEl.parentNode) this.deskBarEl.parentNode.replaceChild(nb, this.deskBarEl);
      //  꺼졌다/켜졌다가 바뀌면 기기 목록도 새로 읽어 프레임 루프를 맞춘다.
      if (prev && (prev.phase === "running") !== booted) {
        //  켜졌으면 라이브 영상을 붙이고(폴링은 startVideo 가 실패할 때만), 꺼졌으면 영상을 접는다.
        if (!booted) this.stopVideo();
        this.loadDevices().then(() => { if (booted && !this.videoOn && !this.disposed) void this.startVideo().then((ok) => { if (!ok) this.ensureLoop(); }); });
      }
    }
  }

  async capture(btn) {
    if (!this.deviceId || this._capturing) return;
    this._capturing = true;
    if (btn) btn.disabled = true;
    try {
      const dev = this.device();
      const r = await api.emulatorFrame(this.deviceId, { maxWidth: 1080, quality: 85 });
      if (!r || !r.base64) throw new Error(i18n.t('화면을 받지 못했어요'));
      const ext = r.mime === "image/png" ? "png" : (r.mime === "image/bmp" ? "bmp" : "jpg");
      const abs = await api.fsWriteB64(".codingpt/attachments/" + attachName("emu-", ext), r.base64);
      const text = i18n.t('[화면] ') + ((dev && dev.name) || this.deviceId);
      const where = insertAttachment({ text, line: text + " " + shq(abs) + " ", path: abs });
      if (!where) { void toast(i18n.t('터미널이 없어 파일만 저장했어요: ') + abs); return; }
      void toast(where === "chat" ? i18n.t('화면을 채팅에 첨부했어요') : i18n.t('화면을 터미널에 첨부했어요'));
    } catch (e) {
      this.err = e && e.message ? e.message : String(e);
      this.render();
    } finally {
      this._capturing = false;
      if (btn) btn.disabled = false;
    }
  }

  async power(action, target) {
    const id = (target && target.id) || this.deviceId;
    if (!id) return;
    let reply = null;
    try { reply = await api.emulatorPower(id, action); }
    catch (e) { this.err = e && e.message ? e.message : String(e); }
    if (action === "boot") {
      const avd = (reply && reply.avdName)
        || (target && target.avdName)
        || ((this.devices || []).find((d) => d.id === id) || {}).avdName
        || null;
      this.render();
      this.watchBoot(avd);
    }
    //  ★ 끄면 기기 목록으로 돌아간다(2026-08-06). 예전엔 '‹ 목록으로' 버튼이 그 자리를 대신했는데
    //   버튼을 뺐다 — 꺼진 기기 화면에 남아 있어 봐야 볼 것도 조작할 것도 없다.
    const dv = (this.devices || []).find((d) => d.id === id);
    if (action === "shutdown" && !this.disposed && !(dv && dv.kind === "desktop")) { this.select(null); return; }
    if (!this.disposed) void this.loadDevices();
  }

  paintFrame() {
    if (this.imgEl && this.frameUrl) this.imgEl.src = this.frameUrl;
    if (this.errEl) this.errEl.textContent = "";
    //  폴링으로 떨어져도 회전은 유지돼야 한다 — 영상이 끊긴 순간 화면이 갑자기 옆으로 눕지 않게.
    if (this.visualRot) this.applyVisualRot();
  }

  //  오류는 화면 아래 줄이 아니라 알림함/토스트로 알린다(2026-09-21). 전체 render 없이 오버레이만 갱신해
  //   스트리밍 중 깜빡임을 피한다 — 종 뱃지는 다음 폴링 render 에서 따라온다.
  paintError() {
    this.pushNotice("err", this.err || "", "error");
    if (!this.el) return;
    this.el.querySelectorAll(".emu-toast, .emu-notif-ov").forEach((n) => n.remove());
    this.renderNoticeOverlays();
  }

  //  한 소스(영상/입력/오류/개입)의 사유가 새로 뜨거나 문구가 바뀔 때만 알림 1건. 사유가 사라지면 로그엔 안 남긴다.
  //   render() 안에서 매번 불려도 dedup(lastBySrc) 이라 새 문구일 때만 쌓인다 — 여기서 render() 를 부르지 않는다(재귀 방지).
  pushNotice(src, text, kind) {
    const t = String(text || "");
    if (this.lastBySrc[src] === t) return;
    this.lastBySrc[src] = t;
    if (!t) return;
    const n = { id: (this.noticeSeq += 1), text: t, kind: kind || "info", at: Date.now() };
    this.notices.unshift(n);
    if (this.notices.length > 40) this.notices.length = 40;
    this.toast = { id: n.id, text: n.text, kind: n.kind };
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = null; this._toastTimer = null; this.render(); }, 3600);
  }

  //  화면 아래 줄에 있던 4종 사유를 알림함으로 흘린다. render() 초입에서 부른다.
  feedNotices(dev, booted, canInput) {
    this.pushNotice("video", this.videoNote || "", "info");
    this.pushNotice("err", this.err || "", "error");
    const stx = this.deskStatus || (dev && dev.desktop) || {};
    const handoff = (dev && dev.kind === "desktop" && booted) ? (stx.handoff || null) : null;
    this.pushNotice("handoff", handoff ? (handoff.reason || "") : "", "info");
    let inputWhy = "";
    if (!canInput && dev && dev.kind !== "desktop") {
      inputWhy = (dev.caps && dev.caps.inputHint)
        || (dev.state !== "booted"
          ? i18n.t('기기가 아직 켜지지 않았어요 — 다 뜨면 바로 조작할 수 있어요')
          : (this.capRetry || 0) < CAP_RETRY_MAX
            ? i18n.t('조작 준비를 기다리는 중이에요…')
            : i18n.t('이 기기는 조작을 지원하지 않아요 (보기 전용)'));
    }
    this.pushNotice("input", inputWhy, "info");
  }

  //  종 버튼 — 안 본 알림이 있으면 점(오류면 강조). 눌러 목록을 연다. cls 로 스트립용/상태바용 구분.
  bellButton(cls, size) {
    const b = document.createElement("button");
    b.className = cls + (this.noticeOpen ? " on" : "");
    b.title = i18n.t('알림');
    b.innerHTML = icons.bell({ size: size || 22 });
    const unseen = this.notices.filter((n) => n.id > this.seenId);
    if (unseen.length) {
      const dot = document.createElement("span");
      dot.className = "emu-bell-dot" + (unseen.some((n) => n.kind === "error") ? " err" : "");
      b.appendChild(dot);
    }
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.toast = null; if (this._toastTimer) { clearTimeout(this._toastTimer); this._toastTimer = null; }
      this.noticeOpen = !this.noticeOpen;
      if (this.noticeOpen) this.seenId = this.noticeSeq;
      this.render();
    });
    return b;
  }

  //  토스트 + 목록 오버레이 — pane 위에 겹친다(절대 배치라 화면 크기를 건드리지 않는다). render() 끝에서 부른다.
  renderNoticeOverlays() {
    if (this.toast) {
      const tw = document.createElement("div");
      tw.className = "emu-toast" + (this.toast.kind === "error" ? " err" : "");
      tw.textContent = this.toast.text;
      this.el.appendChild(tw);
    }
    if (!this.noticeOpen) return;
    const ov = document.createElement("div");
    ov.className = "emu-notif-ov";
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) { this.noticeOpen = false; this.render(); } });
    const panel = document.createElement("div");
    panel.className = "emu-notif";
    const head = document.createElement("div");
    head.className = "emu-notif-h";
    head.innerHTML = `<b>${i18n.t('알림')}</b>`;
    if (this.notices.length) {
      const clr = document.createElement("button");
      clr.className = "emu-notif-clear";
      clr.textContent = i18n.t('모두 지우기');
      clr.addEventListener("click", () => { this.notices = []; this.seenId = 0; this.lastBySrc = {}; this.render(); });
      head.appendChild(clr);
    }
    panel.appendChild(head);
    if (this.notices.length) {
      const listEl = document.createElement("div");
      listEl.className = "emu-notif-list";
      for (const n of this.notices) {
        const row = document.createElement("div");
        row.className = "emu-notif-row";
        row.innerHTML = `<span class="emu-notif-dot${n.kind === "error" ? " err" : ""}"></span>`
          + `<div class="emu-notif-tx"><div>${escapeHtml(n.text)}</div><i>${escapeHtml(new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</i></div>`;
        listEl.appendChild(row);
      }
      panel.appendChild(listEl);
    } else {
      const empty = document.createElement("div");
      empty.className = "emu-notif-empty";
      empty.textContent = i18n.t('알림이 없어요');
      panel.appendChild(empty);
    }
    ov.appendChild(panel);
    this.el.appendChild(ov);
  }

  render() {
    this.el.innerHTML = "";
    this.imgEl = null;
    this.canvasEl = null;
    this.errEl = null;

    // ── 기기 선택 ──
    if (!this.deviceId) {
      const wrap = document.createElement("div");
      wrap.className = "emu-pick";
      const noTools = this.tools && !this.tools.adb && !this.tools.simctl;
      wrap.innerHTML = `
        <div class="emu-pick-h">${i18n.t('모바일 화면')}</div>
        <div class="emu-pick-sub">${i18n.t('이 PC 에 붙어 있는 기기예요. 고르면 화면이 보이고, 눌러서 조작할 수 있어요.')}</div>`;
      const list = document.createElement("div");
      list.className = "emu-list";
      if (this.devices === null) {
        list.innerHTML = `<div class="emu-empty">${i18n.t('찾는 중…')}</div>`;
      } else if (!this.devices.length) {
        list.innerHTML = `<div class="emu-empty">${noTools
          ? i18n.t('안드로이드 SDK 도 Xcode 도 찾지 못했어요. PC 에 설치하면 여기 나타나요.')
          : i18n.t('켜져 있는 기기가 없어요.')}</div>`;
      } else {
        for (const d of this.devices) {
          const booting = !!this.bootingAvd && d.avdName === this.bootingAvd;
          const row = document.createElement("button");
          row.className = "emu-row" + (d.state === "booted" ? " on" : "");
          const sub = (booting ? i18n.t('켜는 중…') : d.state === "booted" ? i18n.t('켜짐') : i18n.t('꺼짐'))
            + (d.caps && d.caps.frame && !d.caps.input ? ` · ${i18n.t('보기 전용')}` : "");
          row.innerHTML = `${(d.kind === "desktop" ? icons.monitor : icons.smartphone)({ size: 15 })}<span class="emu-row-t"><b></b><i></i></span>`;
          row.querySelector("b").textContent = d.name;
          row.querySelector("i").textContent = sub;
          //  꺼진 기기는 목록에서 바로 켠다 — 예전엔 골라 들어가야 전원 버튼이 보였는데, 꺼진 기기를
          //   고르면 화면이 없어서 "고를 이유가 없는 것을 골라야" 하는 흐름이었다.
          if (d.state !== "booted" && !d.physical && !booting) {
            const pw = document.createElement("span");
            pw.className = "emu-row-pw";
            pw.title = i18n.t('켜기');
            pw.innerHTML = icons.play({ size: 14 });
            pw.addEventListener("click", (ev) => { ev.stopPropagation(); void this.power("boot", d); });
            row.appendChild(pw);
          }
          row.addEventListener("click", () => { if (d.state === "booted") this.select(d.id); else void this.power("boot", d); });
          list.appendChild(row);
        }
      }
      wrap.appendChild(list);
      const again = document.createElement("button");
      again.className = "emu-again";
      again.innerHTML = `${icons.refresh({ size: 13 })}<span>${i18n.t('다시 찾기')}</span>`;
      again.addEventListener("click", () => this.loadDevices());
      wrap.appendChild(again);
      const e = document.createElement("div");
      e.className = "emu-err";
      e.textContent = this.err || "";
      wrap.appendChild(e);
      this.el.appendChild(wrap);
      return;
    }

    // ── 화면 ──
    const dev = this.device();
    const booted = dev ? dev.state === "booted" : false;
    const canInput = !!(dev && dev.caps && dev.caps.input);
    //  화면 아래 안내줄 대신 알림함으로 흘린다(사용자 지시 2026-09-21 — 화면이 깎이는 게 싫다).
    this.feedNotices(dev, booted, canInput);

    /**
     * ★ 조작 버튼은 **화면 옆의 남는 자리**에 세운다(2026-08-06 사용자 확정).
     *
     *  기기 화면은 늘 액자(pane)와 비율이 달라서 한쪽에 여백이 생긴다 — 세로 기기면 좌우가,
     *  가로 기기면 위아래가 남는다. 예전처럼 탭바 아래에 **줄을 하나 더 두면** 그 줄만큼
     *  화면이 통째로 줄어드는데, 정작 옆의 빈 자리는 그대로 비어 있었다.
     *  그래서 버튼을 그 빈 자리로 옮긴다: 세로면 오른쪽 세로줄, 가로면 아래 가로줄.
     *  덤으로 버튼을 크게 키울 수 있다(같은 자리에 더 큰 과녁).
     */
    const keys = document.createElement("div");
    keys.className = "emu-keys";
    //  알림 종 — 화면 아래 안내줄 대신 여기로 모은다(안 본 게 있으면 점). 폰 스트립 맨 앞.
    keys.appendChild(this.bellButton("emu-key", 22));
    const bsep = document.createElement("span");
    bsep.className = "emu-keys-sep";
    keys.appendChild(bsep);
    /**
     * ★ 캡처 — 지금 이 화면을 **에이전트에게 건네는** 버튼(2026-08-06 사용자 요구).
     *  기기 조작 키가 아니라 **우리 기능**이라 `caps.keys` 와 무관하게 그린다. 조건은 하나:
     *  화면을 받을 수 있는가(`caps.frame`). 조작이 안 되는 보기 전용 기기도 캡처는 뜻이 있다.
     *  넣을 곳(TUI 한 줄 / 채팅 칩)은 attach-insert 가 정한다 — 프리뷰 요소 캡처와 같은 길.
     */
    if (dev && dev.caps && dev.caps.frame) {
      const cap = document.createElement("button");
      cap.className = "emu-key";
      cap.title = i18n.t('이 화면을 캡처해 에이전트에게 첨부');
      cap.innerHTML = icons.camera({ size: 22 });
      cap.addEventListener("click", () => void this.capture(cap));
      keys.appendChild(cap);
      const s0 = document.createElement("span");
      s0.className = "emu-keys-sep";
      keys.appendChild(s0);
    }
    if (canInput) {
      const ios = dev && dev.kind === "ios";
      for (const k of this.keyRow(dev)) {
        const spec = EMU_KEYS[k];
        const b = document.createElement("button");
        b.className = "emu-key";
        b.innerHTML = icons[(ios && spec.iosIcon) || spec.icon]({ size: 22 });
        b.title = i18n.t(spec.title);
        b.addEventListener("click", () => (k === "rotate" ? this.rotate() : this.send({ type: "key", key: k })));
        keys.appendChild(b);
      }
    }
    /**
     * 에이전트 PC — **에이전트 멈춤/재개** 토글. 사용자가 이 화면을 만지는 동안 에이전트 입력이
     *  큐에 대기하고(데몬이 자동으로 켠다), 개입을 끝내면 이 버튼으로 풀어 준다. 되감기·재시작 같은
     *  파괴적 조작은 여기 두지 않는다(설정 시트로).
     */
    if (false && dev && dev.kind === "desktop" && booted) {
      const pz = document.createElement("button");
      pz.className = "emu-key" + (this.deskPaused ? " on" : "");
      pz.title = this.deskPaused ? i18n.t('에이전트 재개') : i18n.t('에이전트 멈춤');
      pz.innerHTML = icons[this.deskPaused ? "play" : "pause"]({ size: 22 });
      pz.addEventListener("click", async () => {
        try { await api.desktopPause(!this.deskPaused); this.deskPaused = !this.deskPaused; this.render(); }
        catch (e) { this.err = e && e.message ? e.message : String(e); this.paintError(); }
      });
      keys.appendChild(pz);
      const s1 = document.createElement("span");
      s1.className = "emu-keys-sep";
      keys.appendChild(s1);
    }
    //  에뮬레이터 자체를 끄는 전원 — 기기 조작 키와 하는 일이 다르니 구분선으로 나눈다.
    //  ★ '기기 목록으로'(‹) 버튼은 뺐다(2026-08-06 사용자 지시). 끄면 목록으로 돌아간다.
    const sep = document.createElement("span");
    sep.className = "emu-keys-sep";
    keys.appendChild(sep);
    const pw = document.createElement("button");
    pw.className = "emu-key";
    pw.title = booted ? i18n.t('에뮬레이터 끄기') : i18n.t('에뮬레이터 켜기');
    pw.innerHTML = icons.power({ size: 21 });
    pw.addEventListener("click", () => this.power(booted ? "shutdown" : "boot"));
    keys.appendChild(pw);

    const stage = document.createElement("div");
    stage.className = "emu-stage";
    //  라이브 영상이면 <canvas>, 폴링이면 <img>. 좌표 환산(ratioOf)은 둘 다 같은 규칙을 쓴다.
    if (this.videoOn) {
      const cv = document.createElement("canvas");
      cv.className = "emu-img";
      this.canvasEl = cv;
      stage.appendChild(cv);
    } else {
      const img = document.createElement("img");
      img.className = "emu-img";
      img.draggable = false;
      if (this.frameUrl) img.src = this.frameUrl;
      this.imgEl = img;
      stage.appendChild(img);
    }

    if (canInput) {
      /**
       * ★ 손가락을 **따라가는** 입력(2026-08-06). 예전엔 누를 때 아무것도 안 보내고, 뗀 뒤에
       *  `swipe(시작→끝)` 한 방을 보내 데몬이 직선으로 재생했다. 그러면 드래그하는 동안 화면이
       *  꿈쩍도 안 하고(사용자가 "미러링이 아니다" 라고 느끼는 지점), iOS 제스처 인식기는 그렇게
       *  몰아친 입력을 아예 무시하기도 한다.
       *  이제 누르는 순간부터 begin → move… → end 를 그대로 흘린다.
       *
       *  좌표는 절대값이라 중간 move 를 몇 개 흘려도 화면이 어긋나지 않는다 — 그래서 4px 미만은
       *  버리고, 앞 요청이 아직 안 끝났으면 그 프레임의 move 는 그냥 건너뛴다(큐를 쌓지 않는다).
       */
      let down = null;
      let inFlight = false;
      const stream = (phase, r) => {
        if (this.touchStreamOff) return false;
        if (phase === "move" && inFlight) return true;      // 밀린 것은 버린다(절대좌표라 안전)
        inFlight = true;
        this.send({ type: "touch", phase, x: r.x, y: r.y }).then((ok) => {
          inFlight = false;
          //  ★ **begin 이 실패했을 때만** 스트리밍을 끈다. 그 드래그는 어차피 통째로 못 살리고,
          //   구 데몬(=touch 를 모르는 데몬)이면 항상 여기서 걸린다. move/end 의 일시적 실패로
          //   꺼 버리면 되던 기능이 한 번의 딸꾹질로 영영 레거시가 된다.
          if (!ok && phase === "begin") this.touchStreamOff = true;
        });
        return true;
      };
      const finish = (ev) => {
        if (!down) return;
        const start = down; down = null;
        const end = this.ratioOf(ev) || { x: start.x, y: start.y };
        //  begin 이 (구 데몬이라) 실패했다면 이미 touchStreamOff 다 — 그 드래그도 레거시로 살린다.
        if (start.streamed && !this.touchStreamOff) { stream("end", end); return; }
        //  레거시(구 데몬): 누른 자리와 뗀 자리로 탭/스와이프/롱프레스를 가른다.
        const dist = Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy);
        if (dist > 18) {
          this.send({ type: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y, durationMs: Math.max(80, Math.min(800, Date.now() - start.t)) });
          return;
        }
        this.send({ type: Date.now() - start.t > 550 ? "longPress" : "tap", x: start.x, y: start.y });
      };
      stage.addEventListener("mousedown", (ev) => {
        const r = this.ratioOf(ev);
        if (!r) return;
        down = { ...r, t: Date.now(), cx: ev.clientX, cy: ev.clientY, streamed: stream("begin", r) };
      });
      stage.addEventListener("mousemove", (ev) => {
        if (!down || !down.streamed) return;
        if (Math.hypot(ev.clientX - down.cx, ev.clientY - down.cy) < 4) return;
        const r = this.ratioOf(ev);
        if (!r) return;
        down.cx = ev.clientX; down.cy = ev.clientY;
        stream("move", r);
      });
      stage.addEventListener("mouseup", finish);
      //  화면 밖으로 나가도 **뗀 것으로** 마무리한다 — 안 그러면 기기가 계속 눌린 줄 안다.
      stage.addEventListener("mouseleave", finish);
      /**
       * 에이전트 PC은 폰이 아니라 **맥 화면**이다 — 우클릭·휠·키보드가 있어야 쓸 수 있다.
       *  키는 xterm 처럼 pane 이 포커스를 가진 채 받는다(stage 가 tabindex 를 갖는다). 글자는 text 로,
       *  그 밖(Enter·화살표·⌘ 조합)은 key 조합 문자열로 보낸다 — 데몬 desktop.js 의 계약과 같다.
       */
      if (dev && dev.kind === "desktop") {
        stage.tabIndex = 0;
        stage.classList.add("emu-desktop");
        stage.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          const r = this.ratioOf(ev); if (!r) return;
          down = null;
          this.send({ type: "tap", button: "right", x: r.x, y: r.y });
        });
        let wheelAcc = 0, wheelTimer = null, wheelAt = null;
        stage.addEventListener("wheel", (ev) => {
          ev.preventDefault();
          const r = this.ratioOf(ev); if (!r) return;
          wheelAcc += ev.deltaY; wheelAt = r;
          if (wheelTimer) return;
          wheelTimer = setTimeout(() => {
            wheelTimer = null;
            const dy = Math.max(-30, Math.min(30, Math.round(wheelAcc / 40))) || (wheelAcc > 0 ? 1 : -1);
            wheelAcc = 0;
            this.send({ type: "scroll", x: wheelAt.x, y: wheelAt.y, dy });
          }, 60);
        }, { passive: false });
        stage.addEventListener("mousedown", () => stage.focus());
        const MOD = { Meta: "cmd", Control: "ctrl", Alt: "alt", Shift: "shift" };
        const NAMED = { Enter: "enter", Backspace: "backspace", Tab: "tab", Escape: "escape", Delete: "delete", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown", " ": "space" };
        stage.addEventListener("keydown", (ev) => {
          if (MOD[ev.key]) return;                                  // 수식키 단독은 조합에 실려 간다
          const hasMod = ev.metaKey || ev.ctrlKey || ev.altKey;
          const named = NAMED[ev.key] || (/^F\d{1,2}$/.test(ev.key) ? ev.key.toLowerCase() : null);
          if (!named && !hasMod && ev.key.length === 1) {           // 그냥 글자(대문자 포함) — IME 조합은 compositionend 로
            if (ev.isComposing) return;
            ev.preventDefault();
            this.send({ type: "text", text: ev.key });
            return;
          }
          const main = named || (ev.key.length === 1 ? ev.key.toLowerCase() : null);
          if (!main) return;
          ev.preventDefault();
          const mods = [ev.metaKey && "cmd", ev.ctrlKey && "ctrl", ev.altKey && "alt", ev.shiftKey && "shift"].filter(Boolean);
          this.send({ type: "key", key: [...mods, main].join("+") });
        });
        stage.addEventListener("compositionend", (ev) => { if (ev.data) this.send({ type: "text", text: ev.data }); });
      }
    } else if (dev && dev.kind === "desktop") {
      //  꺼진 에이전트 PC — 버튼 대신 한 줄(켜기는 상태 바의 전원 아이콘 하나뿐, 사용자 결정 2026-09-17).
      const off = document.createElement("div");
      off.className = "emu-off";
      off.textContent = this.deskOffText();
      stage.appendChild(off);
    } else if (!booted) {
      const b = document.createElement("button");
      b.className = "emu-boot";
      b.textContent = i18n.t('켜기');
      b.addEventListener("click", () => this.power("boot"));
      stage.appendChild(b);
    }

    //  화면 + 버튼 스트립. 어느 쪽에 붙일지는 **여백이 어디 생기는지**로 정한다(applyLayout).
    const wrap2 = document.createElement("div");
    wrap2.className = "emu-main";
    const isDesktop = !!(dev && dev.kind === "desktop");
    if (isDesktop) {
      //  에이전트 PC은 폰이 아니라 맥 화면 — 옆 스트립 대신 **얇은 상태 바**를 위에 둔다(목업 확정 2026-09-17):
      //   [● 실행 중 · 1440×900 · 에이전트 조작 중]   [에이전트 멈춤↔재개] [첨부] [계속] [···]
      this.el.append(this.buildDeskBar(dev, booted));
      wrap2.append(stage);
      this.keysEl = null;
      this.startDeskPoll();
    } else {
      wrap2.append(stage, keys);
      this.keysEl = keys;
      this.stopDeskPoll();
    }
    this.el.append(wrap2);
    this.mainEl = wrap2;
    //  render 는 <canvas>/<img> 를 새로 만든다 — 배치·표시 회전을 그 위에 다시 얹는다.
    setTimeout(() => this.applyLayout(), 0);
    //  창 크기가 바뀌면 남는 자리도 바뀐다 — 그때마다 다시 판정한다.
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* noop */ } }
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this.applyLayout());
      this._ro.observe(wrap2);
    }
    //  ★ 화면 아래 안내줄(영상 폴링 사유·조작 불가 사유·오류)은 없앴다(2026-09-21 사용자 지시 — 화면이 깎이는 게 싫다).
    //   전부 feedNotices 로 알림함에 흘렸고, 아래 오버레이(종 버튼 목록 + 토스트)가 pane 위에 겹쳐 보여 준다.
    this.errEl = null;
    this.renderNoticeOverlays();
  }
}
