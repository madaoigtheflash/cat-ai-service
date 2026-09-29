'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const domain = require('../utils/cato-encounter-review')
const { createStore } = require('../services/cato-lab')
const NOW = '2026-09-29T15:00'
const INPUT = { area: '公园北侧树荫一带', observedAt: '2026-09-28T09:30', revisitAt: '2026-09-29T10:00', note: '看到橘白短毛猫，尾尖似乎是白色。' }
let serial = 0
function command(state, type, input = {}, overrides = {}) {
  return { type, input, operationId: 'operation_' + (++serial), actor: { id: domain.OWNER, role: 'observer' }, encounterId: 'sighting_one', expectedRevision: state.revision, expectedVersion: state.encounters[0]?.version || 0, ...overrides }
}
function advance(state, type, input, overrides) { return domain.applyCommand(state, command(state, type, input, overrides), NOW) }
function created() { return advance(domain.emptyState(), 'create', INPUT) }
function evidence(state = created()) { return advance(state, 'evidence', { id: 'evidence_one', at: '2026-09-29T10:10', note: '看到白色尾尖；没有看清脸。' }) }
function reviewed(state = evidence()) { return advance(state, 'review', { candidateId: 'demo-taotao', conclusion: 'possible_same', reason: '尾尖相似，脸部花纹尚未核实。' }) }
function memory(initial) {
  let saved = initial === undefined ? undefined : structuredClone(initial)
  const flags = { reads: 0, writes: 0, failRead: false, failSave: false, failAfterSave: false }
  return { flags, peek: () => structuredClone(saved), replace: value => { saved = structuredClone(value) },
    load(name, fallback) { assert.equal(name, 'notebook'); flags.reads++; if (flags.failRead) throw new Error('read failure'); return structuredClone(saved === undefined ? fallback : saved) },
    save(name, value) { assert.equal(name, 'notebook'); flags.writes++; if (flags.failSave) throw new Error('save failure'); saved = structuredClone(value); if (flags.failAfterSave) throw new Error('ack failure') }
  }
}

test('create separates sighting, candidate, conclusion, link and revisit state without mutating input', () => {
  const state = domain.emptyState(); const before = structuredClone(state)
  const result = advance(state, 'create', INPUT)
  assert.deepEqual(state, before)
  assert.equal(result.encounters[0].candidateId, null)
  assert.equal(result.encounters[0].conclusion, 'insufficient')
  assert.equal(result.encounters[0].linkedCardId, null)
  assert.equal(result.encounters[0].completedAt, null)
  assert.equal(result.revision, 1)
})

test('dates reject non-existing dates, invalid time and years, and accept leap day', () => {
  for (const value of ['2026-02-29T10:00', '2026-13-01T10:00', '2026-09-29T24:00', '2026-09-29T12:60', '2100-01-01T00:00', '2026/09/29 10:00']) assert.throws(() => domain.dateValue(value))
  assert.ok(Number.isFinite(domain.dateValue('2024-02-29T10:00')))
})

test('new observation requires self-chosen revisit time after observation and no future observation', () => {
  for (const patch of [{ revisitAt: '' }, { revisitAt: INPUT.observedAt }, { revisitAt: '2026-09-27T09:00' }, { observedAt: '2026-09-30T10:00', revisitAt: '2026-10-01T10:00' }]) assert.throws(() => advance(domain.emptyState(), 'create', { ...INPUT, ...patch }))
  assert.equal(created().encounters[0].revisitAt, INPUT.revisitAt)
})

test('rough area rejects blank, excessive length, precise coordinates, address and phone', () => {
  for (const area of ['', ' ', '园', '园'.repeat(61), '31.2304,121.4737', '公园路12号', '北侧3栋101室', '联系13812345678', '经度121']) assert.throws(() => advance(domain.emptyState(), 'create', { ...INPUT, area }))
  for (const note of ['', ' ', '猫'.repeat(501)]) assert.throws(() => advance(domain.emptyState(), 'create', { ...INPUT, note }))
})

test('edit preserves distinct ID and increments version; cannot move observation after evidence', () => {
  const state = evidence()
  const next = advance(state, 'edit', { ...INPUT, area: '公园南侧草地一带', note: '已更正粗略区域。' })
  assert.equal(next.encounters[0].id, state.encounters[0].id)
  assert.equal(next.encounters[0].version, 3)
  assert.equal(next.encounters[0].evidence.length, 1)
  assert.throws(() => advance(state, 'edit', { ...INPUT, observedAt: '2026-09-29T11:00', revisitAt: '2026-09-30T10:00' }), /证据时间/)
})

test('evidence requires valid timestamp after observation and not in future, unique ID, and nonblank note', () => {
  for (const input of [{ id: 'evidence_one', at: '2026-09-27T10:00', note: '未遇见' }, { id: 'evidence_one', at: '2026-09-30T10:00', note: '未遇见' }, { id: 'evidence_one', at: NOW, note: '' }]) assert.throws(() => advance(created(), 'evidence', input))
  assert.throws(() => evidence(evidence()), /重复/)
  assert.equal(evidence().encounters[0].conclusion, 'insufficient')
})

test('review accepts all three manual conclusions and only two synthetic candidates', () => {
  for (const conclusion of Object.keys(domain.CONCLUSIONS)) {
    const next = advance(evidence(), 'review', { candidateId: 'demo-doudou', conclusion, reason: '人工笔记，不确定身份。' })
    assert.equal(next.encounters[0].conclusion, conclusion)
    assert.equal(next.encounters[0].linkedCardId, null)
  }
  for (const patch of [{ candidateId: 'real-cat' }, { candidateId: null }, { conclusion: 'confirmed' }, { reason: '' }]) assert.throws(() => advance(evidence(), 'review', { candidateId: 'demo-taotao', conclusion: 'possible_same', reason: '线索相近。', ...patch }))
  assert.throws(() => reviewed(created()), /补充/)
})

test('explicit link requires evidence and possible-same hypothesis for selected candidate', () => {
  assert.throws(() => advance(created(), 'link', { candidateId: 'demo-taotao' }))
  assert.throws(() => advance(reviewed(), 'link', { candidateId: 'demo-doudou' }))
  const different = advance(evidence(), 'review', { candidateId: 'demo-taotao', conclusion: 'different', reason: '花纹不符。' })
  assert.throws(() => advance(different, 'link', { candidateId: 'demo-taotao' }))
  const linked = advance(reviewed(), 'link', { candidateId: 'demo-taotao' })
  assert.equal(linked.encounters[0].linkedCardId, 'demo-taotao')
  assert.equal(linked.encounters[0].conclusion, 'possible_same')
})

test('unlink is reversible, keeps evidence and hypothesis, and blocks silent candidate reassignment', () => {
  const linked = advance(reviewed(), 'link', { candidateId: 'demo-taotao' })
  assert.throws(() => advance(linked, 'review', { candidateId: 'demo-doudou', conclusion: 'possible_same', reason: '改选。' }), /先撤销/)
  assert.throws(() => advance(linked, 'review', { candidateId: 'demo-taotao', conclusion: 'different', reason: '改判。' }), /先撤销/)
  const unlinked = advance(linked, 'unlink')
  assert.equal(unlinked.encounters[0].linkedCardId, null)
  assert.equal(unlinked.encounters[0].evidence.length, 1)
  assert.equal(unlinked.encounters[0].conclusion, 'possible_same')
  assert.equal(advance(unlinked, 'link', { candidateId: 'demo-taotao' }).encounters[0].linkedCardId, 'demo-taotao')
})

test('complete requires evidence; reopen keeps evidence and hypothesis', () => {
  assert.throws(() => advance(created(), 'complete'), /补充/)
  const completed = advance(reviewed(), 'complete')
  assert.equal(completed.encounters[0].completedAt, NOW)
  assert.throws(() => advance(completed, 'complete'), /重复/)
  const reopened = advance(completed, 'reopen')
  assert.equal(reopened.encounters[0].completedAt, null)
  assert.equal(reopened.encounters[0].evidence.length, 1)
  assert.equal(reopened.encounters[0].candidateId, 'demo-taotao')
  assert.throws(() => advance(reopened, 'reopen'))
})

test('viewer, foreign identity, stale aggregate and stale record versions cannot mutate', () => {
  const state = created()
  for (const overrides of [{ actor: { id: domain.OWNER, role: 'viewer' } }, { actor: { id: 'other-person', role: 'observer' } }, { expectedRevision: 0 }, { expectedVersion: 0 }, { encounterId: 'sighting_missing' }]) assert.throws(() => advance(state, 'edit', INPUT, overrides))
  assert.throws(() => advance(state, 'create', INPUT), /重复/)
})

test('same operation is idempotent but collision and independent duplicate actions fail', () => {
  const state = domain.emptyState(); const op = command(state, 'create', INPUT)
  const once = domain.applyCommand(state, op, NOW)
  assert.deepEqual(domain.applyCommand(once, op, NOW), once)
  assert.throws(() => domain.applyCommand(once, { ...op, input: { ...INPUT, note: '另一笔记' } }, NOW), /不同内容/)
  const linked = advance(reviewed(), 'link', { candidateId: 'demo-taotao' })
  assert.throws(() => advance(linked, 'link', { candidateId: 'demo-taotao' }), /重复/)
  assert.throws(() => advance(created(), 'unlink'))
})

test('unsupported schema, malformed lists, owner and invariant violations fail closed', () => {
  const state = reviewed()
  const mutations = [s => { s.schemaVersion = 2 }, s => { s.revision = 999 }, s => { s.encounters[0].ownerId = 'someone' }, s => { s.encounters.push(s.encounters[0]) }, s => { s.encounters[0].version = -1 }, s => { s.encounters[0].conclusion = 'different'; s.encounters[0].linkedCardId = 'demo-taotao' }, s => { s.extra = true }]
  mutations.forEach(mutate => { const broken = structuredClone(state); mutate(broken); assert.throws(() => domain.validateState(broken)) })
  for (const broken of [null, [], '', { schemaVersion: 1 }]) assert.throws(() => domain.validateState(broken))
})

test('capacity guards block overflow without modifying the original', () => {
  let state = domain.emptyState()
  for (let index = 0; index < 100; index++) state = advance(state, 'create', INPUT, { encounterId: 'sighting_' + index })
  assert.throws(() => advance(state, 'create', INPUT, { encounterId: 'sighting_overflow' }), /最多保存/)
  assert.equal(state.encounters.length, 100)
  const fullEvidence = evidence()
  fullEvidence.encounters[0].evidence = Array.from({ length: 100 }, (_, index) => ({ id: 'evidence_' + index, at: NOW, note: '观察记录' }))
  assert.throws(() => advance(fullEvidence, 'evidence', { id: 'evidence_overflow', at: NOW, note: '观察记录' }), /证据列表/)
})

test('repository persists real local writes and reloads without sharing mutable references', () => {
  const store = memory(); const repository = domain.createRepository(store)
  const state = repository.load(); const op = command(state, 'create', INPUT)
  const saved = repository.commit(op, NOW)
  saved.encounters[0].note = 'outside mutation'
  assert.equal(repository.load().encounters[0].note, INPUT.note)
  repository.commit(op, NOW)
  assert.equal(store.flags.writes, 1)
})

test('read failure blocks saving and never replaces records with empty fallback', () => {
  const initial = created(); const store = memory(initial); store.flags.failRead = true
  const repository = domain.createRepository(store)
  assert.throws(() => repository.load(), /read failure/)
  assert.throws(() => repository.commit(command(initial, 'edit', INPUT), NOW), /读取未成功/)
  assert.equal(store.flags.writes, 0)
  assert.deepEqual(store.peek(), initial)
  store.flags.failRead = false
  assert.deepEqual(repository.load(), initial)
})

test('corrupt or newer-version storage never saves a silent empty state', () => {
  for (const broken of [{ ...domain.emptyState(), schemaVersion: 99 }, { ...domain.emptyState(), encounters: 'bad' }]) {
    const store = memory(broken); const repository = domain.createRepository(store)
    assert.throws(() => repository.load())
    assert.throws(() => repository.commit(command(domain.emptyState(), 'create', INPUT), NOW))
    assert.deepEqual(store.peek(), broken); assert.equal(store.flags.writes, 0)
  }
})

test('save failure preserves old state, blocks retry until reload, then supports safe retry', () => {
  const store = memory(created()); const repository = domain.createRepository(store); const state = repository.load()
  const op = command(state, 'edit', { ...INPUT, note: '修订观察' }); store.flags.failSave = true
  assert.throws(() => repository.commit(op, NOW), /保存未获确认/)
  assert.equal(repository.isReady(), false)
  assert.equal(store.peek().encounters[0].note, INPUT.note)
  assert.throws(() => repository.commit(op, NOW), /读取未成功/)
  store.flags.failSave = false; repository.load()
  assert.equal(repository.commit(op, NOW).encounters[0].note, '修订观察')
})

test('uncertain saved-but-thrown response cannot duplicate when reloaded and retried', () => {
  const store = memory(); const repository = domain.createRepository(store); const state = repository.load()
  const op = command(state, 'create', INPUT); store.flags.failAfterSave = true
  assert.throws(() => repository.commit(op, NOW), /保存未获确认/)
  store.flags.failAfterSave = false; repository.load()
  const result = repository.commit(op, NOW)
  assert.equal(result.encounters.length, 1); assert.equal(store.flags.writes, 1)
})

test('external write, reset or read failure between load and save is detected without overwrite', () => {
  const initial = created()
  for (const changed of [domain.emptyState(), advance(initial, 'edit', { ...INPUT, note: '另一个页面的编辑' })]) {
    const store = memory(initial); const repository = domain.createRepository(store); repository.load(); store.replace(changed)
    assert.throws(() => repository.commit(command(initial, 'edit', INPUT), NOW), /已变化/)
    assert.equal(store.flags.writes, 0); assert.deepEqual(store.peek(), changed)
  }
  const store = memory(initial); const repository = domain.createRepository(store); repository.load(); store.flags.failRead = true
  assert.throws(() => repository.commit(command(initial, 'edit', INPUT), NOW), /read failure/)
  assert.equal(store.flags.writes, 0); assert.equal(repository.isReady(), false)
})

test('isolated store only touches encounter-review key, preserving original pets', () => {
  const data = new Map([['catai_mini_pets_v1', [{ id: 'real-cat' }]]]); const keys = []
  const store = createStore('encounter-review', { getStorageSync(key) { keys.push(key); return data.get(key) }, setStorageSync(key, value) { keys.push(key); data.set(key, value) } })
  const repository = domain.createRepository(store); const state = repository.load(); repository.commit(command(state, 'create', INPUT), NOW)
  assert.ok(keys.every(key => key === 'catai_cato_lab_v1:encounter-review:notebook'))
  assert.deepEqual(data.get('catai_mini_pets_v1'), [{ id: 'real-cat' }])
})

function pageHarness(options = {}) {
  const filename = require.resolve('../pages/cato-encounter-review/index.js')
  const oldPage = global.Page; const oldWx = global.wx; let definition; let saved; let modal; let writes = 0
  global.Page = value => { definition = value }
  global.wx = { getStorageSync() { if (options.failRead) throw new Error('cannot read'); return saved }, setStorageSync(key, value) { if (options.failSave) throw new Error('cannot save'); writes++; saved = structuredClone(value) }, showModal(value) { modal = value } }
  delete require.cache[filename]; require(filename)
  const page = { ...definition, data: structuredClone(definition.data), setData(update, done) { Object.entries(update).forEach(([key, value]) => { const parts = key.split('.'); let target = this.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = value }); if (done) done() } }
  page.onLoad()
  return { page, options, modal: () => modal, saved: () => saved, writes: () => writes, restore() { global.Page = oldPage; global.wx = oldWx; delete require.cache[filename] } }
}
function fillObservation(page) { page.openNew(); Object.assign(page.data.form, { area: INPUT.area, note: INPUT.note, observedDate: '2020-01-01', observedTime: '09:30', revisitDate: '2020-01-02', revisitTime: '10:00' }); page.saveObservation() }

test('page requires explicit revisit and candidate choices, cancel does not save', () => {
  const harness = pageHarness(); const page = harness.page
  try {
    page.openNew(); assert.equal(page.data.form.revisitDate, ''); assert.equal(page.data.form.revisitTime, '')
    page.cancelForm(); assert.equal(harness.writes(), 0)
    fillObservation(page); page.openReview(); assert.equal(page.data.reviewForm.candidateIndex, 0)
    page.saveReview(); assert.match(page.data.error, /主动选择/); assert.equal(harness.writes(), 1)
    page.cancelForm(); assert.equal(harness.writes(), 1)
  } finally { harness.restore() }
})

test('page failure preserves form, locks writes until reload, and viewer cannot save', () => {
  const harness = pageHarness({ failSave: true }); const page = harness.page
  try {
    fillObservation(page)
    assert.equal(page.data.ready, false); assert.equal(page.data.form.note, INPUT.note)
    assert.equal(page.data.rows.length, 0); assert.match(page.data.error, /保存未获确认/)
    harness.options.failSave = false; page.reload(); page.saveObservation()
    assert.equal(page.data.rows.length, 1)
    page.changeRole({ detail: { value: '1' } }); page.openNew(); assert.equal(page.data.form, null)
    assert.match(page.data.error, /只读/)
  } finally { harness.restore() }
})

test('page link cancel is a no-op and confirmed link/revoke remain separate', () => {
  const harness = pageHarness(); const page = harness.page
  try {
    fillObservation(page); page.openEvidence(); Object.assign(page.data.evidenceForm, { date: '2020-01-02', time: '10:00', note: '尾尖白色，身份仍未确定。' }); page.saveEvidence()
    page.openReview(); Object.assign(page.data.reviewForm, { candidateIndex: 1, conclusionIndex: 1, reason: '尾尖相近。' }); page.saveReview()
    assert.equal(page.data.selected.linkedCardId, null)
    page.recordAction({ currentTarget: { dataset: { action: 'link' } } }); const count = harness.writes()
    harness.modal().success({ confirm: false }); assert.equal(harness.writes(), count)
    assert.equal(page.data.selected.linkedCardId, null)
    page.recordAction({ currentTarget: { dataset: { action: 'link' } } }); harness.modal().success({ confirm: true })
    assert.equal(page.data.selected.linkedCardId, 'demo-taotao')
    page.recordAction({ currentTarget: { dataset: { action: 'unlink' } } }); assert.equal(page.data.selected.linkedCardId, null)
    assert.equal(page.data.selected.evidence.length, 1)
  } finally { harness.restore() }
})

test('feature source preserves offline entry and has no network, upload, location or real-card reads', () => {
  const root = path.join(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'pages/cato-encounter-review/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-encounter-review/index.wxml'), 'utf8')
  assert.doesNotMatch(source, /wx\.(request|cloud|uploadFile|getLocation|chooseLocation)|readLocalCatCards|catai_mini_pets_v1/)
  assert.match(source, /createStore\('encounter-review'\)/)
  assert.doesNotMatch(wxml, /&amp;&amp;/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages[0], 'pages/cato-lab/index')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8')).appid, 'touristappid')
})
