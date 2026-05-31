CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE readings (
    id SERIAL PRIMARY KEY,
    decibel_level FLOAT NOT NULL,
    location GEOMETRY(Point, 4326) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX readings_location_idx ON readings USING GIST (location);
