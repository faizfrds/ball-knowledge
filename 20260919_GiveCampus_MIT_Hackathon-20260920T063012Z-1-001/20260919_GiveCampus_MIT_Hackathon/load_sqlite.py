#!/usr/bin/env python3
"""Load the HackMIT CSV package into a new SQLite database."""

import argparse
import csv
import sqlite3
from pathlib import Path


TABLES = [
    "schools",
    "staff",
    "constituents",
    "affiliations",
    "degrees",
    "activities",
    "funds",
    "campaigns",
    "opportunities",
    "gifts",
    "gift_allocations",
    "interactions",
    "events",
    "event_attendance",
    "career_history",
]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).with_name("data"))
    parser.add_argument("--output", type=Path, default=Path("givecampus_hackmit.sqlite"))
    return parser.parse_args()


def sqlite_value(value):
    if value == "":
        return None
    if value == "true":
        return 1
    if value == "false":
        return 0
    return value


def main():
    args = parse_args()
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing database: {args.output}")

    schema_path = Path(__file__).with_name("schema.sql")
    connection = sqlite3.connect(args.output)
    try:
        connection.executescript(schema_path.read_text(encoding="utf-8"))
        for table in TABLES:
            csv_path = args.data_dir / f"{table}.csv"
            with csv_path.open(newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                columns = reader.fieldnames
                placeholders = ", ".join("?" for _ in columns)
                quoted_columns = ", ".join(f'"{column}"' for column in columns)
                rows = ([sqlite_value(row[column]) for column in columns] for row in reader)
                connection.executemany(
                    f'INSERT INTO "{table}" ({quoted_columns}) VALUES ({placeholders})',
                    rows,
                )
        foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_key_errors:
            raise RuntimeError(f"Foreign-key validation failed: {foreign_key_errors[:5]}")
        connection.commit()
    except Exception:
        connection.close()
        args.output.unlink(missing_ok=True)
        raise
    finally:
        if connection:
            connection.close()

    print(f"Loaded {len(TABLES)} tables into {args.output}")


if __name__ == "__main__":
    main()
