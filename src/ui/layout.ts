/** Lumiverse scales the body once; DOM rectangles are already in rendered pixels. */
export function uiScale(): number {
  const value = Number.parseFloat(document.defaultView?.getComputedStyle(document.documentElement).getPropertyValue("--lumiverse-ui-scale") ?? "");
  return Number.isFinite(value) && value > 0 ? value : 1;
}
