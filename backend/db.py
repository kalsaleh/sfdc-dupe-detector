import sqlite3

from backend.config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT,
    name_normalized TEXT,
    website TEXT,
    website_normalized TEXT,
    owner_id TEXT,
    owner_name TEXT,
    type TEXT,
    industry TEXT,
    account_stage TEXT,
    billing_country TEXT,
    arr REAL,
    current_arr REAL,
    customer_health TEXT,
    created_date TEXT,
    last_modified_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_website_norm ON accounts(website_normalized);
CREATE INDEX IF NOT EXISTS idx_name_norm ON accounts(name_normalized);
CREATE INDEX IF NOT EXISTS idx_account_stage ON accounts(account_stage);
CREATE INDEX IF NOT EXISTS idx_billing_country ON accounts(billing_country);

CREATE TABLE IF NOT EXISTS account_match_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    match_type TEXT,
    label TEXT,
    match_value TEXT,
    source_field TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_match_key_value ON account_match_keys(match_type, match_value);
CREATE INDEX IF NOT EXISTS idx_match_key_account ON account_match_keys(account_id);

CREATE TABLE IF NOT EXISTS duplicate_groups (
    group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_types TEXT,
    score REAL,
    tier INTEGER,
    status TEXT DEFAULT 'pending',
    recommended_action TEXT DEFAULT 'merge',
    has_service_owner INTEGER DEFAULT 0,
    explanation TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_groups_tier ON duplicate_groups(tier);
CREATE INDEX IF NOT EXISTS idx_groups_status ON duplicate_groups(status);

CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER,
    account_id TEXT,
    is_master INTEGER DEFAULT 0,
    role TEXT DEFAULT 'victim',
    PRIMARY KEY (group_id, account_id),
    FOREIGN KEY (group_id) REFERENCES duplicate_groups(group_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS pairwise_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    account_id_a TEXT,
    account_id_b TEXT,
    match_type TEXT,
    score REAL,
    FOREIGN KEY (group_id) REFERENCES duplicate_groups(group_id)
);

CREATE TABLE IF NOT EXISTS related_data_cache (
    account_id TEXT PRIMARY KEY,
    opportunity_count INTEGER,
    contact_count INTEGER,
    case_count INTEGER,
    fetched_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS merge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    master_id TEXT,
    victim_ids TEXT,
    action TEXT,
    status TEXT,
    sf_response TEXT,
    merged_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (group_id) REFERENCES duplicate_groups(group_id)
);

CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS website_verify_cache (
    input_url  TEXT PRIMARY KEY,
    result_json TEXT,
    fetched_at  TEXT DEFAULT (datetime('now'))
);
"""


def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)

    cols = [row[1] for row in conn.execute("PRAGMA table_info(duplicate_groups)").fetchall()]
    if "has_service_owner" not in cols:
        conn.execute("ALTER TABLE duplicate_groups ADD COLUMN has_service_owner INTEGER DEFAULT 0")
        conn.commit()
    if "website_verified" not in cols:
        conn.execute("ALTER TABLE duplicate_groups ADD COLUMN website_verified INTEGER DEFAULT NULL")
        conn.commit()
    if "website_verify_detail" not in cols:
        conn.execute("ALTER TABLE duplicate_groups ADD COLUMN website_verify_detail TEXT")
        conn.commit()

    tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if "account_match_keys" not in tables:
        conn.executescript(
            """
            CREATE TABLE account_match_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT,
                match_type TEXT,
                label TEXT,
                match_value TEXT,
                source_field TEXT,
                FOREIGN KEY (account_id) REFERENCES accounts(id)
            );
            CREATE INDEX idx_match_key_value ON account_match_keys(match_type, match_value);
            CREATE INDEX idx_match_key_account ON account_match_keys(account_id);
            """
        )
        conn.commit()

    if "website_verify_cache" not in tables:
        conn.executescript(
            """
            CREATE TABLE website_verify_cache (
                input_url   TEXT PRIMARY KEY,
                result_json TEXT,
                fetched_at  TEXT DEFAULT (datetime('now'))
            );
            """
        )
        conn.commit()

    conn.close()
