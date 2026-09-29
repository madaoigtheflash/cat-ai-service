const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createStore } = require('../services/cato-lab')
const { MINUTE, createSession, snapshot, pauseSession, resumeSession, advancePhase, finishSession, editRecord, parseTags, summarize, validateState, createFocusController } = require('../utils/cato-focus')

const input = { activity: 'companion', title: '安静读书', mode: 'pomodoro', workMinutes: 25, restMinutes: 5 }
const base = new Date(2026, 8, 29, 10).getTime()
function rig() {
  let now = base; let sequence = 0; let failRead = false; let failWrite = false
  const values = { catai_mini_pets_v1: [{ id: 'private' }], 'catai_cato_lab_v1:other:state': { untouched: true } }
  const writes = []
  const driver = {
    getStorageSync(key) { if (failRead) throw new Error('read blocked'); return values[key] },
    setStorageSync(key, value) { if (failWrite) throw new Error('storage full'); writes.push(key); values[key] = value }
  }
  const store = createStore('focus', driver)
  const options = { store, clock: () => now, idFactory: () => 'session-' + (++sequence) }
  return { values, writes, options, controller: createFocusController(options), advance: ms => { now += ms }, now: () => now,
    failRead: value => { failRead = value }, failWrite: value => { failWrite = value } }
}
function finishOne(r, minutes = 3, completed = false) {
  r.controller.start({ ...input, mode: 'countup' }); const id = r.controller.getState().active.id
  r.advance(minutes * MINUTE); r.controller.pause(id)
  return r.controller.finish(id, { title: input.title, tags: '阅读，安静', taskCompleted: completed })
}

test('正计时使用时间戳，不依赖任何 ticker 调用', () => {
  const session = createSession({ ...input, mode: 'countup' }, base, 'clock')
  assert.equal(snapshot(session, base + 92345).workMs, 92345)
  assert.equal(snapshot(session, base + 92345).remainingMs, null)
  assert.equal(session.workMs, 0)
})
test('暂停冻结时长，恢复不计入暂停的空档', () => {
  const running = createSession({ ...input, mode: 'countup' }, base, 'pause')
  const paused = pauseSession(running, base + 30000)
  assert.equal(snapshot(paused, base + 300000).workMs, 30000)
  const resumed = resumeSession(paused, base + 300000)
  assert.equal(snapshot(resumed, base + 345000).workMs, 75000)
  assert.equal(pauseSession(resumed, base + 345000).phaseElapsedMs, 75000)
})
test('番茄钟后台超时只计当前阶段，不自动跳转', () => {
  const session = createSession(input, base, 'capped')
  const current = snapshot(session, base + 120 * MINUTE)
  assert.equal(current.workMs, 25 * MINUTE); assert.equal(current.remainingMs, 0); assert.equal(current.reached, true)
  assert.equal(session.phase, 'work'); assert.equal(current.restMs, 0)
})
test('到点显式切换专注与休息，休息不计专注，轮次增加', () => {
  const session = createSession({ ...input, workMinutes: 1, restMinutes: 1 }, base, 'cycle')
  assert.throws(() => advancePhase(session, base + 59999), /尚未到点/)
  const rest = advancePhase(session, base + MINUTE)
  assert.equal(rest.phase, 'rest'); assert.equal(rest.workMs, MINUTE)
  const work = advancePhase(rest, base + 3 * MINUTE)
  assert.equal(work.phase, 'work'); assert.equal(work.rounds, 2)
  assert.equal(snapshot(work, base + 3 * MINUTE + 1000).workMs, MINUTE + 1000)
  assert.equal(work.restMs, MINUTE)
})
test('已到点暂停不可直接恢复，正计时不可跳阶段', () => {
  const paused = pauseSession(createSession(input, base, 'end'), base + 25 * MINUTE)
  assert.throws(() => resumeSession(paused, base + 26 * MINUTE), /已到点/)
  assert.throws(() => advancePhase(createSession({ ...input, mode: 'countup' }, base, 'up'), base + 30 * MINUTE), /尚未到点/)
})
test('重建控制器恢复运行中的开始时间戳', () => {
  const r = rig(); r.controller.start(input); r.advance(8 * MINUTE)
  const restored = createFocusController(r.options)
  assert.equal(restored.getState().current.workMs, 8 * MINUTE)
  assert.equal(restored.getState().active.status, 'running')
})
test('重建控制器恢复暂停状态，不累计离线间隔', () => {
  const r = rig(); r.controller.start(input); r.advance(MINUTE)
  r.controller.pause(r.controller.getState().active.id); r.advance(60 * MINUTE)
  const restored = createFocusController(r.options)
  assert.equal(restored.getState().current.workMs, MINUTE)
  assert.equal(restored.getState().active.status, 'paused')
})
test('反向系统时钟不产生负时长并提供提醒', () => {
  const current = snapshot(createSession(input, base, 'back'), base - MINUTE)
  assert.equal(current.workMs, 0); assert.equal(current.clockMovedBack, true)
  assert.throws(() => snapshot(createSession(input, base, 'time'), NaN), /时间无效/)
})
test('拒绝无效的活动、名称、模式和番茄钟时长', () => {
  for (const change of [{ title: '  ' }, { title: '猫'.repeat(61) }, { activity: 'automatic-exercise' }, { mode: 'other' },
    { workMinutes: 0 }, { workMinutes: 181 }, { workMinutes: 1.5 }, { workMinutes: 'abc' }, { restMinutes: 0 }, { restMinutes: 61 }]) {
    assert.throws(() => createSession({ ...input, ...change }, base, 'bad'))
  }
  assert.equal(createSession({ ...input, mode: 'countup', workMinutes: '', restMinutes: '' }, base, 'countup').mode, 'countup')
})
test('标签去重且约束长度、数量', () => {
  assert.deepEqual(parseTags('读书，读书, 客厅、安静'), ['读书', '客厅', '安静'])
  assert.throws(() => parseTags('1,2,3,4,5,6'), /最多/)
  assert.throws(() => parseTags('猫'.repeat(17)), /最多/)
})
test('计时不能直接结束，暂停核对后才允许保存', () => {
  const r = rig(); r.controller.start(input); const id = r.controller.getState().active.id
  assert.throws(() => r.controller.finish(id, {}), /先暂停/)
  assert.equal(r.controller.getState().active.id, id)
  assert.equal(r.controller.getState().records.length, 0)
})
test('核对取消没有记录且仍暂停，可恢复原会话', () => {
  const r = rig(); r.controller.start(input); const id = r.controller.getState().active.id
  r.advance(4 * MINUTE); r.controller.pause(id)
  const before = r.controller.getState()
  r.advance(10 * MINUTE)
  assert.equal(r.controller.getState().records.length, 0)
  assert.equal(r.controller.getState().current.workMs, before.current.workMs)
  r.controller.resume(id); r.advance(MINUTE)
  assert.equal(r.controller.getState().current.workMs, 5 * MINUTE)
})
test('花了时间不自动视为任务完成，必须显式 true', () => {
  const paused = pauseSession(createSession(input, base, 'confirmed'), base + MINUTE)
  assert.equal(finishSession(paused, {}, base + MINUTE).taskCompleted, false)
  assert.equal(finishSession(paused, { taskCompleted: 'true' }, base + MINUTE).taskCompleted, false)
  assert.equal(finishSession(paused, { taskCompleted: true }, base + MINUTE).taskCompleted, true)
})
test('重复确认同一会话只保留一条记录，包括重建后重试', () => {
  const r = rig(); const record = finishOne(r)
  assert.deepEqual(r.controller.finish(record.id, { title: '不应覆盖' }), record)
  const restored = createFocusController(r.options)
  assert.deepEqual(restored.finish(record.id, {}), record)
  assert.equal(restored.getState().records.length, 1)
  assert.equal(restored.getState().active, null)
})
test('上一条确认的迟到重试不会结束新会话', () => {
  const r = rig(); const record = finishOne(r); r.controller.start(input)
  const activeId = r.controller.getState().active.id
  r.controller.finish(record.id, {})
  assert.equal(r.controller.getState().active.id, activeId)
  assert.equal(r.controller.getState().records.length, 1)
})
test('修改名称、时长、标签、完成状态后统计立即使用新值', () => {
  const r = rig(); const record = finishOne(r, 2)
  r.controller.edit(record.id, { title: '改为学习', minutes: '12.5', tags: '知识，读书', taskCompleted: true })
  const state = r.controller.getState(); const totals = summarize(state.records, r.now())
  assert.equal(state.records[0].title, '改为学习'); assert.equal(state.records[0].edited, true)
  assert.deepEqual(state.records[0].tags, ['知识', '读书'])
  for (const range of ['day', 'week', 'month']) { assert.equal(totals[range].workMs, 12.5 * MINUTE); assert.equal(totals[range].completed, 1) }
})
test('今天/周一开始的周/月统计按当地结束日期，不包含休息与未来周期', () => {
  const now = new Date(2026, 8, 29, 10).getTime()
  const records = [
    [new Date(2026, 8, 29, 1), 1], [new Date(2026, 8, 28, 23), 2],
    [new Date(2026, 8, 27, 23), 3], [new Date(2026, 7, 31, 23), 4], [new Date(2026, 9, 1, 0), 5]
  ].map(([time, count]) => ({ endedAt: +time, workMs: count * MINUTE, restMs: 999 * MINUTE, taskCompleted: false }))
  const result = summarize(records, now)
  assert.equal(result.day.workMs, MINUTE); assert.equal(result.week.workMs, 8 * MINUTE); assert.equal(result.month.workMs, 6 * MINUTE)
})
test('日期修改移出今天与本月，历史统计可重新核对', () => {
  const r = rig(); const record = finishOne(r)
  const endedAt = new Date(2026, 7, 1, 12).getTime()
  r.controller.edit(record.id, { title: record.title, minutes: 8, tags: [], endedAt })
  assert.equal(summarize(r.controller.getState().records, r.now()).month.count, 0)
  assert.equal(summarize(r.controller.getState().records, endedAt).day.workMs, 8 * MINUTE)
})
test('无效修改不改变原记录', () => {
  const r = rig(); const record = finishOne(r)
  for (const minutes of ['', ' ', -1, 'abc', Infinity, 10081]) assert.throws(() => r.controller.edit(record.id, { title: record.title, minutes, tags: [] }))
  assert.throws(() => editRecord(record, { title: '', minutes: 5 }))
  assert.deepEqual(r.controller.getState().records[0], record)
})
test('开始保存失败不创建幽灵会话', () => {
  const r = rig(); r.failWrite(true)
  assert.throws(() => r.controller.start(input), /storage full/)
  assert.equal(r.controller.getState().active, null); assert.equal(r.writes.length, 0)
})
test('暂停和恢复保存失败都保留之前的可恢复会话', () => {
  const r = rig(); r.controller.start(input); const id = r.controller.getState().active.id
  r.advance(MINUTE); r.failWrite(true)
  assert.throws(() => r.controller.pause(id), /storage full/)
  assert.equal(r.controller.getState().active.status, 'running')
  r.failWrite(false); r.controller.pause(id); r.failWrite(true)
  assert.throws(() => r.controller.resume(id), /storage full/)
  assert.equal(r.controller.getState().active.status, 'paused')
})
test('结束保存失败不清除会话，重试仅保存一条', () => {
  const r = rig(); r.controller.start(input); const id = r.controller.getState().active.id
  r.advance(MINUTE); r.controller.pause(id); r.failWrite(true)
  assert.throws(() => r.controller.finish(id, {}), /storage full/)
  assert.equal(r.controller.getState().active.id, id); assert.equal(r.controller.getState().records.length, 0)
  assert.equal(createFocusController(r.options).getState().active.id, id)
  r.failWrite(false); r.controller.finish(id, {}); r.controller.finish(id, {})
  assert.equal(r.controller.getState().records.length, 1)
})
test('切换番茄钟阶段保存失败后仍停留在原到点阶段', () => {
  const r = rig(); r.controller.start({ ...input, workMinutes: 1 }); const id = r.controller.getState().active.id
  r.advance(2 * MINUTE); r.failWrite(true)
  assert.throws(() => r.controller.advance(id), /storage full/)
  assert.equal(r.controller.getState().active.phase, 'work'); assert.equal(r.controller.getState().current.reached, true)
  r.failWrite(false); r.controller.advance(id)
  assert.equal(r.controller.getState().active.phase, 'rest'); assert.equal(r.controller.getState().current.workMs, MINUTE)
})
test('确认表单无效时不清除已暂停会话', () => {
  const r = rig(); r.controller.start(input); const id = r.controller.getState().active.id
  r.controller.pause(id)
  assert.throws(() => r.controller.finish(id, { title: ' ' }), /名称/)
  assert.throws(() => r.controller.finish(id, { tags: '1,2,3,4,5,6' }), /标签/)
  assert.equal(r.controller.getState().active.id, id); assert.equal(r.controller.getState().active.status, 'paused')
  assert.equal(r.controller.getState().records.length, 0)
})
test('修改保存失败保留记录和统计', () => {
  const r = rig(); const record = finishOne(r); r.failWrite(true)
  assert.throws(() => r.controller.edit(record.id, { title: '不应保存', minutes: 88, tags: [] }), /storage full/)
  assert.deepEqual(r.controller.getState().records[0], record)
  assert.equal(summarize(r.controller.getState().records, r.now()).day.workMs, record.workMs)
})
test('读取失败或损坏状态阻止覆写，可重新读取恢复', () => {
  const r = rig(); r.failRead(true); const failed = createFocusController(r.options)
  assert.match(failed.getState().loadError, /读取/); assert.throws(() => failed.start(input), /读取/)
  r.failRead(false); failed.reload(); failed.start(input)
  const saved = r.values['catai_cato_lab_v1:focus:state']
  r.values['catai_cato_lab_v1:focus:state'] = { bad: true }
  const corrupt = createFocusController(r.options); assert.ok(corrupt.getState().loadError)
  assert.throws(() => corrupt.start(input)); assert.deepEqual(r.values['catai_cato_lab_v1:focus:state'], { bad: true })
  r.values['catai_cato_lab_v1:focus:state'] = saved; corrupt.reload(); assert.equal(corrupt.getState().active.status, 'running')
})
test('返回的状态副本不会被外部误修改，拒绝重复启动', () => {
  const r = rig(); r.controller.start(input)
  const state = r.controller.getState(); state.active.title = '外部篡改'
  assert.equal(r.controller.getState().active.title, input.title)
  assert.throws(() => r.controller.start(input), /先处理/)
})
test('仅写 focus 命名空间，不碰旧档案与其他实验', () => {
  const r = rig(); finishOne(r)
  assert.ok(r.writes.every(key => key === 'catai_cato_lab_v1:focus:state'))
  assert.deepEqual(r.values.catai_mini_pets_v1, [{ id: 'private' }])
  assert.deepEqual(r.values['catai_cato_lab_v1:other:state'], { untouched: true })
})
test('格式校验拒绝重复记录和异常负时长', () => {
  const r = rig(); const record = finishOne(r)
  assert.throws(() => validateState({ version: 1, active: null, records: [record, record] }), /标识/)
  assert.throws(() => validateState({ version: 1, active: null, records: [{ ...record, workMs: -1 }] }), /异常/)
})
test('页面路由、原生柔粉操作区与离线声明齐备', () => {
  const root = path.resolve(__dirname, '..')
  const config = require('../config/cato-lab')
  assert.equal(config.variant, 'focus'); assert.equal(config.entry, '/pages/cato-focus/index')
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).pages.includes('pages/cato-focus/index'))
  const page = fs.readFileSync(path.join(root, 'pages/cato-focus/index.js'), 'utf8')
  const markup = fs.readFileSync(path.join(root, 'pages/cato-focus/index.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-focus/index.wxss'), 'utf8')
  assert.match(page, /createStore\('focus'\)/); assert.doesNotMatch(page, /wx\.(request|cloud|requestSubscribeMessage)/)
  assert.match(markup, /本机离线实验/); assert.match(markup, /不发通知/); assert.match(markup, /不提供医疗建议/)
  assert.match(css, /min-height: 88rpx/); assert.match(css, /safe-area-inset-bottom/)
})
test('页面结束取消/确认与存储失败保留核对表单', () => {
  let definition
  global.Page = page => { definition = page }
  const modulePath = require.resolve('../pages/cato-focus/index.js'); delete require.cache[modulePath]; require(modulePath)
  delete global.Page
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, callback) {
    Object.entries(patch).forEach(([key, value]) => { const parts = key.split('.'); let target = this.data; while (parts.length > 1) { target = target[parts.shift()] } target[parts[0]] = value }); if (callback) callback()
  } }
  const r = rig(); page.controller = r.controller; page.primaryAction(); r.advance(MINUTE)
  page.reviewFinish(); assert.equal(page.data.reviewing, true); assert.equal(page.data.review.taskCompleted, false)
  page.cancelFinish(); assert.equal(page.data.reviewing, false); assert.equal(page.data.active.status, 'paused')
  page.reviewFinish(); r.failWrite(true); page.confirmFinish()
  assert.equal(page.data.reviewing, true); assert.match(page.data.error, /未保存更改/); assert.ok(page.data.active)
  r.failWrite(false); page.confirmFinish(); assert.equal(page.data.reviewing, false); assert.equal(page.data.active, null); assert.equal(page.data.records.length, 1)
})
