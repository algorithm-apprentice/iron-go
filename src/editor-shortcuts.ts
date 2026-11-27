export function handleEditorCycle(event: KeyboardEvent, blocked: boolean, cycle: (direction: 1 | -1) => boolean) {
  if (blocked || event.isComposing || event.altKey) return false;
  let direction: 1 | -1 | undefined;
  if (event.ctrlKey && !event.metaKey && event.key === "Tab") direction = event.shiftKey ? -1 : 1;
  else if (event.metaKey && event.shiftKey && !event.ctrlKey) {
    if (event.code === "BracketLeft") direction = -1;
    else if (event.code === "BracketRight") direction = 1;
    else if (event.key === "[") direction = -1;
    else if (event.key === "]") direction = 1;
  }
  if (!direction || !cycle(direction)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
