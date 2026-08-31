const test = require('node:test')
const assert = require('node:assert/strict')

const core = require('../cloudfunctions/identifyCat/core')

test('owner key is stable, secret-bound, and rejects missing identity', () => {
  const secretA = 'identify-secret-a-at-least-32-bytes-long'
  const secretB = 'identify-secret-b-at-least-32-bytes-long'
  const first = core.makeOwnerKey(secretA, 'openid-a')
  assert.equal(first, core.makeOwnerKey(secretA, 'openid-a'))
  assert.notEqual(first, core.makeOwnerKey(secretB, 'openid-a'))
  assert.notEqual(first, core.makeOwnerKey(secretA, 'openid-b'))
  assert.throws(() => core.makeOwnerKey('', 'openid-a'), /NOT_CONFIGURED/)
  assert.throws(() => core.makeOwnerKey('too-short', 'openid-a'), /NOT_CONFIGURED/)
  assert.throws(() => core.makeOwnerKey(secretA, ''), /IDENTITY_REQUIRED/)
})

test('file declaration accepts only supported MIME and bounded integer size', () => {
  assert.deepEqual(core.normalizeFile({ mime: 'IMAGE/PNG', sizeBytes: 123 }, 1024), {
    mime: 'image/png',
    sizeBytes: 123,
    extension: 'png'
  })
  assert.throws(() => core.normalizeFile({ mime: 'image/gif', sizeBytes: 123 }, 1024), /UNSUPPORTED/)
  assert.throws(() => core.normalizeFile({ mime: 'image/jpeg', sizeBytes: 1025 }, 1024), /INVALID_IMAGE_SIZE/)
  assert.throws(() => core.normalizeFile({ mime: 'image/jpeg', sizeBytes: 1.5 }, 1024), /INVALID_IMAGE_SIZE/)
})

test('upload path is deterministic and fileID must match the full controlled path', () => {
  const owner = core.makeOwnerKey('identify-secret-at-least-32-bytes-long', 'openid')
  const uploadId = core.makeUploadId(owner, 'attempt-1')
  const path = core.makeCloudPath(owner, uploadId, 'jpg')
  assert.equal(uploadId, core.makeUploadId(owner, 'attempt-1'))
  assert.match(path, /^identify-pending\/[a-f0-9]{16}\/identify_[a-f0-9]{28}\/source\.jpg$/)
  assert.equal(core.fileIdMatchesPath(`cloud://env.bucket/${path}`, path), true)
  assert.equal(core.fileIdMatchesPath(`cloud://env.bucket/${path}`, path, 'env'), true)
  assert.equal(core.fileIdMatchesPath(`cloud://other.bucket/${path}`, path, 'env'), false)
  assert.equal(core.fileIdMatchesPath(`cloud://env.bucket/other/${path}`, path), false)
  assert.equal(core.fileIdMatchesPath(`cloud://env.bucket/${path}.bak`, path), false)
  assert.equal(core.fileIdMatchesPath('https://example.test/file.jpg', path), false)
})

test('actual bytes must match declared size and magic MIME', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7])
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const webp = Buffer.from('RIFF1234WEBPmore', 'ascii')

  assert.equal(core.mimeFromMagic(jpeg), 'image/jpeg')
  assert.equal(core.mimeFromMagic(png), 'image/png')
  assert.equal(core.mimeFromMagic(webp), 'image/webp')
  assert.deepEqual(core.validateActualFile(jpeg, { mime: 'image/jpeg', sizeBytes: jpeg.length }, 100), {
    mime: 'image/jpeg',
    sizeBytes: jpeg.length
  })
  assert.throws(() => core.validateActualFile(jpeg, { mime: 'image/png', sizeBytes: jpeg.length }, 100), /TYPE_MISMATCH/)
  assert.throws(() => core.validateActualFile(jpeg, { mime: 'image/jpeg', sizeBytes: jpeg.length + 1 }, 100), /SIZE_MISMATCH/)
  assert.throws(() => core.validateActualFile(Buffer.from('not an image'), { mime: 'image/jpeg', sizeBytes: 12 }, 100), /TYPE_MISMATCH/)
})
