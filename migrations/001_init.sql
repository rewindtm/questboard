-- Questboard: schema iniziale

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  discord_id    TEXT UNIQUE,                 -- NULL per gli account locali (uso senza Discord)
  username      TEXT,
  display_name  TEXT,
  avatar        TEXT,
  local_login   TEXT UNIQUE,                 -- login locale opzionale (ENABLE_LOCAL_AUTH)
  password_hash TEXT,
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE, -- impostato solo dal bootstrap in .env
  CHECK (discord_id IS NOT NULL OR local_login IS NOT NULL),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id               BIGSERIAL PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description      TEXT NOT NULL DEFAULT '',
  code_prefix      TEXT NOT NULL DEFAULT 'TASK' CHECK (code_prefix ~ '^[A-Z0-9]{2,8}$'),
  task_seq         INTEGER NOT NULL DEFAULT 0,
  categories       TEXT[] NOT NULL DEFAULT ARRAY['Gameplay','Multiplayer','UI / UX','Audio','Bug'],
  discord_guild_id TEXT,
  discord_forum_id TEXT,
  discord_tag_map  JSONB NOT NULL DEFAULT '{"status":{},"priority":{}}'::jsonb,
  created_by       BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_members (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('admin','developer','tester')),
  can_approve BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

CREATE TABLE builds (
  id         BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind       TEXT NOT NULL DEFAULT 'build' CHECK (kind IN ('build','milestone')),
  due_date   DATE,
  released   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE tasks (
  id                 BIGSERIAL PRIMARY KEY,
  project_id         BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  code               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  checklist          JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority           TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  status             TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','done')),
  category           TEXT NOT NULL DEFAULT '',
  assignee_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  due_date           DATE,
  build_id           BIGINT REFERENCES builds(id) ON DELETE SET NULL,
  author_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  version            INTEGER NOT NULL DEFAULT 1,
  archived_at        TIMESTAMPTZ,
  -- Discord
  sync_ref           UUID NOT NULL DEFAULT gen_random_uuid(),
  discord_thread_id  TEXT,
  discord_message_id TEXT,
  discord_url        TEXT,
  sync_status        TEXT NOT NULL DEFAULT 'none'
                     CHECK (sync_status IN ('none','pending','synced','error','missing')),
  sync_error         TEXT,
  synced_version     INTEGER,
  publish_started_at TIMESTAMPTZ,
  UNIQUE (project_id, seq),
  UNIQUE (project_id, code),
  UNIQUE (sync_ref)
);
CREATE INDEX tasks_project_idx ON tasks(project_id, archived_at);
CREATE UNIQUE INDEX tasks_thread_idx ON tasks(discord_thread_id) WHERE discord_thread_id IS NOT NULL;

CREATE TABLE task_events (
  id         BIGSERIAL PRIMARY KEY,
  task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  source     TEXT NOT NULL CHECK (source IN ('web','discord','system')),
  type       TEXT NOT NULL,
  changes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events(task_id, id DESC);

-- Outbox Discord: al massimo una riga attiva per task (serializzazione + coalescing:
-- il worker sincronizza sempre l'ultima versione del task).
CREATE TABLE outbox (
  id              BIGSERIAL PRIMARY KEY,
  task_id         BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('publish','update','repost')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','error')),
  dirty           BOOLEAN NOT NULL DEFAULT FALSE,
  mention_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outbox_active_task_idx ON outbox(task_id) WHERE status IN ('pending','processing');
CREATE INDEX outbox_due_idx ON outbox(next_attempt_at) WHERE status = 'pending';

-- Sessioni (connect-pg-simple)
CREATE TABLE session (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session(expire);
