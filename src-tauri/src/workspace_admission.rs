use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};

use crate::{CommandResult, Core, Session};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Mutation,
    CreateFile,
    Cutover,
    Quit(u64),
}

impl Kind {
    fn is_cutover(self) -> bool {
        matches!(self, Self::Cutover | Self::Quit(_))
    }
}

const WAITING: u8 = 0;
const ADMITTED: u8 = 1;
#[cfg(any(feature = "e2e", test))]
const SEALED: u8 = 2;

pub(crate) struct Operation {
    id: u64,
    kind: Kind,
    effect: Arc<AtomicU8>,
    teardown_started: bool,
}

impl Session {
    pub(crate) fn workspace_busy(&self) -> bool {
        self.workspace_operation.is_some()
    }

    pub(crate) fn cutover_pending(&self) -> bool {
        self.workspace_operation
            .as_ref()
            .is_some_and(|operation| operation.kind.is_cutover())
    }

    pub(crate) fn cutover_tearing_down(&self) -> bool {
        self.workspace_operation
            .as_ref()
            // Replacement retires the workspace as a whole. Quit stops each
            // owner at its own ticket-checked step; retiring a shell alone
            // does not revoke an admitted Debug or ordinary Go handoff.
            .is_some_and(|operation| operation.kind == Kind::Cutover && operation.teardown_started)
    }

    pub(crate) fn owns_quit(&self, ticket: u64) -> bool {
        self.workspace_operation
            .as_ref()
            .is_some_and(|operation| operation.kind == Kind::Quit(ticket))
    }

    #[cfg(feature = "e2e")]
    pub(crate) fn quit_tearing_down(&self, ticket: u64) -> bool {
        self.workspace_operation.as_ref().is_some_and(|operation| {
            operation.kind == Kind::Quit(ticket) && operation.teardown_started
        })
    }

    #[cfg(any(feature = "e2e", test))]
    pub(crate) fn seal_workspace_effect(&self) {
        if let Some(operation) = &self.workspace_operation {
            let _ = operation.effect.compare_exchange(
                WAITING,
                SEALED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    fn reserve_workspace(&mut self, kind: Kind) -> CommandResult<u64> {
        #[cfg(feature = "e2e")]
        self.acceptance.check()?;
        if self.workspace_busy() {
            return Err("Another workspace operation is in progress.".into());
        }
        if kind == Kind::Mutation && self.go_busy() {
            return Err("Stop the current Go task before changing workspace paths.".into());
        }
        let id = self.next_id();
        self.workspace_operation = Some(Operation {
            id,
            kind,
            effect: Arc::new(AtomicU8::new(WAITING)),
            teardown_started: false,
        });
        Ok(id)
    }

    fn release_workspace(&mut self, id: u64) {
        if self
            .workspace_operation
            .as_ref()
            .is_some_and(|operation| operation.id == id)
        {
            self.workspace_operation = None;
        }
    }
}

pub(crate) struct Lease {
    app: AppHandle,
    id: u64,
    effect: Arc<AtomicU8>,
}

impl Lease {
    pub(crate) fn begin(app: &AppHandle, session: &mut Session, kind: Kind) -> CommandResult<Self> {
        let id = session.reserve_workspace(kind)?;
        Ok(Self {
            app: app.clone(),
            id,
            effect: session.workspace_operation.as_ref().unwrap().effect.clone(),
        })
    }

    pub(crate) fn admit_effect(&self) -> CommandResult<()> {
        self.effect
            .compare_exchange(WAITING, ADMITTED, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| {
                "The workspace operation can no longer start a filesystem change.".to_owned()
            })
    }

    pub(crate) fn check(&self, session: &Session) -> CommandResult<()> {
        #[cfg(feature = "e2e")]
        session.acceptance.check()?;
        if session
            .workspace_operation
            .as_ref()
            .is_some_and(|operation| operation.id == self.id)
        {
            Ok(())
        } else {
            Err("The workspace operation is no longer current.".into())
        }
    }

    pub(crate) fn begin_teardown(&self, session: &mut Session) -> CommandResult<()> {
        self.check(session)?;
        let operation = session.workspace_operation.as_mut().unwrap();
        if !operation.kind.is_cutover() {
            return Err("The workspace operation does not authorize cutover.".into());
        }
        operation.teardown_started = true;
        Ok(())
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let core = self.app.state::<Core>();
        core.0.lock().unwrap().release_workspace(self.id);
        #[cfg(feature = "e2e")]
        core.2.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mutation_excludes_cutover_and_a_stale_release_cannot_clear_a_new_lease() {
        let mut session = Session::default();
        let mutation = session.reserve_workspace(Kind::Mutation).unwrap();
        assert!(session.workspace_busy());
        assert!(!session.cutover_pending());
        assert!(session.reserve_workspace(Kind::Cutover).is_err());
        session.release_workspace(mutation);
        let cutover = session.reserve_workspace(Kind::Cutover).unwrap();
        session.release_workspace(mutation);
        assert!(session.cutover_pending());
        assert!(!session.cutover_tearing_down());
        assert!(session.reserve_workspace(Kind::Mutation).is_err());
        session.release_workspace(cutover);
        assert!(!session.workspace_busy());
    }

    #[test]
    fn quit_retiring_its_terminal_does_not_fence_other_owners() {
        let mut session = Session::default();
        let quit = session.reserve_workspace(Kind::Quit(1)).unwrap();
        session
            .workspace_operation
            .as_mut()
            .unwrap()
            .teardown_started = true;
        assert!(session.workspace_busy());
        assert!(!session.cutover_tearing_down());
        session.release_workspace(quit);
        session.reserve_workspace(Kind::Cutover).unwrap();
        session
            .workspace_operation
            .as_mut()
            .unwrap()
            .teardown_started = true;
        assert!(session.cutover_tearing_down());
    }

    #[test]
    fn sealing_refuses_preflight_but_does_not_cancel_an_admitted_effect() {
        let mut session = Session::default();
        let first = session.reserve_workspace(Kind::Mutation).unwrap();
        let effect = session.workspace_operation.as_ref().unwrap().effect.clone();
        session.seal_workspace_effect();
        assert_eq!(
            effect.compare_exchange(WAITING, ADMITTED, Ordering::AcqRel, Ordering::Acquire),
            Err(SEALED)
        );
        assert!(session.workspace_busy());
        session.release_workspace(first);
        session.reserve_workspace(Kind::Mutation).unwrap();
        let effect = session.workspace_operation.as_ref().unwrap().effect.clone();
        assert!(effect
            .compare_exchange(WAITING, ADMITTED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        session.seal_workspace_effect();
        assert_eq!(effect.load(Ordering::Acquire), ADMITTED);
        assert!(session.workspace_busy());
    }
}
