const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const { createCatOnlineCore } = require('../cloudfunctions/catOnline/core')
const { resolveLike } = require('../cloudfunctions/catOnline/showcase')
const client = require('../services/showcase')

const catalog = { version: 'test-v1', assets: [{ id: 'a', title: '猫片', group: 0, author: 'Photographer', thumb: { fileID: 'cloud://test/showcase/thumb' }, detail: { fileID: 'cloud://test/showcase/detail', width: 500, height: 400 } }] }
function setup() {
  const records = new Map()
  const repository = new Proxy({
    ensureUser: async user => user,
    listShowcaseLikes: async ids => ids.map(id => records.get(id)).filter(Boolean),
    async setShowcaseLike(input) {
      const next = resolveLike(records.get(input.id), input.liked, input.expectedVersion)
      if (next.changed) records.set(input.id, { ...input, ...next })
      return next
    }
  }, { get(target, key) { return target[key] || (() => { throw new Error(`Unexpected repository access: ${key}`) }) } })
  const media = { async getTempUrls(requests) { return Object.fromEntries(requests.map(r => [r.key, { url: `https://signed.test/${r.key}`, expiresAt: '2030-01-01T00:00:00Z' }])) } }
  const core = createCatOnlineCore({ repository, media, ownerSecret: 'a'.repeat(48), showcaseCatalog: catalog })
  const call = (action, data = {}, openid = 'person-a') => core.handle({ action, ...data }, { openid })
  return { call, records }
}

test('showcase requires trusted identity but no community membership; never exposes owner or file IDs', async () => {
  const { call } = setup()
  assert.equal((await call('listShowcase', {}, '')).error.code, 'AUTH_REQUIRED')
  const result = await call('listShowcase', { ownerKey: 'forged', openid: 'forged' })
  assert.equal(result.ok, true)
  assert.equal(result.data.assets[0].liked, false)
  assert.doesNotMatch(JSON.stringify(result), /ownerKey|fileID|cloud:\/\//)
})
test('likes survive another device, remain private, and same-target repeats do not toggle', async () => {
  const { call, records } = setup()
  const input = { assetId: 'a', liked: true, expectedVersion: 0 }
  const responses = await Promise.all([call('setShowcaseLike', input), call('setShowcaseLike', input)])
  assert.ok(responses.every(r => r.data.liked && r.data.version === 1 && !r.data.conflict))
  assert.equal(records.size, 1)
  assert.equal((await call('listShowcase')).data.assets[0].liked, true)
  assert.equal((await call('listShowcase', {}, 'person-b')).data.assets[0].liked, false)
  assert.equal((await call('setShowcaseLike', { ...input, liked: false, expectedVersion: 1 })).data.version, 2)
  const stale = await call('setShowcaseLike', input)
  assert.equal(stale.data.conflict, true)
  assert.equal(stale.data.liked, false)
  assert.equal(stale.data.version, 2)
})
test('unlike repeats and invalid assets/versions fail safely', async () => {
  const { call, records } = setup()
  assert.equal((await call('setShowcaseLike', { assetId: 'a', liked: false, expectedVersion: 0 })).data.version, 0)
  assert.equal(records.size, 0)
  for (const patch of [{ assetId: '../user-photo' }, { liked: 'true' }, { expectedVersion: -1 }, { expectedVersion: 0.5 }]) {
    assert.equal((await call('setShowcaseLike', { assetId: 'a', liked: true, expectedVersion: 0, ...patch })).ok, false)
  }
})
test('all groups balance curated scenes, favorites show actual counts and expiration falls back', () => {
  const assets = client.mergeAssets([])
  assert.equal(assets.length, 8)
  const first = client.groupAssets(assets, false, 0)
  const second = client.groupAssets(assets, false, 1)
  assert.equal(first.items.length, 4)
  assert.equal(new Set([...first.items, ...second.items].map(a => a.id)).size, 8)
  assert.equal(client.groupAssets(assets, true, 0).items.length, 0)
  assets[2].liked = true
  const favorites = client.groupAssets(assets, true, 4)
  assert.equal(favorites.items.length, 1)
  assert.equal(favorites.page, 0)
  const expired = client.mergeAssets([{ id: assets[0].id, thumbUrl: 'expired', detailUrl: 'expired', expiresAt: '2000-01-01' }])[0]
  assert.equal(expired.thumbUrl, '')
  assert.match(expired.fallback, /^\/assets\/showcase\//)
})
function component(mock) {
  let definition
  vm.runInNewContext(fs.readFileSync(require.resolve('../components/showcase-garden/index.js'), 'utf8'), {
    require: () => mock, Component: value => { definition = value }, wx: {}, setTimeout, clearTimeout
  })
  const instance = { ...definition.methods, data: JSON.parse(JSON.stringify(definition.data)), _alive: true, setData(patch) { Object.assign(this.data, patch) } }
  return instance
}
test('duplicate taps are guarded, failed likes never fake a synced state, conflict uses server state', async () => {
  let reject, calls = 0
  const mock = { ...client, setLike: () => { calls++; return new Promise((_, r) => { reject = r }) } }
  const c = component(mock)
  c.data.assets = client.mergeAssets([])
  c.data.detail = c.data.assets[0]
  c.data.synced = true
  const pending = c.likePhoto()
  await c.likePhoto()
  assert.equal(calls, 1)
  assert.equal(c.data.detail.liked, false)
  reject(new Error('offline'))
  await pending
  assert.equal(c.data.synced, false)
  assert.equal(c.data.detail.liked, false)
  assert.equal(c.data.busy, false)
  mock.setLike = async () => ({ assetId: c.data.detail.id, liked: true, version: 4, conflict: true })
  c.data.synced = true
  await c.likePhoto()
  assert.equal(c.data.detail.likeVersion, 4)
  assert.equal(c.data.heart, false)
})

test('a completed like updates its own photo without animating another open detail', async () => {
  let resolve
  const c = component({ ...client, setLike: () => new Promise(r => { resolve = r }) })
  c.data.assets = client.mergeAssets([])
  c.data.detail = c.data.assets[0]
  c.data.synced = true
  const pending = c.likePhoto()
  c.closePhoto()
  await c.openPhoto({ currentTarget: { dataset: { id: c.data.assets[1].id } } })
  resolve({ liked: true, version: 1, conflict: false })
  await pending
  assert.equal(c.data.assets[0].liked, true)
  assert.equal(c.data.detail.id, c.data.assets[1].id)
  assert.equal(c.data.detail.liked, false)
  assert.equal(c.data.heart, false)
  assert.equal(c.data.notice, '')
})

test('rotor epoch bumps only when the bubble id set changes, keeping spin animations phase-locked', () => {
  const c = component({ ...client })
  c.data.assets = client.mergeAssets([])
  c.renderGroup()
  const epoch = c.data.rotorEpoch
  c.renderGroup()
  assert.equal(c.data.rotorEpoch, epoch)
  c.data.page = 1
  c.renderGroup()
  assert.equal(c.data.rotorEpoch, epoch + 1)
  assert.equal(c.data.bubbles.length, 4)
})

test('rosette slots keep pairwise clearance through the rigid revolution', () => {
  const c = component({ ...client })
  c.data.assets = client.mergeAssets([])
  c.renderGroup()
  const points = c.data.bubbles.map(b => {
    const m = b.spiralStyle.match(/left: ([\d.]+)%; top: ([\d.]+)%;/)
    assert.ok(m, `bad spiralStyle: ${b.spiralStyle}`)
    // top% is relative to the stage height (70% of width); normalize to width units.
    return { x: Number(m[1]), y: Number(m[2]) * 0.7 }
  })
  assert.equal(points.length, 4)
  // Rotation is rigid, so pairwise distances hold for the whole revolution.
  // 25.5% of the 638rpx stage width ≈ 163rpx — the tallest bubble pair clearance.
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
      assert.ok(d >= 25.5, `bubble pair ${i}-${j} too close: ${d.toFixed(1)}%`)
    }
  }
})

test('cold offline launch keeps all bundled photos available and no favorites synchronized', async () => {
  const c = component({ ...client, refresh: async () => { throw new Error('offline') } })
  c.data.assets = client.initialAssets()
  c.renderGroup()
  assert.equal(c.data.bubbles.length, 4)
  assert.ok(c.data.assets.every(a => a.fallback && !a.liked))
  assert.equal(await c.refresh(), false)
  assert.equal(c.data.synced, false)
  assert.equal(c.data.bubbles.length, 4)
  assert.match(c.data.error, /喜欢尚未确认/)
})
