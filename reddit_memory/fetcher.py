"""Playwright-based Reddit thread fetcher."""

import asyncio
import time
import re
from typing import Optional, Callable, Dict, Any, List
from playwright.async_api import async_playwright
from .models import Post, Comment, slugify

def parse_reddit_url(url: str) -> str:
    """Normalize and validate Reddit thread URL."""
    url = url.strip()
    if not url.startswith("http"):
        url = "https://" + url
    if "reddit.com" not in url and "redd.it" not in url:
        raise ValueError("Invalid Reddit URL: must contain reddit.com or redd.it")
    return url

async def fetch_post_async(
    url: str,
    cancel_event: Optional[asyncio.Event] = None,
    progress_cb: Optional[Callable[[str, int, int, float, str], None]] = None
) -> Post:
    """Fetches a Reddit post and expands comments using Playwright.

    Checks cancel_event between expansion clicks.
    Calls progress_cb(stage, count, total, elapsed, raw_message) if provided.
    """
    clean_url = parse_reddit_url(url)
    start_time = time.time()

    def report(stage: str, count: int, total: int, message: str):
        elapsed = time.time() - start_time
        if progress_cb:
            progress_cb(stage, count, total, round(elapsed, 1), message)

    report("init", 0, 100, "Starting Playwright Chromium browser...")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled"
            ]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 900}
        )
        page = await context.new_page()

        try:
            report("navigating", 10, 100, f"Navigating to {clean_url}...")
            if cancel_event and cancel_event.is_set():
                raise asyncio.CancelledError("Fetch job cancelled before navigation")

            await page.goto(clean_url, wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(2)

            if cancel_event and cancel_event.is_set():
                raise asyncio.CancelledError("Fetch job cancelled during page load")

            report("parsing_post", 25, 100, "Extracting post title and details...")

            # Extract Post details
            title = await page.title()
            title = re.sub(r' : r/\w+$', '', title)
            title = re.sub(r' - Reddit$', '', title)

            post_id = "post_" + str(int(time.time()))

            # Subreddit extraction
            subreddit = ""
            sub_match = re.search(r'reddit\.com/r/([^/]+)', clean_url)
            if sub_match:
                subreddit = sub_match.group(1)

            # Try to grab author & selftext
            author = "[unknown]"
            selftext = ""
            score = 0
            num_comments = 0

            try:
                author_el = await page.query_selector('a[href*="/user/"]')
                if author_el:
                    author_text = await author_el.text_content()
                    if author_text:
                        author = author_text.strip().lstrip("u/")
            except Exception:
                pass

            try:
                # Main post body
                post_body_el = await page.query_selector('[data-test-id="post-content"], shreddit-post, div[id*="post-rtjson"]')
                if post_body_el:
                    selftext = (await post_body_el.text_content() or "").strip()
            except Exception:
                pass

            # Expand "more replies" / comment buttons
            report("expanding_comments", 40, 100, "Searching for comment expansion buttons...")

            expansion_selectors = [
                'button:has-text("more replies")',
                'button:has-text("More comments")',
                'button:has-text("View more comments")',
                'button[id*="more-comments"]',
                'faceplate-tracker[source="comment_tree"] button'
            ]

            expanded_count = 0
            max_expansions = 25

            for sel in expansion_selectors:
                if cancel_event and cancel_event.is_set():
                    raise asyncio.CancelledError("Fetch job cancelled during comment expansion")

                buttons = await page.query_selector_all(sel)
                for btn in buttons[:10]:
                    if cancel_event and cancel_event.is_set():
                        raise asyncio.CancelledError("Fetch job cancelled during comment expansion")

                    try:
                        if await btn.is_visible():
                            await btn.scroll_into_view_if_needed()
                            await btn.click(timeout=1500)
                            expanded_count += 1
                            report("expanding_comments", 40 + min(40, expanded_count * 2), 100, f"Expanded {expanded_count} comment section(s)...")
                            await asyncio.sleep(0.5)
                            if expanded_count >= max_expansions:
                                break
                    except Exception:
                        continue
                if expanded_count >= max_expansions:
                    break

            if cancel_event and cancel_event.is_set():
                raise asyncio.CancelledError("Fetch job cancelled before parsing comments")

            report("parsing_comments", 85, 100, "Parsing rendered comment tree...")

            # Parse comments DOM
            comments: List[Comment] = []
            comment_elements = await page.query_selector_all('shreddit-comment, [data-testid="comment"], div.comment')

            for idx, c_el in enumerate(comment_elements[:150]):
                if cancel_event and cancel_event.is_set():
                    raise asyncio.CancelledError("Fetch job cancelled while parsing comments")

                try:
                    c_author = "[deleted]"
                    author_attr = await c_el.get_attribute("author")
                    if author_attr:
                        c_author = author_attr
                    else:
                        c_author_el = await c_el.query_selector('a[href*="/user/"]')
                        if c_author_el:
                            c_author = (await c_author_el.text_content() or "").strip()

                    c_score = 1
                    score_attr = await c_el.get_attribute("score")
                    if score_attr and score_attr.isdigit():
                        c_score = int(score_attr)

                    c_body = ""
                    body_el = await c_el.query_selector('div[id*="-content"], p, [slot="comment"]')
                    if body_el:
                        c_body = (await body_el.text_content() or "").strip()
                    else:
                        c_body = (await c_el.text_content() or "").strip()

                    if c_body:
                        comments.append(Comment(
                            id=f"comment_{idx+1}",
                            author=c_author,
                            body=c_body,
                            score=c_score,
                            created_utc=time.time(),
                            depth=0
                        ))
                except Exception:
                    continue

            num_comments = len(comments)
            post_slug = slugify(title)

            post = Post(
                id=post_id,
                slug=post_slug,
                title=title if title else "Reddit Thread",
                author=author,
                url=clean_url,
                score=score,
                num_comments=num_comments,
                created_utc=time.time(),
                selftext=selftext,
                subreddit=subreddit,
                comments=comments
            )

            report("complete", 100, 100, f"Successfully fetched post '{post.title}' with {num_comments} comments.")
            return post

        finally:
            await browser.close()

def fetch_post(
    url: str,
    cancel_event: Optional[asyncio.Event] = None,
    progress_cb: Optional[Callable[[str, int, int, float, str], None]] = None
) -> Post:
    """Synchronous entrypoint for fetch_post_async."""
    return asyncio.run(fetch_post_async(url, cancel_event=cancel_event, progress_cb=progress_cb))
