'use strict'

const { createStore, uid } = require('../../services/cato-lab')
const capture = require('../../utils/cato-capture')

Page({
  data: {
    input: '', source: 'text', sourceLabel: capture.SOURCES.text,
    batch: null, items: [], count: 0, error: '', notice: '', saving: false, loadFailed: false, saveUncertain: false
  },

  onLoad() {
    this._store = createStore('capture')
    this.reloadInbox()
  },

  reloadInbox() {
    try {
      const state = this.readState()
      this.showState(state)
      this.setData({ error: '', loadFailed: false })
    } catch (error) {
      this.setData({ loadFailed: true, error: '收件箱读取失败，已暂停保存以保护原记录。' + error.message })
    }
  },

  readState() { return capture.validateState(this._store.load('inbox', capture.emptyState())) },

  showState(state) { this.setData({ items: capture.presentItems(state), count: state.items.length }) },

  onInput(event) {
    if (this.data.batch || this._saving) return
    this.setData({ input: event.detail.value, error: '', notice: '' })
  },

  useSample(event) {
    if (this.data.batch || this._saving) return
    const source = event.currentTarget.dataset.source
    if (!Object.prototype.hasOwnProperty.call(capture.SAMPLES, source)) return
    const apply = () => {
      if (this.data.batch || this._saving) return
      this.setData({ input: capture.SAMPLES[source], source, sourceLabel: capture.SOURCES[source], error: '', notice: '这是预写的合成文字样本，没有录音、选图、识别或上传。可修改文字后再整理。' })
    }
    if (!this.data.input.trim()) return apply()
    wx.showModal({ title: '替换输入区文字？', content: '只替换尚未整理的文字，不改收件箱。', success: result => { if (result.confirm) apply() } })
  },

  startText() {
    if (this.data.batch || this._saving) return
    wx.showModal({ title: '清空样本文字并新写？', content: '当前输入会清空，收件箱不受影响。未清空前，样本及其编辑版本始终标记为合成来源。', success: result => {
      if (result.confirm && !this.data.batch && !this._saving) this.setData({ input: '', source: 'text', sourceLabel: capture.SOURCES.text, notice: '可以写下你自己的照护事项了。', error: '' })
    } })
  },

  prepareDrafts() {
    if (this.data.batch || this._saving) return
    try {
      const batch = capture.parseDrafts(this.data.input, uid('capture'), this.data.source)
      this.setData({ batch, saveUncertain: false, error: '', notice: '仅按换行、分号和句号拆分，不做语义理解。请逐条核对内容与时间，离开页面会丢弃未确认草稿。' })
    } catch (error) { this.setData({ error: error.message, notice: '' }) }
  },

  editDraft(event) {
    if (this._saving || this.data.saveUncertain || !this.data.batch) return
    const { id, field } = event.currentTarget.dataset
    if (!['title', 'date', 'time'].includes(field)) return
    const patch = { [field]: event.detail.value }
    if (field === 'date' || field === 'time') patch.timeMode = 'scheduled'
    try { this.setData({ batch: capture.updateDraft(this.data.batch, id, patch), error: '', notice: '' }) }
    catch (error) { this.setData({ error: error.message }) }
  },

  chooseTimeMode(event) {
    if (this._saving || this.data.saveUncertain || !this.data.batch) return
    const { id, mode } = event.currentTarget.dataset
    try { this.setData({ batch: capture.updateDraft(this.data.batch, id, { timeMode: mode }), error: '' }) }
    catch (error) { this.setData({ error: error.message }) }
  },

  removeDraft(event) {
    if (this._saving || this.data.saveUncertain || !this.data.batch) return
    const drafts = this.data.batch.drafts.filter(draft => draft.id !== event.currentTarget.dataset.id)
    if (!drafts.length) {
      this.setData({ batch: null, error: '', notice: '最后一条草稿已移除。原输入仍保留，没有创建事项。' })
    } else this.setData({ batch: { ...this.data.batch, drafts }, error: '' })
  },

  cancelBatch() {
    if (this._saving || !this.data.batch) return
    const batchId = this.data.batch.id
    wx.showModal({
      title: '取消这一批草稿？', content: '仅丢弃当前草稿，不修改收件箱。若上次保存结果不明，建议先重试核对；取消不会撤回可能已保存的事项。原输入会保留。',
      success: result => {
        if (result.confirm && this.data.batch && this.data.batch.id === batchId && !this._saving) {
          this.setData({ batch: null, saveUncertain: false, error: '', notice: '已丢弃草稿；此次取消操作没有创建或修改收件箱事项。原输入仍保留。' })
          this.reloadInbox()
        }
      }
    })
  },

  confirmDrafts() {
    if (this._saving || !this.data.batch || this.data.loadFailed) return
    this._saving = true
    this.setData({ saving: true, error: '', notice: '' })
    let writeAttempted = false
    try {
      // Always read latest state. Persist items and idempotency receipt in one storage write.
      const result = capture.confirmBatch(this.readState(), this.data.batch, new Date().toISOString())
      if (!result.alreadyCommitted) {
        writeAttempted = true
        this._store.save('inbox', result.state)
      }
      this.showState(result.state)
      this.setData({ batch: null, saveUncertain: false, input: '', source: 'text', sourceLabel: capture.SOURCES.text, notice: result.alreadyCommitted ? '这批事项已保存，没有重复创建。' : '已在本机保存 ' + result.added + ' 条事项。没有设置通知或上传云端。' })
    } catch (error) {
      this.setData({ saveUncertain: this.data.saveUncertain || writeAttempted, error: '本次确认未完成，草稿仍保留。' + error.message + (writeAttempted || this.data.saveUncertain ? ' 保存结果需要核对，请重试；会检查批次回执，不会重复创建。' : ' 请核对输入或本机存储后重试。') })
    } finally {
      this._saving = false
      this.setData({ saving: false })
    }
  },

  toggleItem(event) { this.persistItem(event.currentTarget.dataset.id, 'toggle') },

  removeItem(event) {
    if (this._saving || this.data.loadFailed) return
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这条本地事项？', content: '仅删除本实验的这条事项；删除后不可撤销，不影响原版档案。', success: result => { if (result.confirm) this.persistItem(id, 'remove') } })
  },

  persistItem(id, action) {
    if (this._saving || this.data.loadFailed) return
    this._saving = true
    this.setData({ saving: true, error: '', notice: '' })
    try {
      const next = capture.changeItem(this.readState(), id, action)
      this._store.save('inbox', next)
      this.showState(next)
      this.setData({ notice: action === 'remove' ? '已删除该实验事项，不影响原版档案。' : '事项状态已保存在本机，可再次点击撤销。' })
    } catch (error) { this.setData({ error: '更改未完成，界面未提前改动。' + error.message }) }
    finally { this._saving = false; this.setData({ saving: false }) }
  }
})
