'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createPhotoRecovery, mediaOf, expired } = require('../utils/community-photo-recovery')
const { postOf } = require('../components/social-post-card/view-model')

const START = Date.parse('2026-09-30T10:00:00Z')
const ORIGINAL = 'https://media.example.invalid/photo?signature=original'
const UPDATED = 'https://media.example.invalid/photo?signature=renewed'
function post(changes = {}) {
  return { id: 'post-one', status: 'approved', content: '原本的猫咪故事', photos: [ORIGINAL], photoExpiresAt: new Date(START + 300000).toISOString(),
    photosUnavailable: false, author: { nickname: '猫友' }, comments: [{ id: 'comment-one', content: '原本的回应' }], ...changes }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(getPost = async id => ({ post: post({ id, photos: [UPDATED] }) })) {
  let time = START
  const calls = [], states = []
  const recovery = createPhotoRecovery({ getPost: id => { calls.push(id); return getPost(id) }, now: () => time, onChange: state => states.push(state) })
  return { recovery, calls, states, tick: ms => { time += ms } }
}
function currentError(recovery) { const state = recovery.snapshot(); return { imageRevision: state.revision, src: state.media.photos[0] } }
function fail(code = 'NETWORK') { return Object.assign(new Error('synthetic failure'), { code }) }

test('view model keeps expiry and incomplete-photo state across repeated page/card projection', () => {
  const source = post({ photos: [], photosUnavailable: true })
  const value = postOf(postOf(source))
  assert.equal(value.photoExpiresAt, source.photoExpiresAt)
  assert.equal(value.photosUnavailable, true)
  assert.deepEqual(value.photos, [])
})

test('ordinary text-only posts never render an image failure or request a refresh', async () => {
  const f = fixture()
  f.recovery.observe(post({ photos: [], photoExpiresAt: new Date(START - 1).toISOString() }))
  await f.recovery.resume(); await f.recovery.retry()
  assert.deepEqual(await f.recovery.preview(), [])
  assert.equal(f.recovery.snapshot().hasPhotos, false)
  assert.equal(f.recovery.snapshot().canRetry, false)
  assert.equal(f.calls.length, 0)
})

test('unexpired media previews immediately; unknown expiry does not invent a time limit', async () => {
  for (const photoExpiresAt of [null, 'invalid-date', new Date(START + 300000).toISOString()]) {
    const f = fixture(); f.recovery.observe(post({ photoExpiresAt }))
    assert.deepEqual(await f.recovery.preview(), [ORIGINAL])
    assert.equal(f.calls.length, 0)
  }
})

test('returning to a page renews newly expired pictures without a timer', async () => {
  const f = fixture(async () => ({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(START + 600000).toISOString() }) }))
  f.recovery.observe(post())
  await f.recovery.resume()
  assert.equal(f.calls.length, 0)
  f.tick(300001)
  await f.recovery.resume()
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.recovery.snapshot().media.photos, [UPDATED])
})

test('expired preview waits for getPost visibility checks and only returns the renewed URLs', async () => {
  const response = deferred(), f = fixture(() => response.promise)
  f.recovery.observe(post({ photoExpiresAt: new Date(START).toISOString() }))
  const pending = f.recovery.preview()
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  assert.equal(f.recovery.snapshot().loading, true)
  assert.equal(f.recovery.snapshot().canRetry, true)
  response.resolve({ post: post({ photos: [UPDATED] }) })
  assert.deepEqual(await pending, [UPDATED])
  assert.equal(f.recovery.snapshot().loading, false)
  assert.equal(f.recovery.snapshot().failed, false)
})

test('automatic recovery is once per external signature version, not once per internally renewed URL', async () => {
  const f = fixture(); const initial = post()
  f.recovery.observe(initial)
  await f.recovery.imageError(currentError(f.recovery))
  assert.deepEqual(f.recovery.snapshot().media.photos, [UPDATED])
  await f.recovery.imageError(currentError(f.recovery))
  await f.recovery.resume(); await f.recovery.resume()
  f.recovery.observe({ ...initial, commentCount: 2 })
  await f.recovery.resume()
  assert.equal(f.calls.length, 1)
  assert.equal(f.recovery.snapshot().failed, true)
  assert.equal(f.recovery.snapshot().canRetry, true)
  f.recovery.observe(post({ photos: ['https://media.example.invalid/fresh-parent-version'] }))
  await f.recovery.imageError(currentError(f.recovery))
  assert.equal(f.calls.length, 2)
})

test('late image error from an old element cannot poison a renewed photo', async () => {
  const f = fixture(); f.recovery.observe(post())
  const oldError = currentError(f.recovery)
  await f.recovery.imageError(oldError)
  const count = f.states.length
  await f.recovery.imageError(oldError)
  await f.recovery.imageError({ ...currentError(f.recovery), src: ORIGINAL })
  assert.equal(f.states.length, count)
  assert.equal(f.recovery.snapshot().failed, false)
  assert.equal(f.calls.length, 1)
})

test('repeated manual retries and an automatic request share the same in-flight operation', async () => {
  const response = deferred(), f = fixture(() => response.promise)
  f.recovery.observe(post({ photos: [], photosUnavailable: true }))
  const first = f.recovery.resume(), second = f.recovery.retry(), third = f.recovery.retry()
  assert.equal(first, second); assert.equal(second, third)
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  response.resolve({ post: post({ photos: [UPDATED] }) })
  assert.equal(await first, true)
})

test('signing failure without URLs is distinct from a text-only post and stays manually retryable', async () => {
  const f = fixture(async () => ({ post: post({ photos: [], photosUnavailable: true, photoExpiresAt: null }) }))
  f.recovery.observe(post({ photos: [], photosUnavailable: true, photoExpiresAt: null }))
  await f.recovery.resume(); await f.recovery.resume()
  const state = f.recovery.snapshot()
  assert.equal(state.hasPhotos, true)
  assert.equal(state.canRetry, true)
  assert.equal(state.loading, false)
  assert.match(state.message, /重试/)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await f.recovery.preview(), [])
})

test('a shorter or already expired renewed URL cannot be previewed or start an automatic loop', async () => {
  const f = fixture(async () => ({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(START - 1).toISOString() }) }))
  f.recovery.observe(post({ photoExpiresAt: new Date(START - 1).toISOString() }))
  await f.recovery.resume(); await f.recovery.resume()
  assert.equal(f.calls.length, 1)
  assert.equal(f.recovery.snapshot().failed, true)
  assert.deepEqual(await f.recovery.preview(), [])
  assert.equal(f.calls.length, 2, 'the second request is only caused by explicit preview, not a timer')
})

test('permission loss clears old images and disables preview/retry until a new parent version', async () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN', 'AUTH_REQUIRED']) {
    const f = fixture(async () => { throw fail(code) })
    const initial = post(); f.recovery.observe(initial)
    await f.recovery.retry()
    assert.deepEqual(f.recovery.snapshot().media.photos, [])
    assert.equal(f.recovery.snapshot().blocked, true)
    assert.equal(f.recovery.snapshot().canRetry, false)
    f.recovery.observe({ ...initial, commentCount: 3 })
    assert.deepEqual(await f.recovery.preview(), [])
    await f.recovery.resume(); await f.recovery.retry()
    assert.equal(f.calls.length, 1)
  }
})

test('network error preserves retry ability without reporting that photo access was revoked', async () => {
  const f = fixture(async () => { throw fail() }); f.recovery.observe(post())
  assert.equal(await f.recovery.retry(), false)
  assert.equal(f.recovery.snapshot().blocked, false)
  assert.equal(f.recovery.snapshot().canRetry, true)
  assert.match(f.recovery.snapshot().message, /重试/)
})

test('post switch and parent page refresh invalidate older async photo responses', async () => {
  for (const incoming of [post({ id: 'post-two', photos: ['https://media.example.invalid/second'] }), post({ photos: ['https://media.example.invalid/new-parent'], photoExpiresAt: new Date(START + 600000).toISOString() })]) {
    const response = deferred(), f = fixture(() => response.promise)
    f.recovery.observe(post())
    const old = f.recovery.retry(); await Promise.resolve()
    f.recovery.observe(incoming)
    response.resolve({ post: post({ photos: [UPDATED] }) })
    assert.equal(await old, false)
    assert.equal(f.recovery.snapshot().id, incoming.id)
    assert.deepEqual(f.recovery.snapshot().media.photos, incoming.photos)
    assert.equal(f.recovery.snapshot().loading, false)
  }
})

test('detach invalidates requests and suppresses late state writes or preview', async () => {
  const response = deferred(), f = fixture(() => response.promise)
  f.recovery.observe(post())
  const old = f.recovery.retry(); await Promise.resolve()
  f.recovery.dispose()
  const count = f.states.length
  response.resolve({ post: post({ photos: [UPDATED] }) })
  assert.equal(await old, false)
  assert.equal(f.states.length, count)
  assert.deepEqual(await f.recovery.preview(), [])
})

test('raw cloud IDs and arbitrary URLs are never resolved or passed to image preview', async () => {
  assert.deepEqual(mediaOf(post({ photos: ['cloud://private/object', 'http://plain/photo', '/local-photo.jpg'] })).photos, [])
  const f = fixture(async () => ({ post: post({ photos: ['cloud://private/object'] }) }))
  f.recovery.observe(post({ photos: ['cloud://private/object'] }))
  assert.deepEqual(await f.recovery.preview(), [])
  assert.equal(f.recovery.snapshot().media.photosUnavailable, true)
})

test('a response for a different post cannot populate the current card', async () => {
  const f = fixture(async () => ({ post: post({ id: 'other-post', photos: [UPDATED] }) }))
  f.recovery.observe(post())
  assert.equal(await f.recovery.retry(), false)
  assert.deepEqual(f.recovery.snapshot().media.photos, [ORIGINAL])
  assert.equal(f.recovery.snapshot().failed, true)
})

function componentFixture(getPost = async id => ({ post: post({ id, photos: [UPDATED] }) })) {
  const filename = path.join(__dirname, '../components/social-post-card/index.js'), localRequire = createRequire(filename)
  const calls = [], previews = [], writes = []
  let definition
  const wx = { previewImage(options) { previews.push(options); options.success() } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Component(value) { definition = value }, wx,
    require: name => name === '../../services/community' ? { getPost: id => { calls.push(id); return getPost(id) } } : localRequire(name)
  }, { filename })
  const instance = { data: structuredClone(definition.data),
    setData(patch) { writes.push(patch); Object.assign(this.data, patch) }, triggerEvent() {} }
  for (const [name, method] of Object.entries(definition.methods)) instance[name] = method.bind(instance)
  const observe = value => definition.observers.post.call(instance, value)
  const attach = () => definition.lifetimes.attached.call(instance)
  const detach = () => definition.lifetimes.detached.call(instance)
  const show = () => definition.pageLifetimes.show.call(instance)
  const hide = () => definition.pageLifetimes.hide.call(instance)
  return { instance, observe, attach, detach, show, hide, calls, previews, writes, wx }
}

test('component retries only media: story, comments and unrelated draft state are untouched', async () => {
  const f = componentFixture(async () => ({ post: post({ content: 'should not replace read text', comments: [], photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) }))
  const initial = post({ photoExpiresAt: new Date(Date.now() + 300000).toISOString() })
  f.instance.data.draft = '尚未发送的回应'
  f.observe(initial); f.attach()
  await f.instance.retryPhotos()
  assert.equal(f.instance.data.story.content, initial.content)
  assert.equal(f.instance.data.story.comments[0].content, initial.comments[0].content)
  assert.equal(f.instance.data.draft, '尚未发送的回应')
  assert.deepEqual(f.instance.data.story.photos, [UPDATED])
  assert.ok(f.writes.every(patch => !Object.hasOwn(patch, 'draft') && !Object.hasOwn(patch, 'comments') && !Object.hasOwn(patch, 'post')))
})

test('component deduplicates expired-preview taps, waits for renewal, and restores via page show without reloading story', async () => {
  const response = deferred(), f = componentFixture(() => response.promise)
  f.observe(post({ photoExpiresAt: new Date(Date.now() - 1).toISOString() })); f.attach()
  const first = f.instance.previewPhoto(), second = f.instance.previewPhoto()
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(f.calls.length, 1)
  assert.equal(f.previews.length, 0)
  f.show()
  response.resolve({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) })
  await first
  assert.equal(f.calls.length, 1)
  assert.equal(f.previews.length, 1)
  assert.deepEqual(f.previews[0].urls, [UPDATED])
})

test('hidden or detached cards do not open preview after an async renewal', async () => {
  for (const end of ['hide', 'detach']) {
    const response = deferred(), f = componentFixture(() => response.promise)
    f.observe(post({ photoExpiresAt: new Date(Date.now() - 1).toISOString() })); f.attach()
    const preview = f.instance.previewPhoto(); await Promise.resolve()
    f[end]()
    response.resolve({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) })
    assert.equal(await preview, false)
    assert.equal(f.previews.length, 0)
  }
})

test('component forwards image element revision/source and ignores stale failures', async () => {
  const f = componentFixture(async () => ({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) }))
  f.observe(post({ photoExpiresAt: new Date(Date.now() + 300000).toISOString() })); f.attach()
  const event = { currentTarget: { dataset: { revision: f.instance.data.photoRevision, src: ORIGINAL } } }
  await f.instance.onPhotoError(event)
  await f.instance.onPhotoError(event)
  assert.equal(f.calls.length, 1)
  assert.equal(f.instance.data.photoFailed, false)
})

test('native preview callback failure or synchronous failure keeps a clear manual retry state', async () => {
  for (const implementation of [options => options.fail(), () => { throw new Error('native preview failed') }]) {
    const f = componentFixture()
    f.observe(post({ photoExpiresAt: new Date(Date.now() + 300000).toISOString() })); f.attach()
    f.wx.previewImage = implementation
    assert.equal(await f.instance.previewPhoto(), false)
    assert.equal(f.instance.data.photoCanRetry, true)
    assert.match(f.instance.data.photoMessage, /预览/)
  }
})

test('late native preview failure cannot hide a newer photo after same-post renewal', async () => {
  const f = componentFixture(async () => ({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) }))
  const opened = deferred(), nativeCalls = []
  f.wx.previewImage = options => { nativeCalls.push(options); opened.resolve() }
  f.observe(post({ photoExpiresAt: new Date(Date.now() + 300000).toISOString() })); f.attach()
  const oldRevision = f.instance.data.photoRevision
  const oldPreview = f.instance.previewPhoto()
  await opened.promise
  await f.instance.onPhotoError({ currentTarget: { dataset: { revision: oldRevision, src: ORIGINAL } } })
  assert.ok(f.instance.data.photoRevision > oldRevision)
  assert.equal(f.instance.data.photoFailed, false)
  nativeCalls[0].fail()
  assert.equal(await oldPreview, false)
  assert.equal(f.instance.data.photoFailed, false)
  assert.equal(f.instance.data.photoMessage, '')
  assert.deepEqual(f.instance.data.story.photos, [UPDATED])

  const currentOpened = deferred()
  f.wx.previewImage = options => { nativeCalls.push(options); currentOpened.resolve() }
  const currentPreview = f.instance.previewPhoto()
  await currentOpened.promise
  nativeCalls[1].fail()
  assert.equal(await currentPreview, false)
  assert.equal(f.instance.data.photoFailed, true)
  assert.match(f.instance.data.photoMessage, /预览/)
})

test('preview failure after awaiting expiry renewal is bound to the new revision, not the expired one', async () => {
  const response = deferred(), opened = deferred(), f = componentFixture(() => response.promise)
  let nativeCall
  f.wx.previewImage = options => { nativeCall = options; opened.resolve() }
  f.observe(post({ photoExpiresAt: new Date(Date.now() - 1).toISOString() })); f.attach()
  const oldRevision = f.instance.data.photoRevision
  const preview = f.instance.previewPhoto()
  response.resolve({ post: post({ photos: [UPDATED], photoExpiresAt: new Date(Date.now() + 300000).toISOString() }) })
  await opened.promise
  assert.ok(f.instance.data.photoRevision > oldRevision)
  nativeCall.fail()
  assert.equal(await preview, false)
  assert.equal(f.instance.data.photoFailed, true)
  assert.equal(f.instance.data.photoCanRetry, true)
  assert.match(f.instance.data.photoMessage, /预览/)
})

test('retry copy stays outside the photo frame and touch target grows with Chinese text', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../components/social-post-card/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(__dirname, '../components/social-post-card/index.wxss'), 'utf8')
  assert.match(wxml, /data-revision="\{\{photoRevision\}\}"/)
  assert.match(wxml, /bindtap="retryPhotos"[^>]*loading="\{\{photoLoading\}\}"[^>]*disabled="\{\{photoLoading\}\}"/)
  assert.ok(wxml.indexOf('story-photo-recovery') > wxml.indexOf('</view>', wxml.indexOf('story-photo-frame')))
  assert.match(wxss, /\.story-card \.story-photo-retry\s*\{[^}]*min-height:\s*88rpx;[^}]*height:\s*auto;[^}]*white-space:\s*normal;/)
  assert.doesNotMatch(wxss.match(/\.story-photo-message\s*\{[^}]*\}/)[0], /(?:\{|;)\s*height:/)
  assert.equal(expired(mediaOf(post()), START + 300001), true)
})
