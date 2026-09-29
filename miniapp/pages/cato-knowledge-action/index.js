'use strict'

const { createStore } = require('../../services/cato-lab')
const flow = require('../../utils/cato-knowledge-action')
const ACTION_LABELS = { draft: '行动草稿 · 尚未确认', ready: '已确认 · 等你自己完成', done: '已完成 · 用户自行标记', cancelled: '已取消 · 没有待执行行动' }
const FEEDBACK_LABELS = { draft: '本地草稿 · 未进入模拟队列', queued: '模拟队列 · 等待你点击审计', audited: '模拟报告 · 等待人工决定', decided: '人工决定已保存 · 仅本地模拟' }

Page({
  data: { state: flow.freshState(), sources: flow.sources(), source: null, actionInput: '', feedbackInput: '', decisionNote: '',
    acknowledged: false, actionDirty: false, feedbackDirty: false, actionLabel: '', feedbackLabel: '',
    storageBlocked: false, busy: false, failNext: false, showHistory: false, error: '', notice: '' },
  onLoad() { this.store = createStore('knowledge-action'); this.loadSession() },
  loadSession() {
    try {
      const state = flow.validateState(this.store.load('session', flow.freshState()))
      this.paint(state)
      this.setData({ storageBlocked: false, error: '', notice: '已读取本机实验草稿。没有读取原档案或照片。' })
    } catch (error) {
      this.setData({ storageBlocked: true, error: '读取未完成：' + (error.message || '本地存储暂不可用') + ' 请重试；数据未被覆盖。' })
    }
  },
  paint(state) {
    this.setData({ state, source: flow.sources().find(item => item.id === state.sourceId) || null,
      actionInput: state.action.text, feedbackInput: state.feedback.raw, decisionNote: state.decision ? state.decision.note : '',
      acknowledged: state.action.acknowledged, actionDirty: false, feedbackDirty: false,
      actionLabel: ACTION_LABELS[state.action.status], feedbackLabel: FEEDBACK_LABELS[state.feedback.status] })
  },
  commit(event, notice) {
    if (this.data.storageBlocked || this.data.busy) return false
    this.setData({ busy: true, error: '', notice: '' })
    try {
      if (this.data.failNext) { this.setData({ failNext: false }); throw new Error('本次为主动触发的模拟保存失败') }
      const next = flow.persistTransition(this.store, this.data.state, event)
      this.paint(next)
      this.setData({ notice })
      return true
    } catch (error) {
      this.setData({ error: (error.message || '保存失败') + '；没有把这次操作记为成功。输入仍在当前页，可重试同一按钮。' })
      return false
    } finally { this.setData({ busy: false }) }
  },
  confirm(title, content, callback) {
    wx.showModal({ title, content, confirmText: '确认', cancelText: '返回', success: result => { if (result.confirm) callback() },
      fail: () => this.setData({ error: '确认窗口未打开；没有变更状态，可重试。' }) })
  },
  selectSource(event) { this.commit({ type: 'select-source', sourceId: event.currentTarget.dataset.id }, '已选择既有知识，尚未创建行动。') },
  onActionInput(event) { this.setData({ actionInput: event.detail.value, actionDirty: event.detail.value !== this.data.state.action.text, acknowledged: false, notice: '' }) },
  toggleAcknowledged() { this.setData({ acknowledged: !this.data.acknowledged }) },
  saveAction() { this.commit({ type: 'save-action', text: this.data.actionInput }, '行动草稿已保存到本机，尚未确认。') },
  confirmAction() {
    if (this.data.actionDirty) { this.setData({ error: '请先保存当前行动草稿，再主动确认。' }); return }
    this.commit({ type: 'confirm-action', acknowledged: this.data.acknowledged }, '小行动已由你确认；不会自动执行、提醒或安排日程。')
  },
  complete() { this.commit({ type: 'complete' }, '已按你的操作标记完成，现在可以写反馈。') },
  feedbackSaved() {
    if (!this.data.feedbackDirty) return true
    this.setData({ error: '请先保存当前反馈输入，再更改行动状态；这样不会丢掉未保存的原文。' })
    return false
  },
  undoComplete() {
    if (!this.feedbackSaved()) return
    this.confirm('撤销完成？', '保留反馈原文，退回草稿；本版模拟报告与人工决定将失效。', () => this.commit({ type: 'undo-complete' }, '完成状态已撤销；反馈保留为草稿。'))
  },
  cancelAction() {
    if (!this.feedbackSaved()) return
    this.confirm('取消这个行动？', '不会处罚或催促你。反馈原文保留，模拟队列、报告与决定会失效。', () => this.commit({ type: 'cancel-action' }, '行动已取消；没有任何后台执行。'))
  },
  editAction() {
    if (!this.feedbackSaved()) return
    this.confirm('重新编辑行动？', '反馈原文保留，但模拟队列、报告和人工决定会失效；需要重新确认与完成。', () => this.commit({ type: 'edit-action' }, '行动回到草稿。请重新核对低风险边界。'))
  },
  onFeedbackInput(event) {
    const raw = event.detail.value
    const changed = raw !== this.data.state.feedback.raw
    // Invalidate a previously reviewed version as soon as editing begins.
    // Keep the new unsaved input even if this local invalidation write fails.
    if (changed && this.data.state.feedback.status !== 'draft') {
      this.commit({ type: 'withdraw-feedback' }, '开始修改反馈，旧模拟报告与决定已失效。')
    }
    this.setData({ feedbackInput: raw, feedbackDirty: changed || this.data.feedbackDirty, notice: '' })
  },
  saveFeedback() {
    const history = this.data.state.feedback.history
    const changedContext = history.length && history[history.length - 1].actionRevision !== this.data.state.action.revision
    this.commit({ type: 'save-feedback', raw: this.data.feedbackInput, revised: this.data.feedbackDirty },
      this.data.feedbackDirty || changedContext ? '反馈原文与新版本已保存；本版是本地草稿，旧报告和决定已失效。' : '反馈已保存；未改变的原文不重复创建版本。')
  },
  submitFeedback() {
    if (this.data.feedbackDirty) { this.setData({ error: '请先保存修改后的反馈，旧报告不能用于新原文。' }); return }
    this.confirm('加入本地模拟队列？', '仅提交已保存的第 ' + this.data.state.feedback.version + ' 版原文到本机模拟队列。不会联网、发送开发者或对外执行。',
      () => this.commit({ type: 'submit-feedback', confirmed: true }, '已进入本地模拟队列。尚未进行模板化审计。'))
  },
  withdrawFeedback() {
    this.confirm('撤回本地模拟队列？', '保留反馈原文；当前模拟报告与人工决定失效。', () => this.commit({ type: 'withdraw-feedback' }, '已撤回为本地草稿，没有真实发送记录。'))
  },
  audit() {
    if (this.data.feedbackDirty) return
    this.commit({ type: 'audit' }, '固定本地模板已生成预览，等待你决定；没有模型或开发任务运行。')
  },
  onDecisionNote(event) { this.setData({ decisionNote: event.detail.value }) },
  decide(event) {
    if (this.data.feedbackDirty) return
    const value = event.currentTarget.dataset.value
    this.confirm(value === 'approved' ? '仅同意保留这个提案？' : '驳回这个模拟提案？', '只记录你对当前版本提案的本地决定。不会执行开发、修改代码、发布或对外执行。',
      () => this.commit({ type: 'decide', value, confirmed: true, note: this.data.decisionNote }, '人工决定已保存到本机；开发并未执行。'))
  },
  undoDecision() { this.commit({ type: 'undo-decision' }, '决定已撤销，可以重新审阅当前模拟提案。') },
  simulateFailure() { this.setData({ failNext: true, notice: '下一次保存将主动模拟失败。失败后再点原按钮可重试。', error: '' }) },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }) }
})
