'use strict'

const LIMITS = { title: 60, story: 4000, catName: 60, share: 500 }
const ROOM = { id: 'simulated-cat-room', label: '午后猫窝（模拟小屋）' }
const count = value => Array.from(value).length
function text(value, label, max, optional) {
  if (typeof value !== 'string') throw new Error(label + '格式不正确')
  const cleaned = value.trim()
  if ((!optional && !cleaned) || count(cleaned) > max) throw new Error(label + (optional ? '最多' : '请填写 1–') + max + ' 字')
  return cleaned
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1900 || year > 2199) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
function validId(value) { return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,159}$/i.test(value) }
function privateFields(draft) {
  if (!draft || !validId(draft.id)) throw new Error('日记标识无效，请重新打开编辑器')
  if (!validDate(draft.date)) throw new Error('请选择 1900–2199 年内的有效日期')
  return { id: draft.id, date: draft.date, title: text(draft.title, '标题', LIMITS.title),
    story: text(draft.story, '正文', LIMITS.story), catName: text(draft.catName || '', '猫咪称呼', LIMITS.catName, true) }
}
function normalizeEntries(value) {
  if (!Array.isArray(value)) throw new Error('本地日记数据格式无效')
  const seen = new Set()
  return value.map(item => {
    const fields = privateFields(item)
    if (seen.has(fields.id) || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt) || item.createdAt < 0 || item.updatedAt < item.createdAt) throw new Error('本地日记数据需要检查')
    seen.add(fields.id)
    return { ...fields, createdAt: item.createdAt, updatedAt: item.updatedAt }
  })
}
function upsertEntry(entries, draft, now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('保存时间无效')
  const base = normalizeEntries(entries)
  const fields = privateFields(draft)
  const old = base.find(item => item.id === fields.id)
  if (old && ['date', 'title', 'story', 'catName'].every(key => old[key] === fields[key])) return base
  const saved = { ...fields, createdAt: old ? old.createdAt : now, updatedAt: Math.max(now, old ? old.updatedAt : now) }
  return old ? base.map(item => item.id === fields.id ? saved : item) : base.concat(saved)
}
function removeEntry(entries, id) {
  if (!validId(id)) throw new Error('日记标识无效')
  return normalizeEntries(entries).filter(item => item.id !== id)
}
function reviewEntries(entries, query, date) {
  const keyword = String(query || '').trim().toLocaleLowerCase()
  return entries.filter(item => (!date || item.date === date) && (!keyword || [item.title, item.story, item.catName].some(value => value.toLocaleLowerCase().includes(keyword))))
    .slice().sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}
function blankEntry(id, date) { return { id, date, title: '', story: '', catName: '' } }
function blankShare(sourceId) { return { sourceId, body: '', visibility: '', mode: 'manual', selectedExcerpt: '' } }
// Suggestions are always strictly shorter than the private story. No metadata or photo is copied.
function excerptsFor(story) {
  const full = story.trim()
  const units = full.match(/[^。！？!?\n]+[。！？!?]?/g) || []
  const output = []
  units.forEach(unit => {
    const chars = Array.from(unit.trim())
    const size = Math.min(80, Math.max(1, Math.ceil(count(full) / 2)))
    for (let i = 0; i < chars.length && output.length < 6; i += size) {
      const excerpt = chars.slice(i, i + size).join('').trim()
      if (excerpt && excerpt !== full && !output.some(item => item.text === excerpt)) output.push({ index: output.length, text: excerpt })
    }
  })
  return output
}
function selectExcerpt(share, source, index) {
  if (!source || share.sourceId !== source.id) throw new Error('来源已变化，请重新选择日记')
  const selected = excerptsFor(source.story).find(item => item.index === index)
  if (!selected) throw new Error('请选择有效片段，或手动改写')
  return { ...blankShare(source.id), body: selected.text, mode: 'excerpt', selectedExcerpt: selected.text }
}
function sharePreview(share, source) {
  if (!share || !source || share.sourceId !== source.id) throw new Error('来源已变化，请重新选择日记')
  if (!['public', 'room'].includes(share.visibility)) throw new Error('请明确选择公开预览或模拟小屋预览')
  const body = text(share.body, '分享文字', LIMITS.share)
  // Only this allowlist may reach the public/room preview. Never spread private source fields.
  return { text: body, audience: share.visibility === 'public' ? { type: 'public', label: '公开（仅预览）' } : { type: 'room', id: ROOM.id, label: ROOM.label }, simulation: true, published: false }
}

module.exports = { LIMITS, ROOM, count, validDate, privateFields, normalizeEntries, upsertEntry, removeEntry, reviewEntries, blankEntry, blankShare, excerptsFor, selectExcerpt, sharePreview }
