const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const rules = require('../utils/cato-expenses')
const { createStore } = require('../services/cato-lab')
const { createPage } = require('../pages/cato-expenses/index')

const draft = (overrides = {}) => ({ amount: '38.50', date: '2026-09-29', category: 'food', catName: '小桃', note: '补充猫粮', ...overrides })
const added = (input = draft(), id = 'op_1') => rules.upsertExpense(rules.emptyLedger(), input, id).ledger
const event = id => ({ currentTarget: { dataset: { id } } })

function harness(initial = rules.emptyLedger()) {
  const values = { 'catai_cato_lab_v1:expenses:ledger': structuredClone(initial), catai_mini_pets_v1: [{ id: 'private', name: '不应读取', photo: 'secret' }] }
  const control = { writes: 0, reads: [], failSave: false, failLoad: false, saveThenThrow: false, modals: [], scrolls: [] }
  const driver = {
    getStorageSync(key) { control.reads.push(key); if (control.failLoad) throw Error('read failed'); return values[key] },
    setStorageSync(key, value) {
      control.writes++
      if (control.failSave) throw Error('quota exceeded')
      values[key] = structuredClone(value)
      if (control.saveThenThrow) throw Error('uncertain result')
    }
  }
  let nextId = 100
  const page = createPage({ store: createStore('expenses', driver), now: () => new Date(2026, 8, 29), newId: () => 'op_' + (++nextId), api: { showModal: modal => control.modals.push(modal), pageScrollTo: options => control.scrolls.push(options) } })
  page.data = structuredClone(page.data)
  page.setData = patch => {
    for (const [key, value] of Object.entries(patch)) {
      const segments = key.split('.')
      let target = page.data
      for (const segment of segments.slice(0, -1)) target = target[segment]
      target[segments[segments.length - 1]] = structuredClone(value)
    }
  }
  page.onLoad()
  const setDraft = (input = draft()) => { page.data.draft = structuredClone(input) }
  const ledger = () => values['catai_cato_lab_v1:expenses:ledger']
  return { page, control, values, setDraft, ledger }
}

test('金额以分精确解析并格式化，支持前导零和两位以内小数', () => {
  for (const [input, cents] of [['0.01', 1], ['0.1', 10], ['1', 100], ['0001.20', 120], [' 38.50 ', 3850], ['999999.99', 99999999]]) {
    assert.equal(rules.parseAmount(input), cents, input)
    assert.equal(rules.parseAmount(rules.formatCents(cents)), cents)
  }
  assert.equal(rules.formatCents(0), '0.00')
  assert.equal(rules.formatCents(30), '0.30')
})

for (const value of ['', ' ', '0', '0.00', '-0.01', '+1', '1.001', '1.', '.50', '1e2', '1,000', '￥1', '１２', 'NaN', 'Infinity', '1000000', '999999.999', '99999999999999999999', 1, null, undefined]) {
  test('拒绝无效或超限金额 ' + String(value), () => assert.throws(() => rules.parseAmount(value)))
}

test('公历日期验证不依赖日期自动溢出，正确处理世纪闰年和范围', () => {
  for (const value of ['1900-01-01', '2000-02-29', '2024-02-29', '2026-09-30', '2100-12-31']) assert.equal(rules.isValidDate(value), true, value)
  for (const value of ['1900-02-29', '2100-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-09-00', '2026-9-29', '1899-12-31', '2101-01-01', '2026-09-29T00:00:00Z', null]) assert.equal(rules.isValidDate(value), false, value)
  assert.equal(rules.localDate(new Date(2026, 8, 29, 0, 1)), '2026-09-29')
})

test('草稿只保留白名单字段并限制名字备注长度和分类', () => {
  assert.deepEqual(rules.validateDraft(draft({ catName: ' 小桃 ', note: ' 备注 ', photo: 'secret', diagnosis: 'secret' })), { cents: 3850, date: '2026-09-29', category: 'food', catName: '小桃', note: '备注' })
  for (const input of [draft({ catName: '猫'.repeat(61) }), draft({ note: '字'.repeat(201) }), draft({ category: 'bank' }), draft({ date: '2026-02-30' })]) assert.throws(() => rules.validateDraft(input))
  assert.equal(rules.validateDraft(draft({ catName: '', note: '' })).catName, '')
})

test('新增纯函数不修改输入，同一确认标识只写一次', () => {
  const initial = rules.emptyLedger()
  const input = draft()
  const result = rules.upsertExpense(initial, input, 'op_add')
  assert.equal(result.changed, true)
  assert.deepEqual(initial, rules.emptyLedger())
  assert.equal(input.amount, '38.50')
  const duplicate = rules.upsertExpense(result.ledger, input, 'op_add')
  assert.equal(duplicate.changed, false)
  assert.deepEqual(duplicate.ledger, result.ledger)
  assert.equal(duplicate.ledger.records.length, 1)
})

test('按月分类计算总额，0.10 + 0.20 = 0.30，不混入其他月份', () => {
  let ledger = rules.emptyLedger()
  for (const [index, input] of [draft({ amount: '0.10' }), draft({ amount: '0.20', category: 'litter' }), draft({ amount: '999.99', date: '2026-08-31' })].entries()) ledger = rules.upsertExpense(ledger, input, 'add_' + index).ledger
  const summary = rules.monthlySummary(ledger, '2026-09')
  assert.equal(summary.totalCents, 30)
  assert.equal(summary.count, 2)
  assert.equal(summary.categories[0].cents, 10)
  assert.equal(summary.categories[1].cents, 20)
  assert.equal(summary.categories.reduce((sum, category) => sum + category.cents, 0), summary.totalCents)
  assert.equal(rules.monthlySummary(ledger, '2026-10').totalCents, 0)
  assert.throws(() => rules.monthlySummary(ledger, '2026-13'))
})

test('修改替换原记录，跨月跨分类汇总与版本一致，重复修改幂等', () => {
  const initial = added()
  const input = draft({ amount: '0.20', date: '2026-10-01', category: 'medical', note: '已核对' })
  const result = rules.upsertExpense(initial, input, 'edit_1', 'op_1', 1)
  assert.equal(result.ledger.records.length, 1)
  assert.equal(result.ledger.records[0].id, 'op_1')
  assert.equal(result.ledger.records[0].revision, 2)
  assert.equal(initial.records[0].cents, 3850)
  assert.equal(rules.monthlySummary(result.ledger, '2026-09').count, 0)
  assert.equal(rules.monthlySummary(result.ledger, '2026-10').categories[2].cents, 20)
  assert.equal(rules.upsertExpense(result.ledger, input, 'edit_1', 'op_1', 1).changed, false)
  assert.throws(() => rules.upsertExpense(result.ledger, input, 'edit_stale', 'op_1', 1), /已变化/)
  assert.throws(() => rules.upsertExpense(result.ledger, input, 'edit_missing', 'missing', 1), /已变化/)
})

test('删除重新汇总、保留确认标识阻止旧确认复活记录，旧版本删除被拒绝', () => {
  const initial = added()
  const result = rules.deleteExpense(initial, 'op_1', 'delete_1', 1)
  assert.equal(result.ledger.records.length, 0)
  assert.equal(initial.records.length, 1)
  assert.equal(rules.monthlySummary(result.ledger, '2026-09').totalCents, 0)
  assert.equal(rules.deleteExpense(result.ledger, 'op_1', 'delete_1', 1).changed, false)
  assert.equal(rules.upsertExpense(result.ledger, draft(), 'op_1').ledger.records.length, 0)
  assert.throws(() => rules.deleteExpense(initial, 'op_1', 'delete_stale', 2), /已变化/)
})

test('记录上限下汇总仍是安全整数，禁止第 1001 笔但允许修改和删除', () => {
  const ledger = { version: 1, records: Array.from({ length: 1000 }, (_, index) => ({ id: 'r_' + index, ...rules.validateDraft(draft({ amount: '999999.99' })), revision: 1 })), applied: [] }
  const total = rules.monthlySummary(ledger, '2026-09').totalCents
  assert.equal(total, 99999999000)
  assert.equal(Number.isSafeInteger(total), true)
  assert.equal(rules.formatCents(total), '999999990.00')
  assert.throws(() => rules.upsertExpense(ledger, draft(), 'full'), /1,000/)
  assert.equal(rules.upsertExpense(ledger, draft(), 'edit_full', 'r_0', 1).ledger.records.length, 1000)
  assert.equal(rules.deleteExpense(ledger, 'r_0', 'delete_full', 1).ledger.records.length, 999)
})

test('损坏账本不被悄悄重置，异常金额、重复ID和确认记录均拒绝', () => {
  const ledger = added()
  for (const invalid of [{}, { ...ledger, version: 2 }, { ...ledger, records: [ledger.records[0], ledger.records[0]] }, { ...ledger, records: [{ ...ledger.records[0], cents: 0.1 }] }, { ...ledger, applied: ['same', 'same'] }]) assert.throws(() => rules.validateLedger(invalid))
  const safe = rules.validateLedger({ ...ledger, photo: 'private' })
  assert.equal(safe.photo, undefined)
})

test('页面启动仅读取独立命名空间，未确认预览不写任何记录', () => {
  const h = harness()
  assert.equal(h.page.data.ready, true)
  assert.equal(h.page.data.month, '2026-09')
  assert.equal(h.page.data.total, '0.00')
  h.setDraft()
  h.page.previewDraft()
  assert.equal(h.page.data.preview.amount, '38.50')
  assert.equal(h.control.writes, 0)
  assert.equal(h.ledger().records.length, 0)
  assert.equal(h.control.reads.every(key => key.startsWith('catai_cato_lab_v1:expenses:')), true)
  h.page.backToForm()
  assert.equal(h.page.data.preview, null)
  assert.equal(h.page.data.draft.note, '补充猫粮')
  h.page.confirmPreview()
  assert.equal(h.control.writes, 0)
})

test('页面无效金额不进入预览、不写入且保留输入', () => {
  const h = harness()
  h.setDraft(draft({ amount: '-1.00' }))
  h.page.previewDraft()
  assert.equal(h.page.data.preview, null)
  assert.ok(h.page.data.error)
  assert.equal(h.page.data.draft.amount, '-1.00')
  h.page.confirmPreview()
  assert.equal(h.control.writes, 0)
})

test('确认一次保存、更新可见明细和汇总，重复点击不重复，重新进页仍在', () => {
  const h = harness()
  h.setDraft()
  h.page.previewDraft()
  h.page.confirmPreview()
  h.page.confirmPreview()
  assert.equal(h.control.writes, 1)
  assert.equal(h.ledger().records.length, 1)
  assert.equal(h.page.data.total, '38.50')
  assert.equal(h.page.data.rows[0].catName, '小桃')
  assert.equal(h.page.data.draft.amount, '')
  assert.equal(h.page.data.preview, null)
  assert.match(h.page.data.status, /已记入/)
  const reopened = harness(h.ledger())
  assert.equal(reopened.page.data.total, '38.50')
  assert.equal(reopened.page.data.rows[0].note, '补充猫粮')
})

test('写入失败保留原账本、草稿和预览，修复存储后重试成功', () => {
  const h = harness(added())
  h.setDraft(draft({ amount: '9.80' }))
  h.page.previewDraft()
  h.control.failSave = true
  h.page.confirmPreview()
  assert.equal(h.ledger().records.length, 1)
  assert.equal(h.page.data.total, '38.50')
  assert.equal(h.page.data.draft.amount, '9.80')
  assert.equal(h.page.data.preview.amount, '9.80')
  assert.equal(h.page.data.status, '')
  assert.equal(h.page.data.saving, false)
  assert.match(h.page.data.error, /草稿仍保留/)
  h.control.failSave = false
  h.page.confirmPreview()
  assert.equal(h.ledger().records.length, 2)
  assert.equal(h.page.data.total, '48.30')
})

test('存储实际写入却报告失败时，重试通过已保存确认标识避免多记', () => {
  const h = harness()
  h.setDraft()
  h.page.previewDraft()
  h.control.saveThenThrow = true
  h.page.confirmPreview()
  assert.equal(h.ledger().records.length, 1)
  assert.ok(h.page.data.preview)
  h.control.saveThenThrow = false
  h.page.confirmPreview()
  assert.equal(h.ledger().records.length, 1)
  assert.equal(h.control.writes, 1)
  assert.equal(h.page.data.total, '38.50')
})

test('修改记录经预览后保存，并自动切换到修改后的月份', () => {
  const h = harness(added())
  h.page.startEdit(event('op_1'))
  assert.equal(h.page.data.editId, 'op_1')
  assert.equal(h.page.data.draft.amount, '38.50')
  h.page.onField({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '25.30' } })
  h.page.onDate({ detail: { value: '2026-10-02' } })
  h.page.onCategory({ detail: { value: '2' } })
  h.page.previewDraft()
  assert.equal(h.ledger().records[0].cents, 3850)
  h.page.confirmPreview()
  assert.equal(h.page.data.month, '2026-10')
  assert.equal(h.page.data.total, '25.30')
  assert.equal(h.page.data.categoryTotals[2].amount, '25.30')
  assert.equal(h.ledger().records.length, 1)
  assert.equal(h.ledger().records[0].revision, 2)
  assert.match(h.page.data.status, /已更新/)
  h.page.onMonth({ detail: { value: '2026-09' } })
  assert.equal(h.page.data.count, 0)
})

test('修改写入失败保留已保存版本和待修改草稿', () => {
  const h = harness(added())
  h.page.startEdit(event('op_1'))
  h.page.onField({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '20.00' } })
  h.page.previewDraft()
  h.control.failSave = true
  h.page.confirmPreview()
  assert.equal(h.ledger().records[0].cents, 3850)
  assert.equal(h.ledger().records[0].revision, 1)
  assert.equal(h.page.data.editId, 'op_1')
  assert.equal(h.page.data.preview.amount, '20.00')
})

test('草稿修改会使旧预览失效，不能直接确认旧金额', () => {
  const h = harness()
  h.setDraft()
  h.page.previewDraft()
  h.page.onField({ currentTarget: { dataset: { field: 'amount' } }, detail: { value: '1.25' } })
  h.page.confirmPreview()
  assert.equal(h.control.writes, 0)
  h.page.previewDraft()
  h.page.confirmPreview()
  assert.equal(h.ledger().records[0].cents, 125)
})

test('取消和切换草稿都先确认，取消确认不改变账本或草稿', () => {
  const h = harness(added())
  h.setDraft(draft({ amount: '9.99' }))
  h.page.cancelDraft()
  h.control.modals.pop().success({ confirm: false })
  assert.equal(h.page.data.draft.amount, '9.99')
  h.page.startEdit(event('op_1'))
  h.control.modals.pop().success({ confirm: false })
  assert.equal(h.page.data.draft.amount, '9.99')
  h.page.cancelDraft()
  h.control.modals.pop().success({ confirm: true })
  assert.equal(h.page.data.draft.amount, '')
  assert.equal(h.control.writes, 0)
  assert.equal(h.ledger().records.length, 1)
})

test('删除需要确认，取消不写入，确认后更新汇总，重复回调不重复保存', () => {
  const h = harness(added())
  h.page.requestDelete(event('op_1'))
  assert.equal(h.control.writes, 0)
  h.control.modals.pop().success({ confirm: false })
  assert.equal(h.ledger().records.length, 1)
  h.page.requestDelete(event('op_1'))
  const modal = h.control.modals.pop()
  assert.match(modal.content, /38.50/)
  modal.success({ confirm: true })
  modal.success({ confirm: true })
  assert.equal(h.ledger().records.length, 0)
  assert.equal(h.page.data.total, '0.00')
  assert.equal(h.control.writes, 1)
})

test('删除写入失败页面保留原记录和总额，不报成功', () => {
  const h = harness(added())
  h.control.failSave = true
  h.page.requestDelete(event('op_1'))
  h.control.modals.pop().success({ confirm: true })
  assert.equal(h.ledger().records.length, 1)
  assert.equal(h.page.data.rows.length, 1)
  assert.equal(h.page.data.total, '38.50')
  assert.equal(h.page.data.status, '')
  assert.match(h.page.data.error, /未能确认删除/)
})

test('读失败阻止保存；重新加载不清空草稿；损坏数据不覆盖', () => {
  const h = harness()
  h.setDraft()
  h.control.failLoad = true
  h.page.reloadLedger()
  assert.equal(h.page.data.ready, false)
  assert.equal(h.page.data.draft.amount, '38.50')
  h.page.previewDraft()
  h.page.confirmPreview()
  assert.equal(h.control.writes, 0)
  h.control.failLoad = false
  h.page.reloadLedger()
  assert.equal(h.page.data.ready, true)
  assert.equal(h.page.data.draft.amount, '38.50')
  const broken = harness({ version: 0, records: [] })
  assert.equal(broken.page.data.ready, false)
  assert.equal(broken.control.writes, 0)
})

test('保存前重新读最新账本，过期编辑不覆盖其他修改', () => {
  const h = harness(added())
  h.page.startEdit(event('op_1'))
  h.page.previewDraft()
  h.values['catai_cato_lab_v1:expenses:ledger'] = rules.upsertExpense(h.ledger(), draft({ amount: '7.00' }), 'external_edit', 'op_1', 1).ledger
  h.page.confirmPreview()
  assert.equal(h.ledger().records[0].cents, 700)
  assert.match(h.page.data.error, /已变化/)
  assert.ok(h.page.data.preview)
  assert.equal(h.control.writes, 0)
})

test('页面契约：共享样式、独立入口、自然换行、无外部或敏感信息接口', () => {
  const root = path.resolve(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'pages/cato-expenses/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-expenses/index.wxml'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-expenses/index.wxss'), 'utf8')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.ok(app.pages.includes('pages/cato-expenses/index'))
  assert.match(source, /createStore\('expenses'\)/)
  assert.match(css, /@import "\.\.\/\.\.\/styles\/cato-lab\.wxss"/)
  assert.match(css, /min-height: 88rpx/)
  assert.match(css, /word-break: break-word/)
  assert.match(css, /PingFang SC/)
  assert.doesNotMatch(source + wxml, /requestPayment|chooseImage|chooseMedia|uploadFile|wx\.cloud|wx\.request|readLocalCatCards|open-type="share"|<image/)
  assert.match(wxml, /本地实验/)
  assert.match(wxml, /不提供诊断、用药或治疗建议/)
  assert.equal(require('../config/cato-lab').variant, 'expenses')
})
