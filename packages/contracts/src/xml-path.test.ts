import { expect, it } from "vitest";
import { ContractError } from "./registries.js";
import { validatePlanSemantics } from "./validation.js";
import { parseXmlPath, selectXmlPath, xmlPathSource } from "./xml-path.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- feed -->
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:os="http://a9.com/-/spec/opensearch/1.1/">
  <channel>
    <title>SearXNG search: paris</title>
    <os:totalResults>4</os:totalResults>
    <atom:link rel="search" href="/opensearch.xml"/>
    <item><title>One &amp; only</title><link>https://a.example/1</link></item>
    <item><title><![CDATA[Two <b>bold</b>]]></title></item>
    <item><title>Thr<em>ee</em> &#x263A;</title></item>
    <item><title>Four</title><item><title>nested</title></item></item>
  </channel>
</rss>`;
const OPENSEARCH = `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>SearXNG</ShortName>
  <Url type="text/html" template="/search?q={searchTerms}"/>
  <Url type="application/rss+xml" template="/search?q={searchTerms}&amp;format=rss"/>
</OpenSearchDescription>`;

it("selects elements by child, descendant, wildcard and per-parent position, in document order", () => {
  expect(selectXmlPath(RSS, "/rss/channel/item").count).toBe(4);
  // A descendant step also reaches the nested item, after its parent in document order.
  expect(selectXmlPath(RSS, "//item")).toMatchObject({ count: 5 });
  expect(selectXmlPath(RSS, "//item/title").text).toBe("One & only");
  expect(selectXmlPath(RSS, "/rss/channel/item[2]/title").text).toBe("Two <b>bold</b>");
  // [1] is per parent: the first item of the channel and the first item of the fourth item.
  expect(selectXmlPath(RSS, "//item[1]/title")).toEqual({ count: 2, text: "One & only" });
  expect(selectXmlPath(RSS, "/rss/channel/item[4]/item/title").text).toBe("nested");
  expect(selectXmlPath(RSS, "/rss/*/title").text).toBe("SearXNG search: paris");
  expect(selectXmlPath(RSS, "/rss/channel/item[9]")).toEqual({ count: 0, text: null });
  expect(selectXmlPath(RSS, "/channel")).toEqual({ count: 0, text: null });
});

it("matches local names whatever the prefix or default namespace, and reads attributes as a last step", () => {
  expect(selectXmlPath(RSS, "/rss/channel/totalResults").text).toBe("4");
  expect(selectXmlPath(RSS, "/rss/channel/os:totalResults").text).toBe("4");
  expect(selectXmlPath(RSS, "//atom:link/@href").text).toBe("/opensearch.xml");
  expect(selectXmlPath(OPENSEARCH, "/OpenSearchDescription/ShortName").text).toBe("SearXNG");
  expect(selectXmlPath(OPENSEARCH, "//Url/@template")).toEqual({
    count: 2,
    text: "/search?q={searchTerms}",
  });
  expect(selectXmlPath(OPENSEARCH, "//Url[2]/@template").text).toBe(
    "/search?q={searchTerms}&format=rss",
  );
  // Namespace declarations are not attributes.
  expect(selectXmlPath(OPENSEARCH, "/OpenSearchDescription/@*").count).toBe(0);
  expect(selectXmlPath(RSS, "/rss/@version").text).toBe("2.0");
});

it("reads the string value of mixed content, CDATA and character references", () => {
  expect(selectXmlPath(RSS, "/rss/channel/item[3]/title").text).toBe("Three ☺");
  expect(selectXmlPath(RSS, "/rss/channel/item[4]").text).toBe("Fournested");
});

it("refuses text that is not well-formed XML and never expands an entity", () => {
  for (const [body, reason] of [
    ['{"results": []}', "text outside the root element"],
    ["<a><b></a>", "does not close"],
    ["<a>", "is not closed"],
    ["<a/><b/>", "a second root element"],
    ["<a x='1' x='2'/>", "repeated"],
    ["<a>&nbsp;</a>", "undeclared entity &nbsp;"],
    ["<a>AT&T</a>", "an & that starts no character reference"],
    ["<a>&#0;</a>", "is not a character"],
    ['<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>', "a DOCTYPE internal subset is never processed"],
    ['<!DOCTYPE a SYSTEM "http://evil.example/a.dtd"><a>&x;</a>', "undeclared entity &x;"],
    ["", "no root element"],
  ])
    expect(() => selectXmlPath(body, "/a"), body).toThrow(reason);
  // A DOCTYPE without an internal subset is skipped.
  expect(selectXmlPath('<!DOCTYPE a SYSTEM "a.dtd"><a>ok</a>', "/a").text).toBe("ok");
});

it("parses the documented path subset and names where an invalid path stops", () => {
  expect(parseXmlPath("//channel/item[2]/@href")).toEqual([
    { axis: "descendant", attribute: false, name: "channel", position: null },
    { axis: "child", attribute: false, name: "item", position: 2 },
    { axis: "child", attribute: true, name: "href", position: null },
  ]);
  for (const [path, reason] of [
    ["item", "must be absolute"],
    ["/a/@b/c", "must be the last step"],
    ["/a[0]", "positive element position"],
    ["/a[last()]", "positive element position"],
    ["/a/text()", "functions, predicates other than [n] and axes are not supported"],
    ["/a[@x='1']", "positive element position"],
    ["/a/@b[1]", "positive element position"],
    ["/", "expected a name or *"],
    ["", "1 to 512 characters"],
  ])
    expect(() => parseXmlPath(path), path).toThrow(reason);
});

it("embeds a source that evaluates paths exactly like the module", () => {
  const select = new Function(
    `${xmlPathSource()}\nreturn selectXmlPath;`,
  )() as typeof selectXmlPath;
  for (const path of ["/rss/channel/item", "//item[1]/title", "//atom:link/@href"])
    expect(select(RSS, path), path).toEqual(selectXmlPath(RSS, path));
  expect(() => select("<a>", "/a")).toThrow("is not closed");
});

it("plan validation accepts xmlPath on text and count response checks and refuses it with jsonPointer, another predicate or a bad path", () => {
  const plan = (input: Record<string, unknown>, expectation: Record<string, unknown>) => ({
    schemaVersion: "1.0.0",
    kind: "executable",
    name: "Feed",
    runner: "http",
    requirementRefs: [],
    steps: [
      {
        id: "feed",
        kind: "action",
        operation: "request",
        input: { method: "GET", pathSegments: [{ literal: "rss" }] },
      },
      {
        id: "check",
        kind: "assertion",
        operation: "assert",
        input: { responseStepId: "feed", ...input },
        expectation,
      },
    ],
  });
  const issues = (input: Record<string, unknown>, expectation: Record<string, unknown>) => {
    try {
      validatePlanSemantics(plan(input, expectation) as never);
      return [];
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return error.issues.map((issue) => issue.path);
    }
  };
  expect(issues({ xmlPath: "//item" }, { predicate: "countEquals", value: 4 })).toEqual([]);
  expect(
    issues(
      { xmlPath: "/OpenSearchDescription/ShortName" },
      {
        predicate: "textEquals",
        value: { literal: "SearXNG" },
      },
    ),
  ).toEqual([]);
  expect(
    issues({ xmlPath: "//item", jsonPointer: "/items" }, { predicate: "countEquals", value: 4 }),
  ).toContain("/steps/1/input/xmlPath");
  expect(
    issues({ xmlPath: "//item" }, { predicate: "jsonEquals", value: { literal: 4 } }),
  ).toContain("/steps/1/input/xmlPath");
  expect(issues({ xmlPath: "item" }, { predicate: "countEquals", value: 4 })).toContain(
    "/steps/1/input/xmlPath",
  );
});
