'use strict'

const { createStore, uid } = require('../../services/cato-lab')
const rules = require('../../utils/cato-expenses')

function createPage(deps = {}) {
  return {
    data: {
      ready: false, saving: false, error: '', status: '', preview: null, editId: '',
      draft: rules.emptyDraft(''), categories: rules.CATEGORIES, categoryIndex: 0,
      month: '', monthLabel: '', total: '0.00', count: 0, recordCount: 0,
      rows: [], categoryTotals: []
    },
    onLoad() {
      this._api = deps.api || wx
      this._store = deps.store || createStore('expenses')
      this._newId = deps.newId || (() => uid('expense'))
      this._today = rules.localDate(deps.now ? deps.now() : new Date())
      this.setData({ draft: rules.emptyDraft(this._today), month: this._today.slice(0, 7) })
      this.reloadLedger()
    },
    _read() { return rules.validateLedger(this._store.load('ledger', rules.emptyLedger())) },
    _refresh(ledger, month) {
      const selected = month || this.data.month
      const summary = rules.monthlySummary(ledger, selected)
      this._ledger = ledger
      this.setData({
        ready: true, month: selected, monthLabel: selected.slice(0, 4) + ' 年 ' + Number(selected.slice(5)) + ' 月',
        total: rules.formatCents(summary.totalCents), count: summary.count, recordCount: ledger.records.length,
        rows: summary.records.map(record => ({ ...record, amount: rules.formatCents(record.cents), categoryLabel: rules.categoryLabel(record.category) })),
        categoryTotals: summary.categories.map(category => ({ ...category, amount: rules.formatCents(category.cents) }))
      })
    },
    reloadLedger() {
      try { this._refresh(this._read()); this.setData({ error: '' }) }
      catch (_) { this.setData({ ready: false, error: '无法读取本机账本。为避免覆盖，已停止写入；草稿仍保留，可重新加载后核对。' }) }
    },
    onField(event) {
      const field = event.currentTarget.dataset.field
      if (!['amount', 'catName', 'note'].includes(field) || this._busy) return
      this._previewDraft = null
      this.setData({ ['draft.' + field]: event.detail.value, preview: null, error: '', status: '' })
    },
    onDate(event) {
      if (this._busy) return
      this._previewDraft = null
      this.setData({ 'draft.date': event.detail.value, preview: null, error: '', status: '' })
    },
    onCategory(event) {
      if (this._busy) return
      const index = Number(event.detail.value)
      if (!Number.isInteger(index) || !rules.CATEGORIES[index]) return
      this._previewDraft = null
      this.setData({ 'draft.category': rules.CATEGORIES[index].value, categoryIndex: index, preview: null, error: '', status: '' })
    },
    onMonth(event) {
      try { this._refresh(this._read(), event.detail.value); this.setData({ error: '' }) }
      catch (error) { this.setData({ error: error.message || '月份读取失败，请重试。' }) }
    },
    previewDraft() {
      if (!this.data.ready || this._busy) return
      try {
        const normalized = rules.validateDraft(this.data.draft)
        this._previewDraft = rules.draftFromRecord(normalized)
        this._operationId = this._newId()
        this.setData({ preview: { ...normalized, amount: rules.formatCents(normalized.cents), categoryLabel: rules.categoryLabel(normalized.category) }, error: '', status: '' })
      } catch (error) { this.setData({ error: error.message, preview: null }) }
    },
    backToForm() {
      if (this._busy) return
      this._previewDraft = null
      this.setData({ preview: null, error: '' })
    },
    confirmPreview() {
      if (!this.data.ready || !this.data.preview || !this._previewDraft || this._busy) return
      this._busy = true
      this.setData({ saving: true, error: '', status: '' })
      const draft = this._previewDraft
      const edited = !!this.data.editId
      try {
        const result = rules.upsertExpense(this._read(), draft, this._operationId, this.data.editId, this._baseRevision)
        if (result.changed) this._store.save('ledger', result.ledger)
        this._refresh(result.ledger, draft.date.slice(0, 7))
        this._clearDraft()
        this.setData({ status: edited ? '已更新这笔本机记录，月度汇总已同步。' : '已记入本机账本。可以继续记下一笔。' })
      } catch (error) {
        this.setData({ error: '未能确认保存：' + (error.message || '本机存储不可用。') + ' 草稿仍保留；可重试，重复确认不会多记一笔。' })
      } finally { this._busy = false; this.setData({ saving: false }) }
    },
    _clearDraft() {
      this._previewDraft = null
      this._operationId = null
      this._baseRevision = null
      this.setData({ draft: rules.emptyDraft(this._today), categoryIndex: 0, editId: '', preview: null, error: '' })
    },
    _hasDraft() {
      const draft = this.data.draft
      return !!(this.data.editId || draft.amount || draft.catName || draft.note || draft.date !== this._today || draft.category !== 'food')
    },
    cancelDraft() {
      if (this._busy) return
      if (!this._hasDraft()) return
      this._api.showModal({ title: this.data.editId ? '取消本次修改？' : '清空未保存的草稿？', content: '只放弃当前草稿，不会更改已保存的账本记录。', confirmText: '放弃草稿',
        success: result => { if (result.confirm) { this._clearDraft(); this.setData({ status: '草稿已放弃，账本没有改变。' }) } },
        fail: () => this.setData({ error: '未能打开确认框，草稿没有改变。' })
      })
    },
    startEdit(event) {
      if (!this.data.ready || this._busy) return
      const id = event.currentTarget.dataset.id
      const open = () => {
        try {
          const ledger = this._read()
          const record = ledger.records.find(item => item.id === id)
          if (!record) throw new Error('这笔记录已不存在，请重新加载。')
          this._refresh(ledger)
          this._previewDraft = null
          this._baseRevision = record.revision
          this.setData({ draft: rules.draftFromRecord(record), editId: id, categoryIndex: rules.CATEGORIES.findIndex(item => item.value === record.category), preview: null, error: '', status: '' })
          if (this._api.pageScrollTo) this._api.pageScrollTo({ scrollTop: 0, duration: 200 })
        } catch (error) { this.setData({ error: error.message || '未能打开记录。' }) }
      }
      if (!this._hasDraft()) return open()
      this._api.showModal({ title: '切换到这笔记录？', content: '当前未确认的草稿会被替换，已保存的记录不会改变。', confirmText: '切换记录',
        success: result => { if (result.confirm) open() }, fail: () => this.setData({ error: '未能打开确认框，草稿没有改变。' }) })
    },
    requestDelete(event) {
      if (!this.data.ready || this._busy) return
      const record = this._ledger.records.find(item => item.id === event.currentTarget.dataset.id)
      if (!record) return
      const operationId = this._newId()
      this._api.showModal({ title: '删除这笔本机记录？', content: record.date + ' · ' + rules.categoryLabel(record.category) + ' · ¥' + rules.formatCents(record.cents) + '。删除后无法恢复。', confirmText: '确认删除', confirmColor: '#B94955',
        success: result => { if (result.confirm) this._deleteRecord(record, operationId) },
        fail: () => this.setData({ error: '未能打开确认框，记录没有改变。' })
      })
    },
    _deleteRecord(record, operationId) {
      if (this._busy) return
      this._busy = true
      try {
        const result = rules.deleteExpense(this._read(), record.id, operationId, record.revision)
        if (result.changed) this._store.save('ledger', result.ledger)
        this._refresh(result.ledger)
        if (this.data.editId === record.id) this._clearDraft()
        this.setData({ error: '', status: '这笔本机记录已删除，月度汇总已同步。' })
      } catch (error) { this.setData({ error: '未能确认删除：' + (error.message || '本机存储不可用。') + ' 请重新加载后核对；页面暂保留原记录。', status: '' }) }
      finally { this._busy = false }
    }
  }
}

if (typeof Page === 'function') Page(createPage())
module.exports = { createPage }
