use std::{
    cell::Cell,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use dispatch2::DispatchQueue;
use objc2::{
    ffi::{class_addMethod, object_getClass},
    rc::Retained,
    runtime::{AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    sync::oneshot,
    time::{sleep, timeout_at, Instant},
};

use crate::CommandResult;

const EXIT_REQUESTED: &str = "iron-go-exit-requested";
const EXIT_EXPIRED: &str = "iron-go-exit-expired";
static APP: OnceLock<AppHandle> = OnceLock::new();
thread_local! { static APPROVED_RETRY: Cell<bool> = const { Cell::new(false) }; }

fn queue_on_main(work: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(work);
}

#[derive(Default)]
pub struct ExitGate(Mutex<Ticket>);

#[derive(Default)]
struct Ticket {
    sequence: u64,
    pending: Option<u64>,
}

impl Ticket {
    fn begin(&mut self) -> Option<u64> {
        if self.pending.is_some() {
            return None;
        }
        self.sequence += 1;
        self.pending = Some(self.sequence);
        self.pending
    }

    fn take(&mut self, ticket: u64) -> bool {
        if self.pending != Some(ticket) {
            return false;
        }
        self.pending = None;
        true
    }
}

pub fn install(app: &AppHandle) -> CommandResult<()> {
    let mtm = MainThreadMarker::new().ok_or("Install the AppKit quit guard on the main thread.")?;
    let native = NSApplication::sharedApplication(mtm);
    let delegate = native
        .delegate()
        .ok_or("The macOS application has no delegate.")?;
    // SAFETY: this is a retained Objective-C object, so its class is valid.
    let class = unsafe { object_getClass(Retained::as_ptr(&delegate).cast()) };
    let selector = sel!(applicationShouldTerminate:);
    let class_ref =
        unsafe { class.as_ref() }.ok_or("The macOS application delegate has no class.")?;
    if class_ref.instance_method(selector).is_some() {
        return Err("The macOS runtime already handles applicationShouldTerminate:; review quit integration.".into());
    }
    APP.set(app.clone())
        .map_err(|_| "The macOS quit guard is already installed.")?;
    type ShouldTerminate = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize;
    let method: ShouldTerminate = should_terminate;
    // SAFETY: AppKit expects NSUInteger (self, SEL, NSApplication*) for
    // this selector. Both supported macOS architectures are 64-bit. Add
    // only the missing selector; never replace any existing method.
    let added = unsafe {
        class_addMethod(
            class.cast_mut(),
            selector,
            std::mem::transmute::<ShouldTerminate, Imp>(method),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err("Unable to install the AppKit quit guard.".into());
    }
    // AppKit caches delegate capabilities on assignment. Re-register the
    // same retained Tao delegate, including all of its original methods.
    native.setDelegate(None);
    native.setDelegate(Some(&delegate));
    Ok(())
}

extern "C-unwind" fn should_terminate(_: *mut AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    if APPROVED_RETRY.with(|permit| permit.replace(false)) {
        return NSApplicationTerminateReply::TerminateNow.0;
    }
    let Some(app) = APP.get() else {
        return NSApplicationTerminateReply::TerminateCancel.0;
    };
    if app.get_webview_window("main").is_none() {
        return NSApplicationTerminateReply::TerminateNow.0;
    }
    let Ok(mut gate) = app.state::<ExitGate>().inner().0.lock() else {
        return NSApplicationTerminateReply::TerminateCancel.0;
    };
    let Some(ticket) = gate.begin() else {
        return NSApplicationTerminateReply::TerminateCancel.0;
    };
    drop(gate);
    // Cancel now so the WebView can display the app-owned dialog in the
    // normal run loop. Keep UI delivery out of this AppKit callback.
    queue_on_main(move || {
        if app.emit_to("main", EXIT_REQUESTED, ticket).is_err() {
            take(app, ticket);
            return;
        }
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(decision_timeout()).await;
            queue_on_main(move || {
                if take(app, ticket) {
                    let _ = app.emit_to("main", EXIT_EXPIRED, ticket);
                }
            });
        });
    });
    NSApplicationTerminateReply::TerminateCancel.0
}

fn decision_timeout() -> Duration {
    #[cfg(feature = "e2e")]
    if let Some(ms) = std::env::var("IRON_GO_E2E_EXIT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_millis(ms);
    }
    Duration::from_secs(60)
}

fn take(app: &AppHandle, ticket: u64) -> bool {
    app.state::<ExitGate>()
        .0
        .lock()
        .is_ok_and(|mut gate| gate.take(ticket))
}

pub fn request_termination() {
    queue_on_main(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).terminate(None);
        }
    });
}

async fn wait_for_presentation<F>(
    deadline: Instant,
    mut sample: impl FnMut(bool) -> F,
) -> CommandResult<bool>
where
    F: std::future::Future<Output = CommandResult<Option<bool>>>,
{
    let mut restore = true;
    while Instant::now() < deadline {
        match timeout_at(deadline, sample(restore)).await {
            Ok(Ok(Some(true))) if Instant::now() < deadline => return Ok(true),
            Ok(Ok(Some(false))) => {
                restore = false;
                sleep(Duration::from_millis(25)).await;
            }
            Ok(Err(error)) => return Err(error),
            _ => break,
        }
    }
    Ok(false)
}

async fn sample_presentation(
    app: AppHandle,
    ticket: u64,
    deadline: Instant,
    restore: bool,
) -> CommandResult<Option<bool>> {
    let (send, receive) = oneshot::channel();
    queue_on_main(move || {
        let current = || {
            Instant::now() < deadline
                && app
                    .state::<ExitGate>()
                    .0
                    .lock()
                    .is_ok_and(|gate| gate.pending == Some(ticket))
        };
        let result = (|| {
            if !current() {
                return Ok(None);
            }
            let mtm =
                MainThreadMarker::new().ok_or("Present the Quit dialog on the main thread.")?;
            let ready = with_main_window(&app, |window| {
                let native = NSApplication::sharedApplication(mtm);
                if restore {
                    if native.isHidden() {
                        native.unhide(None);
                    }
                    if window.isMiniaturized() {
                        window.deminiaturize(None);
                    }
                    native.activate();
                    window.makeKeyAndOrderFront(None);
                    // Activation is cooperative; the window can still be shown.
                    if !native.isActive() {
                        window.orderFrontRegardless();
                    }
                }
                !native.isHidden() && !window.isMiniaturized() && window.isVisible()
            })?;
            Ok(current().then_some(ready))
        })();
        let _ = send.send(result);
    });
    receive.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn present_app_exit(app: AppHandle, ticket: u64) -> CommandResult<bool> {
    let deadline = Instant::now() + Duration::from_secs(2);
    wait_for_presentation(deadline, |restore| {
        sample_presentation(app.clone(), ticket, deadline, restore)
    })
    .await
}

#[tauri::command]
pub async fn resolve_app_exit(app: AppHandle, ticket: u64, approve: bool) -> CommandResult<bool> {
    let (send, receive) = oneshot::channel();
    queue_on_main(move || {
        if !take(&app, ticket) {
            let _ = send.send(false);
        } else if !approve {
            let _ = send.send(true);
        } else {
            if let Some(mtm) = MainThreadMarker::new() {
                APPROVED_RETRY.with(|permit| {
                    permit.set(true);
                    NSApplication::sharedApplication(mtm).terminate(None);
                    permit.set(false);
                });
            }
            // If AppKit returns, the app is still alive. The renderer must
            // thaw and any later Quit must obtain a fresh decision.
            let _ = send.send(false);
        }
    });
    receive.await.map_err(|error| error.to_string())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn test_quit_menu_action() -> CommandResult<bool> {
    fn activate(menu: &objc2_app_kit::NSMenu) -> bool {
        for index in 0..menu.numberOfItems() {
            let Some(item) = menu.itemAtIndex(index) else {
                continue;
            };
            if item.action() == Some(sel!(terminate:)) {
                menu.performActionForItemAtIndex(index);
                return true;
            }
            if item.submenu().is_some_and(|submenu| activate(&submenu)) {
                return true;
            }
        }
        false
    }
    let (send, receive) = oneshot::channel();
    queue_on_main(move || {
        let found = MainThreadMarker::new()
            .and_then(|mtm| NSApplication::sharedApplication(mtm).mainMenu())
            .is_some_and(|menu| activate(&menu));
        let _ = send.send(found);
    });
    receive.await.map_err(|error| error.to_string())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn test_quit_window_state(app: AppHandle, minimize: bool) -> CommandResult<(bool, bool)> {
    let (send, receive) = oneshot::channel();
    queue_on_main(move || {
        let result = with_main_window(&app, |window| {
            if minimize {
                window.miniaturize(None);
            }
            (window.isMiniaturized(), window.isVisible())
        });
        let _ = send.send(result);
    });
    receive.await.map_err(|error| error.to_string())?
}

fn with_main_window<T>(
    app: &AppHandle,
    work: impl FnOnce(&objc2_app_kit::NSWindow) -> T,
) -> CommandResult<T> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    let ptr = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: this is the live Cocoa window of a retained Tauri
    // window handle; the method is called only on the main queue.
    let native =
        unsafe { ptr.cast::<objc2_app_kit::NSWindow>().as_ref() }.ok_or("No Cocoa window")?;
    Ok(work(native))
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn test_perform_window_close(app: AppHandle) -> CommandResult<()> {
    let (send, receive) = oneshot::channel();
    queue_on_main(move || {
        let result = with_main_window(&app, |window| window.performClose(None));
        let _ = send.send(result);
    });
    receive.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{wait_for_presentation, Duration, Instant, Ticket};
    use std::{cell::RefCell, future::ready};

    #[tokio::test]
    async fn presentation_waits_for_visibility_without_restoring_twice() {
        let calls = RefCell::new(Vec::new());
        let presented = wait_for_presentation(Instant::now() + Duration::from_secs(2), |restore| {
            calls.borrow_mut().push(restore);
            ready(Ok(Some(!restore)))
        })
        .await
        .unwrap();
        assert!(presented);
        assert_eq!(calls.into_inner(), [true, false]);
    }

    #[tokio::test]
    async fn presentation_wait_stops_on_ticket_invalidation_or_timeout() {
        let calls = RefCell::new(Vec::new());
        let presented = wait_for_presentation(Instant::now() + Duration::from_secs(2), |restore| {
            calls.borrow_mut().push(restore);
            ready(Ok(restore.then_some(false)))
        })
        .await
        .unwrap();
        assert!(!presented);
        assert_eq!(calls.into_inner(), [true, false]);

        let presented = wait_for_presentation(Instant::now() + Duration::from_millis(10), |_| {
            std::future::pending()
        })
        .await
        .unwrap();
        assert!(!presented);
    }

    #[test]
    fn tickets_coalesce_and_cannot_approve_a_later_attempt() {
        let mut gate = Ticket::default();
        let initial = gate.begin().unwrap();
        assert_eq!(gate.begin(), None);
        assert!(gate.take(initial));
        let retry = gate.begin().unwrap();
        assert_ne!(initial, retry);
        assert!(!gate.take(initial));
        assert!(gate.take(retry));
        assert!(!gate.take(retry));
    }
}
