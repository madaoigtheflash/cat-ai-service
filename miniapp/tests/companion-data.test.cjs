const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const event = dataset => ({ currentTarget: { dataset } })
const time = new Date(2026, 8, 30, 15, 4).getTime()
const pet = (id, name) => ({ id, name, updatedAt: time })
const overview = (patch = {}) => ({ pets: [], relationships: [], locations: [], counts: { pets: 0, relationships: 0, locations: 0, messages: 0 }, ...patch })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(name = 'companion-data', overrides = {}) {
  let definition
  const calls = [], navigation = [], modals = [], clipboard = [], writes = [], toasts = []
  let stopped = 0
  const defaults = { getOverview: () => overview(), listMessages: () => [], listLocations: () => [], exportHistory: () => '{"private":"我的话","draft":"未发送"}' }
  const service = Object.fromEntries(Object.keys(defaults).map(method => [method, (...args) => {
    calls.push({ method, args })
    return (overrides[method] || defaults[method])(...args)
  }]))
  const wx = { navigateTo: options => navigation.push({ method: 'navigateTo', ...options }),
    switchTab: options => navigation.push({ method: 'switchTab', ...options }),
    showModal: options => modals.push(options), showToast: options => toasts.push(options),
    setClipboardData: options => clipboard.push(options), stopPullDownRefresh: () => { stopped += 1 },
    getLocation: () => assert.fail('read-only page must not locate'), chooseLocation: () => assert.fail('read-only page must not choose location'),
    openLocation: () => assert.fail('coarse map must not navigate to exact location'), cloud: { callFunction: () => assert.fail('local pages must not call cloud') } }
  const filename = path.join(ROOT, 'pages', name, 'index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page: value => { definition = value }, wx,
    require(request) { assert.equal(request, '../../services/companion'); return service } }, { filename, timeout: 1000 })
  const page = { ...definition, data: clone(definition.data), setData(patch) { writes.push(clone(patch)); Object.assign(this.data, clone(patch)) } }
  return { page, calls, navigation, modals, clipboard, writes, toasts, stopped: () => stopped }
}

test('data: empty local records never generate sample data or cloud totals', async () => {
  const f = fixture()
  assert.equal(f.page.data.loading, true)
  assert.equal(await f.page.onShow(), true)
  assert.deepEqual(f.page.data.counts, { pets: 0, relationships: 0, locations: 0, messages: 0 })
  assert.deepEqual(f.page.data.pets, [])
  assert.equal(f.page.data.loading, false)
  assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'listMessages'])
})

test('data: shows real messages, exact recorded time and explicit source without fake read status', async () => {
  const f = fixture('companion-data', { listMessages: () => [
    { id: 'user', role: 'user', text: '我的私人文字', time },
    { id: 'local', role: 'assistant', text: '待确认', source: '本地引导', time: time + 1 },
    { id: 'cloud', role: 'assistant', text: '真实回复', source: '云端回复', time: time + 2 },
    { id: 'unknown', role: 'assistant', text: '旧记录', source: 'unexpected', time: null }
  ] })
  await f.page.onShow()
  assert.deepEqual(f.page.data.messages.map(row => row.id), ['cloud', 'local', 'user', 'unknown'])
  assert.equal(f.page.data.messages[0].sourceLabel, '云端回复 · 本机留存')
  assert.equal(f.page.data.messages[1].sourceLabel, '本地引导 · 固定规则')
  assert.equal(f.page.data.messages[2].timeLabel, '2026-09-30 15:04')
  assert.equal(f.page.data.messages[2].text, '我的私人文字')
  assert.equal(f.page.data.messages[3].sourceLabel, '来源未标注 · 本机留存')
  assert.equal(f.page.data.messages[3].timeLabel, '时间未记录')
  assert.doesNotMatch(JSON.stringify(f.page.data), /已读|在线|发送成功/)
})

test('data: counts come from returned local records rather than unsupported totals', async () => {
  const f = fixture('companion-data', { getOverview: () => overview({ pets: [pet('a', '奶糖')], locations: [{ petId: 'a' }], counts: { pets: 9000, relationships: 9000, locations: 9000, messages: 9000 } }) })
  await f.page.onShow()
  assert.deepEqual(f.page.data.counts, { pets: 1, relationships: 0, locations: 1, messages: 0 })
})

test('data: confirmed receipts precede unchanged history, default to latest three and disclose historical scope', async () => {
  const original = [{ id: 'old', role: 'assistant', text: '已整理为草稿，尚未登记。', source: '本地引导', time }]
  const actionReceipts = Array.from({ length: 5 }, (_, index) => ({ id: `receipt_${index}`, kind: index === 1 ? 'relationship' : index === 2 ? 'location' : 'pet', targetId: `deleted_${index}`, confirmedAt: time + index * 60000, fingerprint: 'must-not-render' }))
  const f = fixture('companion-data', { getOverview: () => overview({ actionReceipts }), listMessages: () => original })
  await f.page.onShow()
  assert.equal(f.page.data.receiptCount, 5)
  assert.equal(f.page.data.receiptsExpanded, false)
  assert.deepEqual(f.page.data.actionReceipts.map(row => row.id), ['receipt_4', 'receipt_3', 'receipt_2'])
  assert.equal(f.page.data.actionReceipts[0].timeLabel, '2026-09-30 15:08')
  assert.equal(f.page.data.actionReceipts[2].kindLabel, '粗位置记录')
  assert.equal(f.page.data.actionReceipts[0].statusLabel, '曾确认保存到本机（当前状态请查看档案）')
  assert.equal(f.page.data.messages[0].text, original[0].text)
  assert.equal(f.page.data.pets.length, 0)
  assert.doesNotMatch(JSON.stringify(f.page.data.actionReceipts), /fingerprint|must-not-render|deleted_/)
  f.page.toggleReceipts()
  assert.equal(f.page.data.actionReceipts.length, 5)
  assert.equal(f.page.data.actionReceipts[3].kindLabel, '双方关系')
  f.page.toggleReceipts()
  assert.equal(f.page.data.actionReceipts.length, 3)
  assert.equal(f.page.data.messages[0].text, '已整理为草稿，尚未登记。')
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/companion-data/index.wxml'), 'utf8')
  assert.ok(wxml.indexOf('已确认记录') < wxml.indexOf('本机对话历史'))
  assert.match(wxml, /不代表记录现在仍存在/)
})

test('data: receipt navigation opens current category, never stale target or a mutation', async () => {
  const f = fixture('companion-data', { getOverview: () => overview({ actionReceipts: [
    { id: 'p', kind: 'pet', targetId: 'gone', confirmedAt: time }, { id: 'r', kind: 'relationship', targetId: 'gone', confirmedAt: time },
    { id: 'l', kind: 'location', targetId: 'gone', confirmedAt: time }, { id: 'bad', kind: 'unexpected', targetId: 'gone', confirmedAt: time }
  ] }) })
  await f.page.onShow()
  for (const id of ['p', 'r', 'l', 'bad', 'missing']) f.page.openReceipt(event({ id }))
  assert.deepEqual(f.navigation, [{ method: 'switchTab', url: '/pages/pets/index' },
    { method: 'navigateTo', url: '/pages/relationships/index' }, { method: 'navigateTo', url: '/pages/companion-map/index' }])
  assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'listMessages'])
  assert.equal(f.page.data.pets.length, 0)
  f.page.onUnload()
  f.page.openReceipt(event({ id: 'p' }))
  assert.equal(f.navigation.length, 3)
})

test('data: missing receipt support is empty, and button width override stays local to summary cards', async () => {
  const f = fixture()
  await f.page.onShow()
  assert.deepEqual(f.page.data.actionReceipts, [])
  assert.equal(f.page.data.receiptCount, 0)
  const css = fs.readFileSync(path.join(ROOT, 'pages/companion-data/index.wxss'), 'utf8')
  const override = css.match(/\.data-page button\.summary-item:not\(\[size='mini'\]\)\s*\{([^}]+)\}/)
  assert.ok(override)
  assert.match(override[1], /width:\s*100%/)
  assert.match(override[1], /min-width:\s*0/)
  assert.match(override[1], /max-width:\s*100%/)
  assert.match(override[1], /box-sizing:\s*border-box/)
})

test('data: both relationship views retain roles and reverse arrow without reassigning parents', async () => {
  const f = fixture('companion-data', { getOverview: () => overview({ pets: [pet('a', '妈妈'), pet('b', '小猫')], relationships: [
    { id: 'r', petAId: 'a', petBId: 'b', directionStatus: 'confirmed', directionMode: 'directed', fromPetId: 'a', toPetId: 'b', fromRole: 'mother', toRole: 'child', note: '主人确认', updatedAt: time }
  ] }) })
  await f.page.onShow()
  assert.equal(f.page.data.relationships[0].forward, '妈妈（母亲） → 小猫（孩子）')
  assert.equal(f.page.data.relationships[0].reverse, '小猫（孩子） ← 妈妈（母亲）')
  assert.equal(f.page.data.relationships[0].pending, false)
})

test('data: legacy, invalid roles and deleted cat records never fabricate identity or direction', async () => {
  const f = fixture('companion-data', { getOverview: () => overview({ pets: [pet('a', '奶糖')], relationships: [
    { id: 'legacy', petAId: 'a', petBId: 'gone', type: 'family' },
    { id: 'bad', petAId: 'a', petBId: 'gone', directionStatus: 'confirmed', directionMode: 'directed', fromPetId: 'a', toPetId: 'gone', fromRole: 'invented', toRole: 'child' }
  ] }) })
  await f.page.onShow()
  for (const row of f.page.data.relationships) {
    assert.equal(row.pending, true)
    assert.equal(row.missing, true)
    assert.equal(row.forward, '奶糖 × 档案已不存在')
    assert.match(row.reverse, /未确认/)
  }
})

test('data: opening an existing pet encodes id and rechecks locally; deleted pet is not opened', async () => {
  let exists = true
  const f = fixture('companion-data', { getOverview: () => overview({ pets: exists ? [pet('猫 / a', '奶糖')] : [] }) })
  await f.page.onShow()
  assert.equal(await f.page.openPet(event({ id: '猫 / a' })), true)
  assert.equal(f.navigation[0].url, '/pages/pet-detail/index?id=%E7%8C%AB%20%2F%20a')
  exists = false
  assert.equal(await f.page.openPet(event({ id: '猫 / a' })), false)
  assert.equal(f.navigation.length, 1)
  assert.equal(f.page.data.pets.length, 0)
  assert.match(f.page.data.error, /已不存在/)
})

test('data: history expansion and valid section selection remain read-only', async () => {
  const f = fixture('companion-data', { listMessages: () => Array.from({ length: 62 }, (_, index) => ({ id: String(index), role: 'user', text: `消息${index}`, time: time + index })) })
  f.page.onLoad({ section: 'history' })
  await f.page.onShow()
  assert.equal(f.page.data.activeSection, 'history')
  assert.equal(f.page.data.messages.length, 30)
  assert.equal(f.page.data.hasEarlier, true)
  f.page.showEarlier()
  assert.equal(f.page.data.messages.length, 60)
  f.page.showEarlier()
  assert.equal(f.page.data.messages.length, 62)
  assert.equal(f.page.data.hasEarlier, false)
  f.page.selectSection(event({ section: 'not-a-section' }))
  assert.equal(f.page.data.activeSection, 'history')
  assert.equal(f.calls.length, 2)
})

test('data: export requires a separate explicit privacy confirmation and cancel never reads export', async () => {
  const f = fixture()
  await f.page.onShow()
  f.page.exportHistory()
  f.page.exportHistory()
  assert.equal(f.modals.length, 1)
  assert.match(f.modals[0].content, /私人对话/)
  assert.match(f.modals[0].content, /剪贴板/)
  assert.match(f.modals[0].content, /未发送/)
  assert.equal(f.clipboard.length, 0)
  await f.modals[0].success({ confirm: false })
  assert.equal(f.page.data.exporting, false)
  assert.equal(f.calls.some(call => call.method === 'exportHistory'), false)
})

test('data: confirmed export copies only actual service result and clipboard failure preserves records', async () => {
  const f = fixture()
  await f.page.onShow()
  f.page.exportHistory()
  await f.modals[0].success({ confirm: true })
  assert.equal(f.clipboard.length, 1)
  assert.equal(f.clipboard[0].data, '{"private":"我的话","draft":"未发送"}')
  f.clipboard[0].fail()
  f.clipboard[0].complete()
  assert.match(f.page.data.error, /记录仍保留/)
  assert.equal(f.page.data.exporting, false)
  assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'listMessages', 'exportHistory'])
})

test('data: invalid export and modal failure reset exporting without copying', async () => {
  const f = fixture('companion-data', { exportHistory: () => null })
  await f.page.onShow()
  f.page.exportHistory()
  await f.modals[0].success({ confirm: true })
  assert.equal(f.clipboard.length, 0)
  assert.equal(f.page.data.exporting, false)
  f.page.exportHistory()
  f.modals[1].fail()
  assert.equal(f.page.data.exporting, false)
})

test('data: unloading during export does not copy private content or mutate destroyed page', async () => {
  const pending = deferred()
  const f = fixture('companion-data', { exportHistory: () => pending.promise })
  await f.page.onShow()
  f.page.exportHistory()
  const saving = f.modals[0].success({ confirm: true })
  f.page.onUnload()
  const before = f.writes.length
  pending.resolve('{"private":"secret"}')
  await saving
  assert.equal(f.clipboard.length, 0)
  assert.equal(f.writes.length, before)
})

for (const name of ['companion-data', 'companion-map']) {
  test(`${name}: failed storage reads do not invent success; pull refresh always stops`, async () => {
    const f = fixture(name, { getOverview: () => { throw new Error('本机读取失败') } })
    assert.equal(await f.page.onPullDownRefresh(), false)
    assert.equal(f.page.data.loading, false)
    assert.equal(f.page.data.error, '本机读取失败')
    assert.equal(f.stopped(), 1)
    const wxml = fs.readFileSync(path.join(ROOT, 'pages', name, 'index.wxml'), 'utf8')
    assert.match(wxml, /wx:if="\{\{!loading && !error\}\}"/)
  })
  test(`${name}: stale and unloaded reads cannot overwrite newer results`, async () => {
    const first = deferred(), second = deferred(), third = deferred()
    const queue = [first, second, third]
    const f = fixture(name, { getOverview: () => queue.shift().promise })
    const load = name === 'companion-data' ? 'loadData' : 'loadLocations'
    const old = f.page[load]()
    const newer = f.page[load]()
    second.resolve(overview({ pets: [pet('new', '新猫')] }))
    assert.equal(await newer, true)
    first.resolve(overview({ pets: [pet('old', '旧猫')] }))
    assert.equal(await old, false)
    if (name === 'companion-data') assert.equal(f.page.data.pets[0].id, 'new')
    const last = f.page[load]()
    f.page.onUnload()
    const before = f.writes.length
    third.reject(new Error('页面已关闭'))
    assert.equal(await last, false)
    assert.equal(f.writes.length, before)
  })
}

test('map: empty state has no fake point, no GPS and no cloud reads', async () => {
  const f = fixture('companion-map')
  assert.equal(f.page.data.loading, true)
  assert.equal(await f.page.onShow(), true)
  assert.deepEqual(f.page.data.markers, [])
  assert.equal(f.page.data.selected, null)
  assert.deepEqual(f.calls.map(call => call.method), ['getOverview', 'listLocations'])
})

test('map: uses the service coarse points and presents name, area and recorded time on marker selection', async () => {
  const locations = [
    { petId: 'a', latitude: 31.23, longitude: 121.47, areaText: '公园附近', time },
    { petId: 'b', latitude: 31.25, longitude: 121.49, areaText: '另一粗区域', time: time + 60000 }
  ]
  const f = fixture('companion-map', { getOverview: () => overview({ pets: [pet('a', '奶糖'), pet('b', '莓莓')] }), listLocations: () => locations })
  await f.page.onShow()
  assert.equal(f.page.data.markers.length, 2)
  assert.equal(f.page.data.markers[0].latitude, locations[0].latitude)
  assert.equal(f.page.data.circles[0].radius, 1000)
  f.page.selectMarker({ detail: { markerId: 2 } })
  assert.equal(f.page.data.selected.catName, '莓莓')
  assert.equal(f.page.data.selected.areaText, '另一粗区域')
  assert.equal(f.page.data.selected.timeLabel, '2026-09-30 15:05')
  f.page.selectMarker({ detail: { markerId: 999 } })
  assert.equal(f.page.data.selected.markerId, 2)
  f.page.selectRow(event({ id: 1 }))
  assert.equal(f.page.data.selected.catName, '奶糖')
  assert.deepEqual(f.navigation, [])
})

test('map: deleted cat remains honestly labeled; invalid coordinates cannot become zero or invented points', async () => {
  const locations = [
    { petId: 'gone', latitude: 31.23, longitude: 121.47, time },
    { petId: 'a', latitude: null, longitude: 0, time },
    { petId: 'a', latitude: '31.23', longitude: '121.47', time },
    { petId: 'a', latitude: 91, longitude: 181, time }, null
  ]
  const f = fixture('companion-map', { listLocations: () => locations })
  await f.page.onShow()
  assert.equal(f.page.data.locations.length, 1)
  assert.equal(f.page.data.omittedCount, 4)
  assert.equal(f.page.data.selected.catName, '猫咪档案已不存在')
  assert.equal(f.page.data.selected.missing, true)
  assert.equal(f.page.data.selected.areaText, '约 2 公里粗区域')
  assert.equal(locations.length, 5)
  assert.equal(f.calls.length, 2)
})

test('navigation: existing tabs use switchTab and local/small-house detail routes use navigateTo', () => {
  const f = fixture()
  for (const handler of ['goChat', 'goPets', 'goSocial', 'goMap', 'goRelationships', 'goOnline', 'goSettings']) f.page[handler]()
  assert.deepEqual(f.navigation, [
    { method: 'switchTab', url: '/pages/home/index' }, { method: 'switchTab', url: '/pages/pets/index' }, { method: 'switchTab', url: '/pages/social/index' },
    { method: 'navigateTo', url: '/pages/companion-map/index' }, { method: 'navigateTo', url: '/pages/relationships/index' },
    { method: 'navigateTo', url: '/pages/online/index' }, { method: 'navigateTo', url: '/pages/settings/index' }
  ])
  const map = fixture('companion-map')
  for (const handler of ['goChat', 'goData', 'goOnline']) map.page[handler]()
  assert.equal(map.navigation[0].url, '/pages/home/index')
  assert.equal(map.navigation[1].url, '/pages/companion-data/index')
  assert.equal(map.navigation[2].url, '/pages/online/index')
})

test('templates: privacy, native coarse map, flexible text and 88rpx controls remain explicit', () => {
  const data = fs.readFileSync(path.join(ROOT, 'pages/companion-data/index.wxml'), 'utf8')
  const map = fs.readFileSync(path.join(ROOT, 'pages/companion-map/index.wxml'), 'utf8')
  assert.match(data, /不代表云端全量数据/)
  assert.match(data, /未发送|草稿/)
  assert.match(map, /show-location="\{\{false\}\}"/)
  assert.match(map, /bindmarkertap="selectMarker"/)
  assert.match(map, /粗位置文字列表/)
  assert.match(map, /不提供精确地点导航/)
  for (const name of ['companion-data', 'companion-map']) {
    const js = fs.readFileSync(path.join(ROOT, 'pages', name, 'index.js'), 'utf8')
    const css = fs.readFileSync(path.join(ROOT, 'pages', name, 'index.wxss'), 'utf8')
    JSON.parse(fs.readFileSync(path.join(ROOT, 'pages', name, 'index.json'), 'utf8'))
    assert.doesNotMatch(js, /wx\.(getLocation|chooseLocation|openLocation)|wx\.cloud|removeStorage|removePet|removeRelationship/)
    assert.match(css, /env\(safe-area-inset-bottom\)/)
    assert.match(css, /min-width:\s*0/)
    assert.match(css, /word-break:\s*break-word/)
    assert.doesNotMatch(css, /text-overflow|font-weight:\s*(650|750|780)/)
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'pages/companion-data/index.wxss'), 'utf8'), /min-height:\s*88rpx/)
})
