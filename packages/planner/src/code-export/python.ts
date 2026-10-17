const asyncRuntime = String.raw`import os
import json
import math
import re
import hashlib
from xml.parsers import expat
import time
import secrets
import asyncio
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit, quote, urlencode
import requests


def pointer(value, path=""):
    if path == "":
        return value
    if not path.startswith("/") or re.search(r"~(?![01])", path):
        raise ValueError("Invalid JSON Pointer")
    for token in path[1:].split("/"):
        key = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", key):
                raise ValueError("Invalid array pointer")
            value = value[int(key)]
        elif isinstance(value, dict):
            value = value[key]
        else:
            raise ValueError("Absent JSON Pointer")
    return value


def removes_cookie(attributes):
    values = {}
    for attribute in attributes:
        if attribute.find("=") > 0:
            key, value = attribute.split("=", 1)
            values[key.strip().lower()] = value.strip()
    max_age = values.get("max-age")
    if max_age is not None and re.fullmatch(r"-?\d+", max_age):
        return int(max_age) <= 0
    expires = values.get("expires")
    if expires is None:
        return False
    try:
        moment = parsedate_to_datetime(expires)
    except (TypeError, ValueError):
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment <= datetime.now(timezone.utc)


def json_type(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)) and math.isfinite(value):
        return "number"
    return {str: "string", dict: "object", list: "array"}.get(type(value))


def equal(left, right):
    if json_type(left) != json_type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


XML_NAME = re.compile(r"(?:[^\W\d][\w.-]*:)?([^\W\d][\w.-]*)")
XML_POSITION = re.compile(r"\[([1-9][0-9]{0,8})\]")


def xml_path(path):
    # The TestMaster xmlPath subset: / and //, names matched by local name, *, [n], a last @name or @*.
    if not isinstance(path, str) or not 1 <= len(path) <= 512:
        raise ValueError("An xmlPath is 1 to 512 characters")
    steps = []
    at = 0
    while at < len(path):
        if steps and steps[-1][1]:
            raise ValueError("xmlPath " + path + ": an attribute step (@name) must be the last step")
        if path.startswith("//", at):
            axis, at = "descendant", at + 2
        elif path.startswith("/", at):
            axis, at = "child", at + 1
        else:
            raise ValueError("xmlPath " + path + ": expected / or // at character " + str(at + 1))
        attribute = path.startswith("@", at)
        at += 1 if attribute else 0
        local = None
        if path.startswith("*", at):
            at += 1
        else:
            match = XML_NAME.match(path, at)
            if not match:
                raise ValueError("xmlPath " + path + ": expected a name or * at character " + str(at + 1))
            local, at = match.group(1), match.end()
        position = None
        if path.startswith("[", at):
            match = None if attribute else XML_POSITION.match(path, at)
            if not match:
                raise ValueError("xmlPath " + path + ": only a positive element position [n] is accepted")
            position, at = int(match.group(1)), match.end()
        steps.append((axis, attribute, local, position))
    return steps


def xml_document(text):
    # Expat with no DTD processing: an internal subset or an entity it cannot expand is refused, never resolved.
    document = {"name": "", "attributes": [], "children": [], "order": -1}
    stack = [document]
    counter = [0]

    def doctype(name, system_id, public_id, has_internal_subset):
        if has_internal_subset:
            raise ValueError("a DOCTYPE internal subset is never processed")

    def skipped(name, is_parameter_entity):
        raise ValueError("undeclared entity &" + name + ";")

    def start(name, attributes):
        pairs = [(key.split(":")[-1], value) for key, value in attributes.items() if key != "xmlns" and not key.startswith("xmlns:")]
        element = {"name": name.split(":")[-1], "attributes": pairs, "children": [], "order": counter[0]}
        counter[0] += 1
        stack[-1]["children"].append(element)
        stack.append(element)

    def end(name):
        stack.pop()

    def characters(data):
        stack[-1]["children"].append(data)

    parser = expat.ParserCreate()
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.StartDoctypeDeclHandler = doctype
    parser.SkippedEntityHandler = skipped
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = characters
    parser.Parse(text, True)
    return document


def xml_string(element):
    return "".join(child if isinstance(child, str) else xml_string(child) for child in element["children"])


def document_order(nodes):
    return sorted({node["order"]: node for node in nodes}.values(), key=lambda node: node["order"])


def select_xml(text, path):
    # Returns (count, text of the first node) exactly as the TestMaster runner evaluates xmlPath.
    steps = xml_path(path)
    context = [xml_document(text)]
    for axis, attribute, name, position in steps:
        if axis == "descendant":
            expanded, pending = [], list(context)
            while pending:
                node = pending.pop()
                expanded.append(node)
                pending.extend(child for child in node["children"] if not isinstance(child, str))
            context = document_order(expanded)
        if attribute:
            values = [value for node in context for key, value in node["attributes"] if name is None or key == name]
            return len(values), (values[0] if values else None)
        selected = []
        for node in context:
            elements = [child for child in node["children"] if not isinstance(child, str) and (name is None or child["name"] == name)]
            selected.extend(elements if position is None else elements[position - 1:position])
        context = document_order(selected)
    return len(context), (xml_string(context[0]) if context else None)


class PlanRuntime:
    def __init__(self, base_url, page=None):
        if not base_url:
            raise ValueError("BASE_URL must be configured")
        self.base_url = base_url
        self.inputs = json.loads(os.environ.get("TEST_INPUTS_JSON", "{}"))
        self.variables = dict(self.inputs.get("variables", {}))
        self.page = page
        self.scope = page
        self.pages = {"main": page}
        self.responses = {}
        self.resources = []
        self.downloads = {}
        self.content_types = {}
        self.popup_index = 0
        self.session = requests.Session()
        if page is not None:
            page.context.on("page", self.popup)
            page.context.on("response", self.response)

    def popup(self, page):
        aliases = self.inputs.get("popupAliases", [])
        if self.popup_index >= len(aliases):
            raise ValueError("Unexpected popup")
        alias = aliases[self.popup_index]
        self.popup_index += 1
        if alias in self.pages:
            raise ValueError("Duplicate page alias")
        self.pages[alias] = page

    def response(self, response):
        self.content_types[response.url] = response.headers.get("content-type", "application/octet-stream").split(";")[0]

    def value(self, ref):
        if "literal" in ref:
            return ref["literal"]
        if "variableRef" in ref:
            return self.variables[ref["variableRef"]]
        if "secretRef" in ref:
            return os.environ["SECRET_" + ref["secretRef"]]
        if "artifactRef" in ref:
            return self.artifact(ref["artifactRef"])["buffer"]
        raise ValueError("Unresolved typed input")

    def scalar(self, ref):
        value = self.value(ref)
        if json_type(value) not in ("string", "number", "boolean"):
            raise ValueError("Expected scalar")
        return str(value).lower() if isinstance(value, bool) else str(value)

    def invalid_credential(self, spec):
        token = "testmaster-invalid-" + secrets.token_hex(16)
        if "cookie" in spec:
            return spec["cookie"] + "=" + token
        return token if "scheme" not in spec else spec["scheme"] + " " + token

    def string(self, ref):
        value = self.value(ref)
        if not isinstance(value, str):
            raise ValueError("Expected string")
        return value

    def artifact(self, ref):
        item = self.inputs["artifacts"][ref]
        parts = item["path"].split("/")
        if any(part in ("", ".", "..") for part in parts) or "\\" in item["path"] or Path(item["path"]).is_absolute():
            raise ValueError("Unsafe artifact path")
        root = Path(os.environ["INPUT_DIR"]).resolve(strict=True)
        path = root
        for part in parts:
            path = path / part
            if path.is_symlink():
                raise ValueError("Artifact symlinks forbidden")
        path.resolve(strict=True).relative_to(root)
        stat = path.stat()
        if not path.is_file() or stat.st_nlink != 1 or stat.st_size != item["sizeBytes"] or stat.st_size > 10485760:
            raise ValueError("Artifact file changed")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Artifact digest changed")
        return {"name": path.name, "mimeType": item["mimeType"], "buffer": data}

    def selected(self, alias=None):
        page = self.page if alias is None else self.pages[alias]
        if page is None or page.is_closed():
            raise ValueError("Unavailable page alias")
        return page

    async def unique(self, locator, timeout):
        assert await locator.count() <= 1, "Ambiguous locator"
        await locator.wait_for(state="attached", timeout=timeout)
        assert await locator.count() == 1, "Locator is not unique"
        return locator

    async def frame(self, locator, timeout):
        locator = await self.unique(locator, timeout)
        handle = await locator.element_handle()
        try:
            frame = await handle.content_frame()
            if frame is None:
                raise ValueError("Locator is not a frame")
            return frame
        finally:
            await handle.dispose()

    async def locate(self, spec, timeout, base=None):
        root = self.scope if base is None else base
        if "pageAlias" in spec:
            root = self.selected(spec["pageAlias"])
        if "frame" in spec:
            root = await self.frame(await self.locate(spec["frame"], timeout, root), timeout)
        if "container" in spec:
            root = await self.unique(await self.locate(spec["container"], timeout, root), timeout)
        by = spec["by"]
        if by == "testId":
            return root.get_by_test_id(spec["value"])
        if by == "role":
            options = {k: spec[k] for k in ("name", "exact") if k in spec}
            return root.get_by_role(spec["role"], **options)
        if by == "css":
            return root.locator(spec["value"])
        method = {"label": root.get_by_label, "text": root.get_by_text, "placeholder": root.get_by_placeholder}[by]
        return method(spec["value"], **({"exact": spec["exact"]} if "exact" in spec else {}))

    def check_response(self, response, expectation, path="", xml=None):
        predicate = expectation["predicate"]
        if xml is not None:
            # The first selected node's string value for the text predicates, the node count for the counts.
            count, text = select_xml(response.content.decode("utf-8-sig"), xml)
            if predicate in ("textEquals", "textContains"):
                expected = self.string(expectation["value"])
                assert text is not None and ((expected in text) if predicate == "textContains" else text == expected)
            elif predicate == "countEquals":
                assert count == expectation["value"]
            elif predicate == "countAtLeast":
                assert count >= expectation["value"]
            elif predicate == "countAtMost":
                assert count <= expectation["value"]
            else:
                raise ValueError("xmlPath is read by the text and count predicates only")
        elif predicate == "statusIn":
            assert response.status_code in expectation["values"]
        elif predicate == "headerEquals":
            assert equal(response.headers.get(expectation["header"]), self.value(expectation["value"]))
        elif predicate == "headerMatches":
            header = response.headers.get(expectation["header"])
            assert header is not None and re.search(expectation["pattern"], header, re.ASCII) is not None
        elif predicate == "cookieAbsent":
            assert expectation["name"] not in response.testmaster_cookies
        elif predicate == "jsonEquals":
            assert equal(pointer(response.json(), path), self.value(expectation["value"]))
        elif predicate in ("textEquals", "textContains"):
            # The whole body as strict UTF-8 text without a leading BOM, as the TestMaster runner reads it.
            observed = response.content.decode("utf-8-sig")
            expected = self.string(expectation["value"])
            assert (expected in observed) if predicate == "textContains" else observed == expected
        elif predicate in ("countEquals", "countAtLeast", "countAtMost"):
            value = pointer(response.json(), path)
            assert isinstance(value, list)
            if predicate == "countEquals":
                assert len(value) == expectation["value"]
            elif predicate == "countAtLeast":
                assert len(value) >= expectation["value"]
            else:
                assert len(value) <= expectation["value"]
        else:
            raise ValueError("Unsupported HTTP predicate: " + predicate)

    def send(self, input, timeout):
        parts = [self.scalar(ref) for ref in input["pathSegments"]]
        if any(part in (".", "..") for part in parts):
            raise ValueError("Dot path segment")
        base = urlsplit(self.base_url)
        path = base.path.rstrip("/") + "/" + "/".join(quote(part, safe="~()*!.'-") for part in parts)
        query = urlencode([(self.scalar(pair["name"]), self.scalar(pair["value"])) for pair in input.get("query", [])])
        url = urlunsplit((base.scheme, base.netloc, path, query, ""))
        headers = {}
        for name, ref in input.get("headers", {}).items():
            name = name.lower()
            value = self.invalid_credential(ref["invalidCredential"]) if "invalidCredential" in ref else self.scalar(ref)
            if re.search(r"[\r\n\x00]", value) or name in headers or name in ("host", "connection", "content-length", "transfer-encoding", "forwarded", "via", "upgrade", "te", "trailer") or name.startswith(("proxy-", "x-forwarded-")):
                raise ValueError("Forbidden header")
            headers[name] = value
        body = input.get("body")
        data = None
        if body:
            kind = body["kind"]
            if kind == "json":
                data = json.dumps(self.value(body["value"]), separators=(",", ":"), ensure_ascii=False).encode()
                mime = "application/json"
            elif kind == "text":
                data = self.scalar(body["value"]).encode()
                mime = "text/plain"
            elif kind == "form":
                data = urlencode([(self.scalar(pair["name"]), self.scalar(pair["value"])) for pair in body["fields"]]).encode()
                mime = "application/x-www-form-urlencoded"
            else:
                artifact = self.artifact(body["artifactRef"])
                data, mime = artifact["buffer"], artifact["mimeType"]
                if mime != body["mimeType"]:
                    raise ValueError("Artifact MIME mismatch")
            if len(data) > 10485760:
                raise ValueError("Request body limit")
            headers.setdefault("content-type", mime)
        expires = time.monotonic() + timeout / 1000
        method = input["method"]
        cookies = []
        for redirects in range(11):
            remaining = expires - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Request deadline")
            response = self.session.request(method, url, headers=headers, data=data, timeout=remaining, allow_redirects=False)
            for cookie in response.raw.headers.getlist("Set-Cookie"):
                pair, *attributes = cookie.split(";")
                name = pair.split("=", 1)[0].strip() if "=" in pair else ""
                if name and not removes_cookie(attributes) and name not in cookies:
                    cookies.append(name)
            if len(response.content) > 10485760:
                raise ValueError("Response body limit")
            if input.get("redirect") != "manual" and response.status_code in (301, 302, 303, 307, 308) and "location" in response.headers:
                if redirects == 10:
                    raise ValueError("Redirect limit")
                target = urljoin(url, response.headers["location"])
                before, after = urlsplit(url), urlsplit(target)
                if (before.scheme, before.netloc) != (after.scheme, after.netloc):
                    for key in ("authorization", "cookie", "cookie2", "x-api-key", "api-key", "set-cookie"):
                        headers.pop(key, None)
                    self.session.cookies.clear()
                status = response.status_code
                if (status == 303 and method != "HEAD") or (status in (301, 302) and method == "POST"):
                    method, data = "GET", None
                    headers.pop("content-type", None)
                response.close()
                url = target
                continue
            response.testmaster_cookies = cookies
            return response
        raise ValueError("Redirect limit")

    async def perform(self, step):
        input = step["input"]
        operation = step["operation"]
        timeout = step.get("timeoutMs", 30000)
        if operation == "request":
            resource = {"stepId": step["id"], "state": "uncertain"} if "resource" in input else None
            if resource is not None:
                self.resources.append(resource)
            response = self.send(input, timeout)
            self.responses[step["id"]] = response
            declaration = input.get("resource", {})
            if resource is not None and 200 <= response.status_code < 300 and "handle" in declaration and "ownerProof" in declaration:
                handle = pointer(response.json(), declaration["handle"])
                proof = pointer(response.json(), declaration["ownerProof"])
                if handle is None or handle == "" or proof is None or proof is False or proof == "":
                    raise ValueError("Missing ownership evidence")
                self.variables[step["id"] + ".handle"] = handle
                resource["state"] = "created"
            for capture in input.get("capture", []):
                value = pointer(response.json(), capture["pointer"]) if capture["from"] == "jsonPointer" else response.headers[capture["header"]]
                if capture["from"] == "header" and capture["valueType"] != "string":
                    if capture["valueType"] == "number":
                        if not re.fullmatch(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?", value):
                            raise ValueError("Invalid number header")
                        value = json.loads(value)
                    else:
                        if value not in ("true", "false"):
                            raise ValueError("Invalid boolean header")
                        value = value == "true"
                assert json_type(value) == capture["valueType"], "Capture type mismatch"
                self.variables[capture["name"]] = value
                self.variables[step["id"] + "." + capture["name"]] = value
            return
        if operation == "assert":
            expectation = step["expectation"]
            predicate = expectation["predicate"]
            if "responseStepId" in input:
                self.check_response(self.responses[input["responseStepId"]], expectation, input.get("jsonPointer", ""), input.get("xmlPath"))
                return
            if predicate == "urlEquals":
                page = self.selected(input.get("pageAlias"))
                expected = self.string(expectation["value"])
                await page.wait_for_url(expected, timeout=timeout, wait_until="commit")
                assert page.url == expected
                return
            if predicate == "urlMatches":
                page = self.selected(input.get("pageAlias"))
                pattern = re.compile(expectation["pattern"], re.ASCII)
                await page.wait_for_url(lambda url: pattern.search(url) is not None, timeout=timeout, wait_until="commit")
                return
            if predicate == "downloadMatches":
                assert input["outputName"] == expectation["outputName"]
                download = self.downloads[input["outputName"]]
                for key in ("sha256", "sizeBytes", "mimeType"):
                    if key in expectation:
                        assert download[key] == expectation[key]
                return
            locator = await self.locate(input["locator"], timeout)
            if predicate in ("countEquals", "countAtLeast", "countAtMost"):
                expires = time.monotonic() + timeout / 1000
                while True:
                    observed = await locator.count()
                    if predicate == "countEquals":
                        holds, bound = observed == expectation["value"], ""
                    elif predicate == "countAtLeast":
                        holds, bound = observed >= expectation["value"], "at least "
                    else:
                        holds, bound = observed <= expectation["value"], "at most "
                    if holds:
                        break
                    remaining = expires - time.monotonic()
                    assert remaining > 0, f"Expected count {bound}{expectation['value']}, observed {observed}"
                    await asyncio.sleep(min(0.05, remaining))
                return
            if predicate == "hidden":
                assert await locator.count() <= 1
                await locator.wait_for(state="hidden", timeout=timeout)
                return
            locator = await self.unique(locator, timeout)
            if predicate == "visible":
                await locator.wait_for(state="visible", timeout=timeout)
            elif predicate in ("enabled", "disabled", "textEquals", "textContains", "valueEquals"):
                expected = True if predicate in ("enabled", "disabled") else self.string(expectation["value"])
                expires = time.monotonic() + timeout / 1000
                while True:
                    assert await locator.count() == 1, "Locator is no longer unique"
                    if predicate == "enabled":
                        observed = await locator.is_enabled(timeout=timeout)
                    elif predicate == "disabled":
                        observed = await locator.is_disabled(timeout=timeout)
                    elif predicate == "valueEquals":
                        observed = await locator.input_value(timeout=timeout)
                    else:
                        observed = await locator.inner_text(timeout=timeout)
                    matches = expected in observed if predicate == "textContains" else observed == expected
                    if matches:
                        break
                    remaining = expires - time.monotonic()
                    assert remaining > 0, f"Expected {expected!r}, observed {observed!r}"
                    await asyncio.sleep(min(0.05, remaining))
            else:
                raise ValueError("Unsupported UI predicate: " + predicate)
            return
        if operation == "navigate":
            await self.page.goto(urljoin(self.base_url, input["path"]), timeout=timeout, wait_until=input.get("readiness", "load"))
            return
        if operation == "switchPage":
            self.page = self.selected(input["pageAlias"])
            self.scope = self.page
            return
        if operation == "frame":
            previous_scope, previous_page = self.scope, self.page
            self.scope = await self.frame(await self.locate(input["locator"], timeout), timeout)
            try:
                await self.steps(input["childSteps"])
            finally:
                self.scope, self.page = previous_scope, previous_page
            return
        if operation == "drag":
            source = await self.unique(await self.locate(input["source"], timeout), timeout)
            destination = await self.unique(await self.locate(input["destination"], timeout), timeout)
            await source.drag_to(destination, timeout=timeout)
            return
        if operation == "waitFor":
            timeout = min(timeout, input["deadlineMs"])
            if "locator" in input:
                locator = await self.locate(input["locator"], timeout)
                if input["state"] in ("attached", "visible"):
                    await self.unique(locator, timeout)
                else:
                    assert await locator.count() <= 1
                await locator.wait_for(state=input["state"], timeout=timeout)
            else:
                expected = input["response"]
                async with self.page.expect_response(lambda response: response.url == urljoin(self.base_url, expected["url"]) and ("status" not in expected or response.status == expected["status"]), timeout=timeout) as event:
                    pass
                await event.value
            return
        if operation == "download":
            locator = await self.unique(await self.locate(input["trigger"]["input"]["locator"], timeout), timeout)
            async with locator.page.expect_download(timeout=timeout) as event:
                await locator.click(timeout=timeout)
            download = await event.value
            path = await download.path()
            if await download.failure() or path is None:
                raise ValueError("Download failed")
            if Path(path).stat().st_size > 10485760:
                raise ValueError("Download size limit")
            data = Path(path).read_bytes()
            if input["outputName"] in self.downloads:
                raise ValueError("Duplicate download name")
            self.downloads[input["outputName"]] = {"sizeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "mimeType": self.content_types.get(download.url, "application/octet-stream")}
            await download.delete()
            return
        locator = await self.unique(await self.locate(input["locator"], timeout), timeout)
        if operation == "click":
            await locator.click(timeout=timeout, **{k: input[k] for k in ("button", "modifiers") if k in input})
        elif operation == "hover":
            await locator.hover(timeout=timeout, **({"modifiers": input["modifiers"]} if "modifiers" in input else {}))
        elif operation == "check":
            await locator.check(timeout=timeout)
        elif operation == "uncheck":
            await locator.uncheck(timeout=timeout)
        elif operation == "fill":
            await locator.fill(self.string(input["value"]), timeout=timeout)
        elif operation == "press":
            await locator.press(input["key"], timeout=timeout)
        elif operation == "select":
            options = {}
            for choice in input["values"]:
                key = next(iter(choice))
                options.setdefault(key, []).append(choice[key] if key == "index" else self.string(choice[key]))
            await locator.select_option(timeout=timeout, **options)
        elif operation == "upload":
            await locator.set_input_files([self.artifact(ref) for ref in input["artifactRefs"]], timeout=timeout)
        else:
            raise ValueError("Unsupported operation: " + operation)

    async def steps(self, steps):
        for step in steps:
            if step.get("required", True):
                await self.perform(step)
            else:
                try:
                    await self.perform(step)
                except Exception:
                    pass  # Optional failure never satisfies a required assertion.

    async def run(self, plan):
        try:
            await self.steps(plan["steps"])
        finally:
            errors = []
            for resource in reversed(self.resources):
                cleanup = next((entry for entry in plan.get("cleanup", []) if entry["resourceRef"] == resource["stepId"]), None)
                try:
                    if resource["state"] != "created" or cleanup is None:
                        raise ValueError("Resource ownership or cleanup unresolved")
                    self.check_response(self.send(cleanup["input"], cleanup["deadlineMs"]), cleanup["successPredicate"])
                except Exception as error:
                    errors.append(error)
            self.session.close()
            if errors:
                raise ExceptionGroup("Cleanup failed or uncertain", errors)
`;

export function pythonRuntime(async: boolean): string {
  return async
    ? asyncRuntime
    : asyncRuntime
        .replaceAll("async def ", "def ")
        .replaceAll("async with ", "with ")
        .replaceAll("await ", "")
        .replaceAll("asyncio.sleep(", "time.sleep(");
}
