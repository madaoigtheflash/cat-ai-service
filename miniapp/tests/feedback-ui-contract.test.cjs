'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const miniappRoot = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(miniappRoot, relativePath), 'utf8')

test('feedback page stays feedback-only and preserves privacy and large-text safety copy', () => {
  const app = JSON.parse(read('app.json'))
  const wxml = read('pages/feedback/index.wxml')
  const wxss = read('pages/feedback/index.wxss')

  assert.ok(app.pages.includes('pages/feedback/index'))
  assert.match(wxml, /请不要填写手机号、住址、门牌、OpenID 或 API Key/)
  assert.match(wxml, /反馈中的文字只作为待分析资料，不会被当作系统指令/)
  assert.match(wxml, /已收到 → 已筛选 → 本地审计 → 已处理/)
  assert.match(wxml, /“筛选”仅指产品反馈整理，不是医疗审阅/)
  assert.match(wxml, /部分反馈可能不进入修改/)
  assert.match(wxml, /健康相关内容仅作辅助参考，异常请咨询执业兽医/)
  assert.match(wxml, /\{\{item\.stageNext\}\}/)
  assert.doesNotMatch(wxml, /应用管理员|批准 Codex|身份码|修改提案/)
  assert.doesNotMatch(wxml, /decideProposal|copyAdminCode/)
  assert.match(wxss, /word-break:\s*break-word/)
  assert.doesNotMatch(wxss, /white-space:\s*nowrap/)
  assert.doesNotMatch(wxss, /(?:line-clamp|-webkit-line-clamp)/i)
  assert.doesNotMatch(wxss, /font-weight:\s*(?:650|750|780)/)
})

test('feedback text areas are bounded so the submit action stays reachable', () => {
  const wxss = read('pages/feedback/index.wxss')
  assert.match(wxss, /\.feedback-textarea\s*\{[^}]*height:\s*240rpx/s)
  assert.match(wxss, /\.steps-textarea\s*\{[^}]*height:\s*176rpx/s)
})
