import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from app.core.config import settings
from app.core.logger import setup_logging
from app.db.base import Base
from app.db.session import engine
from app.exceptions.handlers import add_exception_handlers
from app.middleware.request_logging import RequestLoggingMiddleware
from app.routes.router import api_router
import app.models  # noqa: F401

setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(settings.storage_dir, exist_ok=True)
    os.makedirs(settings.worker_temp_dir, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title=settings.app_name,
    version="0.0.1",
    description="AI Video Automation Platform REST API & Asynchronous Media Pipeline",
    lifespan=lifespan,
)

app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

add_exception_handlers(app)
app.include_router(api_router)


@app.get("/", response_class=PlainTextResponse)
async def server_root():
    return "AI Video Automation Platform API is running 🚀"


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "message": f"Server is running in {settings.environment} mode",
        "app_name": settings.app_name,
    }
