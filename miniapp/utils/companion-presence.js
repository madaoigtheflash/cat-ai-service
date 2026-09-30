const MOTION_KEY = 'catai_showcase_reduce_motion_v1'
const greetings = [
  '喵，今天先从一件小事说起。',
  '耳朵借给你，慢慢说就好。',
  '也可以什么都不记，在这里待一会儿。'
]

function greeting(hour) {
  if (hour >= 5 && hour < 11) return '早上好，遇见了哪只猫？'
  if (hour >= 11 && hour < 18) return '歇一会儿，和我说说猫。'
  return '忙完啦？来，和我待一会儿。'
}

function reaction(index) { return greetings[Math.abs(Number(index) || 0) % greetings.length] }

module.exports = { MOTION_KEY, greeting, reaction }
