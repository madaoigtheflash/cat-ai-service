'use strict'

// Deliberately deterministic text rules, not an ASR/OCR/LLM adapter.
const MAX_INPUT = 3000
const MAX_DRAFTS = 20
const MAX_ITEMS = 500
const SOURCES = {
  text: '手动文字',
  'voice-sample': '合成语音文字示例',
  'image-sample': '合成图片文字示例'
}
const SAMPLES = {
  'voice-sample': '明天早上给猫咪换水；周末清洗食盆；有空整理猫玩具',
  'image-sample': '照护便签：今晚检查饮水碗\n下周给猫抓板除尘\n买一袋猫砂'
}
const clone = value => JSON.parse(JSON.stringify(value))
const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
const isSource = value => Object.prototype.hasOwnProperty.call(SOURCES, value)

function emptyState() { return { version: 1, items: [], committedBatches: [] } }

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 2000 || year > 2100) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

function titleValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('每条事项都需要填写内容。')
  if (value.trim().length > 180) throw new Error('每条事项最多 180 字，请拆成更短的事项。')
  return value.trim()
}

function timeHint(text) {
  // A hint is never promoted into a scheduled timestamp. Even explicit dates need review.
  const match = text.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[:：点时]\d{0,2}分?|今天|明天|后天|今晚|明早|周末|下周|本周|星期[一二三四五六日天]|周[一二三四五六日天]|早上|上午|中午|下午|晚上|稍后|有空|过几天|每天|每周|每月/)
  return match ? '原文含「' + match[0] + '」，请人工核对，未自动安排。' : '没有可靠的时间，请选择日期时间，或明确先不设时间。'
}

function parseDrafts(text, batchId, source = 'text') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('请先写下至少一条照护事项。')
  if (text.length > MAX_INPUT) throw new Error('一次最多输入 3000 字，请分批整理。')
  if (!isId(batchId) || !isSource(source)) throw new Error('草稿来源无效，请重新整理。')
  const lines = text.split(/[\n\r；;。]+/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error('请填写事项内容，不能只有分隔符。')
  if (lines.length > MAX_DRAFTS) throw new Error('一次最多整理 20 条，请分批录入。')
  return {
    id: batchId,
    source,
    drafts: lines.map((line, index) => ({
      id: batchId + '_' + index,
      title: titleValue(line),
      originalText: line,
      source,
      timeHint: timeHint(line),
      timeMode: 'review',
      date: '',
      time: ''
    }))
  }
}

function updateDraft(batch, id, patch) {
  if (!batch || !Array.isArray(batch.drafts)) throw new Error('没有待编辑草稿。')
  if (!batch.drafts.some(draft => draft.id === id)) throw new Error('草稿不存在，请重新检查。')
  const allowed = ['title', 'timeMode', 'date', 'time']
  const safePatch = {}
  Object.keys(patch).forEach(key => { if (allowed.includes(key)) safePatch[key] = patch[key] })
  if (safePatch.timeMode && !['review', 'scheduled', 'unscheduled'].includes(safePatch.timeMode)) throw new Error('时间选择无效。')
  if (safePatch.timeMode === 'unscheduled') Object.assign(safePatch, { date: '', time: '' })
  return { ...batch, drafts: batch.drafts.map(draft => draft.id === id ? { ...draft, ...safePatch } : { ...draft }) }
}

function validateDraft(draft) {
  if (!draft || !isId(draft.id) || !isSource(draft.source)) throw new Error('草稿格式无效，请重新整理。')
  titleValue(draft.title)
  if (typeof draft.originalText !== 'string' || !draft.originalText.trim() || draft.originalText.length > 180) throw new Error('草稿原文无效。')
  if (draft.timeMode === 'review') throw new Error('还有时间待核对：请选择日期和时间，或点「先不设时间」。')
  if (draft.timeMode === 'unscheduled') {
    if (draft.date || draft.time) throw new Error('不设时间的事项不能保留日期时间。')
  } else if (draft.timeMode === 'scheduled') {
    if (!validDate(draft.date) || !validTime(draft.time)) throw new Error('请补全有效的日期和时间（2000–2100 年）。')
  } else throw new Error('请选择事项时间。')
}

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.items) || !Array.isArray(state.committedBatches)) throw new Error('本机收件箱格式异常，未覆盖原记录。请先返回审计入口处理本实验数据。')
  const ids = new Set()
  const batches = new Set()
  state.committedBatches.forEach(id => {
    if (!isId(id) || batches.has(id)) throw new Error('本机批次回执异常，未覆盖原记录。')
    batches.add(id)
  })
  state.items.forEach(item => {
    validateDraft(item)
    if (ids.has(item.id) || !isId(item.batchId) || !batches.has(item.batchId) || typeof item.done !== 'boolean' || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('本机事项格式异常，未覆盖原记录。')
    ids.add(item.id)
  })
  return clone(state)
}

function confirmBatch(state, batch, now) {
  const next = validateState(state)
  if (!batch || !isId(batch.id)) throw new Error('没有待确认的草稿。')
  // Receipt is retained even after an item is removed, so retries cannot resurrect it.
  if (next.committedBatches.includes(batch.id)) return { state: next, added: 0, alreadyCommitted: true }
  if (!isSource(batch.source) || !Array.isArray(batch.drafts) || !batch.drafts.length || batch.drafts.length > MAX_DRAFTS) throw new Error('请保留 1–20 条有效草稿后确认。')
  const ids = new Set(next.items.map(item => item.id))
  batch.drafts.forEach(draft => {
    validateDraft(draft)
    if (draft.source !== batch.source || !draft.id.startsWith(batch.id + '_') || ids.has(draft.id)) throw new Error('草稿重复或来源不一致，请重新整理。')
    ids.add(draft.id)
  })
  if (next.items.length + batch.drafts.length > MAX_ITEMS) throw new Error('本地收件箱最多保存 500 条，请先删除不需要的事项。草稿仍保留。')
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw new Error('本机时间无效，暂未保存。')
  const items = batch.drafts.map(draft => ({
    id: draft.id,
    batchId: batch.id,
    title: titleValue(draft.title),
    originalText: draft.originalText,
    source: draft.source,
    timeMode: draft.timeMode,
    date: draft.date,
    time: draft.time,
    createdAt: now,
    done: false
  }))
  next.items = items.concat(next.items)
  next.committedBatches.push(batch.id)
  return { state: next, added: items.length, alreadyCommitted: false }
}

function changeItem(state, id, action) {
  const next = validateState(state)
  if (!next.items.some(item => item.id === id)) throw new Error('事项已不存在，请重新读取收件箱。')
  if (action === 'remove') next.items = next.items.filter(item => item.id !== id)
  else if (action === 'toggle') next.items = next.items.map(item => item.id === id ? { ...item, done: !item.done } : item)
  else throw new Error('不支持的事项操作。')
  return next
}

function presentItems(state) {
  return state.items.map(item => ({ ...item, sourceLabel: SOURCES[item.source], timeLabel: item.timeMode === 'scheduled' ? item.date + ' ' + item.time + '（手动选择）' : '先不设时间' }))
}

module.exports = { MAX_INPUT, MAX_DRAFTS, MAX_ITEMS, SOURCES, SAMPLES, emptyState, validDate, validTime, timeHint, parseDrafts, updateDraft, validateDraft, validateState, confirmBatch, changeItem, presentItems }
