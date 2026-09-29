'use strict'

const { createStore, uid } = require('../../services/cato-lab')
const domain = require('../../utils/cato-encounter-review')
function localNow() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function dateParts(value) { const parts = (value || '').split('T'); return { date: parts[0] || '', time: parts[1] || '' } }
function displayTime(value) { return value ? value.replace('T', ' ') : '' }
function catName(id) { const card = domain.CANDIDATES.find(item => item.id === id); return card ? '模拟猫 · ' + card.name : '未选择' }
function viewRecord(record, now) {
  return { ...record, candidateName: catName(record.candidateId), linkedName: catName(record.linkedCardId), conclusionText: domain.CONCLUSIONS[record.conclusion],
    observedText: displayTime(record.observedAt), revisitText: displayTime(record.revisitAt), completedText: displayTime(record.completedAt),
    status: record.completedAt ? '已完成回访' : record.revisitAt <= now ? '到了约定时间' : '等待回访',
    evidence: record.evidence.map(item => ({ ...item, timeText: displayTime(item.at) })),
    canLink: !record.linkedCardId && record.conclusion === 'possible_same' && record.evidence.length > 0 }
}
Page({
  data: {
    ready: false, busy: false, error: '', feedback: '', role: 'observer', roles: ['本机记录者 · 可编辑', '模拟旁观者 · 只读'], roleIndex: 0,
    rows: [], pendingCount: 0, selected: null, selectedId: '', form: null, evidenceForm: null, reviewForm: null,
    candidates: domain.CANDIDATES, candidateNames: ['请选择合成候选'].concat(domain.CANDIDATES.map(item => '合成示例 · ' + item.name)),
    conclusionNames: ['证据不足', '可能同一只', '不同'], today: localNow().slice(0, 10)
  },
  onLoad() { this.repository = domain.createRepository(createStore('encounter-review')); this.reload() },
  onShow() { if (this.state) this.render(this.state) },
  reload() {
    if (this.data.busy) return
    try {
      const state = this.repository.load()
      this.render(state)
      this.setData({ ready: true, error: '', feedback: '已读取本机记录。未保存的表单会保留；如版本已变化，请取消后重新打开。' })
    } catch (error) { this.setData({ ready: false, error: '读取失败，已暂停写入，未清空原记录。' + error.message, feedback: '' }) }
  },
  render(state, done) {
    this.state = state
    const rows = state.encounters.map(item => viewRecord(item, localNow()))
    this.setData({ rows, pendingCount: rows.filter(item => !item.completedAt).length, selected: rows.find(item => item.id === this.data.selectedId) || null }, done)
  },
  scrollTo(selector) { if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ selector, duration: 0 }) },
  changeRole(event) {
    if (this.data.busy) return
    const index = Number(event.detail.value)
    this.setData({ roleIndex: index, role: index === 0 ? 'observer' : 'viewer', feedback: '', error: '' })
  },
  writable() {
    if (this.data.busy) return false
    if (!this.data.ready || this.data.role !== 'observer') { this.setData({ error: this.data.ready ? '当前为只读体验，请切换为本机记录者。' : '请先成功重新载入，避免覆盖原记录。' }); return false }
    return true
  },
  openNew() {
    if (!this.writable()) return
    const now = dateParts(localNow())
    this.setData({ form: { id: uid('sighting'), isNew: true, expectedRevision: this.state.revision, expectedVersion: 0, area: '', note: '', observedDate: now.date, observedTime: now.time, revisitDate: '', revisitTime: '' }, evidenceForm: null, reviewForm: null, selectedId: '', selected: null, error: '', feedback: '' }, () => this.scrollTo('#observation-editor'))
  },
  openEdit() {
    if (!this.writable() || !this.data.selected) return
    const record = this.data.selected
    const seen = dateParts(record.observedAt); const revisit = dateParts(record.revisitAt)
    this.setData({ form: { id: record.id, isNew: false, expectedRevision: this.state.revision, expectedVersion: record.version, area: record.area, note: record.note, observedDate: seen.date, observedTime: seen.time, revisitDate: revisit.date, revisitTime: revisit.time }, evidenceForm: null, reviewForm: null, error: '', feedback: '' }, () => this.scrollTo('#observation-editor'))
  },
  chooseRecord(event) {
    if (this.data.form || this.data.evidenceForm || this.data.reviewForm) { this.setData({ error: '请先保存或取消当前表单，再查看另一条记录。' }); return }
    this.setData({ selectedId: event.currentTarget.dataset.id, error: '', feedback: '' }); this.render(this.state, () => this.scrollTo('#encounter-detail'))
  },
  inputField(event) {
    const { form, field } = event.currentTarget.dataset
    const fields = { form: ['area', 'note', 'observedDate', 'observedTime', 'revisitDate', 'revisitTime'], evidenceForm: ['date', 'time', 'note'], reviewForm: ['candidateIndex', 'conclusionIndex', 'reason'] }
    if (!this.data[form] || !fields[form] || !fields[form].includes(field) || this.data.busy) return
    this.setData({ [`${form}.${field}`]: event.detail.value })
  },
  cancelForm() { if (!this.data.busy) this.setData({ form: null, evidenceForm: null, reviewForm: null, error: '', feedback: '已取消，未保存任何更改。' }) },
  saveObservation() {
    const form = this.data.form
    if (!form || !this.writable()) return
    this.perform(form.isNew ? 'create' : 'edit', { area: form.area.trim(), note: form.note.trim(), observedAt: form.observedDate + 'T' + form.observedTime, revisitAt: form.revisitDate + 'T' + form.revisitTime }, form, '目击与回访时间已保存在本机。', 'form')
  },
  openEvidence() {
    if (!this.writable() || !this.data.selected) return
    const now = dateParts(localNow()); const record = this.data.selected
    this.setData({ evidenceForm: { id: record.id, evidenceId: uid('evidence'), expectedRevision: this.state.revision, expectedVersion: record.version, date: now.date, time: now.time, note: '' }, reviewForm: null, form: null, error: '', feedback: '' })
  },
  saveEvidence() {
    const form = this.data.evidenceForm
    if (form) this.perform('evidence', { id: form.evidenceId, at: form.date + 'T' + form.time, note: form.note.trim() }, form, '证据笔记已保存；它不会自动改变同猫判断。', 'evidenceForm')
  },
  openReview() {
    if (!this.writable() || !this.data.selected) return
    const record = this.data.selected
    this.setData({ reviewForm: { id: record.id, expectedRevision: this.state.revision, expectedVersion: record.version, candidateIndex: record.candidateId ? domain.CANDIDATES.findIndex(item => item.id === record.candidateId) + 1 : 0, conclusionIndex: ['insufficient', 'possible_same', 'different'].indexOf(record.conclusion), reason: record.reason }, evidenceForm: null, form: null, error: '', feedback: '' })
  },
  saveReview() {
    const form = this.data.reviewForm
    if (!form) return
    const candidate = domain.CANDIDATES[Number(form.candidateIndex) - 1]
    if (!candidate) { this.setData({ error: '请主动选择一张合成示例猫名片。' }); return }
    this.perform('review', { candidateId: candidate.id, conclusion: ['insufficient', 'possible_same', 'different'][Number(form.conclusionIndex)], reason: form.reason.trim() }, form, '人工判断已保存，仍然只是你的假设。', 'reviewForm')
  },
  recordAction(event) {
    if (!this.writable() || !this.data.selected) return
    const type = event.currentTarget.dataset.action
    const record = this.data.selected
    const source = { id: record.id, expectedRevision: this.state.revision, expectedVersion: record.version }
    if (type === 'link') {
      this.setData({ busy: true })
      wx.showModal({ title: '关联这张模拟名片？', content: `将目击 ${record.id} 关联到${record.candidateName}。这只保存人工“可能同一只”的本机假设，不合并真实档案，可随时撤销。`,
        success: result => { this.setData({ busy: false }); if (result.confirm) this.perform('link', { candidateId: record.candidateId }, source, '模拟名片已关联。身份仍未确认，可随时撤销。') },
        fail: () => this.setData({ busy: false, error: '确认窗口未打开，没有关联名片。' }) })
      return
    }
    const messages = { unlink: '已撤销名片关联；证据与人工判断仍保留。', complete: '回访已记为完成，之后仍可撤销。', reopen: '已撤销完成，回到本机待回访清单。' }
    if (messages[type]) this.perform(type, {}, source, messages[type])
  },
  perform(type, input, source, feedback, closeForm) {
    if (!this.writable()) return
    this.setData({ busy: true, error: '', feedback: '' })
    try {
      const command = { type, input, encounterId: source.id, expectedRevision: source.expectedRevision, expectedVersion: source.expectedVersion, operationId: uid('operation'), actor: { id: domain.OWNER, role: this.data.role } }
      const state = this.repository.commit(command, localNow())
      const update = { busy: false, selectedId: source.id, feedback }
      if (closeForm) update[closeForm] = null
      this.setData(update); this.render(state)
    } catch (error) { this.setData({ busy: false, ready: this.repository.isReady(), error: error.message + (this.data.form || this.data.evidenceForm || this.data.reviewForm ? '（表单未丢弃）' : '') }, () => this.scrollTo('#page-feedback')) }
  }
})
