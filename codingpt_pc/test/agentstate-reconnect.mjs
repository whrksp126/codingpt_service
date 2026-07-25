// agentstate-reconnect.mjs — 제어 WS(ui-channel) **재접속 시 에이전트 상태 폐기** 회귀 테스트.
//
// 왜 이 파일이 따로 있는가
//  · contract.mjs 는 state.js 의 순수 로직만 본다. 그런데 이 결함의 정체는 "state.js 에 폐기 함수가
//    없다"가 아니라 **ui-channel 이 재접속 시 그것을 부르지 않는다**는 배선 누락이었다 → 실제 소켓
//    수명주기(onopen)를 통과시키지 않으면 재발을 못 잡는다.
//  · back 의 라스트-스테이트 리플레이는 '삭제'를 표현할 수 없다: 끊긴 사이 에이전트가 끝나면 back 은
//    그 키를 캐시에서 지우므로 재접속 리플레이에 **아무 프레임도 오지 않는다**(daemonRelayService).
//    그래서 클라이언트가 먼저 비우지 않으면 끝난 에이전트가 유령으로 15분 남는다(계약 §1.5).
//  · WebSocket/Tauri IPC 는 스텁한다(앱을 띄우면 번들 사이드카 데몬이 사용자 데몬과 상호 kill 한다 —
//    리포 CLAUDE.md 경고). ui-channel 은 타이머를 남기므로 마지막에 process.exit 로 끝낸다.
const invokeCalls = [];
let invokeImpl = async (cmd) => {
  if (cmd === "ui_stream_url") return "ws://127.0.0.1:1/api/ui/stream?ticket=t";
  if (cmd === "daemon_status") return { paired: true, deviceId: 12, device_name: "PC" };
  return {};
};
const invoke = async (cmd, args) => { invokeCalls.push([cmd, args]); return invokeImpl(cmd, args); };

let lastSock = null;
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; this.sent = []; lastSock = this; }
  send(s) { this.sent.push({ frame: JSON.parse(s), storeSize: STORE_SIZE() }); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}
globalThis.WebSocket = FakeWS;

globalThis.window = {
  __TAURI__: { core: { invoke }, event: { listen: async () => () => {} } },
  addEventListener() {}, removeEventListener() {},
  location: { href: "http://localhost/" },
  innerWidth: 1440,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  FitAddon: { FitAddon: class { activate() {} fit() {} } },
  Terminal: class { open() {} write() {} onData() {} loadAddon() {} dispose() {} },
  WebLinksAddon: { WebLinksAddon: class {} },
  SearchAddon: { SearchAddon: class {} },
};
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.document = {
  hidden: false, addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} },
  body: { classList: { add() {}, remove() {} }, appendChild() {} },
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {} }),
};

const base = process.argv[2] || new URL("../src/js", import.meta.url).href;
const S = await import(`${base}/state.js`);
const STORE_SIZE = () => S.agentStates.size;
const uich = await import(`${base}/ui-channel.js`);

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// 끊기기 전에 받아 둔 push — 그 사이 claude 가 끝나 back 은 이 키를 캐시에서 지웠다(리플레이 0건).
S.setAgentState({
  cwd: "other/project/codingpt", win: 1000123, state: "working", agent: "claude",
  version: 42, at: Date.now(), hostDeviceId: 12, kind: "local",
});
eq("사전 조건: push 보유", S.agentStateOf("other/project/codingpt", 1000123)?.state, "working");

uich.startUiChannel();
await tick();
eq("WS 접속 시도", !!lastSock, true);
lastSock.onopen();
await tick();

eq("재접속(onopen) → 보유 push 전량 폐기", S.agentStateOf("other/project/codingpt", 1000123), null);
const hello = lastSock.sent.find((x) => x.frame && x.frame.type === "ui_hello");
eq("ui_hello 발신", !!hello, true);
// ★ 순서: 폐기가 ui_hello 보다 **먼저** 여야 한다. 뒤면 back 리플레이가 복원한 프레임을 우리가 지운다.
eq("폐기 → ui_hello 순서", hello ? hello.storeSize : -1, 0);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS");
process.exit(fail ? 1 : 0);
