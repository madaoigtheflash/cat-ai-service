const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../utils/cato-companion')
const { createPageOptions } = require('../pages/cato-companion/index')

const KEY = 'catai_cato_lab_v1:companion:preferences'
function preferences(patch) { return Object.assign(model.defaults(), patch) }
function setup(options = {}) {
  const values = Object.assign({ original: 'untouched', 'catai_cato_lab_v1:other:preferences': 'untouched' }, options.values)
  const calls = { reads: [], writes: [], modals: [] }
  const flags = { failRead: !!options.failRead, failWrite: !!options.failWrite, failModal: !!options.failModal }
  const api = {
    getStorageSync(key) { calls.reads.push(key); if (flags.failRead) throw Error('read failed'); return values[key] },
    setStorageSync(key, value) { if (flags.failWrite) throw Error('quota'); calls.writes.push(key); values[key] = JSON.parse(JSON.stringify(value)) },
    showModal(config) { if (flags.failModal) { config.fail(); return }; calls.modals.push(config) }
  }
  const optionsObject = createPageOptions({ api, systemReduceMotion: options.systemReduceMotion })
  const page = Object.assign({}, optionsObject, { data: JSON.parse(JSON.stringify(optionsObject.data)), setData(patch) { Object.assign(this.data, patch) } })
  page.onLoad()
  const edit = (key, value) => page.edit({ currentTarget: { dataset: { key, value } }, detail: { value } })
  const respond = confirm => calls.modals[calls.modals.length - 1].success({ confirm })
  return { page, values, calls, flags, edit, respond }
}

test('defaults: notifications off, cross-midnight quiet hours, conservative reduced motion', () => {
  assert.deepEqual(model.defaults(), { nickname: '猫咪家长', assistantName: '小猫助手', tone: 'gentle', notificationsEnabled: false, quietEnabled: true, quietStart: '22:00', quietEnd: '08:00', reduceMotion: true })
  assert.equal(model.defaults(true).reduceMotion, true)
  assert.equal(model.defaults(false).reduceMotion, false)
})

test('validation trims names and projects only preference fields', () => {
  const result = model.validate(preferences({ nickname: '  阿桃  ', assistantName: ' 小云 ', simulatedTime: '10:00', privatePhoto: 'never saved' }))
  assert.equal(result.ok, true)
  assert.equal(result.value.nickname, '阿桃')
  assert.equal(result.value.assistantName, '小云')
  assert.equal('simulatedTime' in result.value, false)
  assert.equal('privatePhoto' in result.value, false)
})

test('validation accepts 12 Unicode characters, rejects blank, control, and overlength names', () => {
  assert.equal(model.validate(preferences({ nickname: '猫'.repeat(12), assistantName: '🐈'.repeat(12) })).ok, true)
  for (const key of ['nickname', 'assistantName']) {
    for (const value of [' ', '猫'.repeat(13), '🐈'.repeat(13), '猫\n猫', 12]) assert.ok(model.validate(preferences({ [key]: value })).errors[key])
  }
})

test('invalid times, tones and non-boolean switches are rejected', () => {
  for (const value of ['24:00', '08:60', '8:00', '-1:00', '', null]) assert.equal(model.minutes(value), null)
  assert.equal(model.minutes('00:00'), 0)
  assert.equal(model.minutes('23:59'), 1439)
  for (const patch of [{ tone: 'pushy' }, { notificationsEnabled: 'false' }, { quietEnabled: 1 }, { reduceMotion: undefined }, { quietStart: '25:00' }, { quietEnd: '22:60' }]) assert.equal(model.validate(preferences(patch)).ok, false)
})

test('cross-midnight quiet range includes start and excludes end', () => {
  const prefs = preferences()
  for (const value of ['22:00', '23:59', '00:00', '07:59']) assert.equal(model.isQuiet(prefs, value), true, value)
  for (const value of ['08:00', '12:00', '21:59']) assert.equal(model.isQuiet(prefs, value), false, value)
})

test('same-day range includes start and excludes end', () => {
  const prefs = preferences({ quietStart: '09:00', quietEnd: '17:00' })
  assert.equal(model.isQuiet(prefs, '08:59'), false)
  assert.equal(model.isQuiet(prefs, '09:00'), true)
  assert.equal(model.isQuiet(prefs, '16:59'), true)
  assert.equal(model.isQuiet(prefs, '17:00'), false)
})

test('equal quiet endpoints mean all-day quiet, disabled quiet overrides equality', () => {
  const prefs = preferences({ quietStart: '08:00', quietEnd: '08:00' })
  for (const value of ['00:00', '08:00', '23:59']) assert.equal(model.isQuiet(prefs, value), true)
  assert.equal(model.isQuiet(Object.assign({}, prefs, { quietEnabled: false }), '08:00'), false)
})

test('prompt evaluation prioritizes off, suppresses quiet hours, and fails closed on invalid input', () => {
  assert.equal(model.promptResult(preferences(), '12:00', 'start').kind, 'off')
  const prefs = preferences({ notificationsEnabled: true })
  assert.equal(model.promptResult(prefs, '23:00', 'start').kind, 'quiet')
  assert.equal(model.promptResult(prefs, '08:00', 'start').shown, true)
  assert.equal(model.promptResult(Object.assign({}, prefs, { quietEnabled: false }), '23:00', 'start').shown, true)
  assert.equal(model.promptResult(prefs, '24:00', 'start').shown, false)
  assert.equal(model.promptResult(Object.assign({}, prefs, { quietStart: 'bad' }), '12:00', 'start').shown, false)
})

test('all three scenes use chosen nickname and both tones; no coercion in interruption', () => {
  for (const scene of model.SCENARIOS) {
    const gentle = model.sceneText(preferences({ nickname: '阿桃' }), scene)
    const concise = model.sceneText(preferences({ nickname: '阿桃', tone: 'concise' }), scene)
    assert.match(gentle, /阿桃/); assert.match(concise, /阿桃/)
    assert.notEqual(gentle, concise)
  }
  assert.match(model.sceneText(preferences({ assistantName: '小云' }), 'start'), /小云/)
  assert.match(model.sceneText(preferences(), 'interrupted'), /不用补打卡/)
})

test('restore preserves saved reduced-motion choice and defaults missing keys without writing', () => {
  assert.equal(model.restore({ reduceMotion: false }, true).reduceMotion, false)
  assert.equal(model.restore(null).notificationsEnabled, false)
  assert.throws(() => model.restore('bad'), /格式无效/)
  assert.throws(() => model.restore({ nickname: '' }), /无效内容/)
})

test('preference equality is independent of object property order', () => {
  const first = model.defaults()
  const second = Object.fromEntries(Object.entries(first).reverse())
  assert.equal(model.equal(first, second), true)
  assert.equal(model.equal(first, preferences({ reduceMotion: false })), false)
})

test('controller initially reads only own namespace, writes nothing, and shows local preview', () => {
  const { page, calls } = setup()
  assert.deepEqual(calls.reads, [KEY]); assert.deepEqual(calls.writes, [])
  assert.equal(page.data.dirty, false)
  assert.equal(page.data.simulatedTime, '23:00')
  assert.equal(page.data.draft.reduceMotion, true)
  assert.match(page.data.previewText, /小猫助手/)
  assert.equal(page.data.prompt, null)
})

test('controller previews names, tone and scenes without persisting', () => {
  const { page, edit, calls } = setup()
  edit('nickname', '阿桃'); edit('assistantName', '小云'); edit('tone', 'concise')
  assert.match(page.data.previewText, /阿桃，小云/)
  page.chooseScenario({ currentTarget: { dataset: { value: 'interrupted' } } })
  assert.match(page.data.previewText, /已暂停/)
  page.chooseScenario({ currentTarget: { dataset: { value: 'finished' } } })
  assert.match(page.data.previewText, /本次结束/)
  assert.equal(page.data.dirty, true)
  assert.deepEqual(calls.writes, [])
})

test('controller simulated clock proves default-off and cross-midnight suppression', () => {
  const { page, edit, calls } = setup()
  page.simulatePrompt(); assert.equal(page.data.prompt.kind, 'off')
  edit('notificationsEnabled', true); assert.equal(page.data.prompt.kind, 'quiet')
  page.changeClock({ currentTarget: { dataset: { value: '07:59' } } }); assert.equal(page.data.prompt.shown, false)
  page.changeClock({ detail: { value: '08:00' }, currentTarget: { dataset: {} } }); assert.equal(page.data.prompt.shown, true)
  edit('quietStart', '08:00'); assert.equal(page.data.prompt.kind, 'quiet')
  assert.match(page.data.quietDescription, /全天安静/)
  edit('quietEnabled', false); assert.equal(page.data.prompt.shown, true)
  page.changeClock({ detail: { value: '25:00' }, currentTarget: { dataset: {} } }); assert.equal(page.data.simulatedTime, '08:00')
  assert.deepEqual(calls.writes, [])
})

test('controller reduced-motion toggle updates immediately and discard restores it', () => {
  const { page, edit, respond } = setup()
  edit('reduceMotion', false); assert.equal(page.data.draft.reduceMotion, false)
  page.discard(); respond(true); assert.equal(page.data.draft.reduceMotion, true)
  assert.equal(page.data.dirty, false)
})

test('cancelled save retains draft and never persists', () => {
  const { page, edit, calls, respond } = setup()
  edit('nickname', '阿桃'); page.save(); respond(false)
  assert.equal(page.data.draft.nickname, '阿桃'); assert.equal(page.data.dirty, true)
  assert.deepEqual(calls.writes, []); assert.equal(page.data.busy, false)
})

test('confirmed save trims and persists only preferences, duplicate save is idempotent', () => {
  const { page, edit, calls, respond, values } = setup()
  edit('nickname', ' 阿桃 '); edit('reduceMotion', false)
  page.simulatePrompt(); page.save(); page.save()
  assert.equal(calls.modals.length, 1)
  respond(true); respond(true); page.save()
  assert.deepEqual(calls.writes, [KEY])
  assert.equal(values[KEY].nickname, '阿桃'); assert.equal(values[KEY].reduceMotion, false)
  assert.deepEqual(Object.keys(values[KEY]).sort(), Object.keys(model.defaults()).sort())
  assert.equal(values.original, 'untouched')
  assert.equal(values['catai_cato_lab_v1:other:preferences'], 'untouched')
  assert.equal(page.data.dirty, false)
})

test('controller invalid nickname blocks save confirmation and keeps draft', () => {
  const { page, edit, calls } = setup()
  edit('nickname', '猫'.repeat(13)); page.save()
  assert.ok(page.data.fieldErrors.nickname)
  assert.deepEqual(calls.modals, []); assert.deepEqual(calls.writes, [])
  assert.equal(page.data.dirty, true)
})

test('whitespace-only change normalizes to saved preference without another write', () => {
  const { page, edit, calls } = setup()
  edit('nickname', ' 猫咪家长 '); page.save()
  assert.equal(page.data.draft.nickname, '猫咪家长')
  assert.equal(page.data.dirty, false)
  assert.deepEqual(calls.modals, []); assert.deepEqual(calls.writes, [])
})

test('failed write keeps draft and last successful saved preference for retry/discard', () => {
  const { page, edit, calls, respond, flags } = setup({ failWrite: true })
  edit('nickname', '阿桃'); page.save(); respond(true)
  assert.equal(page.data.dirty, true); assert.equal(page.data.busy, false)
  assert.match(page.data.error, /保存失败/); assert.equal(page.saved.nickname, '猫咪家长')
  flags.failWrite = false; page.save(); respond(true)
  assert.equal(page.data.dirty, false); assert.deepEqual(calls.writes, [KEY])
})

test('discard cancellation preserves draft; confirmed discard writes nothing', () => {
  const { page, edit, calls, respond } = setup()
  edit('nickname', '阿桃'); page.discard(); respond(false)
  assert.equal(page.data.draft.nickname, '阿桃')
  page.discard(); respond(true)
  assert.equal(page.data.draft.nickname, '猫咪家长'); assert.equal(page.data.dirty, false)
  assert.deepEqual(calls.writes, [])
})

test('reset requires confirmation and successfully stores safe defaults without touching other data', () => {
  const { page, calls, respond, values } = setup({ values: { [KEY]: preferences({ nickname: '阿桃', notificationsEnabled: true, reduceMotion: false }) } })
  page.reset(); respond(false); assert.equal(values[KEY].nickname, '阿桃')
  page.reset(); respond(true)
  assert.deepEqual(values[KEY], model.defaults()); assert.deepEqual(calls.writes, [KEY])
  assert.equal(values.original, 'untouched'); assert.equal(page.data.dirty, false)
})

test('failed reset does not replace in-memory preferences or claim success', () => {
  const saved = preferences({ nickname: '阿桃', reduceMotion: false })
  const { page, respond, values } = setup({ values: { [KEY]: saved }, failWrite: true })
  page.reset(); respond(true)
  assert.equal(page.data.draft.nickname, '阿桃'); assert.equal(page.data.draft.reduceMotion, false)
  assert.deepEqual(values[KEY], saved); assert.match(page.data.error, /保存失败/)
  assert.equal(page.data.status, '')
})

test('failed load blocks overwrite, retry recovers without write', () => {
  const { page, edit, calls, flags } = setup({ failRead: true, values: { [KEY]: preferences({ nickname: '阿桃' }) } })
  assert.equal(page.data.loadFailed, true)
  edit('nickname', '新草稿'); page.save(); assert.deepEqual(calls.modals, [])
  flags.failRead = false; page.loadPreferences()
  assert.equal(page.data.loadFailed, false); assert.equal(page.data.draft.nickname, '阿桃')
  assert.deepEqual(calls.writes, [])
})

test('corrupt local data remains untouched until explicitly confirmed reset', () => {
  const { page, calls, respond, values } = setup({ values: { [KEY]: 'corrupt' } })
  assert.equal(page.data.loadFailed, true); assert.equal(values[KEY], 'corrupt')
  page.reset(); respond(false); assert.equal(values[KEY], 'corrupt')
  page.reset(); respond(true)
  assert.deepEqual(values[KEY], model.defaults()); assert.equal(page.data.loadFailed, false)
  assert.deepEqual(calls.writes, [KEY])
})

test('modal failure cannot write and leaves action available for retry', () => {
  const { page, edit, calls } = setup({ failModal: true })
  edit('nickname', '阿桃'); page.save()
  assert.equal(page.data.busy, false); assert.equal(page.data.dirty, true)
  assert.match(page.data.error, /确认窗口/); assert.deepEqual(calls.writes, [])
})

test('saved local reduced-motion preference is restored on a new controller', () => {
  const one = setup(); one.edit('reduceMotion', false); one.page.save(); one.respond(true)
  const two = setup({ values: one.values })
  assert.equal(two.page.data.draft.reduceMotion, false)
  assert.equal(two.page.data.dirty, false)
})

test('page markup connects real animation toggle, local scope and safe layout', () => {
  const root = path.resolve(__dirname, '..')
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-companion/index.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-companion/index.wxss'), 'utf8')
  const sharedCss = fs.readFileSync(path.join(root, 'styles/cato-lab.wxss'), 'utf8')
  assert.match(wxml, /draft\.reduceMotion \? '' : 'is-moving'/)
  assert.match(css, /\.motion-dot\.is-moving\s*\{ animation:/)
  assert.match(css, /\.reduced-motion \.motion-dot\s*\{ animation: none/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /min-height: 88rpx/); assert.match(sharedCss, /safe-area-inset-bottom/)
  assert.match(wxml, /不是真实猫友/); assert.match(wxml, /不会发微信通知/)
  assert.doesNotMatch(wxml, /&amp;&amp;/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages.includes('pages/cato-companion/index'), true)
})
