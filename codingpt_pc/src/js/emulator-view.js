// emulator-view — PC 의 "모바일 화면" pane. 이 PC 에 붙어 있는 안드로이드 에뮬레이터/실기기와
//  iOS 시뮬레이터의 화면을 그리고, 클릭·드래그를 그대로 기기에 보낸다.
//
// ⚠ 앱(codingpt_app/src/workspace/EmulatorBody.tsx)에 같은 규율의 화면이 있다. 규칙 두 가지는
//   반드시 같아야 한다:
//   ① 프레임은 **당겨** 온다(한 장 받고 다음 장 요청). 밀면 느린 회선에서 지연이 눈덩이가 된다.
//   ② 좌표는 **0~1 비율**로 보낸다. 픽셀은 기기만 안다 — 여기서 환산하면 배율·회전에 어긋난다.
//
// 프리뷰와 달리 네이티브 웹뷰를 안 쓴다(그냥 <img> 다) — 겹침·좌표 보정 문제가 통째로 없다.
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

export class EmulatorView {
  /**
   * @param {HTMLElement} host  본문 컨테이너
   * @param {{ deviceId: string|null, onDeviceChange: (id: string|null) => void }} opts
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

    this.el = document.createElement("div");
    this.el.className = "emu";
    this.host.appendChild(this.el);
    this.render();
    this.loadDevices();
  }

  dispose() {
    this.disposed = true;
    try { this.el.remove(); } catch (_) { /* noop */ }
  }

  /** 탭 전환 — 보이면 루프 재개, 가려지면 다음 장부터 멈춘다(받는 중이던 한 장은 그냥 버린다). */
  setVisible(on) {
    const next = !!on;
    if (next === this.visible) return;
    this.visible = next;
    if (next) { this.lastTouch = Date.now(); this.ensureLoop(); }
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

  select(id) {
    this.deviceId = id;
    this.frameUrl = null;
    this.frameAspect = null;
    this.lastTouch = Date.now();
    this.onDeviceChange(id);
    this.render();
    this.ensureLoop();
  }

  /** 프레임 루프 — **한 장을 받고 나서** 다음 장을 요청한다(겹쳐 쏘지 않는다). */
  ensureLoop() {
    if (this.running || !this.deviceId || this.disposed || !this.visible) return;
    this.running = true;
    (async () => {
      while (!this.disposed && this.deviceId && this.visible) {
        if (Date.now() - this.lastTouch > IDLE_AFTER_MS) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const t0 = Date.now();
        try {
          const f = await api.emulatorFrame(this.deviceId, { maxWidth: 480, quality: 60 });
          if (this.disposed) break;
          this.frameUrl = `data:${f.mime};base64,${f.base64}`;
          if (f.width && f.height) this.frameAspect = f.width / f.height;
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

  /** 화면 좌표 → 0~1. `object-fit: contain` 의 **여백을 빼고** 계산한다. */
  ratioOf(ev) {
    const img = this.imgEl;
    if (!img) return null;
    const r = img.getBoundingClientRect();
    const ar = this.frameAspect;
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
    return { x, y };
  }

  async send(body) {
    if (!this.deviceId) return;
    this.lastTouch = Date.now();
    try { await api.emulatorInput({ id: this.deviceId, ...body }); this.err = null; }
    catch (e) { this.err = e && e.message ? e.message : String(e); this.paintError(); }
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
    if (!this.disposed) void this.loadDevices();
  }

  paintFrame() {
    if (this.imgEl && this.frameUrl) this.imgEl.src = this.frameUrl;
    if (this.errEl) this.errEl.textContent = "";
  }

  paintError() {
    if (this.errEl) this.errEl.textContent = this.err || "";
  }

  render() {
    this.el.innerHTML = "";
    this.imgEl = null;
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

    const bar = document.createElement("div");
    bar.className = "emu-bar";
    const back = document.createElement("button");
    back.className = "emu-bar-name";
    back.innerHTML = `${icons.smartphone({ size: 13 })}<span></span>`;
    back.querySelector("span").textContent = dev ? dev.name : this.deviceId;
    back.title = i18n.t('기기 목록으로');
    back.addEventListener("click", () => this.select(null));
    const pw = document.createElement("button");
    pw.className = "emu-bar-btn";
    pw.title = booted ? i18n.t('끄기') : i18n.t('켜기');
    pw.textContent = booted ? "⏻" : "⏵";
    pw.addEventListener("click", () => this.power(booted ? "shutdown" : "boot"));
    bar.append(back, pw);

    const stage = document.createElement("div");
    stage.className = "emu-stage";
    const img = document.createElement("img");
    img.className = "emu-img";
    img.draggable = false;
    if (this.frameUrl) img.src = this.frameUrl;
    this.imgEl = img;
    stage.appendChild(img);

    if (canInput) {
      // 누른 자리와 뗀 자리로 탭/스와이프/롱프레스를 가른다(앱과 같은 판정).
      let down = null;
      stage.addEventListener("mousedown", (ev) => {
        const r = this.ratioOf(ev);
        if (!r) return;
        down = { ...r, t: Date.now(), cx: ev.clientX, cy: ev.clientY };
      });
      stage.addEventListener("mouseup", (ev) => {
        if (!down) return;
        const start = down; down = null;
        const dist = Math.hypot(ev.clientX - start.cx, ev.clientY - start.cy);
        if (dist > 18) {
          const b = this.ratioOf(ev);
          if (b) this.send({ type: "swipe", x: start.x, y: start.y, x2: b.x, y2: b.y, durationMs: Math.max(80, Math.min(800, Date.now() - start.t)) });
          return;
        }
        this.send({ type: Date.now() - start.t > 550 ? "longPress" : "tap", x: start.x, y: start.y });
      });
      stage.addEventListener("mouseleave", () => { down = null; });
    } else if (!booted) {
      const b = document.createElement("button");
      b.className = "emu-boot";
      b.textContent = i18n.t('켜기');
      b.addEventListener("click", () => this.power("boot"));
      stage.appendChild(b);
    }

    this.el.append(bar, stage);

    if (canInput) {
      const keys = document.createElement("div");
      keys.className = "emu-keys";
      for (const [label, key, title] of [["▢", "recents", i18n.t('최근 앱')], ["○", "home", i18n.t('홈')], ["◁", "back", i18n.t('뒤로')]]) {
        const b = document.createElement("button");
        b.className = "emu-key";
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", () => this.send({ type: "key", key }));
        keys.appendChild(b);
      }
      this.el.appendChild(keys);
    } else if (dev && dev.caps && dev.caps.inputHint) {
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
