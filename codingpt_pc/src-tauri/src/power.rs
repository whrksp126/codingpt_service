// power.rs — macOS 잠자기/깨어남 통지(automation-design §6.5).
//
// NSWorkspace 의 notificationCenter 에 NSWorkspaceWillSleepNotification / NSWorkspaceDidWakeNotification
//  옵저버를 건다 → 콜백마다 웹뷰에 `cpt-power {kind:'willSleep'|'didWake'}` 를 emit 한다.
//  JS(ui-channel.js wirePower)가 그걸 데몬 로컬 커맨드 `power.event` 로 넘긴다(데몬이 `pc_sleeping` 푸시 판단).
//
// 왜 앱(Tauri)인가: 데몬(Node)은 NSWorkspace 알림을 받을 수 없다(AppKit 런루프가 없다). 앱은 이미
//  메인 런루프를 돌고 있어 옵저버 한 줄이면 된다. macOS 가 willSleep 뒤 주는 시간은 수 초라 best effort 다
//  (결정적 안전망은 서버의 끊김 90초 푸시).
//
// 옵저버는 앱 수명 동안 산다(해제하지 않는다) — notificationCenter 가 블록을 복사해 보관한다.

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use core::ptr::NonNull;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
    use tauri::Emitter;

    let ws = NSWorkspace::sharedWorkspace();
    let nc = ws.notificationCenter();
    let pairs: [(&objc2_foundation::NSString, &'static str); 2] = unsafe {
        [(NSWorkspaceWillSleepNotification, "willSleep"), (NSWorkspaceDidWakeNotification, "didWake")]
    };
    for (name, kind) in pairs {
        let h = app.clone();
        let block = RcBlock::new(move |_note: NonNull<AnyObject>| {
            eprintln!("[power] {kind}");
            let _ = h.emit("cpt-power", serde_json::json!({ "kind": kind }));
        });
        // addObserverForName:object:queue:usingBlock: — queue nil = 게시한 스레드(메인)에서 동기 호출.
        //  반환 옵저버 토큰은 센터가 보관한다(우리는 해제하지 않는다 — 앱 수명 동안 유지).
        let _obs: *mut AnyObject = unsafe {
            msg_send![
                &*nc,
                addObserverForName: name,
                object: core::ptr::null::<AnyObject>(),
                queue: core::ptr::null::<AnyObject>(),
                usingBlock: &*block
            ]
        };
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}
