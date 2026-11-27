export interface ExitDecision {
  canDecide(): boolean;
  hasUnsavedChanges(): boolean;
  confirmDiscard(): boolean | Promise<boolean>;
  freeze(frozen: boolean): void;
  reply(approve: boolean): Promise<boolean>;
}

export async function decideExit(decision: ExitDecision) {
  if (!decision.canDecide()) {
    await decision.reply(false);
    return;
  }
  decision.freeze(true);
  let exiting = false;
  try {
    const approve = !decision.hasUnsavedChanges() || await decision.confirmDiscard();
    const accepted = await decision.reply(approve);
    exiting = approve && accepted;
  } catch (error) {
    try { await decision.reply(false); } catch { /* The same ticket will expire if the host is unavailable. */ }
    throw error;
  } finally {
    if (!exiting) decision.freeze(false);
  }
}
