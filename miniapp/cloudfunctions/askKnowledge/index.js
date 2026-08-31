const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const API_URL = 'https://api.minimaxi.com/v1/chat/completions'
const DEFAULT_MODEL = 'MiniMax-M3'

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.setTimeout(55000, () => request.destroy(new Error('模型请求超时')))
    request.on('error', reject)
    request.end(JSON.stringify(payload))
  })
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLength)
}

function safeSources(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 5).map(item => ({
    title: cleanText(item && item.title, 80),
    content: cleanText(item && item.content, 1200)
  })).filter(item => item.title && item.content)
}

async function callMiniMax(messages) {
  const apiKey = process.env.MINIMAX_API_KEY
  const model = process.env.MINIMAX_MODEL || DEFAULT_MODEL
  if (!apiKey) throw new Error('云函数尚未配置 MINIMAX_API_KEY')

  const response = await postJson(API_URL, {
      model,
      messages,
      max_completion_tokens: 2048,
      temperature: 0.2,
      thinking: { type: 'disabled' },
      reasoning_split: true
    }, { Authorization: `Bearer ${apiKey}` })
  const text = response.text
  let data
  try { data = JSON.parse(text) } catch (error) { throw new Error(`模型返回无法解析（HTTP ${response.status}）`) }
  if (response.status < 200 || response.status >= 300) {
    const message = data && (data.message || (data.error && data.error.message))
    throw new Error(`模型请求失败（HTTP ${response.status}）：${cleanText(message, 180) || '未知错误'}`)
  }
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (!content || !String(content).trim()) throw new Error('模型返回了空答案，请重试')
  return { content: String(content).trim(), model }
}

exports.main = async event => {
  if (event && event.action === 'health') {
    return {
      success: true,
      status: 'running',
      service: 'cloudbase',
      environment: process.env.TCB_ENV || 'current',
      model: process.env.MINIMAX_MODEL || DEFAULT_MODEL,
      modelConfigured: Boolean(process.env.MINIMAX_API_KEY)
    }
  }

  const query = cleanText(event && event.query, 300)
  const breed = cleanText(event && event.breed, 80)
  if (!query) return { success: false, error: '问题不能为空' }

  const sources = safeSources(event && event.sources)
  const context = sources.length
    ? sources.map(item => `【来源：${item.title}】\n${item.content}`).join('\n\n')
    : '（本地知识库没有检索到直接相关内容）'

  try {
    const result = await callMiniMax([
      {
        role: 'system',
        content: '你是一位谨慎的猫咪知识顾问。优先依据给出的知识库片段回答；不要编造诊断或用药剂量；涉及呼吸困难、尿闭、抽搐、中毒、严重外伤等紧急风险时明确提示立即联系宠物医院。用简洁中文回答，并在相关句末标注【来源标题】。'
      },
      {
        role: 'user',
        content: `当前猫咪品种：${breed || '未指定'}\n\n知识库片段：\n${context}\n\n用户问题：${query}`
      }
    ])
    return { success: true, answer: result.content, model_used: `minimax/${result.model}`, sources }
  } catch (error) {
    console.error('askKnowledge failed:', error && error.message)
    return { success: false, error: cleanText(error && error.message, 240) || 'AI 问答失败' }
  }
}
