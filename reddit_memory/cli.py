"""Command-line interface for Reddit Memory."""

import argparse
import sys
from .fetcher import fetch_post
from .storage import save_post
from .embeddings import index_post

def main():
    parser = argparse.ArgumentParser(description="Fetch and archive Reddit threads as JSON + Markdown.")
    parser.add_argument("url", help="Reddit thread URL to fetch")
    parser.add_argument("--no-index", action="store_true", help="Skip Chroma vector indexing")

    args = parser.parse_args()

    print(f"Fetching Reddit thread from: {args.url}")

    def log_progress(stage, count, total, elapsed, msg):
        print(f"[{elapsed:4.1f}s] [{stage}] {msg}")

    try:
        post = fetch_post(args.url, progress_cb=log_progress)
        json_path, md_path = save_post(post)
        print("\nSaved files:")
        print(f" - JSON: {json_path}")
        print(f" - Markdown: {md_path}")

        if not args.no_index:
            indexed = index_post(post)
            if indexed:
                print(" - Chroma Index: Updated")
            else:
                print(" - Chroma Index: Skipped or unavailable")

    except Exception as e:
        print(f"\nError fetching Reddit thread: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
