const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const planner = require('../utils/cato-care-planner')
const { createStore } = require('../services/cato-lab')
const now = new Date(2026, 8, 29, 12, 30).getTime()
const fields = extra => ({ title: '整理猫咪用品', kind: 'start', date: '2026-09-29', time: '09:00', repeat: 'none', ...extra })
const add = (extra, time = now) => planner.applyCommand(planner.emptyState(), { id: 'task1', type: 'add', task: fields(extra) }, time)
const command = (state, id, type, day = '2026-09-29', time = now) => planner.applyCommand(state, { id, type, taskId: 'task1', date: day }, time)

test('创建开始、截止、随时事项，时间由输入给出；纯函数不改输入', () => {
  for (const kind of planner.KINDS) {
    const state = planner.emptyState()
    const next = planner.applyCommand(state, { id: 'task1', type: 'add', task: fields({ kind }) }, now)
    assert.equal(state.tasks.length, 0)
    assert.equal(next.tasks[0].kind, kind)
    assert.equal(next.tasks[0].createdAt, now)
    assert.equal(next.tasks[0].time, kind === 'anytime' ? '' : '09:00')
    assert.equal(planner.occurrences(next, '2026-09-29', now).length, 1)
  }
})
test('时间与日期严格校验，不接受空白、溢出、非法日期和无效重复', () => {
  for (const date of ['', '2026-2-01', '2026-02-29', '2026-04-31', '1899-12-31', 'NaN', null]) assert.throws(() => add({ date }))
  for (const time of ['', '24:00', '12:60', '1:00', null]) assert.throws(() => add({ time }))
  for (const extra of [{ title: ' ' }, { title: '字'.repeat(81) }, { kind: 'medicine' }, { repeat: 'hourly' }]) assert.throws(() => add(extra))
  assert.throws(() => add({}, NaN))
  assert.equal(planner.parseDate('2024-02-29').day, 29)
})
test('单次、每日、每周遵守首日和星期，不产生首日之前的事项', () => {
  for (const repeat of planner.REPEATS) assert.equal(planner.occursOn(add({ repeat }).tasks[0], '2026-09-28'), false)
  assert.equal(planner.occursOn(add().tasks[0], '2026-09-30'), false)
  assert.equal(planner.occursOn(add({ repeat: 'daily' }).tasks[0], '2026-09-30'), true)
  const weekly = add({ repeat: 'weekly' }).tasks[0]
  assert.equal(planner.occursOn(weekly, '2026-10-06'), true)
  assert.equal(planner.occursOn(weekly, '2026-10-05'), false)
})
test('月末短月夹取不漂移，闰年和跨年正确', () => {
  const task = add({ date: '2024-01-31', repeat: 'monthly' }).tasks[0]
  for (const day of ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30', '2025-01-31', '2025-02-28']) assert.equal(planner.occursOn(task, day), true, day)
  for (const day of ['2024-03-29', '2024-03-30', '2025-02-27']) assert.equal(planner.occursOn(task, day), false, day)
  const task30 = add({ date: '2025-01-30', repeat: 'monthly' }).tasks[0]
  assert.equal(planner.occursOn(task30, '2025-02-28'), true)
  assert.equal(planner.occursOn(task30, '2025-03-30'), true)
})
test('周一至周五不包含周末；从周末开始等到周一，不假装识别节假日', () => {
  const task = add({ date: '2026-09-26', repeat: 'workday' }).tasks[0]
  assert.equal(planner.occursOn(task, '2026-09-26'), false)
  assert.equal(planner.occursOn(task, '2026-09-27'), false)
  assert.equal(planner.occursOn(task, '2026-09-28'), true)
  assert.equal(planner.occursOn(task, '2026-10-01'), true)
})
test('同日多次打卡、逐次撤销；跨日是独立发生记录', () => {
  const original = add({ repeat: 'daily' })
  let state = command(original, 'check1', 'check')
  state = command(state, 'check2', 'check', '2026-09-29', now + 1000)
  assert.equal(original.logs['task1@2026-09-29'], undefined)
  assert.equal(planner.occurrences(state, '2026-09-29', now)[0].count, 2)
  state = command(state, 'undo1', 'undo')
  assert.deepEqual(state.logs['task1@2026-09-29'].checks, [{ id: 'check1', at: now }])
  const tomorrow = new Date(2026, 8, 30, 0, 1).getTime()
  assert.equal(planner.occurrences(state, '2026-09-30', tomorrow)[0].count, 0)
  state = command(state, 'tomorrow', 'check', '2026-09-30', tomorrow)
  assert.equal(state.logs['task1@2026-09-29'].checks.length, 1)
  assert.equal(state.logs['task1@2026-09-30'].checks.length, 1)
})
test('命令重试幂等，重复创建、打卡、撤销不追加或再撤销', () => {
  let state = add()
  assert.strictEqual(planner.applyCommand(state, { id: 'task1', type: 'add', task: fields() }, now), state)
  state = command(state, 'check1', 'check')
  assert.strictEqual(command(state, 'check1', 'check'), state)
  state = command(state, 'check2', 'check')
  state = command(state, 'undo1', 'undo')
  assert.strictEqual(command(state, 'undo1', 'undo'), state)
  assert.equal(state.logs['task1@2026-09-29'].checks.length, 1)
})
test('跳过可撤销，只影响选中当天，不覆盖已有完成', () => {
  let state = command(add({ repeat: 'daily' }), 'skip1', 'skip')
  assert.strictEqual(command(state, 'skip1', 'skip'), state)
  assert.equal(planner.occurrences(state, '2026-09-29', now)[0].skipped, true)
  assert.equal(planner.occurrences(state, '2026-09-30', now)[0].skipped, false)
  assert.throws(() => command(state, 'badcheck', 'check'), /撤销/)
  state = command(state, 'unskip', 'undo')
  state = command(state, 'check1', 'check')
  assert.throws(() => command(state, 'badskip', 'skip'), /已有打卡/)
  state = command(state, 'uncheck', 'undo')
  assert.throws(() => command(state, 'emptyundo', 'undo'), /没有可撤销/)
})
test('暂停、恢复不删除记录、不补记，暂停仍能撤销历史', () => {
  let state = command(add({ repeat: 'daily' }), 'check1', 'check')
  state = command(state, 'pause1', 'pause')
  assert.equal(planner.occurrences(state, '2026-09-29', now)[0].count, 1)
  assert.equal(planner.occurrences(state, '2026-09-29', now)[0].canCheck, false)
  assert.throws(() => command(state, 'check2', 'check'), /暂停/)
  state = command(state, 'undo1', 'undo')
  state = command(state, 'resume1', 'resume')
  assert.equal(planner.occurrences(state, '2026-09-29', now)[0].canCheck, true)
  assert.equal(planner.occurrences(state, '2026-09-30', now)[0].count, 0)
})
test('未来日只预览，非发生日期、未知事项及无效操作拒绝', () => {
  const state = add({ repeat: 'daily' })
  assert.equal(planner.occurrences(state, '2026-09-30', now)[0].canCheck, false)
  assert.throws(() => command(state, 'future', 'check', '2026-09-30'), /提前/)
  assert.throws(() => command(add(), 'invalid', 'check', '2026-09-28'), /日程/)
  assert.throws(() => planner.applyCommand(state, { id: 'missing', type: 'pause', taskId: 'missing' }, now), /未找到/)
  assert.throws(() => command(state, 'unknown', 'delete'))
  assert.throws(() => planner.applyCommand(state, { id: '../bad', type: 'add' }, now))
})
test('开始和截止提示采用注入的设备本地时刻', () => {
  const start = add({ time: '13:00' })
  const ddl = add({ kind: 'ddl', time: '13:00' })
  assert.equal(planner.occurrences(start, '2026-09-29', now)[0].status, '等待开始时间')
  assert.equal(planner.occurrences(ddl, '2026-09-29', now)[0].status, '截止前')
  const later = new Date(2026, 8, 29, 13, 0).getTime()
  assert.equal(planner.occurrences(start, '2026-09-29', later)[0].status, '已到开始时间')
  assert.equal(planner.occurrences(ddl, '2026-09-29', later)[0].status, '已到截止时间')
})
test('本地日期不使用UTC日截取，夏令时跨日仍按民用日递增', () => {
  const modulePath = path.resolve(__dirname, '../utils/cato-care-planner.js')
  const script = `const assert=require('node:assert/strict');const p=require(${JSON.stringify(modulePath)});assert.equal(p.localDate(new Date(2026,8,29,0,15).getTime()),'2026-09-29');assert.equal(p.shiftDate('2026-03-08',1),'2026-03-09');assert.equal(p.shiftDate('2026-11-01',1),'2026-11-02');`
  for (const TZ of ['Asia/Shanghai', 'America/New_York']) {
    const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(planner.shiftDate('2026-12-31', 1), '2027-01-01')
  assert.equal(planner.shiftDate('2024-03-01', -1), '2024-02-29')
})
test('损坏本地状态拒绝加载，保留原数据而非静默清空', () => {
  for (const state of [null, [], {}, { ...planner.emptyState(), version: 2 }, { ...planner.emptyState(), commands: ['x', 'x'] }]) assert.throws(() => planner.assertState(state))
  const state = add()
  state.logs['task1@2026-02-30'] = { checks: [], skipped: false }
  assert.throws(() => planner.assertState(state))
})
test('隔离存储保留旧档案和其他实验；写入失败不吞掉', () => {
  const values = { catai_mini_pets_v1: ['private'], 'catai_cato_lab_v1:other:planner': 'other' }
  const driver = { getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = value } }
  const store = createStore('care-planner', driver)
  store.save('planner', add())
  assert.equal(values['catai_cato_lab_v1:care-planner:planner'].tasks.length, 1)
  assert.deepEqual(values.catai_mini_pets_v1, ['private'])
  assert.equal(values['catai_cato_lab_v1:other:planner'], 'other')
  assert.throws(() => createStore('care-planner', { setStorageSync() { throw Error('quota') } }).save('planner', add()), /quota/)
})
function pageHarness(api) {
  let definition
  global.wx = api
  global.Page = object => { definition = object }
  const modulePath = require.resolve('../pages/cato-care-planner/index')
  delete require.cache[modulePath]
  require(modulePath)
  delete global.Page
  const page = { ...definition, data: structuredClone(definition.data), setData(values) {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.')
      if (parts.length === 2) this.data[parts[0]][parts[1]] = value
      else this.data[key] = value
    }
  } }
  return page
}
test('页面取消无写入；日期和钟点均需明确选择', () => {
  let writes = 0
  const page = pageHarness({ getStorageSync: () => '', setStorageSync: () => { writes++ } })
  page.onLoad(); page.openForm()
  page.data.draft.title = '整理猫咪用品'
  page.saveTask()
  assert.match(page.data.error, /亲自选择/)
  assert.equal(writes, 0)
  page.cancelForm()
  assert.equal(page.data.showForm, false)
  assert.equal(page.data.draft.title, '')
  assert.equal(writes, 0)
  delete global.wx
})
test('页面写失败保持原状态和草稿，重试成功后重载可恢复', () => {
  const values = {}
  let shouldFail = true
  const api = { getStorageSync: key => values[key], setStorageSync(key, value) { if (shouldFail) throw Error('quota'); values[key] = value } }
  const page = pageHarness(api)
  page.onLoad(); page.openForm()
  page.data.draft = { title: '整理猫咪用品', kindIndex: 0, date: '2026-09-29', time: '09:00', repeatIndex: 1 }
  page.saveTask()
  assert.equal(page.state.tasks.length, 0)
  assert.equal(page.data.showForm, true)
  assert.equal(page.data.draft.title, '整理猫咪用品')
  assert.match(page.data.error, /保存失败/)
  shouldFail = false
  page.saveTask()
  assert.equal(page.state.tasks.length, 1)
  assert.equal(page.data.showForm, false)
  const reloaded = pageHarness(api); reloaded.onLoad()
  assert.equal(reloaded.state.tasks[0].title, '整理猫咪用品')
  delete global.wx
})
test('读取失败不会保存或启用编辑；重试可恢复', () => {
  let fails = true
  let writes = 0
  const page = pageHarness({ getStorageSync() { if (fails) throw Error('unavailable'); return '' }, setStorageSync() { writes++ } })
  page.onLoad()
  assert.equal(page.state, null)
  assert.equal(page.data.today, '')
  assert.match(page.data.error, /未覆盖/)
  assert.equal(page.commit({ type: 'add', task: fields() }, 'saved'), false)
  assert.equal(writes, 0)
  fails = false; page.reload()
  assert.equal(page.state.tasks.length, 0)
  delete global.wx
})
test('页面再次显示时今日跨日刷新，手动过去日期保持选择', () => {
  const page = pageHarness({ getStorageSync: () => '' })
  page.onLoad()
  page.data.day = '2026-09-29'; page.data.today = '2026-09-29'
  page.refresh(new Date(2026, 8, 30, 0, 1).getTime())
  assert.equal(page.data.day, '2026-09-30')
  page.data.day = '2026-09-28'
  page.refresh(new Date(2026, 9, 1, 0, 1).getTime())
  assert.equal(page.data.day, '2026-09-28')
  delete global.wx
})
test('分支入口、页面配置和触控规范可审计，没有网络或原档案写入', () => {
  const root = path.resolve(__dirname, '..')
  const config = require('../config/cato-lab')
  assert.equal(config.variant, 'care-planner')
  assert.equal(config.entry, '/pages/cato-care-planner/index')
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages.includes('pages/cato-care-planner/index'))
  JSON.parse(fs.readFileSync(path.join(root, 'pages/cato-care-planner/index.json'), 'utf8'))
  const css = fs.readFileSync(path.join(root, 'pages/cato-care-planner/index.wxss'), 'utf8')
  assert.match(css, /min-height: 88rpx/)
  const code = fs.readFileSync(path.join(root, 'pages/cato-care-planner/index.js'), 'utf8')
  assert.match(code, /createStore\('care-planner'\)/)
  assert.doesNotMatch(code, /wx\.(request|cloud|requestSubscribeMessage)|catai_mini_pets_v1/)
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-care-planner/index.wxml'), 'utf8')
  assert.match(wxml, /不发送微信推送/)
  assert.match(wxml, /不提供诊断、药量或自动用药安排/)
})
