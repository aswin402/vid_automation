# fastapi

FastAPI + SQLAlchemy (Async) + Alembic + Pydantic v2 + structlog + Best Practices

## Quick Start

```bash
cd fastapi
```

### Install dependencies

```bash
pip install .
```

### Development

```bash
uvicorn src.main:app --reload
```

## Generated with onpkg

This project was scaffolded using the `fastapi` template v1.0.0.

## Project Structure

```
fastapi/
├── app/main.py
├── app/core/config.py
├── app/core/logger.py
├── app/db/session.py
├── app/db/base.py
├── app/db/dependencies.py
├── app/exceptions/handlers.py
├── app/middleware/request_logging.py
├── app/routes/router.py
├── app/models/__init__.py
├── app/__init__.py
├── app/core/__init__.py
├── app/db/__init__.py
├── app/exceptions/__init__.py
├── app/middleware/__init__.py
├── app/routes/__init__.py
├── alembic.ini
├── alembic/env.py
├── alembic/script.py.mako
├── alembic/versions/.gitkeep
├── .env
├── justfile
├── uploads/.gitkeep
├── .gitignore
```

## Variables


