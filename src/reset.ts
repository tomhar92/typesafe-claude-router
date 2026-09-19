export function detectReset(
  lastMessages: unknown[] | undefined,
  currentMessages: unknown[]
): boolean {
  if (!lastMessages || lastMessages.length === 0) return true;
  if (currentMessages.length < lastMessages.length) return true;
  for (let i = 0; i < lastMessages.length; i++) {
    if (JSON.stringify(currentMessages[i]) !== JSON.stringify(lastMessages[i])) {
      return true;
    }
  }
  return false;
}
