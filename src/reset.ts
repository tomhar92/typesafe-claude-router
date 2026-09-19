// Claude Code moves the `cache_control` breakpoint marker onto whichever
// content block is now the end of the cacheable prefix, so the same
// logical message can carry a different `cache_control` field turn to
// turn even though nothing the user or assistant actually said changed.
// Comparing raw messages byte-for-byte flags that breakpoint move as a
// reset on nearly every turn, which defeats the sticky/break-even policy
// entirely (it always sees "reset" and adopts the raw classifier choice).
// Strip `cache_control` before comparing so only real content changes -
// edits, rewinds, `/clear`, `/compact` - count as a reset.
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCacheControl);
  }
  if (value !== null && typeof value === "object") {
    const { cache_control, ...rest } = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(rest)) {
      normalized[key] = stripCacheControl(nested);
    }
    return normalized;
  }
  return value;
}

export function detectReset(
  lastMessages: unknown[] | undefined,
  currentMessages: unknown[]
): boolean {
  if (!lastMessages || lastMessages.length === 0) return true;
  if (currentMessages.length < lastMessages.length) return true;
  for (let i = 0; i < lastMessages.length; i++) {
    if (
      JSON.stringify(stripCacheControl(currentMessages[i])) !==
      JSON.stringify(stripCacheControl(lastMessages[i]))
    ) {
      return true;
    }
  }
  return false;
}
