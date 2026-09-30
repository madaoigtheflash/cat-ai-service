'use strict'

// Conservative, local rules. These are not model responses or image recognition.
const MEDICAL_NOTICE = '健康相关内容仅供记录，不能据此诊断或决定用药；出现异常请咨询兽医。'
const HELP = '我是虚拟猫小桃，现在只能按本地规则帮你整理。可以说“登记猫咪叫奶糖”，或“奶糖是团子的妈妈”。我会先给草稿，你确认后才保存；想自由聊聊时，可选择云端文字对话。'
const NAME = '[\\p{Script=Han}A-Za-z0-9·_-]{1,20}'
const REGISTER = new RegExp('^(?:登记|记录|添加)(?:一只)?猫咪(?:叫|名叫)(?<name>' + NAME + ')[。！!]?$', 'u')
const RELATION = new RegExp('^(?<from>' + NAME + ')是(?<to>' + NAME + ')的(?<role>妈妈|母亲|爸爸|父亲)[。！!]?$', 'u')

function cleanName(value) {
  if (typeof value !== 'string') throw new Error('猫咪名字格式无效。')
  const name = value.trim()
  if (!new RegExp('^' + NAME + '$', 'u').test(name)) throw new Error('猫咪名字请填写 1–20 个中文字、字母、数字或 · _ -。')
  return name
}

function parseIntent(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (/^(今天)?想放松一会儿[。！!]*$/.test(text)) return { kind: 'unknown', reply: '那就先不急着记什么。可以看看窗边的猫，或者说说今天遇见的小事。你随时都可以停下，这段话不会变成任务。' }
  if (!text || text.length > 2000) return { kind: 'unknown', reply: HELP }
  // Negation, uncertainty, questions and compound sentences never become actions.
  if (/[?？\n；;]/u.test(text) || /不要|别|不想|不是|可能|好像|也许|大概|是不是|是否|假如|如果|听说|似乎|难道|吗|么/u.test(text)) {
    return { kind: 'unknown', reply: '这句话包含疑问或不确定信息，我不会自动登记。请明确说明，或手动填写一张草稿再核对。' }
  }
  const pet = text.match(REGISTER)
  if (pet) return { kind: 'pet', fields: { name: pet.groups.name } }
  const relationship = text.match(RELATION)
  if (relationship) return { kind: 'relationship', fromName: relationship.groups.from, toName: relationship.groups.to,
    fields: { fromRole: /妈妈|母亲/u.test(relationship.groups.role) ? 'mother' : 'father', toRole: 'child', note: '用户陈述，尚未独立核实；不代表亲缘鉴定。' } }
  if (/病|药|吐|血|呼吸|不吃|疼|疫苗|诊断/u.test(text)) return { kind: 'unknown', reply: MEDICAL_NOTICE + '我可以保留这段对话，但不会自动建立诊疗或用药安排。' }
  return { kind: 'unknown', reply: HELP }
}

function coarseLocation(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -85 || latitude > 85 || longitude < -180 || longitude > 180) {
    throw new Error('位置无效；暂不支持纬度超过 85° 的地区。')
  }
  // Approximately 2 km cells, with longitude width adjusted at the cell latitude.
  const latitudeStep = 2 / 111.32
  const centerLat = (Math.floor((latitude + 90) / latitudeStep) + 0.5) * latitudeStep - 90
  const longitudeStep = 2 / (111.32 * Math.cos(centerLat * Math.PI / 180))
  const centerLon = Math.min(180, (Math.floor((longitude + 180) / longitudeStep) + 0.5) * longitudeStep - 180)
  return { latitude: Number(centerLat.toFixed(5)), longitude: Number(centerLon.toFixed(5)) }
}

module.exports = { MEDICAL_NOTICE, HELP, cleanName, parseIntent, coarseLocation }
