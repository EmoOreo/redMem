"""Storage utilities for saving and loading Reddit threads as JSON and Markdown."""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from .models import Post

DATA_DIR = Path("data")

def ensure_data_dir() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR

def save_post(post: Post) -> tuple[Path, Path]:
    """Saves a post to data/<slug>.json and data/<slug>.md."""
    data_dir = ensure_data_dir()
    slug = post.slug

    json_path = data_dir / f"{slug}.json"
    md_path = data_dir / f"{slug}.md"

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(post.to_dict(), f, indent=2, ensure_ascii=False)

    with open(md_path, "w", encoding="utf-8") as f:
        f.write(post.to_markdown())

    return json_path, md_path

def get_post(slug: str) -> Optional[Post]:
    """Loads a Post object from data/<slug>.json."""
    json_path = DATA_DIR / f"{slug}.json"
    if not json_path.exists():
        return None
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return Post.from_dict(data)
    except Exception:
        return None

def get_post_markdown(slug: str) -> Optional[str]:
    """Reads markdown file for given slug."""
    md_path = DATA_DIR / f"{slug}.md"
    if not md_path.exists():
        return None
    try:
        with open(md_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return None

def list_posts() -> List[Dict[str, Any]]:
    """Returns a list of all saved posts metadata sorted by created_utc descending."""
    ensure_data_dir()
    posts = []
    for json_file in DATA_DIR.glob("*.json"):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            posts.append({
                "id": data.get("id"),
                "slug": data.get("slug", json_file.stem),
                "title": data.get("title", "Untitled"),
                "author": data.get("author", "unknown"),
                "subreddit": data.get("subreddit", ""),
                "score": data.get("score", 0),
                "num_comments": data.get("num_comments", 0),
                "created_utc": data.get("created_utc", 0),
                "url": data.get("url", ""),
                "json_path": str(json_file),
                "md_path": str(json_file.with_suffix(".md"))
            })
        except Exception:
            continue
    posts.sort(key=lambda x: x.get("created_utc", 0), reverse=True)
    return posts

def delete_post(slug: str) -> bool:
    """Deletes JSON and MD files for the given slug."""
    data_dir = ensure_data_dir()
    json_path = data_dir / f"{slug}.json"
    md_path = data_dir / f"{slug}.md"

    deleted = False
    if json_path.exists():
        json_path.unlink()
        deleted = True
    if md_path.exists():
        md_path.unlink()
        deleted = True
    return deleted

def get_file_path(slug: str, format_type: str) -> Optional[Path]:
    """Returns path for file download if it exists."""
    ext = ".json" if format_type.lower() == "json" else ".md" if format_type.lower() in ("md", "markdown") else None
    if not ext:
        return None
    file_path = DATA_DIR / f"{slug}{ext}"
    if file_path.exists():
        return file_path
    return None
