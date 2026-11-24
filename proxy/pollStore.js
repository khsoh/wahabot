const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const DB_DIR = "/app/polldb";
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(path.join(DB_DIR, "polls.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS watched_polls (
    poll_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    selected_options TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, voter_id),
    FOREIGN KEY (poll_id) REFERENCES watched_polls(poll_id) ON DELETE CASCADE
  );
`);

const watchStmt = db.prepare(`
  INSERT INTO watched_polls (poll_id, expires_at, created_at)
  VALUES (?, ?, ?)
  ON CONFLICT(poll_id) DO UPDATE SET
    expires_at = excluded.expires_at
`);

const activeStmt = db.prepare(`
  SELECT 1 FROM watched_polls WHERE poll_id = ? AND expires_at > ?
`);

const listWatchedStmt = db.prepare(`
  SELECT
    w.poll_id,
    w.created_at,
    w.expires_at,
    COUNT(v.voter_id) AS vote_count
  FROM watched_polls w
  LEFT JOIN poll_votes v ON v.poll_id = w.poll_id
  WHERE w.expires_at > ?
  GROUP BY w.poll_id
  ORDER BY w.created_at DESC
`);

const upsertVoteStmt = db.prepare(`
  INSERT INTO poll_votes (poll_id, voter_id, selected_options, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(poll_id, voter_id) DO UPDATE SET
    selected_options = excluded.selected_options,
    updated_at = excluded.updated_at
`);

const deleteVoteStmt = db.prepare(`
  DELETE FROM poll_votes WHERE poll_id = ? AND voter_id = ?
`);

const getVotesStmt = db.prepare(`
  SELECT voter_id, selected_options, updated_at
  FROM poll_votes
  WHERE poll_id = ?
`);

const cleanupStmt = db.prepare(`
  DELETE FROM watched_polls WHERE expires_at <= ?
`);

/**
 * Register or extend the expiration of a poll to track.
 */
function watchPoll(pollId, ttlHours = 72) {
  const now = Date.now();
  const expiresAt = now + Number(ttlHours) * 60 * 60 * 1000;
  watchStmt.run(pollId, expiresAt, now);

  return {
    pollId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * Return all currently active (non-expired) watched polls and their vote counts.
 */
function getWatchedPolls() {
  const now = Date.now();
  return listWatchedStmt.all(now).map((row) => ({
    pollId: row.poll_id,
    voteCount: row.vote_count,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  }));
}

/**
 * Record or update a voter's selection if the poll is watched and not expired.
 */
function recordVoteEvent(payload) {
  if (!payload || !payload.poll || !payload.vote) return false;

  const pollId = payload.poll.id;
  const voterId = payload.vote.from;
  const options = payload.vote.selectedOptions || [];
  const now = Date.now();

  if (!activeStmt.get(pollId, now)) return false;

  if (options.length === 0) {
    deleteVoteStmt.run(pollId, voterId);
  } else {
    upsertVoteStmt.run(pollId, voterId, JSON.stringify(options), now);
  }
  return true;
}

/**
 * Return all stored votes for a given pollId.
 */
function getPollVotes(pollId) {
  return getVotesStmt.all(pollId).map((row) => ({
    voter: row.voter_id,
    selectedOptions: JSON.parse(row.selected_options),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/**
 * Delete expired polls (and cascade-delete their votes).
 */
function cleanupExpiredPolls() {
  const info = cleanupStmt.run(Date.now());
  if (info.changes > 0) db.pragma("optimize");
  return info.changes;
}

// Run cleanup hourly + once on startup (.unref() lets container exit cleanly on SIGTERM)
setInterval(cleanupExpiredPolls, 60 * 60 * 1000).unref();
cleanupExpiredPolls();

module.exports = {
  watchPoll,
  getWatchedPolls,
  recordVoteEvent,
  getPollVotes,
  cleanupExpiredPolls,
};
