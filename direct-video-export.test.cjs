const assert = require('node:assert/strict');
const {test} = require('node:test');

const engine = import('./direct-video-export.js');
const library = import('mediabunny');

function globals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
}

// One real H.264 keyframe from the synthetic 640 x 360 fixture, with its AVC configuration.
// The actual pinned muxer builds the MP4; none of its parsing or conversion code is mocked.
const videoFixture = (async () => {
  const {Output, BufferTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedPacket} = await library;
  const target = new BufferTarget(), source = new EncodedVideoPacketSource('avc');
  const output = new Output({format: new Mp4OutputFormat(), target});
  output.addVideoTrack(source);
  await output.start();
  await source.add(new EncodedPacket(new Uint8Array(Buffer.from(
    'AAAAXmWIhAA3//7hA/gU0xJ5iamA/hPVy5G3EpdM2fOQGI9dBXEEYAAAAwAAAwAACqlB57qtjH+h2AAAAwOkAKgEACNhshchqh4ChjrFOIAQIAAAAwAAAwAAAwAAAwAAFvE=', 'base64'
  )), 'key', 0, 1), {decoderConfig: {
    codec: 'avc1.64001e', codedWidth: 640, codedHeight: 360,
    description: new Uint8Array(Buffer.from('AWQAHv/hABpnZAAerNlAoC/5cBEAAAMAAQAAAwA8DxYtlgEABmjr48siwP34+AA=', 'base64')),
  }});
  source.close();
  await output.finalize();
  return new File([target.buffer], 'source.mp4', {type: 'video/mp4'});
})();

function destination() {
  const events = [];
  return {events, handle: {
    name: 'result.mp4',
    async createWritable() {
      events.push('open');
      return {
        async write() {events.push('write');},
        async close() {events.push('close');},
        async abort() {events.push('abort');},
      };
    },
  }};
}

async function options(handle, overrides = {}) {
  return {
    file: await videoFixture, handle, project: {title: '测试工程'}, rows: [],
    range: {start: 0, end: null}, canvas: {getContext: () => ({})},
    signal: new AbortController().signal, onProgress() {}, ...overrides,
  };
}

test('save picker is called within the initiating turn and its cancellation leaves source and destination untouched', async t => {
  const {exportMP4, directExportSupport} = await engine;
  let selected;
  const cancelled = new DOMException('User cancelled', 'AbortError');
  globals(t, {
    VideoEncoder: class {}, VideoDecoder: class {},
    showSaveFilePicker(value) {selected = value; return Promise.reject(cancelled);},
  });
  assert.equal(directExportSupport(), true);
  const target = destination(), pending = exportMP4(await options(target.handle));
  assert.equal(selected.suggestedName, '测试工程-带字幕.mp4');
  assert.deepEqual(selected.types[0].accept, {'video/mp4': ['.mp4']});
  await assert.rejects(pending, error => error === cancelled);
  assert.deepEqual(target.events, []);
});

test('unsupported browser, missing source, aborted request, and original filename are rejected before opening a writable', async t => {
  const {exportMP4, directExportSupport} = await engine;
  let picks = 0;
  const target = destination();
  globals(t, {VideoEncoder: undefined, VideoDecoder: undefined, showSaveFilePicker: undefined});
  assert.equal(directExportSupport(), false);
  await assert.rejects(exportMP4(await options(target.handle)), /Chrome \/ Edge/);
  globalThis.VideoEncoder = class {};
  globalThis.VideoDecoder = class {};
  globalThis.showSaveFilePicker = () => {picks++; return Promise.resolve({...target.handle, name: 'source.mp4'});};
  await assert.rejects(exportMP4(await options(target.handle, {file: undefined})), /载入本地原视频/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportMP4(await options(target.handle, {signal: controller.signal})), {name: 'AbortError'});
  assert.equal(picks, 0);
  await assert.rejects(exportMP4(await options(target.handle)), /不同于原视频/);
  assert.equal(picks, 1);
  assert.deepEqual(target.events, []);
});

test('actual MP4 duration rejects an out-of-source range without touching the destination', async () => {
  const {writeMP4} = await engine;
  for (const range of [{start: 1, end: null}, {start: 0, end: 1.002}]) {
    const target = destination();
    await assert.rejects(writeMP4(await options(target.handle, {range})), /超出原视频时长/);
    assert.deepEqual(target.events, []);
  }
});

test('an actual audio-only WAV and corrupt media are rejected before a destination file is opened', async () => {
  const {writeMP4} = await engine;
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40);
  const audioTarget = destination();
  await assert.rejects(writeMP4(await options(audioTarget.handle, {file: new File([wav], 'sound.wav')})), /没有视频轨/);
  assert.deepEqual(audioTarget.events, []);
  const invalidTarget = destination();
  await assert.rejects(writeMP4(await options(invalidTarget.handle, {file: new File(['not media'], 'corrupt.mp4')})));
  assert.deepEqual(invalidTarget.events, []);
});

test('real conversion without WebCodecs aborts the opened destination and never commits a partial MP4', async t => {
  const {writeMP4} = await engine;
  globals(t, {document: {fonts: {ready: Promise.resolve()}}, VideoEncoder: undefined, VideoDecoder: undefined});
  const target = destination(), value = await options(target.handle);
  await assert.rejects(writeMP4(value), /解码片源或编码 H\.264/);
  assert.equal(value.canvas.width, 640); assert.equal(value.canvas.height, 360);
  assert.deepEqual(target.events, ['open', 'abort']);
});

test('cancellation during font preparation and denied disk access cannot commit output', async t => {
  const {writeMP4} = await engine;
  let ready, fontRequested;
  const waitingForFonts = new Promise(resolve => {fontRequested = resolve;});
  const fontsReady = new Promise(resolve => {ready = resolve;});
  globals(t, {document: {fonts: {get ready() {fontRequested(); return fontsReady;}}}});
  const controller = new AbortController(), target = destination();
  const pending = writeMP4(await options(target.handle, {signal: controller.signal}));
  await waitingForFonts;
  controller.abort(); ready();
  await assert.rejects(pending, {name: 'AbortError'});
  assert.deepEqual(target.events, []);

  const denied = new DOMException('Write permission denied', 'NotAllowedError');
  const deniedHandle = {...target.handle, async createWritable() {throw denied;}};
  await assert.rejects(writeMP4(await options(deniedHandle)), error => error === denied);
  assert.deepEqual(target.events, []);
});
