-- Additive release features; existing diagnostics and recommendations are preserved.
CREATE TABLE IF NOT EXISTS assistant_conversations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 profession_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_conversations_owner ON assistant_conversations(account_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id UUID NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,
 question TEXT NOT NULL CHECK(length(question) <= 2000),
 answer TEXT NOT NULL CHECK(length(answer) <= 12000),
 sources JSONB NOT NULL DEFAULT '[]',
 status TEXT NOT NULL CHECK(status IN ('success','out_of_domain','needs_clarification','insufficient_data')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS assistant_messages_history ON assistant_messages(conversation_id, created_at DESC, id);
CREATE TABLE IF NOT EXISTS assistant_leases (
 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,
 route_id UUID REFERENCES education_routes(id) ON DELETE CASCADE,
 clarity SMALLINT NOT NULL CHECK(clarity BETWEEN 1 AND 5),
 recommendations SMALLINT NOT NULL CHECK(recommendations BETWEEN 1 AND 5),
 navigation SMALLINT NOT NULL CHECK(navigation BETWEEN 1 AND 5),
 usefulness SMALLINT NOT NULL CHECK(usefulness BETWEEN 1 AND 5),
 comment TEXT NOT NULL DEFAULT '' CHECK(length(comment) <= 2000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(session_id, request_id)
);

ALTER TABLE education_routes DROP CONSTRAINT IF EXISTS education_routes_profession_key_check;
ALTER TABLE education_routes ADD CONSTRAINT education_routes_profession_key_check CHECK (
 profession_key='none' OR profession_key ~ '^prof_[0-9]{3,4}$' OR
 profession_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
);
