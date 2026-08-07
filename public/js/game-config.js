const SCORE_THRESHOLDS = Object.freeze([
  Object.freeze({ minimumSeconds: 8, points: 10 }),
  Object.freeze({ minimumSeconds: 6, points: 8 }),
  Object.freeze({ minimumSeconds: 4, points: 6 }),
  Object.freeze({ minimumSeconds: 2, points: 4 }),
  Object.freeze({ minimumSeconds: 0, points: 2 }),
]);

const HARD_SAKUGABOORU_FILTER = Object.freeze({
  // 负标签排除原画/线稿/分镜/制作资料类视频，确保截图是成品动画画面
  tags: "-genga -production_materials -layout -douga -storyboard -genga_comparison",
  startDate: "",
  endDate: "",
  // 最低热度过滤低分/未审批内容，进一步避开制作资料帖
  minScore: 5,
  maxScore: null,
  rating: "s",
});

export const GAME_CONFIG = Object.freeze({
  localQuestionCount: 50,
  localPreloadCount: 5,
  answerFeedbackMs: 1000,
  questionSeconds: 10,
  scoreThresholds: SCORE_THRESHOLDS,
  hard: Object.freeze({
    batchSize: 20,
    minRankQuestions: 50,
    sakugabooruFilter: HARD_SAKUGABOORU_FILTER,
  }),
  leaderboard: Object.freeze({
    timeZone: "Asia/Shanghai",
    cacheSeconds: 30,
    retentionDays: 7,
  }),
});

validateGameConfig(GAME_CONFIG);

function validateGameConfig(config) {
  assertPositiveInteger(config.localQuestionCount, "localQuestionCount");
  assertPositiveInteger(config.localPreloadCount, "localPreloadCount");
  if (config.localPreloadCount > config.localQuestionCount) {
    throw new Error("GAME_CONFIG.localPreloadCount 不能超过 localQuestionCount");
  }
  assertPositiveInteger(config.answerFeedbackMs, "answerFeedbackMs");
  if (!(Number.isFinite(config.questionSeconds) && config.questionSeconds > 0)) {
    throw new Error("GAME_CONFIG.questionSeconds 必须是正数");
  }
  if (!Array.isArray(config.scoreThresholds) || config.scoreThresholds.length === 0) {
    throw new Error("GAME_CONFIG.scoreThresholds 不能为空");
  }

  let previousMinimum = Number.POSITIVE_INFINITY;
  let previousPoints = Number.POSITIVE_INFINITY;
  for (const [index, tier] of config.scoreThresholds.entries()) {
    const minimum = Number(tier?.minimumSeconds);
    const points = Number(tier?.points);
    if (!(Number.isFinite(minimum) && minimum >= 0 && minimum < previousMinimum && minimum <= config.questionSeconds)) {
      throw new Error(`GAME_CONFIG.scoreThresholds[${index}].minimumSeconds 必须严格降序且位于倒计时范围内`);
    }
    if (!(Number.isSafeInteger(points) && points > 0 && points < previousPoints)) {
      throw new Error(`GAME_CONFIG.scoreThresholds[${index}].points 必须是严格降序的正整数`);
    }
    previousMinimum = minimum;
    previousPoints = points;
  }
  if (previousMinimum !== 0) {
    throw new Error("GAME_CONFIG.scoreThresholds 最后一档 minimumSeconds 必须为 0");
  }

  assertPositiveInteger(config.hard?.batchSize, "hard.batchSize");
  assertPositiveInteger(config.hard?.minRankQuestions, "hard.minRankQuestions");
  assertPositiveInteger(config.leaderboard?.cacheSeconds, "leaderboard.cacheSeconds");
  assertPositiveInteger(config.leaderboard?.retentionDays, "leaderboard.retentionDays");
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.leaderboard.timeZone }).format();
  } catch {
    throw new Error("GAME_CONFIG.leaderboard.timeZone 不是有效时区");
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GAME_CONFIG.${fieldName} 必须是正整数`);
  }
}
