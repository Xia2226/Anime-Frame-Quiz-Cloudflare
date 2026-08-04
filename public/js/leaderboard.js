const PARTICIPANT_STORAGE_KEY = "anime-frame-quiz.participant-id.v1";
const PROFILE_STORAGE_KEY = "anime-frame-quiz.leaderboard-profile.v1";

let memoryParticipantId = "";
let memoryProfile = { resolved: false, username: "" };

export function getParticipantId() {
  if (memoryParticipantId) return memoryParticipantId;
  try {
    const stored = localStorage.getItem(PARTICIPANT_STORAGE_KEY);
    if (isUuid(stored)) {
      memoryParticipantId = stored;
      return stored;
    }
  } catch {
    // Fall back to an in-memory id when storage is blocked.
  }
  memoryParticipantId = crypto.randomUUID();
  try {
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, memoryParticipantId);
  } catch {
    // The id remains valid for this page lifetime.
  }
  return memoryParticipantId;
}

export function readLeaderboardProfile() {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY) || "null");
    if (stored && stored.resolved === true) {
      memoryProfile = { resolved: true, username: normalizeUsername(stored.username) };
    }
  } catch {
    // Keep the in-memory profile.
  }
  return { ...memoryProfile };
}

export function saveLeaderboardProfile(username) {
  memoryProfile = { resolved: true, username: normalizeUsername(username) };
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(memoryProfile));
  } catch {
    // The prompt will still stay resolved for this page lifetime.
  }
  return { ...memoryProfile };
}

export async function submitLeaderboardResult(result, signal = undefined) {
  const profile = readLeaderboardProfile();
  if (!profile.username) return getLeaderboard(result.mode, signal);
  return requestLeaderboard(`?mode=${encodeURIComponent(result.mode)}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      participantId: getParticipantId(),
      username: profile.username,
      score: Math.round(result.score || 0),
      correctCount: Math.round(result.correct || 0),
      questionCount: Math.round(result.answered || 0),
      elapsedMs: Math.round(result.elapsedMs || 0),
    }),
  });
}

export function getLeaderboard(mode, signal = undefined) {
  return requestLeaderboard(`?mode=${encodeURIComponent(mode)}`, { signal });
}

export function normalizeUsername(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, 20)
    : "";
}

async function requestLeaderboard(query, options) {
  const { headers = {}, ...requestOptions } = options || {};
  const response = await fetch(`/api/leaderboard${query}`, {
    ...requestOptions,
    headers: { Accept: "application/json", ...headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `排行榜请求失败（HTTP ${response.status}）`);
  return {
    dayKey: String(data?.dayKey || ""),
    mode: String(data?.mode || ""),
    entries: Array.isArray(data?.entries) ? data.entries : [],
    personalBest: data?.personalBest || null,
  };
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
