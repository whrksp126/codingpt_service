'use strict';

/**
 * canonical VT 모델을 기존 attach handle 계약으로 연결한다.
 * subscribe를 snapshot보다 먼저 걸고 snapshot.seq 이하를 버려, snapshot과 live output 사이의
 * 유실·중복을 동시에 막는다.
 */
async function openCanonicalStream(registry, name, o = {}) {
  const model = registry.get(name, { cols: o.cols, rows: o.rows, cwd: o.cwd });
  const pending = [];
  let live = false;
  let closed = false;
  const deliver = (frame) => {
    if (closed) return;
    if (!live) { pending.push(frame); return; }
    if (frame.type === 'output') o.onOutput && o.onOutput(frame);
    else if (frame.type === 'exit') o.onExit && o.onExit(frame.code);
  };
  const unsubscribe = model.subscribe(deliver);
  try {
    const snapshot = await model.snapshot();
    if (closed) throw new Error('canonical stream closed during snapshot');
    if (o.onSnapshot) await o.onSnapshot(snapshot);
    live = true;
    for (const frame of pending.splice(0)) {
      if (frame.seq > snapshot.seq) deliver(frame);
    }
  } catch (e) {
    unsubscribe();
    throw e;
  }
  return {
    model,
    write(data) { return model.write(data); },
    resize(cols, rows) { return model.resize(cols, rows); },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
}

module.exports = { openCanonicalStream };
