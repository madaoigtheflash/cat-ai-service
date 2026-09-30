const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture(handler = () => ({})) {
  const values = new Map(), calls = [], uploads = []
  const wx = {
    getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, structuredClone(value)), removeStorageSync: key => values.delete(key),
    getFileInfo: value => value.success({ size: 100 }), getImageInfo: value => value.success({ type: 'jpeg' }),
    cloud: {
      callFunction: async value => { calls.push(value); return { result: { ok: true, data: await handler(value.data) } } },
      uploadFile: async value => { uploads.push(value); return { fileID: `cloud://env.bucket/${value.cloudPath}` } },
      getTempFileURL: async value => ({ fileList: value.fileList.map(fileID => ({ fileID, tempFileURL: `https://signed.example/${fileID.split('/').pop()}`, status: 0 })) })
    }
  }
  const box = { wx, module: { exports: {} }, Map, Set, Promise, Date, Math }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/community.js'), 'utf8'), box)
  return { api: box.module.exports, values, calls, uploads, wx }
}

test('public feed never uses the sandbox, and pagination goes to shared service', async () => {
  const f = fixture(() => ({ posts: [], nextCursor: 'next' }))
  const value = await f.api.listPosts({ filter: 'public', cursor: 'previous' })
  assert.equal(value.nextCursor, 'next')
  assert.equal(f.calls[0].name, 'catCommunity')
  assert.equal(f.calls[0].data.filter, 'all')
  assert.equal(f.calls[0].data.cursor, 'previous')
})

test('draft and publish whitelist exclude private archive/recognition/location fields', async () => {
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community/actor/', maxBytes: 5242880 } : { post: { id: 'p1', status: 'approved' } })
  const input = { content: '一只小猫', cat: { name: '奶油', breed: '田园猫', coatColor: '橘白', medical: ['private'], location: { latitude: 1 }, recognition: { secret: true }, id: 'local-id' }, includeCat: true, photos: [], consent: true, requestId: 'intent-one', notes: 'private' }
  f.api.saveDraft(input)
  const stored = JSON.stringify(f.api.getDraft())
  assert.doesNotMatch(stored, /medical|location|recognition|private|local-id/)
  await f.api.publishPost(input)
  const payload = f.calls.find(call => call.data.action === 'publishPost').data
  assert.deepEqual(Object.keys(payload.cat).sort(), ['breed', 'coatColor', 'name'])
  assert.doesNotMatch(JSON.stringify(payload), /medical|location|recognition|private|local-id/)
  assert.equal(f.api.getDraft(), null)
})

test('no photo upload or cloud call happens before explicit public consent', async () => {
  const f = fixture()
  await assert.rejects(f.api.publishPost({ content: 'hello', photos: ['local.jpg'] }), /确认/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.uploads.length, 0)
})

test('text-only publication bypasses mediaContext and upload configuration', async () => {
  const f = fixture(data => {
    assert.equal(data.action, 'publishPost')
    return { post: { id: 'text-only', status: 'approved' } }
  })
  await f.api.publishPost({ content: '今天遇见一只猫', photos: [], requestId: 'text-only-request', consent: true })
  assert.equal(f.calls.length, 1)
  assert.equal(f.uploads.length, 0)
  assert.equal(f.api.getDraft(), null)
})

test('disabled media preserves the photo draft and performs no upload or publication', async () => {
  const f = fixture()
  f.wx.cloud.callFunction = async value => {
    f.calls.push(value)
    assert.equal(value.data.action, 'mediaContext')
    return { result: { ok: false, error: { code: 'MEDIA_DISABLED', message: '照片分享暂未开放，请保留照片草稿。' } } }
  }
  await assert.rejects(f.api.publishPost({ content: '想分享的小猫', photos: ['saved.jpg'], requestId: 'photo-request', consent: true }), error => error.code === 'MEDIA_DISABLED')
  assert.equal(f.calls.length, 1)
  assert.equal(f.uploads.length, 0)
  assert.equal(f.api.getDraft().requestId, 'photo-request')
  assert.equal(f.api.getDraft().photos[0], 'saved.jpg')
})

test('lost publish response preserves request and uploaded files; retry reuses them', async () => {
  let failed = false
  const f = fixture(data => {
    if (data.action === 'mediaContext') return { cloudPathPrefix: 'community-pending/owner/', maxBytes: 5242880 }
    if (!failed) { failed = true; throw new Error('network timeout') }
    return { post: { id: 'p1', status: 'pending' } }
  })
  const input = { content: '猫咪故事', photos: ['local.jpg'], requestId: 'intent-one', consent: true }
  await assert.rejects(f.api.publishPost(input), /连接不上/)
  const kept = f.api.getDraft()
  assert.equal(kept.requestId, 'intent-one')
  assert.equal(f.uploads.length, 1)
  await f.api.publishPost({ ...kept, consent: true })
  assert.equal(f.uploads.length, 1)
  const ids = f.calls.filter(call => call.data.action === 'publishPost').map(call => call.data.requestId)
  assert.deepEqual(ids, ['intent-one', 'intent-one'])
})

test('photo-only upload reports overall task progress and keeps submitting separate from approval', async () => {
  const events = [], removed = [], listeners = []
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'photo-only', status: 'pending' } })
  f.wx.cloud.uploadFile = options => {
    f.uploads.push(options)
    assert.equal(options.config.env, f.api.CLOUD_ENV)
    return {
      onProgressUpdate(listener) {
        listeners.push(listener)
        queueMicrotask(() => {
          listener({ progress: 50 })
          listener({ progress: 20 }) // Never move overall progress backwards.
          listener({ progress: NaN })
          options.success({ fileID: `cloud://env.bucket/${options.cloudPath}` })
          listener({ progress: 90 }) // A late task callback cannot change UI.
        })
      },
      offProgressUpdate: listener => removed.push(listener)
    }
  }
  const result = await f.api.publishPost({ content: '', photos: ['one.jpg', 'two.jpg'], requestId: 'photos-only', consent: true }, { onProgress: event => events.push({ ...event }) })
  assert.equal(result.post.status, 'pending')
  assert.deepEqual(events[0], { phase: 'preparing', completed: 0, total: 2, percent: null })
  assert.deepEqual(events.at(-1), { phase: 'submitting', completed: 2, total: 2, percent: null })
  const uploading = events.filter(event => event.phase === 'uploading')
  assert.deepEqual(uploading.map(event => event.percent), [0, 25, 25, 50, 50, 75, 75, 100])
  assert.equal(removed.length, 2)
  assert.equal(removed[0], listeners[0])
  assert.equal(f.calls.find(call => call.data.action === 'publishPost').data.content, '')
})

test('promise-style upload still publishes when progress observers throw', async () => {
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'ok' } })
  const result = await f.api.publishPost({ photos: ['one.jpg'], consent: true }, { onProgress() { throw new Error('page detached') } })
  assert.equal(result.post.id, 'ok')
  assert.equal(f.uploads.length, 1)
  assert.equal(f.api.getDraft(), null)
})

test('callback and thenable completion settle once and byte progress is supported', async () => {
  const events = []
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'ok' } })
  f.wx.cloud.uploadFile = options => ({
    then(resolve) { queueMicrotask(() => { options.success({ fileID: 'cloud://env.bucket/first' }); resolve({ fileID: 'cloud://env.bucket/second' }) }) },
    onProgressUpdate(listener) { listener({ totalBytesSent: 20, totalBytesExpectedToSend: 100 }); listener({ progress: -2 }); listener({ progress: 101 }) }
  })
  await f.api.publishPost({ photos: ['one.jpg'], consent: true }, { onProgress: event => events.push(event) })
  const publish = f.calls.filter(call => call.data.action === 'publishPost')
  assert.equal(publish.length, 1)
  assert.deepEqual(Array.from(publish[0].data.photos), ['cloud://env.bucket/first'])
  assert.deepEqual(events.filter(event => event.phase === 'uploading').map(event => event.percent), [0, 20, 100])
})

test('failed task retains successful uploads and retry progress counts the reused file', async () => {
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'ok' } })
  let fail = true
  f.wx.cloud.uploadFile = options => {
    f.uploads.push(options)
    queueMicrotask(() => {
      if (fail && options.filePath === 'two.jpg') options.fail({ errMsg: 'network timeout' })
      else options.success({ fileID: `cloud://env.bucket/${options.cloudPath}` })
    })
    return {}
  }
  await assert.rejects(f.api.publishPost({ photos: ['one.jpg', 'two.jpg'], requestId: 'same-intent', consent: true }), /连接不上/)
  assert.equal(f.calls.filter(call => call.data.action === 'publishPost').length, 0)
  const kept = f.api.getDraft()
  assert.equal(Object.keys(kept.uploads).length, 1)
  const events = []
  fail = false
  await f.api.publishPost({ ...kept, consent: true }, { onProgress: event => events.push(event) })
  assert.equal(f.uploads.length, 3)
  const firstUploadEvent = events.find(event => event.phase === 'uploading')
  assert.equal(firstUploadEvent.completed, 1)
  assert.equal(firstUploadEvent.percent, 50)
  assert.equal(f.api.getDraft(), null)
})

test('text-only progress never claims there were photo uploads', async () => {
  const events = []
  const f = fixture(() => ({ post: { id: 'text' } }))
  await f.api.publishPost({ content: '猫咪', photos: [], consent: true }, { onProgress: event => events.push({ ...event }) })
  assert.deepEqual(events, [
    { phase: 'preparing', completed: 0, total: 0, percent: null },
    { phase: 'submitting', completed: 0, total: 0, percent: null }
  ])
})

test('a missing upload result cannot submit or discard the draft', async () => {
  const f = fixture(() => ({ prefix: 'community-pending/owner/' }))
  f.wx.cloud.uploadFile = async () => undefined
  await assert.rejects(f.api.publishPost({ photos: ['one.jpg'], consent: true }), /上传没有完成/)
  assert.ok(f.api.getDraft())
  assert.equal(f.calls.filter(call => call.data.action === 'publishPost').length, 0)
})

test('an old upload finishing cannot overwrite or clear a newer editor draft', async () => {
  let uploaded, start
  const started = new Promise(resolve => { start = resolve })
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'old-post' } })
  f.wx.cloud.uploadFile = options => { uploaded = options; start(); return {} }
  const old = f.api.publishPost({ photos: ['old.jpg'], requestId: 'old-intent', consent: true })
  await started
  f.api.saveDraft({ content: '新编辑的故事', photos: ['new.jpg'], requestId: 'new-intent' })
  const newer = structuredClone(f.api.getDraft())
  await assert.rejects(f.api.publishPost({ ...newer, consent: true }), /上一条动态还在提交/)
  assert.deepEqual(structuredClone(f.api.getDraft()), newer)
  uploaded.success({ fileID: 'cloud://env.bucket/old.jpg' })
  assert.equal((await old).post.id, 'old-post')
  assert.deepEqual(structuredClone(f.api.getDraft()), newer)
  assert.equal(f.calls.filter(call => call.data.action === 'publishPost').length, 1)
})

test('same-intent concurrent publication is deduplicated and still clears its own draft', async () => {
  const f = fixture(data => data.action === 'mediaContext' ? { prefix: 'community-pending/owner/' } : { post: { id: 'same-post' } })
  const input = { photos: ['one.jpg'], requestId: 'same-intent', consent: true }
  const [a, b] = await Promise.all([f.api.publishPost(input), f.api.publishPost(input)])
  assert.equal(a.post.id, b.post.id)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.calls.filter(call => call.data.action === 'publishPost').length, 1)
  assert.equal(f.api.getDraft(), null)
})

test('repeated concurrent comment sends share one invocation and retry key', async () => {
  const f = fixture(data => data.action === 'identity' ? { user: { id: 'real-user' } } : { comment: { id: 'c1' } })
  const [a, b] = await Promise.all([f.api.addComment('p1', '它叫什么'), f.api.addComment('p1', '它叫什么')])
  assert.equal(a.comment.id, b.comment.id)
  assert.equal(f.calls.filter(call => call.data.action === 'addComment').length, 1)
})

test('another comment cannot erase an ambiguous comment retry request', async () => {
  let loseResponse = true
  const committed = new Map()
  const f = fixture(data => {
    if (data.action === 'identity') return { user: { id: 'real-user' } }
    if (!committed.has(data.requestId)) committed.set(data.requestId, data.content)
    if (data.content === '第一条' && loseResponse) { loseResponse = false; throw new Error('network timeout') }
    return { comment: { id: data.requestId } }
  })
  await assert.rejects(f.api.addComment('p1', '第一条'), /连接不上/)
  await f.api.addComment('p2', '第二条')
  await f.api.addComment('p1', '第一条')
  const firstCalls = f.calls.filter(call => call.data.content === '第一条')
  assert.equal(firstCalls[0].data.requestId, firstCalls[1].data.requestId)
  assert.equal(committed.size, 2)
  assert.equal(f.values.has(f.api._test.RETRY_KEY), false)
})

test('interleaved completions remove only their own pending comment', async () => {
  let resolveFirst, startFirst
  const firstStarted = new Promise(resolve => { startFirst = resolve })
  let loseSecond = true
  const f = fixture(data => {
    if (data.action === 'identity') return { user: { id: 'real-user' } }
    if (data.content === '第一条') return new Promise(resolve => { resolveFirst = resolve; startFirst() })
    if (loseSecond) { loseSecond = false; throw new Error('network timeout') }
    return { comment: { id: data.requestId } }
  })
  const first = f.api.addComment('p1', '第一条')
  await firstStarted
  await assert.rejects(f.api.addComment('p2', '第二条'), /连接不上/)
  const failedId = f.calls.find(call => call.data.content === '第二条').data.requestId
  resolveFirst({ comment: { id: 'first' } })
  await first
  assert.deepEqual(Object.values(f.values.get(f.api._test.RETRY_KEY).requests), [failedId])
  await f.api.addComment('p2', '第二条')
  assert.equal(f.calls.filter(call => call.data.content === '第二条').at(-1).data.requestId, failedId)
  assert.equal(f.values.has(f.api._test.RETRY_KEY), false)
})

test('terminal rejection clears only itself and retains interleaved uncertain comments', async () => {
  let resolveRejected, startRejected
  const rejectionStarted = new Promise(resolve => { startRejected = resolve })
  const f = fixture()
  f.wx.cloud.callFunction = async value => {
    f.calls.push(value)
    const data = value.data
    if (data.action === 'identity') return { result: { ok: true, data: { user: { id: 'real-user' } } } }
    if (data.content === '审核拒绝') return new Promise(resolve => { resolveRejected = resolve; startRejected() })
    if (data.content === '网络中断') throw new Error('network timeout')
    return { result: { ok: false, error: { code: data.content === '审核不可用' ? 'MODERATION_UNAVAILABLE' : 'SERVICE_UNAVAILABLE', message: '暂时不可用' } } }
  }
  const rejection = assert.rejects(f.api.addComment('p1', '审核拒绝'), error => error.code === 'CONTENT_REJECTED')
  await rejectionStarted
  for (const content of ['网络中断', '审核不可用', '未知故障']) await assert.rejects(f.api.addComment('p2', content))
  const expected = structuredClone(f.values.get(f.api._test.RETRY_KEY).requests)
  const rejectedKey = 'real-user:' + JSON.stringify({ postId: 'p1', content: '审核拒绝', parentId: '' })
  delete expected[rejectedKey]
  resolveRejected({ result: { ok: false, error: { code: 'CONTENT_REJECTED', message: '评论未通过内容审核' } } })
  await rejection
  assert.deepEqual(f.values.get(f.api._test.RETRY_KEY).requests, expected)
  assert.equal(Object.keys(expected).length, 3)
})

test('legacy retry records migrate and remain scoped to their actor', async () => {
  let actorId = 'bob'
  const f = fixture(data => data.action === 'identity' ? { user: { id: actorId } } : { comment: { id: data.requestId } })
  const payload = JSON.stringify({ postId: 'p1', content: '旧评论', parentId: '' })
  f.values.set(f.api._test.RETRY_KEY, { key: `alice:${payload}`, requestId: 'legacy-comment-intent' })
  await f.api.addComment('p1', '旧评论')
  assert.notEqual(f.calls.find(call => call.data.action === 'addComment').data.requestId, 'legacy-comment-intent')
  assert.equal(f.values.get(f.api._test.RETRY_KEY).requests[`alice:${payload}`], 'legacy-comment-intent')
  actorId = 'alice'
  await f.api.addComment('p1', '旧评论')
  assert.equal(f.calls.filter(call => call.data.action === 'addComment').at(-1).data.requestId, 'legacy-comment-intent')
  assert.equal(f.values.has(f.api._test.RETRY_KEY), false)
})

test('pending comment storage is bounded without evicting unresolved requests', async () => {
  let allow = false
  const f = fixture(data => {
    if (data.action === 'identity') return { user: { id: 'real-user' } }
    if (!allow) throw new Error('network timeout')
    return { comment: { id: data.requestId } }
  })
  for (let index = 0; index < f.api._test.MAX_PENDING_COMMENTS; index += 1) {
    await assert.rejects(f.api.addComment('p1', `待确认 ${index}`), /连接不上/)
  }
  const before = structuredClone(f.values.get(f.api._test.RETRY_KEY))
  await assert.rejects(f.api.addComment('p1', '新评论'), /待确认的评论较多/)
  assert.deepEqual(f.values.get(f.api._test.RETRY_KEY), before)
  assert.equal(f.calls.filter(call => call.data.action === 'addComment').length, f.api._test.MAX_PENDING_COMMENTS)
  allow = true
  await f.api.addComment('p1', '待确认 0')
  await f.api.addComment('p1', '新评论')
  assert.equal(Object.keys(f.values.get(f.api._test.RETRY_KEY).requests).length, f.api._test.MAX_PENDING_COMMENTS - 1)
})

test('unreadable retry storage cannot produce a fresh potentially duplicate comment', async () => {
  const f = fixture(() => ({ user: { id: 'real-user' } }))
  f.wx.getStorageSync = () => { throw new Error('storage unavailable') }
  await assert.rejects(f.api.addComment('p1', '需要重试'), /无法读取评论重试记录/)
  assert.equal(f.calls.filter(call => call.data.action === 'addComment').length, 0)
})

test('only server-signed photo projections are displayed; raw IDs never trigger client signing', async () => {
  const f = fixture()
  f.wx.cloud.getTempFileURL = async () => assert.fail('renewal must recheck getPost access')
  const expires = '2026-09-29T02:05:00.000Z'
  const posts = await f.api._test.resolvePosts([{ photos: ['cloud://env.bucket/photo.jpg', 'https://signed.example/approved.jpg', 'http://invalid.example/p.jpg'], content: 'cloud://private/text.jpg', photoExpiresAt: expires }])
  assert.equal(posts[0].content, 'cloud://private/text.jpg')
  assert.deepEqual(Array.from(posts[0].photos), ['https://signed.example/approved.jpg'])
  assert.equal(posts[0].photosUnavailable, true)
  assert.equal(posts[0].photoExpiresAt, expires)
})

test('signing failure and genuine photo-free posts remain distinguishable on list and detail', async () => {
  const f = fixture(data => data.action === 'listPosts'
    ? { posts: [{ id: 'text-only', photos: [] }, { id: 'has-photo', photos: [], photosUnavailable: true }] }
    : { post: { id: 'has-photo', photos: [], photosUnavailable: true }, comments: [] })
  f.wx.cloud.getTempFileURL = async () => assert.fail('no client signing')
  const feed = await f.api.listPosts()
  assert.equal(feed.posts[0].photosUnavailable, false)
  assert.equal(feed.posts[1].photosUnavailable, true)
  const detail = await f.api.getPost('has-photo')
  assert.equal(detail.post.photosUnavailable, true)
  assert.equal(detail.post.photos.length, 0)
})

test('routes replace knowledge with social without removing native cat features', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'))
  assert.ok(!config.pages.includes('pages/knowledge/index'))
  for (const page of ['home', 'social', 'social-compose', 'social-post', 'identify', 'pets', 'pet-detail', 'pet-edit', 'online', 'relationships', 'garden']) assert.ok(config.pages.includes(`pages/${page}/index`), page)
  assert.deepEqual(config.tabBar.list.map(tab => tab.text), ['聊聊', '猫咪', '社区', '我的'])
})
