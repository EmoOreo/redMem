"""Vector embeddings and semantic search using ChromaDB."""

import os
from pathlib import Path
from typing import List, Dict, Any
from .models import Post, Comment
from .storage import list_posts, get_post

CHROMA_DIR = Path("data/chroma")

_chroma_client = None
_collection = None

def _get_collection():
    global _chroma_client, _collection
    if _collection is not None:
        return _collection
    try:
        import chromadb
        CHROMA_DIR.mkdir(parents=True, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        _collection = _chroma_client.get_or_create_collection(name="reddit_threads")
        return _collection
    except Exception:
        return None

def index_post(post: Post) -> bool:
    """Indexes a post and its top text into ChromaDB."""
    collection = _get_collection()
    if collection is None:
        return False

    try:
        documents = []
        metadatas = []
        ids = []

        # Post document
        post_doc = f"Post Title: {post.title}\nSubreddit: r/{post.subreddit}\nSelftext: {post.selftext}"
        documents.append(post_doc)
        metadatas.append({
            "slug": post.slug,
            "title": post.title,
            "subreddit": post.subreddit,
            "type": "post"
        })
        ids.append(f"{post.slug}_post")

        # Index top level comments
        for idx, comment in enumerate(post.comments[:50]):
            if comment.body and len(comment.body.strip()) > 10:
                documents.append(f"Comment by u/{comment.author} on '{post.title}':\n{comment.body}")
                metadatas.append({
                    "slug": post.slug,
                    "title": post.title,
                    "subreddit": post.subreddit,
                    "type": "comment",
                    "comment_id": comment.id
                })
                ids.append(f"{post.slug}_comment_{comment.id or idx}")

        if documents:
            collection.upsert(documents=documents, metadatas=metadatas, ids=ids)
        return True
    except Exception:
        return False

def search_posts(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Performs semantic search with Chroma or keyword fallback search."""
    collection = _get_collection()
    if collection is not None:
        try:
            results = collection.query(query_texts=[query], n_results=min(limit * 3, 50))
            if results and results.get("metadatas"):
                seen_slugs = set()
                search_results = []
                for meta_list, doc_list in zip(results["metadatas"], results.get("documents", [[]])):
                    for meta, doc in zip(meta_list, doc_list):
                        slug = meta.get("slug")
                        if slug and slug not in seen_slugs:
                            seen_slugs.add(slug)
                            post = get_post(slug)
                            if post:
                                search_results.append({
                                    "slug": post.slug,
                                    "title": post.title,
                                    "subreddit": post.subreddit,
                                    "author": post.author,
                                    "score": post.score,
                                    "num_comments": post.num_comments,
                                    "snippet": doc[:300] + "..." if len(doc) > 300 else doc
                                })
                            if len(search_results) >= limit:
                                break
                if search_results:
                    return search_results
        except Exception:
            pass

    # Keyword search fallback
    query_lower = query.lower()
    matches = []
    for post_meta in list_posts():
        slug = post_meta["slug"]
        post = get_post(slug)
        if not post:
            continue
        text_content = f"{post.title} {post.selftext} " + " ".join(c.body for c in post.comments[:20])
        if query_lower in text_content.lower():
            matches.append({
                "slug": post.slug,
                "title": post.title,
                "subreddit": post.subreddit,
                "author": post.author,
                "score": post.score,
                "num_comments": post.num_comments,
                "snippet": post.selftext[:300] if post.selftext else (post.comments[0].body[:300] if post.comments else post.title)
            })
        if len(matches) >= limit:
            break
    return matches
