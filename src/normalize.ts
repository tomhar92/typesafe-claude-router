/**
 * JSON for comparison and hashing, with Claude Code's `cache_control`
 * breakpoint markers removed.
 *
 * Claude Code moves the marker onto whichever content block now ends the
 * cacheable prefix, so the same logical message serializes differently
 * turn to turn even when nothing anyone said changed. A replacer drops it
 * in a single pass, without the intermediate object graph the recursive
 * rebuild in reset.ts allocated for every message, every turn.
 */
export function stringifyWithoutCacheControl(value: unknown): string {
  return JSON.stringify(value, (key, nested) => (key === "cache_control" ? undefined : nested)) ?? "";
}
