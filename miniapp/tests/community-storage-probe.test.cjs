'use strict'

// Offline tests only. These use no cloud credentials and never issue network requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createStorageProbe, signStorageProbe, ACTION, PROBE_PREFIX } = require('../cloudfunctions/catCommunity/storage-probe')
const { signReview } = require('../cloudfunctions/catCommunity/review')
const { parseContext } = require('../cloudfunctions/catOnline/node_modules/@cloudbase/node-sdk')
const requestContext = require('../cloudfunctions/catCommunity/request-context')

const SECRET = 'offline-storage-probe-signing-secret-not-production'
const START = Date.parse('2026-09-29T00:00:00Z')
const ROOT = path.join(__dirname, '../cloudfunctions/catCommunity')
const JPEG_STUB = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 0xff, 0xd9])

function signed(changes = {}, clock = START) {
  const event = { action: ACTION, requestId: 'ab'.repeat(24), expiresAt: new Date(clock + 240000).toISOString(), ...changes }
  return { ...event, signature: signStorageProbe(event, SECRET) }
}

function fixture(options = {}) {
  const calls = [], files = new Map()
  const media = {
    async sanitize(input) {
      calls.push(['sanitize', input])
      assert.ok(input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      return Buffer.from(JPEG_STUB)
    },
    async upload(cloudPath, bytes) {
      calls.push(['upload', cloudPath])
      const fileID = `cloud://offline-env.test/${cloudPath}`
      files.set(fileID, Buffer.from(bytes))
      return fileID
    },
    async download(fileID) { calls.push(['download', fileID]); return files.get(fileID) },
    ...options.media
  }
  const probe = createStorageProbe({ media, reviewSecret: SECRET, enabled: true, now: () => START, ...options, media })
  return { probe, calls, files }
}

function loadModule(filename, overrides = {}, globals = {}) {
  const localRequire = createRequire(filename), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), ...globals
  }, { filename })
  return module.exports
}

test('probe denies any trusted WeChat caller before checking enablement or accessing media', async () => {
  const f = fixture({ enabled: false })
  const result = await f.probe.handle(signed(), { openid: 'real-wechat-caller' })
  assert.equal(result.error.code, 'FORBIDDEN')
  assert.equal(f.calls.length, 0)
})

test('probe defaults closed; truthy strings and missing or short signing secrets stay closed', async () => {
  for (const options of [{ enabled: undefined }, { enabled: false }, { enabled: 'true' }, { enabled: 1 }, { reviewSecret: '' }, { reviewSecret: 'short' }]) {
    const f = fixture(options)
    assert.equal((await f.probe.handle(signed())).error.code, 'PROBE_DISABLED')
    assert.equal(f.calls.length, 0)
  }
})

test('signature requires the independent storage-probe domain and detects tampering', async () => {
  const f = fixture()
  const valid = signed()
  for (const event of [
    { ...valid, signature: '0'.repeat(64) },
    { ...valid, requestId: 'cd'.repeat(24) },
    { ...valid, expiresAt: new Date(START + 60000).toISOString() },
    { ...valid, signature: signReview(valid, SECRET) }
  ]) assert.equal((await f.probe.handle(event)).error.code, 'FORBIDDEN')
  assert.equal(f.calls.length, 0)
})

test('invalid request nonce, shape and arbitrary destination/content fields are rejected without I/O', async () => {
  const f = fixture()
  const events = [null, [], {}, signed({ requestId: '../arbitrary/path' }), signed({ requestId: 'a'.repeat(65) }), signed({ action: 'reviewPost' })]
  for (const key of ['cloudPath', 'fileID', 'postId', 'fileContent', 'openid', 'bytes', 'cleanup', 'signatureDomain']) events.push({ ...signed(), [key]: 'untrusted' })
  for (const event of events) assert.equal((await f.probe.handle(event)).error.code, 'VALIDATION_ERROR')
  assert.equal(f.calls.length, 0)
})

test('signed expiry must be future and no more than five minutes; malformed times fail closed', async () => {
  const f = fixture()
  for (const expiresAt of ['not-a-date', new Date(START - 1).toISOString(), new Date(START).toISOString(), new Date(START + 300001).toISOString()]) {
    assert.equal((await f.probe.handle(signed({ expiresAt }))).error.code, 'PROBE_EXPIRED')
  }
  assert.equal(f.calls.length, 0)
  assert.equal((await f.probe.handle(signed({ expiresAt: new Date(START + 300000).toISOString() }))).ok, true)
})

test('successful probe uploads only a fixed sanitized image to a random server path and returns cleanup details', async () => {
  const f = fixture()
  const result = await f.probe.handle(signed())
  assert.equal(result.ok, true)
  assert.match(result.data.fileID, /^cloud:\/\/offline-env\.test\/community-approved\/_ownership-probe\/[a-f0-9]{64}\.jpg$/)
  assert.deepEqual(Object.keys(result.data).sort(), ['cleanupRequired', 'fileID', 'sha256', 'sizeBytes'])
  assert.equal(result.data.cleanupRequired, true)
  assert.equal(result.data.sizeBytes, JPEG_STUB.length)
  assert.equal(result.data.sha256, crypto.createHash('sha256').update(JPEG_STUB).digest('hex'))
  assert.deepEqual(f.calls.map(call => call[0]), ['sanitize', 'upload', 'download'])
  assert.equal(f.calls[1][1], result.data.fileID.slice('cloud://offline-env.test/'.length))
  assert.ok(f.calls[1][1].startsWith(PROBE_PREFIX))
  const second = await f.probe.handle(signed())
  assert.notEqual(second.data.fileID, result.data.fileID, 'separate operator probes never overwrite a previous object')
  assert.equal(f.files.size, 2)
})

test('failed or invalid sanitization never allocates an upload destination', async () => {
  for (const sanitize of [async () => null, async () => Buffer.from('not-jpeg'), async () => Buffer.alloc(16385), async () => { throw new Error('private decoder error') }]) {
    const f = fixture({ media: { sanitize } })
    const result = await f.probe.handle(signed())
    assert.equal(result.ok, false)
    assert.equal(result.cleanup, undefined)
    assert.equal(f.calls.length, 0)
    assert.ok(!JSON.stringify(result).includes('private decoder error'))
  }
})

test('upload errors include only the exact generated cleanup path, since a timed-out write may have succeeded', async () => {
  let attempted = ''
  const f = fixture({ media: { async upload(cloudPath) { attempted = cloudPath; throw new Error('credential=private-secret') } } })
  const result = await f.probe.handle(signed())
  assert.equal(result.error.code, 'PROBE_FAILED')
  assert.deepEqual(result.cleanup, { required: true, cloudPath: attempted })
  assert.match(attempted, /^community-approved\/_ownership-probe\/[a-f0-9]{64}\.jpg$/)
  assert.ok(!JSON.stringify(result).includes('private-secret'))
})

test('an invalid upload response is never downloaded or offered as a cleanup file ID', async () => {
  const f = fixture({ media: { async upload() { return 'cloud://elsewhere/private-user-file.jpg' } } })
  const result = await f.probe.handle(signed())
  assert.equal(result.error.code, 'PROBE_UPLOAD_FAILED')
  assert.equal(result.cleanup.fileID, undefined)
  assert.equal(f.calls.some(call => call[0] === 'download'), false)
})

test('readback must have the exact bytes, not just the same length; failures identify only this synthetic file', async () => {
  for (const download of [async () => Buffer.from([0xff, 0xd8, 0xff, 4, 3, 2, 1, 0xff, 0xd9]), async () => Buffer.from('short'), async () => null]) {
    const f = fixture({ media: { download } })
    const result = await f.probe.handle(signed())
    assert.equal(result.error.code, 'PROBE_READBACK_FAILED')
    assert.equal(result.cleanup.required, true)
    assert.ok(result.cleanup.fileID.endsWith(`/${result.cleanup.cloudPath}`))
  }
})

let sharp
try { sharp = require('../cloudfunctions/catOnline/node_modules/sharp') } catch (_) { /* local dependency needed only for the real codec test */ }

test('built-in PNG roundtrips through the actual Sharp sanitizer, without identifying metadata', { skip: !sharp }, async () => {
  const sanitizer = loadModule(path.join(ROOT, 'sanitize.js'), { sharp })
  const f = fixture({ media: { sanitize: sanitizer.sanitizeApprovedImage } })
  const result = await f.probe.handle(signed())
  assert.equal(result.ok, true)
  const metadata = await sharp(f.files.get(result.data.fileID)).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.width, 8)
  assert.equal(metadata.height, 8)
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.xmp, undefined)
})

test('entrypoint uses the literal probe toggle, bounded download wrapper and no post collection; normal media remains closed', async () => {
  let openid = '', uploadCalls = 0, downloadCalls = 0, uploadedBytes
  const env = { CAT_COMMUNITY_STORAGE_PROBE_ENABLED: 'false', CAT_COMMUNITY_MEDIA_ENABLED: 'false',
    CAT_COMMUNITY_OWNER_SECRET: SECRET + '-owner', CAT_COMMUNITY_REVIEW_SECRET: SECRET, CLOUDBASE_ENV_ID: 'offline-env' }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'offline-env', init() {}, getWXContext: () => ({ OPENID: openid, ENV: 'offline-env' }),
    database: () => ({ command: {}, collection() { assert.fail('probe must not access collections') } }),
    async uploadFile({ cloudPath, fileContent }) { uploadCalls += 1; uploadedBytes = Buffer.from(fileContent); return { fileID: `cloud://offline-env.test/${cloudPath}` } },
    async downloadFile() { assert.fail('probe must not perform an unbounded download') },
    async getTempFileURL({ fileList }) {
      assert.equal(fileList.length, 1); assert.equal(fileList[0].maxAge, 60)
      assert.ok(fileList[0].fileID.includes(PROBE_PREFIX))
      return { fileList: [{ fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://probe.offline.invalid/synthetic' }] }
    }
  }
  const bounded = require('../cloudfunctions/catCommunity/bounded-media')
  const entry = loadModule(path.join(ROOT, 'index.js'), {
    'wx-server-sdk': cloud, './sanitize': { async sanitizeApprovedImage() { return Buffer.from(JPEG_STUB) } },
    './request-context': { resolveRequestContext: context => requestContext.resolveRequestContext(context, parseContext) },
    './bounded-media': { createBoundedMediaDownloader: options => bounded.createBoundedMediaDownloader({ ...options,
      request(url, config, callback) {
        downloadCalls += 1
        const response = new (require('node:stream').PassThrough)(), req = new (require('node:events').EventEmitter)()
        response.statusCode = 200; response.headers = { 'content-length': String(uploadedBytes.length) }
        req.destroy = () => response.destroy()
        req.end = () => queueMicrotask(() => { callback(response); if (!response.destroyed) response.end(uploadedBytes) })
        return req
      }
    }) }
  }, { process: { env } })
  const event = signed({}, Date.now())
  const runtime = () => ({ request_id: 'offline-storage-probe-request', namespace: 'offline-env',
    environment: JSON.stringify({ SCF_NAMESPACE: 'offline-env', ...(openid ? { WX_OPENID: openid, WX_APPID: 'wx-offline' } : {}) }) })
  for (const disabled of ['false', 'TRUE', '1', true, undefined]) {
    env.CAT_COMMUNITY_STORAGE_PROBE_ENABLED = disabled
    assert.equal((await entry.main(event, runtime())).error.code, 'PROBE_DISABLED')
  }
  assert.equal(uploadCalls, 0)
  env.CAT_COMMUNITY_STORAGE_PROBE_ENABLED = 'true'
  openid = 'actual-wechat-caller'
  assert.equal((await entry.main(event, runtime())).error.code, 'FORBIDDEN')
  assert.equal((await entry.main({ action: 'mediaContext' }, runtime())).error.code, 'MEDIA_DISABLED')
  assert.equal(uploadCalls, 0)
  openid = ''
  assert.equal((await entry.main(event, runtime())).ok, true)
  assert.equal(uploadCalls, 1)
  assert.equal(downloadCalls, 1)
  assert.equal(env.CAT_COMMUNITY_MEDIA_ENABLED, 'false')
})
