import { CAT_ICON_POOL } from "./icons";
import { IconCycle } from "./icon-cycle";

const kinds = ["swipes", "settings", "cat"] as const;
export type CatIconKind = typeof kinds[number];
const designs = new IconCycle(CAT_ICON_POOL);
designs.shuffle();

export function catIcon(className = "ao-cat-icon", kind: CatIconKind = "swipes"): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = designs.at(kinds.indexOf(kind));
  const svg = template.content.firstElementChild as unknown as SVGSVGElement;
  svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className); svg.dataset.aoCatIcon = kind;
  return svg;
}

/** Only explicit interaction advances the designs; streaming and other renders reuse them. */
export function rotateCatIcons(): void {
  designs.shuffle();
  refreshCatIcons();
}

/** Drawer roots can be detached while closed; synchronize them when the host opens one. */
export function refreshCatIcons(root: ParentNode = document): void {
  for (const svg of root.querySelectorAll<SVGSVGElement>("svg[data-ao-cat-icon]")) {
    const kind = svg.dataset.aoCatIcon as CatIconKind;
    if (!kinds.includes(kind)) continue;
    const next = catIcon(svg.getAttribute("class") ?? "", kind);
    for (const attribute of Array.from(svg.attributes)) svg.removeAttribute(attribute.name);
    for (const attribute of Array.from(next.attributes)) svg.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    svg.replaceChildren(...Array.from(next.childNodes));
  }
}
