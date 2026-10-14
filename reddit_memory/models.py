"""Data models for Reddit Memory."""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
import datetime
import re

def slugify(text: str) -> str:
    """Convert text to a safe filename slug."""
    text = text.lower()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_-]+', '-', text).strip('-')
    return text[:80] or "reddit-post"

@dataclass
class Comment:
    id: str
    author: str
    body: str
    score: int = 0
    created_utc: float = 0.0
    depth: int = 0
    parent_id: Optional[str] = None
    replies: List['Comment'] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "author": self.author,
            "body": self.body,
            "score": self.score,
            "created_utc": self.created_utc,
            "depth": self.depth,
            "parent_id": self.parent_id,
            "replies": [reply.to_dict() for reply in self.replies]
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Comment':
        replies_raw = data.get("replies", [])
        replies = [cls.from_dict(r) for r in replies_raw]
        return cls(
            id=data.get("id", ""),
            author=data.get("author", "[deleted]"),
            body=data.get("body", ""),
            score=data.get("score", 0),
            created_utc=data.get("created_utc", 0.0),
            depth=data.get("depth", 0),
            parent_id=data.get("parent_id"),
            replies=replies
        )

    def to_markdown(self, indent_level: int = 0) -> str:
        indent = "  " * indent_level
        prefix = "> " if indent_level > 0 else ""
        date_str = ""
        if self.created_utc:
            date_str = f" • {datetime.datetime.fromtimestamp(self.created_utc, tz=datetime.timezone.utc).strftime('%Y-%m-%d %H:%M')}"

        body_indented = self.body.replace("\n", f"\n{indent}{prefix}")
        md = f"{indent}{prefix}**{self.author}** ({self.score} pts{date_str}):\n"
        md += f"{indent}{prefix}{body_indented}\n\n"

        for reply in self.replies:
            md += reply.to_markdown(indent_level + 1)
        return md


@dataclass
class Post:
    id: str
    slug: str
    title: str
    author: str
    url: str
    score: int = 0
    num_comments: int = 0
    created_utc: float = 0.0
    selftext: str = ""
    subreddit: str = ""
    comments: List[Comment] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "slug": self.slug,
            "title": self.title,
            "author": self.author,
            "url": self.url,
            "score": self.score,
            "num_comments": self.num_comments,
            "created_utc": self.created_utc,
            "selftext": self.selftext,
            "subreddit": self.subreddit,
            "comments": [c.to_dict() for c in self.comments]
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'Post':
        comments_raw = data.get("comments", [])
        comments = [Comment.from_dict(c) for c in comments_raw]
        return cls(
            id=data.get("id", ""),
            slug=data.get("slug", slugify(data.get("title", "post"))),
            title=data.get("title", ""),
            author=data.get("author", "[deleted]"),
            url=data.get("url", ""),
            score=data.get("score", 0),
            num_comments=data.get("num_comments", len(comments)),
            created_utc=data.get("created_utc", 0.0),
            selftext=data.get("selftext", ""),
            subreddit=data.get("subreddit", ""),
            comments=comments
        )

    def to_markdown(self) -> str:
        date_str = ""
        if self.created_utc:
            date_str = f" on {datetime.datetime.fromtimestamp(self.created_utc, tz=datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}"

        md = f"# {self.title}\n\n"
        md += f"**Subreddit:** r/{self.subreddit} | **Author:** u/{self.author} | **Score:** {self.score} | **Comments:** {self.num_comments}{date_str}\n"
        md += f"**URL:** {self.url}\n\n"

        if self.selftext:
            md += "## Post Text\n\n"
            md += f"{self.selftext}\n\n"

        md += "---\n\n## Comments\n\n"
        if not self.comments:
            md += "*No comments saved.*\n"
        else:
            for comment in self.comments:
                md += comment.to_markdown(indent_level=0)
        return md
