export const typescriptRuntime = String.raw`import { expect, type Page, type Frame, type Locator, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

type Data = any;
export async function executePlan(plan: Data, initialPage: Page, request: APIRequestContext, baseURL: string) {
  if (!baseURL) throw new Error('BASE_URL must be configured');
  const inputs = JSON.parse(process.env.TEST_INPUTS_JSON ?? '{}');
  const variables = new Map<string, Data>(Object.entries(inputs.variables ?? {}));
  const responses = new Map<string, Data>();
  const resources: Data[] = [];
  const downloads = new Map<string, Data>();
  const contentTypes = new Map<string, string>();
  const pages = new Map<string, Page>([['main', initialPage]]);
  let page = initialPage;
  let scope: Page | Frame = page;
  let popupIndex = 0;
  page.context().on('page', popup => {
    const alias = (inputs.popupAliases ?? [])[popupIndex++];
    if (!alias || pages.has(alias)) { void popup.close(); return; }
    pages.set(alias, popup);
  });
  page.context().on('response', response => contentTypes.set(response.url(), response.headers()['content-type']?.split(';')[0] ?? 'application/octet-stream'));
  const value = (ref: Data): Data => {
    if ('literal' in ref) return ref.literal;
    if ('variableRef' in ref && variables.has(ref.variableRef)) return variables.get(ref.variableRef);
    if ('secretRef' in ref) {
      const secret = process.env['SECRET_' + ref.secretRef];
      if (secret !== undefined) return secret;
    }
    if ('artifactRef' in ref) return artifact(ref.artifactRef).bytes;
    throw new Error('Unresolved typed input reference');
  };
  const scalar = (v: Data): string => {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return String(v);
    throw new Error('Expected a scalar input');
  };
  const string = (ref: Data): string => {
    const v = value(ref); if (typeof v !== 'string') throw new Error('Expected a string input'); return v;
  };
  function pointer(v: Data, p = ''): Data {
    if (p === '') return v;
    if (!p.startsWith('/') || /~(?![01])/.test(p)) throw new Error('Invalid JSON Pointer');
    for (const encoded of p.slice(1).split('/')) {
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key) || (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key))) throw new Error('Absent JSON Pointer');
      v = v[key];
    }
    return v;
  }
  function artifact(ref: string): Data {
    const item = inputs.artifacts?.[ref];
    if (!item || !process.env.INPUT_DIR) throw new Error('Artifact reference requires INPUT_DIR and a manifest');
    if (typeof item.path !== 'string' || item.path.split(/[\\/]/).some((p: string) => !p || p === '.' || p === '..') || isAbsolute(item.path)) throw new Error('Unsafe artifact path');
    const root = realpathSync(process.env.INPUT_DIR);
    const path = resolve(root, item.path);
    let parent = root;
    for (const part of item.path.split('/')) { parent = resolve(parent, part); if (lstatSync(parent).isSymbolicLink()) throw new Error('Artifact links are forbidden'); }
    if (relative(root, realpathSync(path)).startsWith('..')) throw new Error('Artifact escapes input directory');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10485760 || stat.size !== item.sizeBytes) throw new Error('Artifact size or file type changed');
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Artifact digest changed');
    return { bytes, mimeType: item.mimeType, name: item.path.split('/').at(-1) };
  }
  const selected = (alias?: string): Page => {
    const p = alias === undefined ? page : pages.get(alias);
    if (!p || p.isClosed()) throw new Error('Unavailable page alias'); return p;
  };
  async function unique(l: Locator, timeout: number): Promise<Locator> {
    expect(await l.count(), 'Locator ambiguity').toBeLessThanOrEqual(1);
    await l.waitFor({state: 'attached', timeout});
    expect(await l.count(), 'Locator uniqueness').toBe(1); return l;
  }
  async function frame(l: Locator, timeout: number): Promise<Frame> {
    const handle = await (await unique(l, timeout)).elementHandle();
    try { const f = await handle?.contentFrame(); if (!f) throw new Error('Locator is not a frame'); return f; }
    finally { await handle?.dispose(); }
  }
  async function locate(spec: Data, timeout: number, base: Data = scope): Promise<Locator> {
    let root = spec.pageAlias === undefined ? base : selected(spec.pageAlias);
    if (spec.frame) root = await frame(await locate(spec.frame, timeout, root), timeout);
    if (spec.container) root = await unique(await locate(spec.container, timeout, root), timeout);
    switch(spec.by) {
      case 'testId': return root.getByTestId(spec.value);
      case 'role': return root.getByRole(spec.role, {name: spec.name, exact: spec.exact});
      case 'label': return root.getByLabel(spec.value, {exact: spec.exact});
      case 'text': return root.getByText(spec.value, {exact: spec.exact});
      case 'placeholder': return root.getByPlaceholder(spec.value, {exact: spec.exact});
      case 'css': return root.locator(spec.value);
      default: throw new Error('Unsupported locator');
    }
  }
  function checkResponse(response: Data, e: Data, p = '') {
    switch(e.predicate) {
      case 'statusIn': expect(e.values).toContain(response.status); break;
      case 'headerEquals': expect(response.headers[e.header.toLowerCase()]).toStrictEqual(value(e.value)); break;
      case 'jsonEquals': expect(pointer(JSON.parse(response.body), p)).toStrictEqual(value(e.value)); break;
      case 'countEquals': { const v = pointer(JSON.parse(response.body), p); expect(Array.isArray(v)).toBe(true); expect(v.length).toBe(e.value); break; }
      default: throw new Error('Unsupported HTTP predicate: ' + e.predicate);
    }
  }
  async function send(input: Data, timeout: number): Promise<Data> {
    const url = new URL(baseURL);
    const parts = input.pathSegments.map((ref: Data) => { const s = scalar(value(ref)); if (s === '.' || s === '..') throw new Error('Dot path segment'); return encodeURIComponent(s); });
    url.pathname = url.pathname.replace(/\/$/, '') + '/' + parts.join('/'); url.search = '';
    for (const pair of input.query ?? []) url.searchParams.append(scalar(value(pair.name)), scalar(value(pair.value)));
    const headers: Data = {};
    for (const [name, ref] of Object.entries(input.headers ?? {})) {
      const v = scalar(value(ref)); const lower = name.toLowerCase();
      if (/[\r\n\u0000]/.test(v) || /^(host|connection|content-length|transfer-encoding|forwarded|via|upgrade|te|trailer)$/.test(lower) || /^(proxy-|x-forwarded-)/.test(lower) || lower in headers) throw new Error('Forbidden header');
      headers[lower] = v;
    }
    let data: Data;
    if (input.body) {
      const b = input.body;
      if (b.kind === 'json') { data = JSON.stringify(value(b.value)); headers['content-type'] ??= 'application/json'; }
      else if (b.kind === 'text') { data = scalar(value(b.value)); headers['content-type'] ??= 'text/plain'; }
      else if (b.kind === 'form') { const f = new URLSearchParams(); for(const pair of b.fields) f.append(scalar(value(pair.name)), scalar(value(pair.value))); data = f.toString(); headers['content-type'] ??= 'application/x-www-form-urlencoded'; }
      else { const a = artifact(b.artifactRef); if(a.mimeType !== b.mimeType) throw new Error('Artifact MIME mismatch'); data = a.bytes; headers['content-type'] ??= b.mimeType; }
      if (Buffer.byteLength(data) > 10485760) throw new Error('Request body limit');
    }
    let target = url.href, method = input.method;
    const expires = Date.now() + timeout;
    for(let redirects = 0; ; redirects++) {
      const remaining = expires - Date.now(); if(remaining <= 0) throw new Error('Request deadline');
      const response = await request.fetch(target, {method, headers, data, timeout:remaining, failOnStatusCode:false, maxRedirects:0});
      const bytes = await response.body(); if(bytes.length > 10485760) throw new Error('Response body limit');
      const status = response.status(), incoming = response.headers();
      await response.dispose();
      if([301,302,303,307,308].includes(status) && incoming.location) {
        if(redirects >= 10) throw new Error('Redirect limit');
        const next = new URL(incoming.location,target);
        if(next.origin !== new URL(target).origin) for(const key of ['authorization','cookie','cookie2','x-api-key','api-key','set-cookie']) delete headers[key];
        if((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) { method = 'GET'; data = undefined; delete headers['content-type']; }
        target = next.href; continue;
      }
      return {status, headers:incoming, body:bytes.toString('utf8')};
    }
  }
  async function perform(step: Data): Promise<void> {
    const i = step.input; const timeout = step.timeoutMs ?? 30000;
    if (step.operation === 'request') {
      const resource = i.resource ? {stepId: step.id, state: 'uncertain'} : undefined;
      if(resource) resources.push(resource);
      const r = await send(i, timeout); responses.set(step.id, r);
      if (resource && r.status >= 200 && r.status < 300 && i.resource.handle !== undefined && i.resource.ownerProof !== undefined) {
        const body = JSON.parse(r.body); const handle = pointer(body, i.resource.handle); const proof = pointer(body, i.resource.ownerProof);
        if(handle === null || handle === '' || proof === null || proof === false || proof === '') throw new Error('Missing ownership evidence');
        variables.set(step.id + '.handle', handle); resource.state = 'created';
      }
      for(const c of i.capture ?? []) {
        let v = c.from === 'jsonPointer' ? pointer(JSON.parse(r.body), c.pointer) : r.headers[c.header.toLowerCase()];
        if(c.from === 'header' && c.valueType !== 'string') { if(c.valueType === 'number') { if(!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(v)) throw new Error('Invalid numeric header capture'); v = Number(v); } else { if(v !== 'true' && v !== 'false') throw new Error('Invalid boolean header capture'); v = v === 'true'; } }
        const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
        if(type !== c.valueType || (type === 'number' && !Number.isFinite(v))) throw new Error('Capture type mismatch');
        variables.set(c.name, v); variables.set(step.id + '.' + c.name, v);
      }
      return;
    }
    if(step.operation === 'assert') {
      const e = step.expectation;
      if('responseStepId' in i) { const r = responses.get(i.responseStepId); if(!r) throw new Error('Missing referenced response'); checkResponse(r,e,i.jsonPointer); return; }
      if(e.predicate === 'urlEquals') { const p = selected(i.pageAlias); const expected = string(e.value); await p.waitForURL(expected,{timeout,waitUntil:'commit'}); expect(p.url()).toBe(expected); return; }
      if(e.predicate === 'downloadMatches') { expect(i.outputName).toBe(e.outputName); const d = downloads.get(i.outputName); if(!d) throw new Error('Missing named download'); for(const key of ['sha256','mimeType','sizeBytes']) if(e[key] !== undefined) expect(d[key]).toBe(e[key]); return; }
      const l = await locate(i.locator,timeout);
      if(e.predicate === 'countEquals') { await expect(l).toHaveCount(e.value,{timeout}); return; }
      if(e.predicate === 'hidden') { expect(await l.count()).toBeLessThanOrEqual(1); await l.waitFor({state:'hidden',timeout}); return; }
      await unique(l,timeout);
      switch(e.predicate) {
        case 'visible': await l.waitFor({state:'visible',timeout}); return;
        case 'enabled': await expect(l).toBeEnabled({timeout}); return;
        case 'textEquals': await expect.poll(() => l.innerText({timeout}),{timeout}).toBe(string(e.value)); return;
        case 'textContains': await expect.poll(() => l.innerText({timeout}),{timeout}).toContain(string(e.value)); return;
        case 'valueEquals': await expect.poll(() => l.inputValue({timeout}),{timeout}).toBe(string(e.value)); return;
        default: throw new Error('Unsupported UI predicate: '+e.predicate);
      }
    }
    switch(step.operation) {
      case 'navigate': await page.goto(new URL(i.path,baseURL).href,{timeout,waitUntil:i.readiness ?? 'load'}); return;
      case 'switchPage': page = selected(i.pageAlias); scope = page; return;
      case 'frame': { const oldScope = scope, oldPage = page; scope = await frame(await locate(i.locator,timeout),timeout); try { await steps(i.childSteps); } finally { scope = oldScope; page = oldPage; } return; }
      case 'drag': await (await unique(await locate(i.source,timeout),timeout)).dragTo(await unique(await locate(i.destination,timeout),timeout),{timeout}); return;
      case 'waitFor': { const deadline = Math.min(timeout,i.deadlineMs); if(i.locator) { const l = await locate(i.locator,deadline); if(i.state === 'visible' || i.state === 'attached') await unique(l,deadline); else expect(await l.count()).toBeLessThanOrEqual(1); await l.waitFor({state:i.state,timeout:deadline}); } else { const url = new URL(i.response.url,baseURL).href; await page.waitForResponse(r => r.url() === url && (i.response.status === undefined || r.status() === i.response.status),{timeout:deadline}); } return; }
      case 'download': { const l = await unique(await locate(i.trigger.input.locator,timeout),timeout); const [d] = await Promise.all([l.page().waitForEvent('download',{timeout}),l.click({timeout})]); const stream = await d.createReadStream(); if(!stream) throw new Error('Missing download stream'); const hash = createHash('sha256'); let sizeBytes = 0; for await(const bytes of stream) { sizeBytes += bytes.length; if(sizeBytes > 10485760) { stream.destroy(); throw new Error('Download size limit'); } hash.update(bytes); } if(await d.failure()) throw new Error('Download failed'); if(downloads.has(i.outputName)) throw new Error('Duplicate download output'); downloads.set(i.outputName,{sha256:hash.digest('hex'),sizeBytes,mimeType:contentTypes.get(d.url()) ?? 'application/octet-stream'}); await d.delete(); return; }
    }
    const l = await unique(await locate(i.locator,timeout),timeout);
    switch(step.operation) {
      case 'click': await l.click({timeout,button:i.button,modifiers:i.modifiers}); return;
      case 'hover': await l.hover({timeout,modifiers:i.modifiers}); return;
      case 'check': await l.check({timeout}); return;
      case 'uncheck': await l.uncheck({timeout}); return;
      case 'fill': await l.fill(string(i.value),{timeout}); return;
      case 'press': await l.press(i.key,{timeout}); return;
      case 'select': await l.selectOption(i.values.map((c: Data) => c.index === undefined ? ('value' in c ? {value:string(c.value)} : {label:string(c.label)}) : {index:c.index}),{timeout}); return;
      case 'upload': await l.setInputFiles(i.artifactRefs.map((ref: string) => {const a = artifact(ref); return {name:a.name,mimeType:a.mimeType,buffer:a.bytes};}),{timeout}); return;
      default: throw new Error('Unsupported operation: '+step.operation);
    }
  }
  async function steps(items: Data[]) { for(const step of items) { if(step.required === false) { try { await perform(step); } catch { /* Optional steps do not satisfy required assertions. */ } } else await perform(step); } }
  try { await steps(plan.steps); }
  finally {
    const errors: unknown[] = [];
    for(const resource of resources.reverse()) {
      const c = (plan.cleanup ?? []).find((entry: Data) => entry.resourceRef === resource.stepId);
      try { if(resource.state !== 'created' || !c) throw new Error('Resource ownership or cleanup unresolved'); checkResponse(await send(c.input,c.deadlineMs),c.successPredicate); }
      catch(error) { errors.push(error); }
    }
    if(errors.length) throw new AggregateError(errors,'Resource cleanup failed or uncertain');
  }
}
`;
