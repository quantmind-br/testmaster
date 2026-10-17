/**
 * The `xmlPath` of a response assertion: a subset of XPath 1.0 location paths over a strict, small
 * XML parser. Every function here is self-contained (it reads nothing outside its own body but the
 * other functions of this file, by name), because `xmlPathSource()` embeds their source text in the
 * Playwright fixtures module and in the exported TypeScript runtime: the runner, generated code and
 * an export all evaluate a path with the same code.
 *
 * Paths: absolute steps `/name` (child) and `//name` (descendant), `*` for any element, a 1-based
 * position `[n]` per parent, and a last step `@name` (or `@*`) that selects attributes. Names match
 * local names: a namespace prefix in the path or the document is ignored, and so is a default
 * namespace. The parser never processes a DTD: a DOCTYPE without an internal subset is skipped, one
 * with an internal subset is refused, and only the predefined and numeric character references are
 * decoded, so no entity is ever expanded.
 */
export interface XmlPathStep {
  axis: "child" | "descendant";
  attribute: boolean;
  /** Local name; null for `*`. */
  name: string | null;
  position: number | null;
}
export interface XmlElementNode {
  name: string;
  attributes: [string, string][];
  children: (XmlElementNode | string)[];
  order: number;
}
/** What a path selects: how many nodes, and the string value of the first one (null when none). */
export interface XmlSelection {
  count: number;
  text: string | null;
}

/** The steps of `path`; throws an Error naming the character where the path stops being valid. */
export function parseXmlPath(path: string): XmlPathStep[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 512)
    throw new Error("An xmlPath is 1 to 512 characters");
  const steps: XmlPathStep[] = [];
  const name = /(?:[\p{L}_][\p{L}\p{N}_.-]*:)?([\p{L}_][\p{L}\p{N}_.-]*)/uy;
  const position = /\[([1-9][0-9]{0,8})\]/y;
  let at = 0;
  while (at < path.length) {
    const previous = steps[steps.length - 1];
    if (previous?.attribute)
      throw new Error(`xmlPath ${path}: an attribute step (@name) must be the last step`);
    let axis: "child" | "descendant";
    if (path.startsWith("//", at)) {
      axis = "descendant";
      at += 2;
    } else if (path[at] === "/") {
      axis = "child";
      at += 1;
    } else if (at === 0)
      throw new Error(`xmlPath ${path} must be absolute: it starts with / or //`);
    else
      throw new Error(
        `xmlPath ${path}: expected / or // at character ${at + 1} (functions, predicates other than [n] and axes are not supported)`,
      );
    const attribute = path[at] === "@";
    if (attribute) at += 1;
    let local: string | null = null;
    if (path[at] === "*") at += 1;
    else {
      name.lastIndex = at;
      const match = name.exec(path);
      if (!match) throw new Error(`xmlPath ${path}: expected a name or * at character ${at + 1}`);
      local = match[1] as string;
      at = name.lastIndex;
    }
    let index: number | null = null;
    if (path[at] === "[") {
      position.lastIndex = at;
      const match = attribute ? null : position.exec(path);
      if (!match)
        throw new Error(
          `xmlPath ${path}: only a positive element position [n] is accepted at character ${at + 1}`,
        );
      index = Number(match[1]);
      at = position.lastIndex;
    }
    steps.push({ axis, attribute, name: local, position: index });
  }
  return steps;
}

/** Decodes the predefined and numeric references of XML character data; any other is refused. */
export function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&<\s]{0,32});|&/g, (whole: string, reference: string | undefined) => {
    if (reference === undefined)
      throw new Error("Not well-formed XML: an & that starts no character reference");
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };
    if (Object.hasOwn(named, reference)) return named[reference] as string;
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(reference);
    if (numeric) {
      const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new Error(`Not well-formed XML: ${whole} is not a character`);
      return String.fromCodePoint(code);
    }
    throw new Error(
      `Not well-formed XML: undeclared entity ${whole.slice(0, 40)} (entities are never expanded)`,
    );
  });
}

/** The root element of `xml`; throws an Error that names why the text is not well-formed XML. */
export function parseXmlDocument(xml: string): XmlElementNode {
  const local = (qualified: string) => qualified.slice(qualified.lastIndexOf(":") + 1);
  const stack: XmlElementNode[] = [];
  const start = /<([^\s/>!?"'=<]+)/y;
  const attribute = /\s+([^\s/>"'=<]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  const close = /\s*(\/?)>/y;
  const end = /<\/([^\s>]+)\s*>/y;
  let root: XmlElementNode | undefined;
  let order = 0;
  let at = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (reason: string): never => {
    throw new Error(`Not well-formed XML at character ${at + 1}: ${reason}`);
  };
  const skipTo = (marker: string, what: string) => {
    const found = xml.indexOf(marker, at);
    if (found < 0) fail(`unclosed ${what}`);
    at = found + marker.length;
  };
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    const stop = open < 0 ? xml.length : open;
    if (stop > at) {
      const chunk = xml.slice(at, stop);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(decodeXmlText(chunk));
      else if (chunk.trim()) fail("text outside the root element");
      at = stop;
      continue;
    }
    if (xml.startsWith("<!--", at)) skipTo("-->", "comment");
    else if (xml.startsWith("<![CDATA[", at)) {
      const parent = stack[stack.length - 1];
      if (!parent) fail("CDATA outside the root element");
      const found = xml.indexOf("]]>", at + 9);
      if (found < 0) fail("unclosed CDATA section");
      parent?.children.push(xml.slice(at + 9, found));
      at = found + 3;
    } else if (xml.startsWith("<?", at)) skipTo("?>", "processing instruction");
    else if (xml.startsWith("<!DOCTYPE", at)) {
      if (root || stack.length) fail("a DOCTYPE after the root element");
      let quote = "";
      let index = at + 9;
      for (; index < xml.length; index++) {
        const character = xml[index] as string;
        if (quote) {
          if (character === quote) quote = "";
        } else if (character === '"' || character === "'") quote = character;
        else if (character === "[") fail("a DOCTYPE internal subset is never processed");
        else if (character === ">") break;
      }
      if (index >= xml.length) fail("unclosed DOCTYPE");
      at = index + 1;
    } else if (xml.startsWith("<!", at)) fail("an unsupported markup declaration");
    else if (xml.startsWith("</", at)) {
      end.lastIndex = at;
      const match = end.exec(xml);
      if (!match) fail("a malformed end tag");
      const element = stack.pop();
      if (!element || element.name !== match?.[1])
        fail(`end tag </${match?.[1]}> does not close the open element`);
      at = end.lastIndex;
    } else {
      start.lastIndex = at;
      const match = start.exec(xml);
      if (!match) fail("a malformed start tag");
      if (root && !stack.length) fail("a second root element");
      const element: XmlElementNode = {
        name: match?.[1] as string,
        attributes: [],
        children: [],
        order: order++,
      };
      at = start.lastIndex;
      const seen = new Set<string>();
      for (;;) {
        attribute.lastIndex = at;
        const pair = attribute.exec(xml);
        if (!pair) break;
        at = attribute.lastIndex;
        const qualified = pair[1] as string;
        if (seen.has(qualified)) fail(`attribute ${qualified} repeated`);
        seen.add(qualified);
        if (qualified === "xmlns" || qualified.startsWith("xmlns:")) continue;
        element.attributes.push([local(qualified), decodeXmlText(pair[2] ?? pair[3] ?? "")]);
      }
      close.lastIndex = at;
      const closing = close.exec(xml);
      if (!closing) fail(`a malformed start tag <${element.name}>`);
      at = close.lastIndex;
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else root = element;
      if (!closing?.[1]) stack.push(element);
    }
  }
  if (stack.length) fail(`element <${stack[stack.length - 1]?.name}> is not closed`);
  if (!root) fail("no root element");
  // Paths match local names; the qualified name was kept only to pair end tags.
  const pending: XmlElementNode[] = [root as XmlElementNode];
  for (let element = pending.pop(); element; element = pending.pop()) {
    element.name = local(element.name);
    for (const child of element.children) if (typeof child !== "string") pending.push(child);
  }
  return root as XmlElementNode;
}

/** XPath string value of an element: the concatenation of its descendant text, in order. */
export function xmlStringValue(element: XmlElementNode): string {
  let text = "";
  const pending: (XmlElementNode | string)[] = [element];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    if (typeof item === "string") text += item;
    else
      for (let index = item.children.length - 1; index >= 0; index--)
        pending.push(item.children[index] as XmlElementNode | string);
  }
  return text;
}

/** Evaluates `path` over the document `xml`. */
export function selectXmlPath(xml: string, path: string): XmlSelection {
  const steps = parseXmlPath(path);
  const root = parseXmlDocument(xml);
  const byOrder = (nodes: XmlElementNode[]) =>
    [...new Set(nodes)].sort((left, right) => left.order - right.order);
  let context: XmlElementNode[] = [{ name: "", attributes: [], children: [root], order: -1 }];
  for (const step of steps) {
    if (step.axis === "descendant") {
      const expanded: XmlElementNode[] = [];
      const pending = [...context];
      for (let node = pending.pop(); node; node = pending.pop()) {
        expanded.push(node);
        for (const child of node.children) if (typeof child !== "string") pending.push(child);
      }
      context = byOrder(expanded);
    }
    if (step.attribute) {
      const values: string[] = [];
      for (const node of context)
        for (const [name, value] of node.attributes)
          if (step.name === null || name === step.name) values.push(value);
      return { count: values.length, text: values[0] ?? null };
    }
    const next: XmlElementNode[] = [];
    for (const node of context) {
      let seen = 0;
      for (const child of node.children) {
        if (typeof child === "string" || (step.name !== null && child.name !== step.name)) continue;
        seen += 1;
        if (step.position === null || seen === step.position) next.push(child);
      }
    }
    context = byOrder(next);
  }
  return { count: context.length, text: context[0] ? xmlStringValue(context[0]) : null };
}

/**
 * JavaScript source of the functions above, for code that cannot import this package: it defines
 * `selectXmlPath(xml, path)` returning `{count, text}` and throwing an Error with the reason.
 */
export function xmlPathSource(): string {
  return [parseXmlPath, decodeXmlText, parseXmlDocument, xmlStringValue, selectXmlPath]
    .map(String)
    .join("\n");
}
