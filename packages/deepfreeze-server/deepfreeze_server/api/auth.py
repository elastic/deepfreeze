"""Token-based authentication middleware with role checking.

Roles:
  - admin: full access (all endpoints)
  - operator: actions + read, but not setup or scheduler management
  - viewer: read-only (status, jobs, events, health)

When no tokens are configured, all requests are allowed (open mode).
"""

import logging

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from ..config import AuthConfig

logger = logging.getLogger("deepfreeze.server.auth")

# Paths that never require auth
_PUBLIC_PATHS = {"/health", "/ready", "/docs", "/openapi.json", "/redoc", "/api/auth/login"}

# Role → allowed path patterns
# More specific checks: admin gets everything, operator gets actions + read,
# viewer gets read-only.
_WRITE_PREFIXES = ("/api/actions/", "/api/scheduler/")
_SETUP_PREFIXES = ("/api/actions/setup",)


def _role_allows(roles: list[str], method: str, path: str) -> bool:
    """Check if any of the token's roles allow access to this endpoint."""
    if "admin" in roles:
        return True

    if "operator" in roles:
        # Operators can do everything except setup and scheduler management
        if any(path.startswith(p) for p in _SETUP_PREFIXES):
            return False
        if path.startswith("/api/scheduler/") and method != "GET":
            return False
        return True

    if "viewer" in roles:
        # Viewers can only read
        if method in ("GET", "HEAD", "OPTIONS"):
            return True
        return False

    return False


class AuthMiddleware(BaseHTTPMiddleware):
    """Bearer token authentication middleware.

    When tokens are configured in the server config, all non-public
    requests must include a valid `Authorization: Bearer <token>` header.
    When no tokens are configured, all requests pass through (open mode).
    """

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        # Get auth config from app state (set during create_app)
        auth_config: AuthConfig | None = getattr(
            request.app.state, "auth_config", None
        )

        # Open mode: no tokens configured → allow everything
        if not auth_config or not auth_config.tokens:
            return await call_next(request)

        path = request.url.path
        method = request.method

        # Public paths skip auth
        if path in _PUBLIC_PATHS:
            return await call_next(request)

        # Static frontend assets skip auth
        if path.startswith("/assets/") or (
            not path.startswith("/api/") and method == "GET"
        ):
            return await call_next(request)

        # Extract Bearer token
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid Authorization header"},
                headers={"WWW-Authenticate": "Bearer"},
            )

        token_value = auth_header[7:]  # strip "Bearer "

        # Check ES session tokens first
        from .login import get_session

        session = get_session(token_value)
        if session:
            # ES-authenticated session — grant full access (admin equivalent)
            request.state.auth_name = session["username"]
            request.state.auth_roles = ["admin"]
            return await call_next(request)

        # Look up configured API token
        matched = None
        for t in auth_config.tokens:
            if t.token == token_value:
                matched = t
                break

        if not matched:
            logger.warning("Invalid token from %s", request.client.host if request.client else "unknown")
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid API token"},
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Check role permissions
        if not _role_allows(matched.roles, method, path):
            logger.warning(
                "Token '%s' (roles=%s) denied access to %s %s",
                matched.name, matched.roles, method, path,
            )
            return JSONResponse(
                status_code=403,
                content={"detail": f"Insufficient permissions (roles: {matched.roles})"},
            )

        # Attach token info to request state for downstream use
        request.state.auth_name = matched.name
        request.state.auth_roles = matched.roles

        return await call_next(request)
