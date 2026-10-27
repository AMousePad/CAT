export { catIcon } from "./cat-icons";
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(label: string, action: () => void, className = "", disabled = false): HTMLButtonElement {
  const node = el("button", `ao-button ${className}`, label); node.type = "button"; node.disabled = disabled;
  node.addEventListener("click", action); return node;
}
export function select(label: string, value: string, options: { id: string; name: string }[], onChange: (id: string) => void, disabled = false): HTMLElement {
  const field = el("label", "ao-field"); field.append(el("span", "ao-label", label));
  const input = el("select", "ao-input"); input.disabled = disabled;
  for (const choice of options) { const option = el("option", "", choice.name); option.value = choice.id; input.append(option); }
  input.value = value;
  input.addEventListener("change", () => onChange(input.value)); field.append(input); return field;
}
