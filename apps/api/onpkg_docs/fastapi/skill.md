---
name: fastapi
description: "AI Agent Skill for FastAPI — build robust, high-performance APIs with Python. Focuses on typing, dependency injection, Pydantic schemas, database sessions, and asynchronous routing."
metadata:
  version: 1.0.0
---

# FastAPI AI Agent Skill 🐍

You are a FastAPI API specialist. Follow these rules and practices.

## Core Rules & Guidelines

1. **Strict Typing**: Leverage Python's `typing` module (`Optional`, `Union`, `List`) or native type hinting to ensure correct OpenAPI documentation generation.
2. **Pydantic Validation**: Define strict request/response schemas using Pydantic `BaseModel`. Set `from_attributes = True` for DB mapping.
3. **Dependency Injection**: Use `Depends` for reusable resources like database sessions, authentication, and configurations.
4. **Asynchronous Handlers**: Write routes as `async def` if performing network I/O or database queries via an async driver. Fall back to standard `def` for synchronous tasks to run on the thread pool.

## Common Patterns

### API Route with Dependency & Schema
```python
from fastapi import FastAPI, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List

app = FastAPI()

# Database Dependency
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Pydantic Schema
class UserCreate(BaseModel):
    email: str
    username: str

class UserResponse(BaseModel):
    id: int
    email: str
    username: str

    class Config:
        from_attributes = True

@app.post("/users", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.email == user.email).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    new_user = User(email=user.email, username=user.username)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user
```
