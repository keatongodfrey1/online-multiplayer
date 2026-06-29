/**
 * Tappable "ⓘ" info affordance for lobby settings.
 *
 * The owner plays on an iPad, where hover `title=` tooltips never appear. This
 * surfaces a setting's one-line hint on TAP instead, in a single shared popover.
 *
 * Lifecycle note (the whole reason this is a framework helper, not inline):
 * the lobby re-renders on every room state change by replacing its innerHTML, so
 * the ⓘ button a popover is anchored to gets destroyed out from under it. The
 * popover lives on `document.body` (outside that subtree), so the re-render can't
 * clean it up. RoomScreen MUST call `closeInfoPopover()` before it re-renders the
 * lobby and when it tears the lobby down — that removes the orphaned popover and
 * its document-level listeners. The popover also self-closes if its anchor leaves
 * the document (scroll/resize), as a backstop.
 *
 * Usage in a game's renderLobbySettings:
 *   `<span>${escapeHtml(label)}${infoButton(hint, label)}</span>` ... then
 *   `wireInfoButtons(container)` once per render (cheap; guarded against re-bind).
 */
import { escapeAttr } from "./dom.js";

/** Markup for one ⓘ trigger. The hint is read back from the data attribute on tap. */
export function infoButton(hint: string, label: string): string {
  if (!hint) return "";
  return `<button type="button" class="fw-info" data-info-hint="${escapeAttr(hint)}" aria-label="What does ${escapeAttr(label)} do?">i</button>`;
}

/** Containers we've already attached the delegated listener to. */
const wired = new WeakSet<HTMLElement>();

let popover: HTMLElement | null = null;
let openAnchor: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;

function ensurePopover(): HTMLElement {
  if (popover) return popover;
  const el = document.createElement("div");
  el.className = "fw-info-popover";
  el.setAttribute("role", "dialog");
  el.tabIndex = -1;
  el.hidden = true;
  document.body.appendChild(el);
  popover = el;
  return el;
}

/** Position the (already-shown) popover near its anchor, clamped to the viewport. */
function place(anchor: HTMLElement): void {
  const el = popover!;
  const margin = 8;
  const r = anchor.getBoundingClientRect();
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let left = r.left;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;
  if (left < margin) left = margin;
  // Below the button by default; flip above if it would overflow the bottom.
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - margin) top = r.top - ph - 6;
  if (top < margin) top = margin;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") closeInfoPopover();
}

function onPointerDown(e: Event): void {
  const t = e.target as HTMLElement | null;
  // Taps on the popover or on ANY ⓘ are handled by their own handlers (toggle).
  if (t && (t.closest(".fw-info-popover") || t.closest("[data-info-hint]"))) return;
  closeInfoPopover();
}

function onReflow(): void {
  if (!openAnchor) return;
  if (!document.contains(openAnchor)) {
    closeInfoPopover();
    return;
  }
  place(openAnchor);
}

function openInfoPopover(anchor: HTMLElement): void {
  const hint = anchor.getAttribute("data-info-hint");
  if (!hint) return;
  const el = ensurePopover();
  el.textContent = hint; // text node — no HTML injection from the hint
  el.hidden = false;
  openAnchor = anchor;
  restoreFocus = (document.activeElement as HTMLElement) ?? anchor;
  place(anchor);
  el.focus();
  // Global dismissal listeners exist only while a popover is open.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("scroll", onReflow, true);
  window.addEventListener("resize", onReflow, true);
}

/**
 * Hide the shared popover and remove every global listener it installed.
 * Idempotent — safe to call when nothing is open. RoomScreen calls this before
 * re-rendering / tearing down the lobby so the popover can't orphan.
 */
export function closeInfoPopover(): void {
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("scroll", onReflow, true);
  window.removeEventListener("resize", onReflow, true);
  if (popover) popover.hidden = true;
  const focusBack = restoreFocus;
  openAnchor = null;
  restoreFocus = null;
  // Only restore focus if the element is still in the document (the anchor may
  // have just been destroyed by the re-render that triggered this close).
  if (focusBack && document.contains(focusBack)) focusBack.focus();
}

/**
 * Attach one delegated click listener to `container` that toggles the shared
 * popover for any ⓘ inside it. Cheap and idempotent — re-binding the same
 * element is a no-op, so games may call it every render.
 */
export function wireInfoButtons(container: HTMLElement): void {
  if (wired.has(container)) return;
  wired.add(container);
  container.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-info-hint]");
    if (!btn) return;
    e.preventDefault();
    if (btn === openAnchor) closeInfoPopover();
    else {
      closeInfoPopover();
      openInfoPopover(btn);
    }
  });
}
