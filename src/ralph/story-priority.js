function priorityScore(story = {}) {
  const explicit = Number.isFinite(story.priority) ? story.priority : null;
  if (explicit !== null) return Math.max(0, Math.min(1000, explicit));
  const labels = Array.isArray(story.labels) ? story.labels.map((label) => String(label).toLowerCase()) : [];
  let score = 100;
  if (labels.includes('p0') || labels.includes('urgent') || labels.includes('critical')) score -= 70;
  if (labels.includes('p1') || labels.includes('high')) score -= 40;
  if (labels.includes('p2') || labels.includes('medium')) score -= 10;
  if (labels.includes('blocked')) score += 500;
  if (story.status === 'waiting_approval') score += 200;
  if (story.status === 'failed' || story.current_phase === 'ESCALATED') score += 900;
  return score;
}

function compareStories(a, b) {
  const scoreDiff = priorityScore(a) - priorityScore(b);
  if (scoreDiff !== 0) return scoreDiff;
  const updatedA = new Date(a.updated_at || a.created_at || 0).getTime();
  const updatedB = new Date(b.updated_at || b.created_at || 0).getTime();
  return updatedA - updatedB;
}

function sortStoriesByPriority(stories = []) {
  return [...stories].sort(compareStories);
}

module.exports = {
  priorityScore,
  compareStories,
  sortStoriesByPriority
};
