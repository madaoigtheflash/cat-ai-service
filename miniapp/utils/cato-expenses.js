'use strict'

// Pure ledger rules. Monetary arithmetic is always integer cents, never floats.
const MAX_CENTS = 99999999
const MAX_RECORDS = 1000
const CATEGORIES = [
  { value: 'food', label: '猫粮与零食' },
  { value: 'litter', label: '猫砂与清洁' },
  { value: 'medical', label: '医疗与护理' },
  { value: 'supplies', label: '用品与玩具' },
  { value: 'other', label: '其他支出' }
]

function fail(message) { throw new Error(message) }
function emptyLedger() { return { version: 1, records: [], applied: [] } }
function parseAmount(raw) {
  if (typeof raw !== 'string') fail('请以数字填写金额，最多两位小数。')
  const value = raw.trim()
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) fail('金额须为正数，最多两位小数，最高 999,999.99 元。')
  const parts = value.split('.')
  const cents = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2))
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) fail('金额须在 0.01 至 999,999.99 元之间。')
  return cents
}
function formatCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) fail('金额数据无效。')
  return Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0')
}
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1900 || year > 2100 || month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}
function localDate(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}
function emptyDraft(date) { return { amount: '', date, category: 'food', catName: '', note: '' } }
function textField(value, max, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.trim().length > max) fail(label + '最多 ' + max + ' 个字符。')
  return value.trim()
}
function categoryLabel(value) {
  const category = CATEGORIES.find(item => item.value === value)
  if (!category) fail('请选择有效的支出分类。')
  return category.label
}
function validateDraft(draft) {
  if (!draft || typeof draft !== 'object') fail('记账草稿无效。')
  if (!isValidDate(draft.date)) fail('请选择 1900–2100 年间真实存在的日期。')
  categoryLabel(draft.category)
  return {
    cents: parseAmount(draft.amount), date: draft.date, category: draft.category,
    catName: textField(draft.catName, 60, '猫咪名字'), note: textField(draft.note, 200, '备注')
  }
}
function validId(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) }
function validateLedger(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.records) || !Array.isArray(raw.applied) || raw.records.length > MAX_RECORDS) fail('本机账本格式异常，已停止写入，请先核对数据。')
  const ids = new Set()
  const records = raw.records.map(record => {
    if (!record || !validId(record.id) || ids.has(record.id) || !Number.isSafeInteger(record.cents) || record.cents < 1 || record.cents > MAX_CENTS || !Number.isSafeInteger(record.revision) || record.revision < 1) fail('本机账本记录异常，已停止写入。')
    ids.add(record.id)
    const fields = validateDraft({ ...record, amount: formatCents(record.cents) })
    return { id: record.id, ...fields, revision: record.revision }
  })
  if (raw.applied.some(id => !validId(id)) || new Set(raw.applied).size !== raw.applied.length) fail('本机账本确认记录异常，已停止写入。')
  return { version: 1, records, applied: raw.applied.slice() }
}
function upsertExpense(raw, draft, operationId, editId, expectedRevision) {
  const ledger = validateLedger(raw)
  if (!validId(operationId)) fail('确认标识无效，请返回修改后重新预览。')
  if (ledger.applied.includes(operationId)) return { ledger, changed: false }
  const fields = validateDraft(draft)
  let records
  if (editId) {
    const previous = ledger.records.find(record => record.id === editId)
    if (!previous || previous.revision !== expectedRevision) fail('这笔记录已变化或已删除，请重新打开修改。')
    if (previous.revision >= Number.MAX_SAFE_INTEGER) fail('记录版本已达上限，请重新建账。')
    records = ledger.records.map(record => record.id === editId ? { id: editId, ...fields, revision: previous.revision + 1 } : record)
  } else {
    if (ledger.records.length >= MAX_RECORDS) fail('本地实验最多保存 1,000 笔记录，请先整理后再记账。')
    if (ledger.records.some(record => record.id === operationId)) fail('记录标识重复，请重新预览。')
    records = ledger.records.concat({ id: operationId, ...fields, revision: 1 })
  }
  return { ledger: { version: 1, records, applied: ledger.applied.concat(operationId) }, changed: true }
}
function deleteExpense(raw, id, operationId, expectedRevision) {
  const ledger = validateLedger(raw)
  if (!validId(operationId)) fail('删除标识无效。')
  if (ledger.applied.includes(operationId)) return { ledger, changed: false }
  const previous = ledger.records.find(record => record.id === id)
  if (!previous || previous.revision !== expectedRevision) fail('这笔记录已变化或已删除，请重新加载后核对。')
  return { ledger: { version: 1, records: ledger.records.filter(record => record.id !== id), applied: ledger.applied.concat(operationId) }, changed: true }
}
function monthlySummary(raw, month) {
  if (typeof month !== 'string' || !isValidDate(month + '-01')) fail('请选择有效月份。')
  const records = validateLedger(raw).records.filter(record => record.date.slice(0, 7) === month)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
  const categories = CATEGORIES.map(category => ({ ...category, cents: 0, count: 0 }))
  let totalCents = 0
  records.forEach(record => {
    totalCents += record.cents
    const category = categories.find(item => item.value === record.category)
    category.cents += record.cents
    category.count += 1
  })
  return { totalCents, count: records.length, categories, records }
}
function draftFromRecord(record) {
  return { amount: formatCents(record.cents), date: record.date, category: record.category, catName: record.catName, note: record.note }
}

module.exports = { MAX_CENTS, MAX_RECORDS, CATEGORIES, emptyLedger, parseAmount, formatCents, isValidDate, localDate, emptyDraft, categoryLabel, validateDraft, validateLedger, upsertExpense, deleteExpense, monthlySummary, draftFromRecord }
