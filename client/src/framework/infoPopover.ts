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
 *   `wireInfoButtons(container)` once per render (cheap; each render passes a fresh container).
 */
import { escapeAttr } from "./dom.js";

/** Markup for one ⓘ trigger. The hint is read back from the data attribute on tap. */
export function infoButton(hint: string, label: string): string {
  if (!hint) return "";
  return `<button type="button" class="fw-info" data-info-hint="${escapeAttr(hint)}" aria-haspopup="true" aria-expanded="false" aria-label="What does ${escapeAttr(label)} do?">i</button>`;
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
  el.setAttribute("role", "tooltip"); // a one-line hint, not a modal dialog
  el.tabIndex = -1;
  el.hidden = true;
  document.body.appendChild(el);
  popover = el;
  return el;
}

/**
 * Does getBoundingClientRect() already include CSS `zoom`? It does on Safari 26.4+
 * and Chrome 126+, but returns PRE-zoom coords on older engines. The lobby anchors
 * sit inside a `zoom: var(--ui-scale)` container while this popover is on un-zoomed
 * `document.body`, so we must know which space the rect is in. Measured once with an
 * offscreen zoom:2 probe (100px wide → ~200px rect means rects include zoom).
 */
let _rectsIncludeZoom: boolean | null = null;
function rectsIncludeZoom(): boolean {
  if (_rectsIncludeZoom !== null) return _rectsIncludeZoom;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;width:100px;height:1px;zoom:2;";
  document.body.appendChild(probe);
  _rectsIncludeZoom = probe.getBoundingClientRect().width > 150;
  probe.remove();
  return _rectsIncludeZoom;
}

/**
 * Position the (already-shown) popover near its anchor, clamped to the viewport.
 * The anchor is magnified by `--ui-scale`; the popover (on body) is not — so bring
 * the anchor's rect into the body's visual-pixel space before clamping. On engines
 * whose rect already includes zoom, k=1; on older engines, multiply by the scale.
 */
function place(anchor: HTMLElement): void {
  const el = popover!;
  const margin = 8;
  const uiScale =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
  const k = rectsIncludeZoom() ? 1 : uiScale;
  const r = anchor.getBoundingClientRect();
  const aLeft = r.left * k;
  const aTop = r.top * k;
  const aBottom = r.bottom * k;
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let left = aLeft;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;
  if (left < margin) left = margin;
  // Below the button by default; flip above if it would overflow the bottom.
  let top = aBottom + 6;
  if (top + ph > window.innerHeight - margin) top = aTop - ph - 6;
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
  anchor.setAttribute("aria-expanded", "true");
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
  if (openAnchor) openAnchor.setAttribute("aria-expanded", "false");
  const focusBack = restoreFocus;
  openAnchor = null;
  restoreFocus = null;
  // Only restore focus if the element is still in the document (the anchor may
  // have just been destroyed by the re-render that triggered this close).
  if (focusBack && document.contains(focusBack)) focusBack.focus();
}

/**
 * Attach one delegated click listener to `container` that toggles the shared
 * popover for any ⓘ inside it. The lobby replaces this container on every
 * re-render, so each call gets a fresh element; the WeakSet only guards against
 * double-binding within a single render.
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
