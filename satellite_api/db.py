import sqlite3
import os

DB_PATH = "maneuvers.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS pending_maneuvers (
            burn_id TEXT PRIMARY KEY,
            ts REAL,
            sat_id TEXT,
            dvx REAL,
            dvy REAL,
            dvz REAL
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS maneuver_history (
            burn_id TEXT PRIMARY KEY,
            satellite_id TEXT,
            burnTime TEXT,
            dvx REAL, dvy REAL, dvz REAL,
            status TEXT
        )
    ''')
    conn.commit()
    conn.close()

def add_pending_maneuver(ts, sat_id, dvx, dvy, dvz, burn_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO pending_maneuvers (ts, sat_id, dvx, dvy, dvz, burn_id)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (ts, sat_id, dvx, dvy, dvz, burn_id))
    conn.commit()
    conn.close()
