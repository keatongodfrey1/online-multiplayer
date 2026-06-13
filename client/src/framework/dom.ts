/** Tiny DOM helpers shared across the framework and game views. */

/** Escape text for safe insertion as element content. */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
