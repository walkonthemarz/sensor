-- Browser push subscriptions and the single alert state machine row.
--
-- Subscriptions are keyed by the push service endpoint. The `p256dh` and
-- `auth` values are the browser's encryption keys from `PushSubscription`.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row tracks the current poor-air episode. `level` is 'bad' once an alert
-- has been sent for the episode; it returns to 'clear' after the air has been
-- good for a while. `bad_since` and `clear_since` are the hysteresis timers.
CREATE TABLE IF NOT EXISTS alert_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    level TEXT NOT NULL DEFAULT 'clear' CHECK (level IN ('clear', 'bad')),
    bad_since TIMESTAMPTZ,
    clear_since TIMESTAMPTZ,
    last_notified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO alert_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
