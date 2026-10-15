import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observePage } from "./observation.js";

/**
 * A page is a tree of these. `observePage` runs in the browser and reads only the DOM surface the
 * fake implements, so the fake is also a record of everything the collector is allowed to touch:
 * there is no `value`, `checked` or `selected` here for it to leak.
 */
class FakeText {
  readonly nodeType = 3;
  constructor(readonly textContent: string) {}
}
class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: (FakeElement | FakeText)[] = [];
  parent: FakeElement | undefined;
  labels: FakeElement[] | undefined;
  constructor(
    tag: string,
    readonly attrs: Record<string, string> = {},
    children: (FakeElement | string)[] = [],
  ) {
    this.tagName = tag.toUpperCase();
    for (const child of children) {
      if (typeof child === "string") this.childNodes.push(new FakeText(child));
      else {
        child.parent = this;
        this.childNodes.push(child);
      }
    }
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): FakeElement | null {
    if (selector !== "[data-sensitive]") throw new Error(`unsupported selector ${selector}`);
    for (let node: FakeElement | undefined = this; node; node = node.parent)
      if (node.hasAttribute("data-sensitive")) return node;
    return null;
  }
  checkVisibility(): boolean {
    return !this.hasAttribute("hidden");
  }
  getBoundingClientRect() {
    return { width: 10, height: 10 };
  }
}
class FakeAnchor extends FakeElement {
  get href(): string {
    return `https://shop.example${this.attrs.href ?? ""}`;
  }
}
const el = (
  tag: string,
  attrs: Record<string, string> = {},
  ...children: (FakeElement | string)[]
) => (tag === "a" ? new FakeAnchor(tag, attrs, children) : new FakeElement(tag, attrs, children));

/** The few selector shapes the collector uses: `a,b`, `tag`, `[attr]`, `tag[attr=v]`, `:not([attr=v])`. */
function matches(node: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => {
    const parsed = /^([a-z0-9]+)?(?:\[([\w-]+)(?:=(\w+))?\])?(?::not\(\[([\w-]+)=(\w+)\]\))?$/.exec(
      part,
    );
    if (!parsed) throw new Error(`unsupported selector ${part}`);
    const [, tag, attribute, value, notAttribute, notValue] = parsed;
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    if (attribute && !node.hasAttribute(attribute)) return false;
    if (attribute && value !== undefined && node.getAttribute(attribute) !== value) return false;
    return !(notAttribute && node.getAttribute(notAttribute) === notValue);
  });
}
function mount(title: string, ...body: FakeElement[]): void {
  const root = el("body", {}, ...body);
  const all = (node: FakeElement): FakeElement[] => [
    node,
    ...node.childNodes.flatMap((child) => (child instanceof FakeElement ? all(child) : [])),
  ];
  vi.stubGlobal("document", {
    title,
    querySelectorAll: (selector: string) => all(root).filter((node) => matches(node, selector)),
  });
}
beforeEach(() => {
  vi.stubGlobal("HTMLAnchorElement", FakeAnchor);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("describes form controls and a password field without reading any value", () => {
  const email = el("input", {
    type: "email",
    placeholder: "you@example.com",
    value: "typed-secret",
  });
  email.labels = [el("label", {}, "Email address")];
  const password = el("input", {
    type: "password",
    placeholder: "Enter your password",
    value: "hunter2",
    "data-testid": "pw",
  });
  mount(
    "Sign in",
    el(
      "form",
      {},
      el("label", {}, "Email address", email),
      password,
      el("textarea", { "aria-label": "Notes" }, "private draft"),
      el("select", { "aria-label": "Region" }, el("option", {}, "Secret option")),
      el("input", { type: "hidden", value: "csrf-token" }),
      el("button", { type: "submit" }, "Continue"),
      el("button", { "aria-label": "Close dialog", hidden: "" }, "x"),
    ),
  );
  const page = observePage();
  expect(page.hasPasswordField).toBe(true);
  expect(page.controls).toEqual([
    {
      tag: "input",
      type: "email",
      role: "textbox",
      name: "Email address",
      placeholder: "you@example.com",
      testId: null,
      visible: true,
    },
    {
      tag: "input",
      type: "password",
      // A password input has no ARIA role, so no role+name locator can be derived for it.
      role: null,
      name: null,
      placeholder: "Enter your password",
      testId: "pw",
      visible: true,
    },
    {
      tag: "textarea",
      type: null,
      role: "textbox",
      name: "Notes",
      placeholder: null,
      testId: null,
      visible: true,
    },
    {
      tag: "select",
      type: null,
      role: "combobox",
      name: "Region",
      placeholder: null,
      testId: null,
      visible: true,
    },
    {
      tag: "button",
      type: "submit",
      role: "button",
      name: "Continue",
      placeholder: null,
      testId: null,
      visible: true,
    },
    {
      tag: "button",
      type: "submit",
      role: "button",
      name: "Close dialog",
      placeholder: null,
      testId: null,
      visible: false,
    },
  ]);
  const serialized = JSON.stringify(page);
  for (const secret of ["typed-secret", "hunter2", "private draft", "Secret option", "csrf-token"])
    expect(serialized).not.toContain(secret);
  // A password input is detected but is never an action candidate.
  expect(page.elements.some((element) => element.placeholder === "Enter your password")).toBe(
    false,
  );
  expect(page.elements.find((element) => element.placeholder === "you@example.com")).toMatchObject({
    tag: "input",
    role: "textbox",
    name: "Email address",
    text: "",
  });
});

it("keeps the text of a form but never of a data-sensitive subtree or of a field", () => {
  mount(
    "Sign in",
    el(
      "main",
      {},
      el("h1", {}, "Sign in"),
      el(
        "form",
        {},
        el("p", {}, "Enter your password to continue"),
        el("a", { href: "/forgot" }, "Forgot password?"),
        el("textarea", {}, "private draft"),
      ),
      el(
        "div",
        { "data-sensitive": "" },
        el("p", {}, "Card 4111 1111 1111 1111"),
        el("input", { type: "text", "data-testid": "card" }),
        el("input", { type: "password" }),
      ),
    ),
  );
  const page = observePage();
  expect(page.text).toContain("Enter your password to continue");
  expect(page.text).toContain("Forgot password?");
  expect(page.text).not.toContain("private draft");
  expect(page.text).not.toContain("4111");
  // Controls inside the sensitive subtree are not described, but the password field it holds still
  // counts: presence is a fact about the page, not its content.
  expect(page.controls).toEqual([expect.objectContaining({ tag: "textarea" })]);
  expect(page.hasPasswordField).toBe(true);
  expect(page.elements.find((element) => element.href !== null)).toMatchObject({
    tag: "a",
    href: "https://shop.example/forgot",
    text: "Forgot password?",
    role: "link",
  });
});

it("reports no password field when the page has none", () => {
  mount("Home", el("main", {}, el("p", {}, "Welcome"), el("input", { type: "search" })));
  expect(observePage()).toMatchObject({
    title: "Home",
    hasPasswordField: false,
    controls: [{ tag: "input", type: "search", role: "searchbox" }],
  });
});
