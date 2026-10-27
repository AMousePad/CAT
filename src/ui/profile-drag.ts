import { catIcon, el } from "./components";
import { uiScale } from "./layout";

/** Lift the actual card above a moving gap; animate its neighbours into place. */
export function profileDrag(list: HTMLElement, save: (ids: string[]) => void): () => void {
  let active: { row: HTMLElement; handle: HTMLElement; pointer: number; y: number; offset: number; moved: boolean;
    order: HTMLElement[]; style: string; gap?: HTMLElement } | undefined;
  const animations = new Map<HTMLElement, Animation>();
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rows = () => Array.from(list.children).filter(row => row.classList.contains("ao-slot")) as HTMLElement[];
  const positions = () => new Map(rows().map(row => [row, row.getBoundingClientRect().top]));
  const animate = (before: Map<HTMLElement, number>) => {
    for (const row of rows()) {
      if (row === active?.row) continue;
      animations.get(row)?.cancel();
      const delta = ((before.get(row) ?? row.getBoundingClientRect().top) - row.getBoundingClientRect().top) / uiScale();
      if (Math.abs(delta) > 1 && !reducedMotion && typeof row.animate === "function") {
        const animation = row.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
        void animation.finished.catch(() => {}); animations.set(row, animation);
      }
    }
  };
  const finish = (commit: boolean) => {
    const drag = active; active = undefined;
    if (!drag) return;
    if (drag.gap) { list.insertBefore(drag.row, drag.gap); drag.gap.remove(); }
    drag.row.style.cssText = drag.style; drag.row.classList.remove("ao-dragging");
    if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    if (!commit) { for (const row of drag.order) list.append(row); return; }
    const order = rows();
    if (drag.moved && drag.order.some((row, i) => order[i] !== row)) save(order.map(row => row.dataset.slotId!));
  };
  const down = (event: PointerEvent) => {
    const handle = (event.target as Element).closest<HTMLElement>(".ao-drag-handle");
    if (!handle || handle.matches(":disabled") || event.button !== 0 || !event.isPrimary) return;
    const row = handle.closest<HTMLElement>(".ao-slot")!;
    active = { row, handle, pointer: event.pointerId, y: event.clientY, offset: event.clientY - row.getBoundingClientRect().top,
      moved: false, order: rows(), style: row.style.cssText };
    handle.setPointerCapture(event.pointerId); event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointer) return;
    const drag = active;
    if (!drag.moved && Math.abs(event.clientY - drag.y) < 5) return;
    if (!drag.moved) {
      const rect = drag.row.getBoundingClientRect();
      drag.moved = true; drag.gap = el("div", "ao-drag-gap"); drag.gap.style.height = `${rect.height / uiScale()}px`;
      drag.gap.setAttribute("aria-hidden", "true"); drag.gap.append(catIcon(), el("span", "", "Drop here"));
      list.insertBefore(drag.gap, drag.row); list.append(drag.row);
      Object.assign(drag.row.style, { position: "absolute", left: "0", width: `${rect.width / uiScale()}px`, height: `${rect.height / uiScale()}px`, pointerEvents: "none" });
      drag.row.classList.add("ao-dragging"); drag.handle.setPointerCapture(event.pointerId);
    }
    drag.row.style.top = `${(event.clientY - list.getBoundingClientRect().top - drag.offset) / uiScale()}px`;
    const before = rows().find(row => row !== drag.row && event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    if (drag.gap!.nextElementSibling !== before && (before || drag.gap!.nextElementSibling !== drag.row)) {
      const old = positions(); list.insertBefore(drag.gap!, before || drag.row); animate(old);
    }
    const scroll = list.closest<HTMLElement>(".ao-content");
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      if (event.clientY < rect.top + 45) scroll.scrollTop -= 12;
      if (event.clientY > rect.bottom - 45) scroll.scrollTop += 12;
    }
    event.preventDefault();
  };
  const up = (event: PointerEvent) => { if (event.pointerId === active?.pointer) finish(true); };
  const cancel = () => finish(false);
  list.addEventListener("pointerdown", down); list.addEventListener("pointermove", move);
  list.addEventListener("pointerup", up); list.addEventListener("pointercancel", cancel); list.addEventListener("lostpointercapture", cancel);
  return () => {
    cancel(); for (const animation of animations.values()) animation.cancel(); animations.clear();
    list.removeEventListener("pointerdown", down); list.removeEventListener("pointermove", move);
    list.removeEventListener("pointerup", up); list.removeEventListener("pointercancel", cancel); list.removeEventListener("lostpointercapture", cancel);
  };
}
