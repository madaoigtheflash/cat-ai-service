const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const handoff = require('../utils/social-handoff')

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const copy = value => JSON.parse(JSON.stringify(value))
const at = index => ({ currentTarget: { dataset: { index } } })
const consent = page => page.onConsent({ detail: { value: ['public'] } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ draft = null, pet = null, choose, publish } = {}) {
  let definition, stored = draft, counter = 0
  const calls = [], writes = [], updates = [], choices = [], modals = []
  const adapter = {
    requestId: () => `photo-intent-${++counter}`,
    getDraft: () => stored,
    saveDraft: value => { stored = copy(value); writes.push(stored) },
    choosePhotos: count => { choices.push(count); return choose ? choose(count) : Promise.resolve(['wxfile://selected.jpg']) },
    publishPost: (value, options) => {
      calls.push({ value: copy(value), options })
      return publish ? publish(value, options) : Promise.resolve({ post: { id: 'post-one', status: 'pending' } })
    }
  }
  const box = {
    Page: value => { definition = value },
    require: name => name.includes('community') ? adapter : name.includes('handoff') ? handoff : { getPet: () => pet },
    wx: { showModal: value => modals.push(value), previewImage() {}, navigateTo() {}, redirectTo() {}, switchTab() {} }
  }
  vm.runInNewContext(source('pages/social-compose/index.js'), box)
  const page = { ...definition, data: copy(definition.data), setData(values) { updates.push(copy(values)); Object.assign(this.data, values) } }
  page.onLoad(pet ? { petId: pet.id } : {})
  return { page, calls, writes, updates, choices, modals, stored: () => stored }
}

test('one or three photos can be submitted with an empty caption, without generated story text', async () => {
  for (const photos of [['wxfile://one.jpg'], ['wxfile://one.jpg', 'wxfile://two.jpg', 'wxfile://three.jpg']]) {
    const f = fixture({ draft: { content: ' \n ', photos, requestId: 'photo-only-intent' } })
    consent(f.page)
    await f.page.publish()
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].value.content.trim(), '')
    assert.deepEqual(f.calls[0].value.photos, photos)
    assert.equal(f.page.data.sent, true)
    assert.equal(f.page.data.status, 'pending')
  }
})

test('empty text and no photos are rejected before any publish attempt', async () => {
  const f = fixture({ draft: { content: ' \n ', photos: [] } })
  consent(f.page)
  await f.page.publish()
  assert.equal(f.calls.length, 0)
  assert.match(f.page.data.error, /至少一张.*或.*故事/)
  assert.equal(f.page.data.busy, false)
})

test('photo-only publication still requires explicit public consent', async () => {
  const f = fixture({ draft: { photos: ['wxfile://one.jpg'], content: '', consent: true } })
  await f.page.publish()
  assert.equal(f.calls.length, 0)
  assert.equal(f.page.data.consent, false)
  assert.match(f.page.data.error, /确认公开/)
})

test('selecting a cover moves it first, preserves other order, renews intent and revokes consent without upload', async () => {
  const photos = ['wxfile://one.jpg', 'wxfile://two.jpg', 'wxfile://three.jpg']
  const uploads = { 'wxfile://three.jpg': { prefix: 'community-pending/owner/', fileID: 'cloud://env/old-file.jpg' } }
  const f = fixture({ draft: { photos, content: '', requestId: 'previous-intent', uploads } })
  consent(f.page)
  f.page.setCover(at(2))
  assert.deepEqual(Array.from(f.page.data.photos), [photos[2], photos[0], photos[1]])
  assert.notEqual(f.page._requestId, 'previous-intent')
  assert.equal(f.page.data.consent, false)
  assert.deepEqual(f.stored().uploads, uploads)
  assert.equal(f.calls.length, 0)
  consent(f.page)
  await f.page.publish()
  assert.deepEqual(f.calls[0].value.photos, [photos[2], photos[0], photos[1]])
})

test('removing the cover promotes the next photo and requires fresh confirmation', () => {
  const f = fixture({ draft: { photos: ['wxfile://one.jpg', 'wxfile://two.jpg'], requestId: 'prior-intent' } })
  consent(f.page)
  f.page.removePhoto(at(0))
  assert.deepEqual(Array.from(f.page.data.photos), ['wxfile://two.jpg'])
  assert.notEqual(f.page._requestId, 'prior-intent')
  assert.equal(f.page.data.consent, false)
  assert.equal(f.calls.length, 0)
})

test('invalid photo indexes and selecting the existing cover are no-ops', () => {
  const f = fixture({ draft: { photos: ['wxfile://one.jpg', 'wxfile://two.jpg'], requestId: 'same-intent' } })
  consent(f.page)
  for (const index of [-1, 2, 1.5, 'bad']) { f.page.setCover(at(index)); f.page.removePhoto(at(index)) }
  f.page.setCover(at(0))
  assert.equal(f.page._requestId, 'same-intent')
  assert.equal(f.page.data.consent, true)
  assert.equal(f.writes.length, 0)
})

test('busy publication blocks changing photos, cover, text, consent and duplicate submission', async () => {
  const request = deferred()
  const f = fixture({ draft: { photos: ['wxfile://one.jpg', 'wxfile://two.jpg'], content: '一起晒太阳', requestId: 'same-intent' }, publish: () => request.promise })
  f.page.setData({ offeredPhoto: 'wxfile://archive.jpg' })
  consent(f.page)
  const pending = f.page.publish()
  f.page.setCover(at(1)); f.page.removePhoto(at(0)); f.page.useArchivePhoto()
  f.page.onInput({ detail: { value: 'changed' } })
  f.page.onConsent({ detail: { value: [] } })
  await f.page.choosePhotos(); await f.page.publish()
  assert.equal(f.calls.length, 1)
  assert.equal(f.choices.length, 0)
  assert.deepEqual(Array.from(f.page.data.photos), ['wxfile://one.jpg', 'wxfile://two.jpg'])
  assert.equal(f.page.data.content, '一起晒太阳')
  assert.equal(f.page.data.consent, true)
  request.resolve({ post: { id: 'post-one', status: 'pending' } })
  await pending
})

test('photo chooser locks photo mutations and submission until selection completes, caps at three, and never uploads', async () => {
  const selection = deferred()
  const f = fixture({ draft: { photos: ['wxfile://one.jpg'], requestId: 'prior-intent' }, choose: () => selection.promise })
  f.page.setData({ offeredPhoto: 'wxfile://archive.jpg' })
  consent(f.page)
  const pending = f.page.choosePhotos()
  f.page.removePhoto(at(0)); f.page.useArchivePhoto()
  await f.page.choosePhotos(); await f.page.publish()
  assert.deepEqual(f.choices, [2])
  selection.resolve(['wxfile://two.jpg', 'wxfile://three.jpg', 'wxfile://four.jpg'])
  await pending
  assert.deepEqual(Array.from(f.page.data.photos), ['wxfile://one.jpg', 'wxfile://two.jpg', 'wxfile://three.jpg'])
  assert.equal(f.page.data.consent, false)
  assert.equal(f.page.data.choosing, false)
  assert.equal(f.calls.length, 0)
})

test('cancelled or empty photo selection preserves the existing draft and consent', async () => {
  for (const choose of [() => Promise.reject({ errMsg: 'chooseMedia:fail cancel' }), () => Promise.resolve([])]) {
    const f = fixture({ draft: { photos: ['wxfile://one.jpg'], requestId: 'same-intent' }, choose })
    consent(f.page)
    await f.page.choosePhotos()
    assert.equal(f.page.data.error, '')
    assert.equal(f.page.data.consent, true)
    assert.equal(f.page._requestId, 'same-intent')
  }
})

test('progress distinguishes preparation, byte upload and submission from approval', async () => {
  const request = deferred()
  const f = fixture({ draft: { photos: ['wxfile://one.jpg', 'wxfile://two.jpg'] }, publish: () => request.promise })
  consent(f.page)
  const pending = f.page.publish()
  const progress = f.calls[0].options.onProgress
  assert.equal(f.page.data.progressPhase, 'preparing')
  assert.equal(f.page.data.progressPercent, null)
  progress({ phase: 'uploading', completed: 0, total: 2 })
  assert.equal(f.page.data.progressPercent, null)
  progress({ phase: 'uploading', completed: 1, total: 2, percent: 75.4 })
  assert.equal(f.page.data.progressCompleted, 1)
  assert.equal(f.page.data.progressTotal, 2)
  assert.equal(f.page.data.progressPercent, 75)
  progress({ phase: 'uploading', completed: 2, total: 2, percent: 100 })
  assert.equal(f.page.data.sent, false)
  assert.equal(f.page.data.status, '')
  progress({ phase: 'submitting', completed: 2, total: 2, percent: 100 })
  assert.equal(f.page.data.progressPercent, null)
  assert.match(f.page.data.progressText, /等待服务端确认/)
  progress({ phase: 'uploading', completed: 1, total: 2, percent: 80 })
  assert.equal(f.page.data.progressPhase, 'submitting')
  request.resolve({ post: { id: 'post-one', status: 'pending' } })
  await pending
  assert.equal(f.page.data.status, 'pending')
  assert.equal(f.page.data.busy, false)
  const count = f.updates.length
  progress({ phase: 'submitting', completed: 2, total: 2 })
  assert.equal(f.updates.length, count)
})

test('unknown, absent or non-finite progress never displays fake percentage', async () => {
  const request = deferred()
  const f = fixture({ draft: { photos: ['wxfile://one.jpg'] }, publish: () => request.promise })
  consent(f.page)
  const pending = f.page.publish()
  const progress = f.calls[0].options.onProgress
  progress({ phase: 'approved', percent: 100 })
  assert.equal(f.page.data.progressPhase, 'preparing')
  for (const percent of [undefined, null, NaN, Infinity, '90']) {
    progress({ phase: 'uploading', completed: 0, total: 1, percent })
    assert.equal(f.page.data.progressPercent, null)
  }
  request.resolve({ post: { id: 'post-one', status: 'pending' } })
  await pending
})

test('upload failure keeps photo order, caption and retry identity while ending busy state', async () => {
  const f = fixture({ draft: { photos: ['wxfile://cover.jpg', 'wxfile://next.jpg'], content: '', requestId: 'retry-intent' },
    publish: (_, options) => { options.onProgress({ phase: 'uploading', completed: 0, total: 2, percent: 10 }); return Promise.reject(new Error('照片上传失败，请重试。')) } })
  consent(f.page)
  await f.page.publish()
  assert.equal(f.page.data.busy, false)
  assert.equal(f.page.data.sent, false)
  assert.match(f.page.data.error, /上传失败/)
  assert.deepEqual(f.stored().photos, ['wxfile://cover.jpg', 'wxfile://next.jpg'])
  assert.equal(f.stored().content, '')
  assert.equal(f.page._requestId, 'retry-intent')
})

test('unload ignores late progress and publication success or failure without touching page state', async () => {
  for (const fail of [false, true]) {
    const request = deferred()
    const f = fixture({ draft: { photos: ['wxfile://one.jpg'] }, publish: () => request.promise })
    consent(f.page)
    const pending = f.page.publish()
    f.page.onUnload()
    const count = f.updates.length
    f.calls[0].options.onProgress({ phase: 'uploading', completed: 1, total: 1, percent: 100 })
    if (fail) request.reject(new Error('late network failure'))
    else request.resolve({ post: { id: 'post-one', status: 'approved' } })
    await pending
    assert.equal(f.updates.length, count)
    assert.equal(f.page.data.sent, false)
  }
})

test('unload ignores late picker success or failure and delayed archive-association modal', async () => {
  for (const fail of [false, true]) {
    const selection = deferred()
    const f = fixture({ choose: () => selection.promise })
    const pending = f.page.choosePhotos()
    f.page.onUnload()
    const count = f.updates.length
    if (fail) selection.reject(new Error('late picker error'))
    else selection.resolve(['wxfile://late.jpg'])
    await pending
    assert.equal(f.updates.length, count)
    assert.equal(f.writes.length, 0)
  }
  const f = fixture({ draft: { content: '已有草稿', photos: [] }, pet: { id: 'local-cat', name: '小猫', imagePath: 'wxfile://archive.jpg' } })
  assert.equal(f.modals.length, 1)
  f.page.onUnload()
  const count = f.updates.length
  f.modals[0].success({ confirm: true })
  assert.equal(f.updates.length, count)
  assert.equal(f.writes.length, 0)
})

test('an old page session cannot update a newly loaded composer through a late publish callback', async () => {
  const request = deferred()
  const f = fixture({ draft: { photos: ['wxfile://one.jpg'] }, publish: () => request.promise })
  consent(f.page)
  const pending = f.page.publish()
  f.page.onUnload()
  f.page.onLoad({})
  const count = f.updates.length
  f.calls[0].options.onProgress({ phase: 'submitting', completed: 1, total: 1 })
  request.resolve({ post: { id: 'old-post', status: 'approved' } })
  await pending
  assert.equal(f.updates.length, count)
  assert.notEqual(f.page.data.postId, 'old-post')
})

test('native share button is visible only for approved posts and pending share handler exposes no original photo', () => {
  const markup = source('pages/social-post/index.wxml')
  const button = markup.match(/<button\b[^>]*open-type="share"[^>]*>分享给微信好友<\/button>/)
  assert.ok(button)
  const expression = button[0].match(/wx:if="\{\{([^}]+)\}\}"/)[1]
  for (const status of ['approved', 'pending', 'rejected']) assert.equal(vm.runInNewContext(expression, { post: { status } }), status === 'approved')
  let definition
  vm.runInNewContext(source('pages/social-post/index.js'), {
    Page: value => { definition = value },
    require: name => name.includes('view-model') ? require('../components/social-post-card/view-model') : {}, wx: {}
  })
  for (const status of ['pending', 'rejected']) {
    const response = definition.onShareAppMessage.call({ data: { postId: 'private-post', post: { status, photos: ['https://signed.example/private.jpg'] } } })
    assert.equal(response.path, '/pages/home/index')
    assert.doesNotMatch(response.imageUrl, /private/)
  }
})

test('photo controls remain outside the picture with flexible 88rpx targets and honest progress copy', () => {
  const markup = source('pages/social-compose/index.wxml')
  const css = source('pages/social-compose/index.wxss')
  assert.match(markup, /正文选填/)
  assert.match(markup, /bindtap="setCover"/)
  assert.match(markup, /当前封面/)
  assert.match(markup, /上传完成不代表审核通过/)
  assert.match(markup, /compose-photo-preview[^]*?<\/view>\s*<button class="photo-cover/)
  assert.match(css, /\.compose-primary, \.compose-secondary, \.photo-remove, \.photo-cover\s*\{[^}]*min-height: 88rpx;[^}]*height: auto;/)
  assert.match(css, /\.compose-photo-preview\s*\{[^}]*padding-top: 75%/)
  assert.match(css, /\.compose-page button\.compose-primary[^}]*width: 100%;[^}]*min-width: 0;/)
  for (const page of ['home', 'social']) assert.match(source(`pages/${page}/index.wxml`), /分享照片 \/ 故事/)
})
