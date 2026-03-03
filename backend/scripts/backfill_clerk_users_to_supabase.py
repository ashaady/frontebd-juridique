from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.workspace_supabase import SupabaseWorkspaceStore


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill Clerk users into Supabase workspace_users table."
    )
    parser.add_argument(
        "--clerk-secret-key",
        default="",
        help="Clerk secret key (fallback env: CLERK_SECRET_KEY).",
    )
    parser.add_argument(
        "--clerk-api-base",
        default="https://api.clerk.com",
        help="Clerk API base URL (default: https://api.clerk.com).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100,
        help="Page size for Clerk users API (default: 100).",
    )
    parser.add_argument(
        "--max-users",
        type=int,
        default=0,
        help="Optional cap for processed users (0 means all users).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read Clerk users and print stats without writing to Supabase.",
    )
    return parser.parse_args()


def _clean(value: Any, *, max_len: int = 320) -> str | None:
    parsed = str(value or "").strip()
    if not parsed:
        return None
    return parsed[:max_len]


def _extract_display_name(user: dict[str, Any]) -> str | None:
    full_name = _clean(user.get("full_name"))
    if full_name:
        return full_name
    first_name = _clean(user.get("first_name"))
    last_name = _clean(user.get("last_name"))
    parts = [part for part in [first_name, last_name] if part]
    if not parts:
        return None
    return " ".join(parts)[:320]


def _extract_primary_email(user: dict[str, Any]) -> str | None:
    primary_id = _clean(user.get("primary_email_address_id"), max_len=128)
    rows = user.get("email_addresses")
    if not isinstance(rows, list):
        return None

    if primary_id:
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_id = _clean(row.get("id"), max_len=128)
            if row_id == primary_id:
                return _clean(row.get("email_address"))

    for row in rows:
        if not isinstance(row, dict):
            continue
        email = _clean(row.get("email_address"))
        if email:
            return email
    return None


def _request_json(
    *,
    url: str,
    token: str,
    timeout_sec: float = 20.0,
    max_retries: int = 4,
) -> Any:
    backoff = 0.8
    for attempt in range(max_retries):
        request = urllib.request.Request(url=url, method="GET")
        request.add_header("Authorization", f"Bearer {token}")
        request.add_header("Clerk-Secret-Key", token)
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", "JuridiqueSN-Backfill/1.0")
        try:
            with urllib.request.urlopen(request, timeout=timeout_sec) as response:
                raw = response.read().decode("utf-8", errors="replace").strip()
                if not raw:
                    return None
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            should_retry = exc.code in {429, 500, 502, 503, 504}
            if not should_retry or attempt == max_retries - 1:
                raw_error = exc.read().decode("utf-8", errors="replace").strip()
                detail = raw_error[:500] if raw_error else exc.reason
                raise RuntimeError(f"Clerk API error {exc.code}: {detail}") from exc
            time.sleep(backoff)
            backoff *= 2
        except urllib.error.URLError as exc:
            if attempt == max_retries - 1:
                raise RuntimeError(f"Clerk API connection error: {exc.reason}") from exc
            time.sleep(backoff)
            backoff *= 2
        except json.JSONDecodeError as exc:
            raise RuntimeError("Clerk API returned invalid JSON.") from exc
    return None


def _fetch_clerk_users(
    *,
    clerk_api_base: str,
    clerk_secret_key: str,
    page_limit: int,
    max_users: int,
) -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = []
    offset = 0

    while True:
        remaining = max_users - len(users) if max_users > 0 else page_limit
        current_limit = max(1, min(page_limit, remaining if max_users > 0 else page_limit))
        query = urllib.parse.urlencode({"limit": str(current_limit), "offset": str(offset)})
        url = f"{clerk_api_base.rstrip('/')}/v1/users?{query}"
        payload = _request_json(url=url, token=clerk_secret_key)

        if isinstance(payload, list):
            batch = payload
        elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
            batch = payload["data"]
        else:
            raise RuntimeError("Unexpected Clerk /v1/users response shape.")

        typed_batch = [row for row in batch if isinstance(row, dict)]
        if not typed_batch:
            break

        users.extend(typed_batch)
        offset += len(typed_batch)

        if len(typed_batch) < current_limit:
            break
        if max_users > 0 and len(users) >= max_users:
            users = users[:max_users]
            break

    return users


def main() -> int:
    load_dotenv()
    args = _parse_args()

    clerk_secret_key = (args.clerk_secret_key or os.getenv("CLERK_SECRET_KEY", "")).strip()
    if not clerk_secret_key:
        print(
            "Missing Clerk secret key. Set CLERK_SECRET_KEY or pass --clerk-secret-key.",
            file=sys.stderr,
        )
        return 1

    page_limit = int(args.limit or 100)
    if page_limit <= 0:
        page_limit = 100
    page_limit = min(page_limit, 500)

    max_users = int(args.max_users or 0)
    if max_users < 0:
        max_users = 0

    supabase_store = SupabaseWorkspaceStore.from_env()
    if not args.dry_run and supabase_store is None:
        print(
            "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
            file=sys.stderr,
        )
        return 1

    try:
        users = _fetch_clerk_users(
            clerk_api_base=args.clerk_api_base,
            clerk_secret_key=clerk_secret_key,
            page_limit=page_limit,
            max_users=max_users,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Backfill failed while reading Clerk users: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    total = len(users)
    print(f"Clerk users fetched: {total}")
    if total == 0:
        print("Nothing to backfill.")
        return 0

    if args.dry_run:
        preview = 0
        for user in users:
            user_id = _clean(user.get("id"), max_len=128)
            if not user_id:
                continue
            email = _extract_primary_email(user)
            username = _clean(user.get("username"))
            display_name = _extract_display_name(user)
            preview += 1
            print(
                f"[dry-run] {preview:04d} | user_id={user_id} | "
                f"email={email or '-'} | username={username or '-'} | name={display_name or '-'}"
            )
            if preview >= 20:
                break
        print("Dry-run complete (no write).")
        return 0

    assert supabase_store is not None
    synced = 0
    skipped = 0
    failed = 0

    for user in users:
        user_id = _clean(user.get("id"), max_len=128)
        if not user_id:
            skipped += 1
            continue
        email = _extract_primary_email(user)
        username = _clean(user.get("username"))
        display_name = _extract_display_name(user)
        try:
            supabase_store.upsert_user_profile(
                user_id=user_id,
                email=email,
                username=username,
                display_name=display_name,
            )
            synced += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(
                f"[warn] failed user_id={user_id}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )

    print(
        "Backfill complete: "
        f"synced={synced} | skipped={skipped} | failed={failed} | total={total}"
    )
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
