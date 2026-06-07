"""FastAPI application factory.

Mounts the v1 REST API, the WebSocket gateway, health checks, CORS, and the
Redis→WS bridge. In an MVP this single process hosts everything; in production
the engine/market-data/strategy workers run as separate services.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.redis import close_redis
from app.websockets.manager import manager

log = get_logger("app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    log.info("startup", env=settings.ENV, app=settings.APP_NAME)
    # Bridge realtime Redis topics to WS clients.
    bridge = asyncio.create_task(
        manager.run_redis_bridge(
            ["md.quotes.*", "orders.events", "positions.updates", "risk.events"]
        )
    )
    try:
        yield
    finally:
        bridge.cancel()
        await close_redis()
        log.info("shutdown")


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.APP_NAME,
        version="1.0.0",
        docs_url="/docs",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)

    # The frontend reads error toasts from `error.response.data.error.message`.
    # FastAPI defaults to `{"detail": ...}`, so we emit both keys: `error.message`
    # for the UI and `detail` for backward compatibility / API clients.
    def _error_body(message: str, detail) -> dict:
        return {"error": {"message": message}, "detail": detail}

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc_handler(request: Request, exc: StarletteHTTPException):
        detail = exc.detail
        message = detail if isinstance(detail, str) else (
            detail.get("reason") or detail.get("message")
            if isinstance(detail, dict)
            else str(detail)
        )
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(message or "request failed", detail),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_exc_handler(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        first = errors[0] if errors else {}
        loc = ".".join(str(p) for p in first.get("loc", []) if p != "body")
        msg = first.get("msg", "validation error")
        message = f"{loc}: {msg}" if loc else msg
        return JSONResponse(status_code=422, content=_error_body(message, errors))

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "env": settings.ENV}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await manager.connect(ws)
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "subscribe":
                    await manager.subscribe(ws, msg.get("channels", []))
                    await ws.send_json({"type": "subscribed", "channels": msg.get("channels", [])})
        except WebSocketDisconnect:
            await manager.disconnect(ws)

    return app


app = create_app()
