export function changedLineRegion(before: readonly string[], after: readonly string[]) {
  const sharedLength = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < sharedLength && before[prefix] === after[prefix]) prefix++;
  if (prefix === before.length && prefix === after.length) return;
  let suffix = 0;
  while (suffix < sharedLength - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { first: prefix + 1, beforeEnd: before.length - suffix, afterEnd: after.length - suffix };
}
