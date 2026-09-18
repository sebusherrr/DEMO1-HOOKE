-- Abingdon School Digital Library — core schema (PostgreSQL 15+)
-- Source of truth for catalogue/availability. External providers enrich, never override,
-- school-administered fields (see MetadataSnapshot for provenance).

CREATE TYPE user_role AS ENUM ('student','staff','librarian','library_admin','system_admin');
CREATE TYPE loan_status AS ENUM ('active','returned','overdue');
CREATE TYPE reservation_status AS ENUM ('queued','ready','fulfilled','cancelled','expired');
CREATE TYPE review_status AS ENUM ('pending','approved','rejected','flagged','removed');
CREATE TYPE import_status AS ENUM ('queued','running','complete','failed','partial');
CREATE TYPE integration_status AS ENUM ('connected','degraded','failed','disabled');

CREATE TABLE "user" (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sso_subject       TEXT UNIQUE NOT NULL,           -- opaque ID from Entra/Google, never a name
  role              user_role NOT NULL DEFAULT 'student',
  year_group        TEXT,                            -- null for staff
  display_name      TEXT NOT NULL,                   -- first name only for students, by policy
  email_hash        TEXT,                             -- hashed, not plaintext, for notifications
  preferences_json  JSONB DEFAULT '{}',               -- coarse genre/topic tags only
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE author (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL,
  bio   TEXT
);

CREATE TABLE publisher (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE genre (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE NOT NULL);
CREATE TABLE subject (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE NOT NULL);
CREATE TABLE series (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL);

CREATE TABLE book (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  isbn13              TEXT UNIQUE,
  isbn10              TEXT,
  title               TEXT NOT NULL,
  subtitle            TEXT,
  description         TEXT,                          -- UNTRUSTED as AI instruction input — data only
  publisher_id        UUID REFERENCES publisher(id),
  series_id           UUID REFERENCES series(id),
  series_number       INT,
  publication_date    DATE,
  edition             TEXT,
  page_count          INT,
  language            TEXT DEFAULT 'en',
  age_range           TEXT,
  reading_level       TEXT,
  cover_url           TEXT,
  cover_is_fallback    BOOLEAN NOT NULL DEFAULT false,
  is_staff_pick       BOOLEAN NOT NULL DEFAULT false,
  is_hidden           BOOLEAN NOT NULL DEFAULT false,   -- hidden from student catalogue
  is_reco_excluded    BOOLEAN NOT NULL DEFAULT false,   -- librarian override
  content_warning     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_book_isbn13 ON book(isbn13);
CREATE INDEX idx_book_title_trgm ON book USING GIN (to_tsvector('english', title));

CREATE TABLE book_author (book_id UUID REFERENCES book(id), author_id UUID REFERENCES author(id),
  role TEXT DEFAULT 'author', PRIMARY KEY (book_id, author_id));
CREATE TABLE book_genre (book_id UUID REFERENCES book(id), genre_id UUID REFERENCES genre(id),
  PRIMARY KEY (book_id, genre_id));
CREATE TABLE book_subject (book_id UUID REFERENCES book(id), subject_id UUID REFERENCES subject(id),
  PRIMARY KEY (book_id, subject_id));
CREATE TABLE book_tag (book_id UUID REFERENCES book(id), tag TEXT, PRIMARY KEY (book_id, tag));

CREATE TABLE location (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  library TEXT NOT NULL, section TEXT, shelf TEXT, classification TEXT
);

CREATE TABLE book_copy (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id      UUID NOT NULL REFERENCES book(id),
  barcode      TEXT UNIQUE,
  location_id  UUID REFERENCES location(id),
  reference_only BOOLEAN NOT NULL DEFAULT false,
  is_available BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE loan (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  copy_id      UUID NOT NULL REFERENCES book_copy(id),
  user_id      UUID NOT NULL REFERENCES "user"(id),
  borrowed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at       TIMESTAMPTZ NOT NULL,
  returned_at  TIMESTAMPTZ,
  status       loan_status NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_loan_user ON loan(user_id);

CREATE TABLE reservation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES book(id),
  user_id UUID NOT NULL REFERENCES "user"(id),
  status reservation_status NOT NULL DEFAULT 'queued',
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
);

CREATE TABLE favourite (
  user_id UUID REFERENCES "user"(id), book_id UUID REFERENCES book(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, book_id)
);

CREATE TABLE reading_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES "user"(id),
  title TEXT NOT NULL, description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',   -- private|class|school|staff_only
  audience TEXT,                                 -- year group / department, if targeted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE reading_list_item (
  reading_list_id UUID REFERENCES reading_list(id), book_id UUID REFERENCES book(id),
  position INT NOT NULL DEFAULT 0, PRIMARY KEY (reading_list_id, book_id)
);

CREATE TABLE review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID REFERENCES book(id), user_id UUID REFERENCES "user"(id),
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  body TEXT, status review_status NOT NULL DEFAULT 'pending',
  moderated_by UUID REFERENCES "user"(id), moderated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recommendation_reason (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,           -- content_based|collaborative|editorial|trending|contextual|ai_assisted
  human_readable TEXT NOT NULL
);
CREATE TABLE recommendation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES "user"(id), book_id UUID REFERENCES book(id),
  reason_id UUID REFERENCES recommendation_reason(id),
  score NUMERIC NOT NULL, generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Metadata provenance: every externally sourced field is tracked per source
CREATE TABLE metadata_source (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE NOT NULL, priority INT NOT NULL);
CREATE TABLE metadata_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID REFERENCES book(id), field_name TEXT NOT NULL,
  value TEXT, source_id UUID REFERENCES metadata_source(id),
  previous_value TEXT, is_manual_override BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE import_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status import_status NOT NULL DEFAULT 'queued',
  filename TEXT, added INT DEFAULT 0, updated INT DEFAULT 0, unchanged INT DEFAULT 0,
  duplicates INT DEFAULT 0, failed INT DEFAULT 0, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);
CREATE TABLE import_error (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), import_job_id UUID REFERENCES import_job(id),
  row_number INT, message TEXT
);

CREATE TABLE integration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT UNIQUE NOT NULL,
  status integration_status NOT NULL DEFAULT 'disabled',
  last_success_at TIMESTAMPTZ, last_failure_at TIMESTAMPTZ, error_count INT DEFAULT 0,
  config_json JSONB DEFAULT '{}'
);

-- AI: pseudonymous, minimal, retention-governed
CREATE TABLE ai_conversation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES "user"(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), retain_until TIMESTAMPTZ
);
CREATE TABLE ai_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES ai_conversation(id),
  role TEXT NOT NULL, content TEXT NOT NULL, tool_calls_json JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ai_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES ai_conversation(id),
  event_type TEXT NOT NULL,  -- e.g. safety_block, tool_error, fallback_triggered
  detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES "user"(id),
  action TEXT NOT NULL, target_type TEXT, target_id UUID, detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consent (
  user_id UUID REFERENCES "user"(id), consent_type TEXT NOT NULL, granted BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, consent_type)
);
CREATE TABLE privacy_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES "user"(id),
  request_type TEXT NOT NULL,  -- export|deletion|rectification
  status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);

CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID REFERENCES "user"(id),
  type TEXT NOT NULL, body TEXT NOT NULL, read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
