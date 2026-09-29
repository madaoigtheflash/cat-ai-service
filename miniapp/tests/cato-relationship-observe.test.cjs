'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const d = require('../utils/cato-relationship-observe')
const { createStore } = require('../services/cato-lab')
const key = 'catai_cato_lab_v1:relationship-observe:state'
const copy = value => JSON.parse(JSON.stringify(value))
const A = d.CATS[0].id
const B = d.CATS[1].id
const AB = d.directionId(A, B)
const BA = d.directionId(B, A)
const O1 = d.OBSERVERS[0].id
const O2 = d.OBSERVERS[1].id
let sequence = 0
function command(state, type, fields = {}) { return { type, opId: 'request_' + (++sequence), expectedVersion: state.version, ...fields } }
function createFields(fromId = A, toId = B, kind = d.KINDS[0]) {
  return { fromId, toId, kindId: kind.id, fromRole: kind.fromRole, toRole: kind.toRole, observeAt: '2026-09-30T09:30', checklist: kind.checklist }
}
function step(state, type, fields) { return d.applyCommand(state, command(state, type, fields)).state }
function withPlan() { return step(d.initialState(), 'create', createFields()) }
function add(state, planId = AB, evidenceId = 'evidence_1') { return step(state, 'addEvidence', { planId, evidenceId, observedAt: '2026-09-29T08:15', note: '虚构记录：糯米先靠近，芝麻停留后离开。' }) }
function vote(state, observerId = O1, choice = 'uncertain', planId = AB, evidenceIds = ['evidence_1']) { return step(state, 'vote', { planId, observerId, choice, evidenceIds }) }
function throwsCode(action, code) { assert.throws(action, error => error.code === code) }
function harness(t, initial) {
  const values = { catai_mini_pets_v1: { private: true }, 'catai_cato_lab_v1:other:state': { other: true } }
  if (initial) values[key] = copy(initial)
  const io = { reads: 0, writes: 0, failRead: false, failWrite: false, throwAfterWrite: false, dropWrite: false, failReadAt: 0, confirmed: true, modalFail: false }
  global.wx = {
    getStorageSync(name) { io.reads++; if (io.failRead || io.reads === io.failReadAt) throw Error('read unavailable'); return copy(values[name] === undefined ? '' : values[name]) },
    setStorageSync(name, value) { io.writes++; if (io.failWrite) throw Error('quota'); if (!io.dropWrite) values[name] = copy(value); if (io.throwAfterWrite) throw Error('written but callback failed') },
    showModal(options) { if (io.modalFail) options.fail(); else options.success({ confirm: io.confirmed }) },
    pageScrollTo() {}
  }
  let definition
  global.Page = options => { definition = options }
  const file = require.resolve('../pages/cato-relationship-observe/index')
  delete require.cache[file]
  require(file)
  const page = { ...definition, data: copy(definition.data), setData(updates) { Object.assign(this.data, updates) } }
  page.onLoad()
  t.after(() => { delete global.wx; delete global.Page; delete require.cache[file] })
  return { page, values, io }
}
function fillCreate(page) { page.setData({ createDate: '2026-09-30', createTime: '09:30' }) }
function fillEvidence(page, note = '虚构观察：先靠近，再各自休息。') { page.setData({ evidenceDate: '2026-09-29', evidenceTime: '08:15', evidenceNote: note }) }

test('初始数据只有合成猫和两位模拟观察者，没有伪造票数', () => {
  assert.equal(d.CATS.length, 3)
  assert.equal(d.OBSERVERS.length, 2)
  assert.ok(d.CATS.every(cat => cat.label.includes('合成猫')))
  assert.ok(d.OBSERVERS.every(person => person.name.includes('模拟')))
  assert.deepEqual(d.initialState(), { schemaVersion: 1, version: 0, plans: [], receipts: [] })
})
test('纯领域模块不依赖运行环境或原始档案', () => {
  const code = fs.readFileSync(path.join(__dirname, '../utils/cato-relationship-observe.js'), 'utf8')
  assert.doesNotMatch(code, /require\(|wx\.|getApp\(|fetch\(|StorageSync|catai_mini/)
})
test('方向需要两只不同且已允许的合成猫', () => {
  const state = d.initialState()
  throwsCode(() => step(state, 'create', createFields(A, A)), 'SAME_CAT')
  throwsCode(() => step(state, 'create', createFields('real-private-cat', B)), 'INVALID_CAT')
  assert.deepEqual(state, d.initialState())
})
test('方向角色严格匹配白名单，亲缘和性格身份不受支持', () => {
  for (const kind of d.KINDS) {
    const fields = createFields(A, B, kind)
    throwsCode(() => step(d.initialState(), 'create', { ...fields, fromRole: kind.toRole }), 'INVALID_ROLE')
    assert.equal(step(d.initialState(), 'create', fields).plans[0].fromRole, kind.fromRole)
  }
  throwsCode(() => step(d.initialState(), 'create', { ...createFields(), kindId: 'parent', fromRole: '母亲', toRole: '子女' }), 'INVALID_ROLE')
})
test('日期验证拒绝不存在的日期、空时间和越界时间', () => {
  assert.equal(d.validTime('2028-02-29T23:59'), true)
  for (const value of ['', '2026-02-29T08:00', '2026-09-31T08:00', '2026-09-29T24:00', '2026-13-01T00:00', '1999-12-31T23:59', '2100-01-01T00:00', '2026-09-29T08:00Z']) assert.equal(d.validTime(value), false, value)
  throwsCode(() => step(d.initialState(), 'create', { ...createFields(), observeAt: 'T' }), 'INVALID_TIME')
})
test('新建为纯转换，描述始终显示两边角色与有向箭头', () => {
  const original = d.initialState()
  const next = step(original, 'create', createFields())
  assert.equal(original.plans.length, 0)
  assert.equal(next.version, 1)
  assert.equal(d.describePlan(next.plans[0]).direction, '糯米 → 芝麻')
  assert.match(d.describePlan(next.plans[0]).roles, /糯米：接近发起方；芝麻：被接近方/)
  assert.equal(d.distribution(next, AB).total, 0)
})
test('反向计划独立建档且角色正确，不复制证据或票', () => {
  let state = vote(add(withPlan()))
  state = step(state, 'create', createFields(B, A))
  assert.equal(d.describePlan(state.plans[1]).roles, '芝麻：接近发起方；糯米：被接近方')
  assert.equal(d.distribution(state, BA).total, 0)
  assert.equal(d.distribution(state, AB).total, 1)
  assert.deepEqual(state.plans[1].evidence, [])
})
test('每个方向仅有一份计划，换行为类型也不能重复建立', () => {
  const state = withPlan()
  throwsCode(() => step(state, 'create', createFields()), 'DUPLICATE_DIRECTION')
  throwsCode(() => step(state, 'create', createFields(A, B, d.KINDS[1])), 'DUPLICATE_DIRECTION')
})
test('计划可编辑时间清单；改计划不会改方向或已有票', () => {
  const state = vote(add(withPlan()))
  const edited = step(state, 'edit', { planId: AB, observeAt: '2026-10-01T12:00', checklist: '补充记录自然互动，也记录没有靠近的时段。' })
  assert.equal(edited.plans[0].observeAt, '2026-10-01T12:00')
  assert.deepEqual(edited.plans[0].votes, state.plans[0].votes)
  throwsCode(() => step(state, 'edit', { planId: AB, observeAt: '2026-10-01T12:00', checklist: '' }), 'INVALID_INPUT')
  throwsCode(() => step(state, 'edit', { planId: AB, observeAt: '2026-10-01T12:00', checklist: '字'.repeat(801) }), 'INVALID_INPUT')
})
test('证据要求有效时间、内容和唯一标识，输入对象不被修改', () => {
  const state = withPlan()
  const evidence = { planId: AB, evidenceId: 'e1', observedAt: '2026-09-29T08:00', note: '  模拟观察  ' }
  const next = step(state, 'addEvidence', evidence)
  assert.equal(next.plans[0].evidence[0].note, '模拟观察')
  assert.equal(evidence.note, '  模拟观察  ')
  assert.equal(state.plans[0].evidence.length, 0)
  throwsCode(() => step(next, 'addEvidence', evidence), 'DUPLICATE_EVIDENCE')
  throwsCode(() => step(state, 'addEvidence', { ...evidence, note: ' ' }), 'INVALID_INPUT')
  throwsCode(() => step(state, 'addEvidence', { ...evidence, observedAt: 'invalid' }), 'INVALID_TIME')
})
test('缺少有效证据不能投票，也不能完成计划', () => {
  const state = withPlan()
  throwsCode(() => vote(state), 'MISSING_EVIDENCE')
  throwsCode(() => vote(state, O1, 'uncertain', AB, []), 'MISSING_EVIDENCE')
  throwsCode(() => step(state, 'setStatus', { planId: AB, status: 'completed' }), 'MISSING_EVIDENCE')
})
test('拒绝伪造观察者、不允许的判断和重复证据引用', () => {
  const state = add(withPlan())
  throwsCode(() => vote(state, 'real-user'), 'INVALID_OBSERVER')
  throwsCode(() => vote(state, O1, 'bad-cat'), 'INVALID_CHOICE')
  throwsCode(() => vote(state, O1, 'uncertain', AB, ['evidence_1', 'evidence_1']), 'MISSING_EVIDENCE')
})
test('反向或已撤回证据不能用来支持当前方向的票', () => {
  let state = step(withPlan(), 'create', createFields(B, A))
  state = add(state, BA, 'reverse-evidence')
  throwsCode(() => vote(state, O1, 'consistent', AB, ['reverse-evidence']), 'MISSING_EVIDENCE')
  state = add(state)
  state = step(state, 'withdrawEvidence', { planId: AB, evidenceId: 'evidence_1' })
  throwsCode(() => vote(state), 'MISSING_EVIDENCE')
})
test('两位模拟观察者可各自投票，改票保持一人一方向一票', () => {
  let state = add(withPlan())
  state = vote(state, O1, 'consistent')
  state = vote(state, O2, 'uncertain')
  state = vote(state, O1, 'inconsistent')
  assert.equal(state.plans[0].votes.length, 2)
  assert.deepEqual(d.distribution(state, AB).rows.map(row => row.count), [0, 1, 1])
  assert.equal(d.distribution(state, AB).unvoted, 0)
})
test('每个方向的同一观察者有独立一票，撤票只影响指定方向身份', () => {
  let state = step(vote(add(withPlan()), O1, 'consistent'), 'create', createFields(B, A))
  state = vote(add(state, BA, 'reverse-evidence'), O1, 'inconsistent', BA, ['reverse-evidence'])
  state = step(state, 'withdrawVote', { planId: AB, observerId: O1 })
  assert.equal(d.distribution(state, AB).total, 0)
  assert.deepEqual(d.distribution(state, BA).rows.map(row => row.count), [0, 0, 1])
  throwsCode(() => step(state, 'withdrawVote', { planId: AB, observerId: O1 }), 'MISSING_VOTE')
})
test('撤证据使引用它的票失效，不撤无关票和反向票', () => {
  let state = add(add(withPlan()), AB, 'evidence_2')
  state = vote(state, O1, 'consistent', AB, ['evidence_1', 'evidence_2'])
  state = vote(state, O2, 'uncertain', AB, ['evidence_2'])
  state = step(state, 'create', createFields(B, A))
  state = vote(add(state, BA, 'reverse-evidence'), O1, 'consistent', BA, ['reverse-evidence'])
  state = step(state, 'withdrawEvidence', { planId: AB, evidenceId: 'evidence_1' })
  assert.equal(state.plans[0].evidence[0].active, false)
  assert.deepEqual(state.plans[0].votes.map(item => item.observerId), [O2])
  assert.equal(d.distribution(state, BA).total, 1)
})
test('完成可撤销；完成期间禁止新增和改票，但允许撤证据并恢复记录中', () => {
  let state = vote(add(withPlan()))
  state = step(state, 'setStatus', { planId: AB, status: 'completed' })
  throwsCode(() => add(state, AB, 'e2'), 'COMPLETED')
  throwsCode(() => vote(state, O2), 'COMPLETED')
  throwsCode(() => step(state, 'edit', { planId: AB, observeAt: '2026-09-30T08:00', checklist: '清单' }), 'COMPLETED')
  const active = step(state, 'setStatus', { planId: AB, status: 'active' })
  assert.equal(active.plans[0].votes.length, 1)
  const withdrawn = step(state, 'withdrawEvidence', { planId: AB, evidenceId: 'evidence_1' })
  assert.equal(withdrawn.plans[0].status, 'active')
  assert.equal(withdrawn.plans[0].votes.length, 0)
})
test('同一请求重试幂等，复用标识改内容则拒绝', () => {
  const state = withPlan()
  const request = command(state, 'addEvidence', { planId: AB, evidenceId: 'e1', observedAt: '2026-09-29T08:00', note: '模拟' })
  const first = d.applyCommand(state, request)
  const second = d.applyCommand(first.state, request)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.state, first.state)
  throwsCode(() => d.applyCommand(first.state, { ...request, note: '不同内容' }), 'OP_REUSED')
})
test('陈旧版本不覆盖新版本，重复已确认请求可在版本更新后核对', () => {
  const state = withPlan()
  const request = command(state, 'addEvidence', { planId: AB, evidenceId: 'e1', observedAt: '2026-09-29T08:00', note: '模拟' })
  const first = d.applyCommand(state, request).state
  const updated = add(first, AB, 'e2')
  throwsCode(() => d.applyCommand(updated, command(state, 'setStatus', { planId: AB, status: 'completed' })), 'VERSION_CONFLICT')
  assert.deepEqual(d.applyCommand(updated, request).state, updated)
})
test('非法额外字段、损坏角色和重复观察者不会从本机读入', () => {
  throwsCode(() => step(d.initialState(), 'create', { ...createFields(), medical: 'private' }), 'INVALID_DATA')
  const state = vote(add(withPlan()))
  const role = copy(state); role.plans[0].fromRole = '母亲'
  throwsCode(() => d.validateState(role), 'INVALID_ROLE')
  const duplicate = copy(state); duplicate.plans[0].votes.push(copy(duplicate.plans[0].votes[0]))
  throwsCode(() => d.validateState(duplicate), 'INVALID_OBSERVER')
  const corrupt = copy(state); corrupt.version++
  throwsCode(() => d.validateState(corrupt), 'INVALID_DATA')
})
test('仅隔离命名空间保存，原档案与其他实验不变', t => {
  const { page, values } = harness(t)
  fillCreate(page); page.createPlan()
  assert.deepEqual(Object.keys(values).sort(), ['catai_mini_pets_v1', 'catai_cato_lab_v1:other:state', key].sort())
  assert.deepEqual(values.catai_mini_pets_v1, { private: true })
  assert.deepEqual(createStore('relationship-observe', global.wx).load('state', null), page._state)
})
test('初次读取异常不会用空数据覆盖，也不开放保存', t => {
  const { page, io } = harness(t, withPlan())
  page.setData({ evidenceNote: '尚未保存的笔记' })
  io.failRead = true; page.loadState(); fillCreate(page); page.createPlan()
  assert.equal(page.data.ready, false)
  assert.equal(page.data.evidenceNote, '尚未保存的笔记')
  assert.equal(io.writes, 0)
})
test('损坏存储不吞错不覆盖，输入保留', t => {
  const { page, values, io } = harness(t, withPlan())
  values[key].plans[0].fromRole = '伪造角色'
  page.setData({ createChecklist: '我的清单' }); page.loadState(); page.createPlan()
  assert.equal(page.data.ready, false)
  assert.equal(page.data.createChecklist, '我的清单')
  assert.equal(io.writes, 0)
})
test('写入失败保留表单和请求，重试成功后才清空证据输入', t => {
  const { page, values, io } = harness(t, withPlan())
  fillEvidence(page); io.failWrite = true; page.addEvidence()
  const operationId = page._pending.command.opId
  assert.equal(page.data.pending, true)
  assert.equal(page.data.evidenceNote, '虚构观察：先靠近，再各自休息。')
  assert.equal(page.data.selected.evidence.length, 0)
  io.failWrite = false; page.retryPending()
  assert.equal(page.data.pending, false)
  assert.equal(page.data.evidenceNote, '')
  assert.equal(values[key].plans[0].evidence.length, 1)
  assert.equal(values[key].receipts.at(-1).id, operationId)
})
test('驱动写入后抛错：重试只核对同一请求，不重复写票或证据', t => {
  const { page, values, io } = harness(t, withPlan())
  fillEvidence(page); io.throwAfterWrite = true; page.addEvidence()
  assert.equal(values[key].plans[0].evidence.length, 1)
  assert.notEqual(page.data.evidenceNote, '')
  io.throwAfterWrite = false; page.retryPending()
  assert.equal(io.writes, 1)
  assert.equal(page.data.selected.evidence.length, 1)
  assert.match(page.data.notice, /未重复提交/)
})
test('写入后读回失败不宣称成功，重试读回后确认', t => {
  const { page, io } = harness(t, withPlan())
  fillEvidence(page); io.failReadAt = io.reads + 2; page.addEvidence()
  assert.equal(page.data.pending, true)
  assert.equal(page.data.notice, '')
  assert.notEqual(page.data.evidenceNote, '')
  io.failReadAt = 0; page.retryPending()
  assert.equal(io.writes, 1)
  assert.equal(page.data.pending, false)
  assert.equal(page.data.selected.evidence.length, 1)
})
test('驱动静默丢写会在读回核对时发现，不清空输入', t => {
  const { page, io } = harness(t, withPlan())
  fillEvidence(page); io.dropWrite = true; page.addEvidence()
  assert.equal(page.data.pending, true)
  assert.equal(page.data.selected.evidence.length, 0)
  assert.notEqual(page.data.evidenceNote, '')
  io.dropWrite = false; page.retryPending()
  assert.equal(page.data.selected.evidence.length, 1)
})
test('保存前读失败也保留请求，重试读取后可以安全完成', t => {
  const { page, io } = harness(t, withPlan())
  fillEvidence(page); io.failRead = true; page.addEvidence()
  assert.equal(page.data.pending, true)
  assert.equal(page.data.ready, false)
  assert.equal(io.writes, 0)
  io.failRead = false; page.retryPending()
  assert.equal(page.data.ready, true)
  assert.equal(page.data.selected.evidence.length, 1)
})
test('页面处理版本冲突：新记录保留、旧输入保留，用户再保存才提交', t => {
  const initial = withPlan()
  const { page, values, io } = harness(t, initial)
  fillEvidence(page, '旧页面仍待提交的输入')
  values[key] = add(initial, AB, 'external-evidence')
  page.addEvidence()
  assert.match(page.data.error, /另一页面改变/)
  assert.equal(page.data.evidenceNote, '旧页面仍待提交的输入')
  assert.equal(io.writes, 0)
  assert.equal(page.data.selected.evidence.length, 1)
  page.addEvidence()
  assert.equal(values[key].plans[0].evidence.length, 2)
})
test('用户取消确认不会撤回、完成或清空草稿', t => {
  const { page, io } = harness(t, vote(add(withPlan())))
  page.setData({ evidenceNote: '保留输入' }); io.confirmed = false
  page.withdrawEvidence({ currentTarget: { dataset: { id: 'evidence_1' } } })
  page.withdrawVote({ currentTarget: { dataset: { id: O1 } } })
  page.toggleStatus()
  assert.equal(io.writes, 0)
  assert.equal(page.data.selected.evidence[0].active, true)
  assert.equal(page.data.selected.votes.length, 1)
  assert.equal(page.data.selected.status, 'active')
  assert.equal(page.data.evidenceNote, '保留输入')
})
test('确认窗口失败不执行操作，输入仍在', t => {
  const { page, io } = harness(t, add(withPlan()))
  io.modalFail = true; page.setData({ evidenceNote: '保留输入' }); page.toggleStatus()
  assert.equal(io.writes, 0)
  assert.match(page.data.error, /未执行操作/)
  assert.equal(page.data.evidenceNote, '保留输入')
})
test('切换方向分别保留草稿，不串证据输入和勾选', t => {
  const state = add(step(add(withPlan()), 'create', createFields(B, A)), BA, 'reverse-evidence')
  const { page } = harness(t, state)
  page.setData({ evidenceNote: 'AB 草稿', selectedEvidenceIds: ['evidence_1'] })
  page.selectPlan({ currentTarget: { dataset: { id: BA } } })
  assert.equal(page.data.evidenceNote, '')
  assert.deepEqual(page.data.selectedEvidenceIds, [])
  page.setData({ evidenceNote: 'BA 草稿' })
  page.selectPlan({ currentTarget: { dataset: { id: AB } } })
  assert.equal(page.data.evidenceNote, 'AB 草稿')
  assert.deepEqual(page.data.selectedEvidenceIds, ['evidence_1'])
})
test('取消编辑不保存，再打开时保留未保存清单', t => {
  const { page, io } = harness(t, withPlan())
  page.startEdit(); page.setData({ editChecklist: '待核对新清单' }); page.cancelEdit(); page.startEdit()
  assert.equal(page.data.editChecklist, '待核对新清单')
  assert.equal(io.writes, 0)
  assert.notEqual(page.data.selected.checklist, '待核对新清单')
  page.setData({ editChecklist: '' }); page.cancelEdit(); page.startEdit()
  assert.equal(page.data.editChecklist, '')
})
test('另建方向后编辑框不会带入前一方向的编辑草稿', t => {
  const { page } = harness(t, withPlan())
  page.startEdit(); page.setData({ editChecklist: '仅 AB 的未保存草稿' }); page.cancelEdit()
  page.openReverse(); fillCreate(page); page.createPlan(); page.startEdit()
  assert.equal(page.data.selected.id, BA)
  assert.equal(page.data.editChecklist, page.data.selected.checklist)
  page.selectPlan({ currentTarget: { dataset: { id: AB } } }); page.startEdit()
  assert.equal(page.data.editChecklist, '仅 AB 的未保存草稿')
})
test('无效输入不写入，保留已填写的日期和正文', t => {
  const { page, io } = harness(t)
  page.setData({ createChecklist: '我的清单', createDate: '2026-09-30' }); page.createPlan()
  assert.equal(io.writes, 0)
  assert.equal(page.data.createChecklist, '我的清单')
  assert.equal(page.data.createDate, '2026-09-30')
  assert.equal(page.data.pending, false)
  assert.match(page.data.error, /日期与时间/)
})
test('改行为类型不覆盖用户自写清单，待确认保存期间不接受新修改', t => {
  const { page, io } = harness(t)
  page.setData({ createChecklist: '我写的清单' }); page.changeKind({ detail: { value: '1' } })
  assert.equal(page.data.createChecklist, '我写的清单')
  fillCreate(page); io.failWrite = true; page.createPlan()
  const opId = page._pending.command.opId
  page.changeField({ currentTarget: { dataset: { field: 'createChecklist' } }, detail: { value: '新输入' } })
  page.createPlan()
  assert.equal(page.data.createChecklist, '我写的清单')
  assert.equal(page._pending.command.opId, opId)
})
test('页面投票表来自本地保存票，改票与撤票刷新真实计数', t => {
  const { page } = harness(t, add(withPlan()))
  page.setData({ selectedEvidenceIds: ['evidence_1'], observerIndex: 0, voteIndex: 0 }); page.vote()
  page.setData({ observerIndex: 1, voteIndex: 1 }); page.vote()
  assert.deepEqual(page.data.stats.rows.map(row => row.count), [1, 1, 0])
  page.setData({ observerIndex: 0, voteIndex: 2 }); page.vote()
  assert.deepEqual(page.data.stats.rows.map(row => row.count), [0, 1, 1])
  page.withdrawVote({ currentTarget: { dataset: { id: O2 } } })
  assert.deepEqual(page.data.stats.rows.map(row => row.count), [0, 0, 1])
})
test('页面按时间排序证据而非提交顺序，反向新建不会写记录', t => {
  let state = add(withPlan())
  state = step(state, 'addEvidence', { planId: AB, evidenceId: 'earlier', observedAt: '2026-09-28T12:00', note: '更早的虚构观察' })
  const { page, io } = harness(t, state)
  assert.deepEqual(page.data.allEvidence.map(item => item.id), ['earlier', 'evidence_1'])
  page.openReverse()
  assert.equal(page.data.fromIndex, 1)
  assert.equal(page.data.toIndex, 0)
  assert.equal(io.writes, 0)
  assert.equal(page.data.plans.length, 1)
})
test('页面契约：独立路由、无网络或原store、WXML保留原始逻辑运算符', () => {
  const root = path.join(__dirname, '..')
  const page = fs.readFileSync(path.join(root, 'pages/cato-relationship-observe/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-relationship-observe/index.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-relationship-observe/index.wxss'), 'utf8')
  assert.match(page, /createStore\('relationship-observe'\)/)
  assert.doesNotMatch(page, /wx\.(request|cloud|chooseLocation|getLocation)|readLocalCatCards|require\([^)]*(community|storage|identity)/)
  assert.match(wxml, /非关系认证/)
  assert.match(wxml, /&&/)
  assert.doesNotMatch(wxml, /&amp;&amp;/)
  assert.match(css, /min-height: 88rpx/)
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.pages[0], 'pages/cato-lab/index')
  assert.ok(app.pages.includes('pages/cato-relationship-observe/index'))
})
