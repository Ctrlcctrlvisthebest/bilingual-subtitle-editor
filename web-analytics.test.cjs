const assert = require('node:assert/strict');
const {test} = require('node:test');

test('analytics only loads on the published editor URL and never on local or other sites', async () => {
  const {initWebAnalytics} = await import('./web-analytics.js');
  const scripts = [];
  const priorWindow = global.window, priorDocument = global.document;
  global.document = {
    createElement(tag) {
      assert.equal(tag, 'script');
      return {attributes: {}, setAttribute(name, value) {this.attributes[name] = value;}};
    },
    body: {appendChild(script) {scripts.push(script);}}
  };
  try {
    for (const url of [
      'file:///Users/example/index.html',
      'http://localhost:8000/',
      'https://example.com/bilingual-subtitle-editor/',
      'https://ctrlcctrlvisthebest.github.io/',
      'https://ctrlcctrlvisthebest.github.io/wordroom/',
      'https://ctrlcctrlvisthebest.github.io/bilingual-subtitle-editor-copy/'
    ]) {
      global.window = {location: new URL(url)};
      initWebAnalytics();
      assert.equal(scripts.length, 0, url);
    }
    for (const path of ['/bilingual-subtitle-editor', '/bilingual-subtitle-editor/', '/bilingual-subtitle-editor/index.html']) {
      global.window = {location: new URL('https://ctrlcctrlvisthebest.github.io' + path)};
      initWebAnalytics();
    }
    assert.equal(scripts.length, 3);
    for (const script of scripts) {
      assert.equal(script.type, 'module');
      assert.equal(script.src, 'https://static.cloudflareinsights.com/beacon.min.js');
      assert.match(JSON.parse(script.attributes['data-cf-beacon']).token, /^[a-f0-9]{32}$/);
    }
  } finally {
    if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
    if (priorDocument === undefined) delete global.document; else global.document = priorDocument;
  }
});
