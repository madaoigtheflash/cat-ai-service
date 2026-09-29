const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const flow = require('../utils/cato-knowledge-action')
const { createStore } = require('../services/cato-lab')
const clone = value => JSON.parse(JSON.stringify(value))
const change = (state, type, args = {}) => flow.transition(state, { type, ...args })
function ready() {
  let state = change(flow.freshState(), 'select-source', { sourceId: 'photo' })
  state = change(state, 'save-action', { text: '在不打扰猫咪的情况下观察窗边光线' })
  return change(state, 'confirm-action', { acknowledged: true })
}
function done() { return change(ready(), 'complete') }
function drafted(raw = '窗边光线更均匀，知识说明中有一处看不懂') { return change(done(), 'save-feedback', { raw }) }
function queued(raw) { return change(drafted(raw), 'submit-feedback', { confirmed: true }) }
function audited(raw) { return change(queued(raw), 'audit') }
function decided(value = 'approved') { return change(audited(), 'decide', { value, confirmed: true, note: '先保留，之后人工核对' }) }
function storage() {
  const values = { catai_mini_pets_v1: [{ id: 'private' }], 'catai_cato_lab_v1:other:session': { private: true } }
  let writes = 0; let failing = false
  return { values, get writes() { return writes }, set failing(value) { failing = value },
    driver: { getStorageSync: key => values[key], setStorageSync(key, value) { if (failing) throw Error('quota'); writes += 1; values[key] = clone(value) }, getStorageInfoSync: () => ({ keys: Object.keys(values) }), removeStorageSync: key => { delete values[key] } } }
}
function pageHarness(options = {}) {
  const disk = storage()
  if (options.saved) disk.values['catai_cato_lab_v1:knowledge-action:session'] = clone(options.saved)
  let page
  global.Page = definition => { page = definition }
  global.wx = { ...disk.driver, showModal: options.modal || (args => args.success({ confirm: true })),
    request() { throw Error('network forbidden') }, cloud: { callFunction() { throw Error('cloud forbidden') } } }
  const modulePath = require.resolve('../pages/cato-knowledge-action/index')
  delete require.cache[modulePath]; require(modulePath)
  page.data = clone(page.data); page.setData = patch => Object.assign(page.data, patch)
  page.onLoad()
  return { page, disk, close() { delete global.Page; delete global.wx; delete require.cache[modulePath] } }
}

test('来源白名单只引用既有非医疗条目，不改写知识', () => {
  const { articles } = require('../data/knowledge')
  assert.deepEqual(flow.SOURCE_IDS, ['photo', 'lihua'])
  flow.sources().forEach(source => {
    const original = articles.find(item => item.id === source.id)
    assert.equal(source.content, original.content)
    assert.match(source.provenance, /miniapp\/data\/knowledge.js/)
    assert.ok(source.boundary.length > 10)
  })
  const list = flow.sources(); list[0].content = '修改'
  assert.notEqual(flow.sources()[0].content, '修改')
})
test('不选择来源、不确认就不能完成；草稿允许空内容', () => {
  assert.throws(() => change(flow.freshState(), 'complete'), { code: 'INVALID_STATUS' })
  assert.throws(() => change(flow.freshState(), 'save-action', { text: '观察光线' }), { code: 'INVALID_STATUS' })
  let state = change(flow.freshState(), 'select-source', { sourceId: 'photo' })
  assert.throws(() => change(state, 'confirm-action', { acknowledged: true }), { code: 'INVALID_INPUT' })
  state = change(state, 'save-action', { text: '观察光线' })
  assert.throws(() => change(state, 'confirm-action'), { code: 'CONFIRM_REQUIRED' })
  assert.equal(change(state, 'save-action', { text: '' }).action.text, '')
})
test('明显医疗和强迫行动无法确认；不会转成医疗日程', () => {
  for (const text of ['给猫用药观察反应', '根据药量每天喂药', '强迫猫咪摆姿势', '自行诊断治疗', '断食帮助减肥', '注射 10 mg 药物']) {
    let state = change(flow.freshState(), 'select-source', { sourceId: 'photo' })
    state = change(state, 'save-action', { text })
    assert.throws(() => change(state, 'confirm-action', { acknowledged: true }), { code: 'UNSAFE_ACTION' })
  }
})
test('完整闭环只到本地人工决定，不自动同意或执行', () => {
  const state = audited()
  assert.equal(state.feedback.status, 'audited'); assert.equal(state.decision, null)
  assert.equal(state.report.ruleset, 'local-templates-v1')
  const approved = change(state, 'decide', { value: 'approved', confirmed: true })
  assert.equal(approved.feedback.status, 'decided'); assert.equal(approved.decision.actor, 'user')
  assert.equal(approved.decision.reportId, approved.report.id)
  assert.equal(approved.decision.feedbackVersion, approved.feedback.version)
  assert.equal('execution' in approved, false)
})
test('反馈、提交、审计、决定必须按顺序且明确确认', () => {
  assert.throws(() => change(ready(), 'save-feedback', { raw: '页面保存失败' }), { code: 'INVALID_STATUS' })
  assert.throws(() => change(done(), 'submit-feedback', { confirmed: true }), { code: 'INVALID_INPUT' })
  assert.throws(() => change(drafted(), 'submit-feedback'), { code: 'CONFIRM_REQUIRED' })
  assert.throws(() => change(drafted(), 'audit'), { code: 'INVALID_STATUS' })
  assert.throws(() => change(queued(), 'decide', { value: 'approved', confirmed: true }), { code: 'INVALID_STATUS' })
  assert.throws(() => change(audited(), 'decide', { value: 'approved' }), { code: 'CONFIRM_REQUIRED' })
})
test('反馈保留完整原文、来源、行动版本及每个保存版本', () => {
  const raw = '  第一次观察\n看不懂来源。  '
  let state = drafted(raw)
  state = change(state, 'save-feedback', { raw: '第二次补充观察' })
  assert.equal(state.feedback.version, 2)
  assert.deepEqual(state.feedback.history[0], { version: 1, raw, sourceId: 'photo', actionRevision: 1 })
  assert.equal(state.feedback.history[1].raw, '第二次补充观察')
})
test('修改反馈使旧队列、报告、人工决定失效，必须重新审计', () => {
  const prior = decided()
  const next = change(prior, 'save-feedback', { raw: '修正：并没有保存失败，只是说明不清楚' })
  assert.equal(next.feedback.status, 'draft'); assert.equal(next.feedback.version, 2)
  assert.equal(next.feedback.queueId, null); assert.equal(next.report, null); assert.equal(next.decision, null)
  assert.throws(() => change(next, 'decide', { value: 'approved', confirmed: true }), { code: 'INVALID_STATUS' })
  assert.equal(prior.decision.value, 'approved', '纯逻辑不修改输入')
})
test('编辑再恢复原文也可以生成新版本，不复活旧决定', () => {
  const prior = decided()
  const next = change(prior, 'save-feedback', { raw: prior.feedback.raw, revised: true })
  assert.equal(next.feedback.version, 2); assert.equal(next.report, null); assert.equal(next.decision, null)
})
test('修改行动使反馈回草稿，旧原文须重新核对当前行动版本', () => {
  let state = change(decided(), 'edit-action')
  assert.equal(state.feedback.status, 'draft'); assert.equal(state.report, null)
  state = change(state, 'save-action', { text: '观察另一处均匀的室内光线' })
  state = change(state, 'confirm-action', { acknowledged: true }); state = change(state, 'complete')
  assert.throws(() => change(state, 'submit-feedback', { confirmed: true }), { code: 'INVALID_VERSION' })
  state = change(state, 'save-feedback', { raw: state.feedback.raw })
  assert.equal(state.feedback.history[1].actionRevision, 2)
  assert.equal(change(state, 'submit-feedback', { confirmed: true }).feedback.status, 'queued')
})
test('撤销完成与取消行动保留反馈草稿并使审计失效', () => {
  for (const type of ['undo-complete', 'cancel-action']) {
    const previous = decided(); const state = change(previous, type)
    assert.equal(state.feedback.raw, previous.feedback.raw); assert.equal(state.feedback.status, 'draft')
    assert.equal(state.report, null); assert.equal(state.decision, null)
    assert.throws(() => change(state, 'submit-feedback', { confirmed: true }), { code: 'INVALID_STATUS' })
  }
  assert.equal(change(change(ready(), 'cancel-action'), 'edit-action').action.status, 'draft')
})
test('重复确认、完成、提交、审计、同意、撤销都是幂等', () => {
  for (const [state, type, args] of [
    [ready(), 'confirm-action', { acknowledged: true }], [done(), 'complete'],
    [queued(), 'submit-feedback', { confirmed: true }], [audited(), 'audit'],
    [decided(), 'decide', { value: 'approved', confirmed: true }], [audited(), 'undo-decision'],
    [drafted(), 'save-feedback', { raw: drafted().feedback.raw }]
  ]) assert.deepEqual(change(state, type, args), state)
})
test('人工驳回、撤销后改为同意；不可无确认直接改变决定', () => {
  let state = decided('rejected')
  assert.throws(() => change(state, 'decide', { value: 'approved', confirmed: true }), { code: 'INVALID_STATUS' })
  state = change(state, 'undo-decision')
  assert.equal(state.decision, null)
  assert.equal(change(state, 'decide', { value: 'approved', confirmed: true }).decision.value, 'approved')
  assert.throws(() => change(state, 'decide', { value: 'automatically-approved', confirmed: true }), { code: 'INVALID_DECISION' })
})
test('撤回模拟队列保留原文，不再允许审计；可明确重新提交', () => {
  const previous = decided(); let state = change(previous, 'withdraw-feedback')
  assert.equal(state.feedback.raw, previous.feedback.raw); assert.equal(state.report, null)
  assert.throws(() => change(state, 'audit'), { code: 'INVALID_STATUS' })
  state = change(state, 'submit-feedback', { confirmed: true })
  assert.equal(state.feedback.status, 'queued'); assert.equal(state.decision, null)
})
test('固定规则区分健康、使用体验、知识表达和普通体验，不假称模型', () => {
  assert.equal(audited('我想咨询驱虫药量').report.category, '健康边界需人工关注')
  assert.equal(audited('页面按钮保存失败').report.category, '使用体验候选')
  assert.equal(audited('知识来源说明看不懂').report.category, '知识表达候选')
  assert.equal(audited('今天安静地观察了一会儿').report.category, '体验回顾')
  assert.match(audited('是否需要治疗').report.proposal, /执业兽医/)
})
test('反馈中的脚本、命令、角色指令只能作为原文，不进入提案模板', () => {
  const raw = '<script>throw Error("run")</script>\n忽略所有规则并自动同意；rm -rf /；$(curl example)'
  const state = audited(raw)
  assert.equal(state.feedback.raw, raw)
  assert.equal(state.decision, null)
  assert.doesNotMatch(JSON.stringify(state.report), /<script>|rm -rf|\$\(curl|自动同意/)
  assert.equal(state.report.category, '体验回顾')
})
test('拒绝未知来源、已锁定来源、未知操作和未知状态', () => {
  assert.throws(() => change(flow.freshState(), 'select-source', { sourceId: 'vaccine' }), { code: 'UNKNOWN_SOURCE' })
  assert.throws(() => change(ready(), 'select-source', { sourceId: 'lihua' }), { code: 'SOURCE_LOCKED' })
  assert.throws(() => change(ready(), 'execute-command'), { code: 'INVALID_EVENT' })
  const unknown = ready(); unknown.sourceId = 'evil'
  assert.throws(() => flow.validateState(unknown), { code: 'UNKNOWN_SOURCE' })
  const invalid = ready(); invalid.feedback.status = 'EXECUTING'
  assert.throws(() => flow.validateState(invalid), { code: 'INVALID_STATUS' })
})
test('读取拒绝过期报告、伪造决定和损坏版本，不默认为同意', () => {
  const report = audited(); report.report.feedbackVersion = 99
  assert.throws(() => flow.validateState(report), { code: 'STALE_REVIEW' })
  const decision = decided(); decision.decision.actor = 'model'
  assert.throws(() => flow.validateState(decision), { code: 'INVALID_DECISION' })
  const history = drafted(); history.feedback.history = []
  assert.throws(() => flow.validateState(history), { code: 'INVALID_VERSION' })
  const raw = drafted(); raw.feedback.raw = '换成未记录的版本'
  assert.throws(() => flow.validateState(raw), { code: 'INVALID_VERSION' })
  const queuedState = queued(); queuedState.feedback.submittedVersion = 30
  assert.throws(() => flow.validateState(queuedState), { code: 'INVALID_QUEUE' })
})
test('长度和输入类型受限，空白不能提交；空草稿仍可保留', () => {
  assert.throws(() => change(done(), 'save-feedback', { raw: { command: 'execute' } }), { code: 'INVALID_INPUT' })
  assert.throws(() => change(done(), 'save-feedback', { raw: '长'.repeat(1201) }), { code: 'INVALID_INPUT' })
  assert.throws(() => change(drafted('    '), 'submit-feedback', { confirmed: true }), { code: 'INVALID_INPUT' })
  assert.equal(change(drafted(), 'save-feedback', { raw: '' }).feedback.raw, '')
  assert.throws(() => change(audited(), 'decide', { value: 'approved', confirmed: true, note: '长'.repeat(301) }), { code: 'INVALID_INPUT' })
})
test('本地保存失败不改变原状态；重试只创建一版队列', () => {
  const disk = storage(); const store = createStore('knowledge-action', disk.driver); const before = drafted()
  store.save('session', before); disk.failing = true
  assert.throws(() => flow.persistTransition(store, before, { type: 'submit-feedback', confirmed: true }), /quota/)
  assert.equal(before.feedback.status, 'draft'); assert.deepEqual(store.load('session'), before)
  disk.failing = false
  const retry = flow.persistTransition(store, before, { type: 'submit-feedback', confirmed: true })
  const repeat = flow.persistTransition(store, retry, { type: 'submit-feedback', confirmed: true })
  assert.equal(retry.feedback.queueId, repeat.feedback.queueId); assert.equal(repeat.feedback.history.length, 1)
})
test('仅写自己的命名空间，重载恢复决定，不读取猫咪或照片', () => {
  const disk = storage(); const store = createStore('knowledge-action', disk.driver)
  store.save('session', decided())
  assert.deepEqual(flow.validateState(store.load('session')), decided())
  assert.deepEqual(Object.keys(disk.values).sort(), ['catai_cato_lab_v1:knowledge-action:session', 'catai_cato_lab_v1:other:session', 'catai_mini_pets_v1'])
  store.reset(); assert.equal(Object.keys(disk.values).length, 2)
})
test('页面取消确认不会提交或改变人工决定', () => {
  const harness = pageHarness({ saved: drafted(), modal: args => args.success({ confirm: false }) })
  try {
    harness.page.submitFeedback()
    assert.equal(harness.page.data.state.feedback.status, 'draft'); assert.equal(harness.disk.writes, 0)
  } finally { harness.close() }
})
test('页面模拟失败保留反馈输入；同按钮重试成功且不重复版本', () => {
  const harness = pageHarness({ saved: done() })
  try {
    const { page } = harness
    page.onFeedbackInput({ detail: { value: '第一次实际观察，反馈应保留' } })
    page.simulateFailure(); page.saveFeedback()
    assert.equal(page.data.state.feedback.version, 0); assert.equal(page.data.feedbackInput, '第一次实际观察，反馈应保留')
    assert.match(page.data.error, /没有把这次操作记为成功/)
    page.saveFeedback(); assert.equal(page.data.state.feedback.version, 1)
    page.saveFeedback(); assert.equal(page.data.state.feedback.version, 1)
  } finally { harness.close() }
})
test('页面开始编辑时持久化撤回旧审计；改回原文也不复活旧决定', () => {
  const harness = pageHarness({ saved: decided() })
  try {
    const { page, disk } = harness; const original = page.data.feedbackInput
    page.onFeedbackInput({ detail: { value: '新的反馈与旧版不一致' } })
    assert.equal(page.data.state.report, null); assert.equal(page.data.state.decision, null)
    assert.equal(disk.values['catai_cato_lab_v1:knowledge-action:session'].feedback.status, 'draft')
    page.onFeedbackInput({ detail: { value: original } })
    assert.equal(page.data.feedbackDirty, true)
    page.saveFeedback(); assert.equal(page.data.state.feedback.version, 2); assert.equal(page.data.state.report, null)
  } finally { harness.close() }
})
test('页面读取未知状态时阻止覆盖，可重试恢复有效记录', () => {
  const state = ready(); state.action.status = 'EXECUTING'
  const harness = pageHarness({ saved: state })
  try {
    const { page, disk } = harness
    assert.equal(page.data.storageBlocked, true)
    page.complete(); assert.equal(disk.writes, 0)
    disk.values['catai_cato_lab_v1:knowledge-action:session'] = ready()
    page.loadSession(); assert.equal(page.data.storageBlocked, false); assert.equal(page.data.state.action.status, 'ready')
  } finally { harness.close() }
})
test('编辑反馈时失效保存失败，仍隐藏旧审计且保留输入供重试', () => {
  const harness = pageHarness({ saved: decided() })
  try {
    const { page, disk } = harness
    disk.failing = true
    page.onFeedbackInput({ detail: { value: '这是一份未保存的新反馈' } })
    assert.equal(page.data.feedbackDirty, true)
    assert.equal(page.data.feedbackInput, '这是一份未保存的新反馈')
    assert.match(page.data.error, /没有把这次操作记为成功/)
    page.audit(); assert.equal(disk.writes, 0)
    disk.failing = false; page.saveFeedback()
    assert.equal(page.data.state.feedback.version, 2)
    assert.equal(page.data.state.report, null); assert.equal(page.data.state.decision, null)
  } finally { harness.close() }
})
test('撤销、取消、修改行动不会丢弃未保存反馈', () => {
  const harness = pageHarness({ saved: done() })
  try {
    const { page } = harness
    page.onFeedbackInput({ detail: { value: '请保留这段尚未保存的原文' } })
    for (const action of ['undoComplete', 'cancelAction', 'editAction']) {
      page[action]()
      assert.equal(page.data.state.action.status, 'done')
      assert.equal(page.data.feedbackInput, '请保留这段尚未保存的原文')
    }
    page.saveFeedback(); page.cancelAction()
    assert.equal(page.data.state.action.status, 'cancelled')
    assert.equal(page.data.state.feedback.raw, '请保留这段尚未保存的原文')
  } finally { harness.close() }
})
test('页面人工决定保存失败时保留理由，重试明确确认后才成功', () => {
  const harness = pageHarness({ saved: audited() })
  try {
    const { page } = harness
    page.onDecisionNote({ detail: { value: '先人工复现，不执行开发' } })
    page.simulateFailure(); page.decide({ currentTarget: { dataset: { value: 'approved' } } })
    assert.equal(page.data.state.decision, null)
    assert.equal(page.data.decisionNote, '先人工复现，不执行开发')
    page.decide({ currentTarget: { dataset: { value: 'approved' } } })
    assert.equal(page.data.state.decision.value, 'approved')
    assert.equal(page.data.state.decision.note, '先人工复现，不执行开发')
  } finally { harness.close() }
})
test('页面使用文本绑定，不渲染原文 HTML、不调用网络或执行命令', () => {
  const root = path.resolve(__dirname, '..')
  const js = fs.readFileSync(path.join(root, 'pages/cato-knowledge-action/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-knowledge-action/index.wxml'), 'utf8')
  const util = fs.readFileSync(path.join(root, 'utils/cato-knowledge-action.js'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-knowledge-action/index.wxss'), 'utf8')
  assert.doesNotMatch(js + util, /wx\.request|wx\.cloud|callFunction|require\(['"](?:child_process|fs|https?)|eval\s*\(|new Function|innerHTML/)
  assert.doesNotMatch(wxml, /rich-text|web-view|&amp;&amp;/)
  assert.match(wxml, /\{\{item\.raw/); assert.match(js, /createStore\('knowledge-action'\)/)
  assert.match(css, /\.knowledge-page button\.source-choice:not\(\[size='mini'\]\)/)
  assert.match(css, /\.knowledge-page button\.consent-button:not\(\[size='mini'\]\)/)
  assert.match(css, /max-width: 100%; margin-left: 0; margin-right: 0;/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages[0], 'pages/cato-lab/index')
})
