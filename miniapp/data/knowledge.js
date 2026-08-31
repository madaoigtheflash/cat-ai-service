const articles = [
  {
    id: 'food-toxic', category: '饮食', icon: '⚠️', title: '猫咪绝对不能吃的食物',
    keywords: '巧克力 可可碱 洋葱 大蒜 葡萄 葡萄干 酒精 咖啡因 木糖醇 百合 有毒 禁忌',
    summary: '巧克力、葱蒜、葡萄、酒精、咖啡因和木糖醇等可能导致严重中毒。',
    content: '巧克力中的可可碱、洋葱和大蒜中的含硫化合物、葡萄与葡萄干、酒精、咖啡因、木糖醇都不应喂猫。百合对猫尤其危险，花粉和插花水也可能造成严重伤害。怀疑误食时不要自行催吐，应立即联系宠物医院。'
  },
  {
    id: 'feeding', category: '饮食', icon: '🥣', title: '日常喂养原则',
    keywords: '喂食 猫粮 饮水 罐头 营养 肥胖',
    summary: '以完整均衡的猫粮为主，保持饮水并控制零食和总热量。',
    content: '猫是专性食肉动物，应选择符合生命阶段的完整均衡主粮。湿粮有助于增加水分摄入。换粮建议逐步过渡，避免突然改变造成胃肠不适。持续记录体重和体态，比单看饭量更可靠。'
  },
  {
    id: 'vaccine', category: '健康', icon: '💉', title: '疫苗与免疫记录',
    keywords: '疫苗 猫三联 狂犬 免疫 加强针',
    summary: '基础免疫和加强计划应由兽医结合年龄、健康和生活环境制定。',
    content: '幼猫通常需要完成基础免疫系列，之后根据疫苗类型、地区法规和暴露风险安排加强。接种前应确认猫咪状态稳定，并保留疫苗名称、日期、批次和下次提醒。具体方案请咨询执业兽医。'
  },
  {
    id: 'deworming', category: '健康', icon: '💊', title: '驱虫注意事项',
    keywords: '驱虫 体内 体外 跳蚤 蜱虫 寄生虫',
    summary: '驱虫频率取决于外出、捕猎、生食和多宠环境等风险。',
    content: '选择猫专用驱虫产品并严格按体重使用。不要将含有对猫有害成分的犬用产品用于猫。出现流涎、震颤、步态异常等情况应立即就医，并携带产品包装。'
  },
  {
    id: 'emergency', category: '健康', icon: '🚑', title: '这些情况需要尽快就医',
    keywords: '急诊 呼吸困难 尿闭 抽搐 中毒 外伤 不吃饭 呕吐',
    summary: '呼吸困难、无法排尿、抽搐、中毒和严重外伤属于高优先级。',
    content: '张口呼吸或明显呼吸困难、反复进出猫砂盆却无法排尿、抽搐、意识异常、疑似中毒、持续大量出血或高处坠落后状态异常，都不适合只在线查询，应立即联系附近宠物医院。'
  },
  {
    id: 'weight', category: '健康', icon: '⚖️', title: '体重与体态管理',
    keywords: '体重 肥胖 减肥 体态 消瘦',
    summary: '固定条件定期称重，结合肋骨触感和腰线观察变化。',
    content: '建议使用同一台秤、相近时间和相近进食状态记录体重。快速下降或上升都值得关注。减重应循序渐进，猫咪长期不进食可能发生严重代谢问题，不应通过断食减肥。'
  },
  {
    id: 'lihua', category: '品种', icon: '🐯', title: '中华田园猫 · 狸花猫',
    keywords: '中华田园猫 狸花 猫 虎斑 本土猫',
    summary: '常见棕黑色鱼骨纹或斑纹，体格结实，个体差异很大。',
    content: '狸花猫通常具有清晰的额头纹路、眼线和身体斑纹，但花纹本身不能替代血统判断。田园猫的性格、体型和健康差异主要取决于个体、成长经历和饲养环境。'
  },
  {
    id: 'british', category: '品种', icon: '🧸', title: '英国短毛猫',
    keywords: '英国短毛猫 英短 蓝猫 金渐层 银渐层',
    summary: '体型紧凑、被毛浓密，面部轮廓圆润，不同毛色标准不同。',
    content: '英国短毛猫常见蓝色、银渐层、金渐层等毛色。仅凭照片容易与其他短毛猫混淆，应结合头脸结构、骨量、被毛质感和可靠来源综合判断。体重管理和定期体检十分重要。'
  },
  {
    id: 'ragdoll', category: '品种', icon: '🎀', title: '布偶猫',
    keywords: '布偶猫 重点色 蓝眼 长毛',
    summary: '常见蓝眼、重点色和半长毛，需要规律梳理被毛。',
    content: '布偶猫有重点色、手套色、双色等花色类型，颜色会随年龄逐渐加深。长毛需要定期梳理。品种识别不能只依据蓝眼或脸部白色倒V，应结合整体特征。'
  },
  {
    id: 'photo', category: '识别', icon: '📷', title: '怎样拍出更容易识别的照片',
    keywords: '拍照 识别 清晰 正面 侧面 光线',
    summary: '保持光线均匀、主体完整，一张照片只拍一只猫。',
    content: '尽量在自然光或均匀室内光下拍摄，避免逆光、强滤镜和运动模糊。品种辅助识别建议包含正面和全身；个体识别建档应补充左右侧面和跨时间照片。'
  }
];

const categories = ['全部', '饮食', '健康', '品种', '识别'];

function search(query, category) {
  const keyword = String(query || '').trim().toLowerCase();
  const candidates = articles.filter(article => !category || category === '全部' || article.category === category);
  if (!keyword) return candidates;

  const compact = keyword.replace(/[\s，。！？、；：,.!?;:的了吗呢呀和与及是一只这那请问怎么如何什么]+/g, '');
  const words = keyword.split(/[\s，。！？、；：,.!?;:]+/).filter(term => term.length >= 2);
  const grams = [];
  for (let index = 0; index < compact.length - 1; index += 1) grams.push(compact.slice(index, index + 2));
  const terms = Array.from(new Set(words.concat(grams))).slice(0, 30);

  return candidates.map(article => {
    const title = article.title.toLowerCase();
    const tags = article.keywords.toLowerCase();
    const body = `${article.summary} ${article.content}`.toLowerCase();
    let score = 0;
    if (title.indexOf(keyword) >= 0) score += 20;
    if (tags.indexOf(keyword) >= 0) score += 15;
    if (body.indexOf(keyword) >= 0) score += 8;
    terms.forEach(term => {
      if (title.indexOf(term) >= 0) score += 5;
      if (tags.indexOf(term) >= 0) score += 4;
      if (body.indexOf(term) >= 0) score += 1;
    });
    return { article, score };
  }).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map(item => item.article);
}

module.exports = { articles, categories, search };
