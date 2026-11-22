-- Support the hourly retention delete and time-range lookups.
CREATE INDEX IF NOT EXISTS readings_timestamp_idx ON readings (timestamp);
