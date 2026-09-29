const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const domain = require('../utils/cato-house-goals')
const { createStore } = require('../services/cato-lab')

function setup() {
  const values = { catai_mini_pets_v1: [{ name: '不得读取' }] }
  const io = { writes: 0, failWrite: false, failRead: false }
  const driver = {
    getStorageSync(key) { if (io.failRead) throw Error('read error'); return values[key] },
    setStorageSync(key, value) { if (io.failWrite) throw Error('quota'); io.writes += 1; values[key] = value },
    removeStorageSync(key) { delete values[key] }, getStorageInfoSync() { return { keys: Object.keys(values) } }
  }
  const store = createStore('house-goals', driver)
  return { values, io, driver, store, backend: domain.createBackend(store) }
}
function seed(backend, createdBy = 'lin') {
  let room = backend.execute(createdBy, { type: 'create-goal', title: '内部目标，不公开', due: '2026-10-31' })
  const goalId = room.goals[0].id
  room = backend.execute(createdBy, { type: 'add-task', goalId, title: '整理用品', due: '2026-10-20' })
  return { goalId, taskId: room.goals[0].tasks[0].id }
}
const errorCode = code => error => error.code === code
const taskOf = (backend, actor = 'lin') => backend.read(actor).goals[0].tasks[0]

test('合成邀请小屋只有房主、成员；访客投影没有内部标题、证据或成员信息', () => {
  const { backend } = setup()
  const ids = seed(backend)
  backend.execute('lin', { type: 'claim', ...ids })
  backend.execute('lin', { type: 'complete', ...ids, evidence: '内部证据，不公开' })
  const view = backend.read('visitor')
  assert.equal(view.allowed, false)
  assert.deepEqual(view.goals, [])
  assert.deepEqual(view.members, [])
  assert.doesNotMatch(JSON.stringify(view), /内部目标|内部证据|整理用品/)
  assert.deepEqual(backend.read('lin').members.map(item => item.role), ['host', 'member'])
})
test('域层阻止访客对每一种内部命令操作，不能通过已知ID越权', () => {
  const { backend } = setup()
  const ids = seed(backend)
  for (const type of ['create-goal', 'edit-goal', 'add-task', 'edit-task', 'claim', 'complete', 'undo', 'release', 'leave']) {
    assert.throws(() => backend.execute('visitor', { type, ...ids, title: '恶意', due: '', evidence: '' }), errorCode('FORBIDDEN'))
  }
  assert.throws(() => backend.read('unknown'), errorCode('ACTOR'))
  assert.throws(() => backend.execute('unknown', { type: 'leave' }), errorCode('ACTOR'))
})
test('目标及子任务为用户自定，可编辑标题与日期，空目标进度为0', () => {
  const { backend } = setup()
  const empty = backend.execute('qiao', { type: 'create-goal', title: '  我的目标  ', due: '' })
  assert.equal(empty.goals[0].title, '我的目标')
  assert.equal(empty.goals[0].progress, 0)
  const goalId = empty.goals[0].id
  const added = backend.execute('lin', { type: 'add-task', goalId, title: '自定义任务', due: '' })
  const taskId = added.goals[0].tasks[0].id
  backend.execute('qiao', { type: 'edit-goal', goalId, title: '改好的目标', due: '2026-11-02', expectedVersion: 1 })
  backend.execute('qiao', { type: 'edit-task', goalId, taskId, title: '改好的任务', due: '2026-11-01', expectedVersion: 1 })
  assert.equal(taskOf(backend).title, '改好的任务')
  assert.equal(backend.read('lin').goals[0].due, '2026-11-02')
})
test('不能代他人认领；同一人重复认领幂等；第二成员认领冲突不会覆盖', () => {
  const { backend, io } = setup()
  const ids = seed(backend)
  assert.throws(() => backend.execute('lin', { type: 'claim', ...ids, assignee: 'qiao' }), errorCode('ASSIGNMENT'))
  backend.execute('qiao', { type: 'claim', ...ids })
  const writes = io.writes
  backend.execute('qiao', { type: 'claim', ...ids })
  assert.equal(io.writes, writes)
  assert.throws(() => backend.execute('lin', { type: 'claim', ...ids }), errorCode('CLAIM_CONFLICT'))
  assert.equal(taskOf(backend).assignee, 'qiao')
})
test('模拟两个客户端总是重读最新存储；过期认领拒绝而非最后写入覆盖', () => {
  const { backend, store } = setup()
  const secondClient = domain.createBackend(store)
  const ids = seed(backend)
  assert.equal(secondClient.read('qiao').goals[0].tasks[0].assignee, '')
  backend.execute('lin', { type: 'claim', ...ids })
  assert.throws(() => secondClient.execute('qiao', { type: 'claim', ...ids }), errorCode('CLAIM_CONFLICT'))
})
test('完成、重复完成、撤销、重复撤销及释放均保持正确进度和幂等', () => {
  const { backend, io } = setup()
  const ids = seed(backend)
  assert.throws(() => backend.execute('lin', { type: 'complete', ...ids, evidence: '' }), errorCode('FORBIDDEN'))
  backend.execute('lin', { type: 'claim', ...ids })
  backend.execute('lin', { type: 'complete', ...ids, evidence: '已核对用品' })
  assert.equal(backend.read('lin').goals[0].progress, 100)
  const writes = io.writes
  backend.execute('lin', { type: 'complete', ...ids, evidence: '已核对用品' })
  assert.equal(io.writes, writes)
  assert.throws(() => backend.execute('lin', { type: 'complete', ...ids, evidence: '不能静默改' }), errorCode('DONE'))
  assert.throws(() => backend.execute('lin', { type: 'release', ...ids }), errorCode('DONE'))
  backend.execute('lin', { type: 'undo', ...ids })
  const afterUndo = io.writes
  backend.execute('lin', { type: 'undo', ...ids })
  assert.equal(io.writes, afterUndo)
  assert.equal(taskOf(backend).evidence, '')
  assert.equal(backend.read('lin').goals[0].progress, 0)
  backend.execute('lin', { type: 'release', ...ids })
  const afterRelease = io.writes
  backend.execute('lin', { type: 'release', ...ids })
  assert.equal(io.writes, afterRelease)
  backend.execute('qiao', { type: 'claim', ...ids })
  assert.equal(taskOf(backend).assignee, 'qiao')
})
test('房主也不能编辑、完成、撤销、释放他人认领任务', () => {
  const { backend } = setup()
  const ids = seed(backend)
  backend.execute('qiao', { type: 'claim', ...ids })
  for (const type of ['edit-task', 'complete', 'undo', 'release']) {
    assert.throws(() => backend.execute('lin', { type, ...ids, title: '覆盖', due: '', evidence: '' }), errorCode('FORBIDDEN'))
  }
  backend.execute('qiao', { type: 'edit-task', ...ids, title: '我调整自己的任务', due: '' })
  assert.equal(taskOf(backend).title, '我调整自己的任务')
})
test('普通成员不能编辑他人的目标及未认领任务；可以添加子任务', () => {
  const { backend } = setup()
  const ids = seed(backend)
  for (const type of ['edit-goal', 'edit-task']) {
    assert.throws(() => backend.execute('qiao', { type, ...ids, title: '覆盖', due: '' }), errorCode('FORBIDDEN'))
  }
  const room = backend.execute('qiao', { type: 'add-task', goalId: ids.goalId, title: '一起补充', due: '' })
  assert.equal(room.goals[0].total, 2)
})
test('过期编辑版本拒绝，不覆盖新内容', () => {
  const { backend } = setup()
  const ids = seed(backend)
  backend.execute('lin', { type: 'edit-task', ...ids, title: '新版任务', due: '', expectedVersion: 1 })
  assert.throws(() => backend.execute('lin', { type: 'edit-task', ...ids, title: '旧版覆盖', due: '', expectedVersion: 1 }), errorCode('CONFLICT'))
  assert.equal(taskOf(backend).title, '新版任务')
})
test('退出立即撤权并释放未完成任务，重复退出不产生写入', () => {
  const { backend, io } = setup()
  const ids = seed(backend)
  backend.execute('qiao', { type: 'claim', ...ids })
  assert.equal(backend.execute('qiao', { type: 'leave' }).allowed, false)
  assert.equal(taskOf(backend).assignee, '')
  const writes = io.writes
  backend.execute('qiao', { type: 'leave' })
  assert.equal(io.writes, writes)
  assert.deepEqual(backend.read('qiao').goals, [])
  assert.throws(() => backend.execute('qiao', { type: 'claim', ...ids }), errorCode('FORBIDDEN'))
})
test('房主退出转交角色；最后一人退出关闭小屋，保留存储但无人有读取权限', () => {
  const { backend, store } = setup()
  const ids = seed(backend)
  backend.execute('lin', { type: 'claim', ...ids })
  backend.execute('lin', { type: 'complete', ...ids, evidence: '完成历史' })
  backend.execute('lin', { type: 'leave' })
  const room = backend.read('qiao')
  assert.equal(room.self.role, 'host')
  assert.equal(room.goals[0].tasks[0].assigneeLeft, true)
  assert.equal(room.goals[0].tasks[0].evidence, '完成历史')
  backend.execute('qiao', { type: 'leave' })
  for (const actor of domain.ACTORS) {
    const view = backend.read(actor.id)
    assert.equal(view.allowed, false)
    assert.equal(view.closed, true)
    assert.deepEqual(view.goals, [])
  }
  assert.equal(store.load('room').goals[0].tasks[0].evidence, '完成历史')
})
test('日期验证拒绝不存在日期、格式错误及越界，支持闰日和留空', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-01', '2100-02-29', '1800-01-01', '2200-01-01', '明天', null]) {
    assert.throws(() => domain.validDate(date), errorCode('DATE'))
  }
  for (const date of ['', '2028-02-29', '2000-02-29', '2026-12-31']) assert.equal(domain.validDate(date), date)
})
test('子任务日期不晚于目标，缩短目标截止不能让已有任务变为无效', () => {
  const { backend, io } = setup()
  const ids = seed(backend)
  const writes = io.writes
  assert.throws(() => backend.execute('lin', { type: 'add-task', goalId: ids.goalId, title: '太晚', due: '2026-11-01' }), errorCode('DATE'))
  assert.throws(() => backend.execute('lin', { type: 'edit-goal', goalId: ids.goalId, title: '目标', due: '2026-10-01' }), errorCode('DATE'))
  assert.equal(io.writes, writes)
})
test('无效标题、记录和不存在ID不修改状态', () => {
  const { backend, io } = setup()
  const ids = seed(backend)
  const writes = io.writes
  for (const title of ['', '   ', '字'.repeat(121), null]) {
    assert.throws(() => backend.execute('lin', { type: 'create-goal', title, due: '' }), errorCode('INPUT'))
  }
  assert.throws(() => backend.execute('lin', { type: 'claim', goalId: 'missing', taskId: ids.taskId }), errorCode('NOT_FOUND'))
  assert.equal(io.writes, writes)
  backend.execute('lin', { type: 'claim', ...ids })
  assert.throws(() => backend.execute('lin', { type: 'complete', ...ids, evidence: '字'.repeat(501) }), errorCode('INPUT'))
})
test('纯状态转换不改变原输入；返回的投影不能反向修改存储', () => {
  const state = domain.initialState()
  const original = JSON.stringify(state)
  const next = domain.transition(state, 'lin', { type: 'create-goal', title: '计划', due: '' })
  assert.equal(JSON.stringify(state), original)
  assert.equal(next.goals.length, 1)
  const view = domain.project(next, 'lin')
  view.goals[0].title = '外部修改'
  assert.equal(next.goals[0].title, '计划')
})
test('保存失败不发布成功状态，不丢掉上次持久化内容，可重试', () => {
  const { backend, io, values } = setup()
  const ids = seed(backend)
  const previous = JSON.stringify(values)
  io.failWrite = true
  assert.throws(() => backend.execute('lin', { type: 'claim', ...ids }), /quota/)
  assert.equal(JSON.stringify(values), previous)
  assert.equal(taskOf(backend).assignee, '')
  io.failWrite = false
  backend.execute('lin', { type: 'claim', ...ids })
  assert.equal(taskOf(backend).assignee, 'lin')
  assert.deepEqual(Object.keys(values).sort(), ['catai_cato_lab_v1:house-goals:room', 'catai_mini_pets_v1'])
})
test('退出保存失败时不假报已退出；读取失败与损坏数据不会自动覆盖', () => {
  const { backend, io, values } = setup()
  seed(backend)
  io.failWrite = true
  assert.throws(() => backend.execute('lin', { type: 'leave' }), /quota/)
  assert.equal(backend.read('lin').allowed, true)
  io.failWrite = false
  io.failRead = true
  assert.throws(() => backend.read('lin'), /read error/)
  io.failRead = false
  values['catai_cato_lab_v1:house-goals:room'] = { schema: 99 }
  const writes = io.writes
  assert.throws(() => backend.read('lin'), errorCode('STORAGE'))
  assert.equal(io.writes, writes)
})

function pageHarness() {
  const env = setup()
  let definition
  const controls = { confirm: false }
  const wx = { ...env.driver, pageScrollTo() {}, showModal(options) { options.success({ confirm: controls.confirm }) } }
  const source = fs.readFileSync(path.join(__dirname, '../pages/cato-house-goals/index.js'), 'utf8')
  vm.runInNewContext(source, {
    Page(value) { definition = value }, wx,
    require(name) {
      if (name.endsWith('/cato-lab')) return { createStore: feature => createStore(feature, wx) }
      if (name.endsWith('/cato-house-goals')) return domain
      throw Error('Unexpected import: ' + name)
    }
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts[parts.length - 1]] = value
    }
  } }
  page.onShow()
  const open = (mode, ids = {}) => page.openEditor({ currentTarget: { dataset: { mode, ...ids } } })
  const input = (field, value) => page.inputField({ currentTarget: { dataset: { field } }, detail: { value } })
  return { ...env, page, controls, open, input }
}
test('页面保存失败保留表单与原状态，重试成功才清空', () => {
  const { page, open, input } = pageHarness()
  open('create-goal'); input('title', '尚未保存的目标'); input('due', '2026-12-31')
  page.simulateFailure()
  page.saveEditor()
  assert.equal(page.data.editor.title, '尚未保存的目标')
  assert.equal(page.data.editor.due, '2026-12-31')
  assert.equal(page.data.room.goals.length, 0)
  assert.match(page.data.error, /保存失败/)
  assert.equal(page.data.feedback, '')
  page.saveEditor()
  assert.equal(page.data.room.goals.length, 1)
  assert.equal(page.data.editor.mode, '')
})
test('取消确认不写存储；取消对话框本身保留草稿', () => {
  const { page, controls, open, input, io } = pageHarness()
  open('create-goal'); input('title', '草稿')
  page.cancelEditor()
  assert.equal(page.data.editor.title, '草稿')
  controls.confirm = true
  page.cancelEditor()
  assert.equal(page.data.editor.mode, '')
  assert.equal(io.writes, 0)
})
test('页面切换访客清除内部目标、编辑标题、完成证据和反馈', () => {
  const { page, open, input } = pageHarness()
  open('create-goal'); input('title', '秘密目标'); page.saveEditor()
  open('edit-goal', { goalId: page.data.room.goals[0].id })
  page.setData({ 'editor.evidence': '秘密证据', feedback: '秘密反馈' })
  page.switchActor({ currentTarget: { dataset: { id: 'visitor' } } })
  assert.equal(page.data.room.allowed, false)
  assert.doesNotMatch(JSON.stringify(page.data), /秘密目标|秘密证据|秘密反馈/)
})
test('页面退出取消不改变权限，确认后立即清空私密显示及草稿', () => {
  const { page, open, input, controls } = pageHarness()
  open('create-goal'); input('title', '秘密目标'); page.saveEditor()
  open('edit-goal', { goalId: page.data.room.goals[0].id })
  page.leaveRoom()
  assert.equal(page.data.room.allowed, true)
  assert.equal(page.data.editor.title, '秘密目标')
  controls.confirm = true
  page.leaveRoom()
  assert.equal(page.data.room.allowed, false)
  assert.equal(page.data.editor.title, '')
  assert.doesNotMatch(JSON.stringify(page.data), /秘密目标/)
})
test('页面非法日期保留输入且不创建目标', () => {
  const { page, open, input } = pageHarness()
  open('create-goal'); input('title', '日期测试'); input('due', '2026-02-30'); page.saveEditor()
  assert.equal(page.data.editor.due, '2026-02-30')
  assert.equal(page.data.editor.title, '日期测试')
  assert.equal(page.data.room.goals.length, 0)
  assert.match(page.data.error, /日期/)
})
test('入口只指向本实验，页面使用共享88rpx、安全区、无云和真实通知API', () => {
  const config = require('../config/cato-lab')
  assert.equal(config.enabled, true)
  assert.equal(config.variant, 'house-goals')
  assert.equal(config.entry, '/pages/cato-house-goals/index')
  const root = path.resolve(__dirname, '..')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(app.pages.includes('pages/cato-house-goals/index'))
  const css = fs.readFileSync(path.join(root, 'styles/cato-lab.wxss'), 'utf8')
  assert.match(css, /min-height: 88rpx/)
  assert.match(css, /safe-area-inset-bottom/)
  const js = fs.readFileSync(path.join(root, 'pages/cato-house-goals/index.js'), 'utf8')
  assert.doesNotMatch(js, /wx\.(cloud|request|requestSubscribeMessage|sendSocketMessage)/)
})
