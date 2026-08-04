const DEFAULT_SCORE_TIERS = [
  { minimumSeconds: 8, points: 10 },
  { minimumSeconds: 6, points: 8 },
  { minimumSeconds: 4, points: 6 },
  { minimumSeconds: 2, points: 4 },
  { minimumSeconds: 0, points: 2 },
];

export class QuizEngine {
  constructor(options) {
    this.mode = options.mode;
    this.provider = options.provider;
    this.questionLimit = Number.isInteger(options.questionLimit) ? options.questionLimit : null;
    this.timed = options.timed === true;
    this.questionSeconds = Number(options.questionSeconds) || 10;
    this.scoreTiers = Array.isArray(options.scoreTiers) ? options.scoreTiers : DEFAULT_SCORE_TIERS;
    this.feedbackMs = Number(options.feedbackMs) || 750;
    this.callbacks = options.callbacks || {};
    this.generation = 0;
    this.timerId = null;
    this.feedbackId = null;
    this.resetState();
  }

  resetState() {
    this.started = false;
    this.stopped = false;
    this.loading = false;
    this.locked = true;
    this.current = null;
    this.answered = 0;
    this.correct = 0;
    this.score = 0;
    this.elapsedMs = 0;
    this.questionStartedAt = 0;
    this.deadline = 0;
    this.answers = [];
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.callbacks.onState?.(this.snapshot());
    await this.loadNextQuestion();
  }

  async loadNextQuestion() {
    if (this.stopped || this.loading) return;
    if (this.questionLimit !== null && this.answered >= this.questionLimit) {
      this.complete();
      return;
    }

    const generation = ++this.generation;
    this.loading = true;
    this.locked = true;
    this.current = null;
    this.clearQuestionTimer();
    this.callbacks.onLoading?.(this.snapshot());
    this.callbacks.onState?.(this.snapshot());

    try {
      const question = await this.provider.next();
      if (this.stopped || generation !== this.generation) return;
      if (!question) throw new Error("题目提供器没有返回下一题");
      this.current = question;
      await this.callbacks.onQuestion?.(question, this.snapshot());
      if (this.stopped || generation !== this.generation) return;
      this.loading = false;
      this.locked = false;
      this.questionStartedAt = performance.now();
      this.deadline = this.timed
        ? this.questionStartedAt + this.questionSeconds * 1000
        : 0;
      if (this.timed) {
        this.emitTimer();
        this.timerId = window.setInterval(() => this.tickTimer(), 100);
      }
      this.callbacks.onState?.(this.snapshot());
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.loading = false;
      this.locked = true;
      this.callbacks.onError?.(error, this.snapshot());
      this.callbacks.onState?.(this.snapshot());
    }
  }

  answer(selectedId, reason = "answer") {
    if (this.stopped || this.loading || this.locked || !this.current) return false;
    const now = performance.now();
    const remainingMs = this.timed ? Math.max(0, this.deadline - now) : null;
    const expired = this.timed && !(remainingMs > 0);
    const effectiveSelectedId = expired ? null : selectedId;
    const effectiveReason = expired ? "timeout" : reason;
    const spentMs = Math.max(0, now - this.questionStartedAt);
    const boundedSpentMs = this.timed
      ? Math.min(this.questionSeconds * 1000, spentMs)
      : spentMs;
    const isCorrect = effectiveSelectedId !== null
      && String(effectiveSelectedId) === String(this.current.answerId);
    const points = isCorrect && this.timed
      ? calculateScore(remainingMs / 1000, this.scoreTiers)
      : 0;

    this.locked = true;
    this.clearQuestionTimer();
    this.answered += 1;
    if (isCorrect) this.correct += 1;
    this.score += points;
    this.elapsedMs += boundedSpentMs;

    const selectedOption = effectiveSelectedId === null ? null
      : this.current.options?.find((option) => String(option.id) === String(effectiveSelectedId));
    const answer = {
      selectedId: effectiveSelectedId === null ? null : String(effectiveSelectedId),
      selectedTitle: typeof selectedOption?.title === "string" ? selectedOption.title : "",
      answerId: String(this.current.answerId),
      isCorrect,
      points,
      remainingMs,
      reason: effectiveReason,
      question: summarizeQuestion(this.current),
    };
    this.answers.push(answer);
    this.callbacks.onFeedback?.(answer, this.snapshot());
    this.callbacks.onState?.(this.snapshot());

    this.feedbackId = window.setTimeout(() => {
      this.feedbackId = null;
      if (!this.stopped) void this.loadNextQuestion();
    }, this.feedbackMs);
    return true;
  }

  skip() {
    return this.answer(null, "skip");
  }

  async retry() {
    if (this.stopped || this.loading || !this.started) return;
    if (!this.current) {
      await this.loadNextQuestion();
      return;
    }

    const generation = ++this.generation;
    this.loading = true;
    this.locked = true;
    this.clearQuestionTimer();
    this.callbacks.onLoading?.(this.snapshot());
    this.callbacks.onState?.(this.snapshot());
    try {
      await this.callbacks.onQuestion?.(this.current, this.snapshot());
      if (this.stopped || generation !== this.generation) return;
      this.loading = false;
      this.locked = false;
      this.questionStartedAt = performance.now();
      this.deadline = this.timed
        ? this.questionStartedAt + this.questionSeconds * 1000
        : 0;
      if (this.timed) {
        this.emitTimer();
        this.timerId = window.setInterval(() => this.tickTimer(), 100);
      }
      this.callbacks.onState?.(this.snapshot());
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.loading = false;
      this.locked = true;
      this.callbacks.onError?.(error, this.snapshot());
      this.callbacks.onState?.(this.snapshot());
    }
  }

  finish() {
    if (this.stopped || !this.started) return;
    this.complete();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.clearQuestionTimer();
    if (this.feedbackId !== null) {
      clearTimeout(this.feedbackId);
      this.feedbackId = null;
    }
    this.provider.stop?.();
  }

  syncTimer() {
    if (this.timed && !this.stopped && !this.locked) this.tickTimer();
  }

  snapshot() {
    const remainingMs = this.timed && this.deadline
      ? Math.max(0, this.deadline - performance.now())
      : null;
    return {
      mode: this.mode,
      started: this.started,
      stopped: this.stopped,
      loading: this.loading,
      locked: this.locked,
      answered: this.answered,
      correct: this.correct,
      accuracy: this.answered ? this.correct / this.answered : 0,
      score: this.score,
      elapsedMs: Math.round(this.elapsedMs),
      questionNumber: this.answered + (this.current && !this.locked ? 1 : 0),
      questionLimit: this.questionLimit,
      remainingMs,
      bufferedCount: Number(this.provider.bufferedCount) || 0,
      current: this.current,
    };
  }

  tickTimer() {
    if (this.stopped || this.locked || !this.current) return;
    const remainingMs = this.deadline - performance.now();
    if (remainingMs <= 0) {
      this.callbacks.onTimer?.(0, 0, this.snapshot());
      this.answer(null, "timeout");
      return;
    }
    this.emitTimer();
  }

  emitTimer() {
    const remainingMs = Math.max(0, this.deadline - performance.now());
    this.callbacks.onTimer?.(
      remainingMs,
      Math.min(1, remainingMs / (this.questionSeconds * 1000)),
      this.snapshot(),
    );
  }

  clearQuestionTimer() {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  complete() {
    if (this.stopped) return;
    const result = this.snapshot();
    this.stop();
    this.callbacks.onComplete?.({
      ...result,
      stopped: true,
      completedAt: new Date().toISOString(),
      answers: this.answers.slice(),
    });
  }
}

function summarizeQuestion(question) {
  const imageUrl = typeof question?.imageUrl === "string" && question.imageUrl
    ? question.imageUrl
    : Array.isArray(question?.imageCandidates)
      ? question.imageCandidates.find((candidate) => typeof candidate === "string" && candidate) || ""
      : "";
  return {
    id: String(question?.id || ""),
    title: String(question?.title || ""),
    imageUrl,
    tags: normalizeHistoryTags(question?.tags),
    copyrightTags: normalizeHistoryTags(question?.copyrightTags),
  };
}

function normalizeHistoryTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean),
  )].slice(0, 5);
}

export function calculateScore(remainingSeconds, tiers = DEFAULT_SCORE_TIERS) {
  if (!(remainingSeconds > 0)) return 0;
  for (const tier of tiers) {
    if (remainingSeconds >= Number(tier.minimumSeconds)) return Number(tier.points) || 0;
  }
  return 0;
}
