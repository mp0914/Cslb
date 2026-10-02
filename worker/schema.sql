-- Study progress for the CSLB practice portal (c33.website).
-- Single user, so user_id is a constant; it stays in the key so the
-- shape does not have to change if that ever stops being true.

-- One row per question that has been answered at least once.
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT    NOT NULL,
  qid     TEXT    NOT NULL,          -- exam:hash of the question text, stable across bank edits
  exam    TEXT    NOT NULL,          -- 'c33' | 'lawbiz'
  cat     TEXT    NOT NULL,          -- category slug, stored not keyed so re-tagging keeps history
  seen    INTEGER NOT NULL DEFAULT 0,
  wrong   INTEGER NOT NULL DEFAULT 0,
  streak  INTEGER NOT NULL DEFAULT 0, -- consecutive correct since the last miss
  last_ms INTEGER NOT NULL,           -- last answered, epoch ms; the merge clock
  last_ok INTEGER NOT NULL DEFAULT 0, -- was the most recent answer correct
  PRIMARY KEY (user_id, qid)
);
CREATE INDEX IF NOT EXISTS progress_user_exam ON progress(user_id, exam);

-- One row per finished quiz, for score history.
CREATE TABLE IF NOT EXISTS attempts (
  uid      TEXT    NOT NULL,          -- client-generated, makes the sync idempotent
  user_id  TEXT    NOT NULL,
  exam     TEXT    NOT NULL,
  mode     TEXT    NOT NULL,          -- category slug, 'all', or 'retest'
  total    INTEGER NOT NULL,
  correct  INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, uid)
);
CREATE INDEX IF NOT EXISTS attempts_user_exam ON attempts(user_id, exam, ended_ms DESC);
