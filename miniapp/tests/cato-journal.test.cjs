const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const j = require('../utils/cato-journal')
const fixture = (id = 'journal_a', extra = {}) => ({ id, date: '2026-09-29', title: '私人标题', story: '今天猫咪在窗边晒太阳。私密的另一件事只写给自己。', catName: '私人称呼', ...extra })
const entry = (id, extra) => j.upsertEntry([], fixture(id, extra), 100)[0]
const event = (dataset = {}, value = '') => ({ currentTarget: { dataset }, detail: { value } })

function controller(options = {}) {
  let definition
  const values = { 'catai_cato_lab_v1:journal:entries': options.entries || [] }
  const api = { values, writes: [], failRead: false, failWrite: false, confirm: false, modal: null,
    getStorageSync(key) { if (api.failRead) throw Error('read failed'); return values[key] },
    setStorageSync(key, value) { if (api.failWrite) throw Error('quota'); api.writes.push(key); values[key] = JSON.parse(JSON.stringify(value)) },
    showModal(value) { api.modal = value; value.success({ confirm: api.confirm }) },
    pageScrollTo() {} }
  global.wx = api
  global.Page = value => { definition = value }
  const modulePath = require.resolve('../pages/cato-journal/index')
  delete require.cache[modulePath]
  require(modulePath)
  delete global.Page
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value, callback) { Object.assign(this.data, value); if (callback) callback() } }
  page.onLoad()
  return { page, api }
}
test.afterEach(() => { delete global.wx; delete global.Page })

test('日期严格校验日历、闰年与允许范围', () => {
  for (const date of ['2024-02-29', '1900-01-01', '2199-12-31']) assert.equal(j.validDate(date), true)
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-09-00', '2026-9-29', '1899-12-31', '2200-01-01', null]) assert.equal(j.validDate(date), false)
})
test('标题、正文、猫咪称呼与非法标识拒绝无效输入', () => {
  for (const patch of [{ title: ' ' }, { title: '猫'.repeat(61) }, { story: '' }, { story: '猫'.repeat(4001) }, { catName: '猫'.repeat(61) }, { date: '2026-02-30' }, { id: '../escape' }]) assert.throws(() => j.upsertEntry([], fixture('journal_a', patch), 100))
  assert.doesNotThrow(() => j.upsertEntry([], fixture('journal_a', { title: '猫'.repeat(60), story: '猫'.repeat(4000), catName: '' }), 100))
})
test('私人存储字段白名单剔除照片、医疗资料与注入的分享对象', () => {
  const saved = j.upsertEntry([], fixture('journal_a', { imagePath: 'private.jpg', medical: 'secret', share: { visibility: 'public' }, unknown: 1 }), 100)[0]
  assert.deepEqual(Object.keys(saved).sort(), ['id', 'date', 'title', 'story', 'catName', 'createdAt', 'updatedAt'].sort())
  assert.equal(saved.story, fixture().story)
})
test('重复保存幂等，修改保留 ID 和创建时间，不改输入', () => {
  const original = [entry('journal_a')]
  const snapshot = JSON.stringify(original)
  assert.deepEqual(j.upsertEntry(original, fixture(), 200), original)
  const changed = j.upsertEntry(original, fixture('journal_a', { title: '改名' }), 200)
  assert.equal(changed.length, 1); assert.equal(changed[0].createdAt, 100); assert.equal(changed[0].updatedAt, 200)
  assert.equal(JSON.stringify(original), snapshot)
})
test('损坏数据、重复 ID、无效时间拒绝加载', () => {
  for (const value of [{}, [null], [entry(), entry()], [{ ...entry(), updatedAt: 0 }], [{ ...entry(), createdAt: -1 }]]) assert.throws(() => j.normalizeEntries(value))
  assert.throws(() => j.upsertEntry([], fixture(), NaN))
})
test('回顾搜索标题正文称呼且可叠加日期，按日期倒序', () => {
  const list = [entry('journal_a'), entry('journal_b', { date: '2026-09-28', title: '独处', catName: 'MIMI', story: '喝水' })]
  assert.equal(j.reviewEntries(list, 'Mimi', '')[0].id, 'journal_b')
  assert.equal(j.reviewEntries(list, '窗边', '2026-09-29').length, 1)
  assert.equal(j.reviewEntries(list, '窗边', '2026-09-28').length, 0)
  assert.equal(j.reviewEntries(list, '', '')[0].id, 'journal_a')
})
test('分享默认空白且无默认可见范围，片段始终短于正文', () => {
  assert.deepEqual(j.blankShare('journal_a'), { sourceId: 'journal_a', body: '', visibility: '', mode: 'manual', selectedExcerpt: '' })
  for (const story of ['猫', '猫咪', '短日记没有标点', fixture().story, '猫'.repeat(4000)]) {
    const excerpts = j.excerptsFor(story)
    assert.ok(excerpts.length <= 6)
    excerpts.forEach(item => { assert.notEqual(item.text, story); assert.ok(story.includes(item.text)); assert.ok(j.count(item.text) <= 80) })
  }
})
test('只选择一个片段且重新要求可见范围，不拼接完整正文', () => {
  const source = entry('journal_a')
  const prior = { ...j.blankShare(source.id), body: '旧草稿', visibility: 'public' }
  const selected = j.selectExcerpt(prior, source, 0)
  assert.equal(selected.body, j.excerptsFor(source.story)[0].text)
  assert.notEqual(selected.body, source.story); assert.equal(selected.visibility, '')
  assert.throws(() => j.selectExcerpt(prior, source, 99))
  assert.throws(() => j.selectExcerpt(prior, entry('journal_b'), 0))
})
test('公开与小屋预览严格白名单，不带任何私人元数据', () => {
  const source = { ...entry('journal_a'), imagePath: 'secret', medical: 'secret' }
  for (const visibility of ['public', 'room']) {
    const preview = j.sharePreview({ ...j.blankShare(source.id), visibility, body: '仅此短句', photo: 'secret', title: 'secret' }, source)
    assert.deepEqual(Object.keys(preview).sort(), ['text', 'audience', 'simulation', 'published'].sort())
    assert.equal(preview.text, '仅此短句'); assert.equal(preview.published, false); assert.equal(preview.simulation, true)
    assert.equal(preview.audience.type, visibility)
    for (const secret of ['私人标题', '私人称呼', 'journal_a', 'secret', '2026-09-29']) assert.equal(JSON.stringify(preview).includes(secret), false)
    if (visibility === 'room') assert.deepEqual(preview.audience, { type: 'room', id: j.ROOM.id, label: j.ROOM.label })
  }
})
test('空文、过长文字、未选或伪造范围和来源变化不能预览', () => {
  const source = entry('journal_a')
  const draft = { ...j.blankShare(source.id), body: '仅此短句', visibility: 'public' }
  for (const patch of [{ body: '' }, { body: ' ' }, { body: '猫'.repeat(501) }, { visibility: '' }, { visibility: 'friends' }, { sourceId: 'journal_b' }]) assert.throws(() => j.sharePreview({ ...draft, ...patch }, source))
  assert.throws(() => j.sharePreview(draft, null))
})
test('页面保存仅使用 journal 独立空间，双击保存不重复新增', () => {
  const { page, api } = controller()
  const id = page.data.draft.id
  page.setDraftField(event({ field: 'title' }, '今日'))
  page.setDraftField(event({ field: 'story' }, '猫咪睡醒了。'))
  page.saveEntry(); page.saveEntry()
  assert.equal(page.data.entries.length, 1); assert.equal(page.data.entries[0].id, id)
  assert.equal(page.data.dirty, false); assert.equal(page.data.error, '')
  assert.ok(api.writes.every(key => key === 'catai_cato_lab_v1:journal:entries'))
})
test('页面写入失败保留编辑草稿和已有记录，重试可保存', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.editEntry(event({ id: 'journal_a' })); page.setDraftField(event({ field: 'story' }, '修改后私人内容'))
  api.failWrite = true; page.saveEntry()
  assert.equal(page.data.entries[0].story, fixture().story); assert.equal(page.data.draft.story, '修改后私人内容')
  assert.equal(page.data.dirty, true); assert.match(page.data.error, /保存失败/)
  api.failWrite = false; page.saveEntry()
  assert.equal(page.data.entries[0].story, '修改后私人内容')
})
test('读失败与损坏存储禁止覆盖，重试保留当前输入', () => {
  const { page, api } = controller({ entries: { corrupt: true } })
  assert.equal(page.data.ready, false)
  page.setDraftField(event({ field: 'title' }, '输入仍在')); page.saveEntry()
  assert.equal(api.writes.length, 0)
  api.values['catai_cato_lab_v1:journal:entries'] = [entry('journal_a')]
  api.failRead = true; page.loadEntries(); assert.equal(page.data.ready, false)
  api.failRead = false; page.loadEntries()
  assert.equal(page.data.draft.title, '输入仍在'); assert.equal(page.data.entries.length, 1); assert.equal(page.data.ready, true)
})
test('编辑取消和新建切换需要确认，拒绝保留未保存草稿', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.editEntry(event({ id: 'journal_a' })); page.setDraftField(event({ field: 'title' }, '尚未保存'))
  page.newEntry(); assert.equal(page.data.draft.title, '尚未保存')
  page.cancelEdit(); assert.equal(page.data.draft.title, '尚未保存')
  api.confirm = true; page.cancelEdit()
  assert.equal(page.data.editorOpen, false); assert.equal(page.data.entries[0].title, '私人标题'); assert.equal(page.data.dirty, false)
})
test('删除必须确认，失败不丢记录，成功同时清空该篇草稿和预览', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.editEntry(event({ id: 'journal_a' })); page.beginShare(event({ id: 'journal_a' }))
  page.deleteEntry(event({ id: 'journal_a' })); assert.equal(page.data.entries.length, 1)
  api.confirm = true; api.failWrite = true; page.deleteEntry(event({ id: 'journal_a' }))
  assert.equal(page.data.entries.length, 1); assert.equal(page.data.share.sourceId, 'journal_a'); assert.match(page.data.error, /删除失败/)
  api.failWrite = false; page.deleteEntry(event({ id: 'journal_a' }))
  assert.equal(page.data.entries.length, 0); assert.equal(page.data.share, null); assert.notEqual(page.data.draft.id, 'journal_a')
})
test('分享改写、范围变更均使旧预览失效，取消不删除私人日记', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.beginShare(event({ id: 'journal_a' })); page.chooseExcerpt(event({ index: 0 })); page.chooseVisibility(event({ visibility: 'public' })); page.previewShare()
  assert.equal(page.data.preview.audience.type, 'public')
  page.chooseVisibility(event({ visibility: 'room' })); assert.equal(page.data.preview, null)
  page.previewShare(); assert.equal(page.data.preview.audience.type, 'room')
  page.changeShareText(event({}, '自己改写的一句话')); assert.equal(page.data.preview, null)
  page.previewShare(); assert.equal(page.data.preview.text, '自己改写的一句话')
  page.cancelShare(); assert.equal(page.data.share, null); assert.equal(page.data.preview, null)
  assert.equal(page.data.entries[0].story, fixture().story); assert.equal(api.writes.length, 0)
})
test('换来源绝不扩大公开内容，私人编辑保存会清空旧分享草稿', () => {
  const { page } = controller({ entries: [entry('journal_a'), entry('journal_b', { story: '另一篇绝密正文不能自动分享。' })] })
  page.beginShare(event({ id: 'journal_a' })); page.chooseExcerpt(event({ index: 0 })); page.chooseVisibility(event({ visibility: 'public' })); page.previewShare()
  page.beginShare(event({ id: 'journal_b' }))
  assert.equal(page.data.share.body, ''); assert.equal(page.data.share.visibility, ''); assert.equal(page.data.preview, null)
  page.editEntry(event({ id: 'journal_b' })); assert.equal(page.data.share, null)
  page.beginShare(event({ id: 'journal_b' })); page.setDraftField(event({ field: 'story' }, '添加更多私密内容')); page.saveEntry()
  assert.equal(page.data.share, null); assert.equal(page.data.preview, null)
})
test('离开页面清空临时分享；重开只恢复私人日记', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.beginShare(event({ id: 'journal_a' })); page.changeShareText(event({}, '临时草稿')); page.onUnload()
  assert.equal(page.data.share, null); assert.equal(api.writes.length, 0)
  const reopened = controller({ entries: api.values['catai_cato_lab_v1:journal:entries'] }).page
  assert.equal(reopened.data.entries.length, 1); assert.equal(reopened.data.share, null)
})
test('页面搜索、日期筛选和清除操作绑定完整', () => {
  const { page } = controller({ entries: [entry('journal_a'), entry('journal_b', { title: '喝水', date: '2026-09-28' })] })
  page.changeQuery(event({}, '喝水')); assert.equal(page.data.visibleEntries.length, 1)
  page.changeReviewDate(event({}, '2026-09-29')); assert.equal(page.data.visibleEntries.length, 0)
  page.clearReview(); assert.equal(page.data.visibleEntries.length, 2)
})
test('页面无效保存和未明确范围预览不产生数据或误报成功', () => {
  const { page, api } = controller({ entries: [entry('journal_a')] })
  page.setDraftField(event({ field: 'title' }, '有效标题')); page.setDraftField(event({ field: 'story' }, '有效正文'))
  page.setDraftField(event({ field: 'date' }, '2026-02-30')); page.saveEntry()
  assert.match(page.data.error, /日期/); assert.equal(page.data.dirty, true); assert.equal(api.writes.length, 0)
  page.beginShare(event({ id: 'journal_a' })); page.changeShareText(event({}, '主动改写')); page.previewShare()
  assert.equal(page.data.preview, null); assert.match(page.data.shareError, /明确选择/)
  page.chooseVisibility(event({ visibility: 'friends' })); assert.equal(page.data.share.visibility, '')
})
test('重复删除是无副作用的，缺失来源不能恢复预览', () => {
  const entries = [entry('journal_a')]
  const removed = j.removeEntry(entries, 'journal_a')
  assert.deepEqual(j.removeEntry(removed, 'journal_a'), [])
  assert.equal(entries.length, 1)
  const { page } = controller({ entries })
  page.beginShare(event({ id: 'journal_a' })); page.chooseExcerpt(event({ index: 0 })); page.chooseVisibility(event({ visibility: 'public' }))
  page.data.entries = []
  page.previewShare(); assert.equal(page.data.preview, null); assert.match(page.data.shareError, /来源已变化/)
})
test('路由、离线配置、原生控制器绑定和 UI 边界完整', () => {
  const root = path.resolve(__dirname, '..')
  const config = require('../config/cato-lab')
  assert.deepEqual(config, { enabled: true, variant: 'journal', title: '私人猫咪日记', entry: '/pages/cato-journal/index' })
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(app.pages.filter(value => value === config.entry.slice(1)).length, 1)
  const wxml = fs.readFileSync(path.join(root, 'pages/cato-journal/index.wxml'), 'utf8')
  const js = fs.readFileSync(path.join(root, 'pages/cato-journal/index.js'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'pages/cato-journal/index.wxss'), 'utf8')
  const shared = fs.readFileSync(path.join(root, 'styles/cato-lab.wxss'), 'utf8')
  const { page } = controller()
  for (const [, method] of wxml.matchAll(/bind(?:tap|input|change)="([A-Za-z]+)"/g)) assert.equal(typeof page[method], 'function', method)
  assert.match(css, /styles\/cato-lab\.wxss/); assert.match(shared, /min-height: 88rpx/); assert.match(shared, /safe-area-inset-bottom/)
  assert.match(css, /PingFang SC/); assert.match(wxml, /没有真实发布/); assert.match(wxml, /模拟小屋/); assert.match(wxml, /兽医诊断/)
  assert.doesNotMatch(js, /community|saveDraft|wx\.cloud|wx\.request|readLocalCatCards|chooseImage|upload/)
  assert.doesNotMatch(wxml, /open-type="share"/)
})
