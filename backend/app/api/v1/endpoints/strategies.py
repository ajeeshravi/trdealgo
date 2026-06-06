"""Strategy catalog, custom-code validation, and instance management."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.deps import CurrentUser, require_roles
from app.strategies.registry import catalog, validate_custom_code

router = APIRouter(prefix="/strategies", tags=["strategies"])


class ValidateRequest(BaseModel):
    code: str


@router.get("/catalog")
async def get_catalog(
    current: CurrentUser = Depends(require_roles("admin", "trader", "viewer")),
):
    return {"strategies": catalog()}


@router.post("/validate")
async def validate(
    body: ValidateRequest,
    current: CurrentUser = Depends(require_roles("admin", "trader")),
):
    ok, message = validate_custom_code(body.code)
    return {"valid": ok, "message": message}
