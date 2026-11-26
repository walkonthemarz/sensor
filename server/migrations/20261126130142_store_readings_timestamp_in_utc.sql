-- The `timestamp` column holds naive UTC, but the original default was
-- `CURRENT_TIMESTAMP`, i.e. a timestamptz cast through the *session* timezone.
-- On a host whose Postgres session ran in a non-UTC zone (for example
-- `Asia/Shanghai`) that wrote local wall-clock time while the API kept
-- labelling it UTC, so the dashboard showed every reading shifted by the
-- offset. Make the default explicit UTC; the insert query pins UTC as well.
ALTER TABLE readings
    ALTER COLUMN timestamp SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- If rows were already written under a non-UTC session timezone, repair them
-- manually once (intentionally not part of the migration):
--
--   UPDATE readings
--   SET timestamp = (timestamp AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC';
--
-- Run it with the session timezone set to the one the writes actually used.
