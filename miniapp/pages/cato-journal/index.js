'use strict'

const { createStore, uid } = require('../../services/cato-lab')
const journal = require('../../utils/cato-journal')
function today() {
  const date = new Date()
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
function fresh() { return journal.blankEntry(uid('journal'), today()) }

Page({
  data: { entries: [], visibleEntries: [], draft: null, dirty: false, editorOpen: true, ready: false,
    query: '', reviewDate: '', error: '', status: '', share: null, excerpts: [], preview: null, shareError: '', shareSourceTitle: '' },
  onLoad() {
    this.store = createStore('journal')
    this.setData({ draft: fresh() })
    this.loadEntries()
  },
  loadEntries() {
    try {
      const entries = journal.normalizeEntries(this.store.load('entries', []))
      this.setData({ entries, ready: true, error: '', visibleEntries: journal.reviewEntries(entries, this.data.query, this.data.reviewDate) })
    } catch (_) { this.setData({ ready: false, error: '本地日记读取失败，已暂停保存以免覆盖原记录。当前输入保留，请重试读取。' }) }
  },
  setDraftField(event) {
    const field = event.currentTarget.dataset.field
    if (!['title', 'story', 'catName', 'date'].includes(field) || !this.data.draft) return
    this.setData({ draft: { ...this.data.draft, [field]: event.detail.value }, dirty: true, error: '', status: '' })
  },
  discardThen(action) {
    if (!this.data.dirty) return action()
    wx.showModal({ title: '放弃尚未保存的修改？', content: '已保存的私人日记仍会保留；当前编辑内容尚未保存。',
      success: result => { if (result.confirm) action() } })
  },
  closeShareState() { return { share: null, excerpts: [], preview: null, shareError: '', shareSourceTitle: '' } },
  newEntry() {
    this.discardThen(() => this.setData({ ...this.closeShareState(), draft: fresh(), editorOpen: true, dirty: false, error: '', status: '' }))
  },
  editEntry(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id)
    if (!entry) return
    this.discardThen(() => {
      this.setData({ ...this.closeShareState(), draft: journal.privateFields(entry), editorOpen: true, dirty: false, error: '', status: '' })
      wx.pageScrollTo({ scrollTop: 0, duration: 200 })
    })
  },
  cancelEdit() {
    this.discardThen(() => this.setData({ draft: fresh(), editorOpen: false, dirty: false, error: '', status: '已取消编辑，已保存的日记不变。' }))
  },
  saveEntry() {
    if (!this.data.ready || !this.data.draft) return
    try {
      const entries = journal.upsertEntry(this.data.entries, this.data.draft, Date.now())
      this.store.save('entries', entries)
      const saved = entries.find(item => item.id === this.data.draft.id)
      this.setData({ ...this.closeShareState(), entries, draft: journal.privateFields(saved), dirty: false,
        visibleEntries: journal.reviewEntries(entries, this.data.query, this.data.reviewDate), error: '', status: '已保存到本机私人日记。没有云同步或公开发布。' })
    } catch (error) {
      this.setData({ error: error.message && /标题|正文|日期|称呼|标识|时间/.test(error.message) ? error.message : '保存失败，编辑内容仍保留。请释放本机空间后重试。', status: '' })
    }
  },
  deleteEntry(event) {
    if (!this.data.ready) return
    const id = event.currentTarget.dataset.id
    const entry = this.data.entries.find(item => item.id === id)
    if (!entry) return
    wx.showModal({ title: '删除这篇私人日记？', content: '将从本机删除《' + entry.title + '》，无法撤销。该篇未保存的修改和相关分享预览也会清空。',
      success: result => {
        if (!result.confirm) return
        try {
          const entries = journal.removeEntry(this.data.entries, id)
          this.store.save('entries', entries)
          const updates = { entries, visibleEntries: journal.reviewEntries(entries, this.data.query, this.data.reviewDate), error: '', status: '已删除这篇本机日记，无法撤销。' }
          if (this.data.draft && this.data.draft.id === id) Object.assign(updates, { draft: fresh(), dirty: false })
          if (this.data.share && this.data.share.sourceId === id) Object.assign(updates, this.closeShareState())
          this.setData(updates)
        } catch (_) { this.setData({ error: '删除失败，原日记和当前编辑内容均已保留。', status: '' }) }
      } })
  },
  changeQuery(event) {
    const query = event.detail.value
    this.setData({ query, visibleEntries: journal.reviewEntries(this.data.entries, query, this.data.reviewDate) })
  },
  changeReviewDate(event) {
    const reviewDate = event.detail.value
    this.setData({ reviewDate, visibleEntries: journal.reviewEntries(this.data.entries, this.data.query, reviewDate) })
  },
  clearReview() { this.setData({ query: '', reviewDate: '', visibleEntries: journal.reviewEntries(this.data.entries, '', '') }) },
  beginShare(event) {
    const entry = this.data.entries.find(item => item.id === event.currentTarget.dataset.id)
    if (!entry) return
    // Switching source always starts empty. Unsaved private editor text is never read here.
    this.setData({ share: journal.blankShare(entry.id), excerpts: journal.excerptsFor(entry.story), preview: null,
      shareError: '', shareSourceTitle: entry.title, status: '分享草稿已重置为空白；私人日记保持不变。' },
    () => wx.pageScrollTo({ selector: '#journal-share', duration: 200 }))
  },
  chooseExcerpt(event) {
    if (!this.data.share) return
    try {
      const source = this.data.entries.find(item => item.id === this.data.share.sourceId)
      const share = journal.selectExcerpt(this.data.share, source, Number(event.currentTarget.dataset.index))
      this.setData({ share, preview: null, shareError: '' })
    } catch (error) { this.setData({ shareError: error.message }) }
  },
  changeShareText(event) {
    if (!this.data.share) return
    this.setData({ share: { ...this.data.share, body: event.detail.value, mode: 'manual', selectedExcerpt: '' }, preview: null, shareError: '' })
  },
  chooseVisibility(event) {
    if (!this.data.share) return
    const visibility = event.currentTarget.dataset.visibility
    if (!['public', 'room'].includes(visibility)) return
    this.setData({ share: { ...this.data.share, visibility }, preview: null, shareError: '' })
  },
  previewShare() {
    if (!this.data.share) return
    try {
      const source = this.data.entries.find(item => item.id === this.data.share.sourceId)
      this.setData({ preview: journal.sharePreview(this.data.share, source), shareError: '' })
    } catch (error) { this.setData({ preview: null, shareError: error.message }) }
  },
  cancelShare() { this.setData({ ...this.closeShareState(), status: '分享草稿与预览已清空。私人日记仍在本机。' }) },
  onUnload() { this.setData(this.closeShareState()) }
})
