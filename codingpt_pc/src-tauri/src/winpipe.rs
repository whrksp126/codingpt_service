// winpipe — win32 named pipe 클라이언트(겹침 I/O). 윈도우 포팅 계약 2 의 Rust 측 하부 구현.
//
// ── 왜 std::fs::File 로는 안 되는가 (2026-08-12 실기 실측으로 확정) ──────────────
//  `OpenOptions::new().read(true).write(true).open(r"\\.\pipe\...")` 로 연 핸들은
//  **동기(non-overlapped) 핸들**이다. Windows 는 동기 핸들의 I/O 를 **파일 오브젝트 단위로
//  직렬화**하므로, 한 스레드가 다음 줄을 기다리며 ReadFile 에 블로킹해 있으면 **같은 핸들
//  (try_clone 으로 복제한 것 포함)에 대한 WriteFile 이 통째로 막힌다.**
//
//  유닉스 도메인 소켓에는 이 제약이 없어(읽기/쓰기 독립) mac 경로에서는 절대 드러나지 않는다.
//  그래서 duplex 채널(cpt UI 채널)을 mac 과 같은 모양으로 옮기면 win32 에서만 죽는다:
//    · ui_local_loop(별도 스레드) = 명령을 기다리는 영구 블로킹 read
//    · ui_local_send(#[tauri::command], 동기 → **메인 스레드**) = write
//    → 앱 기동 2~4 초 만에 메인 스레드가 write 에서 영구 블록 = UI 전체 정지(고스트 창).
//  실측 로그: `[진단] ui_local_send 쓰기 진입 tid=ThreadId(1)` 이후 반환 없음.
//
// ── 해법 ────────────────────────────────────────────────────────────────────
//  FILE_FLAG_OVERLAPPED 로 열고 모든 연산에 **연산별 OVERLAPPED + 전용 이벤트**를 쓴다.
//  겹침 핸들은 파일 오브젝트 직렬화 대상이 아니므로 읽기와 쓰기가 동시에 진행된다.
//  덤으로 읽기 타임아웃이 생긴다(동기 파일 핸들에는 타임아웃 API 자체가 없어
//  cpt_request_timed 의 timeout_secs 가 win32 에서 그냥 버려지고 있었다 — 같이 해소).
//
//  ★ 이 파일의 규율: 핸들은 Arc 로 공유하되 OVERLAPPED/이벤트는 **절대 공유하지 않는다**.
//    하나의 OVERLAPPED 를 두 연산이 쓰면 완료 통지가 섞여 조용히 오동작한다.

#![cfg(windows)]

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use windows::core::{Free, HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_IO_PENDING, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, OPEN_EXISTING,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

// 핸들 소유권 래퍼 — Drop 에서 한 번만 닫는다. Arc 로 감싸 clone 간 공유한다.
struct OwnedHandle(HANDLE);

// SAFETY: 파이프 핸들은 커널 오브젝트로 스레드 친화적이다. 겹침 I/O 라 동시 접근도 안전하다
//  (연산별 OVERLAPPED/이벤트를 쓰므로 커널이 각 연산을 독립적으로 완료 처리한다).
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe { let _ = CloseHandle(self.0); }
        }
    }
}

/// 연산 1회짜리 이벤트 + OVERLAPPED 묶음. 스택에 만들어 쓰고 즉시 버린다(공유 금지).
struct Op {
    ov: Box<OVERLAPPED>,
    event: HANDLE,
}

impl Op {
    fn new() -> io::Result<Self> {
        // manual_reset=true, initial=false, 무명 이벤트.
        let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map_err(|e| io::Error::other(format!("이벤트 생성 실패: {e}")))?;
        let mut ov = Box::new(OVERLAPPED::default());
        ov.hEvent = event;
        Ok(Self { ov, event })
    }
}

impl Drop for Op {
    fn drop(&mut self) {
        if !self.event.is_invalid() {
            unsafe { let mut h = self.event; h.free(); }
        }
    }
}

#[derive(Clone)]
pub struct PipeClient {
    handle: Arc<OwnedHandle>,
    /// 읽기 타임아웃(ms). 0 = 무한. 쓰기는 항상 무한(파이프 쓰기는 상대가 읽으면 곧 끝난다).
    read_timeout_ms: Arc<AtomicU64>,
}

impl PipeClient {
    /// 파이프 접속. 서버가 다음 인스턴스를 아직 안 걸어 둔 찰나는 ERROR_PIPE_BUSY(231) → 짧게 재시도.
    pub fn connect(path: &str) -> io::Result<Self> {
        let wide = HSTRING::from(path);
        let mut last: Option<io::Error> = None;
        for _ in 0..20 {
            let h = unsafe {
                CreateFileW(
                    PCWSTR(wide.as_ptr()),
                    (GENERIC_READ.0 | GENERIC_WRITE.0) as u32,
                    FILE_SHARE_MODE(0),
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    None,
                )
            };
            match h {
                Ok(h) if !h.is_invalid() => {
                    return Ok(Self {
                        handle: Arc::new(OwnedHandle(h)),
                        read_timeout_ms: Arc::new(AtomicU64::new(0)),
                    })
                }
                Ok(_) => last = Some(io::Error::other("파이프 핸들이 유효하지 않습니다.")),
                Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() => {
                    std::thread::sleep(Duration::from_millis(50));
                    last = Some(io::Error::other(format!("파이프 사용 중: {e}")));
                    continue;
                }
                Err(e) => return Err(io::Error::from_raw_os_error(e.code().0 & 0xFFFF)),
            }
        }
        Err(last.unwrap_or_else(|| io::Error::other("파이프 접속 실패")))
    }

    /// 읽기 타임아웃. None = 무한(UI 채널처럼 "명령이 언제 올지 모르는" 스트림용).
    pub fn set_read_timeout(&self, d: Option<Duration>) {
        let ms = d.map(|d| d.as_millis().min(u64::MAX as u128) as u64).unwrap_or(0);
        self.read_timeout_ms.store(ms, Ordering::Relaxed);
    }

    /// 같은 파이프를 가리키는 또 하나의 핸들 뷰. 겹침 I/O 라 원본과 **동시에** 읽고 쓸 수 있다
    /// (이것이 std::fs::File::try_clone 과 결정적으로 다른 점).
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(self.clone())
    }

    fn raw(&self) -> HANDLE {
        self.handle.0
    }

    /// 겹침 연산 완료 대기. timeout_ms=0 이면 무한.
    fn wait(&self, op: &Op, timeout_ms: u64) -> io::Result<u32> {
        let wait_ms = if timeout_ms == 0 { u32::MAX } else { timeout_ms.min(u32::MAX as u64) as u32 };
        let w = unsafe { WaitForSingleObject(op.event, wait_ms) };
        if w == WAIT_TIMEOUT {
            // 타임아웃 → 그대로 두면 커널이 우리 버퍼에 계속 쓸 수 있으므로 반드시 취소하고
            //  완료를 회수해야 한다(취소 완료를 안 기다리면 use-after-free 위험).
            unsafe {
                let _ = CancelIoEx(self.raw(), Some(&*op.ov));
                let mut n = 0u32;
                let _ = GetOverlappedResult(self.raw(), &*op.ov, &mut n, true);
            }
            return Err(io::Error::new(io::ErrorKind::TimedOut, "파이프 응답 시간 초과"));
        }
        if w != WAIT_OBJECT_0 {
            return Err(io::Error::other(format!("파이프 대기 실패(WaitForSingleObject={w:?})")));
        }
        let mut n = 0u32;
        unsafe { GetOverlappedResult(self.raw(), &*op.ov, &mut n, false) }
            .map_err(|e| io::Error::from_raw_os_error(e.code().0 & 0xFFFF))?;
        Ok(n)
    }
}

impl Read for PipeClient {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        (&*self).read(buf)
    }
}

// &PipeClient 로도 읽을 수 있어야 BufReader 가 clone 없이 참조를 물 수 있다.
impl Read for &PipeClient {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut op = Op::new()?;
        let mut read_now = 0u32;
        let r = unsafe { ReadFile(self.raw(), Some(buf), Some(&mut read_now), Some(&mut *op.ov)) };
        match r {
            Ok(()) => Ok(read_now as usize),
            Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {
                let n = self.wait(&op, self.read_timeout_ms.load(Ordering::Relaxed))?;
                Ok(n as usize)
            }
            // 상대가 닫음 = EOF(에러 아님). BufRead::lines 가 정상 종료하도록 0 을 돌려준다.
            Err(e) if is_pipe_closed(&e) => Ok(0),
            Err(e) => Err(io::Error::from_raw_os_error(e.code().0 & 0xFFFF)),
        }
    }
}

impl Write for PipeClient {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        (&*self).write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Write for &PipeClient {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let mut op = Op::new()?;
        let mut wrote = 0u32;
        let r = unsafe { WriteFile(self.raw(), Some(buf), Some(&mut wrote), Some(&mut *op.ov)) };
        match r {
            Ok(()) => Ok(wrote as usize),
            Err(e) if e.code() == ERROR_IO_PENDING.to_hresult() => {
                // 쓰기는 타임아웃을 두지 않는다 — 상대가 읽기만 하면 즉시 완료된다.
                let n = self.wait(&op, 0)?;
                Ok(n as usize)
            }
            Err(e) => Err(io::Error::from_raw_os_error(e.code().0 & 0xFFFF)),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// ERROR_BROKEN_PIPE(109) / ERROR_PIPE_NOT_CONNECTED(233) / ERROR_NO_DATA(232) = 상대가 닫음.
fn is_pipe_closed(e: &windows::core::Error) -> bool {
    matches!(e.code().0 & 0xFFFF, 109 | 232 | 233)
}
