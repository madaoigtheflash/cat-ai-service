const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const handoff = require('../utils/social-handoff')

function fixture({ pet = null, publish, draft = null } = {}) {
  const calls = [], writes = []
  let definition, counter = 0, stored = draft
  const adapter = {
    requestId: () => `intent-${++counter}`, getDraft: () => stored,
    saveDraft: value => { stored = structuredClone(value); writes.push(stored) },
    publishPost: async value => { calls.push(value); return publish ? publish(value) : { post: { id: 'post-one', status: 'pending' } } }
  }
  const box = { Page: value => { definition = value }, require: name => name.includes('community') ? adapter : name.includes('handoff') ? handoff : { getPet: () => pet },
    wx: { showModal: opts => opts.success({ confirm: true }), navigateTo() {}, switchTab() {}, redirectTo() {} } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/social-compose/index.js'), 'utf8'), box)
  const page = { ...definition, data: structuredClone(definition.data), setData(values) { Object.assign(this.data, values) } }
  return { page, calls, writes }
}

test('identify handoff offers photo separately and only shows whitelisted cat fields', () => {
  const f = fixture({ pet: { id: 'local', name: '小猫', breed: '田园猫', coatColor: '橘白', imagePath: 'wxfile://photo.jpg', notes: 'private', medical: ['secret'], recognition: { description: 'secret' } } })
  f.page.onLoad({ petId: 'local' })
  assert.equal(f.page.data.offeredPhoto, 'wxfile://photo.jpg')
  assert.equal(f.page.data.photos.length, 0)
  assert.equal(f.page.data.consent, false)
  assert.doesNotMatch(JSON.stringify(f.page.data.cat), /private|secret|medical|recognition|imagePath/)
  f.page.useArchivePhoto()
  assert.equal(f.page.data.photos[0], 'wxfile://photo.jpg')
  assert.equal(f.calls.length, 0)
})

test('demo archive is not offered for public sharing', () => {
  const f = fixture({ pet: { id: 'local', name: '演示', recognition: { demo: true }, imagePath: 'wxfile://photo.jpg' } })
  f.page.onLoad({ petId: 'local' })
  assert.equal(f.page.data.cat, null)
  assert.equal(f.page.data.offeredPhoto, '')
})

test('new user without archive can compose; prompt changes require renewed consent', async () => {
  const f = fixture()
  f.page.onLoad({})
  f.page.onInput({ detail: { value: '今天遇到一只猫。' } })
  await f.page.publish()
  assert.equal(f.calls.length, 0)
  f.page.onConsent({ detail: { value: ['public'] } })
  f.page.onInput({ detail: { value: '它走过来闻了闻鞋子。' } })
  assert.equal(f.page.data.consent, false)
  f.page.onConsent({ detail: { value: ['public'] } })
  await f.page.publish()
  assert.equal(f.calls.length, 1)
  assert.equal(f.page.data.sent, true)
  assert.equal(f.page.data.status, 'pending')
})

test('publish failure retains draft, prevents duplicate click, and stays editable', async () => {
  let reject
  const f = fixture({ publish: () => new Promise((_, fail) => { reject = fail }) })
  f.page.onLoad({})
  f.page.onInput({ detail: { value: '需要重试的猫咪故事' } })
  f.page.onConsent({ detail: { value: ['public'] } })
  const pending = f.page.publish()
  await f.page.publish()
  assert.equal(f.calls.length, 1)
  reject(new Error('网络失败'))
  await pending
  assert.equal(f.page.data.content, '需要重试的猫咪故事')
  assert.equal(f.page.data.sent, false)
  assert.equal(f.page.data.busy, false)
  assert.equal(f.writes.at(-1).content, '需要重试的猫咪故事')
})

test('restoring a draft never restores public consent', () => {
  const f = fixture({ draft: { content: '旧草稿', cat: null, photos: [], requestId: 'saved-intent', consent: true } })
  f.page.onLoad({})
  assert.equal(f.page.data.content, '旧草稿')
  assert.equal(f.page.data.consent, false)
  assert.equal(f.page._requestId, 'saved-intent')
})
