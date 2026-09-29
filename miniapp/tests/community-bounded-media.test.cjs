'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createBoundedMediaDownloader } = require('../cloudfunctions/catCommunity/bounded-media')
const { MAX_IMAGE_BYTES } = require('../cloudfunctions/catCommunity/core')

const ENV = 'community-test-env'
const FILE = `cloud://${ENV}.storage/community-pending/${'a'.repeat(64)}/test-image-0001.jpg`

function fixture(options = {}) {
  const observed = { signs: 0, requests: 0, bytesRead: 0, requestDestroyed: false, responseDestroyed: false }
  const chunks = options.chunks || [Buffer.from([0xff, 0xd8, 0xff, 0x00])]
  const request = (url, config, callback) => {
    observed.requests += 1
    assert.equal(url.protocol, 'https:')
    assert.deepEqual(config, { method: 'GET', headers: { 'Accept-Encoding': 'identity' } })
    const response = new PassThrough()
    response.statusCode = options.status || 200
    response.headers = { ...options.headers }
    const read = response.read.bind(response)
    response.read = size => {
      const value = read(size)
      if (value) observed.bytesRead += value.length
      return value
    }
    const destroyResponse = response.destroy.bind(response)
    response.destroy = (...args) => { observed.responseDestroyed = true; return destroyResponse(...args) }
    const req = new EventEmitter()
    req.destroy = () => { observed.requestDestroyed = true; response.destroy() }
    req.end = () => {
      if (options.hangHeaders) return
      queueMicrotask(() => {
        callback(response)
        if (response.destroyed) return
        if (options.streamError) { response.destroy(new Error('secret-signed-url')); return }
        for (const chunk of chunks) response.write(chunk)
        if (!options.hangBody) response.end()
      })
    }
    return req
  }
  const sign = async input => {
    observed.signs += 1
    assert.deepEqual(input, { fileList: [{ fileID: FILE, maxAge: 60 }] })
    if (options.signHang) return new Promise(() => {})
    if (options.signError) throw new Error('secret-signing-error')
    return { fileList: [{ fileID: FILE, status: 0, tempFileURL: 'https://storage.example.test/signed-photo?token=secret', ...options.signedItem }] }
  }
  const download = createBoundedMediaDownloader({ cloudEnvId: ENV, getTempFileURL: sign, request,
    timeoutMs: options.timeoutMs || 2000, signTimeoutMs: options.signTimeoutMs || 2000 })
  return { observed, download }
}

test('rejects user URLs, foreign or malformed authorities and paths before SDK signing', async () => {
  const f = fixture()
  for (const fileID of ['https://attacker.test/photo.jpg', FILE.replace(ENV, 'foreign-env'), FILE.replace('.storage/', '.storage:443/'),
    FILE.replace('.storage/', '.storage.evil/'), FILE.replace('test-image-0001.jpg', '../secret.jpg'),
    FILE.replace('test-image-0001.jpg', 'encoded%2fsecret.jpg'), FILE.replace('community-pending/', 'private-original/'), `${FILE}\n`]) {
    await assert.rejects(f.download(fileID), error => error.code === 'INVALID_FILE')
  }
  assert.equal(f.observed.signs, 0)
  assert.equal(f.observed.requests, 0)
})

test('accepts only the exact successful SDK item and an unambiguous HTTPS URL', async () => {
  for (const signedItem of [{ fileID: `${FILE}x` }, { status: -1 }, { tempFileURL: 'http://storage.test/a' },
    { tempFileURL: 'https://user:pass@storage.test/a' }, { tempFileURL: 'https://storage.test:444/a' }, { tempFileURL: 'https://storage.test/a#fragment' }]) {
    const f = fixture({ signedItem })
    await assert.rejects(f.download(FILE), error => error.code === 'MEDIA_DOWNLOAD_FAILED')
    assert.equal(f.observed.requests, 0)
  }
})

test('downloads a complete image with or without Content-Length and accepts the exact 5MB boundary', async () => {
  for (const headers of [{}, { 'content-length': '4' }]) {
    const f = fixture({ headers })
    assert.deepEqual(await f.download(FILE), Buffer.from([0xff, 0xd8, 0xff, 0x00]))
    assert.equal(f.observed.bytesRead, 4)
  }
  const f = fixture({ chunks: [Buffer.alloc(MAX_IMAGE_BYTES, 1)], headers: { 'content-length': String(MAX_IMAGE_BYTES) } })
  assert.equal((await f.download(FILE)).length, MAX_IMAGE_BYTES)
  assert.equal(f.observed.bytesRead, MAX_IMAGE_BYTES)
})

test('known oversized objects abort before reading any body byte', async () => {
  const f = fixture({ headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })
  await assert.rejects(f.download(FILE), error => error.code === 'INVALID_FILE')
  assert.equal(f.observed.bytesRead, 0)
  assert.equal(f.observed.requestDestroyed, true)
  assert.equal(f.observed.responseDestroyed, true)
})

test('missing or lying Content-Length cannot exceed the 5MB+1 sentinel read bound', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const f = fixture({ headers, chunks: [Buffer.alloc(MAX_IMAGE_BYTES - 2), Buffer.alloc(5000)] })
    await assert.rejects(f.download(FILE), error => error.code === 'INVALID_FILE')
    assert.equal(f.observed.bytesRead, MAX_IMAGE_BYTES + 1)
    assert.equal(f.observed.requestDestroyed, true)
    assert.equal(f.observed.responseDestroyed, true)
  }
})

test('redirects, partial content, compressed responses, invalid lengths and truncated bodies fail closed', async () => {
  for (const options of [{ status: 302, headers: { location: 'https://attacker.test/secret' } }, { status: 206 },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': 'invalid' } }, { headers: { 'content-length': '5' } }]) {
    const f = fixture(options)
    await assert.rejects(f.download(FILE), error => error.code === 'MEDIA_DOWNLOAD_FAILED')
    assert.equal(f.observed.requests, 1, 'must never follow a redirect')
    assert.equal(f.observed.requestDestroyed, true)
  }
})

test('hard deadlines abort stalled headers and stalled bodies, not only idle sockets', async () => {
  for (const options of [{ hangHeaders: true }, { hangBody: true }]) {
    const f = fixture({ ...options, timeoutMs: 15 })
    await assert.rejects(f.download(FILE), error => error.code === 'MEDIA_TIMEOUT')
    assert.equal(f.observed.requestDestroyed, true)
    assert.equal(f.observed.bytesRead <= MAX_IMAGE_BYTES + 1, true)
  }
})

test('signing timeout/error starts no image transfer and errors expose no provider details', async () => {
  for (const options of [{ signHang: true, signTimeoutMs: 15 }, { signError: true }, { streamError: true }]) {
    const f = fixture(options)
    await assert.rejects(f.download(FILE), error => {
      assert.doesNotMatch(error.message, /secret|token|https:/)
      return ['MEDIA_TIMEOUT', 'MEDIA_DOWNLOAD_FAILED'].includes(error.code)
    })
    if (!options.streamError) assert.equal(f.observed.requests, 0)
  }
})

test('a signing response arriving after its deadline cannot start a late download', async () => {
  let completeSign, requests = 0
  const download = createBoundedMediaDownloader({ cloudEnvId: ENV, signTimeoutMs: 10,
    getTempFileURL: () => new Promise(resolve => { completeSign = resolve }),
    request: () => { requests += 1; assert.fail('late signing must not transfer') }
  })
  await assert.rejects(download(FILE), error => error.code === 'MEDIA_TIMEOUT')
  completeSign({ fileList: [{ fileID: FILE, status: 0, tempFileURL: 'https://storage.example.test/late' }] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 0)
})
