import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pathlib import Path

_START_TS = str(int(time.time()))

from backend.db import init_db
from backend.api.routes_extraction import router as extraction_router
from backend.api.routes_matching import router as matching_router
from backend.api.routes_merge import router as merge_router
from backend.api.routes_dashboard import router as dashboard_router
from backend.api.routes_verify import router as verify_router

app = FastAPI(title="SFDC Duplicate Detector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extraction_router, prefix="/api")
app.include_router(matching_router, prefix="/api")
app.include_router(merge_router, prefix="/api")
app.include_router(dashboard_router, prefix="/api")
app.include_router(verify_router, prefix="/api")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/css", StaticFiles(directory=str(FRONTEND_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")

# Serve custom fonts if directory exists
FONTS_DIR = FRONTEND_DIR / "fonts"
if FONTS_DIR.exists():
    app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")


@app.on_event("startup")
def startup():
    init_db()


@app.get("/")
async def index():
    html = (FRONTEND_DIR / "index.html").read_text()
    html = html.replace("?v=2", f"?v={_START_TS}")
    return HTMLResponse(html)


if __name__ == "__main__":
    import uvicorn
    from backend.config import HOST, PORT
    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=True)
