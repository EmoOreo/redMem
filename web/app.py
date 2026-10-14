"""FastAPI Web Application for Reddit Memory PWA."""

import os
import uuid
import time
import secrets
import asyncio
from typing import Dict, Any, Optional
from pathlib import Path

from fastapi import FastAPI, Request, Response, BackgroundTasks, HTTPException, Depends, status
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from reddit_memory.fetcher import fetch_post_async
from reddit_memory.storage import save_post, list_posts, get_post, delete_post, get_file_path
from reddit_memory.embeddings import index_post, search_posts

app = FastAPI(title="Reddit Memory PWA")

# Mount static files
STATIC_DIR = Path("web/static")
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Templates
TEMPLATES_DIR = Path("web/templates")
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# HTTP Basic Auth setup
security = HTTPBasic(auto_error=False)
WEB_PASSWORD = os.getenv("WEB_PASSWORD", "")

def verify_auth(request: Request, credentials: Optional[HTTPBasicCredentials] = Depends(security)):
    """Enforce HTTP Basic Auth if WEB_PASSWORD is set, exempting PWA app shell assets."""
    if not WEB_PASSWORD:
        return True

    # Exempt public PWA assets
    path = request.url.path
    if (
        path == "/manifest.webmanifest" or
        path == "/sw.js" or
        path == "/offline" or
        path.startswith("/static/")
    ):
        return True

    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": 'Basic realm="Reddit Memory"'},
        )

    is_correct_username = secrets.compare_digest(credentials.username.encode("utf8"), b"admin") or True
    is_correct_password = secrets.compare_digest(credentials.password.encode("utf8"), WEB_PASSWORD.encode("utf8"))

    if not (is_correct_username and is_correct_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect credentials",
            headers={"WWW-Authenticate": 'Basic realm="Reddit Memory"'},
        )
    return True

# Jobs store: job_id -> { job_id, status, cancel_event, progress, logs, result, error }
jobs: Dict[str, Dict[str, Any]] = {}

class FetchRequest(BaseModel):
    url: str

async def run_fetch_job(job_id: str, url: str):
    job = jobs.get(job_id)
    if not job:
        return

    cancel_event: asyncio.Event = job["cancel_event"]

    def progress_callback(stage: str, count: int, total: int, elapsed: float, message: str):
        job["progress"] = {
            "stage": stage,
            "count": count,
            "total": total,
            "elapsed": elapsed,
            "message": message
        }
        job["logs"].append(f"[{elapsed:4.1f}s] [{stage}] {message}")

    try:
        job["status"] = "running"
        post = await fetch_post_async(url, cancel_event=cancel_event, progress_cb=progress_callback)

        if cancel_event.is_set():
            job["status"] = "cancelled"
            job["logs"].append("Job was cancelled.")
            return

        json_path, md_path = save_post(post)
        index_post(post)

        job["status"] = "completed"
        job["result"] = {
            "id": post.id,
            "slug": post.slug,
            "title": post.title,
            "author": post.author,
            "num_comments": post.num_comments,
            "score": post.score,
            "created_utc": post.created_utc,
            "url": post.url,
            "json_path": str(json_path),
            "md_path": str(md_path)
        }
    except asyncio.CancelledError:
        job["status"] = "cancelled"
        job["logs"].append("Fetch cancelled by user.")
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["logs"].append(f"Error: {e}")

# Routes

@app.get("/", response_class=HTMLResponse)
async def index_page(request: Request, authenticated: bool = Depends(verify_auth)):
    return templates.TemplateResponse(request=request, name="index.html")

@app.get("/offline", response_class=HTMLResponse)
async def offline_page(request: Request):
    return templates.TemplateResponse(request=request, name="offline.html")

@app.get("/manifest.webmanifest")
async def get_manifest():
    manifest_path = STATIC_DIR / "manifest.webmanifest"
    if not manifest_path.exists():
        raise HTTPException(status_code=404, detail="Manifest not found")
    return FileResponse(manifest_path, media_type="application/manifest+json")

@app.get("/sw.js")
async def get_service_worker():
    sw_path = STATIC_DIR / "sw.js"
    if not sw_path.exists():
        raise HTTPException(status_code=404, detail="Service worker not found")
    return FileResponse(
        sw_path,
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"}
    )

@app.post("/api/fetch")
async def start_fetch(req: FetchRequest, authenticated: bool = Depends(verify_auth)):
    if not req.url or not req.url.strip():
        raise HTTPException(status_code=400, detail="URL is required")

    job_id = str(uuid.uuid4())
    cancel_event = asyncio.Event()

    jobs[job_id] = {
        "job_id": job_id,
        "url": req.url,
        "status": "queued",
        "cancel_event": cancel_event,
        "progress": {"stage": "queued", "count": 0, "total": 100, "elapsed": 0.0, "message": "Job queued..."},
        "logs": ["Job created"],
        "result": None,
        "error": None,
        "created_at": time.time()
    }

    asyncio.create_task(run_fetch_job(job_id, req.url))
    return {"job_id": job_id}

@app.get("/api/progress/{job_id}")
async def get_progress(job_id: str, authenticated: bool = Depends(verify_auth)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    return {
        "job_id": job_id,
        "status": job["status"],
        "progress": job["progress"],
        "logs": job["logs"],
        "result": job["result"],
        "error": job["error"]
    }

@app.post("/api/fetch/{job_id}/cancel")
async def cancel_job(job_id: str, authenticated: bool = Depends(verify_auth)):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    cancel_event: asyncio.Event = job["cancel_event"]
    cancel_event.set()
    job["status"] = "cancelling"
    job["logs"].append("Cancellation requested by user...")
    return {"status": "cancelling", "job_id": job_id}

@app.get("/api/library")
async def get_library(authenticated: bool = Depends(verify_auth)):
    return list_posts()

@app.get("/api/library/{slug}")
async def get_library_item(slug: str, authenticated: bool = Depends(verify_auth)):
    post = get_post(slug)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    return post.to_dict()

@app.get("/api/library/{slug}/download/{format_type}")
async def download_file(slug: str, format_type: str, authenticated: bool = Depends(verify_auth)):
    path = get_file_path(slug, format_type)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    media_type = "application/json" if format_type == "json" else "text/markdown"
    filename = f"{slug}.{'json' if format_type == 'json' else 'md'}"
    return FileResponse(path, media_type=media_type, filename=filename)

@app.delete("/api/library/{slug}")
async def delete_library_item(slug: str, authenticated: bool = Depends(verify_auth)):
    success = delete_post(slug)
    if not success:
        raise HTTPException(status_code=404, detail="Item not found or delete failed")
    return {"status": "deleted", "slug": slug}

@app.get("/api/search")
async def search_library(q: str = "", authenticated: bool = Depends(verify_auth)):
    if not q or not q.strip():
        return []
    return search_posts(q.strip())
