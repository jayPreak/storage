"use client";

import { useEffect, useRef, type RefObject } from "react";

// Pointer/touch gestures for the photo grid, attached natively (not via
// React props) because two of them need non-passive listeners to be able
// to preventDefault: touch drag-select has to stop the page scrolling, and
// pinch has to stop the browser zooming the whole page.
//
// - Mouse: press on the grid and drag to draw a marquee; every tile it
//   touches is selected. Holding Shift/Cmd/Ctrl adds to the existing
//   selection instead of replacing it. Auto-scrolls near the edges.
// - Touch: long-press a tile to select it, then (without lifting) drag
//   across other tiles to select the whole range between -- same as
//   Google/Apple Photos. Starting on an already-selected tile deselects
//   the range instead.
// - Pinch (touch) / Ctrl+wheel (trackpad pinch): calls onZoom(+1 | -1).
//
// The grid lives in whichever [data-scroll-root] is currently rendered;
// tiles are found via [data-tile-id]. Latest state is read through the
// getters on every event, so the listeners are attached exactly once.

type Selection = Record<string, boolean>;

type Opts = {
  // Re-attaches when this flips (the host only exists once unlocked).
  active: boolean;
  hostRef: RefObject<HTMLElement | null>;
  marqueeClass: string;
  getOrder: () => string[];
  getSelected: () => Selection;
  setSelected: (next: Selection) => void;
  onLongPress: () => void;
  onZoom: (dir: 1 | -1) => void;
  enabled: () => boolean;
};

const DRAG_THRESHOLD = 6;
const LONG_PRESS_MS = 380;
const LONG_PRESS_SLOP = 10;
const EDGE = 56;
const MAX_SCROLL_STEP = 18;

function sameKeys(a: Selection, b: Selection): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (!b[k]) return false;
  return true;
}

// Swallow the click that the browser fires right after a drag/long-press
// ends, so finishing a gesture on a tile doesn't also open or toggle it.
function suppressNextClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
}

export function useGridGestures(opts: Opts) {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const host = opts.hostRef.current;
    if (!host) return;
    const o = () => optsRef.current;

    // ---- shared auto-scroll loop ----
    let scrollRoot: HTMLElement | null = null;
    let lastX = 0;
    let lastY = 0;
    let scrollRaf = 0;
    let onScrollTick: (() => void) | null = null;
    function autoScroll() {
      scrollRaf = 0;
      if (!scrollRoot || !onScrollTick) return;
      const r = scrollRoot.getBoundingClientRect();
      let dy = 0;
      if (lastY < r.top + EDGE) dy = -Math.ceil(((r.top + EDGE - lastY) / EDGE) * MAX_SCROLL_STEP);
      else if (lastY > r.bottom - EDGE) dy = Math.ceil(((lastY - (r.bottom - EDGE)) / EDGE) * MAX_SCROLL_STEP);
      if (dy !== 0) {
        const before = scrollRoot.scrollTop;
        scrollRoot.scrollTop += dy;
        if (scrollRoot.scrollTop !== before) onScrollTick();
        scrollRaf = requestAnimationFrame(autoScroll);
      }
    }
    function kickAutoScroll() {
      if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
    }
    function stopAutoScroll() {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
      onScrollTick = null;
      scrollRoot = null;
    }

    function rootFor(target: EventTarget | null): HTMLElement | null {
      if (!(target instanceof Element)) return null;
      const root = target.closest<HTMLElement>("[data-scroll-root]");
      if (!root || !host!.contains(root) || !root.querySelector("[data-tile-id]")) return null;
      return root;
    }

    // ---- mouse marquee ----
    let mPending = false;
    let mActive = false;
    let mStart = { x: 0, y: 0 }; // content coords (include scroll offset)
    let mClientStart = { x: 0, y: 0 };
    let mBase: Selection = {};
    let mEl: HTMLDivElement | null = null;
    let mRaf = 0;

    function contentPoint(root: HTMLElement, cx: number, cy: number) {
      const r = root.getBoundingClientRect();
      return { x: cx - r.left + root.scrollLeft, y: cy - r.top + root.scrollTop };
    }

    function updateMarquee() {
      mRaf = 0;
      const root = scrollRoot;
      if (!root || !mEl) return;
      const cur = contentPoint(root, lastX, lastY);
      const left = Math.min(mStart.x, cur.x);
      const top = Math.min(mStart.y, cur.y);
      const width = Math.abs(cur.x - mStart.x);
      const height = Math.abs(cur.y - mStart.y);
      mEl.style.transform = `translate(${left}px, ${top}px)`;
      mEl.style.width = `${width}px`;
      mEl.style.height = `${height}px`;

      const rr = root.getBoundingClientRect();
      const next: Selection = { ...mBase };
      root.querySelectorAll<HTMLElement>("[data-tile-id]").forEach((t) => {
        const b = t.getBoundingClientRect();
        const tl = b.left - rr.left + root.scrollLeft;
        const tt = b.top - rr.top + root.scrollTop;
        if (tl < left + width && tl + b.width > left && tt < top + height && tt + b.height > top) {
          next[t.dataset.tileId!] = true;
        }
      });
      if (!sameKeys(next, o().getSelected())) o().setSelected(next);
    }
    function scheduleMarquee() {
      if (!mRaf) mRaf = requestAnimationFrame(updateMarquee);
    }

    function onPointerDown(e: PointerEvent) {
      if (e.pointerType !== "mouse" || e.button !== 0 || !o().enabled()) return;
      const root = rootFor(e.target);
      if (!root) return;
      const t = e.target as Element;
      if (t.closest("button, input, a, [data-no-marquee]")) return;
      // Ignore presses on the scrollbar itself.
      const rr = root.getBoundingClientRect();
      if (e.clientX > rr.left + root.clientWidth) return;
      mPending = true;
      scrollRoot = root;
      mClientStart = { x: e.clientX, y: e.clientY };
      mStart = contentPoint(root, e.clientX, e.clientY);
      mBase = e.shiftKey || e.metaKey || e.ctrlKey ? { ...o().getSelected() } : {};
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    }

    function onPointerMove(e: PointerEvent) {
      lastX = e.clientX;
      lastY = e.clientY;
      if (mPending && !mActive) {
        if (Math.hypot(e.clientX - mClientStart.x, e.clientY - mClientStart.y) < DRAG_THRESHOLD) return;
        mActive = true;
        mEl = document.createElement("div");
        mEl.className = o().marqueeClass;
        scrollRoot!.appendChild(mEl);
        onScrollTick = scheduleMarquee;
        window.getSelection()?.removeAllRanges();
      }
      if (!mActive) return;
      e.preventDefault();
      scheduleMarquee();
      kickAutoScroll();
    }

    function onPointerUp() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (mActive) {
        if (mRaf) cancelAnimationFrame(mRaf);
        updateMarquee();
        suppressNextClick();
      }
      mEl?.remove();
      mEl = null;
      mPending = false;
      mActive = false;
      stopAutoScroll();
    }

    // ---- touch: long-press drag-select + pinch ----
    let lpTimer = 0;
    let tStart = { x: 0, y: 0 };
    let tActive = false;
    let tAnchor = "";
    let tMode: "select" | "deselect" = "select";
    let tBase: Selection = {};
    let tLastId = "";
    let pinchDist = 0;
    let lastTouchTs = 0;

    function cancelLongPress() {
      if (lpTimer) window.clearTimeout(lpTimer);
      lpTimer = 0;
    }

    function applyTouchRange() {
      const el = document.elementFromPoint(lastX, lastY);
      const tile = el?.closest<HTMLElement>("[data-tile-id]");
      const id = tile?.dataset.tileId;
      if (!id || id === tLastId) return;
      tLastId = id;
      const order = o().getOrder();
      const i = order.indexOf(tAnchor);
      const j = order.indexOf(id);
      if (i === -1 || j === -1) return;
      const next: Selection = { ...tBase };
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
        if (tMode === "select") next[order[k]] = true;
        else delete next[order[k]];
      }
      o().setSelected(next);
    }

    function pinchSpan(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function onTouchStart(e: TouchEvent) {
      lastTouchTs = Date.now();
      if (!o().enabled()) return;
      const root = rootFor(e.target);
      if (!root) return;
      if (e.touches.length === 2) {
        cancelLongPress();
        pinchDist = pinchSpan(e);
        return;
      }
      if (e.touches.length !== 1) return;
      const tile = (e.target as Element).closest<HTMLElement>("[data-tile-id]");
      if (!tile) return;
      const t = e.touches[0];
      tStart = { x: t.clientX, y: t.clientY };
      lastX = t.clientX;
      lastY = t.clientY;
      cancelLongPress();
      lpTimer = window.setTimeout(() => {
        lpTimer = 0;
        tActive = true;
        scrollRoot = root;
        tAnchor = tile.dataset.tileId!;
        tLastId = "";
        const sel = o().getSelected();
        tMode = sel[tAnchor] ? "deselect" : "select";
        tBase = { ...sel };
        o().onLongPress();
        applyTouchRange();
        onScrollTick = applyTouchRange;
        navigator.vibrate?.(8);
      }, LONG_PRESS_MS);
    }

    function onTouchMove(e: TouchEvent) {
      if (pinchDist && e.touches.length === 2) {
        e.preventDefault();
        const d = pinchSpan(e);
        if (d / pinchDist > 1.3) {
          o().onZoom(1);
          pinchDist = d;
        } else if (d / pinchDist < 0.77) {
          o().onZoom(-1);
          pinchDist = d;
        }
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      if (lpTimer && Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > LONG_PRESS_SLOP) {
        cancelLongPress();
      }
      if (!tActive) return;
      e.preventDefault();
      lastX = t.clientX;
      lastY = t.clientY;
      applyTouchRange();
      kickAutoScroll();
    }

    function onTouchEnd(e: TouchEvent) {
      lastTouchTs = Date.now();
      if (e.touches.length < 2) pinchDist = 0;
      cancelLongPress();
      if (tActive) {
        tActive = false;
        suppressNextClick();
        stopAutoScroll();
      }
    }

    // Stop the long-press context menu / iOS callout on tiles.
    function onContextMenu(e: Event) {
      if (Date.now() - lastTouchTs < 1000 && (e.target as Element).closest?.("[data-tile-id]")) {
        e.preventDefault();
      }
    }

    // Safari's proprietary pinch event -- blocking it keeps a pinch on the
    // grid from zooming the whole page.
    function onGestureStart(e: Event) {
      if (rootFor(e.target)) e.preventDefault();
    }

    // Trackpad pinch arrives as ctrl+wheel.
    let wheelAcc = 0;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey || !rootFor(e.target)) return;
      e.preventDefault();
      wheelAcc += e.deltaY;
      if (wheelAcc < -40) {
        o().onZoom(1);
        wheelAcc = 0;
      } else if (wheelAcc > 40) {
        o().onZoom(-1);
        wheelAcc = 0;
      }
    }

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    host.addEventListener("contextmenu", onContextMenu);
    host.addEventListener("gesturestart", onGestureStart);
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.removeEventListener("contextmenu", onContextMenu);
      host.removeEventListener("gesturestart", onGestureStart);
      host.removeEventListener("wheel", onWheel);
      onPointerUp();
      cancelLongPress();
    };
    // Everything else is read through optsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.active]);
}
