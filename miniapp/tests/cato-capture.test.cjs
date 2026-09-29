const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const capture = require('../utils/cato-capture')
const { createStore } = require('../services/cato-lab')

const NOW = '2026-09-29T08:00:00.000Z'
const KEY = 'catai_cato_lab_v1:capture:inbox'
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const event = (dataset, value) => ({ currentTarget: { dataset }, detail: { value } })

function readyBatch(id = 'batch_a', text = '换水；清洗食盆', source = 'text') {
  const batch = capture.parseDrafts(text, id, source)
  batch.drafts.forEach(draft => { draft.timeMode = 'unscheduled' })
  return batch
}

function makePage(options = {}) {
  const values = clone(options.values || { catai_mini_pets_v1: [{ id: 'private', medical: 'private' }] })
  let definition
  let sequence = 0
  const writes = []
  const reads = []
  const modals = []
  const control = { failLoad: false, failSave: false, commitThenThrow: false }
  const driver = {
    getStorageSync(key) {
      reads.push(key)
      if (control.failLoad) throw Error('read failed')
      return clone(values[key])
    },
    setStorageSync(key, value) {
      if (control.failSave) throw Error('quota')
      values[key] = clone(value)
      writes.push(key)
      if (control.commitThenThrow) throw Error('uncertain write result')
    },
    removeStorageSync(key) { delete values[key] }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/cato-capture/index.js'), 'utf8'), {
    require(request) {
      if (request === '../../utils/cato-capture') return capture
      if (request === '../../services/cato-lab') return {
        createStore(variant) { assert.equal(variant, 'capture'); return createStore(variant, driver) },
        uid(prefix) { assert.equal(prefix, 'capture'); return 'capture_' + (++sequence) }
      }
      throw Error('Unexpected import: ' + request)
    },
    Page(value) { definition = value },
    wx: { showModal(value) { modals.push(value) } },
    Date
  })
  const page = { ...definition, data: clone(definition.data) }
  page.setData = patch => Object.assign(page.data, clone(patch))
  page.onLoad()
  function prepare(text = '明天换水；清洗食盆') {
    page.onInput(event({}, text))
    page.prepareDrafts()
    return page.data.batch
  }
  function resolveTimes() {
    page.data.batch.drafts.forEach(draft => page.chooseTimeMode(event({ id: draft.id, mode: 'unscheduled' })))
  }
  return { page, values, writes, reads, modals, control, prepare, resolveTimes }
}

test('pure: blank, separators-only, invalid source and oversized input are rejected', () => {
  for (const text of ['', '   ', '\n；;。']) assert.throws(() => capture.parseDrafts(text, 'b'))
  assert.throws(() => capture.parseDrafts('换水', 'b', 'real-voice'))
  assert.throws(() => capture.parseDrafts('换水', '../escape'))
  assert.throws(() => capture.parseDrafts('水'.repeat(3001), 'b'), /3000/)
})

test('pure: splits only documented separators, retaining source text and ordering', () => {
  const batch = capture.parseDrafts(' 明天换水；\n洗碗，然后放好。擦地;整理玩具\n', 'b')
  assert.deepEqual(batch.drafts.map(d => d.title), ['明天换水', '洗碗，然后放好', '擦地', '整理玩具'])
  assert.equal(batch.drafts[0].originalText, '明天换水')
  assert.equal(new Set(batch.drafts.map(d => d.id)).size, 4)
  assert.equal(batch.drafts.every(d => d.timeMode === 'review' && !d.date && !d.time), true)
})

test('pure: does not truncate 180-character items or discard items above the batch limit', () => {
  assert.equal(capture.parseDrafts('水'.repeat(180), 'b').drafts[0].title.length, 180)
  assert.throws(() => capture.parseDrafts('水'.repeat(181), 'b'), /180/)
  assert.equal(capture.parseDrafts(Array(20).fill('换水').join(';'), 'b').drafts.length, 20)
  assert.throws(() => capture.parseDrafts(Array(21).fill('换水').join(';'), 'b'), /20/)
})

test('pure: uncertain, explicit and absent time all require human confirmation', () => {
  for (const text of ['明天换水', '周末换水', '2026-10-01 18:30 换水', '换水']) {
    const batch = capture.parseDrafts(text, 'b')
    assert.equal(batch.drafts[0].timeMode, 'review')
    assert.ok(batch.drafts[0].timeHint)
    assert.throws(() => capture.confirmBatch(capture.emptyState(), batch, NOW), /时间待核对/)
  }
})

test('pure: date validation handles leap years and prevents rollover and invalid times', () => {
  for (const date of ['2024-02-29', '2000-01-01', '2100-12-31']) assert.equal(capture.validDate(date), true)
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '1999-01-01', '2101-01-01', '2026-9-1']) assert.equal(capture.validDate(date), false)
  for (const time of ['00:00', '23:59']) assert.equal(capture.validTime(time), true)
  for (const time of ['24:00', '12:60', '9:30', '', null]) assert.equal(capture.validTime(time), false)
})

test('pure: editing is immutable and cannot alter identity, source or original text', () => {
  const batch = capture.parseDrafts('明天换水', 'b', 'voice-sample')
  const next = capture.updateDraft(batch, 'b_0', { title: '换新鲜饮用水', id: 'evil', source: 'text', originalText: 'evil' })
  assert.equal(batch.drafts[0].title, '明天换水')
  assert.equal(next.drafts[0].title, '换新鲜饮用水')
  assert.equal(next.drafts[0].source, 'voice-sample')
  assert.equal(next.drafts[0].originalText, '明天换水')
  assert.equal(next.drafts[0].id, 'b_0')
  assert.throws(() => capture.updateDraft(batch, 'missing', {}))
  assert.throws(() => capture.updateDraft(batch, 'b_0', { timeMode: 'automatic' }))
})

test('pure: manual schedules require both fields and unscheduled clears stale fields', () => {
  let batch = capture.parseDrafts('明天换水', 'b')
  batch = capture.updateDraft(batch, 'b_0', { timeMode: 'scheduled', date: '2026-10-01' })
  assert.throws(() => capture.confirmBatch(capture.emptyState(), batch, NOW), /补全/)
  batch = capture.updateDraft(batch, 'b_0', { time: '18:30' })
  const result = capture.confirmBatch(capture.emptyState(), batch, NOW)
  assert.equal(result.state.items[0].date, '2026-10-01')
  assert.equal(result.state.items[0].time, '18:30')
  batch = capture.updateDraft(batch, 'b_0', { timeMode: 'unscheduled' })
  assert.equal(batch.drafts[0].date, '')
  assert.equal(batch.drafts[0].time, '')
})

test('pure: repeated confirmation is idempotent even after all batch items are deleted', () => {
  const batch = readyBatch()
  const original = capture.emptyState()
  const first = capture.confirmBatch(original, batch, NOW)
  assert.equal(original.items.length, 0)
  assert.equal(first.added, 2)
  const second = capture.confirmBatch(first.state, batch, NOW)
  assert.equal(second.added, 0)
  assert.equal(second.alreadyCommitted, true)
  let removed = capture.changeItem(first.state, batch.drafts[0].id, 'remove')
  removed = capture.changeItem(removed, batch.drafts[1].id, 'remove')
  const retried = capture.confirmBatch(removed, batch, NOW)
  assert.equal(retried.state.items.length, 0)
  assert.deepEqual(retried.state.committedBatches, [batch.id])
})

test('pure: rejects duplicate identities and unreviewed/empty content without partial commit', () => {
  const batch = readyBatch()
  batch.drafts[1].id = batch.drafts[0].id
  assert.throws(() => capture.confirmBatch(capture.emptyState(), batch, NOW), /重复/)
  batch.drafts[1].id = batch.id + '_1'
  batch.drafts[1].title = ' '
  assert.throws(() => capture.confirmBatch(capture.emptyState(), batch, NOW), /内容/)
  assert.throws(() => capture.confirmBatch(capture.emptyState(), readyBatch(), 'invalid'), /时间无效/)
})

test('pure: identical text in a new explicitly confirmed batch remains a legitimate new item', () => {
  const first = capture.confirmBatch(capture.emptyState(), readyBatch('a', '换水'), NOW)
  const second = capture.confirmBatch(first.state, readyBatch('b', '换水'), NOW)
  assert.equal(second.state.items.length, 2)
})

test('pure: capacity failure is atomic and completed status can be undone', () => {
  let state = capture.emptyState()
  for (let index = 0; index < 25; index++) state = capture.confirmBatch(state, readyBatch('batch_' + index, Array(20).fill('换水').join(';')), NOW).state
  assert.equal(state.items.length, 500)
  assert.throws(() => capture.confirmBatch(state, readyBatch('overflow'), NOW), /500/)
  assert.equal(state.items.length, 500)
  const done = capture.changeItem(state, state.items[0].id, 'toggle')
  assert.equal(done.items[0].done, true)
  assert.equal(capture.changeItem(done, state.items[0].id, 'toggle').items[0].done, false)
  assert.throws(() => capture.changeItem(state, 'missing', 'remove'))
})

test('pure: corrupted persisted data is rejected rather than replaced with an empty inbox', () => {
  for (const state of [null, {}, [], { version: 2, items: [], committedBatches: [] }, { version: 1, items: [{}], committedBatches: [] }]) assert.throws(() => capture.validateState(state))
  const state = capture.confirmBatch(capture.emptyState(), readyBatch(), NOW).state
  state.committedBatches = []
  assert.throws(() => capture.validateState(state), /格式异常/)
})

test('page: opening and preparing drafts do not write business data or read original archives', () => {
  const env = makePage()
  env.prepare()
  assert.equal(env.page.data.batch.drafts.length, 2)
  assert.deepEqual(env.writes, [])
  assert.equal(env.values[KEY], undefined)
  assert.equal(env.reads.every(key => key === KEY), true)
  assert.deepEqual(env.values.catai_mini_pets_v1, [{ id: 'private', medical: 'private' }])
})

test('page: invalid input and unreviewed time cannot create any records', () => {
  const env = makePage()
  env.prepare('；\n')
  assert.equal(env.page.data.batch, null)
  assert.match(env.page.data.error, /填写事项/)
  env.prepare()
  env.page.confirmDrafts()
  assert.match(env.page.data.error, /时间待核对/)
  assert.ok(env.page.data.batch)
  assert.deepEqual(env.writes, [])
})

test('page: cancel modal dismissal preserves drafts; confirmed cancel leaves no business record', () => {
  const env = makePage()
  env.prepare()
  env.page.cancelBatch()
  env.modals.pop().success({ confirm: false })
  assert.ok(env.page.data.batch)
  env.page.cancelBatch()
  env.modals.pop().success({ confirm: true })
  assert.equal(env.page.data.batch, null)
  assert.equal(env.page.data.input, '明天换水；清洗食盆')
  assert.deepEqual(env.writes, [])
  assert.equal(env.values[KEY], undefined)
})

test('page: edit each draft, explicitly confirm, reload and repeat tap without duplicates', () => {
  const env = makePage()
  const batch = env.prepare()
  env.page.editDraft(event({ id: batch.drafts[0].id, field: 'title' }, '给饮水碗换水'))
  env.resolveTimes()
  env.page.confirmDrafts()
  env.page.confirmDrafts()
  assert.equal(env.page.data.batch, null)
  assert.equal(env.page.data.input, '')
  assert.equal(env.values[KEY].items.length, 2)
  assert.equal(env.values[KEY].items[0].title, '给饮水碗换水')
  assert.equal(env.values[KEY].items[0].originalText, '明天换水')
  assert.deepEqual(env.writes, [KEY])
  const reopened = makePage({ values: env.values })
  assert.equal(reopened.page.data.count, 2)
  assert.equal(reopened.page.data.items[0].timeLabel, '先不设时间')
})

test('page: manual pickers persist date/time only after both are set', () => {
  const env = makePage()
  const batch = env.prepare('换水')
  const id = batch.drafts[0].id
  env.page.editDraft(event({ id, field: 'date' }, '2026-10-01'))
  env.page.confirmDrafts()
  assert.equal(env.writes.length, 0)
  env.page.editDraft(event({ id, field: 'time' }, '08:45'))
  env.page.confirmDrafts()
  assert.equal(env.values[KEY].items[0].date, '2026-10-01')
  assert.equal(env.values[KEY].items[0].time, '08:45')
})

test('page: storage write failure retains edited draft and retry creates one batch only', () => {
  const env = makePage()
  const batch = env.prepare('换水')
  env.page.editDraft(event({ id: batch.drafts[0].id, field: 'title' }, '编辑后的换水事项'))
  env.resolveTimes()
  const before = clone(env.page.data.batch)
  env.control.failSave = true
  env.page.confirmDrafts()
  assert.deepEqual(env.page.data.batch, before)
  assert.equal(env.page.data.items.length, 0)
  assert.equal(env.page.data.saving, false)
  assert.match(env.page.data.error, /草稿仍保留/)
  env.control.failSave = false
  env.page.confirmDrafts()
  assert.equal(env.values[KEY].items.length, 1)
  assert.equal(env.values[KEY].items[0].title, '编辑后的换水事项')
})

test('page: uncertain write success is recovered by batch receipt instead of duplicating data', () => {
  const env = makePage()
  env.prepare('换水')
  env.resolveTimes()
  env.control.commitThenThrow = true
  env.page.confirmDrafts()
  assert.ok(env.page.data.batch)
  assert.equal(env.values[KEY].items.length, 1)
  assert.equal(env.page.data.saveUncertain, true)
  const id = env.page.data.batch.drafts[0].id
  env.page.editDraft(event({ id, field: 'title' }, '不得把已提交批次悄悄改写'))
  env.page.removeDraft(event({ id }))
  assert.equal(env.page.data.batch.drafts[0].title, '换水')
  env.control.commitThenThrow = false
  env.page.confirmDrafts()
  assert.equal(env.page.data.batch, null)
  assert.equal(env.values[KEY].items.length, 1)
  assert.equal(env.writes.length, 1)
  assert.match(env.page.data.notice, /没有重复创建/)
})

test('page: cancelling after uncertain write does not claim rollback and refreshes saved inbox', () => {
  const env = makePage()
  env.prepare('换水')
  env.resolveTimes()
  env.control.commitThenThrow = true
  env.page.confirmDrafts()
  env.page.cancelBatch()
  const modal = env.modals.pop()
  assert.match(modal.content, /不会撤回/)
  modal.success({ confirm: true })
  assert.equal(env.page.data.batch, null)
  assert.equal(env.page.data.items.length, 1)
  assert.equal(env.values[KEY].items.length, 1)
  assert.equal(env.writes.length, 1)
})

test('page: reads latest inbox before confirmation so another local batch is preserved', () => {
  const env = makePage()
  env.prepare('换水')
  env.resolveTimes()
  env.values[KEY] = capture.confirmBatch(capture.emptyState(), readyBatch('other', '洗碗'), NOW).state
  env.page.confirmDrafts()
  assert.equal(env.values[KEY].items.length, 2)
  assert.equal(env.values[KEY].items[1].title, '洗碗')
})

test('page: read failures and malformed storage cannot overwrite existing inbox', () => {
  const env = makePage({ values: { [KEY]: { corrupt: 'keep' } } })
  assert.equal(env.page.data.loadFailed, true)
  env.prepare('换水')
  env.resolveTimes()
  env.page.confirmDrafts()
  assert.deepEqual(env.values[KEY], { corrupt: 'keep' })
  assert.deepEqual(env.writes, [])
  env.values[KEY] = capture.emptyState()
  env.control.failLoad = true
  env.page.reloadInbox()
  assert.equal(env.page.data.loadFailed, true)
  env.control.failLoad = false
  env.page.reloadInbox()
  assert.equal(env.page.data.loadFailed, false)
  env.page.confirmDrafts()
  assert.equal(env.values[KEY].items.length, 1)
})

test('page: complete/undo/delete work locally and failed mutation leaves visible state unchanged', () => {
  const env = makePage()
  env.prepare('换水')
  env.resolveTimes()
  env.page.confirmDrafts()
  const id = env.page.data.items[0].id
  env.control.failSave = true
  env.page.toggleItem(event({ id }))
  assert.equal(env.page.data.items[0].done, false)
  assert.equal(env.values[KEY].items[0].done, false)
  env.control.failSave = false
  env.page.toggleItem(event({ id }))
  assert.equal(env.page.data.items[0].done, true)
  env.page.toggleItem(event({ id }))
  assert.equal(env.page.data.items[0].done, false)
  env.page.removeItem(event({ id }))
  env.modals.pop().success({ confirm: false })
  assert.equal(env.values[KEY].items.length, 1)
  env.page.removeItem(event({ id }))
  env.modals.pop().success({ confirm: true })
  assert.equal(env.values[KEY].items.length, 0)
  assert.equal(env.values[KEY].committedBatches.length, 1)
})

test('page: synthetic samples keep their provenance through editing and saving', () => {
  for (const source of ['voice-sample', 'image-sample']) {
    const env = makePage()
    env.page.useSample(event({ source }))
    assert.equal(env.page.data.input, capture.SAMPLES[source])
    assert.match(env.page.data.sourceLabel, /合成/)
    env.page.onInput(event({}, '手动编辑过的样本'))
    env.page.prepareDrafts()
    env.resolveTimes()
    env.page.confirmDrafts()
    assert.equal(env.values[KEY].items[0].source, source)
    assert.match(env.page.data.items[0].sourceLabel, /合成/)
  }
})

test('page: sample replacement and new manual input require explicit destructive-input confirmation', () => {
  const env = makePage()
  env.page.onInput(event({}, '不要丢失'))
  env.page.useSample(event({ source: 'voice-sample' }))
  env.modals.pop().success({ confirm: false })
  assert.equal(env.page.data.input, '不要丢失')
  env.page.useSample(event({ source: 'voice-sample' }))
  env.modals.pop().success({ confirm: true })
  env.page.startText()
  env.modals.pop().success({ confirm: false })
  assert.equal(env.page.data.source, 'voice-sample')
  env.page.startText()
  env.modals.pop().success({ confirm: true })
  assert.equal(env.page.data.source, 'text')
  assert.equal(env.page.data.input, '')
  assert.deepEqual(env.writes, [])
})

test('page: removing last draft makes no records and stale cancel cannot discard a newer batch', () => {
  const env = makePage()
  const batch = env.prepare('换水')
  env.page.cancelBatch()
  const stale = env.modals.pop()
  env.page.removeDraft(event({ id: batch.drafts[0].id }))
  assert.equal(env.page.data.batch, null)
  assert.equal(env.page.data.input, '换水')
  env.page.prepareDrafts()
  stale.success({ confirm: true })
  assert.ok(env.page.data.batch)
  assert.notEqual(env.page.data.batch.id, batch.id)
  assert.deepEqual(env.writes, [])
})

test('contract: correct route, offline labels, touch targets, safe-area and no network/media APIs', () => {
  const root = path.join(__dirname, '..')
  const config = require('../config/cato-lab')
  assert.equal(config.enabled, true)
  assert.equal(config.variant, 'capture')
  assert.equal(config.entry, '/pages/cato-capture/index')
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages.includes('pages/cato-capture/index'))
  JSON.parse(fs.readFileSync(path.join(root, 'pages/cato-capture/index.json'), 'utf8'))
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-capture/index.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-capture/index.wxss'), 'utf8')
  const shared = fs.readFileSync(path.join(root, 'styles/cato-lab.wxss'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'pages/cato-capture/index.js'), 'utf8')
  assert.match(wxml, /离线实验/)
  assert.match(wxml, /合成语音文字/)
  assert.match(wxml, /合成图片文字/)
  assert.match(wxml, /兽医/)
  assert.match(shared, /min-height: 88rpx/)
  assert.match(shared, /safe-area-inset-bottom/)
  assert.match(css, /flex-wrap: wrap/)
  assert.match(css, /min-width: 0/)
  assert.doesNotMatch(css, /text-overflow|white-space:\s*nowrap|font-weight:\s*(650|750|780)/)
  assert.doesNotMatch(page, /wx\.(request|cloud|uploadFile|chooseMedia|getRecorderManager|requestSubscribeMessage)|readLocalCatCards/)
})
