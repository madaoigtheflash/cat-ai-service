'use strict'

// Pure local state machine. No network, HTML, model, code execution or medical plan.
const { articles } = require('../data/knowledge')
const SOURCE_IDS = ['photo', 'lihua']
const RULESET = 'local-templates-v1'
const MEDICAL = /用药|喂药|药量|剂量|诊断|治疗|驱虫|疫苗|注射|催吐|断食|处方|中毒|呼吸困难|无法排尿|抽搐|呕吐|腹泻|毫克|\bmg\b/i
const UNSAFE_ACTION = /用药|喂药|药量|剂量|诊断|治疗|驱虫|疫苗|注射|催吐|断食|处方|毫克|\bmg\b|强迫|强行|追赶|抓住|惩罚/i
const ACTION_STATUSES = ['draft', 'ready', 'done', 'cancelled']
const FEEDBACK_STATUSES = ['draft', 'queued', 'audited', 'decided']
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function requireThat(condition, code, message) { if (!condition) fail(code, message) }
function sources() {
  return SOURCE_IDS.map(id => {
    const article = articles.find(item => item.id === id)
    return { id: article.id, title: article.title, summary: article.summary, content: article.content,
      provenance: '仓库既有知识库 · miniapp/data/knowledge.js',
      boundary: id === 'photo' ? '只观察光线与构图，不强迫猫咪摆姿势；本页不读相册、不做身份判断。' : '花纹不等于血统或身份；只记看见的外观，不给个体贴性格或健康标签。' }
  })
}
function freshState() {
  return { schema: 1, sourceId: '', action: { text: '', revision: 0, status: 'draft', acknowledged: false },
    feedback: { raw: '', version: 0, history: [], status: 'draft', submittedVersion: null, queueId: null }, report: null, decision: null }
}
function queueId(state) { return 'local:' + state.sourceId + ':a' + state.action.revision + ':v' + state.feedback.version }
function invalidate(state) {
  state.feedback.status = 'draft'; state.feedback.submittedVersion = null; state.feedback.queueId = null
  state.report = null; state.decision = null
}
function fixedReport(state) {
  const raw = state.feedback.raw
  let category = '体验回顾'
  let issue = '当前原文尚不足以证明产品存在问题；先区分观察结果与改进建议。'
  let proposal = '补充一个具体场景、原本期待和实际结果，再由用户决定是否保留为改进候选。'
  let feasibility = '可在本地继续整理文字；是否值得开发、实现成本和效果仍未评估。'
  if (MEDICAL.test(raw)) {
    category = '健康边界需人工关注'
    issue = '检测到健康相关词，仅提示核对边界，不判断病情、紧急程度或医学正确性。'
    proposal = '把健康疑问与产品体验分开；健康问题交由执业兽医，本实验不生成用药、诊断或治疗安排。'
    feasibility = '医疗方案不在本实验范围内；仅可讨论来源说明与安全提示是否清楚。'
  } else if (/按钮|页面|保存|失败|报错|遮挡|字号/.test(raw)) {
    category = '使用体验候选'
    issue = '检测到界面或保存相关词；这些词不代表故障已被复现。'
    proposal = '整理触发步骤、期望与实际结果，先人工复现，再决定是否另开开发任务。'
    feasibility = '可以提出检查清单；未读代码、未运行测试，也不能保证修复可行。'
  } else if (/知识|看不懂|说明|来源|花纹|光线/.test(raw)) {
    category = '知识表达候选'
    issue = '检测到知识表达相关词；不判断知识内容真假，也不新增知识结论。'
    proposal = '保留来源 ID，标出不清楚的表述，再人工核对依据与适用范围。'
    feasibility = '可以整理表达问题；新知识和医学内容须另行核验，不在这里修改。'
  }
  return { id: queueId(state) + ':' + RULESET, sourceId: state.sourceId, actionRevision: state.action.revision,
    feedbackVersion: state.feedback.version, ruleset: RULESET, category, issue, proposal, feasibility,
    boundary: '本地固定关键词与模板，不是模型审计。不会执行命令、修改代码或对外发送反馈。' }
}
function validateState(value) {
  requireThat(value && value.schema === 1 && value.action && value.feedback, 'INVALID_STATE', '本地数据格式无法识别，未覆盖原数据。')
  const state = copy(value)
  const action = state.action; const feedback = state.feedback
  requireThat(state.sourceId === '' || SOURCE_IDS.includes(state.sourceId), 'UNKNOWN_SOURCE', '知识来源不在本实验白名单内，不能继续操作。')
  requireThat(ACTION_STATUSES.includes(action.status) && FEEDBACK_STATUSES.includes(feedback.status), 'INVALID_STATUS', '状态无法识别，未推断为完成或同意。')
  requireThat(typeof action.text === 'string' && action.text.length <= 240 && Number.isSafeInteger(action.revision) && action.revision >= 0 && typeof action.acknowledged === 'boolean', 'INVALID_STATE', '行动数据无效。')
  requireThat(typeof feedback.raw === 'string' && feedback.raw.length <= 1200 && Number.isSafeInteger(feedback.version) && feedback.version >= 0 && Array.isArray(feedback.history), 'INVALID_STATE', '反馈数据无效。')
  requireThat(feedback.history.length === feedback.version, 'INVALID_VERSION', '反馈版本记录不完整。')
  feedback.history.forEach((entry, index) => {
    requireThat(entry && entry.version === index + 1 && typeof entry.raw === 'string' && entry.raw.length <= 1200 && entry.sourceId === state.sourceId && Number.isSafeInteger(entry.actionRevision) && entry.actionRevision > 0 && entry.actionRevision <= action.revision, 'INVALID_VERSION', '反馈历史版本无效。')
  })
  requireThat(feedback.version === 0 ? feedback.raw === '' : feedback.history[feedback.version - 1].raw === feedback.raw, 'INVALID_VERSION', '反馈原文与版本不一致。')
  requireThat(state.sourceId || (action.text === '' && action.status === 'draft' && feedback.version === 0), 'UNKNOWN_SOURCE', '请先选择一个既有知识来源。')
  requireThat(action.status === 'draft' || (state.sourceId && action.text.trim().length >= 4 && action.revision > 0 && action.acknowledged && !UNSAFE_ACTION.test(action.text)), 'INVALID_ACTION', '已确认行动缺少有效内容或低风险确认。')
  if (feedback.status === 'draft') {
    requireThat(feedback.submittedVersion === null && feedback.queueId === null && state.report === null && state.decision === null, 'STALE_REVIEW', '草稿不能保留旧审计报告或决定。')
  } else {
    requireThat(action.status === 'done' && feedback.raw.trim().length >= 4 && feedback.submittedVersion === feedback.version && feedback.queueId === queueId(state) && feedback.history[feedback.version - 1].actionRevision === action.revision, 'INVALID_QUEUE', '模拟队列与当前行动、反馈版本不一致。')
    if (feedback.status === 'queued') requireThat(state.report === null && state.decision === null, 'STALE_REVIEW', '待模拟审计状态不能包含报告或决定。')
    else {
      requireThat(JSON.stringify(state.report) === JSON.stringify(fixedReport(state)), 'STALE_REVIEW', '模拟报告与当前固定规则不一致，请勿沿用旧报告。')
      if (feedback.status === 'audited') requireThat(state.decision === null, 'INVALID_DECISION', '待人工决定状态不能预置同意。')
      else requireThat(state.decision && ['approved', 'rejected'].includes(state.decision.value) && state.decision.reportId === state.report.id && state.decision.feedbackVersion === feedback.version && state.decision.actor === 'user' && typeof state.decision.note === 'string' && state.decision.note.length <= 300, 'INVALID_DECISION', '人工决定无效。')
    }
  }
  return state
}
function transition(current, event) {
  const state = validateState(current)
  requireThat(event && typeof event.type === 'string', 'INVALID_EVENT', '操作无效。')
  const action = state.action; const feedback = state.feedback
  switch (event.type) {
    case 'select-source':
      requireThat(SOURCE_IDS.includes(event.sourceId), 'UNKNOWN_SOURCE', '只可选择本页列出的既有知识。')
      if (state.sourceId === event.sourceId) return state
      requireThat(action.status === 'draft' && action.text === '' && feedback.version === 0, 'SOURCE_LOCKED', '行动已有内容；如需换来源，请回实验入口重置本实验。')
      state.sourceId = event.sourceId
      break
    case 'save-action':
      requireThat(state.sourceId && action.status === 'draft', 'INVALID_STATUS', '请先选择来源，并进入行动编辑状态。')
      requireThat(typeof event.text === 'string' && event.text.length <= 240, 'INVALID_INPUT', '行动最多 240 字。')
      if (action.text === event.text) return state
      action.text = event.text; action.revision += 1; action.acknowledged = false; invalidate(state)
      break
    case 'confirm-action':
      if (action.status === 'ready') return state
      requireThat(state.sourceId && action.status === 'draft', 'INVALID_STATUS', '只有行动草稿可以确认。')
      requireThat(action.text.trim().length >= 4, 'INVALID_INPUT', '请用至少 4 个字写下你自己决定的小行动。')
      requireThat(!UNSAFE_ACTION.test(action.text), 'UNSAFE_ACTION', '本实验不安排用药、诊断、治疗或强迫互动；请改为低风险的外观、光线或环境观察。')
      requireThat(event.acknowledged === true, 'CONFIRM_REQUIRED', '请主动确认低风险、猫咪可退出的行动边界。')
      action.status = 'ready'; action.acknowledged = true
      break
    case 'complete':
      if (action.status === 'done') return state
      requireThat(action.status === 'ready', 'INVALID_STATUS', '只有已确认的行动可以标记完成。')
      action.status = 'done'
      break
    case 'undo-complete':
      if (action.status === 'ready') return state
      requireThat(action.status === 'done', 'INVALID_STATUS', '当前没有已完成行动可撤销。')
      action.status = 'ready'; invalidate(state)
      break
    case 'cancel-action':
      if (action.status === 'cancelled') return state
      requireThat(['ready', 'done'].includes(action.status), 'INVALID_STATUS', '只有已确认的行动可以取消。')
      action.status = 'cancelled'; invalidate(state)
      break
    case 'edit-action':
      if (action.status === 'draft') return state
      action.status = 'draft'; action.acknowledged = false; invalidate(state)
      break
    case 'save-feedback':
      requireThat(action.status === 'done', 'INVALID_STATUS', '先完成自己确认的小行动，再保存反馈。')
      requireThat(typeof event.raw === 'string' && event.raw.length <= 1200, 'INVALID_INPUT', '反馈最多 1200 字。')
      if (event.raw === feedback.raw && !event.revised && (!feedback.version || feedback.history[feedback.version - 1].actionRevision === action.revision)) return state
      feedback.raw = event.raw; feedback.version += 1
      feedback.history.push({ version: feedback.version, raw: event.raw, sourceId: state.sourceId, actionRevision: action.revision })
      invalidate(state)
      break
    case 'submit-feedback':
      requireThat(action.status === 'done', 'INVALID_STATUS', '行动尚未完成，不能提交模拟队列。')
      if (feedback.status !== 'draft') return state
      requireThat(feedback.raw.trim().length >= 4, 'INVALID_INPUT', '请先保存至少 4 个字的反馈草稿。')
      requireThat(feedback.history[feedback.version - 1].actionRevision === action.revision, 'INVALID_VERSION', '行动已修改，请核对并重新保存反馈以绑定当前行动版本。')
      requireThat(event.confirmed === true, 'CONFIRM_REQUIRED', '请明确确认将这一版反馈加入本地模拟队列。')
      feedback.status = 'queued'; feedback.submittedVersion = feedback.version; feedback.queueId = queueId(state)
      break
    case 'withdraw-feedback':
      invalidate(state)
      break
    case 'audit':
      if (['audited', 'decided'].includes(feedback.status)) return state
      requireThat(feedback.status === 'queued', 'INVALID_STATUS', '请先明确提交本地模拟队列。')
      state.report = fixedReport(state); feedback.status = 'audited'
      break
    case 'decide':
      requireThat(['approved', 'rejected'].includes(event.value), 'INVALID_DECISION', '请选择人工同意或驳回。')
      if (feedback.status === 'decided' && state.decision.value === event.value) return state
      requireThat(feedback.status === 'audited' && state.report, 'INVALID_STATUS', '只有当前版本的模拟报告可以人工决定；修改决定前请先撤销。')
      requireThat(event.confirmed === true, 'CONFIRM_REQUIRED', '需要用户明确确认，不会自动同意提案。')
      requireThat(event.note === undefined || (typeof event.note === 'string' && event.note.length <= 300), 'INVALID_INPUT', '决定说明最多 300 字。')
      state.decision = { value: event.value, note: event.note || '', actor: 'user', reportId: state.report.id, feedbackVersion: feedback.version }
      feedback.status = 'decided'
      break
    case 'undo-decision':
      if (feedback.status === 'audited') return state
      requireThat(feedback.status === 'decided', 'INVALID_STATUS', '当前没有人工决定可撤销。')
      state.decision = null; feedback.status = 'audited'
      break
    default: fail('INVALID_EVENT', '不支持此操作。')
  }
  return validateState(state)
}
function persistTransition(store, current, event) {
  const next = transition(current, event)
  // Save before publishing success. Failed writes keep the previous state intact.
  store.save('session', next)
  return next
}
module.exports = { SOURCE_IDS, RULESET, sources, freshState, validateState, transition, persistTransition }
