-- Create readings table
CREATE TABLE IF NOT EXISTS readings (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    eco2 SMALLINT,
    ech2o SMALLINT,
    tvoc SMALLINT,
    pm2_5 SMALLINT,
    pm10 SMALLINT,
    temperature REAL,
    humidity REAL
);
