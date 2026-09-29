const test = require('node:test')
const assert = require('node:assert/strict')
const { signProjectedPhotos, PHOTO_TTL_SECONDS } = require('../cloudfunctions/catCommunity/media-urls')
const START = Date.parse('2026-09-29T02:00:00Z')
const file = i => `cloud://test-environment/approved/${i}.jpg`
const response = photos => ({ ok: true, data: { post: { id: 'post-1', content: '保留故事', photos } } })
const signed = (fileID, maxAge) => ({ fileID, tempFileURL: `https://signed.example/${fileID.split('/').pop()}`, status: 0, ...(maxAge === undefined ? {} : { maxAge }) })

test('signing honours shorter provider lifetime and does not add response latency', async () => {
  let time = START
  const input = response([file(1), file(2)])
  const result = await signProjectedPhotos(input, async request => {
    assert.deepEqual(request.fileList, [1, 2].map(i => ({ fileID: file(i), maxAge: 300 })))
    time += 12000
    return { fileList: [signed(file(1), 60), signed(file(2), 120)] }
  }, () => time)
  assert.equal(result.data.post.photoExpiresAt, new Date(START + 60000).toISOString())
  assert.equal(result.data.post.photos.length, 2)
  assert.equal(result.data.post.photosUnavailable, false)
  assert.deepEqual(input.data.post.photos, [file(1), file(2)])
})

test('missing or longer provider lifetime is bounded by requested local refresh window', async () => {
  for (const ttl of [undefined, 7200]) {
    const result = await signProjectedPhotos(response([file(1)]), async () => ({ fileList: [signed(file(1), ttl)] }), () => START)
    assert.equal(result.data.post.photoExpiresAt, new Date(START + PHOTO_TTL_SECONDS * 1000).toISOString())
  }
})

test('already-expired or explicitly invalid lifetimes never return usable URLs', async () => {
  for (const ttl of [0, -1, null, '60', false, NaN, Infinity]) {
    const result = await signProjectedPhotos(response([file(1)]), async () => ({ fileList: [signed(file(1), ttl)] }), () => START)
    assert.deepEqual(result.data.post.photos, [])
    assert.equal(result.data.post.photoExpiresAt, null)
    assert.equal(result.data.post.photosUnavailable, true)
  }
  let time = START
  const expired = await signProjectedPhotos(response([file(1)]), async () => {
    time += 310000
    return { fileList: [signed(file(1))] }
  }, () => time)
  assert.deepEqual(expired.data.post.photos, [])
  assert.equal(expired.data.post.photosUnavailable, true)
})

test('each post uses its own earliest available expiry with a shared batch and partial failures', async () => {
  const input = { ok: true, data: { posts: [{ id: 'a', photos: [file(1)] }, { id: 'b', photos: [file(2), file(3)] }, { id: 'c', photos: [] }] } }
  const result = await signProjectedPhotos(input, async () => ({ fileList: [signed(file(1), 60), signed(file(2), 180), { ...signed(file(3)), status: 1 }] }), () => START)
  assert.equal(result.data.posts[0].photoExpiresAt, new Date(START + 60000).toISOString())
  assert.equal(result.data.posts[1].photoExpiresAt, new Date(START + 180000).toISOString())
  assert.equal(result.data.posts[1].photosUnavailable, true)
  assert.equal(result.data.posts[2].photosUnavailable, false)
  assert.equal(result.data.posts[2].photoExpiresAt, null)
})

test('batches isolate file IDs and expired earlier batches are omitted when response completes', async () => {
  let time = START
  let batches = 0
  const ids = Array.from({ length: 51 }, (_, i) => file(i))
  const result = await signProjectedPhotos(response(ids), async request => {
    batches += 1
    if (batches === 1) return { fileList: [...request.fileList.map(x => signed(x.fileID, 30)), signed(file(50), 300)] }
    time += 40000
    return { fileList: [] }
  }, () => time)
  assert.equal(batches, 2)
  assert.deepEqual(result.data.post.photos, [])
  assert.equal(result.data.post.photosUnavailable, true)
})

test('signing errors and malformed items retain text, expose no file IDs, and support retry', async () => {
  const input = response([file(1)])
  for (const get of [async () => { throw new Error('private-provider-detail') }, async () => ({ fileList: [null, {}, signed(file(999)), { ...signed(file(1)), tempFileURL: 'http://bad.example/file' }] })]) {
    const result = await signProjectedPhotos(input, get, () => START)
    assert.equal(result.data.post.content, '保留故事')
    assert.equal(result.data.post.photosUnavailable, true)
    assert.equal(JSON.stringify(result).includes('cloud://'), false)
    assert.equal(JSON.stringify(result).includes('private-provider-detail'), false)
  }
  const retry = await signProjectedPhotos(input, async () => ({ fileList: [signed(file(1), 120)] }), () => START)
  assert.equal(retry.data.post.photosUnavailable, false)
  assert.equal(retry.data.post.photos.length, 1)
})

test('no-photo and failed core responses cause no signing request', async () => {
  for (const input of [response([]), { ok: false, error: { code: 'FORBIDDEN' } }, null]) {
    const result = await signProjectedPhotos(input, async () => assert.fail('no signing permitted'))
    assert.equal(result, input)
  }
})
