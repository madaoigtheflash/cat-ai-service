'use strict'

const { createStore, uid } = require('../../services/cato-lab')
const domain = require('../../utils/cato-relationship-observe')
const choices = domain.CHOICES

Page({
  data: {
    cats: domain.CATS, kinds: domain.KINDS, observers: domain.OBSERVERS, choices,
    ready: false, pending: false, busy: false, error: '', notice: '', plans: [], selected: null,
    createOpen: true, fromIndex: 0, toIndex: 1, kindIndex: 0,
    createDate: '', createTime: '', createChecklist: domain.KINDS[0].checklist,
    editOpen: false, editDate: '', editTime: '', editChecklist: '',
    evidenceDate: '', evidenceTime: '', evidenceNote: '',
    observerIndex: 0, voteIndex: 1, selectedEvidenceIds: [], voteCards: [], stats: null,
    activeEvidence: [], allEvidence: [], reversePlan: null
  },
  onLoad() {
    this._store = createStore('relationship-observe')
    this._drafts = {}
    this.loadState()
  },
  loadState() {
    try {
      const state = this._store.load('state', domain.initialState())
      domain.validateState(state)
      this._state = state
      this.setData({ ready: true, error: '', notice: '' })
      this.renderState()
    } catch (error) {
      this.setData({ ready: false, error: '本机记录读取失败，暂未开放保存；输入仍保留。' + (error.code ? error.message : '请重试读取，不会用空记录覆盖。') })
    }
  },
  rememberDraft() {
    if (!this.data.selected) return
    this._drafts[this.data.selected.id] = {
      evidenceDate: this.data.evidenceDate, evidenceTime: this.data.evidenceTime, evidenceNote: this.data.evidenceNote,
      selectedEvidenceIds: this.data.selectedEvidenceIds.slice(), editOpen: this.data.editOpen,
      editDate: this.data.editDate, editTime: this.data.editTime, editChecklist: this.data.editChecklist
    }
  },
  renderState(preferredId) {
    const plans = this._state.plans.map(domain.describePlan)
    const id = preferredId || (this.data.selected && this.data.selected.id)
    const selected = id ? plans.find(item => item.id === id) || null : plans[0] || null
    const allEvidence = selected ? selected.evidence.slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt)).map(item => ({ ...item, timeLabel: item.observedAt.replace('T', ' ') })) : []
    const selectedIds = this.data.selectedEvidenceIds
    const activeEvidence = allEvidence.filter(item => item.active).map(item => ({ ...item, checked: selectedIds.includes(item.id) }))
    const voteCards = selected ? domain.OBSERVERS.map(observer => {
      const vote = selected.votes.find(item => item.observerId === observer.id)
      return { ...observer, voted: Boolean(vote), choiceName: vote ? choices.find(item => item.id === vote.choice).name : '本方向未投票', evidenceCount: vote ? vote.evidenceIds.length : 0 }
    }) : []
    this.setData({
      plans, selected, allEvidence, activeEvidence, voteCards,
      selectedEvidenceIds: selectedIds.filter(id => activeEvidence.some(item => item.id === id)),
      stats: selected ? domain.distribution(this._state, selected.id) : null,
      reversePlan: selected ? plans.find(item => item.id === domain.directionId(selected.toId, selected.fromId)) || null : null
    })
  },
  changeField(event) {
    if (this.data.pending) return
    const field = event.currentTarget.dataset.field
    if (!['createDate', 'createTime', 'createChecklist', 'editDate', 'editTime', 'editChecklist', 'evidenceDate', 'evidenceTime', 'evidenceNote'].includes(field)) return
    this.setData({ [field]: event.detail.value, notice: '' })
  },
  changeCat(event) {
    if (this.data.pending) return
    const field = event.currentTarget.dataset.field
    if (!['fromIndex', 'toIndex'].includes(field)) return
    const index = Number(event.detail.value)
    if (!domain.CATS[index]) return
    this.setData({ [field]: index, error: '', notice: '' })
  },
  changeKind(event) {
    if (this.data.pending) return
    const kindIndex = Number(event.detail.value)
    if (!domain.KINDS[kindIndex]) return
    const useDefault = !this.data.createChecklist || this.data.createChecklist === domain.KINDS[this.data.kindIndex].checklist
    this.setData({ kindIndex, ...(useDefault ? { createChecklist: domain.KINDS[kindIndex].checklist } : {}) })
  },
  toggleCreate() {
    if (this.data.pending) return
    this.setData({ createOpen: !this.data.createOpen, error: '', notice: '' })
  },
  createPlan() {
    const kind = domain.KINDS[this.data.kindIndex]
    const from = domain.CATS[this.data.fromIndex]
    const to = domain.CATS[this.data.toIndex]
    this.submit({ type: 'create', fromId: from.id, toId: to.id, kindId: kind.id, fromRole: kind.fromRole, toRole: kind.toRole,
      observeAt: this.data.createDate + 'T' + this.data.createTime, checklist: this.data.createChecklist }, 'create')
  },
  selectPlan(event) {
    if (this.data.pending) return
    const id = event.currentTarget.dataset.id
    if (!this._state.plans.some(item => item.id === id)) return
    this.rememberDraft()
    const draft = this._drafts[id] || { evidenceDate: '', evidenceTime: '', evidenceNote: '', selectedEvidenceIds: [], editOpen: false, editDate: '', editTime: '', editChecklist: '' }
    this.setData({ ...draft, error: '', notice: '' })
    this.renderState(id)
  },
  openReverse() {
    if (this.data.pending || !this.data.selected) return
    if (this.data.reversePlan) return this.selectPlan({ currentTarget: { dataset: { id: this.data.reversePlan.id } } })
    const selected = this.data.selected
    // No inverse role or evidence is copied: this is a new, unsubmitted hypothesis.
    this.setData({ createOpen: true, fromIndex: domain.CATS.findIndex(item => item.id === selected.toId), toIndex: domain.CATS.findIndex(item => item.id === selected.fromId), notice: '已交换两只合成猫。请独立选择反向假设与时间；未复制任何证据或投票。' })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
  startEdit() {
    if (this.data.pending || !this.data.selected) return
    const plan = this.data.selected
    const hasDraft = Boolean(this.data.editDate || this.data.editTime || this.data.editChecklist)
    this.setData({ editOpen: true, ...(hasDraft ? {} : { editDate: plan.observeAt.slice(0, 10), editTime: plan.observeAt.slice(11), editChecklist: plan.checklist }), error: '', notice: '' })
  },
  cancelEdit() { if (!this.data.pending) this.setData({ editOpen: false, notice: '已取消编辑，没有更改已保存计划。草稿留在本页。' }) },
  saveEdit() {
    this.submit({ type: 'edit', planId: this.data.selected.id, observeAt: this.data.editDate + 'T' + this.data.editTime, checklist: this.data.editChecklist }, 'edit')
  },
  addEvidence() {
    this.submit({ type: 'addEvidence', planId: this.data.selected.id, evidenceId: uid('evidence'), observedAt: this.data.evidenceDate + 'T' + this.data.evidenceTime, note: this.data.evidenceNote }, 'evidence')
  },
  confirmAction(options, action) {
    if (!this.data.ready || this.data.pending || this.data.busy) return
    wx.showModal({ ...options, success: result => {
      if (result.confirm) action()
      else this.setData({ notice: '已取消，没有修改记录或清空输入。' })
    }, fail: () => this.setData({ error: '确认窗口未能打开，未执行操作；输入仍保留。' }) })
  },
  withdrawEvidence(event) {
    const planId = this.data.selected.id
    const evidenceId = event.currentTarget.dataset.id
    this.confirmAction({ title: '撤回这条证据？', content: '引用它的模拟投票会一并撤回。若没有其他有效证据，计划会恢复为记录中。笔记保留并标记已撤回。' }, () => this.submit({ type: 'withdrawEvidence', planId, evidenceId }, 'withdrawEvidence'))
  },
  changeObserver(event) {
    if (this.data.pending) return
    const index = Number(event.detail.value)
    if (domain.OBSERVERS[index]) this.setData({ observerIndex: index, notice: '' })
  },
  changeVote(event) {
    if (this.data.pending) return
    const index = Number(event.detail.value)
    if (choices[index]) this.setData({ voteIndex: index, notice: '' })
  },
  selectEvidence(event) {
    if (this.data.pending) return
    this.setData({ selectedEvidenceIds: event.detail.value })
    this.renderState()
  },
  vote() {
    this.submit({ type: 'vote', planId: this.data.selected.id, observerId: domain.OBSERVERS[this.data.observerIndex].id, choice: choices[this.data.voteIndex].id, evidenceIds: this.data.selectedEvidenceIds.slice() }, 'vote')
  },
  withdrawVote(event) {
    const planId = this.data.selected.id
    const observerId = event.currentTarget.dataset.id
    this.confirmAction({ title: '撤回这位模拟观察者的票？', content: '只撤回当前方向的这一票，另一位观察者和反向记录不受影响。' }, () => this.submit({ type: 'withdrawVote', planId, observerId }, 'withdrawVote'))
  },
  toggleStatus() {
    const plan = this.data.selected
    const status = plan.status === 'completed' ? 'active' : 'completed'
    this.confirmAction({ title: status === 'completed' ? '完成本次记录？' : '撤销完成？', content: status === 'completed' ? '完成只是结束这次记录，不确认关系事实。完成后可撤销，再继续补充。' : '恢复后可以编辑清单、补记证据和改票。已有记录保留。' }, () => this.submit({ type: 'setStatus', planId: plan.id, status }, 'status'))
  },
  submit(payload, effect) {
    if (!this.data.ready || this.data.pending || this.data.busy) return
    this._pending = { command: { ...payload, opId: uid('operation'), expectedVersion: this._state.version }, effect }
    this.executePending()
  },
  retryPending() { if (this._pending && !this.data.busy) this.executePending() },
  executePending() {
    const pending = this._pending
    if (!pending) return
    this.setData({ busy: true, error: '', notice: '' })
    let latest
    let stage = 'read'
    try {
      latest = this._store.load('state', domain.initialState())
      domain.validateState(latest)
      stage = 'apply'
      const result = domain.applyCommand(latest, pending.command)
      stage = 'write'
      if (!result.replayed) this._store.save('state', result.state)
      stage = 'verify'
      const verified = this._store.load('state', domain.initialState())
      domain.validateState(verified)
      if (JSON.stringify(verified) !== JSON.stringify(result.state)) throw new Error('保存后核对不一致')
      this._state = verified
      this._pending = null
      const selectedId = pending.command.type === 'create' ? domain.directionId(pending.command.fromId, pending.command.toId) : pending.command.planId
      const changes = { busy: false, pending: false, ready: true, notice: result.replayed ? '已核对：这次操作此前已保存，未重复提交。' : '已保存到本机实验空间。' }
      if (pending.effect === 'create') {
        this.rememberDraft()
        Object.assign(changes, { createOpen: false, createDate: '', createTime: '', evidenceDate: '', evidenceTime: '', evidenceNote: '', selectedEvidenceIds: [], editOpen: false, editDate: '', editTime: '', editChecklist: '' })
      }
      if (pending.effect === 'edit') changes.editOpen = false
      if (pending.effect === 'evidence') Object.assign(changes, { evidenceNote: '', evidenceDate: '', evidenceTime: '' })
      this.setData(changes)
      this.renderState(selectedId)
    } catch (error) {
      if (stage === 'apply') {
        this._pending = null
        if (error.code === 'VERSION_CONFLICT') { this.rememberDraft(); this._state = latest; this.renderState() }
        this.setData({ busy: false, pending: false, error: error.message })
      } else {
        // A driver can throw after writing; retain the exact command for idempotent recovery.
        this.setData({ busy: false, pending: true, ready: stage !== 'read', error: (stage === 'read' ? '本机记录读取失败。' : '保存尚未确认，可能已写入本机。') + '输入与这次操作已保留；请重试核对，确认前不会重复提交或开放其他修改。' })
      }
    }
  }
})
