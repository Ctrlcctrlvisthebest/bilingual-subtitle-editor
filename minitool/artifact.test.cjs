const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Pass MINITOOL_ARTIFACT or a positional directory to check another build.
const artifact = path.resolve(process.env.MINITOOL_ARTIFACT || process.argv[2] ||
  path.join(__dirname, '..', 'dist', 'minitool'));
const expectedFiles = ['index.html', 'assets/style.css', 'assets/video-placeholder.svg',
  'assets/app.js'].sort();
const allowedTypes = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2', '.json']);

function filesIn(directory, prefix = '') {
  assert.ok(fs.existsSync(directory), 'Build the miniTool artifact before running these checks: ' + directory);
  const files = [];
  for (const name of fs.readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const relative = prefix + name;
    const stat = fs.lstatSync(absolute);
    assert.ok(!stat.isSymbolicLink(), 'The artifact must not contain symlinks: ' + relative);
    if (stat.isDirectory()) files.push(...filesIn(absolute, relative + '/'));
    else {
      assert.ok(stat.isFile(), 'Only regular files can be packaged: ' + relative);
      files.push(relative);
    }
  }
  return files.sort();
}

function read(name) { return fs.readFileSync(path.join(artifact, name), 'utf8'); }
function htmlWithoutComments() { return read('index.html').replace(/<!--[\s\S]*?-->/g, ''); }

function attributes(text) {
  const result = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(text))) {
    const name = match[1].toLowerCase();
    assert.ok(!Object.hasOwn(result, name), 'Duplicate HTML attribute: ' + name);
    result[name] = match[2] === undefined ? match[3] === undefined ? match[4] === undefined ? '' : match[4] : match[3] : match[2];
  }
  return result;
}

function tags(html) {
  return Array.from(html.matchAll(/<([a-z][a-z0-9:-]*)\b([^>]*)>/gi), match =>
    ({ name: match[1].toLowerCase(), attributes: attributes(match[2]) }));
}

function existsResource(value, referringFile) {
  assert.ok(typeof value === 'string' && value.trim(), 'Empty resource reference in ' + referringFile);
  assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(value), 'Resources must be packaged relative paths: ' + value);
  const clean = value.split(/[?#]/)[0];
  if (!clean) return; // A local fragment is not an external resource.
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch (error) { assert.fail('Malformed resource path: ' + value); }
  const absolute = path.resolve(artifact, path.dirname(referringFile), decoded);
  const relative = path.relative(artifact, absolute);
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Resource must stay within the package: ' + value);
  assert.ok(fs.existsSync(absolute) && fs.statSync(absolute).isFile(), 'Missing packaged resource: ' + value);
}

test('the output contains exactly four permitted static files and one root index', () => {
  const files = filesIn(artifact);
  assert.deepEqual(files, expectedFiles);
  assert.deepEqual(files.filter(file => path.extname(file) === '.html'), ['index.html']);
  for (const file of files) {
    assert.ok(allowedTypes.has(path.extname(file).toLowerCase()), 'Unsupported package type: ' + file);
    assert.ok(fs.statSync(path.join(artifact, file)).size > 0, 'Packaged files must not be empty: ' + file);
  }
});

test('HTML uses one external local script with no inline handlers, modules, CSP or navigation', () => {
  const html = htmlWithoutComments();
  assert.match(html, /<!doctype html>/i);
  assert.equal((html.match(/<html\b/gi) || []).length, 1);
  assert.equal((html.match(/<head\b/gi) || []).length, 1);
  assert.equal((html.match(/<body\b/gi) || []).length, 1);
  assert.doesNotMatch(html, /Content-Security-Policy|__\w+__|<\s*(?:iframe|object|embed|form)\b/i);
  const scriptMatches = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi));
  const expectedScripts = ['./assets/app.js'];
  assert.equal(scriptMatches.length, expectedScripts.length);
  assert.equal((html.match(/<script\b/gi) || []).length, scriptMatches.length, 'Every script has a closing tag');
  assert.deepEqual(scriptMatches.map(match => attributes(match[1]).src), expectedScripts);
  for (const match of scriptMatches) {
    const attrs = attributes(match[1]);
    assert.ok(attrs.src, 'Inline scripts are prohibited, including JSON script tags');
    assert.equal(match[2].trim(), '', 'External script tags must not contain inline code');
    assert.ok(!Object.hasOwn(attrs, 'type') || attrs.type === 'text/javascript', 'Module scripts are unavailable');
    existsResource(attrs.src, 'index.html');
  }
  for (const tag of tags(html)) {
    for (const [name, value] of Object.entries(tag.attributes)) {
      assert.ok(!/^on/i.test(name), 'Inline event handler found: ' + name);
      assert.ok(!/^\s*javascript:/i.test(value), 'JavaScript URL is prohibited');
    }
    assert.ok(!Object.hasOwn(tag.attributes, 'download'), 'Downloads are unavailable');
    assert.ok(!Object.hasOwn(tag.attributes, 'target'), 'Opening another window is unavailable');
    if (tag.name === 'input' && tag.attributes.type === 'file') {
      assert.ok(['video/mp4', 'image/png'].includes(tag.attributes.accept), 'The container only selects supported images/video');
    }
  }
});

test('all HTML, SVG, CSS and static script resource references resolve inside the package', () => {
  for (const tag of tags(htmlWithoutComments())) {
    for (const name of ['src', 'href', 'poster']) {
      if (Object.hasOwn(tag.attributes, name)) existsResource(tag.attributes[name], 'index.html');
    }
    assert.ok(!Object.hasOwn(tag.attributes, 'srcset'), 'Responsive external image sources are not needed in this package');
  }
  const svg = read('assets/video-placeholder.svg');
  assert.doesNotMatch(svg, /<\s*(?:script|foreignObject)\b|\bon\w+\s*=/i);
  for (const tag of tags(svg)) {
    for (const name of ['href', 'xlink:href', 'src']) {
      if (Object.hasOwn(tag.attributes, name)) existsResource(tag.attributes[name], 'assets/video-placeholder.svg');
    }
  }
  const styles = [['assets/style.css', read('assets/style.css')], ['index.html',
    Array.from(htmlWithoutComments().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi), match => match[1]).join('\n')]];
  for (const [name, css] of styles) {
    assert.doesNotMatch(css, /@import\b/i, 'Stylesheets are packaged directly');
    for (const match of css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)) {
      existsResource(match[1] || match[2] || match[3], name);
    }
  }
  for (const name of expectedFiles.filter(file => file.endsWith('.js'))) {
    const script = read(name);
    assert.doesNotMatch(script, /["'`]https?:\/\//i, 'No external URL literals belong in runtime scripts');
    for (const match of script.matchAll(/["'](\.\.?\/[A-Za-z0-9_./-]+\.(?:js|css|svg|png|jpg|jpeg|gif|webp|woff2?|json))["']/g)) {
      existsResource(match[1], name);
    }
  }
});

test('runtime scripts contain no unavailable networking, hardware, execution or download APIs', () => {
  const unavailable = [
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|WebAssembly|Worker|SharedWorker|SharedArrayBuffer|OffscreenCanvas|PaymentRequest|Notification|BroadcastChannel|WebTransport)\b/,
    /\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/,
    /navigator\s*\.\s*(?:clipboard|geolocation|bluetooth|usb|hid|serial|credentials|locks|serviceWorker|connection)\b/,
    /\b(?:execCommand|requestFullscreen|webkitRequestFullscreen|requestPointerLock|enumerateDevices|getBattery|getDisplayMedia|requestMIDIAccess|requestStorageAccess|persisted)\s*\(/,
    /\b(?:window|globalThis)\s*\.\s*(?:open|prompt)\s*\(|\bprompt\s*\(/,
    /\.download\s*=|\.setAttribute\s*\(\s*["']download["']/,
    /\.on(?:click|change|timeupdate)\s*=/,
    /\.clearStorage\s*\(/
  ];
  for (const name of expectedFiles.filter(file => file.endsWith('.js'))) {
    const script = read(name);
    for (const pattern of unavailable) assert.doesNotMatch(script, pattern, name + ' has a prohibited API');
    assert.doesNotThrow(() => new vm.Script(script, { filename: name }), 'Packaged script syntax must parse');
  }
});

test('every literal DOM lookup references an existing unique ID', () => {
  const html = htmlWithoutComments();
  const ids = tags(html).filter(tag => Object.hasOwn(tag.attributes, 'id')).map(tag => tag.attributes.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, 'Duplicate DOM IDs can bind controls to the wrong element');
  const script = read('assets/app.js');
  const references = Array.from(script.matchAll(/(?:\$\d*|\bgetElementById)\s*\(\s*(["'])([^"']+)\1\s*\)/g), match => match[2]);
  assert.ok(references.length > 40, 'The generated app must retain its expected DOM controls');
  assert.ok(!references.includes('load') && !references.includes('initial'), 'Removed desktop controls must have no runtime references');
  for (const id of references) assert.ok(unique.has(id), 'App references a missing DOM ID: ' + id);
});

function cssDeclarations(body) {
  return body.split(';').map(item => {
    const separator = item.indexOf(':');
    return separator === -1 ? null : { property: item.slice(0, separator).trim().toLowerCase(), value: item.slice(separator + 1).trim() };
  }).filter(Boolean);
}

function advancedCSS(value) { return /\b(?:min|max|clamp)\s*\(|#[a-f0-9]{8}\b/i.test(value); }

async function runArtifact({ legacy = false } = {}) {
  class Element {
    constructor() {
      Object.assign(this, {
        value: '', textContent: '', style: {}, checked: false, disabled: false,
        hidden: false, selectionStart: 0, clientWidth: 1000, children: [], files: [],
      });
      this.attributes = new Map();
      this.events = new Map();
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) {
      const handlers = this.events.get(name) || [];
      handlers.push(callback);
      this.events.set(name, handlers);
    }
    removeEventListener(name, callback) {
      this.events.set(name, (this.events.get(name) || []).filter(handler => handler !== callback));
    }
    async fire(name) {
      const event = { target: this, preventDefault() {} };
      for (const callback of this.events.get(name) || []) await callback(event);
    }
    click() { return this.fire('click'); }
    closest() { return null; }
    focus() {}
    select() {}
    scrollIntoView() {}
  }
  const elements = new Map();
  for (const tag of tags(htmlWithoutComments())) {
    if (!Object.hasOwn(tag.attributes, 'id')) continue;
    const item = new Element();
    item.id = tag.attributes.id;
    item.value = tag.attributes.value || '';
    item.hidden = Object.hasOwn(tag.attributes, 'hidden');
    elements.set(item.id, item);
  }
  const element = id => {
    assert.ok(elements.has(id), 'Runtime references a missing packaged DOM ID: ' + id);
    return elements.get(id);
  };
  Object.assign(element('video'), {
    currentTime: 0, duration: NaN, readyState: 0, paused: true,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); }, load() {},
  });
  element('importOrder').value = 'auto';
  element('offsetScope').value = 'all';
  element('fineStep').value = '0.1';
  const values = new Map();
  const nativeStore = {
    async getStorage({ key }) { return { errMsg: 'getStorage:ok', data: values.get(key) ?? null }; },
    async setStorage({ key, data }) { values.set(key, data); return { errMsg: 'setStorage:ok' }; },
    async removeStorage({ key }) { values.delete(key); return { errMsg: 'removeStorage:ok' }; },
    async getStorageInfo() { return { errMsg: 'getStorageInfo:ok', keys: [...values.keys()], currentSize: 0, limitSize: 10240 }; },
    async getLaunchOptions() { return { errMsg: 'getLaunchOptions:ok', miniToolEnv: { buildVersion: 9460000 } }; },
  };
  const browserValues = new Map();
  let timer = 0;
  const context = vm.createContext({
    Element,
    document: {
      getElementById: element,
      createElement: () => new Element(),
      addEventListener() {},
      body: new Element(),
      documentElement: new Element(),
    },
    localStorage: {
      get length() { return browserValues.size; },
      key(index) { return [...browserValues.keys()][index] ?? null; },
      getItem(key) { return browserValues.get(key) ?? null; },
      setItem(key, value) { browserValues.set(key, String(value)); },
      removeItem(key) { browserValues.delete(key); },
    },
    xhs: { launchOptions: { miniToolEnv: { buildVersion: 9460000 } }, miniTool: nativeStore },
    navigator: { userAgent: 'miniTool artifact test' },
    crypto: require('node:crypto').webcrypto,
    Blob, URL, TextEncoder, TextDecoder, console,
    setTimeout() { return ++timer; }, clearTimeout() {},
    addEventListener() {},
  });
  context.window = context;
  if (legacy) vm.runInContext('delete Array.prototype.at; delete Object.fromEntries;', context);
  vm.runInContext(read('assets/app.js'), context, { filename: 'assets/app.js' });
  assert.ok(context.MiniEditor && context.MiniEditor.ready, 'The bundled app must expose its initialization promise');
  await context.MiniEditor.ready;
  return { context, fire: (id, event) => element(id).fire(event) };
}

test('CSS preserves Chrome 61 spacing and baseline declarations before modern enhancements', () => {
  const inline = Array.from(htmlWithoutComments().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi), match => match[1]).join('\n');
  const skin = read('assets/style.css');
  assert.match(skin, /\bgrid-gap\s*:/i, 'Grid spacing is supported in Chrome 61 and must be preserved');
  assert.match(skin, /\.row\s*>\s*\*\s*\{[^}]*margin-right\s*:/, 'Flex rows need a margin spacing baseline');
  for (const css of [inline, skin]) {
    const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
    // Leaf blocks also cover rules nested in @media without deleting grid-gap.
    for (const match of uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = cssDeclarations(match[2]);
      const baseline = new Set();
      for (const declaration of declarations) {
        assert.notEqual(declaration.property, 'gap', 'Flex gap has no Chrome 61 layout effect; use margin or grid-gap');
        if (advancedCSS(declaration.value)) {
          assert.ok(baseline.has(declaration.property), 'Modern CSS requires an earlier baseline: ' + match[1].trim() + ' ' + declaration.property);
        } else baseline.add(declaration.property);
      }
    }
  }
});

test('the packaged app starts blank and practice loads only the generic three-row fixture', async () => {
  const { context, fire } = await runArtifact();
  const seed = JSON.parse(JSON.stringify(context.MiniEditor.getProject()));
  assert.equal(seed.editor_id, 'mini-blank');
  assert.equal(seed.title, '空白字幕工程');
  assert.deepEqual(seed.rows, []);
  assert.ok(!Object.hasOwn(seed, 'video') && !Object.hasOwn(seed, 'mediaName'), 'No original media may be bundled');
  const fixture = fs.readFileSync(path.join(__dirname, '..', 'offline', '练习字幕.srt'), 'utf8');
  await fire('miniPractice', 'click');
  assert.equal(context.MiniEditor.getProject().rows.length, 3);
  assert.equal(context.MiniEditor.buildSRT(), fixture);
  assert.equal((fixture.match(/^\d+$/gm) || []).length, 3, 'Only three generic practice rows are packaged');
  const wholeArtifact = expectedFiles.map(read).join('\n');
  assert.doesNotMatch(wholeArtifact, /usmp|KyLqZkfv3BU|USMP字幕|cloudPanel|cloudOwnerKey|leaderKey|inviteToken|groupSecret|组长密钥/i);
  assert.doesNotMatch(wholeArtifact, /\b(?:sg1|sgi1|sgm1)_[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{16,}/);
  assert.doesNotMatch(wholeArtifact, /data:video\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]{16,}/i, 'No embedded video bytes may be shipped');
  for (const tag of tags(htmlWithoutComments()).filter(item => item.name === 'video')) {
    assert.ok(!Object.hasOwn(tag.attributes, 'src'), 'Startup must not load an original video');
  }
});

test('the bundle supplies at, fromEntries and replaceChildren before initializing the editor', async () => {
  const { context } = await runArtifact({ legacy: true });
  const result = vm.runInContext(`(function () {
    var object = Object.fromEntries([['title', '字幕'], ['__proto__', 'safe']]);
    var node = new Element();
    var old = { id: 'old' }, first = { id: 'first' }, second = { id: 'second' };
    node.appendChild(old);
    node.replaceChildren(first, second);
    var children = node.children.map(function (child) { return child.id; });
    node.replaceChildren();
    return JSON.stringify({ first: ['a', 'b'].at(0), last: ['a', 'b'].at(-1), fractional: ['a', 'b'].at(-1.9),
      outside: ['a', 'b'].at(8) === undefined, generic: Array.prototype.at.call({0:'x',length:1},-1),
      title: object.title, safePrototype: Object.getPrototypeOf(object) === Object.prototype,
      ownProto: Object.prototype.hasOwnProperty.call(object, '__proto__') && object.__proto__ === 'safe',
      children: children, emptied: node.children.length === 0 });
  }())`, context);
  assert.deepEqual(JSON.parse(result), { first: 'a', last: 'b', fractional: 'b', outside: true,
    generic: 'x', title: '字幕', safePrototype: true, ownProto: true, children: ['first', 'second'], emptied: true });
});
