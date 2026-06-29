/** Tiny DOM helpers shared across the framework and game views. */

/** Escape text for safe insertion as element content. */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape text for a double-quoted HTML attribute. `escapeHtml` does not escape
 * `"`, so a value containing a quote would break out of `attr="..."`.
 */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
