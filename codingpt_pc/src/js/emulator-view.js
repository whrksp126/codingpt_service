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
import * as i18n from "./i18n/index.js";

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

    this.el = document.createElement("div");
    this.el.className = "emu";
    this.host.appendChild(this.el);
    this.render();
    this.loadDevices();
  }

  dispose() {
    this.disposed = true;
    this.stopVideo();
    try { this.el.remove(); } catch (_) { /* noop */ }
  }

  /** 탭 전환 — 보이면 루프 재개, 가려지면 다음 장부터 멈춘다(받는 중이던 한 장은 그냥 버린다). */
  setVisible(on) {
    const next = !!on;
    if (next === this.visible) return;
    this.visible = next;
    if (next) {
      this.lastTouch = Date.now();
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
    if (!/^(android|ios):/.test(this.deviceId)) return false;
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
          if (!skip && queued === 0) cv.getContext('2d')?.drawImage(frame, 0, 0);   // 따라잡기·밀린 것은 안 그린다
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
        if (Date.now() - this.lastTouch > IDLE_AFTER_MS) {
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
    if (action === "shutdown" && !this.disposed) { this.select(null); return; }
    if (!this.disposed) void this.loadDevices();
  }

  paintFrame() {
    if (this.imgEl && this.frameUrl) this.imgEl.src = this.frameUrl;
    if (this.errEl) this.errEl.textContent = "";
    //  폴링으로 떨어져도 회전은 유지돼야 한다 — 영상이 끊긴 순간 화면이 갑자기 옆으로 눕지 않게.
    if (this.visualRot) this.applyVisualRot();
  }

  paintError() {
    if (this.errEl) this.errEl.textContent = this.err || "";
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
          row.innerHTML = `${icons.smartphone({ size: 15 })}<span class="emu-row-t"><b></b><i></i></span>`;
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
    wrap2.append(stage, keys);
    this.el.append(wrap2);
    this.mainEl = wrap2;
    this.keysEl = keys;
    //  render 는 <canvas>/<img> 를 새로 만든다 — 배치·표시 회전을 그 위에 다시 얹는다.
    setTimeout(() => this.applyLayout(), 0);
    //  창 크기가 바뀌면 남는 자리도 바뀐다 — 그때마다 다시 판정한다.
    if (this._ro) { try { this._ro.disconnect(); } catch (_) { /* noop */ } }
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(() => this.applyLayout());
      this._ro.observe(wrap2);
    }
    //  폴링으로 돌아갔으면 **왜** 인지 한 줄로 적는다(느린 이유를 사용자가 짐작하게 두지 않는다).
    if (this.videoNote) {
      const note = document.createElement("div");
      note.className = "emu-note";
      note.textContent = this.videoNote;
      this.el.appendChild(note);
    }

    if (!canInput && dev && dev.caps && dev.caps.inputHint) {
      const hint = document.createElement("div");
      hint.className = "emu-hint";
      hint.textContent = dev.caps.inputHint;
      this.el.appendChild(hint);
    }

    const e = document.createElement("div");
    e.className = "emu-err";
    e.textContent = this.err || "";
    this.errEl = e;
    this.el.appendChild(e);
  }
}
