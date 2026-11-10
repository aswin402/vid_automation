import time
from datetime import datetime
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        print(f"<-  {request.method} {request.url.path}")
        start = time.perf_counter()
        response = await call_next(request)
        duration = int((time.perf_counter() - start) * 1000)
        print(f"--> {request.method} {request.url.path} {response.status_code} {duration}ms")
        return response
