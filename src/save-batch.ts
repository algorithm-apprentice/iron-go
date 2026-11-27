interface SaveTab {
  path: string;
  dirty: boolean;
  model: { getVersionId(): number };
}

export async function saveDirtyTabs<T extends SaveTab>(tabs: () => readonly T[], save: (tab: T) => Promise<boolean>,
  canContinue = () => true) {
  const versions = new Map(tabs().map(tab => [tab, tab.model.getVersionId()]));
  const committed: string[] = [];
  const interruption = () => {
    if (!canContinue()) return "The save decision expired.";
    const changed = tabs().find(tab => tab.dirty && versions.get(tab) !== tab.model.getVersionId());
    if (changed) return `Newer edits in ${changed.path} remain unsaved.`;
  };
  for (const tab of versions.keys()) {
    const issue = interruption();
    if (issue) return { committed, issue };
    if (!tab.dirty) continue;
    try {
      if (!await save(tab)) return { committed, issue: `Could not save ${tab.path}.` };
      committed.push(tab.path);
    } catch (error) {
      return { committed, issue: `Could not save ${tab.path}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { committed, issue: interruption() };
}
