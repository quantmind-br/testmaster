/** A form control as the page exposes it. Never carries a value, a checked state or typed text. */
export interface ObservedControl {
  tag: string;
  type: string | null;
  role: string | null;
  name: string | null;
  placeholder: string | null;
  testId: string | null;
  visible: boolean;
}
/** A candidate target for an action: a link, a control or any element with a test id. */
export interface ObservedElement {
  tag: string;
  testId: string | null;
  label: string | null;
  placeholder: string | null;
  role: string | null;
  name: string | null;
  text: string;
  href: string | null;
}
export interface ObservedPage {
  title: string;
  text: string;
  controls: ObservedControl[];
  /** A password input exists. Its value, like every form value, is never read. */
  hasPasswordField: boolean;
  elements: ObservedElement[];
}

/**
 * Reads the page for the exploration and agent observations. Playwright serializes this function
 * into the page, so it must stay self-contained: no outer constants, helpers or imports.
 *
 * Form values are never read: `value`, `checked`, `selected` and the text of `textarea`, `select`
 * and `input` are skipped, and so is everything under `[data-sensitive]`. A password input is only
 * detected, never described by its content.
 */
export function observePage(): ObservedPage {
  const textNode = 3;
  const elementNode = 1;
  const opaque: Record<string, true> = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    TEXTAREA: true,
    SELECT: true,
    INPUT: true,
  };
  const textOf = (node: Node): string => {
    if (node.nodeType === textNode) return node.textContent ?? "";
    if (node.nodeType !== elementNode) return "";
    const element = node as Element;
    if (opaque[element.tagName] || element.hasAttribute("data-sensitive")) return "";
    return Array.from(element.childNodes, (child) => textOf(child)).join("");
  };
  const clean = (value: string | null | undefined, limit: number): string | null => {
    const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
    return text === "" ? null : text;
  };
  const isVisible = (node: Element): boolean => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return (
      node.checkVisibility({ visibilityProperty: true }) &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const inputType = (node: Element): string => (node.getAttribute("type") ?? "text").toLowerCase();
  const roleOf = (node: Element): string | null => {
    const explicit = node.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return node.hasAttribute("href") ? "link" : null;
    if (tag === "textarea") return "textbox";
    if (tag === "select")
      return node.hasAttribute("multiple") || Number(node.getAttribute("size")) > 1
        ? "listbox"
        : "combobox";
    if (tag !== "input") return null;
    const type = inputType(node);
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox" || type === "radio") return type;
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    // A password input has no ARIA role, and the hidden type has no control at all.
    if (type === "password" || type === "hidden") return null;
    return "textbox";
  };
  const nameOf = (node: Element): string | null => {
    const aria = clean(node.getAttribute("aria-label"), 100);
    if (aria) return aria;
    const labels = (node as HTMLInputElement).labels;
    const labelled = labels
      ? clean(Array.from(labels, (label) => textOf(label)).join(" "), 100)
      : null;
    if (labelled) return labelled;
    if (node.tagName === "BUTTON") {
      const text = clean(textOf(node), 100);
      if (text) return text;
    }
    return clean(node.getAttribute("title"), 100);
  };
  const sensitive = (node: Element): boolean => node.closest("[data-sensitive]") !== null;
  const controls = Array.from(document.querySelectorAll("input,select,textarea,button"))
    .filter((node) => inputType(node) !== "hidden" || node.tagName !== "INPUT")
    .filter((node) => !sensitive(node))
    .slice(0, 40)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      type:
        node.tagName === "INPUT"
          ? inputType(node)
          : node.tagName === "BUTTON"
            ? (node.getAttribute("type") ?? "submit").toLowerCase()
            : null,
      role: roleOf(node),
      name: nameOf(node),
      placeholder: clean(node.getAttribute("placeholder"), 100),
      testId: clean(node.getAttribute("data-testid"), 100),
      visible: isVisible(node),
    }));
  return {
    title: document.title,
    text: Array.from(document.querySelectorAll("h1,h2,h3,p,label,a,button,main"))
      .filter((node) => !sensitive(node))
      .map((node) => textOf(node))
      .join("\n")
      .slice(0, 12000),
    controls,
    hasPasswordField: document.querySelectorAll("input[type=password]").length > 0,
    elements: Array.from(
      document.querySelectorAll(
        "a[href],button,input:not([type=password]),textarea,select,[data-testid]",
      ),
    )
      // `[data-testid]` also matches a password input; it is detected, never an action candidate.
      .filter((node) => !(node.tagName === "INPUT" && inputType(node) === "password"))
      .slice(0, 100)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        testId: node.getAttribute("data-testid"),
        label: node.getAttribute("aria-label"),
        placeholder: clean(node.getAttribute("placeholder"), 200),
        role: roleOf(node),
        name: nameOf(node),
        text: textOf(node).slice(0, 200),
        href: node instanceof HTMLAnchorElement ? node.href : null,
      })),
  };
}
